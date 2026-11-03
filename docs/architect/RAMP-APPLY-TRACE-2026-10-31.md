# The Telegram apply path, link by link, for the owner's first real application (2026-10-31)

Posting: Ramp, Software Engineering Intern, Frontend, Ashby,
https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74. Nothing was submitted to Ramp or any employer. Nothing
was deployed, no migration was applied, no live database was touched, and the live Ashby page was not opened: the build
container's egress refused `jobs.ashbyhq.com` and `api.ashbyhq.com`. Every claim below is a test on a local stand-in.

Labels: **PROVEN** = a test drives this link with the production code and asserts the outcome (test named).
**BUILT-UNTESTED** = the code exists, but no test drives it in the shape Ramp's live run needs. **MISSING** = the link
does not work for Ramp as the code stood at trunk `ddb7d292`.

## The trace

| # | Link | Code | Status at trunk `ddb7d292` | After this PR |
|---|---|---|---|---|
| 1 | Telegram text "apply me to this: <Ashby link>" reaches agent-chat | `trainee-telegram/handler.ts` → `chatThroughAgent` → `handler-career.ts` | PROVEN: `flow-telegram-e2e` step 4 | same |
| 2 | Posting read from Ashby's public API, queued, the hosted preparation kicked | `career_apply_wanted`, `kickPrepare` → `career-cloud-runner/prepare` | PROVEN: `flow-hosted-apply` step 2. CI on trunk `ddb7d292` (run 41231812697) is green on every architect shard, and this test throws in CI rather than skip. Locally it failed because the test runs as `runner`, which inherits `SSL_CERT_FILE`/`DENO_CERT=/root/.ccr/ca-bundle.crt` (unreadable under `/root`, mode 700). With `DENO_TLS_CA_STORE=system,mozilla` Deno's first `fetch` (the Ashby posting read, stubbed to 127.0.0.1) throws "Failed to load platform certificates: Permission denied (os error 13)", which the apply turn reports as "couldn't read that posting from Ashby". With a readable copy of the bundle it passes, 11/11 steps | same |
| 3 | Fields read from the live form | `scripts/apply.ts` dry run in the preparation sandbox (`prepare-runner.ts` → `prepareAhead` → `approve-first.ts prepare`) | **MISSING for every real Ashby form.** Ashby has no `<form>` post, so the dry run stops at `SUBMIT_DESTINATION_NOT_BOUND` before the card unless the engine runs with `--script-submit ashby` or `UPMORE_SCRIPT_SUBMIT_LIVE=1`. The Vercel host never passed that switch to its sandboxes (`cloud_runner.ts vercelSandboxHost.run`), and the VM preparation host dropped it (`prepare-ahead.ts PREPARE_ENGINE_ENV_KEYS`). Every existing test injected `--script-submit ashby` by hand, which hid this. | PROVEN plumbing: `ramp-ashby-submit-path` L1a, L1b, L1c. The stop itself is shown in L2 (no binding gives `SUBMIT_DESTINATION_NOT_BOUND`). |
| 3b | The live page's shape: the form appears only after a read-only GraphQL query | engine route `readOnly` | BUILT-UNTESTED for Ramp (proven on a generic page in `career-script-submit-binding.test.cjs`) | PROVEN: `ramp-ashby-submit-path` L2 (`ApiJobPosting` read, then filled) |
| 4 | Answers only from confirmed facts | `trustedFacts` / `contractFill` (WO-102) | PROVEN: `wo-102-paths`, `submit-real-person` | also L2: every answer on the card is a `text-answer:N` the person gave or the approved resume |
| 5 | Missing facts asked | `questionsText` (one composer for the chat reply, the hosted push and the scheduled push) → outbox | Was a numbered list of up to 5 in one message. **Now one question per message on every channel; the next is asked in the reply that saves the answer (or "use 1"); "skip" moves on and the skipped one comes back last; a deferral ("not yet") or several numbered answers save nothing; the card is prepared again only when none is open**: `ramp-one-question-at-a-time` Q1-Q5 (red on the prior code, green now) | same |
| 6 | Approval card with the exact payload hash; Approve/Decline buttons bound to card id and hash | `prepare()` card lines, `career_apply_card_answer_as` | PROVEN: `flow-telegram-e2e` 6a-6c (forged button, changed card and text "yes" approve nothing), `chat-approval-card-binding` | also L2: one card line per answer sent, each showing what goes on the wire |
| 7 | Queue: `career_apply_jobs` row, `payload_hash = approval_hash` | `career_apply_card_answer_as` | PROVEN: `flow-hosted-apply` step 5, `flow-telegram-e2e` 6c | same |
| 8 | Kill switch `CAREER_AGENT_SUBMIT` | SQL claim and authorization checks | PROVEN for the cloud text-card route and the agent one-tap start: `tests/db/career_apply_agent_submit.test.sql`, `career_cloud_hosted_apply.test.sql`, `flow-hosted-apply` step 6. **Not in** `career_apply_claim_own` (own-computer route, 20261025110000). That route runs only on the person's own computer after their tap. | same |
| 9 | Which submitter runs | see below | **Nothing runs by default.** A queued job is driven only by (a) the owner's own computer (`approve-first.ts` runner) or (b) the hosted cloud runner, with every switch on and a waiver. Nothing in the repo shows either one deployed or running. The handoff of 2026-10-27 says "not deployed, not verified live", and nothing since says otherwise. | same |
| 10a | Submitter (b): cloud sandbox submits exactly the card | `sandbox-runner.ts` → `runCloudJob` → `scripts/apply.ts --submit --approved` | PROVEN on JSON-shaped stand-in: `flow-hosted-apply` step 6 (loose compare). **MISSING for real Ashby (link 3's switch).** BUILT-UNTESTED: Ashby's multipart wire shape. | PROVEN: L2: one multipart mutation to `/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction`; field entries equal the approved card byte for byte (only change: the page's own yes/no → boolean); resume file part byte for byte; authorized before the engine twice and before the one Submit. L2b: a page that changes an answer is stopped, nothing sent. |
| 10b | Submitter (a): own computer | `approve-first.ts runApproved` + `engineRunner` (inherits the shell's env) | PROVEN with `--script-submit` injected: `flow-telegram-e2e` step 7 (loose, lower-cased compare). For real Ashby it needs `UPMORE_SCRIPT_SUBMIT_LIVE=1` in his shell. That was undocumented until now. | documented (below) |
| 10c | Submitter: browser extension | `extension/`, `career_apply_extension_begin_own` | BUILT-UNTESTED for Ramp/Ashby submit (person-submits proven on captured forms, `career-extension-person-submits.test.cjs`). Not recommended for the first run. | same |
| 11 | Captcha → needs_user, never solved | engine `detectChallenge` → `needs_user`/`captcha` → `settle` → `bot_check` | PROVEN at Submit: `flow-hosted-apply` step 8 | PROVEN at load **and** at Submit on the live shape, driven once, no Submit authorized: L3 |
| 12 | Confirmation captured | page text → `confirmation_id`; screenshot hash; employer response code | PROVEN: `flow-hosted-apply` 7a | also L2 (`RAMP-ASHBY-0931`, 200, after-submit screenshot hash) |
| 13 | Tracker updated, confirmed only by email | `career_apply_cloud_finish` (`submitted_unconfirmed`), `runMail` (`confirmed`) | PROVEN: `flow-hosted-apply` 7a, 7b, 7c (the owner's verification SQL in RAMP-FIRST-RUN.md runs as written) | same |
| 14 | Receipt and read-back in Telegram | `runReceipts` → outbox → `trainee-deliver`; `career_apply_status.ts` | PROVEN: `flow-telegram-e2e` 7-8, `flow-hosted-apply` 7a | same |

## Mutation checks (each guard reverted alone, the named test goes red, then restored)

| Mutation | Red |
|---|---|
| Vercel host drops `UPMORE_SCRIPT_SUBMIT_LIVE` | L1b |
| `PREPARE_ENGINE_ENV_KEYS` without it | L1c |
| `scriptSubmitFamily` ignores the live switch | L1a |
| `carriesApproved` accepts any body | L2b |
| `fnDetectChallenge` always false | L3 |

## What the dry run showed on the stand-in, to check on the live page

- **Fixed: consent lines read as one option answering another.** On the reconstructed markup the SMS consent radios had
  no heading of their own, so the group took its first option as its question: `You agree: Yes - I consent to receiving
  text messages: No - I do not consent to receiving text messages`. Discovery now takes the text block just before such a
  group as its question (the page's own "Check Yes or No to indicate your agreement to receive text message updates from
  Ramp regarding your job application."). A group with no question text on the page (WhatsApp, in the copy) is named by
  all of its choices, never by one. The answer shown is the label of the option whose code is sent (`notGiven`):
  `ramp-one-question-at-a-time` C1, C2. If the live WhatsApp consent has its own text, the dry run will show it.
- The graduation date box keeps only `MM/DD/YYYY`. A month and year alone is cleared by the page, and Trainee never adds a day.
- The school is a search box. The stand-in offers what was typed. Ramp's live list may not hold his school's exact name.

## Run the architect's dry run on the real page (never submits)

```
deno run -A scripts/career/ramp-dry-run.ts --persona <his persona JSON, outside the repo> --out <new empty folder>
```

The run refuses `--submit`, and its engine runner throws if a submit is ever asked for. It writes the following:
- `field-map.json`: every field the page showed, the answer per field with its source, the fields left empty, and the bound destination.
- `card.txt`: the card exactly as he will read it.
- `questions.json`: what Trainee would ask him.
- `before-review.png`: the filled form at the final review.
- `evidence.json`

Proven on the stand-in by L4. Run it from a machine whose egress reaches `jobs.ashbyhq.com`, with `UPMORE_PLAYWRIGHT_PATH`
set. Exit 0 means ready. Exit 1 means something is still needed (listed).

## What the owner provides for the live Ramp run

**His answers** (sent in Telegram; each is asked if missing):
- The resume PDF: the exact file. It is kept byte for byte by sha256. Then he says "that's my resume".
- Full legal name, email and phone, exactly as they should appear.
- School, as he wants it matched on Ashby's search list.
- Graduation date with the day, `MM/DD/YYYY`.
- Greater NYC location or relocation: Yes/No.
- Visa sponsorship: Yes/No.
- The "something you've built" text, in his words.
- SMS consent and WhatsApp consent: his own choice. They are optional and never given for him.
- Optional fields (pronouns, LinkedIn, degree and dates) stay empty unless he states them.
- His Trainee user id, for the dry-run persona and for `gate_user_ids`.

**Settings, by submitter** (names only; the values are his):

| Submitter | Where | Settings |
|---|---|---|
| Telegram in and out (both options) | `trainee-telegram`, `trainee-deliver`, agent-chat | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_CHAT_IDS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `CAREER_MODEL`, `CAREER_PREPARE_AHEAD_URL`, `CAREER_PREPARE_AHEAD_TOKEN` |
| (b) hosted cloud | `career-cloud-runner` function secrets | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `CLOUD_SANDBOX_SNAPSHOT_ID` (**rebuilt at the merge commit of this PR**), `CLOUD_RUNNER_SECRET`, `CLOUD_DISPATCH_SECRET`, `CAREER_PREPARE_AHEAD_TOKEN`, `CLOUD_BRIDGE_URL`, `CLOUD_RUNNER_ENABLED=on`, `CLOUD_PREPARE_ENABLED=on`, **`UPMORE_SCRIPT_SUBMIT_LIVE=1` (new; without it Ramp cannot be prepared or sent)** |
| (b) database | SQL, the owner's | `CAREER_AGENT_SUBMIT`, `CAREER_CLOUD_APPLY`, `CAREER_CLOUD_TEXT_CARDS` = `on` in `career_cloud_settings`; one `career_apply_cloud_gate_waivers` row (ashby, 1 send); his opt-in; the pg_cron ticks `career-cloud-dispatch` and `career-cloud-prepare-dispatch`; the migrations listed in `scripts/launch/trainee-go-live.sh` |
| (a) his own computer | his shell | `UPMORE_SUPABASE_URL`, `UPMORE_SUPABASE_ANON_KEY`, `UPMORE_APP_URL` (or `UPMORE_ACCESS_TOKEN` + `UPMORE_REFRESH_TOKEN`), `UPMORE_PLAYWRIGHT_PATH`, optional `UPMORE_CHROMIUM_PATH`, `UPMORE_CHROMIUM_SANDBOX`, **`UPMORE_SCRIPT_SUBMIT_LIVE=1`**; Gmail connected (the confirmation email makes it `confirmed` and counts 1 of the 3 for the Ashby gate) |
| VM worker and VM preparation host (MASS-SUBMISSION.md) | host env | `UPMORE_SCRIPT_SUBMIT_LIVE=1`, beside their existing database settings |

Choosing (a) or (b) is the owner's decision (CLOUD-RUNNER.md, "The owner's Ramp run and the gate"). With (b), a datacenter
IP running headless Chromium makes a reCAPTCHA Enterprise challenge likely. If one appears, the job comes back as
`needs_user` and he finishes it at the link.
