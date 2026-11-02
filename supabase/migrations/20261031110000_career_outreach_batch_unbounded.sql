-- OUTREACH DRAFTS WITHOUT A BATCH CAP (people drafts round 3, 2026-11-02).
-- 1. career_outreach_drafts.n was checked "between 1 and 10" (20261021010000, when a batch was ten drafts). The owner's
--    NO LIMITS rule (2026-10-27) made a group draft cover everyone asked for, and the chat drafts that many
--    (career_networking.ts writeBatch; BATCH_MAX is only how many one message shows), but the table still refused draft 11:
--    "reach out to everyone at Datadog" with 150 contacts there failed to save the batch, and the person got no drafts and
--    no reason. The number is now any positive one; a batch is still one set of numbers (unique (batch_id, n)).
-- 2. agent_turn_costs.calls and .failed were checked "between 0 and 100" (20261011040000). A turn that drafts more than
--    100 emails makes more than 100 model calls on one meter, so its cost row was refused and the turn was recorded as
--    "unrecorded" (spend unknown) instead of what it cost. Only the upper bound goes; the row says what the turn did.
--    (The per-person daily ceiling, CAREER_MODEL_DAILY_CALLS, is unchanged: that is a spend decision, not this file's.)
-- Each check is added NOT VALID and then validated, so the table is not held under an exclusive lock while its rows are
-- read. Idempotent: run twice, the same constraints. No function, nothing granted.
alter table public.career_outreach_drafts drop constraint if exists career_outreach_drafts_n_check;
alter table public.career_outreach_drafts add constraint career_outreach_drafts_n_check check (n >= 1) not valid;
alter table public.career_outreach_drafts validate constraint career_outreach_drafts_n_check;
alter table public.agent_turn_costs drop constraint if exists agent_turn_costs_calls_check;
alter table public.agent_turn_costs add constraint agent_turn_costs_calls_check check (calls is null or calls >= 0) not valid;
alter table public.agent_turn_costs validate constraint agent_turn_costs_calls_check;
alter table public.agent_turn_costs drop constraint if exists agent_turn_costs_failed_check;
alter table public.agent_turn_costs add constraint agent_turn_costs_failed_check check (failed >= 0) not valid;
alter table public.agent_turn_costs validate constraint agent_turn_costs_failed_check;
