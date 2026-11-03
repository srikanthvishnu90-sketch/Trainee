-- Introduction reminders, pushed (D-033 as amended 2026-10-27; #217 follow-up, lane L8): the career-proactive run
-- gains a rail that queues a due intro reminder to career_outbox (career_people_reminders.ts, wired only with
-- CAREER_INTRO_REMINDERS=on). The rail's count is recorded on the run row, like every other rail's (receipts,
-- cards, questions, ...). Additive only: no table or row is changed, and nothing here turns the rail on.
alter table public.career_proactive_runs add column if not exists intro_reminders int not null default 0 check (intro_reminders >= 0);
