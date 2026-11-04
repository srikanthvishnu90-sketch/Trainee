-- Disconnecting Google also deletes the undelivered deadline reminder queued from the person's mail.
-- 20261026200011 (and 20261030050000_account_erase_r2, which redefined it) delete the mail events, drafts and read cursor
-- when the career Google row goes, but the deadline reminder queued from one of those emails lives in career_outbox
-- (key 'status:deadline:<message hash>', kind 'status') and survived: it would still be delivered after the person took
-- Trainee's access away, repeating an email's words.
-- This redefines google_career_disconnect_erase() exactly as 20261030050000 has it (same guard: an UPDATE only counts when
-- the address changed; same trigger) plus one delete: the person's UNDELIVERED rows of that key. A reminder already
-- delivered stays (it is part of the person's own history), as does every other outbox kind.
-- Idempotent (create or replace); the trigger from 20261030050000 is untouched. Reverse: supabase/rollbacks/20261103100000_google_disconnect_erase_outbox.down.sql.
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
