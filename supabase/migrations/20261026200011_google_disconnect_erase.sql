-- Google verification (owner, 2026-10-26: "yes start google's verification"). Disconnecting Google deletes what Trainee
-- derived from the person's Gmail, not only the tokens. Until now a disconnect (gmail-oauth "disconnect", the chat's
-- "disconnect gmail") deleted the connection row and its Vault entry (20261012060000) but kept the mail-tracking rows
-- read from that Gmail (20261020100000): the status events (kind, employer, an evidence line from the subject, a hash of
-- the message id), the follow-up and thank-you drafts made from them, and the read cursor. The privacy policy
-- (site/privacy.html, "Disconnecting Google") and the consent notice (_shared/google_scopes.ts) say a disconnect deletes
-- them, as Google's API Services User Data Policy expects of data obtained through restricted scopes.
--   One trigger on the career Google row's delete, whatever deletes it: a disconnect, a reconnect that replaces the row
--   is an UPDATE (upsert) and keeps them, an account deletion (the row cascades from auth.users) deletes them with the
--   account anyway. Only the row's own person is touched. The legacy finance grant (provider "gmail") never fed mail
--   tracking, so its delete changes nothing here.
--   Kept, and said so in the policy: application stages already moved in the person's tracker, and messages already
--   delivered in the chat, which are the person's own history (deleted by "forget everything" or account deletion).
-- Idempotent.
create or replace function public.google_career_disconnect_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.provider = 'google_career' then
    delete from public.career_mail_events where user_id = old.user_id;
    delete from public.career_mail_drafts where user_id = old.user_id;
    delete from public.career_mail_cursors where user_id = old.user_id;
  end if;
  return old;
end $$;
revoke all on function public.google_career_disconnect_erase() from public, anon, authenticated;
drop trigger if exists user_oauth_connections_google_erase on public.user_oauth_connections;
create trigger user_oauth_connections_google_erase after delete on public.user_oauth_connections
  for each row execute function public.google_career_disconnect_erase();
