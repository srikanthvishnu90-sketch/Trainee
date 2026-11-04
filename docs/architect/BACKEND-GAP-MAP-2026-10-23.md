> **SUPERSEDED (2026-10-28):** the current inventory of features, depth and status is `docs/architect/FEATURES.md`. Kept for history; do not use as current.

# Backend gap map, 2026-10-23

The architect's map of the whole backend, from ingest to a proven application, at trunk `63a1233f`. It is in
priority order: the gap that blocks the most real outcomes comes first. Every line is backed by code, a test, or a
read-only query of the live project (`mrwngntwmnaqrqhupvlt`, read 2026-10-23). Docs are treated as claims.

Labels:
- **PROVEN-CONNECTED**: a test drives real code across a stage boundary and checks the outcome.
- **BUILT-UNPROVEN**: the code exists, but is tested only in isolation, with mocks, or not at all.
- **MISSING**: no code.
- **LIVE**: what the production project shows today.

## What is live today (read-only queries)

| Fact | Value |
|---|---|
| Edge functions deployed | `agent-chat` v249 plus older ones (finance, broker, site, channels). **Not deployed: `career-ingest`, `career-proactive`, `trainee-deliver`** |
| Cron jobs | `cancel-watcher-daily`, `plaid-sync-6h`, `upmore-proactive` (all finance era). **No ingestion schedule** |
| `career_postings` (live ingestion) | **0 rows**; `career_ingest_state` empty, so ingestion has never run |
| `career_kb_postings` (frozen snapshot) | 21,688 rows. This is what the released router serves |
| `career_apply_jobs` | **0 rows**, so real submissions = 0 |
| `career_apply_prepared` / `career_apply_wanted` / `career_outbox` | 3 / 0 / 0 |
| `career_batch_runs_v1` (old 155 stack) | 6 runs, all `completed` (sandbox lanes) |
| Apply functions present | `career_apply_enqueue`, `career_apply_claim_own`, `career_apply_cloud_claim`, `career_apply_extension_begin_own`, `career_apply_extension_begin_agent_own`, `career_batch_claim_v1` |
| Migration ledger | no `supabase_migrations.schema_migrations` table, so which repo migrations are applied cannot be read from the database |

## CI coverage (corrects an earlier statement)

`ci.yml` installs Playwright Chromium and runs all of `scripts/gate.sh`:
- the browser, architect, edge, typecheck and bundle steps;
- every `tests/career-*.test.cjs` except the 15 archived files.

It also runs `tests/db/run.sh` on a throwaway Postgres 16. The ~181 tests that fail in the architect's container (no
sandboxed Chromium, no remote Deno imports) therefore pass in CI.

One exception: `tests/edge/channel-text-yes.test.ts` is not in the gate's edge list, so CI never runs it.

## Gaps, in priority order

### G1. No test drives the loop as one connected flow (BUILT-UNPROVEN everywhere)

Each stage is tested alone: ingest with stub HTTP, search in memory, the queue in SQL, the executor with an
in-memory queue or mock RPC. No test takes one person from chat-confirmed facts through a prepared row, approval,
enqueue, claim and the click on a page, to the recorded result and the receipt, on a real Postgres. Until one does,
"working connected flow" cannot be shown, and every fix below is measured by it.

**Status 2026-10-23: closed by `tests/architect/flow-connected.test.ts`** (harness `tests/flow/`):
- **What it drives.** One application through the D-014 stack on a real Postgres (CI's migration order), with a
  sandboxed browser and the real engine: prepare, card, the person's own tap, claim, drive, recorded outcome.
- **The attestation gate.** A certification posting stops at the gate: asked of the person, never prepared or sent.
- **Negative control.** A payload altered after approval is not sent.
- **Not vacuous.** Two planted defects each fail it.
- **Defect it found.** With the worker's own payload check removed, the altered application reached the employer.
  Neither `career_apply_claim_own` nor the engine re-verifies the stored payload against `payload_hash`, so the worker
  check is a single layer (folded into G3).

### G2. The executor's inputs have no product writer (MISSING)

What the executor needs that nothing writes:
- **Basics.** They are kept only with owner provenance and a confirmation event. `set_resume_contact` writes name and
  email without either, so they are dropped. Nothing writes phone.
- **Work authorization and sponsorship.** These need a confirmed `eligibility` fact with a value (149:386-396). Chat
  writes `constraints` instead, which the executor never reads. Live, the polarity was once stored inverted
  (loop-completion §2).
- **Resume.** The executor reads `master.resume` with a sha256; nothing writes it. The resolver
  (`resume-store.cjs`) exists.

The tests pass only on hand-made profiles. A real person's application stops at uncovered questions with no resume.

### G3. Two apply stacks, two caps, two once-per-company ledgers, no unique confirmation ID

- **Caps:** D-014 names one stack with one cap. In code, the queue is 25/50 (SQL), the 155/149 path is 15
  (`SPEC_CAPS`) and the cloud bridge is 15.
- **Once-per-company ledgers:** `career_apply_jobs` and `career_batch_ledgers_v1` do not see each other, so the daily
  cap and the 30-day company rule do not hold across paths.
- **Confirmation IDs (D-024):** `career_apply_jobs.confirmation_id` has no uniqueness constraint, so two employers can
  share one ID.
- **Payload not re-verified:** the claim does not recompute the payload's hash, and the engine sent an altered payload
  once the worker check was removed (found by G1). The database should refuse to claim a row whose payload no longer
  hashes to its approval.
- **Old-stack arming (owner priority, 2026-10-23): closed by G3a.** Module 150's browser board, the old stack's only
  real-browser submit, now arms and clicks only on `localhost` / `127.0.0.1`. A real employer host is refused before
  any browser command, with no switch; no permission or setting was changed. Before the gate, the old stack could
  arm a real Greenhouse click through module 150 after an exact
  "Approve batch <id>" and a matching card hash.

### G4. Nothing is prepared before the person asks (D-011, MISSING)

The queue path's prepare is the manual CLI `approve-first.ts prepare-batch` over a local facts file. The 155 path
prepares only on a chat ask. `career-proactive` only pushes rows that are already `ready`. `planBatch` has no
server-side caller. The tailored resume is not bound into the queue payload, and the cover note has no production
caller.

### G5. Approval semantics are split (WO-005 unbuilt)

- Text "yes" is refused on queue cards (Option A) but approves 155 batch cards over WhatsApp/Telegram, and that test is
  outside CI.
- Generic pending approvals are collected by `loop.ts` and only counted by the handler.
- **The per-application attestation carrier stays parked on the owner's question.** Today attestation exists only as
  the person's own answer row inside the payload hash (queue, cloud, extension), and as a run record inside 155.

### G6. Proof is not kept with the record or shown to the person (D-024, BUILT-UNPROVEN)

- Screenshots stay on the device or VM as hashes.
- `apply.ts` takes its "before" picture at review, not at the click.
- Receipts are tested only in memory.
- Inbox confirmation (`CAREER_MAIL_TRACKING`) is off, so the cloud gate (3 email-confirmed submissions per portal) can
  only open by waiver.

Status, 2026-10-24 (branch `arch/backend-g6-receipts`, not merged):
- **Receipts:** shown on a real database (slice 1, e300defb).
- **Before picture and proof in the record:** slice 2, hardened after the coordinator's review of ce89f34a.
  - **One capture function for every picture.** Each picture goes into its own new file (`proof-<seq>-<kind>.png`),
    numbered in the run's own order. It is recorded the moment it is taken, frozen once recorded, with:
    - its sha256 and its time;
    - the run's id;
    - the application's id (the queue passes `--application-id`).

    No file that was already there is ever read as a picture.
  - **Order is the run's own sequence**, never file mtimes: before-click, then the click, then the after picture.
  - **The before picture** is taken after every check before the click, with what each field held at that moment,
    read back from the page as one sha256 per field. A long answer can run past what a picture shows. The answers'
    text is not kept again.
  - **No before picture, no click:** `BEFORE_CLICK_PROOF_MISSING`, not sent, may be tried again.
  - **The after picture** is taken once the outcome was read. Its failure is kept (`after_submit: null`,
    `after_submit_error`), never covered by an older file.
  - **Without the after picture, never "confirmed"**, in the engine and again in `runApproved`.
  - **`runApproved` keeps a proof only if it is bound to this application and this approval.** Otherwise the record
    gets `proof_refused: PROOF_NOT_THIS_APPLICATION`, and the outcome is never "confirmed".
  - **Test:** `tests/architect/proof-g6.test.ts`, with the employer's server as witness, run through `runApproved` and
    the real engine. G1's drive step checks each hash against its file, the order and the binding.
    - **Fail-first** at ce89f34a: control, 1, 3 and 4 red. Case 2 (a stale picture) was already refused there by the
      engine's empty-directory guard.
    - **Mutations**, each red on its case:
      - M1, the before-click failure swallowed: the click goes on.
      - M2, the empty-directory guard removed and an existing picture taken as the new one.
      - M3, the binding check removed.
      - M4b, both "confirmed" downgrades removed. M4a, the engine's alone, is masked by `runApproved`'s.
    - Green on Chrome 156 and Chromium 141: proof-g6, flow-connected and flow-integrated, 8 tests, 21 steps each.
- **What the proof is, and is not.** Each picture is what the page showed. It binds that picture to this application
  and approval. It is not proof that the employer accepted anything, cryptographically or otherwise. Only the
  employer's own answer, read on the page or in the person's mail (WO-032), makes "confirmed".
- **Sensitivity.** What is written where, and who can read it:

  | Written | Holds | Where | Mode |
  |---|---|---|---|
  | `evidence.json` | the approved answers (the one place their text is kept), the result | the run's evidence directory | 0600 (written aside, renamed in) |
  | `proof-<seq>-<kind>.png`, `before-review.png`, `after-submit.png`, `after-code.png` | the page as it showed | the run's evidence directory | 0600: every file of the directory is set 0600 when the record is written, whichever step took it |
  | the evidence directory | the above | `evidence-*` under the engine's state directory, `trainee-evidence-*` (the person's runner), a uuid (cloud, removed after each run) | 0700 (`privateDir`) |
  | the queue's row, the job store | hashes (`fields_sha256`, one per field), names, the result; never an answer's text | database row; `~/.local/state/upmore/apply` | store files 0600 |
  | the engine's output | field names and the fact behind each; an answer only when the person reviews at their own terminal (`Deno.stdin.isTerminal()`) | the person's terminal, a worker's log | no answer when piped |

  - The cloud worker masks every answer in its pictures (`UPMORE_MASK_SCREENSHOTS`). The person's own runs keep the
    plain picture they can check.
  - The engine never holds a password, a one-time code or an identity number in a field it fills: it stops before
    filling (`ACCOUNT_LOGIN_REQUIRED`, `IDENTITY_NUMBER_REQUESTED`). An emailed code is never stored or printed, and
    `after-code.png` masks every input.
  - **Test:** `tests/architect/proof-g6.test.ts` "proof, private" runs the real engine through `runApproved` with the
    engine creating its own evidence directory (as in production), synthetic persona only (a `PROOF-TEST-` fact on
    `example.test`). It asserts: the directory 0700; every file 0600; the engine's output holds no answer; the queue's
    record and its proof hold no answer, and `fields_sha256` is hex; only `evidence.json` holds an answer's text.
    - Fail-first at 32bdc668: red, `after-submit.png` was 0644 (the helper's `submit_and_capture` wrote it unset).
    - Mutations, each red: the 0600 sweep removed (`after-submit.png is 0600`); the terminal gate removed (`the
      engine printed Proofa`).
  - `tests/architect/evidence-retention.test.ts`: nothing of the evidence is tracked in the repo, and no workflow's
    `upload-artifact` names it.
- **Retention and cleanup: proposed 90 days, the owner sets it.** `scripts/career/evidence-retention.ts`:
  - It removes an evidence directory whose newest file is older than the period.
  - It removes only what is plainly one: the engine's name, owned by this user, 0700, not a link, holding only
    the evidence's own files. Anything else is left and named (a link, not private, another file).
  - Without `--delete` it only lists. `deno run -A scripts/career/evidence-retention.ts [--days N] [--root DIR] [--delete]`.
  - `PROPOSED_RETENTION_DAYS = 90` is a proposal. Nothing runs it on a schedule: deleting on the person's device
    is the owner's call. The cloud worker already removes each run's directory when the run ends.
  - The row's hashes stay; they are not the person's text.
  - **Test:** `tests/architect/evidence-retention.test.ts`: old removed, recent kept, a listing removes nothing, a
    directory's age is its newest file's; a link (and its target), a non-private directory, one holding another
    file, another name: never removed. Six mutations of the module, each red (links followed, non-private
    accepted, foreign files accepted, a listing deletes, the directory's own time only, any name).
- **Still open (before FEATURE 14):**
  - The pictures stay on the device or VM; only their hashes are in the row.
  - The receipt does not show them.
  - Inbox confirmation is off.
- **FEATURE 14 (2026-10-25, `feat/f14-receipts-20261025`):** a stored receipt per application, readable in chat.
  - `20261026140000_career_apply_receipt_store.sql`: `career_apply_receipts` is written by the database when a queue
    row finishes (any finish path), with the answers and their facts, where, when, the hashes, the confirmation id and
    the page text. `career_apply_receipt_files` keeps the bound proof's two pictures, sent by the person's worker under
    its lease (`career_apply_receipt_attach_own`), checked against their hashes; kept 90 days (PROPOSED). Both tables
    are service-role only. The page text never rides the row's evidence.
  - Chat: "show me the receipt for X", "what did you send to X" (`career_apply_receipt_read.ts`, FEATURE 14 block in
    `handler-career.ts`); the pictures go out through `channel_artifacts`. The status reply links to it.
  - Tests: `tests/architect/flow-receipt.test.ts` (real Postgres, browser, engine, `handleChat`),
    `tests/architect/receipt-read.test.ts`, `tests/db/career_apply_receipt_store.test.sql`.
  - Still open: the cloud worker passes no `--application-id`, so its proof is never bound and its receipts carry no
    pictures; the extension path writes receipts without pictures; nothing schedules the 90-day expiry; inbox
    confirmation is off (the owner's flag).

### G7. Jobs never reach a user

- **In code:** `search_jobs`, `set_job_alerts` and `queue_applications` exist only in the agent brain, which is pinned
  off (`AGENT_BRAIN_RELEASED = false`). The released router reads the frozen `career_kb_postings` snapshot.
- **Live:** ingestion is not deployed or scheduled.
- **In the code paths that do exist:** alerts rank by keyword and recency, not fit. Fit ranking sees only the 150
  newest text matches. The relevance floor is not applied at queue time, and its agency list is empty.

Changing the router's data source touches the frozen router, so it needs the impact assessment through the
coordinator.

### G8. Deploy readiness

- Production is `agent-chat` v249, whose lineage relative to trunk is unrecorded (D-026, WO-093 provenance unrun).
- The migration ledger (`upmore_migration_ledger`, read 2026-10-23) records 72 files, only 3 of them from 10-19 or
  later, although the live schema holds the 10-20 to 10-24 apply tables. Those were applied outside the ledger, so a
  `--pending` run would try to replay about 40 files.
- The cloud bridge migration is a draft.
- Paid-eval safety (`arch/eval-cap-remaining` a248c291, `arch/paid-workflow-disable` 70418b2f) is on side branches;
  the 7 paid workflows are enabled.
- Deploys, migrations, cron and flags are the owner's to run.

## Proven and working (scoped)

- The postings schema, RLS, de-dup and the pay column are proven on real Postgres (`tests/db`).
- Payload-hash binding at enqueue, the 25/50 daily cap and once-per-company-per-30-days are proven in SQL for the
  queue stack.
- The extension's submit path:
  - an exact-card check;
  - page re-verification before the click;
  - captcha hand-off;
  - recording before the click.

  This is proven on fixture pages with a mock backend, in CI.
- Ingest to alert to delivery is proven in memory (capability journey).
- Chat routing at `63a1233f`: CI green, unmeasured on a fresh held-out set, frozen.

## Order of work

G1 first, because it is the measuring tool for everything else. Then G2, G3, G4, G5 (without the attestation
carrier), G6, G7 (the router part only after an impact assessment) and G8 (a packet the owner runs). Each gap closes
with the connected test from G1 extended to cover it. Nothing is deployed, no paid run is started, and no real
submission is made.
