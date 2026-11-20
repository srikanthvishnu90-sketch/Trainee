-- Reverse of 20261111120000_career_google_accounts.sql: the earlier definitions back (connectors r3/r4), the added accounts gone.
-- Every added account's token is deleted with its row (the cleanup trigger runs on the delete below, before it is dropped).
delete from public.career_google_accounts;
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

create or replace function public.career_mailbox_is(p_user uuid, p_provider text, p_mailbox text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_mailbox is null or exists (select 1 from public.user_oauth_connections c where c.user_id = p_user and c.provider = p_provider
    and lower(btrim(coalesce(c.email, ''))) = lower(btrim(p_mailbox)))
$$;
revoke all on function public.career_mailbox_is(uuid, text, text) from public, anon, authenticated;

create or replace function public.google_career_disconnect_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not public.career_connection_switched(old, new) then return new; end if;
  if old.provider = 'google_career' then
    delete from public.career_mail_events where user_id = old.user_id;
    delete from public.career_mail_drafts where user_id = old.user_id;
    delete from public.career_mail_cursors where user_id = old.user_id;
    delete from public.career_outbox where user_id = old.user_id and key like 'status:deadline:%' and delivered_at is null;
    -- Round 4: every undelivered text made from that mailbox, and the offers of the drafts deleted just above.
    delete from public.career_outbox where user_id = old.user_id and delivered_at is null
      and (public.career_mail_text_key(key) or key ~ '^followup:(followup|thank_you):');
    delete from public.career_watch_kv where user_id = old.user_id and key like 'career:confirm-ask:%' and value->>'state' = 'pending';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.google_career_disconnect_erase() from public, anon, authenticated;

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
               and lower(btrim(coalesce(c.email, ''))) = addr) then
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

drop function if exists public.career_google_account_commit(uuid, text, text, text, timestamptz);
drop function if exists public.career_google_account_vault_refresh(uuid, text, text);
drop function if exists public.career_google_account_vault_read(uuid, text);
drop table if exists public.career_google_accounts;
drop function if exists public.career_google_account_cleanup();
drop function if exists public.career_google_account_guard();
drop function if exists public.career_google_account_vault_name(uuid, text);
alter table public.career_mail_events drop column if exists mailbox;
