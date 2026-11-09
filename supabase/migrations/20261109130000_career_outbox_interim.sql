-- R10 (architect, 2026-11-09): the interim line of a slow turn ("on it — looking for roles now") is sent straight to the
-- chat, not through the outbox, so nothing recorded it and a replay could only compute it. It is now written to
-- career_outbox as kind 'interim', key interim:<scoped message id>, already delivered (status delivered, delivered_at set),
-- with the exact text sent. A delivered row is never claimed, so it is never sent again.
alter table public.career_outbox drop constraint if exists career_outbox_kind_check;
alter table public.career_outbox add constraint career_outbox_kind_check
  check (kind in ('alert', 'report', 'reply', 'receipt', 'card', 'status', 'followup', 'mock', 'brief', 'digest', 'link', 'questions', 'interim'));
alter table public.career_outbox drop constraint if exists career_outbox_key_check;
alter table public.career_outbox add constraint career_outbox_key_check
  check (key ~ '^(alert|report|reply|receipt|card|status|followup|mock|brief|digest|link|questions|interim):.+$' and length(key) <= 310);
