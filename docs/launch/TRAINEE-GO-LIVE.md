# Trainee go-live (owner only)

One command, from the repo on your own machine, checked out at the exact commit you want live, named again with `--sha`.
No agent runs it: agents never deploy, apply migrations to the live project or create credentials (AGENTS.md).

```bash
supabase login                                                 # once
git fetch origin && git checkout --detach <sha>                # the full 40-character commit you worded
git status --porcelain                                         # must print nothing
bash scripts/launch/trainee-go-live.sh --sha <sha> --dry-run   # stages the commit, checks it, prints the manifest; nothing live
bash scripts/launch/trainee-go-live.sh --sha <sha>             # the real run (asks for what is not in the environment)
bash scripts/launch/trainee-go-live.sh --verify <sha>          # afterwards, any time: does the live project match <sha>?
```

## From GitHub (the production workflow)

`.github/workflows/deploy-production.yml` runs this same script, `--sha $GITHUB_SHA --non-interactive`, on every push to
`release/production`, inside the GitHub environment `production`. Shipping is a push; nothing runs until you approve it.

**Once, before the first push** (if `production` does not exist when the first run starts, GitHub creates it with no
protection):

1. Settings > Environments > New environment `production`. Required reviewers: yourself. Leave "Prevent self-review"
   off (you push and you approve). Deployment branches and tags: Selected branches, `release/production`.
2. In that environment, add these **environment secrets** (not repository secrets, so only an approved run sees them):

| Secret | Where the value comes from |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com > your avatar > Account preferences > Access Tokens > Generate new token |
| `SUPABASE_PROJECT_REF` | Supabase > Project Settings > General > Project ID (20 letters) |
| `SUPABASE_DB_URL` | Supabase > Connect (top bar) > Connection string > **Session pooler** URI (port 5432; GitHub's runners have no IPv6, so not the direct `db.<ref>.supabase.co` one), password filled in. A forgotten password: Project Settings > Database > Reset database password |
| `TRAINEE_INBOUND_SECRET` | the `?secret=` value in LoopMessage's webhook URL. Required unless it is already set on the project (it is never generated here: a new one would break LoopMessage's URL unseen) |
| `CAREER_INGEST_SECRET`, `CAREER_PROACTIVE_SECRET`, `TRAINEE_DELIVER_SECRET` | the values already live, readable only by you in Supabase > SQL Editor: `select name, decrypted_secret from vault.decrypted_secrets where name like 'trainee_%_secret'`. Leave unset to keep them: a secret already on the project is kept, its pg_cron job and Vault copy untouched, and the smoke skips its gate |
| `OPENAI_API_KEY` | platform.openai.com > the project > API keys > Create new secret key. Unset keeps the one on the project |
| `LOOPMESSAGE_API_KEY` | LoopMessage dashboard. Unset keeps the one on the project |
| optional: `INGEST_CONTACT_EMAIL`, `TRAINEE_ALLOWED_CONTACTS`, `LOOPMESSAGE_DAILY_CONTACTS`, `PDL_API_KEY`, `UPMORE_TEST_JWT`, the `WHATSAPP_*` ones | as in "What you are asked for" below; unset keeps what the project has |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | **leave unset** for now (Telegram, below) |

3. Ship: `git push origin <40-character sha>:refs/heads/release/production`. The run waits on "Review deployments":
   approve it there. It uploads one artifact, `deploy-production-<sha>`: the full log, the provenance manifest and the
   rollback copy of the live agent-chat, every secret value replaced by `***` (`scripts/launch/mask-artifacts.py`).

Every PR that touches `supabase/`, `scripts/launch/` or `tests/db/` runs `deploy-preflight.yml`: this script's
`--dry-run --non-interactive` at the PR head, and `tests/db/rehearse_live_migrations.sh` (go-live's migration step on a
throwaway Postgres shaped like the live project, then compared object by object with a file-order build).

**Telegram.** The live webhook points at `telegram-inbound` (the test bridge, `_shared/telegram_bridge.ts`); this script
deploys `trainee-telegram`, a separate function, and never deploys, deletes or repoints `telegram-inbound`. Both read the
project-wide `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, so: leave the three Telegram secrets unset and the live
values stay (a different value would make `telegram-inbound` refuse every update). With `TELEGRAM_BOT_TOKEN` given, the
smoke fails until the webhook points at `trainee-telegram`. Moving Telegram to `trainee-telegram` is your step, by hand,
after a deploy: run `setWebhook` (section Telegram, step 3) with the URL `.../functions/v1/trainee-telegram` and the
**same** secret token; `getWebhookInfo` then shows the new URL; only after that add the Telegram secrets here. Going back
is the same `setWebhook` with `.../functions/v1/telegram-inbound`.

**Rollback from GitHub** (commits that have this workflow): `git push --force origin <earlier sha>:refs/heads/release/production`
and approve. Migrations are additive and every mark is already true, so none runs; every function is redeployed from that
commit and the ledger names it. For agent-chat alone, or a commit before this workflow, use the artifact's `rollback/`
copy: `cd rollback/agent-chat-<UTC> && supabase functions deploy agent-chat --project-ref <ref>` (section Rollback).

**Provenance (WO-093).** The run ships exactly `<sha>` and nothing else. It refuses to start when the tree has any change
or untracked file, when `--sha` is missing, short or not `HEAD`, or when the commit's router bundle is stale
(`python3 scripts/build-router-core.py --check` and `--career-only --check`, run in the staged commit). It then stages
only `git archive <sha>` (`supabase scripts packages corpus`) into a fresh temp dir and does everything from there:
migrations, deploys, schedules and the smoke never read this checkout. It prints a **provenance manifest**: the sha, each
function's entry and bundle sha256 (the sha256 of the sorted list of every file in its import graph with its own sha256,
plus its remote imports; the same sha gives the same hashes on any machine), each migration with its sha256 and live
mark, the time and the tool versions; a copy is kept in `~/trainee-provenance/manifest-<sha>-<UTC>.json`. Each migration
mark read true and each function deployed gets a row in `public.career_deploy_ledger` (service role only, RLS on, no
client access, append-only), labelled `--label <who>` (default `owner`). `--verify <sha>` reads only: it rebuilds the
manifest of `<sha>`, reads the latest ledger row per function and per migration, every mark on the live schema and (with
`SUPABASE_PROJECT_REF`) `supabase functions list`, prints one line per check and exits 1 listing each mismatch: a function
last deployed from another commit or with another bundle, a function with no row (deployed outside go-live), a platform
version other than the one the ledger recorded, a missing mark, a migration whose file changed after it was recorded.
Why: `docs/architect/work-orders/WO-093-deploy-provenance.md`.

Needs `supabase`, `psql`, `node`, `deno`, `git`, `python3`, `tar` (`brew install supabase/tap/supabase libpq node deno`). Every value is
read from the environment or asked on a hidden prompt; none is echoed, written to a file or put in the log
(`~/trainee-go-live-<UTC>.log`). The run stops at the first `STEP … FAILED`.

| Flag | Effect |
|---|---|
| `--sha <sha>` | **required** for every run but `--only-smoke`: the full 40-character commit, which must be `HEAD` |
| `--verify <sha>` | read only: compare the deploy ledger and every live migration mark to the manifest of `<sha>`; exit 1 on any mismatch |
| `--label <who>` | the ledger rows' `deployed_by_label` (letters, digits, space, `. _ @ : + -`; default `owner`; never a secret) |
| `--dry-run` | print the plan, run nothing live (with `--sha` it still stages the commit, runs the two bundle checks and prints the manifest) |
| `--skip-migrations` / `--skip-deploy` | skip step 2 / step 4 |
| `--only-smoke` | only preflight and the smoke checks |
| `--brain agent` | sets `CAREER_BRAIN=agent` (the agent brain answers career turns). Without it the brain is not touched; `--brain router` unsets it |
| `--allow-send` | the smoke also sends `HELP` to `trainee-inbound` as if from `TRAINEE_SMOKE_CONTACT`, and **the help reply is texted to that number**. Use your own |
| `--no-wait` | the smoke does not wait (up to 7 minutes) for each schedule to fire once |

## What you are asked for

| Input | What it is | Where it ends up |
|---|---|---|
| `SUPABASE_PROJECT_REF`, `SUPABASE_DB_URL` | the project (20 letters) and its database URI | nowhere (this process only) |
| `CAREER_INGEST_SECRET`, `CAREER_PROACTIVE_SECRET`, `TRAINEE_DELIVER_SECRET`, `TRAINEE_INBOUND_SECRET` | 32+ characters of `A-Z a-z 0-9 . _ ~ -`; Enter generates 48 (`openssl rand -hex 24`), shown once on the terminal only if you say yes | function secrets; the first three also in Vault for pg_cron; the inbound one in LoopMessage's webhook URL |
| `TRAINEE_ROTATE_INBOUND=1` | only when replacing the inbound secret on purpose | on a re-run, Enter for `TRAINEE_INBOUND_SECRET` stops the run if one is already set (a new one would silently break LoopMessage's webhook URL); give the same value, or set this and paste the new URL into LoopMessage |
| `LOOPMESSAGE_API_KEY`, `OPENAI_API_KEY` | Enter keeps the one already set | function secrets (`MODEL_PROVIDER=openai` with the OpenAI key) |
| `INGEST_CONTACT_EMAIL` | the contact job boards see in the User-Agent; career-ingest answers 503 without it | function secret |
| `TRAINEE_ALLOWED_CONTACTS` | comma-separated numbers allowed to sign up (sign-up is closed by default: `TRAINEE_SIGNUP` is not touched) | function secret |
| `LOOPMESSAGE_DAILY_CONTACTS` | your plan's contacts a day (unset means 300) | function secret |
| `PDL_API_KEY` | optional: People Data Labs key for hired-candidate aggregates (WO-036, D-018); without it Trainee says it has no data | function secret, hidden prompt |
| `UPMORE_TEST_JWT` (optional) | a test user's JWT for the agent-chat "hi" check | nowhere |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (optional) | from @BotFather (section Telegram below). Left empty, Telegram stays `NOT_WIRED` | function secrets |
| `TELEGRAM_WEBHOOK_SECRET` | asked only with a Telegram token; 32-256 of `A-Z a-z 0-9 _ -`; Enter generates 48 | function secret, and the `secret_token` you give `setWebhook` |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (optional) | the permanent system-user token, the phone number **ID**, the Meta app secret (section WhatsApp below). Left empty, WhatsApp stays `NOT_WIRED` | function secrets |
| `WHATSAPP_VERIFY_TOKEN` | asked only with a WhatsApp token; 32+ of `A-Z a-z 0-9 _ -`; Enter generates 48 | function secret, and the verify token in Meta's webhook settings |
| `TRAINEE_ROTATE_CHANNELS=1` | only when replacing a Telegram webhook secret or a WhatsApp verify token on purpose | as with `TRAINEE_ROTATE_INBOUND`: Enter never replaces one already set |
| `WHATSAPP_TEMPLATE_UPDATES`, `WHATSAPP_TEMPLATE_LANGUAGE` | the approved template's name (`trainee_updates`) and language (`en_US`). Unset: outside WhatsApp's 24-hour window nothing is sent; messages wait for the person's next message | function secrets |
| `WHATSAPP_DAILY_TEMPLATES` | your WhatsApp messaging limit, templates a day (unset means 250, a new account's tier) | function secret |
| `CAREER_PREPARE_AHEAD_URL`, `CAREER_PREPARE_AHEAD_TOKEN` (optional, both or neither) | the preparation host's door, `https://<host>/prepare`, and that host's own token (section "Running mass submission" below). Left empty, phone-only preparation stays `NOT_WIRED` and the smoke says so | function secrets (agent-chat kicks the host with them; the smoke reads the host's `/status`) |
| `TRAINEE_FILE_LINK_SECRET`, `OPS_MONITOR_TOKEN` (set on the project by the owner, never by this script) | the signing secret of `trainee-file`'s hosted list page, and `ops-monitor`'s bearer token. Step 4 deploys `trainee-file` / `ops-monitor` (both `--no-verify-jwt`; the link or token authenticates) only when its secret is already among the project's function secrets (a dry run: given in the environment). Absent: it is skipped with a `gated: ... SKIPPED` log line, never a failure, and it is not in the provenance manifest | function secrets |

Function secrets are project-wide in Supabase: every function sees every one.

## The steps and what each changes

1. **preflight**: tools, inputs, a clean tree at `HEAD` = `--sha`, the commit staged from `git archive <sha>`, the two
   router bundle checks and `deno check` of the seven entry points in the staged commit, the provenance manifest printed
   and kept. Changes nothing live.
2. **migrations**: applies, in order and each once, every migration from the Trainee set on (the `MIGRATIONS` list in
   `scripts/launch/trainee-go-live.sh`; `tests/trainee-go-live.test.cjs` fails if a migration file from `20261019` on is
   missing from it). Today: `20261019000001_career_postings.sql`, `20261019010001_career_alerts.sql`,
   `20261019020000_site_capture.sql` (the landing page's waitlist and careers capture, ported from `main` by WO-081 and
   already live, so its live-schema mark skips it), `20261019020001_channel_delivery.sql` (re-versioned from 20261019020000
   by WO-081 so it never shares a version with the live site capture), `20261019030000_channel_inbound.sql` (postings, alerts, the outbox, delivery
   and inbound), and the apply pipeline `20261020000001_career_apply_jobs.sql`, `20261020010000_career_apply_own_worker.sql`,
   `20261020020000_career_apply_receipts.sql`, `20261020030000_career_apply_cards.sql`,
   `20261020040000_career_apply_card_push.sql`, `20261020050000_career_apply_daily_limit.sql` (the approved-application
   queue, the person's own computer claiming its own applications, receipts, prepared applications and their card, the
   card pushed into the thread, the daily limit), and `20261020060000_career_apply_questions.sql` (the questions only the person can answer, asked once by text), `20261020070000_career_apply_questions_ai_policy.sql` (the employer's own words about AI help, kept with each written question so Trainee reads them before it drafts one, WO-030), `20261020100000_career_mail_tracking.sql` (status changes read from the person's own mail, drafts never sent), `20261020110000_career_connector.sql` (the Connector's profiles, introductions and blocks; nothing is proposed until 500 people opt in), `20261020120000_career_events.sql` and `20261020120100_career_events_erase.sql` (the account's timeline, cleared by an erase), and `20261020130000_career_resume_tailoring.sql` (the private
   `career-resumes` bucket for tailored resumes and the tailored/untailored tag on every application), and `20261021020000_career_voice_mock.sql` (the voice mock's single-use links and its debrief into the thread; the voice itself stays off until you deploy `career-voice` and set `CAREER_VOICE=on`, see WO-035), and `20261021010000_career_outreach.sql` (outreach drafts approved by their exact text, the do-not-contact list, Hunter's cached checks, and the send claim: 10 a day the first week, 20 by default, 30 at most, 90 seconds apart), and `20261021050000_career_brief_digest.sql` (interview invites and their briefs, the weekly digest's settings, both cleared by an erase; turned on with `CAREER_BRIEF_DIGEST=on` on career-proactive after it applies, WO-034), and `20261021070000_channel_parity.sql` (WhatsApp and Telegram beside iMessage: a contact per channel, the home channel, messages held for WhatsApp's window, Telegram link tokens and WhatsApp link questions, WO-038), and `20261021030000_career_hired_backgrounds.sql` (aggregate hired-candidate backgrounds from People Data Labs, never a named person, and the log of every PDL call's credits), and `20261021075000_career_apply_ops.sql` (WO-032: who drove each application, confirmed only by the employer's email, the PR #16 gate count `select * from career_apply_gate_status()`, applying by email from the person's Gmail on their yes, which sends only once you set `CAREER_EMAIL_SEND=on` on agent-chat (off by default: the yes is told sending is not switched on and the email is kept as a draft; outreach's own switch is `CAREER_OUTREACH_SEND=on` on career-proactive), the open questions texted once, and no card pushed while the thread waits on something else), and `20261021080000_career_apply_cloud.sql` (the cloud worker's gate, opt-in, claim, telemetry and throttle; the kill switch `CAREER_CLOUD_APPLY` stays off until the owner turns it on, `docs/launch/CLOUD-WORKER.md`), and `20261021090000_career_mail_erase.sql` (an erase also deletes the mail-tracking events and drafts), and `20261021100000_career_proactive_last_word.sql` (a delivered alert, receipt or other text Trainee starts joins the texting thread, so a later "yes" is never read as the answer to an older prompt). Each runs in one transaction with its row in
   WO-037 adds `20261021110000_career_board_state.sql` (each watched board's read state for the 6-hour sharded refresh, the alert latency report and the weekly alert count).
    WO-031 adds `20261021000000_career_apply_extension.sql` (the browser extension records each application the person approved in it on the same queue, as them), and WO-042 adds `20261021120000_career_apply_form_answers.sql` (an answer the person typed on the form and approved is kept for later forms, so it is asked once; the extension's applications carry source `extension`, so the gate counts them).
    WO-091c adds `20261022120000_career_control_state.sql` (one predicate, `career_user_quiet`, true while the person is paused, has texted STOP on any channel, or erased their profile; the scheduled run starts nothing for them and a text queued before the pause is not delivered; outreach approvals expire after 7 days and a quiet account's are held; `career_proactive_runs.errors` records each rail's failure by rail).
   `public.upmore_migration_ledger` (when that ledger is in use; an empty or missing one is left for
   `apply-rails-and-seed.sh --pending` to backfill). A file whose objects are already live is not run again. The earlier
   career migrations (`20261015*`, `20261016*`) are only **checked**: they use plain `create table`, so a missing one stops
   the run and you apply it by hand after looking. Every applied one is additive (new tables, columns, constraints and
   functions; `create ... if not exists` and `create or replace`) and is applied twice in a row by `tests/db/run.sh` to
   prove a second run changes nothing. Then **every mark is read again** (`MIGRATION_MARK` and the earlier ones), and a
   single missing one fails the step, each named: a ledger row saying "applied" is never taken for the schema (a
   packet's migrations once never landed). The marks read true get their rows in `public.career_deploy_ledger`
   (`20261022120500_career_deploy_ledger.sql`, applied by this step). With `--skip-migrations` the same marks are read at
   the start of step 4, and nothing is deployed on a schema without them.
3. **secrets**: one `supabase secrets set --env-file` from a 0600 temp file that is removed at once.
4. **deploy**: first downloads the live `agent-chat` to `~/trainee-rollback/agent-chat-<UTC>` (best effort), then deploys
   `agent-chat` from the career-only staged tree (`node scripts/career/stage-career.cjs`: `index-career.ts` as
   `agent-chat/index.ts`, JWT on; deploying it from the repo tree would ship the shelved finance entry), then
   `career-ingest`, `career-proactive`, `trainee-deliver`, `trainee-inbound`, `trainee-telegram`, `trainee-whatsapp`
   with `--no-verify-jwt` (pg_cron, LoopMessage, Telegram and Meta send no JWT; each function checks its own secret).
   The two channel webhooks deploy even when their channel is not wired: they then answer 503 `NOT_WIRED`. Every deploy
   runs from the staged commit, and right after each one its row goes into `public.career_deploy_ledger`: the sha, the
   function, its bundle sha256 from the manifest, the platform's version number (`supabase functions list`), the label.
5. **schedules**: runs `schedule-career-ingest.sql` (every 5 min), `schedule-career-proactive.sql` (every 5 min) and
   `schedule-trainee-deliver.sql` (every minute), each with its secret passed by env as the script's header says. Each
   stores the secret in Vault and replaces its pg_cron job. **From here texts go out** to people with a linked contact.
   Ingest (Feature 6) is one job per lane: the lane plan in `packages/career-data/ingest-lane-plan.json` (lanes, window
   60 min, posting budget per run, measured offline by `scripts/career/measure-ingest-lane.ts`) is written into the SQL by
   `node scripts/launch/build-ingest-schedule.cjs`; `-v lanes=<n>` overrides it. It needs migrations
   `20261026060006_career_more_providers.sql` (eleven providers) and `20261026060106_career_ingest_runs.sql` (run log,
   board body hash) applied and `career-ingest` deployed first. Health:
   `select * from public.career_ingest_coverage(interval '1 hour')` (one row per lane: runs, boards read of due,
   failures, the last report with fresh-within-the-hour fractions for the lane and the directory). The first full read of
   all 27,751 boards takes a few hours (the plan's `first_coverage_hours`); after it, every board within the hour.
6. **smoke**: `node scripts/launch/trainee-smoke.cjs`: each function refuses a wrong secret and answers the right one
   (503 `NOT_WIRED` or "not configured" is a WARN, never a pass), agent-chat refuses no JWT and answers "hi" for the test
   user, the three pg_cron jobs fired and each run record (`career_ingest_state.last_run_at`, `career_proactive_runs`,
   `channel_delivery_runs`) has a fresh row without an error. The right-secret calls are one extra run of each
   function (an ingest pass, an alerts pass, a delivery pass); the inbound one gets an empty body and runs nothing.
   With Telegram's values: `trainee-telegram` refuses a wrong `X-Telegram-Bot-Api-Secret-Token` and ignores an empty
   update with the right one, and Telegram's `getWebhookInfo` (read only) shows the webhook is this project's. With
   `WHATSAPP_VERIFY_TOKEN`: `trainee-whatsapp` answers Meta's challenge only with the right token and refuses an unsigned
   POST. A channel not given is printed `NOT RUN … NOT_WIRED` and does not fail the run. None of them sends a message.
   Re-run it any time: `SUPABASE_URL=https://<ref>.supabase.co … node scripts/launch/trainee-smoke.cjs` (exit 0 pass,
   1 a FAIL, 2 NOT RUN).

Networking emails from chat (FEATURE 10): a contacts CSV pasted or attached in chat is imported, and "who do I know at
X" answers from it, with no switch. Drafting ("email Maya at Stripe about ...") makes one model call per recipient, so it
runs only once you set `CAREER_NETWORKING_DRAFT=on` on agent-chat (off: the reply names who would be written to and
nothing is drafted). Drafts land on the outreach batch and need "send N" on the exact message; they go out only through
career-proactive with `CAREER_OUTREACH_SEND=on` and a Gmail grant with send scope. No migration.

## LoopMessage

Webhook URL (inbound messages), in LoopMessage's dashboard:

```
https://<ref>.supabase.co/functions/v1/trainee-inbound?secret=<TRAINEE_INBOUND_SECRET>
```

**Check these against LoopMessage's own documentation before you turn it on**; none was verified there (the docs were
unreachable from the build environment, WO-013). The code uses the shape your test bridge used live, 2026-10-08..11:

- send: `POST https://a.loopmessage.com/api/v1/message/send/`, header `Authorization: <raw API key>`, body
  `{ "contact", "text" }`, one request per bubble (`_shared/loopmessage.ts`). Some LoopMessage documentation describes
  a different host and fields (`server.loopmessage.com`, a second `Loop-Secret-Key` header, `recipient` and
  `sender_name`): confirm which one your account uses.
- retried as "certainly not sent": HTTP 429, 502, 503 and a connection that never opened; anything else is final.
- inbound: the webhook body is read from `alert_type` (`message_inbound`; delivery callbacks are ignored),
  `message_id` (dedupe), `recipient` / `from` / `sender` / `contact` / `phone` (the person's number) and `text`.
- the webhook answers after the chat turn (up to about 2 minutes). If LoopMessage retries sooner, the retry is
  answered "duplicate webhook" and runs nothing; confirm its timeout and retry rules.

## Telegram (Bot API)

Telegram works like iMessage once the person has pressed Start: no window, no cost, 4,096 characters a message (Trainee
sends at most 1,500 and splits longer text on purpose, one message a second to one chat). The bot is never told a phone
number, so a person reaches their account one of two ways: they text **connect telegram** where they already use Trainee
(or tap Connect Telegram in the app, `channel_link_telegram_start()`, once the app has the button) and open the one-time
link it sends, then reply **YES** where they already use Trainee when it asks "Someone wants to link Telegram @name to your
Trainee" (opening the link alone links nothing: a forwarded or copied link is not proof of who opened it;
20261031040000_telegram_link_confirm.sql); or, if their chat is on the allow list (`TRAINEE_ALLOWED_CONTACTS` entries like `telegram:<chat id>`) or
sign-up is open, pressing Start makes a new account.

1. In Telegram, message **@BotFather**: `/newbot`, a name (`Trainee`), a username ending in `bot`. BotFather shows the
   bot token **once**: keep it for the go-live prompt only, never paste it into a chat. Then `/setjoingroups` → your bot →
   **Disable** (Trainee reads private chats only).
2. Run go-live with `TELEGRAM_BOT_TOKEN` (hidden prompt), `TELEGRAM_BOT_USERNAME` (without `@`), and Enter for
   `TELEGRAM_WEBHOOK_SECRET` (say yes to see it once, then clear the screen).
3. Point Telegram at the webhook. In your own shell (`read -rs` keeps both values off the screen and out of history):
   ```bash
   read -rs TG_TOKEN; read -rs TG_SECRET
   curl -sS "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
     --data-urlencode "url=https://<ref>.supabase.co/functions/v1/trainee-telegram" \
     --data-urlencode "secret_token=${TG_SECRET}" \
     --data-urlencode 'allowed_updates=["message","callback_query","my_chat_member"]' \
     --data-urlencode "drop_pending_updates=true"
   unset TG_TOKEN TG_SECRET
   ```
   The answer is `{"ok":true,"result":true,"description":"Webhook was set"}`. Telegram then sends the secret back on every
   update in `X-Telegram-Bot-Api-Secret-Token`, and `trainee-telegram` refuses any update without it (403).
4. Check: re-run the smoke (step 6) with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` set; `getWebhookInfo` must
   show this project's URL and no `last_error_message`.
5. Try it: text **connect telegram** to Trainee on iMessage, open the link on the phone where you use Telegram, tap
   Start. Telegram answers "Telegram is linked to your Trainee account." Then text Telegram anything.

Not verified against Telegram's own pages (they did not load from the build environment): the field names
`link_preview_options` and `my_chat_member`, and the 403 wording for a blocked bot. The smoke and step 5 check them live.

## WhatsApp (Meta's Cloud API, directly)

Meta's rule makes one difference from iMessage that code cannot remove: Trainee may send free text only within 24 hours
of the person's last WhatsApp message. Outside that window, every message Trainee starts (alert, report, receipt,
approval card, mail status, follow-up) waits in the outbox, and the person gets one short template instead: "Trainee has
3 new update(s) for you. Reply to see them." Their reply opens the window, and everything waiting goes out, whole, before
the answer. One template per silence, and none at all until a template name is set. An approval card is not even put
into the thread while the window is closed (a waiting card could catch a "yes" meant for something else).

1. **Business**: in Meta Business Suite (business.facebook.com) use or create the business portfolio, and start
   **Business verification** (Settings → Security Center). Verification raises the messaging limit and lets the display
   name show.
2. **The app**: developers.facebook.com → My Apps → **Create app** → use case **Connect with customers through
   WhatsApp** (type Business) → attach the business portfolio. In the app, add the **WhatsApp** product; this creates or
   links the **WhatsApp Business Account** (WABA). Note the WABA ID shown on API Setup.
3. **The number**: WhatsApp Manager → Phone numbers → **Add phone number**: a number not in use on the WhatsApp app,
   verified by SMS or call, with the display name (`Trainee`, or the one Meta approves). Then app dashboard → WhatsApp →
   **API Setup**: copy the **Phone number ID** (a long number; not the phone number itself). That is
   `WHATSAPP_PHONE_NUMBER_ID`. If the number shows "pending registration", finish registration there (it asks you to set
   a six-digit two-step PIN; keep it to yourself, Trainee never needs it).
4. **The app secret**: app dashboard → App settings → **Basic** → App secret → Show. That is `WHATSAPP_APP_SECRET`; it
   checks the signature on every webhook.
5. **A permanent token**: Business settings → Users → **System users** → Add (role Admin) → **Assign assets**: the app
   (full control) and the WhatsApp account (full control) → **Generate new token** → the app, permissions
   `whatsapp_business_messaging` and `whatsapp_business_management`, expiry **Never**. Meta shows it once: it goes only
   into the go-live prompt as `WHATSAPP_TOKEN` (hidden), never into a chat, a file or a ticket.
6. **Run go-live** with those four values and Enter for `WHATSAPP_VERIFY_TOKEN` (say yes to see it once).
7. **The webhook**: app dashboard → WhatsApp → **Configuration** → Webhook → Edit: Callback URL
   `https://<ref>.supabase.co/functions/v1/trainee-whatsapp`, Verify token = your `WHATSAPP_VERIFY_TOKEN` → **Verify and
   save** (Meta calls it with a GET; `trainee-whatsapp` echoes the challenge only for the right token). Then **Webhook
   fields → Manage → subscribe to `messages`** (it carries the incoming messages and the status of what Trainee sent; a
   "failed" status for the window, 131047, puts that message back in the queue).
   If messages still do not arrive, subscribe the app to the WABA once (in your shell; `read -rs` keeps the token hidden):
   ```bash
   read -rs WA_TOKEN
   curl -sS -X POST "https://graph.facebook.com/v21.0/<WABA ID>/subscribed_apps" -H "Authorization: Bearer ${WA_TOKEN}"
   unset WA_TOKEN
   ```
8. **The template**: WhatsApp Manager → Account tools → **Message templates** → Create template. Category **Utility**,
   name `trainee_updates`, language **English (US)** (`en_US`), body exactly
   `Trainee has {{1}} new update(s) for you. Reply to see them.` with sample `3`; no header, footer or buttons. Submit.
   The definition is in `docs/launch/whatsapp-templates.json`. When Meta approves it, set the name (not a secret):
   `supabase secrets set --project-ref <ref> WHATSAPP_TEMPLATE_UPDATES=trainee_updates WHATSAPP_TEMPLATE_LANGUAGE=en_US`.
   Meta decides the category: if it approves the template as **Marketing**, per-user marketing limits apply (131049) and
   Trainee simply waits for the person's next message; nothing is lost. Meta charges for each template delivered
   outside the window (rate by country: Meta's pricing page); free text inside the window costs nothing.
9. **The limit**: set `WHATSAPP_DAILY_TEMPLATES` to your number's messaging limit (250 a day for a new account; it grows
   with verification and quality). Past it, messages wait for the person's next message.
10. **Try it** from a phone on the allow list (`TRAINEE_ALLOWED_CONTACTS` takes the number as `+1…`): text the business
    number. If that number already has Trainee on iMessage, nothing is merged: iMessage asks "Someone texted Trainee on
    WhatsApp from your number. Reply yes to link it.", and the link happens only on that yes.

Not verified against Meta's own pages (they did not load from the build environment): the signature header's exact
form, the business-scoped id fields (`user_id`, `from_user_id`, sending with `recipient`), whether 131047 comes back on
the send or only in a status (both are handled), and Graph API `v21.0` (set `WHATSAPP_GRAPH_VERSION` to the version your
app shows). Steps 7 and 10 check them live.

## The cloud runner (FEATURE 17: preparation and sending without anyone's computer)

Go-live deploys `career-cloud-runner` every time (without its secrets it answers 503 "not configured"). It wires it, on
the same run, only when `VERCEL_TOKEN` is given: then it asks for `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` and
`CLOUD_SANDBOX_SNAPSHOT_ID` (or builds the snapshot at `--sha` with `--build-snapshot`: one Vercel sandbox for about 25
minutes, which is spend), generates `CLOUD_RUNNER_SECRET`, `CLOUD_DISPATCH_SECRET` and `CAREER_PREPARE_AHEAD_TOKEN` when not
given, derives `CLOUD_BRIDGE_URL` and `CAREER_PREPARE_AHEAD_URL` from the project ref, sets the runner's sizing by name
(each as given, or its default: sending 2 at once, 1 per family, 2 started a tick; preparation 2 at once, 2 a tick) and a
per-person or per-site number only when one is given (none by default: the owner's NO LIMITS rule, 2026-10-27), and schedules the two minute ticks (`scripts/launch/schedule-career-cloud.sql`). It never
turns anything on by itself: `CLOUD_RUNNER_ENABLED=on` / `CLOUD_PREPARE_ENABLED=on` only when given, and the database's
`CAREER_AGENT_SUBMIT` / `CAREER_CLOUD_APPLY` / `CAREER_CLOUD_TEXT_CARDS` only by the owner's SQL. Everything else (the route, the limits, the
recommended first-wave numbers, the gate): docs/launch/CLOUD-RUNNER.md. The owner's first run: docs/launch/RAMP-FIRST-RUN.md.
## Running mass submission

There is no volume number of Trainee's own (owner, 2026-10-27). Every executor runs as many applications as its machine
holds, on every employer site. It slows only when a site refuses (a 429, a Retry-After, or a verification check), and then
only on that site, for every instance at once. A captcha is never solved: it ends `needs_user` with its link, and so does
a sign-in wall. Each application is started at most once, even when a worker is killed mid-batch.

- **The commands**:
  - submitting from the cloud: `deno run -A workers/career-cloud/worker.ts`, on as many machines as you like;
  - the person's own computer: `deno run -A workers/career-browser/approve-first.ts run <resume.pdf>`, one at a time with
    `--headed`, `--handoff` or `--person-submits`;
  - phone-only preparation: `deno run -A workers/career-browser/prepare-ahead.ts serve --port 8787` behind HTTPS, with
    `PREPARE_AHEAD_SHARD=i/n` on each of several hosts.
- **What go-live takes**: `CAREER_PREPARE_AHEAD_URL` and `CAREER_PREPARE_AHEAD_TOKEN` (both or neither; the table above).
  Without them, phone-only preparation is `NOT_WIRED`: the smoke says so, and `prepareHostStatus` gives the chat a
  plain sentence.
- **Hosts, env names, scaling out, and the measured numbers**: docs/launch/MASS-SUBMISSION.md.

## Rollback

Nothing below drops data. The tables stay (the migrations are additive and nothing old reads them); deleting a table or
its rows is a separate decision of yours, never part of a rollback.

- **Stop every text now**: `supabase secrets unset LOOPMESSAGE_API_KEY TELEGRAM_BOT_TOKEN WHATSAPP_TOKEN --project-ref <ref>`
  (each channel then answers 503 NOT_WIRED and sends nothing; its messages wait in the outbox), and/or remove the webhook
  in LoopMessage, call Telegram's `deleteWebhook`, or unsubscribe `messages` in Meta's webhook settings. One channel
  alone: unset only its token.
- **Stop the schedules**: `psql "$SUPABASE_DB_URL" -c "select cron.unschedule(j) from unnest(array['trainee-deliver','trainee-career-proactive','trainee-career-ingest']) j"`; then the ingest lanes:
  `psql "$SUPABASE_DB_URL" -c "select cron.unschedule(jobname) from cron.job where jobname like 'trainee-career-ingest-lane-%'"`.
  Re-running step 5 brings them back. Their Vault secrets (`trainee_*_secret`) can stay.
- **Everything back to an earlier commit that has WO-093**: `git checkout --detach <earlier sha>`, then
  `bash scripts/launch/trainee-go-live.sh --sha <earlier sha> --skip-migrations`, then `--verify <earlier sha>`. The
  ledger then names that commit for every function. A hand deploy (below) writes no row, so `--verify` reports it.
- **agent-chat back to the previous version**: `cd ~/trainee-rollback/agent-chat-<UTC> && supabase functions deploy agent-chat --project-ref <ref>`.
  If the download failed: `git checkout <previous commit>`, `node scripts/career/stage-career.cjs /tmp/rb/supabase/functions`,
  write `[functions.agent-chat]` / `verify_jwt = true` to `/tmp/rb/supabase/config.toml`, then
  `cd /tmp/rb && supabase functions deploy agent-chat --project-ref <ref>`.
- **The router brain back**: `supabase secrets unset CAREER_BRAIN --project-ref <ref>`.
- **Remove the new functions** (after unscheduling): `supabase functions delete <name> --project-ref <ref>` for
  `career-ingest`, `career-proactive`, `trainee-deliver`, `trainee-inbound`, `trainee-telegram`, `trainee-whatsapp`.
