-- Reverses 20261105130000_connectors_r4.sql: the disconnect erase goes back to 20261103100000's body (the undelivered
-- deadline reminder only), and the guarded mail-text queue and the key test are dropped (the mail run then inserts its
-- texts as before). Texts and asks already deleted stay deleted.
create or replace function public.google_career_disconnect_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not public.career_connection_switched(old, new) then return new; end if;
  if old.provider = 'google_career' then
    delete from public.career_mail_events where user_id = old.user_id;
    delete from public.career_mail_drafts where user_id = old.user_id;
    delete from public.career_mail_cursors where user_id = old.user_id;
    delete from public.career_outbox where user_id = old.user_id and key like 'status:deadline:%' and delivered_at is null;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.google_career_disconnect_erase() from public, anon, authenticated;

drop function if exists public.career_mail_text_key(text);
drop function if exists public.career_mail_text_enqueue(uuid, text, text, text, timestamptz, text);
drop function if exists public.career_mail_record_events(uuid, jsonb, bigint, text);
drop function if exists public.career_mail_save_draft(uuid, jsonb, bigint, text);
drop function if exists public.career_mail_save_cursor(uuid, timestamptz, text);
drop function if exists public.career_outlook_store_messages(uuid, jsonb, bigint, text);
drop function if exists public.career_mailbox_is(uuid, text, text);
-- oauth_connect_commit and oauth_vault_refresh go back to 20261031060000's and 20261030050000's bodies: re-apply those two
-- functions from their files (a stored grant stamp is then ignored; it is part of the JSON only).
