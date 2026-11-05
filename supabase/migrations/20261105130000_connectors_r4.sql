-- CONNECTORS, DISCONNECT AND ERASE, ROUND 4 (2026-11-05; tests/architect/scenarios-connectors-r4.test.ts, ~10,000 generated
-- deliveries, mail runs, token refreshes and erase retries, and tests/architect/flow-scenarios-connectors-r4.test.ts, the same
-- on real Postgres through the real mail run, delivery run and disconnects). What the database let through:
--   The texts the scheduled Gmail run queues from a person's mail outlived "disconnect gmail" (and connecting another Google
--   account, which is the old mailbox's disconnect). 20261103100000 deleted only the undelivered deadline reminder
--   (status:deadline:<message>); every other text read from that mailbox stayed queued and went out after the person was
--   told "Gmail is disconnected ... I deleted the application updates I had read from your Gmail", most of them the next
--   morning, since they wait out the person's quiet hours:
--     status:<message hash>          "Acme moved you to interviews ..." (the email's subject quoted), a cancellation;
--     brief:<message hash>:<n|moved> the interview brief made from an invite (its time, its interviewers);
--     status:confirmed:<application> "Acme confirmed your application by email";
--     status:which:<message hash>    "which application does this email confirm?" (and the pending ask behind it,
--                                    career:confirm-ask:<message hash>, which the next run would have texted);
--     followup:followup:<ref>, followup:thank_you:<ref>:<day>  the offer of a draft that the same disconnect deletes
--                                    (career_mail_drafts), so a "yes" to it found nothing.
--   And a mail run that read the inbox before the disconnect committed queued its texts after it (runMail checks the
--   connection, then queues: a disconnect in between left them queued for a mailbox that is gone).
-- Now:
--   1. career_mail_text_key(key) (new): the keys of texts made from a person's mail (the list above but the draft offers).
--   2. google_career_disconnect_erase() is 20261103100000's with the undelivered texts of every key above deleted (the
--      deadline reminder as before), and the pending "which application" asks; a delivered text stays (the person's own
--      history), as does every other kind (job alerts, receipts, replies, outreach follow-ups).
--   3. career_mail_text_enqueue (new): the mail run queues a text made from mail only while the person's career Google row
--      exists, holding that row until the insert commits (a disconnect waits for it, then deletes it); 'gone' queues
--      nothing (career_alert_store.ts enqueue; a project without this function inserts as before).
--   And the delivery run looks again right before it sends such a text (channel.ts stillQueued): one a run had claimed
--   before the disconnect deleted it is not sent.
--   4. A token refresh that read the grant before a disconnect and wrote after the person connected the same account
--      again overwrote the new grant with the old (revoked) one: each connect now stamps its grant, and a refresh is written
--      only over the grant it read (oauth_connect_commit, oauth_vault_refresh).
--   5. A mail run that read one Google account's mail while the person connected another wrote what it read under the new
--      account (events, drafts, its read position, its texts): the writes now carry the address the run read and are
--      refused for another (career_mailbox_is; overloads of round 3's writes; career_mail_text_enqueue's p_mailbox). The same for
--      Outlook's sync (career_outlook_store_messages).
-- Idempotent; service role only. Reverse: supabase/rollbacks/20261105130000_connectors_r4.down.sql.

-- ---------------------------------------------------------------------------------------------- 1. what is made from mail
create or replace function public.career_mail_text_key(p_key text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_key ~ '^(status:([0-9a-f]{64}|deadline:[0-9a-f]{64}|confirmed:[^:]+|which:[0-9a-f]{64})|brief:[0-9a-f]{64}:[^:]+)$', false)
$$;
revoke all on function public.career_mail_text_key(text) from public, anon, authenticated;
grant execute on function public.career_mail_text_key(text) to service_role;

-- ---------------------------------------------------------------------------------------------- 2. the disconnect
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

-- ---------------------------------------------------------------------------------------------- 1b. the mailbox a run read
-- Is the person's connection of this provider still at the address a run read the mail from? null p_mailbox: not checked
-- (a caller that does not say). Compared without case or spaces, as oauth_connect_commit compares addresses.
create or replace function public.career_mailbox_is(p_user uuid, p_provider text, p_mailbox text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_mailbox is null or exists (select 1 from public.user_oauth_connections c where c.user_id = p_user and c.provider = p_provider
    and lower(btrim(coalesce(c.email, ''))) = lower(btrim(p_mailbox)))
$$;
revoke all on function public.career_mailbox_is(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------- 3. queued after it
-- A text made from mail, queued only while the person's career Google row exists; that row is held until the insert commits
-- (a disconnect waits for it, then deletes it with the rest). 'queued' | 'duplicate' (queued or sent before: once per key,
-- ever) | 'gone' (no career Google row: nothing queued) | 'invalid' (not a mail text's key).
-- p_mailbox: the address the run read the mail from (null: not checked); a run that read another account's mail than the one
-- connected now (the person connected another Google account meanwhile) queues nothing ('gone').
create or replace function public.career_mail_text_enqueue(p_user uuid, p_key text, p_kind text, p_text text, p_at timestamptz, p_mailbox text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_user is null or not public.career_mail_text_key(p_key) or p_at is null then return 'invalid'; end if;
  perform 1 from public.user_oauth_connections c where c.user_id = p_user and c.provider = 'google_career' for share;
  if not found or not public.career_mailbox_is(p_user, 'google_career', p_mailbox) then return 'gone'; end if;
  insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (p_user, p_key, p_kind, p_text, p_at)
  on conflict (user_id, key) do nothing;
  get diagnostics n = row_count;
  return case when n = 1 then 'queued' else 'duplicate' end;
end $$;
revoke all on function public.career_mail_text_enqueue(uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.career_mail_text_enqueue(uuid, text, text, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------------------------- 4. a refresh of a grant gone
-- A refresh that read the person's tokens before "disconnect gmail|outlook" and wrote them back after the person had connected
-- THE SAME account again (a new grant: the disconnect revoked the old one at Google) passed oauth_vault_refresh's checks (the
-- row is there, the address is the same) and overwrote the new grant's tokens with the old grant's: the connection the
-- person had just made was dead (Google refused the revoked refresh token at the next refresh), and the old grant's token was
-- used. Now each connect stamps the grant it stores (grant: a new id in the stored JSON, which every refresh carries over
-- with the rest of the secret), and a refresh is written only over the same grant. A secret stored before this (no grant)
-- is checked as before.
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

create or replace function public.oauth_vault_refresh(p_name text, p_secret text) returns boolean
language plpgsql security definer set search_path = vault, public, pg_temp as $$
declare conn_email text; tok_email text; held text; held_grant text; tok_grant text;
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
  -- Round 4: nor the same account's earlier grant (disconnected and connected again while it ran).
  select s.decrypted_secret into held from vault.decrypted_secrets s where s.name = p_name limit 1;
  begin held_grant := nullif(held::jsonb->>'grant', ''); exception when others then held_grant := null; end;
  begin tok_grant := nullif(p_secret::jsonb->>'grant', ''); exception when others then tok_grant := null; end;
  if held_grant is not null and tok_grant is distinct from held_grant then return false; end if;
  delete from vault.secrets where name = p_name;
  perform vault.create_secret(p_secret, p_name, 'Upmore OAuth token');
  return true;
end $$;
revoke all on function public.oauth_vault_refresh(text, text) from public, anon, authenticated;
grant execute on function public.oauth_vault_refresh(text, text) to service_role;

-- ---------------------------------------------------------------------------------------------- 5. the run's writes, bound
-- A mail run that read one Google account's mail while the person connected another (a connect link still open, the row's
-- address changed: 20261030050000 erases the old mailbox's rows on that update) wrote what it had read after the switch, under
-- the new account: round 3's writes check only that a connection row is there. The same writes with the address the run read
-- (p_mailbox), refused when the row's address is not that one; the row is held from the check to the write, so a switch
-- waits and then erases what was written. Overloads (no default for p_mailbox), so the round-3 calls are unchanged.
create or replace function public.career_mail_record_events(p_user uuid, p_rows jsonb, p_epoch bigint, p_mailbox text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.career_mailbox_live(p_user, 'google_career', p_epoch) or not public.career_mailbox_is(p_user, 'google_career', p_mailbox) then
    return jsonb_build_object('ok', false); end if;
  return public.career_mail_record_events(p_user, p_rows, p_epoch);
end $$;
revoke all on function public.career_mail_record_events(uuid, jsonb, bigint, text) from public, anon, authenticated;
grant execute on function public.career_mail_record_events(uuid, jsonb, bigint, text) to service_role;

create or replace function public.career_mail_save_draft(p_user uuid, p_row jsonb, p_epoch bigint, p_mailbox text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.career_mailbox_live(p_user, 'google_career', p_epoch) or not public.career_mailbox_is(p_user, 'google_career', p_mailbox) then return 'gone'; end if;
  return public.career_mail_save_draft(p_user, p_row, p_epoch);
end $$;
revoke all on function public.career_mail_save_draft(uuid, jsonb, bigint, text) from public, anon, authenticated;
grant execute on function public.career_mail_save_draft(uuid, jsonb, bigint, text) to service_role;

-- The read position of the old mailbox is never saved for the new one (it would skip the new mailbox's mail before it).
create or replace function public.career_mail_save_cursor(p_user uuid, p_read_through timestamptz, p_mailbox text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.career_mailbox_live(p_user, 'google_career', null) or not public.career_mailbox_is(p_user, 'google_career', p_mailbox) then return false; end if;
  return public.career_mail_save_cursor(p_user, p_read_through);
end $$;
revoke all on function public.career_mail_save_cursor(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.career_mail_save_cursor(uuid, timestamptz, text) to service_role;

-- Outlook's sync, the same: the messages of one round, refused for another Microsoft address than the one the sync read.
create or replace function public.career_outlook_store_messages(p_user uuid, p_rows jsonb, p_epoch bigint, p_mailbox text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'invalid rows'; end if;
  if not public.career_mailbox_live(p_user, 'microsoft', p_epoch) or not public.career_mailbox_is(p_user, 'microsoft', p_mailbox) then return -1; end if;
  return public.career_outlook_store_messages(p_user, p_rows, p_epoch);
end $$;
revoke all on function public.career_outlook_store_messages(uuid, jsonb, bigint, text) from public, anon, authenticated;
grant execute on function public.career_outlook_store_messages(uuid, jsonb, bigint, text) to service_role;
