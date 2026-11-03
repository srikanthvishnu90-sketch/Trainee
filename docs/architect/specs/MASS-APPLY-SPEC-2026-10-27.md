# Mass application submission: feature spec (2026-10-27)

Owner of this document: the architect. It turns the owner's mass-submission decisions of 2026-10-27 (D-MS-1..4) and the
later NO LIMITS and SCALE rulings into sub-features that the three builder lanes build and Instinct judges.

Sources:
- the owner's decisions D-MS-1..4 (2026-10-27 13:2x CDT, quoted from the mass-submission brief; their DECISIONS.md rows
  are the mass-submission lanes' to add) and D-NO-LIMITS and D-SCALE (`DECISIONS.md`, added in the same PR as this
  spec);
- the mass-submission brief of 2026-10-27;
- `SUBMIT-PATH-2026-10-25.md` (the one path, its volume ceilings and approval model) and
  `HANDOFF-SUBMIT-PATH-2026-10-27.md`;
- the capability map of 2026-10-26 (AP-*, DI-06, PM-07, TR-*; branch `docs/handoff-20261026`);
- the launch audit (B2, B4, Q2, X1-X7; branch `audit/launch-readiness-20261026`);
- the connectors audit's root cause 2 (eight apply paths).

Every "today" statement is about trunk `4144c42ea` unless it names a lane. Nothing here authorizes a deploy, a live
migration, a Vercel sandbox, model spend, or contact with a real employer (D-MS-4).

## 0. Lanes and ids

| Lane | Owns | Migration range |
|---|---|---|
| **A** (database) | the queue, the ledger, cards and approval functions, the exact-duplicate rule, claim functions, pacing rows | `20261027 14xxxx` |
| **B** (conversation) | the chat side: mass asks, the batch card and its answer grammar on every channel, replies, status | none |
| **C** (executors) | the workers that prepare and submit: the scheduler, crash recovery, captcha and sign-in hand-backs, the preparation host | none |

| Id | Sub-feature | Lanes |
|---|---|---|
| APL-01 | Ready to apply: the confirmed resume and facts | B (asks), A (gate in SQL) |
| APL-02 | Mass asks: from a search or a list to a batch | B |
| APL-03 | Preparation at scale, including for a person with only a phone | C (host), A (functions) |
| APL-04 | Questions asked once across the whole batch | B, A |
| APL-05 | The batch card and one yes (D-MS-1) | B (grammar), A (card, approval) |
| APL-06 | The queue and the exact-duplicate rule (D-MS-3) | A |
| APL-07 | Execution at scale: claims, leases, executors | C, A |
| APL-08 | Outside refusals: captcha, sign-in walls, rate limits, bot checks | C |
| APL-09 | Confirmation and proof | C, A |
| APL-10 | Status and tracking | B |
| APL-11 | Change, cancel, withdraw and erase | A, B |
| APL-12 | Apply by email through the person's own mailbox | **PROPOSED** (owner to confirm; rail shared with networking M1) |
| APL-13 | Scale proof | A, C |

## 1. Rules that hold for every sub-feature

1. **Approval (D-MS-1).** A texted yes on any channel (SMS/iMessage, WhatsApp, Telegram, web) approves exactly the batch
   that was shown, each item bound to its payload hash. "yes except 3" and "only 1,2" approve the stated subset.
   Ambiguous replies ("maybe", "yes but not Acme" when Acme is not unique on the card) approve nothing. A payload that
   changed since it was shown is refused, not sent. This replaces Option A (text yes refused) and D-031's reply-only
   rule.
2. **No volume cap (D-MS-2) and NO LIMITS.** Trainee sets no number of its own: no per-person daily limit (the 25/50 of
   D-011 is gone), no per-card cap as a submission limit, no claim-size bound, no one-at-a-time claim, no default
   per-host spacing or in-flight number. Work slows only when an outside system refuses (a portal's 429 or rate limit,
   a bot wall, a captcha). Trainee then backs off on that host, resumes when the host allows, and tells the person.
   A pace the person sets for themselves ("only 10 a day") is their choice and is honored, with no maximum.
3. **Duplicates (D-MS-3).** Only exact duplicates are blocked: the same posting (canonical job URL or ATS job id) for the
   same person, already sent or in flight. "One per company per 30 days" is gone; different roles at one company are
   fine. Unique confirmation ids and the payload-hash re-verify at claim stay.
4. **Never invent (D-007).** Every answer on a form comes from a confirmed fact or the person's own answer. Never submit
   without a real confirmed resume (audit B4; do not weaken any resume gate).
5. **Never.** No LinkedIn or Indeed automation; no captcha solving (a captcha ends `needs_user`, never retried); no
   password or one-time code through chat (D-013(b), D-021, D-029 rules unchanged).
6. **Proof (D-024).** "Submitted" only with the engine's record; "confirmed" only with the employer's own answer on the
   page or in the person's mail.
7. **Truthful replies.** No promise the deployed system can't keep (audit Q2: the apply reply promised preparation when
   no host was configured). If preparation or submission is not wired for this person, the reply says so.
8. **Channel parity.** The card, the yes and the status work on every channel, or the reply says what is missing there.
9. **Tests never reach an employer.** Postings are local fixtures (127.0.0.1), portals are faked; no real submit.

### 1.1 What NO LIMITS changes in today's code and in the lanes' drafts

| Limit | Where | Under NO LIMITS |
|---|---|---|
| Person's daily limit 25/50 (`DEFAULT_DAILY`, `MAX_DAILY`, `career_apply_daily_limit`) | `_shared/career_apply.ts:46,57`; migrations `20261020050000`, `20261025100000` | removed (lane A's `20261027140000`); only the person's own optional pace remains |
| `MAX_PER_CARD = 8`, `items between 1 and 8` | `career_apply_cards.ts:43`; `20261020030000:21,78` | removed as a submission limit. Lane A's draft allows up to 100 per card "as an argument bound". Under NO LIMITS a batch larger than one card's technical size is several cards opened together under one **batch id**, and one yes approves the whole batch shown |
| `least(6, p_limit)` claim; `claim(limit = 1)`; store-side `limit > 6` | `20261025100000:263,275`; `approve-first.ts:408,443`; `career_apply_store.ts:37` | removed; claim takes what the caller asks (a sanity bound on the argument only) |
| Cloud `min(6, contexts)`; cloud bridge `least(15, …)` | `workers/career-cloud/worker.ts:236`; `20261024130000` | removed; concurrency is the worker's hardware setting, not a product number |
| Prepare-ahead 5 per person, 50 per run; SQL 25/200 | `prepare-ahead.ts:67`; `20261025120000:75-77` | removed |
| **Default per-host pacing** in the lanes' drafts: lane A `career_apply_host_pacing` (`min_gap_seconds` 20, `max_inflight` 3); lane C `MASS_SUBMIT_HOST_MAX` 2, `MASS_SUBMIT_HOST_SPACING_MS` 10 s | lane A `20261027141000`; lane C `workers/career-browser/mass-run.ts` | these were written before NO LIMITS (19:55). Under it there is **no default pacing number**. The pacing table keeps only the back-off state a host's refusal sets (`paused_until`, the observed Retry-After, a bot-check count). A per-host row may be set by the owner after a host has refused, as an observed fact, never as a default |
| `PREPARE_AHEAD_RUN_MAX`, `MASS_SUBMIT_CONCURRENCY`, `MASS_SUBMIT_CLAIM_BATCH` | lane C | allowed only as the capacity of one worker process (how many browsers this machine runs), scaled out by running more workers; never a cap on a person's work |
| Lane B's 20 pages per reply | lane B `career_apply_cards.ts` | a texting-channel message size, not an approval limit. Under D-MS-2 one yes approves the whole batch shown, so a batch longer than one reply is shown as a summary plus an inspect link (web) or as consecutive messages, and the yes covers every item shown; "N more come on the next card" is acceptable only if those N were never shown and are not approved |
| `SPEC_CAPS` (15/5/1) | `packages/domain/149-career-portal-apply.js` | off the path (old stack, retired by the root-cause-2 consolidation); never re-enabled |

## 2. Shared state (the one path)

`SUBMIT-PATH-2026-10-25.md` names the one path: the person texts → server preparation → the card → the person's yes →
claim → the engine submits → finish records it → chat reads it back. The eight apply paths of the connectors audit
(the 155 batch stack, the D-014 queue, the extension, the desktop runner, prepare-ahead, the cloud bridge and runner,
F1 chat-to-queue, apply by email) converge on these tables. New work adds no ninth path.

| What | Table (trunk or lane A) |
|---|---|
| A posting the person asked for | `career_apply_wanted` |
| A prepared application (answers, files, payload, `payload_hash`) | `career_apply_prepared`, `career_apply_prepare_attempts` |
| Open questions | `career_apply_questions`, `career_apply_question_drafts` |
| A card (items with `payload_hash`), its answer | `career_apply_cards` (+ batch id under NO LIMITS) |
| An approved application in the queue | `career_apply_jobs` (`approval_hash = payload_hash`) |
| The one ledger and the exact-duplicate rule | `career_apply_ledger`, `career_apply_posting_key`, `career_apply_posting_sent` |
| Host back-off state | lane A's `career_apply_host_pacing` (refusal state only, §1.1) |
| Receipts and proof | `career_apply_receipts`, `career_apply_receipt_files` (files in storage, not Postgres; audit X-finding on screenshots) |
| Timeline | `career_events` |
| Plan steps across turns | the task-intelligence plan tables |

## 3. Sub-features

### APL-01 Ready to apply: the confirmed resume and facts

- **Story.** "Apply me to jobs" from someone Trainee has never met.
- **Triggers.** "apply to jobs for me", "can u apply to like 100 internships", "apply to the ones you found".
- **Asks (once, in this order, only what the batch needs).** The resume (file, paste, or forward); a yes to confirm the
  entries as shown; contact facts (name, email, phone) if a posting asks for them and they are not on record
  (`contact_draft.ts`, "use N"); work authorization and sponsorship (asked once, stored per country).
- **Connectors.** None. Files on channels are partial (CH-10); the fallback is paste.
- **Execution.** The resume rule in SQL (`career_resume_ok`, #194): no stored, confirmed resume → nothing is prepared,
  queued or claimed.
- **Recorded state.** `fact_confirmed` events with provenance (`career_router_evidence.ts`); the stored resume.
- **Truthful reply.** "I need your resume before I can apply anywhere. Send it as a file or paste it here."
- **Failure paths.** Unreadable file; resume pasted without headings; a correction after approval (approvals that relied
  on the old fact become stale and are re-shown: `career_account_authority_mark`).
- **Acceptance.**
  - **APL-01-S1** (Telegram, new user): "apply me to 50 data analyst jobs in chicago" with no resume → 0 rows in
    `career_apply_wanted`, `career_apply_jobs`; the reply asks for the resume once.
  - **APL-01-S2** (SQL): a direct call to enqueue with no confirmed resume is refused by the database.

### APL-02 Mass asks: from a search or a list to a batch

- **Story.** "Apply to all of them." / "Apply to the top 50 remote ones."
- **Triggers.** "apply me to all of them", "apply to the top 50", "apply to all remote ones", "apply to every SWE intern
  role you found", "apply to 1, 3 and 7", a pasted list of links, "apply to 200 data jobs in NYC" (a search, then a
  batch).
- **Asks.** Nothing if the referent is clear; one question if "them" could mean two lists.
- **Execution.** Resolve the referent against the last list shown (stored ordered, account-wide: WO-100 R7); filter
  exactly as said ("remote" filters; lane B found "all remote ones" queued every listed posting before); closed or
  unknown postings named and dropped; exact duplicates named.
- **Recorded state.** One `career_apply_wanted` row per posting, with the plan step that asked for it.
- **Truthful reply.** "I'll prepare 47 of the 50: 2 have closed and 1 you already applied to. You'll see each one before
  anything is sent."
- **Acceptance.**
  - **APL-02-S1** (web): a list of 60 with 22 remote; "apply to all the remote ones" → exactly 22 wanted rows.
  - **APL-02-S2** (SMS): "apply to all of them" in a new thread after a search on Telegram → the same list is used.

### APL-03 Preparation at scale, including for a person with only a phone

- **Story.** "I don't have a computer, just my phone."
- **Execution.** Server preparation (`prepare-ahead.ts serve`, lane C) runs the engine in dry-run mode on a host; it
  never submits. It prepares every wanted posting with answers from confirmed facts and a tailored resume, and records
  the questions it could not answer. No per-person or per-run cap.
- **Connectors.** The preparation host (`CAREER_PREPARE_AHEAD_URL`, token), set up by the owner. When it is not
  configured or unreachable, `prepareHostStatus` reports it and the chat says plainly that nothing will be prepared
  without the extension on a computer (audit B2, Q2).
- **Recorded state.** `career_apply_prepared` (payload, `payload_hash`), `career_apply_prepare_attempts` with the reason
  for any stop.
- **Failure paths.** Host down; a posting closed during preparation; a form family not drivable (named); a sign-in wall
  (APL-08).
- **Scale.** Many preparation hosts claim from one table with leases (lane A's claim pattern); the narrow
  `career_prepare` role replaces the service key (lane C request to A).
- **Acceptance.**
  - **APL-03-S1** (no host): "apply to these 10" → wanted rows exist; the reply says preparation isn't running and what
    would start it; no "I'll prepare" promise.
  - **APL-03-S2** (fake host, 200 wanted): 200 prepared rows with hashes; 0 submits (the engine's dry-run guard).

### APL-04 Questions asked once across the whole batch

- **Story.** "Don't ask me the same thing 50 times."
- **Execution.** Questions are keyed by meaning (`question_map.ts`) and grouped across the batch: one question, answered
  once, fills every application that asks it (PM-07 answer bank). EEO defaults to "decline to answer" unless the person
  says otherwise; attestations only from the person's own words.
- **Recorded state.** One answer row reused by many prepared rows; each prepared row's payload hash changes when an
  answer fills it (so the card shows the final payload).
- **Truthful reply.** "3 questions are holding 41 applications: 1) … 2) … 3) …. Answer them in one message."
- **Acceptance.**
  - **APL-04-S1**: 50 prepared, 30 ask "Are you authorized to work in the US?" → asked once; after the answer, 30
    payloads carry it; the card shows them with new hashes.

### APL-05 The batch card and one yes (D-MS-1)

- **Story.** "Show me what you'll send, and I'll say yes once."
- **Triggers.** Proactive (the morning card, PR-05) or "show my applications", "what's ready".
- **Answer grammar (the one grammar).** "yes", "yes to all", "approve all", "send them" → the whole batch. "yes except 3",
  "yes but not Acme" (when Acme is one item), "approve, skip 2" → leave those out. "only 1, 2 and 5", "just 1 and 2"
  → exactly those. "no" → decline. "wait" → hold. Ambiguous → nothing approved, with how to answer. A number or
  employer not on the card, or a wrong count ("yes send all 60" on a card of 3) → nothing approved.
- **Channels.** A plain yes counts while the card is the thread's last word (iMessage, SMS and web send no reply id);
  on Telegram and WhatsApp a reply to the card's message also counts; buttons where the channel has them.
- **Execution.** The yes calls the existing batch approval (`career_apply_card_answer_as(p_user, p_card, p_approve
  int[])`), the same function a tap uses. Each item's current payload hash must equal the shown hash, else it is
  `changed`.
- **Recorded state.** Card answered once; `career_apply_jobs` rows with `approval_hash = payload_hash = shown hash`.
- **Truthful reply.** "Approved 58 of 60. #12 changed since I showed it (the posting added a question), so it wasn't
  sent; I'll show it again. #31 you left out."
- **Failure paths.** Stale card (a newer card was shown), expired card, already answered, another person's card.
- **Acceptance.** Lane B's suites are the reference (`mass-submit-chat`, `mass-submit-channels`,
  `mass-submit-handler-pg`): every class above on every channel, judged by `career_apply_jobs` rows. Plus:
  - **APL-05-S1** (scale): one yes on a batch of 500 approves 500 in one bounded call; the turn's database requests do
    not grow with the batch (lane B measured 27 requests for both 5 and 500).
  - **APL-05-S2** (NO LIMITS): a batch larger than one card's technical size spans cards under one batch id; one yes
    approves every item shown.

### APL-06 The queue and the exact-duplicate rule (D-MS-3)

- **Execution.** Enqueue requires `approval = payload_hash = career_apply_payload_hash(payload)`. The ledger refuses only
  an exact duplicate (`duplicate_job`: the same canonical posting key, already sent or in flight, for the same person).
  Different roles at one company are allowed.
- **Recorded state.** `career_apply_jobs`, `career_apply_ledger`.
- **Acceptance.**
  - **APL-06-S1**: two roles at Stripe → both queued.
  - **APL-06-S2**: the same Greenhouse posting reached by two URLs (board URL and `?gh_jid=`) → the second is refused
    `duplicate_job`, by the database.
  - **APL-06-S3**: the TS mirror (`admitApplication`) and SQL agree on 20 cases.

### APL-07 Execution at scale: claims, leases, executors

- **Executors.** The cloud worker, the person's computer (`approve-first.ts`) and the extension all claim from
  `career_apply_jobs` with leases. One scheduler (`mass-run.ts`, lane C) claims in batches, runs many at once, journals
  each start before the engine runs (fsync), and on restart records a started-but-unfinished application as
  `unknown_outcome`, never re-driven.
- **Claim.** `FOR UPDATE SKIP LOCKED`, partitioned so many workers run; a fairness quantum per person per pass so one
  heavy person can't starve others; expired leases reclaimed; the payload hash re-verified at claim
  (`career_apply_void_unsendable`).
- **Recorded state.** Each job ends in a recorded state: `sent`, `confirmed`, `needs_user` (with its link), `failed`
  (with the reason), `unknown_outcome`, `not_submitted` (with the reason).
- **Acceptance.** Lane C's `mass-submit-pg` is the reference (42 approved on 7 hosts, SIGKILL after the 10th start,
  restart from the journal): every row ends recorded, each engine starts once, each posting gets at most one POST, the
  one running at the kill is `unknown_outcome` and never re-driven. Under NO LIMITS the per-host maximum and spacing
  assertions become back-off assertions (APL-08).

### APL-08 Outside refusals: captcha, sign-in walls, rate limits, bot checks

- **Execution.**
  - Captcha (`captcha`, `CAPTCHA_AT_SUBMIT`) → `needs_user` with the posting's link, never retried, never solved.
  - Sign-in wall (`ACCOUNT_LOGIN_REQUIRED`) → `needs_user`/`login_required` (D-013(b): the person signs in themselves).
  - HTTP 429 or a host's rate-limit page → that host is paused until its Retry-After (or an exponential back-off when none
    is given); other hosts continue.
  - A bot check that is not a captcha → host back-off grows; the person's application on that host is `needs_user`.
- **Recorded state.** Lane A's host pacing row holds only refusal state (`paused_until`, last refusal, count).
- **Truthful reply.** "Greenhouse asked for a human check on 3 applications. Open each link to finish it yourself:
  1) … 2) … 3) …." "Workday slowed us down; the remaining 12 continue at 4:10 pm."
- **Acceptance.**
  - **APL-08-S1**: fixture host returns 429 with Retry-After 120 → no start on that host for 120 s (fake clock); other
    hosts proceed; every job ends recorded.
  - **APL-08-S2**: captcha fixture → `needs_user`, 0 POSTs, never claimed again.
  - **APL-08-S3** (NO LIMITS): a host that never refuses runs at the workers' full capacity; no wait was inserted by
    Trainee (the scheduler's start times show no default spacing).

### APL-09 Confirmation and proof

- **Execution.** The engine captures the employer's confirmation text or id on the page; the mail classifier confirms
  from the employer's email (EM-10). Receipts are written by the database on finish.
- **Recorded state.** `career_apply_receipts` (answers sent, approval time and hash, before/after pictures in storage,
  confirmation text or id, final URL, times). Unique confirmation ids (`career_apply_confirmation_key`).
- **Acceptance.**
  - **APL-09-S1**: two employers return the same confirmation id → the second is "unconfirmed", not confirmed.

### APL-10 Status and tracking

- **Triggers.** "did they go through", "where are my applications", "what's stuck", "how many did you send today".
- **Execution.** One read model (WO-100 situation) over wanted, prepared, cards, jobs, receipts and mail events.
- **Truthful reply.** Counts and names from rows; "submitted" vs "confirmed" kept apart; `needs_user` items first with
  their links.
- **Acceptance.**
  - **APL-10-S1** (every channel): seeded 120 jobs across states → the reply's counts equal the rows on web, Telegram,
    SMS and WhatsApp.

### APL-11 Change, cancel, withdraw and erase

- **Triggers.** "don't send the Acme one", "cancel all pending", "stop applying", "forget my applications".
- **Execution.** An approved, unclaimed job can be cancelled (state `cancelled`); a claimed one finishes or is stopped at
  the next safe point, said truthfully; a submitted application cannot be unsent (the reply says so and offers a
  withdrawal email draft, approved like any send, if APL-12 or the networking send rail is connected). Erase removes
  every application record of the person in one transaction (audit: "the erase misses records about applications").
- **Acceptance.**
  - **APL-11-S1**: 30 approved, "cancel all pending" with 4 in flight → 26 `cancelled`, 4 finish recorded; the reply says
    26 and 4.
  - **APL-11-S2**: erase → 0 rows in every apply table for the person; another person's rows untouched.

### APL-12 Apply by email through the person's own mailbox (PROPOSED)

- **Story.** "This posting says to email your resume to jobs@…."
- **Why proposed.** AP-28 is built behind `CAREER_EMAIL_SEND` (off). D-MN-1 allows sending from the person's own Gmail
  for outreach; whether it also covers applications sent by email is the owner's call.
- **Shape.** The whole email and attachment shown on the batch card, hash-bound; sent once through the networking send
  rail (NET-06); the exact-duplicate rule applies; confirmation from the employer's reply.

### APL-13 Scale proof

- **Requirement (SCALE).** 100,000 people active at once, hundreds of applications each per day.
- **Load test, CI-runnable, real Postgres 16.** For example 10,000 people × 50 queued applications, 20 concurrent
  workers with a fake engine: measure claims per second and claim latency; assert exactly-once (no job claimed twice
  while leased, none lost), fairness (the p99 wait of a light person while a heavy person has 5,000 queued stays within a
  stated bound measured on the base), and lease reclaim after a killed worker.
- **Hot paths.** Every claim and status query uses an index and a bound; no per-turn read of hundreds of rows; no
  screenshots in Postgres.
- **Report.** The PR states the measured numbers and how they were measured, and the numbers on the base for
  comparison.

## 4. Cross-channel acceptance (new users, judged by state)

| Id | New person says (messy) | State afterwards |
|---|---|---|
| APL-E1 | "can u apply me to like 100 remote data analyst jobs" (no resume) | 0 wanted/jobs; resume asked once |
| APL-E2 | After the resume: "ok go", then a card of 100, "yes except 7 and 40" | 98 jobs with matching hashes; one card answered |
| APL-E3 | "yes but not the one in ohio" (ambiguous) | 0 approved; how to answer said |
| APL-E4 | A posting changes after the card is shown, then "yes" | that one refused by number, the rest queued |
| APL-E5 | Worker killed mid-run | every job recorded; exactly-once; the in-flight one `unknown_outcome` |
| APL-E6 | A portal returns 429 for an hour | that host waits; others proceed; the reply says when it resumes |
| APL-E7 | "did they all go through?" on another channel | counts equal rows; confirmed vs submitted kept apart |
| APL-E8 | "apply me on linkedin" / an Indeed link | refused plainly; 0 requests to those hosts |

## 5. Open decisions for the owner

1. Confirm that lane A's and lane C's default per-host pacing numbers are removed under NO LIMITS (the architect's
   reading of "no default pacing number").
2. APL-12: does D-MN-1's "Trainee sends from the person's own Gmail" also cover applications sent by email?
3. The preparation host for phone-only people (B2) needs the owner's VM, token and go-live settings.
