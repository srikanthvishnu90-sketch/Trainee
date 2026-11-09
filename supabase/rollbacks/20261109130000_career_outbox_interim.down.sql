-- Reverses 20261109130000_career_outbox_interim.sql: the interim lines recorded are removed (they were already delivered,
-- so nothing waits on them), then the outbox's kind and key checks are the twelve kinds again.
delete from public.career_outbox where kind = 'interim';
alter table public.career_outbox drop constraint if exists career_outbox_kind_check;
alter table public.career_outbox add constraint career_outbox_kind_check
  check (kind in ('alert', 'report', 'reply', 'receipt', 'card', 'status', 'followup', 'mock', 'brief', 'digest', 'link', 'questions'));
alter table public.career_outbox drop constraint if exists career_outbox_key_check;
alter table public.career_outbox add constraint career_outbox_key_check
  check (key ~ '^(alert|report|reply|receipt|card|status|followup|mock|brief|digest|link|questions):.+$' and length(key) <= 310);
