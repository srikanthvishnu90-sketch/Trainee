-- ERASE SCENARIOS, ROUND 2 (2026-10-30; tests/architect/scenarios-erase-r2.test.ts, ~10,000 generated account deletions,
-- refresh races and replies, and tests/architect/flow-scenarios-erase-r2.test.ts, people deleted mid-activity on Postgres
-- with the whole schema scanned for any row still tied to them). What the database let through:
--   1. A token refresh in flight outlived a disconnect or an account deletion. Every refresh writes the new tokens back with
--      oauth_vault_store, which writes whatever it is given: a refresh that read the grant before "disconnect gmail" (or
--      delete-account) committed wrote a fresh Vault entry after it, with the refresh token, for a connection (or a
--      person) that no longer exists. Nothing ever removed it. oauth_vault_refresh (new) writes the refreshed tokens only
--      while the connection row is there, holding that row so a disconnect waits for it (and then deletes what it wrote);
--      a refresh that finds the row gone writes nothing and says so (false), and the caller does not use the token. The
--      same for a refresh of the account the person had before connecting another (the secret's email is not the row's):
--      it never overwrites the new account's tokens with the old account's.
--      oauth_vault_store is unchanged: connecting writes the Vault before the row exists.
--   2. Connecting again with a different account replaced the connection row in place (an upsert, an UPDATE), and every
--      disconnect rule fires on its DELETE only: the emails approved and queued to go from the old mailbox, the replies
--      lane's approved follow-ups on its threads and the mail read from it stayed, and went from (or were read against)
--      the new account. Now a connection row whose address changes is the old mailbox's disconnect, rule for rule
--      (career_send_on_google, career_connector_on_disconnect, google_career_disconnect_erase, career_outlook_on_disconnect
--      are redefined: the same bodies, also on that UPDATE). The same account connecting again (its address unchanged)
--      keeps everything, as before. An address that cannot be told (the new one unknown) counts as a change: the person
--      approves those emails again rather than one going from an account they did not approve it for.
--   3. A deleted account was not quiet. career_user_quiet read the account's pause and the contacts' opt-out, both gone with
--      the account, so it answered false: a delivery run that had claimed a job alert before the deletion sent it to the
--      person's chat after. An account that no longer exists is now quiet; career_account_gone (new) is the same check for
--      the answers to the person's own messages, which a pause does not hold.
--   4. account_deletion_log (new): one row per account deletion, with nothing that names the person: when, whether the
--      account went, what Google answered each grant's revoke, whether an Outlook grant existed (Microsoft has no revoke
--      endpoint) and what could not be done, in plain words. delete-account writes it after the account is gone, so a
--      revoke Google did not confirm is on record (the person is told in the same answer).
-- Idempotent; service role only.

-- ---------------------------------------------------------------------------------------------- 1. the refresh write
create or replace function public.oauth_vault_refresh(p_name text, p_secret text) returns boolean
language plpgsql security definer set search_path = vault, public, pg_temp as $$
declare conn_email text; tok_email text;
begin
  if p_name is null or p_name not like 'oauth\_%' or p_secret is null then raise exception 'invalid vault name'; end if;
  -- The connection this entry belongs to, held until the write commits (a disconnect's delete waits for it).
  select c.email into conn_email from public.user_oauth_connections c
    where c.vault_name = p_name and p_name = 'oauth_' || c.provider || '_' || c.user_id::text
    for update;
  if not found then return false; end if;
  -- A refresh of the account the person connected before (they connected another one while it ran) never overwrites the
  -- new account's tokens: the stored secret names its account (email), and it must be the connection's.
  begin tok_email := nullif(lower(btrim(p_secret::jsonb->>'email')), ''); exception when others then tok_email := null; end;
  if tok_email is not null and tok_email is distinct from nullif(lower(btrim(conn_email)), '') then return false; end if;
  delete from vault.secrets where name = p_name;
  perform vault.create_secret(p_secret, p_name, 'Upmore OAuth token');
  return true;
end $$;
revoke all on function public.oauth_vault_refresh(text, text) from public, anon, authenticated;
grant execute on function public.oauth_vault_refresh(text, text) to service_role;

-- ---------------------------------------------------------------------------------------------- 2. another account
-- The old mailbox of a connection row: on its delete, or on an update to another address.
create or replace function public.career_connection_switched(o public.user_oauth_connections, n public.user_oauth_connections) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select o.provider = n.provider and lower(btrim(coalesce(o.email, ''))) <> lower(btrim(coalesce(n.email, '')))
$$;
revoke all on function public.career_connection_switched(public.user_oauth_connections, public.user_oauth_connections) from public, anon, authenticated;

create or replace function public.career_send_on_google() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare prov text; label text;
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and public.career_connection_switched(old, new)) then
    prov := case old.provider when 'google_career' then 'gmail' when 'microsoft' then 'outlook' end;
    if prov is not null then
      label := case prov when 'gmail' then 'Gmail' else 'Outlook' end;
      -- Every email waiting or held: cancelled. A held one keeps its lease owner (career_send_complete_one).
      update public.career_send_queue set state = 'cancelled', result = prov || ' disconnected', updated_at = now(),
        lease_owner = case when state = 'sending' then lease_owner end, lease_until = case when state = 'sending' then lease_until end
      where user_id = old.user_id and provider = prov and state in ('queued', 'sending');
      update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = prov || ' disconnected', updated_at = now()
      where user_id = old.user_id and status in ('approved', 'sending')
        and id in (select source_id from public.career_send_queue where user_id = old.user_id and kind = 'outreach' and provider = prov
                   and state = 'cancelled' and result = prov || ' disconnected' and updated_at = now());
      -- The replies lane: a follow-up handed to the rail and cancelled just above never went: taken back, not counted.
      with a as (
        update public.career_outreach_actions x set status = 'cancelled', result = left('not sent: ' || label || ' disconnected', 300), updated_at = now()
        where x.user_id = old.user_id and x.status = 'done'
          and x.thread_id in (select t.id from public.career_outreach_threads t where t.user_id = old.user_id and t.provider = prov)
          and x.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and exists (select 1 from public.career_send_queue s where s.id = x.provider_ref::uuid and s.user_id = old.user_id and s.state = 'cancelled'
                      and s.sent_at is null and s.lease_owner is null and s.result = prov || ' disconnected' and s.updated_at = now())
        returning x.thread_id, x.kind
      )
      update public.career_outreach_threads h set followups_sent = greatest(h.followups_sent - k.n, 0), updated_at = now()
      from (select thread_id, count(*)::int n from a where kind = 'followup' group by thread_id) k where h.id = k.thread_id;
      -- Not handed yet (waiting for the yes, approved, being handed): cancelled; the person approves again to send.
      update public.career_outreach_actions x set status = 'cancelled', result = left('not sent: ' || label || ' disconnected', 300),
        lease_owner = null, lease_until = null, updated_at = now()
      where x.user_id = old.user_id and x.status in ('shown', 'approved', 'running')
        and x.thread_id in (select t.id from public.career_outreach_threads t where t.user_id = old.user_id and t.provider = prov);
      update public.career_outreach_threads set followup_state = 'none', updated_at = now()
      where user_id = old.user_id and provider = prov and followup_state = 'drafted';
      -- What was read from the mailbox: the other side's turns and the read position.
      delete from public.career_outreach_turns u where u.user_id = old.user_id and u.who <> 'person'
        and u.thread_id in (select t.id from public.career_outreach_threads t where t.user_id = old.user_id and t.provider = prov);
      update public.career_outreach_threads t set turns = (select count(*) from public.career_outreach_turns u where u.thread_id = t.id), updated_at = now()
      where t.user_id = old.user_id and t.provider = prov;
      update public.career_outreach_sync set cursor = null where user_id = old.user_id and provider = prov;
      update public.career_send_accounts set state = 'disconnected', has_work = false, reason = prov || ' disconnected', updated_at = now()
      where user_id = old.user_id and provider = prov;
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;
  prov := case new.provider when 'google_career' then 'gmail' when 'microsoft' then 'outlook' end;
  if prov is not null then
    update public.career_send_accounts set state = 'ok', resume_at = null, reason = null, strikes = 0, updated_at = now(),
      has_work = exists (select 1 from public.career_send_queue where user_id = new.user_id and provider = prov and state = 'queued')
    where user_id = new.user_id and provider = prov and state in ('needs_reconnect', 'disconnected');
  end if;
  return new;
end $$;
revoke all on function public.career_send_on_google() from public, anon, authenticated;
drop trigger if exists user_oauth_connections_send_rail on public.user_oauth_connections;
create trigger user_oauth_connections_send_rail after insert or update or delete on public.user_oauth_connections
  for each row execute function public.career_send_on_google();

create or replace function public.career_connector_on_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not public.career_connection_switched(old, new) then return new; end if;
  if old.provider in ('google_career', 'microsoft') then
    -- Every approved outreach email that has not gone yet, except one queued to go from the person's other mailbox.
    update public.career_outreach_drafts d set status = 'skipped', result = 'cancelled: ' || case when old.provider = 'microsoft' then 'Outlook' else 'Gmail' end || ' disconnected', updated_at = now()
      where d.user_id = old.user_id and d.status = 'approved'
        and not exists (select 1 from public.career_send_queue q where q.user_id = old.user_id and q.kind = 'outreach' and q.source_id = d.id
          and q.state in ('queued', 'sending') and q.provider <> case when old.provider = 'microsoft' then 'outlook' else 'gmail' end);
  end if;
  -- A live link is burned on a disconnect; on another account's connect, the link that connected it is being finished.
  if tg_op = 'DELETE' and old.provider in ('google_career', 'gmail') then
    update public.career_connector_links set opened_at = coalesce(opened_at, now()), finished_at = now(), outcome = coalesce(outcome, 'error')
      where user_id = old.user_id and connector = 'gmail' and finished_at is null;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.career_connector_on_disconnect() from public, anon, authenticated;
drop trigger if exists user_oauth_connections_connector_cancel on public.user_oauth_connections;
create trigger user_oauth_connections_connector_cancel after delete or update on public.user_oauth_connections
  for each row execute function public.career_connector_on_disconnect();

create or replace function public.google_career_disconnect_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not public.career_connection_switched(old, new) then return new; end if;
  if old.provider = 'google_career' then
    delete from public.career_mail_events where user_id = old.user_id;
    delete from public.career_mail_drafts where user_id = old.user_id;
    delete from public.career_mail_cursors where user_id = old.user_id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.google_career_disconnect_erase() from public, anon, authenticated;
drop trigger if exists user_oauth_connections_google_erase on public.user_oauth_connections;
create trigger user_oauth_connections_google_erase after delete or update on public.user_oauth_connections
  for each row execute function public.google_career_disconnect_erase();

create or replace function public.career_outlook_on_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not public.career_connection_switched(old, new) then return new; end if;
  if old.provider = 'microsoft' then
    delete from public.career_outlook_messages where user_id = old.user_id;
    -- The new account's connect writes its own state right after its row.
    delete from public.career_outlook_state where user_id = old.user_id;
    update public.career_outlook_sends set status = 'cancelled', detail = 'Outlook disconnected', updated_at = now()
      where user_id = old.user_id and status in ('sending', 'rate_limited', 'refused');
    if tg_op = 'DELETE' then
      update public.career_outlook_links set opened_at = coalesce(opened_at, now()), finished_at = now(), outcome = coalesce(outcome, 'error')
        where user_id = old.user_id and finished_at is null;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.career_outlook_on_disconnect() from public, anon, authenticated;
drop trigger if exists user_oauth_connections_outlook_erase on public.user_oauth_connections;
create trigger user_oauth_connections_outlook_erase after delete or update on public.user_oauth_connections
  for each row execute function public.career_outlook_on_disconnect();

-- ---------------------------------------------------------------------------------------------- 3. a deleted account is quiet
create or replace function public.career_user_quiet(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select w.value->'paused' = 'true'::jsonb from public.career_watch_kv w
                   where w.user_id = p_user and w.key = 'career:account'), false)
      or exists (select 1 from public.channel_contacts c where c.user_id = p_user and c.opted_out)
      or not exists (select 1 from auth.users u where u.id = p_user)
$$;
revoke all on function public.career_user_quiet(uuid) from public, anon, authenticated;
grant execute on function public.career_user_quiet(uuid) to service_role;

create or replace function public.career_account_gone(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_user is null or not exists (select 1 from auth.users u where u.id = p_user)
$$;
revoke all on function public.career_account_gone(uuid) from public, anon, authenticated;
grant execute on function public.career_account_gone(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------- 4. the deletion record
create table if not exists public.account_deletion_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  deleted boolean not null,
  google jsonb not null default '{}'::jsonb check (jsonb_typeof(google) = 'object'
    and not jsonb_path_exists(google, '$.* ? (@ != "revoked" && @ != "refused" && @ != "not_confirmed" && @ != "no_token")')),
  outlook boolean not null default false,
  failures text[] not null default '{}' check (cardinality(failures) <= 20)
);
alter table public.account_deletion_log enable row level security;
revoke all on public.account_deletion_log from public, anon, authenticated;
grant select, insert on public.account_deletion_log to service_role;
grant usage, select on sequence public.account_deletion_log_id_seq to service_role;
