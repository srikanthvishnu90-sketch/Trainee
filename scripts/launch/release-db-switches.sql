-- D-037 (owner, in writing, 2026-11-01 20:04 CT: "turn these on: Real submissions …"): the database switches the release
-- serves on, written by trainee-go-live.sh after the claim guards are verified. The table and its key check are the
-- migrations' (20261021080000, 20261024090000, 20261028180000); this writes values only, never schema.
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v v=on  -f scripts/launch/release-db-switches.sql   the release (default)
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v v=off -f scripts/launch/release-db-switches.sql   the kill switch, kept
-- The keys are supabase/functions/agent-chat/release_config.ts RELEASE_DB_SWITCHES (tests/architect/release-flags.test.ts
-- holds them equal). Each claim still checks the person's approval of the exact payload, the cloud gate or its waiver,
-- the opt-in and the pauses; APPLY_VM sends for nobody until APPLY_VM_USER_IDS names someone (the owner's).
\set ON_ERROR_STOP on
begin;
insert into public.career_cloud_settings (key, value)
values ('CAREER_AGENT_SUBMIT', :'v'), ('CAREER_CLOUD_APPLY', :'v'), ('APPLY_VM', :'v')
on conflict (key) do update set value = excluded.value, updated_at = now();
commit;
