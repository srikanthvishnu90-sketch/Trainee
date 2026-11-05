-- CHANNEL DELIVERY ROUND 4 (2026-11-05): a person's STOP outlives the chat they said it on. Additive and idempotent.
--
-- STOP is the person's across channels (20261021070000_channel_parity.sql): channel_opted_out and career_user_quiet read it
-- from any of the person's channel_contacts rows. But it is recorded on ONE row, the contact the STOP (or Telegram's "bot
-- was blocked") came from. When that contact stopped being theirs, the STOP went with it: Telegram unlinked
-- (channel_telegram_unlink_as sets the row's user_id to null), a WhatsApp number released or moved (channel_contact_release
-- deletes the row), a chat linked to another account. The person's other channel then read "not opted out", and Trainee
-- started texting them again (alerts, reports, receipts, cards) without a START: found by the round's end-to-end flow
-- (tests/architect/flow-scenarios-channel-r4.test.ts), a person who said STOP on Telegram and unlinked it got their digest on
-- iMessage. Now, when an opted-out contact leaves a person (its user_id changes or it is deleted), the STOP, with its time,
-- is carried to every contact the person still has. START (channel_set_opt_out(..., false)) still clears all of them.
-- A person with no contact left has nothing to send to; their next link starts from their own word again.
create or replace function public.channel_contacts_keep_stop() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.user_id is not null and old.opted_out and (tg_op = 'DELETE' or new.user_id is distinct from old.user_id) then
    update public.channel_contacts c
       set opted_out = true, opted_out_at = coalesce(old.opted_out_at, c.opted_out_at, now()), updated_at = now()
     where c.user_id = old.user_id and c.contact <> old.contact and not c.opted_out;
  end if;
  return null;
end $$;
revoke all on function public.channel_contacts_keep_stop() from public, anon, authenticated;
drop trigger if exists channel_contacts_keep_stop on public.channel_contacts;
create trigger channel_contacts_keep_stop after update of user_id or delete on public.channel_contacts
  for each row execute function public.channel_contacts_keep_stop();
