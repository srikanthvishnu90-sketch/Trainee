# R10 live replay (post-deploy check for fix 15)

Owner order 2026-11-09, work order WO-I. Spec: `docs/architect/specs/APP-LAYER-15-FIXES.md` (A.2, E.9, E.10 item 15).

## What it is

After a release is deployed through the documented path (`docs/launch/TRAINEE-GO-LIVE.md`), the owner or the architect
dispatches `.github/workflows/r10-live-replay.yml` (Actions, "Run workflow", input `sha` = the deployed commit). The workflow
checks out that commit, and the script runs its code. It runs `scripts/launch/r10-live-replay.ts`, which:

1. verifies the deployment: the checkout is the given sha, and `bash scripts/launch/trainee-go-live.sh --verify <sha>` (reads
   only) finds the release ledger and every function's platform version matching it; the log is kept as `verify.log`;
2. creates one synthetic test person and uploads its resume as a PDF file, never confirmed. The upload runs the product's own
   ingest (`ingestResumeFile` and `supabaseUploadRecorder`, this commit's code, the production tables) and hands the file's message
   to `agent-chat` as the channel does. Only Telegram's file hosting is skipped, because `getFile` answers only for a file a real
   chat sent;
3. sends every other turn as a Telegram update to the deployed `trainee-telegram`, signed with the webhook's secret header as
   Telegram signs it, so the whole channel layer runs (outbox, bubble splitting, the document send). These are the old
   machine-learning search, the five observed turns of spec A.2 (T1-T3, S1-S2), the five post-reset turns of spec F, then
   "pause everything" and "resume career work". Each reply is read back from `career_outbox` (`reply:tg:<update>`). The interim
   ack a slow turn gets is read from `career_outbox` (`interim:tg:<update>`, which WO-C #636 records). When there is no such row
   (before that deploy, or for a fast turn that needed no ack), it is computed with the deployed `ackFor` and labelled computed.
   Either way it is checked against the observed failures;
3. downloads every delivered file (attachments by their owner-scoped ref, and every link in the reply), opens each one (page
   count, text, target), fetches each File page signed in as the test person and screenshots it at 390 px (deviceScaleFactor 2),
   and screenshots the bare `/file` and `/connect` pages on the deployed site;
4. checks nothing was applied, queued or sent for the test person, and that its recorded spend stayed under the cap. It also
   checks that every count a stop or pause reply states equals the tables, that the pause sets `career:account` and
   `career_user_quiet` and the resume clears both (each read back), and that F1a/F1b carry no resume-confirmation tail;
5. deletes the test person and writes `artifacts/r10-live-replay/r10-live-replay.json` (uploaded as the run's artifact, kept 14
   days).

`deno run -A scripts/r10-acceptance-report.ts --no-run --live artifacts/r10-live-replay/r10-live-replay.json` folds the live
result into the per-item report. Item 15 is PASS only when both the in-process replay and this live replay pass.

## How the test person is identified

- A new Supabase Auth user per run: `r10-live-replay-<GitHub run id>@users.trainee.invalid`, `user_metadata.r10_live_replay = true`.
  `.invalid` is a reserved top-level domain (RFC 2606), so no mail can reach it.
- One channel contact, `tg:<4_500_000_000_000_000 + run id mod 10^7>`. That is inside Telegram's 52-bit id space but about half
  a million times above the ids Telegram issues today. The turns arrive from it, and the File pages' Telegram sign-in maps to
  this person. The script refuses to run if that contact already belongs to an account.
- `--cleanup-stale` (the workflow passes it) also deletes any earlier `r10-live-replay-*@users.trainee.invalid` user older than an
  hour, so a run that died mid-way leaves nothing behind for long.

## Why it cannot reach a real employer or contact

- The script never calls the Telegram Bot API itself. The product's replies do go to the Bot API, since that is the channel
  under test, and Telegram refuses them: a bot can only message a chat that started it, and this one never did. If the id ever
  named a real user, they would have to have started Trainee's bot first. That would make them a Trainee contact, and the run
  refuses any id a contact already has.
- The only words it sends are the old search, the observed turns (which say "don't apply"), "pause everything" and "resume
  career work". It never sends a yes,
  an approval or a tap. After every turn it reads `career_apply_wanted`, `career_apply_jobs`, `career_send_queue` and approved
  `career_outreach_drafts` for the test person; anything found is deleted at once, before a worker can take it, and the run FAILS.
- The person has no cloud opt-in and no connected mailbox, so no rail can submit or send for it.
- Outside requests are read-only GETs of the application links a reply shows (to record whether each is live).

## Spend

Model calls are counted by the product's own counters: `agent_turn_costs` for the test person (checked before every turn; the
run stops once it reaches the cap, default and maximum $1.00) and the global ledger `model_budget_days`. The global ledger's
spent plus reserved total is read before every turn and at the end, so background work the turns start counts too. The run
stops if that total has moved by the cap, even though other people's turns are in it.
This guard is the run's own: the owner removed the per-person AI cap on 2026-11-09 (WO-J). The run also records the model of every
call it caused (the test person's `agent_turn_costs.models`, exact; and every `model_budget_reservations` row made during the run
window, which may include other people's turns) and FAILS on any model other than `claude-sonnet-5-5` (owner ruling 2026-11-09).
A reservation with no model name (`model_budget_reserve` called without `p_model`) names no model. It is reported in its own
category, by role and status, and never read as another model.
The $70 cycle budget is unchanged.

## Secrets

Only secrets already in the Actions `production` environment: `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` (reads the
project's service key from the Management API; never printed), `SUPABASE_DB_URL` (reads, the checks and cleanup), `TELEGRAM_WEBHOOK_SECRET` (signs each turn's update), and
`TELEGRAM_BOT_TOKEN` (optional: signs the test person's own Mini App sign-in; without it the File pages are fetched signed out).

## Smoke mode (`--smoke`)

The same script with `--smoke` is the deploy smoke's R10 step. It is part of S6 in `deploy-production.yml`, so its FAIL rolls
the deploy back, and it runs only when the repository variable `R10_DEPLOY_SMOKE` is `on`. Until the R10 fixes are deployed, its
PDF check fails on production, and every deploy would roll back. The owner turns the variable on. `scripts/r10-loop.ts --live`
runs it too. It uses the same test person, guard and cleanup, but instead of the replay it checks (1) the inbound path: T1 as a
Telegram update to `trainee-telegram`, with a reply recorded for it (Telegram refuses to deliver it, so nobody receives it); (2) the
File endpoint: the list link opens signed out (200 or 303, HTML, its own policy) and signed in; (3) a resume PDF link: 200,
`application/pdf`, and the same bytes as the stored document.

The full replay records the R-4 Telegram document step (`telegram`) as BLOCKED, "needs an owner-provided test chat", never a
pass. BLOCKED is a named outside reason, not a FAIL, and the smoke never runs this step. The detail includes trainee-telegram's own
count of documents sent and failed. The architect's
design observes it from Trainee's side: the delivery record's `sendDocument` response with `ok`, `document.file_id` and a
`file_size` equal to the PDF's length, then `getFile` and a sha256 match against the stored PDF. Two things stand in the way
today. The delivery record keeps only `message_id` (`_shared/telegram.ts`); WO-B is storing `file_id` and `file_size`. And
Telegram refuses `sendDocument` to a chat that never started the bot, so the synthetic id gets no document. The step needs a
test chat that has started the bot, which the owner provides.

## Not covered

The live replay checks the observed turns, the pause and resume, and the entry pages. Spec E.11's live-only flows (valid phone sign-in, connected
inbox permissions, employer-form fill, a real submission and its receipt) need their own owner-run checks.
