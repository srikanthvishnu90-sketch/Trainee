-- D-037 (owner, in writing, 2026-11-01 20:04 CT: "turn these on: Real submissions …"): the database switches the release
-- serves on, written by trainee-go-live.sh after the claim guards are verified. The table and its key check are the
-- migrations' (20261021080000, 20261024090000, 20261028180000); this writes values only, never schema.
--
-- The owner's kill switch always wins (review of #407): a row that is already there is never changed by a plain go-live,
-- so a switch the owner set to 'off' stays 'off' through any later deploy, including an emergency `--brain router`
-- rollback. Only an explicit `trainee-go-live.sh --real-submit on|off` overwrites existing rows.
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v v=on  -v overwrite=false -f scripts/launch/release-db-switches.sql   a plain go-live: missing rows on
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v v=on  -v overwrite=true  -f scripts/launch/release-db-switches.sql   --real-submit on
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v v=off -v overwrite=true  -f scripts/launch/release-db-switches.sql   --real-submit off
-- The keys are supabase/functions/agent-chat/release_config.ts RELEASE_DB_SWITCHES (tests/architect/d037-live-effects.test.ts
-- holds them equal and runs this file on Postgres). Each claim still checks the person's approval of the exact payload, the
-- cloud gate or its waiver, the opt-in and the pauses; APPLY_VM sends for nobody until APPLY_VM_USER_IDS names someone.
\set ON_ERROR_STOP on
begin;
\if :overwrite
insert into public.career_cloud_settings (key, value)
values ('CAREER_AGENT_SUBMIT', :'v'), ('CAREER_CLOUD_APPLY', :'v'), ('APPLY_VM', :'v')
on conflict (key) do update set value = excluded.value, updated_at = now();
\else
insert into public.career_cloud_settings (key, value)
values ('CAREER_AGENT_SUBMIT', :'v'), ('CAREER_CLOUD_APPLY', :'v'), ('APPLY_VM', :'v')
on conflict (key) do nothing;
\endif
commit;
