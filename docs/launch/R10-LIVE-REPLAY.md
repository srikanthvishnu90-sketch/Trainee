# R10 live replay (post-deploy check for fix 15)

Owner order 2026-11-09, work order WO-I. Spec: `docs/architect/specs/APP-LAYER-15-FIXES.md` (A.2, E.9, E.10 item 15).

## What it is

After a release is deployed through the documented path (`docs/launch/TRAINEE-GO-LIVE.md`), the owner or the architect
dispatches `.github/workflows/r10-live-replay.yml` (Actions, "Run workflow", input `sha` = the deployed commit). It runs
`scripts/launch/r10-live-replay.ts`, which:

1. creates one synthetic test person;
2. sends the setup turns (the intake, pasted; "yes, that's my resume"; the old machine-learning search), then the five observed
   user turns from spec A.2 (T1-T3 resume, S1-S2 search) to the deployed `agent-chat`, with the same call the channels make
   (`POST /functions/v1/agent-chat`, service key, `as_user_id`, `channel: "telegram"`);
3. downloads every delivered file (attachments by their owner-scoped ref, and every link in the reply), opens each one (page
   count, text, target), fetches each File page signed in as the test person and screenshots it at 390 px (deviceScaleFactor 2),
   and screenshots the bare `/file` and `/connect` pages on the deployed site;
4. checks nothing was applied, queued or sent for the test person, and that its recorded spend stayed under the cap;
5. deletes the test person and writes `artifacts/r10-live-replay/r10-live-replay.json` (uploaded as the run's artifact, kept 14
   days).

`deno run -A scripts/r10-acceptance-report.ts --no-run --live artifacts/r10-live-replay/r10-live-replay.json` folds the live
result into the per-item report. Item 15 is PASS only when both the in-process replay and this live replay pass.

## How the test person is identified

- A new Supabase Auth user per run: `r10-live-replay-<GitHub run id>@users.trainee.invalid`, `user_metadata.r10_live_replay = true`.
  `.invalid` is a reserved top-level domain (RFC 2606), so no mail can reach it.
- One channel contact, `tg:<9_100_000_000 + run id mod 10^8>`, created only so the File pages' Telegram sign-in maps to this
  person. The script refuses to run if that contact already belongs to an account.
- `--cleanup-stale` (the workflow passes it) also deletes any earlier `r10-live-replay-*@users.trainee.invalid` user older than an
  hour, so a run that died mid-way leaves nothing behind for long.

## Why it cannot reach a real employer or contact

- It never calls the Telegram Bot API; a bot can only message a user who started it, which a synthetic id never has.
- The only words it sends are the three setup turns and the five observed turns, which say "don't apply". It never sends a yes,
  an approval or a tap. After every turn it reads `career_apply_wanted`, `career_apply_jobs`, `career_send_queue` and approved
  `career_outreach_drafts` for the test person; anything found is deleted at once, before a worker can take it, and the run FAILS.
- The person has no cloud opt-in and no connected mailbox, so no rail can submit or send for it.
- Outside requests are read-only GETs of the application links a reply shows (to record whether each is live).

## Spend

Model calls are counted by the product's own counters: `agent_turn_costs` for the test person (checked before every turn; the
run stops once it reaches the cap, default and maximum $1.00) and the global ledger `model_budget_days` (read before and after).
The per-person daily AI cap ($0.05) applies to the test person like anyone else. The $70 cycle budget is unchanged.

## Secrets

Only secrets already in the Actions `production` environment: `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` (reads the
project's service key from the Management API; never printed), `SUPABASE_DB_URL` (reads, the checks and cleanup), and
`TELEGRAM_BOT_TOKEN` (optional: signs the test person's own Mini App sign-in; without it the File pages are fetched signed out).

## Not covered

The live replay checks the five observed turns and the entry pages. Spec E.11's live-only flows (valid phone sign-in, connected
inbox permissions, employer-form fill, a real submission and its receipt) need their own owner-run checks.
