-- Item 12 (coordinator ruling 2026-11-10, D-024 status truth): an employer's email about one of the person's applications
-- that the mail rules could not read (unclear) and the mail model's second pass did not label is filed under that
-- application as kind 'unclear', always flagged and with no stage, so no reader moves a stage, counts a reply or an
-- outcome on it. The status then says the employer wrote and shows the email; it never guesses what they asked.
-- Additive and idempotent: one kind more, and a check that an unclear row is flagged and stageless.
alter table public.career_mail_events drop constraint if exists career_mail_events_kind_check;
alter table public.career_mail_events add constraint career_mail_events_kind_check
  check (kind in ('received', 'rejection', 'interview', 'assessment', 'offer', 'recruiter_reply', 'unclear'));
alter table public.career_mail_events drop constraint if exists career_mail_events_unclear_flagged;
alter table public.career_mail_events add constraint career_mail_events_unclear_flagged
  check (kind <> 'unclear' or (flagged and stage is null));
