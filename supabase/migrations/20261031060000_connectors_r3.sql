-- CONNECTORS, DISCONNECT AND ERASE, ROUND 3 (2026-10-31; tests/architect/scenarios-connectors-r3.test.ts, ~10,000 generated
-- callbacks, connects, inbox runs and partial grants, and tests/architect/flow-scenarios-connectors-r3.test.ts, the same on
-- real Postgres through the real callbacks and inbox runs). What the database let through:
--   1. A connect callback stored the tokens for a person who no longer exists. Gmail's state lives ten minutes and Outlook's
--      link is finished before the code is exchanged; a person who deleted their account in between (or a replayed Gmail
--      callback after it) got oauth_vault_store's write (the Vault has no cascade), then the connection row's insert failed
--      on its foreign key: a refresh token for a deleted account was left in the Vault for good, and Google's grant was
--      never revoked. oauth_connect_commit (new) writes the Vault entry and the row in one transaction, holding the account
--      (a deletion waits for it, then cascades both away), and refuses when the account is gone ('gone'): the callback then
--      revokes the new grant at Google and stores nothing.
--   2. A Gmail callback's state could be used again within its ten minutes (it is signed, not spent). A state seen once,
--      paired with another consent's code, connected another Google account to the state's Trainee account (that account's
--      approved emails would go from, and its replies be read from, a mailbox that is not the person's). oauth_state_use
--      (new) spends a state once; the callback refuses a spent one before it exchanges any code.
--   3. One Google (or Microsoft) address could be connected to two Trainee accounts. Google keeps one grant per person and
--      app, so the first account's "disconnect gmail" (or its deletion) revoked the second account's access at Google, and
--      the same mail was read into both accounts. oauth_connect_commit refuses an address another account holds ('taken'),
--      and the callback tells the person in plain words; nothing is revoked (that would cut the other account off).
--   4. An inbox run that read mail before "disconnect gmail|outlook" or "forget everything" committed wrote what it read
--      after it: Outlook's sync wrote career_outlook_messages with no check at all, and Gmail's run checked the connection
--      then wrote (a disconnect in between re-created the events the disconnect had erased; an erase in between was never
--      checked). career_outlook_store_messages, career_mail_record_events, career_mail_save_draft and career_mail_save_cursor
--      (new) write only while the connection row is there and, given the erase epoch the run read before it read the
--      mail, only while no erase has happened since; they hold the connection and the account row, so a disconnect or an
--      erase that comes after waits for the write and then erases it.
-- Idempotent; service role only.

-- ---------------------------------------------------------------------------------------------- 2. a state is spent once
create table if not exists public.oauth_state_uses (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz not null default now()
);
alter table public.oauth_state_uses enable row level security;
revoke all on public.oauth_state_uses from public, anon, authenticated;
grant select, insert, delete on public.oauth_state_uses to service_role;

create or replace function public.oauth_state_use(p_state text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_state is null or length(p_state) < 16 then return false; end if;
  -- A state lives ten minutes: a day of spent states is more than enough to refuse every replay.
  delete from public.oauth_state_uses where used_at < now() - interval '1 day';
  insert into public.oauth_state_uses(state_hash) values (encode(sha256(convert_to(p_state, 'UTF8')), 'hex')) on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.oauth_state_use(text) from public, anon, authenticated;
grant execute on function public.oauth_state_use(text) to service_role;

-- ---------------------------------------------------------------------------------------------- 1 and 3. the connect, whole
-- 'connected' | 'gone' (the account no longer exists) | 'taken' (another account holds this address) | 'invalid'.
create or replace function public.oauth_connect_commit(p_user uuid, p_provider text, p_secret text, p_email text, p_scopes text, p_now timestamptz default now())
returns text
language plpgsql security definer set search_path = vault, public, pg_temp as $$
declare fam text[]; addr text; vname text;
begin
  if p_user is null or p_secret is null or p_provider not in ('google_career', 'gmail', 'microsoft') then return 'invalid'; end if;
  addr := nullif(lower(btrim(coalesce(p_email, ''))), '');
  fam := case when p_provider = 'microsoft' then array['microsoft'] else array['google_career', 'gmail'] end;
  if addr is not null then
    -- Two connects of the same address at once: one at a time.
    perform pg_advisory_xact_lock(hashtextextended(fam[1] || ':' || addr, 31));
    if exists (select 1 from public.user_oauth_connections c where c.provider = any(fam) and c.user_id <> p_user
               and lower(btrim(coalesce(c.email, ''))) = addr) then
      return 'taken';
    end if;
  end if;
  -- The account, held until this commits: a deletion waits, then cascades the row (and, by its trigger, the Vault entry).
  -- Checked after 'taken': a grant another account shares at Google is never the one revoked for a gone account.
  perform 1 from auth.users u where u.id = p_user for share;
  if not found then return 'gone'; end if;
  vname := 'oauth_' || p_provider || '_' || p_user::text;
  delete from vault.secrets where name = vname;
  perform vault.create_secret(p_secret, vname, 'Upmore OAuth token');
  insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes, connected_at)
    values (p_user, p_provider, vname, p_email, p_scopes, coalesce(p_now, now()))
  on conflict (user_id, provider) do update set vault_name = excluded.vault_name, email = excluded.email, scopes = excluded.scopes,
    connected_at = excluded.connected_at;
  return 'connected';
end $$;
revoke all on function public.oauth_connect_commit(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.oauth_connect_commit(uuid, text, text, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------- 4. what an inbox run writes
-- The erase epoch of an account (career_host_commit raises it on "forget everything"); 0 when there is none.
create or replace function public.career_erase_epoch(p_user uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (w.value->>'epoch')::bigint from public.career_watch_kv w where w.user_id = p_user and w.key = 'career:account'), 0)
$$;
revoke all on function public.career_erase_epoch(uuid) from public, anon, authenticated;
grant execute on function public.career_erase_epoch(uuid) to service_role;

-- Is the mailbox still the person's to write from? The connection row is held (a disconnect waits for this transaction,
-- then its triggers erase what was written) and so is the account's erase row (an erase waits, then erases it). p_epoch:
-- the epoch the run read before it read the mail (null: not checked).
create or replace function public.career_mailbox_live(p_user uuid, p_provider text, p_epoch bigint) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare e bigint;
begin
  perform 1 from public.user_oauth_connections c where c.user_id = p_user and c.provider = p_provider for share;
  if not found then return false; end if;
  select coalesce((w.value->>'epoch')::bigint, 0) into e from public.career_watch_kv w where w.user_id = p_user and w.key = 'career:account' for share;
  if p_epoch is not null and coalesce(e, 0) > p_epoch then return false; end if;
  return true;
end $$;
revoke all on function public.career_mailbox_live(uuid, text, bigint) from public, anon, authenticated;

-- Outlook: the messages of one sync round. -1: the mailbox is not the person's any more (nothing written).
create or replace function public.career_outlook_store_messages(p_user uuid, p_rows jsonb, p_epoch bigint default null) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_user is null or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'invalid rows'; end if;
  if not public.career_mailbox_live(p_user, 'microsoft', p_epoch) then return -1; end if;
  insert into public.career_outlook_messages(user_id, message_hash, conversation_hash, from_address, subject, preview, received_at)
  select p_user, r->>'message_hash', r->>'conversation_hash', r->>'from_address', r->>'subject', r->>'preview', (r->>'received_at')::timestamptz
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (user_id, message_hash) do update set conversation_hash = excluded.conversation_hash, from_address = excluded.from_address,
    subject = excluded.subject, preview = excluded.preview, received_at = excluded.received_at;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.career_outlook_store_messages(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.career_outlook_store_messages(uuid, jsonb, bigint) to service_role;

-- Gmail: the status events of one run. {ok:false}: not the person's any more; {ok:true, stored:[hashes]}: the ones new.
create or replace function public.career_mail_record_events(p_user uuid, p_rows jsonb, p_epoch bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare got jsonb;
begin
  if p_user is null or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'invalid rows'; end if;
  if not public.career_mailbox_live(p_user, 'google_career', p_epoch) then return jsonb_build_object('ok', false); end if;
  with ins as (
    insert into public.career_mail_events(user_id, application_ref, kind, company, role, stage, flagged, evidence, message_hash, mail_at)
    select p_user, r->>'application_ref', r->>'kind', r->>'company', r->>'role', r->>'stage', coalesce((r->>'flagged')::boolean, false),
      r->>'evidence', r->>'message_hash', (r->>'mail_at')::timestamptz
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
    on conflict (user_id, message_hash) do nothing
    returning message_hash)
  select coalesce(jsonb_agg(message_hash), '[]'::jsonb) into got from ins;
  return jsonb_build_object('ok', true, 'stored', got);
end $$;
revoke all on function public.career_mail_record_events(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.career_mail_record_events(uuid, jsonb, bigint) to service_role;

-- 'saved' | 'duplicate' (made before, once ever) | 'gone' (not the person's mailbox any more).
create or replace function public.career_mail_save_draft(p_user uuid, p_row jsonb, p_epoch bigint default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_user is null or jsonb_typeof(p_row) <> 'object' then raise exception 'invalid draft'; end if;
  if not public.career_mailbox_live(p_user, 'google_career', p_epoch) then return 'gone'; end if;
  insert into public.career_mail_drafts(user_id, draft_key, application_ref, kind, company, role, text, basis)
  values (p_user, p_row->>'draft_key', p_row->>'application_ref', p_row->>'kind', p_row->>'company', p_row->>'role', p_row->>'text', p_row->>'basis')
  on conflict (user_id, draft_key) do nothing;
  get diagnostics n = row_count;
  return case when n = 1 then 'saved' else 'duplicate' end;
end $$;
revoke all on function public.career_mail_save_draft(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.career_mail_save_draft(uuid, jsonb, bigint) to service_role;

-- The read position: kept through an erase (20261026230100), never re-created for a disconnected mailbox.
create or replace function public.career_mail_save_cursor(p_user uuid, p_read_through timestamptz) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null or p_read_through is null then raise exception 'invalid cursor'; end if;
  if not public.career_mailbox_live(p_user, 'google_career', null) then return false; end if;
  insert into public.career_mail_cursors(user_id, read_through, updated_at) values (p_user, p_read_through, now())
  on conflict (user_id) do update set read_through = excluded.read_through, updated_at = excluded.updated_at;
  return true;
end $$;
revoke all on function public.career_mail_save_cursor(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.career_mail_save_cursor(uuid, timestamptz) to service_role;
