-- D-062 (owner, 2026-11-11, in chat: "be able to answer emails ... do all of it"; Instinct read three Gmail accounts): more than one
-- Google account per person. The first career Google grant stays where it is (user_oauth_connections, provider google_career,
-- Vault oauth_google_career_<uid>): every guard written for it is unchanged. Connecting ANOTHER address no longer replaces it:
-- it is added here, one row per address, each with its own Vault entry; each can be disconnected alone; deleting the account
-- removes every row and every token (cascade + trigger), and "disconnect gmail" removes them all (google_disconnect.ts).
--   1. career_google_accounts       the added accounts: service role only (RLS on, no client access), one address one person.
--   2. Vault names                  oauth_google_career_<uid>_<md5(address)>, derived, never read from a row (the guard and the
--                                   cleanup derive the same name), so no row can point at another person's secret.
--   3. career_google_account_commit 'primary' (no first grant yet, or the first grant's own address: the caller stores it with
--                                   oauth_connect_commit as before) | 'added' | 'taken' (another Trainee person holds the address)
--                                   | 'limit' (5 added accounts) | 'gone' (no such person) | 'invalid'.
--   4. career_google_account_vault_refresh  a refreshed token written back only over the same address and the same grant.
--   5. career_mail_events.mailbox   which account an email was read from (null: the first grant, as before). A row is recorded
--                                   only for an address the person has connected now; disconnecting an added account deletes
--                                   the events read from it, and disconnecting the first grant no longer deletes the others'.
--   6. career_mailbox_live / career_mailbox_is   an added account keeps the person's mail run alive and is the person's mailbox.
-- Additive and idempotent. Never applied to a live database by an agent (owner's go-live). Reverse:
-- supabase/rollbacks/20261111120000_career_google_accounts.down.sql.

-- ---------------------------------------------------------------------------------------------- 1. the table
create table if not exists public.career_google_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  mailbox text not null check (mailbox = lower(btrim(mailbox)) and mailbox ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(mailbox) <= 254),
  vault_name text not null,
  scopes text,
  connected_at timestamptz not null default now(),
  primary key (user_id, mailbox)
);
create unique index if not exists career_google_accounts_one_person on public.career_google_accounts (mailbox);
alter table public.career_google_accounts enable row level security;
revoke all on public.career_google_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.career_google_accounts to service_role;
drop policy if exists career_google_accounts_service on public.career_google_accounts;
create policy career_google_accounts_service on public.career_google_accounts for all to service_role using (true) with check (true);

create or replace function public.career_google_account_vault_name(p_user uuid, p_mailbox text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select 'oauth_google_career_' || p_user::text || '_' || md5(lower(btrim(p_mailbox)))
$$;
revoke all on function public.career_google_account_vault_name(uuid, text) from public, anon, authenticated;
grant execute on function public.career_google_account_vault_name(uuid, text) to service_role;

create or replace function public.career_google_account_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.vault_name <> public.career_google_account_vault_name(new.user_id, new.mailbox) then
    raise exception 'google account vault name must match owner and address';
  end if;
  return new;
end $$;
revoke all on function public.career_google_account_guard() from public, anon, authenticated;
drop trigger if exists career_google_accounts_guard on public.career_google_accounts;
create trigger career_google_accounts_guard before insert or update on public.career_google_accounts
  for each row execute function public.career_google_account_guard();

-- ---------------------------------------------------------------------------------------------- 5. which account an email came from
alter table public.career_mail_events add column if not exists mailbox text check (mailbox is null or (mailbox = lower(btrim(mailbox)) and length(mailbox) <= 254));

-- A deleted added account takes its token and what was read from it; nothing of another account's.
create or replace function public.career_google_account_cleanup() returns trigger
language plpgsql security definer set search_path = public, vault, pg_temp as $$
begin
  delete from vault.secrets where name = public.career_google_account_vault_name(old.user_id, old.mailbox);
  delete from public.career_mail_events where user_id = old.user_id and mailbox = old.mailbox;
  return old;
end $$;
revoke all on function public.career_google_account_cleanup() from public, anon, authenticated;
drop trigger if exists career_google_accounts_cleanup on public.career_google_accounts;
create trigger career_google_accounts_cleanup after delete on public.career_google_accounts
  for each row execute function public.career_google_account_cleanup();

-- The first grant's disconnect (or switch) erased every mail event; with added accounts it erases the first grant's own (mailbox
-- null, or its address) and leaves the added accounts' events. Everything else it did is unchanged.
create or replace function public.google_career_disconnect_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not public.career_connection_switched(old, new) then return new; end if;
  if old.provider = 'google_career' then
    delete from public.career_mail_events where user_id = old.user_id
      and (mailbox is null or mailbox = lower(btrim(coalesce(old.email, '')))
           or not exists (select 1 from public.career_google_accounts g where g.user_id = old.user_id and g.mailbox = career_mail_events.mailbox));
    delete from public.career_mail_drafts where user_id = old.user_id;
    delete from public.career_mail_cursors where user_id = old.user_id;
    delete from public.career_outbox where user_id = old.user_id and key like 'status:deadline:%' and delivered_at is null;
    delete from public.career_outbox where user_id = old.user_id and delivered_at is null
      and (public.career_mail_text_key(key) or key ~ '^followup:(followup|thank_you):');
    delete from public.career_watch_kv where user_id = old.user_id and key like 'career:confirm-ask:%' and value->>'state' = 'pending';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.google_career_disconnect_erase() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------- 3. connecting another account
create or replace function public.career_google_account_commit(p_user uuid, p_secret text, p_email text, p_scopes text, p_now timestamptz default now())
returns text
language plpgsql security definer set search_path = vault, public, pg_temp as $$
declare addr text; first_addr text; vname text; stamped text := p_secret; n int;
begin
  addr := nullif(lower(btrim(coalesce(p_email, ''))), '');
  if p_user is null or p_secret is null or addr is null or addr !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then return 'invalid'; end if;
  -- One connect of an address at a time (the same lock oauth_connect_commit takes for the Google family).
  perform pg_advisory_xact_lock(hashtextextended('google_career:' || addr, 31));
  select lower(btrim(coalesce(c.email, ''))) into first_addr from public.user_oauth_connections c
    where c.user_id = p_user and c.provider = 'google_career' for update;
  -- No first grant yet, or the first grant's own address: that grant's path (oauth_connect_commit), exactly as before; an address
  -- already added stays an added account (connected again: its token is replaced below).
  if (not found or first_addr = addr or first_addr = '')
     and not exists (select 1 from public.career_google_accounts g where g.user_id = p_user and g.mailbox = addr) then return 'primary'; end if;
  if exists (select 1 from public.user_oauth_connections c where c.provider in ('google_career', 'gmail') and c.user_id <> p_user and lower(btrim(coalesce(c.email, ''))) = addr)
     or exists (select 1 from public.career_google_accounts g where g.mailbox = addr and g.user_id <> p_user) then
    return 'taken';
  end if;
  perform 1 from auth.users u where u.id = p_user for share;
  if not found then return 'gone'; end if;
  select count(*) into n from public.career_google_accounts g where g.user_id = p_user and g.mailbox <> addr;
  if n >= 5 then return 'limit'; end if;
  begin
    if jsonb_typeof(p_secret::jsonb) = 'object' then stamped := (p_secret::jsonb || jsonb_build_object('grant', gen_random_uuid()::text, 'email', addr))::text; end if;
  exception when others then stamped := p_secret;
  end;
  vname := public.career_google_account_vault_name(p_user, addr);
  delete from vault.secrets where name = vname;
  perform vault.create_secret(stamped, vname, 'Trainee Google account token');
  insert into public.career_google_accounts(user_id, mailbox, vault_name, scopes, connected_at)
    values (p_user, addr, vname, p_scopes, coalesce(p_now, now()))
  on conflict (user_id, mailbox) do update set vault_name = excluded.vault_name, scopes = excluded.scopes, connected_at = excluded.connected_at;
  return 'added';
end $$;
revoke all on function public.career_google_account_commit(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.career_google_account_commit(uuid, text, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------- 4. a refresh of an added account
create or replace function public.career_google_account_vault_refresh(p_user uuid, p_mailbox text, p_secret text) returns boolean
language plpgsql security definer set search_path = vault, public, pg_temp as $$
declare addr text := lower(btrim(coalesce(p_mailbox, ''))); vname text; held text; held_grant text; tok_grant text; tok_email text;
begin
  if p_user is null or addr = '' or p_secret is null then raise exception 'invalid account'; end if;
  perform 1 from public.career_google_accounts g where g.user_id = p_user and g.mailbox = addr for update;
  if not found then return false; end if;
  begin tok_email := nullif(lower(btrim(p_secret::jsonb->>'email')), ''); exception when others then tok_email := null; end;
  if tok_email is not null and tok_email <> addr then return false; end if;
  vname := public.career_google_account_vault_name(p_user, addr);
  select s.decrypted_secret into held from vault.decrypted_secrets s where s.name = vname limit 1;
  begin held_grant := nullif(held::jsonb->>'grant', ''); exception when others then held_grant := null; end;
  begin tok_grant := nullif(p_secret::jsonb->>'grant', ''); exception when others then tok_grant := null; end;
  if held_grant is not null and tok_grant is distinct from held_grant then return false; end if;
  delete from vault.secrets where name = vname;
  perform vault.create_secret(p_secret, vname, 'Trainee Google account token');
  return true;
end $$;
revoke all on function public.career_google_account_vault_refresh(uuid, text, text) from public, anon, authenticated;
grant execute on function public.career_google_account_vault_refresh(uuid, text, text) to service_role;

-- An added account's stored token, for the service role only (oauth_vault_read is name-based; this one is address-based).
create or replace function public.career_google_account_vault_read(p_user uuid, p_mailbox text) returns text
language plpgsql security definer set search_path = vault, public, pg_temp as $$
declare addr text := lower(btrim(coalesce(p_mailbox, ''))); s text;
begin
  if not exists (select 1 from public.career_google_accounts g where g.user_id = p_user and g.mailbox = addr) then return null; end if;
  select d.decrypted_secret into s from vault.decrypted_secrets d where d.name = public.career_google_account_vault_name(p_user, addr) limit 1;
  return s;
end $$;
revoke all on function public.career_google_account_vault_read(uuid, text) from public, anon, authenticated;
grant execute on function public.career_google_account_vault_read(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------- 6. the person's mailboxes
create or replace function public.career_mailbox_live(p_user uuid, p_provider text, p_epoch bigint) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare e bigint;
begin
  perform 1 from public.user_oauth_connections c where c.user_id = p_user and c.provider = p_provider for share;
  if not found then
    if p_provider <> 'google_career' then return false; end if;
    perform 1 from public.career_google_accounts g where g.user_id = p_user for share;
    if not found then return false; end if;
  end if;
  select coalesce((w.value->>'epoch')::bigint, 0) into e from public.career_watch_kv w where w.user_id = p_user and w.key = 'career:account' for share;
  if p_epoch is not null and coalesce(e, 0) > p_epoch then return false; end if;
  return true;
end $$;
revoke all on function public.career_mailbox_live(uuid, text, bigint) from public, anon, authenticated;

create or replace function public.career_mailbox_is(p_user uuid, p_provider text, p_mailbox text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_mailbox is null or exists (select 1 from public.user_oauth_connections c where c.user_id = p_user and c.provider = p_provider
    and lower(btrim(coalesce(c.email, ''))) = lower(btrim(p_mailbox)))
    or (p_provider = 'google_career' and exists (select 1 from public.career_google_accounts g where g.user_id = p_user and g.mailbox = lower(btrim(p_mailbox))))
$$;
revoke all on function public.career_mailbox_is(uuid, text, text) from public, anon, authenticated;

-- Each event carries the account it was read from; a row naming an address the person has not connected now is not recorded.
create or replace function public.career_mail_record_events(p_user uuid, p_rows jsonb, p_epoch bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare got jsonb;
begin
  if p_user is null or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'invalid rows'; end if;
  if not public.career_mailbox_live(p_user, 'google_career', p_epoch) then return jsonb_build_object('ok', false); end if;
  with ins as (
    insert into public.career_mail_events(user_id, application_ref, kind, company, role, stage, flagged, evidence, message_hash, mail_at, mailbox)
    select p_user, r->>'application_ref', r->>'kind', r->>'company', r->>'role', r->>'stage', coalesce((r->>'flagged')::boolean, false),
      r->>'evidence', r->>'message_hash', (r->>'mail_at')::timestamptz, nullif(lower(btrim(coalesce(r->>'mailbox', ''))), '')
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
    where nullif(btrim(coalesce(r->>'mailbox', '')), '') is null or public.career_mailbox_is(p_user, 'google_career', r->>'mailbox')
    on conflict (user_id, message_hash) do nothing
    returning message_hash)
  select coalesce(jsonb_agg(message_hash), '[]'::jsonb) into got from ins;
  return jsonb_build_object('ok', true, 'stored', got);
end $$;
revoke all on function public.career_mail_record_events(uuid, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.career_mail_record_events(uuid, jsonb, bigint) to service_role;

-- ---------------------------------------------------------------------------------------------- 7. the first grant's "taken"
-- Round 4's oauth_connect_commit, unchanged but for one more case of 'taken': an address another person holds as an added account.
create or replace function public.oauth_connect_commit(p_user uuid, p_provider text, p_secret text, p_email text, p_scopes text, p_now timestamptz default now())
returns text
language plpgsql security definer set search_path = vault, public, pg_temp as $$
declare fam text[]; addr text; vname text; stamped text := p_secret;
begin
  if p_user is null or p_secret is null or p_provider not in ('google_career', 'gmail', 'microsoft') then return 'invalid'; end if;
  addr := nullif(lower(btrim(coalesce(p_email, ''))), '');
  fam := case when p_provider = 'microsoft' then array['microsoft'] else array['google_career', 'gmail'] end;
  if addr is not null then
    -- Two connects of the same address at once: one at a time.
    perform pg_advisory_xact_lock(hashtextextended(fam[1] || ':' || addr, 31));
    if exists (select 1 from public.user_oauth_connections c where c.provider = any(fam) and c.user_id <> p_user
               and lower(btrim(coalesce(c.email, ''))) = addr)
       -- D-062: an address another person added as an extra account is theirs too.
       or (p_provider <> 'microsoft' and exists (select 1 from public.career_google_accounts g where g.mailbox = addr and g.user_id <> p_user)) then
      return 'taken';
    end if;
  end if;
  -- The account, held until this commits: a deletion waits, then cascades the row (and, by its trigger, the Vault entry).
  -- Checked after 'taken': a grant another account shares at Google is never the one revoked for a gone account.
  perform 1 from auth.users u where u.id = p_user for share;
  if not found then return 'gone'; end if;
  -- Round 4: this grant's own id, carried by every refresh of it (oauth_vault_refresh writes only over the same grant).
  begin
    if jsonb_typeof(p_secret::jsonb) = 'object' then stamped := (p_secret::jsonb || jsonb_build_object('grant', gen_random_uuid()::text))::text; end if;
  exception when others then stamped := p_secret;
  end;
  vname := 'oauth_' || p_provider || '_' || p_user::text;
  delete from vault.secrets where name = vname;
  perform vault.create_secret(stamped, vname, 'Upmore OAuth token');
  insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes, connected_at)
    values (p_user, p_provider, vname, p_email, p_scopes, coalesce(p_now, now()))
  on conflict (user_id, provider) do update set vault_name = excluded.vault_name, email = excluded.email, scopes = excluded.scopes,
    connected_at = excluded.connected_at;
  return 'connected';
end $$;
revoke all on function public.oauth_connect_commit(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.oauth_connect_commit(uuid, text, text, text, text, timestamptz) to service_role;
