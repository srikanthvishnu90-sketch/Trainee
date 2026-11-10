-- CHANNEL DELIVERY, release 10 (s-release, 2026-11-10; found by the CI flake of flow-scenarios-channel-r4 on 3645456a):
-- a row some of whose messages went out to one chat, then claimed for ANOTHER chat, resumed by skipping that many of the new
-- chat's messages. The claims (career_outbox_claim, _claim_lane, _claim_key) write the new target into contact but kept
-- sent_parts and provider_ids, which count the earlier chat's rendering. Seen: a digest rendered as two Telegram messages
-- sent the first, the second hit a 502; Telegram was unlinked; on iMessage (three bubbles) it skipped the first bubble and
-- sent the rest. The person had words 0-79 on Telegram and 40-118 on iMessage, nothing whole anywhere, and the row said
-- "delivered". career_outbox_reroute already sends a moved channel-bound row whole (sent_parts = 0); a row with no channel
-- (digest, status, alert, ...) follows the person's home chat and never passed through it.
-- Now: parts_contact records the chat a row's sent parts went to (written with them). A claim for any other chat clears them
-- (sent_parts 0, provider_ids null): the row goes whole there. The same chat resumes after its parts exactly as before,
-- including after a put-back that empties contact (quiet hours: the store's "queued" mark writes contact null). A row part
-- sent before this migration has no parts_contact: its contact at the time stands for it.
alter table public.career_outbox add column if not exists parts_contact text;

create or replace function public.career_outbox_parts_follow_contact() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare went text;
begin
  if coalesce(new.sent_parts, 0) = 0 then
    new.parts_contact := null;
    return new;
  end if;
  if new.sent_parts is distinct from old.sent_parts then
    -- a write of progress: the parts went to the chat the row was claimed for
    new.parts_contact := coalesce(new.contact, old.contact);
    return new;
  end if;
  went := coalesce(old.parts_contact, old.contact);
  if new.contact is not null and went is not null and new.contact is distinct from went then
    new.sent_parts := 0;
    new.provider_ids := null;
    new.parts_contact := null;
  end if;
  return new;
end $$;
revoke all on function public.career_outbox_parts_follow_contact() from public, anon, authenticated;

drop trigger if exists career_outbox_parts_follow_contact on public.career_outbox;
create trigger career_outbox_parts_follow_contact before update of contact, sent_parts on public.career_outbox
  for each row execute function public.career_outbox_parts_follow_contact();
