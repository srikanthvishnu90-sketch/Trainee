-- Reverses 20261110190000_career_outbox_parts_follow_contact.sql: a row claimed for another chat keeps its sent_parts again.
drop trigger if exists career_outbox_parts_follow_contact on public.career_outbox;
drop function if exists public.career_outbox_parts_follow_contact();
alter table public.career_outbox drop column if exists parts_contact;
