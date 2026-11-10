-- Reverses 20261110120000_career_mail_unclear.sql. Refuses while an unclear email is on record (the old kind check cannot
-- hold then); those rows are the person's mail record and are not deleted here: resolve them first, by hand.
do $d$ begin
 if exists (select from public.career_mail_events where kind = 'unclear') then
  raise exception 'rollback refused: unclear mail events are on record';
 end if;
end $d$;
alter table public.career_mail_events drop constraint if exists career_mail_events_unclear_flagged;
alter table public.career_mail_events drop constraint if exists career_mail_events_kind_check;
alter table public.career_mail_events add constraint career_mail_events_kind_check
  check (kind in ('received', 'rejection', 'interview', 'assessment', 'offer', 'recruiter_reply'));
