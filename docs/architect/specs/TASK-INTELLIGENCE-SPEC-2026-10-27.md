# Task intelligence: how Trainee turns any ask into a method (2026-10-27)

Owner of this document: the architect. The owner asked for an "intelligence": when someone asks for any task, Trainee
works out how to do it from what it can do, asks once for what is missing, plans the steps, gets approval for every
external effect, does the work, checks it happened, says truthfully what happened, and keeps going over time.

This spec defines that layer: the capability contract, the plan model, the loop, the migration from today's code, the
quality bar, and an inventory of today's capabilities against the contract.

Sources: the connectors audit's root causes (`research-2026-10-26/connectors-audit.md` Part 2, branch
`docs/handoff-20261026`), the capability map (same folder), WO-100 (task awareness: `career_situation.ts`,
`career_capabilities.ts`), the launch audit (B6, Q1-Q3, R1), D-007, D-024, D-030, the strict standard, the product
directive, and the networking and mass-apply specs written with this one.

Nothing here changes code. It is the target the next work orders build toward, behind a flag.

## 1. Why: the root causes it replaces

The connectors audit traced the product's inconsistency to structure, not to individual bugs:

| Root cause (audit) | Evidence (audit, trunk `fe8405586`) | What this spec puts in its place |
|---|---|---|
| RC1: several brains, each claiming text with its own regex | 17 code-first turns before the router; a 15,256-line regex router with 120 intents and 2,098 regex literals; 4 post-router rewriters; the same need reaches different engines by phrasing | one understanding step (a model with a strict schema) that picks capabilities from one registry (§2, §5) |
| RC2: no single owner per concept | **8 apply paths**; ≥10 approval grammars; 5+ status readers; 12 fact stores; 6 outboxes | one contract per capability; one approval grammar; one plan and one read model; effects only through registered capabilities |
| RC3: state per thread | the profile lost in a new thread; three status readers disagree; 1,615 thread snapshots live and 0 `career_events` | plans and facts per person, resumable on any channel (§3) |
| RC4: hand-written prose claiming unchecked state | about 5,560 prose literals; "I've handed this batch to the browser worker" 31 times while no executor ran | replies rendered from verified results; a claim check (§4.7) |
| RC7: tests assert text | ≈2.3 reply-text asserts for every state assert | acceptance by state through `handleChat` on real Postgres (§6) |

The launch audit adds: the live brain is the regex router at 60.5% on the 38-item set (B6), and two texts sent close
together lose one (R1). WO-100 showed that with a per-person situation built by code every turn, the agent brain knew
what to do in 15 of 15 task conversations (43 of 43 facts), against the router's 0 of 15.

## 2. The capability contract

Every action Trainee can take is a capability with this contract. A capability that is not registered cannot be planned,
and no code outside a capability may cause an external effect.

```ts
interface Capability {
  name: string;                       // stable id, e.g. "outreach.send", "apply.submit", "people.find_email"
  summary: string;                    // one plain sentence the planner and the person can read
  inputs: JSONSchema;                 // typed inputs; the planner fills them from facts, the plan, or the person's words
  requires: {
    facts: FactKey[];                 // confirmed facts it needs (D-007): e.g. "resume.confirmed", "signature"
    connectors: ConnectorNeed[];      // e.g. { provider: "google_career", scopes: ["gmail.send"] } or one of several
    keys: KeyNeed[];                  // owner-held keys, e.g. { name: "PEOPLE_PROVIDER_KEY" } → NOT_WIRED when absent
  };
  ladder: FallbackStep[];             // what to do when a requirement is absent (the connectors research ladder)
  effect: "none" | "internal" | "external";  // external = anything leaving Trainee (send, submit, invite, message)
  approval: "none" | "confirm_fact" | "exact_payload_batch";
  // exact_payload_batch: the payload is shown whole; one yes approves the shown batch, each item bound to
  // sha256 of its canonical payload; subsets by the one grammar; ambiguous approves nothing (D-MS-1, D-MN-2)
  payloadOf?: (inputs) => CanonicalPayload;  // what is hashed and shown, for external effects
  run: (inputs, ctx) => Promise<Result>;     // the execution; idempotent by (person, capability, idempotency key)
  outputs: JSONSchema;                // the typed result the renderer turns into words
  verify: VerificationQuery;          // a read of state (DB rows, provider read-back) that proves the outcome
  failures: FailureMode[];            // named failure kinds with: retryable?, who acts (person | trainee | outside),
                                      // the plain sentence, and the next step
  pacing: "outside_refusal_only";     // NO LIMITS: no Trainee volume number; back off on an outside system's refusal
  channels: ChannelSupport;           // what works on web, Telegram, SMS/iMessage, WhatsApp, and what is said where not
  owner_rules: Rule[];                // e.g. never LinkedIn/Indeed; no captcha solving; resume required; opt-out honored
}
```

Rules on the contract:
- **External effects** have `approval = exact_payload_batch` and a `payloadOf`. The executor re-verifies the hash at
  claim; a changed payload is refused, not sent.
- **`verify` is required.** A capability whose outcome cannot be read back is not done. "Sent" needs a provider message
  id; "submitted" needs the engine's record; "confirmed" needs the employer's own answer (D-024).
- **`requires` is checked before planning, not discovered by failing.** Missing facts and connectors become one ask
  (§4.3).
- **Keys** are referenced by name only. A missing key makes the capability `not_wired`, and the renderer says so. A
  capability never pretends a connector exists.
- **Pacing** is never a product number (NO LIMITS). A `failures` entry with `who = outside` and `retryable` carries the
  back-off the outside system asked for.
- **Owner rules** are code checks inside `run` and the executor, tested by mutation; the planner cannot route around
  them.

## 3. The plan model

A plan is how a multi-step ask survives across messages, channels and days.

```ts
interface Plan {
  id: uuid; user_id: uuid;            // per person, never per thread
  goal: string;                       // the person's words, normalized ("email 100 PMs at fintechs about internships")
  status: "drafting" | "waiting_on_person" | "waiting_on_outside" | "running" | "done" | "stopped" | "failed";
  steps: Step[];                      // ordered; a step may fan out into many items (a batch)
  asked: Ask[];                       // what was asked of the person, when, on which channel, and the answer
  created_at, updated_at, channel_origin, last_channel;
  revision: int;                      // optimistic concurrency; two turns never both advance one plan
}
interface Step {
  id: uuid; plan_id: uuid; capability: string; inputs: json;
  depends_on: uuid[];
  status: "pending" | "blocked" | "awaiting_approval" | "approved" | "queued" | "running" | "done" | "failed"
        | "needs_person" | "skipped";
  blocker?: { what: string; who: "person" | "trainee" | "outside"; how: string };   // WO-100's vocabulary
  items?: { total: int; by_status: Record<string, int> };   // for batch steps; item rows live in the capability's table
  approval?: { card_id: uuid; shown_hashes: string[]; approved_hashes: string[]; answered_at };
  result_ref?: json;                  // ids of rows the capability wrote (never a copy of them)
  verified_at?: timestamptz; verify_result?: json;
  next_check_at?: timestamptz;        // follow-through over time (a follow-up, a reply check, a retry after back-off)
}
```

- **Tables.** `career_plans`, `career_plan_steps` (account-scoped, RLS by `user_id`, indexed on `(user_id, status)` and
  `next_check_at` where not null). Item-level rows stay in each capability's own table (`career_apply_jobs`,
  `career_outreach_drafts`, …); the step holds counts and ids, so a plan read is bounded whatever the batch size.
- **Resumable.** Any turn on any channel reads the person's open plans (bounded: open plans plus the newest few done).
  "keep going", "did it work", "what's left" resolve against them.
- **Concurrency.** A turn advances a plan only with the revision it read (the `career_host_commit` pattern); a second
  turn that loses the race re-reads and retries once (audit R1's fix), so a burst of texts never loses one.
- **Background.** A scheduler wakes steps whose `next_check_at` has passed (follow-ups, reply reads, back-off
  resumption) with leases and `SKIP LOCKED`, partitioned by person.
- **Erase.** Plans and steps are part of the person's erase transaction.

## 4. The loop

Every turn and every wake runs the same steps. The model decides; code enforces.

1. **Understand.** One model call with a strict schema returns: the goal, the referents resolved against the person's
   situation and open plans ("them", "the second one", "the Stripe people"), whether it continues an open plan, and
   the candidate capabilities. Third-party text (postings, emails, pages) is data, never instructions.
2. **Pick capabilities.** From the registry only. Compound asks become several steps ("find data internships and tell
   me my tracker" is two steps; the audit found the second one dropped).
3. **Find what's missing; ask once.** For the chosen steps, code evaluates `requires` against the person's record:
   missing facts, connectors and keys. It asks for all of what the next runnable step needs in one message, in the
   order a real product would (the resume before anything that applies; the signature before the first email draft;
   a mailbox before the first send). An answered ask is never asked again (the plan records it). Missing owner keys
   are not asked of the person: the reply says that part isn't available yet.
4. **Plan.** Persist the plan and its steps with dependencies. Steps that need nothing run now; others wait with a
   named blocker.
5. **Gate external effects.** Every external step produces a batch card: each item's exact payload, numbered, with its
   hash. One answer in the one grammar approves exactly what it states. Nothing external runs without it.
6. **Execute.** Internal steps run in the turn when they are fast; anything long or external is enqueued and claimed
   by workers. Idempotent by key; outside refusals back off.
7. **Verify.** After each step, run its `verify` query. The step is `done` only when the query shows the outcome. A
   claimed-but-unverifiable outcome is `unknown` and is reconciled, never retried blind.
8. **Report truthfully.** The renderer writes the reply from verified results only. A claim check rejects any sentence
   that asserts a state no result field supports (generalizing D-024 and the brain's unbacked-claim guard). No internal
   codes reach the person.
9. **Follow through.** Steps with `next_check_at` wake later. Proactive messages carry their reason and respect quiet
   hours and the person's channel. "What's happened" reads the plan.
10. **Recover.** A failed step names its failure kind, who must act and how. A retryable outside refusal waits and
    resumes. A person-side blocker becomes the next ask. A code fault stops the step, tells the person plainly, and
    leaves the rest of the plan intact.

## 5. Replacing today's structure, incrementally, behind a flag

The switch is per person and reversible: `CAREER_PLANNER=on` (default off), plus an allow-list for the owner's test
accounts first. The router stays live until the bar in §6 is met (D-008, D-030).

| Phase | What moves | What is deleted when it lands |
|---|---|---|
| P0 | The registry file and contract types; registering today's read-only capabilities (situation, status, search, profile read) with `verify` queries. No behavior change. | nothing |
| P1 | Plans and steps tables; the understanding call (staged brain's metered gateway) producing capability picks; with the flag on, read-only asks route through the registry; everything else falls through to today's handler. | nothing yet; measured on the sealed set |
| P2 | The one approval grammar and batch card as a shared capability (`approval.batch`), adopted first by mass apply (lane B's grammar) and outreach (N2). | the per-feature grammars as each adopts it (audit lists ≥10) |
| P3 | External capabilities move: `apply.*` on the one path (the 8 apply paths converge on `career_apply_jobs`; the 155 stack and its task bridge are deleted, as D-014 already rules), `outreach.*`, `calendar.*`, `connect.*`. | the code-first FEATURE blocks those capabilities replace; the router intents they cover |
| P4 | One renderer with the claim check over typed results. | per-module reply prose, a module at a time |
| P5 | Person-scoped memory only: thread state keeps dialogue frames; facts, plans, contacts and applications live on the person. | per-thread profile and tracker stores (the audit's 12 fact stores converge) |
| P6 | The flag becomes the default when §6's bar is met on the live build. | the regex router (`142-career-router.js`) and the cascade |

Each phase is one or a few work orders with acceptance tests written first, fail-first shown, and an eval run.
No phase adds a ninth apply path, a new outbox or a new approval grammar.

## 6. Quality bar

- **D-030, owner, final.** 95% or higher on the sealed held-out set, in one full pass, on the build that is actually
  live; two independent judges (gpt-5-mini in CI and Instinct); an item passes only when both pass it; the ratchet (no
  merge lowers the held-out score). The sealed set is PR #198's (162 items) once the owner confirms it; the 38-item set
  is too small and has been seen by its builder (audit B6).
- **Task completion, judged by state.** In addition to answer quality: the Instinct beta of about 1,000 brand-new users
  (product directive) is scored on whether each task's state is reached (rows, outbox, provider calls with exact
  params), not on reply text. The networking and mass-apply specs list the state each scenario must reach (NET-*,
  APL-*).
- **No model spend now.** Eval runs and live drafting wait for the owner's fresh key and budget.

## 7. Inventory: today's capabilities against the contract

Status: **built** = the capability exists on trunk (or the named PR) and meets most of the contract; **partial** = code
exists but contract parts are missing (named); **missing** = no code. Capability-map ids and states are from
2026-10-26; "contract gaps" are the architect's reading against §2. "Approval" is the contract kind it needs.

| Contract name | Map id (state) | Effect / approval | Requires | Verify query | Status | Contract gaps |
|---|---|---|---|---|---|---|
| `profile.ingest_resume` | ON-02 (MISSING), ON-03 (PARTIAL) | internal / confirm_fact | none | `fact_confirmed` events with upload hash | partial | files not read on channels (#201, #194, #215 open); paste capped at 4,000 chars on web |
| `profile.confirm_fact` | PM-01, PM-02 (BUILT) | internal / confirm_fact | — | event per fact | built | name/email/phone in chat not captured as facts (map) |
| `profile.correct_fact` | PM-03 (BUILT) | internal / none | — | fact replaced; dependent approvals stale | built | — |
| `profile.read` ("what do you know") | PM-01 (BUILT) | none | — | read | built | account-wide only with `CAREER_ACCOUNT_MEMORY` (PM-04) |
| `memory.standing_instruction` | PM-05 (PARTIAL) | internal / none | — | applied as filter | partial | kept and listed, not applied as filters to search/alerts |
| `memory.forget` | PM-06 (BUILT) | internal / confirm (erase) | — | rows gone | partial | erase misses application records (audit) |
| `situation.read` | WO-100 (`career_situation.ts`) | none | — | — | built | not yet the planner's input; no plan rows |
| `capabilities.read` | WO-100 (`career_capabilities.ts`) | none | — | — | partial | no Outlook, calendar or provider entries |
| `jobs.search` | DI-06 (BUILT) | none | — | — | built | two data sources (KB snapshot vs `career_postings`); ingest not deployed |
| `jobs.watch` | DI-07 (LIVE) | internal / none | — | `career_alert_prefs` row | built | delivery not deployed (PR-01) |
| `fit.score` | FT-01..03 (BUILT) | none | confirmed facts | — | built | — |
| `materials.tailor_resume` | AM-01 (LIVE), AM-02 (BUILT) | internal / none | resume | audit trace | built | — |
| `materials.cover_letter` | AM-04 (PARTIAL) | internal / none | resume | trace | partial | full letters only on the extension card |
| `apply.queue` | AP-27 (BUILT) | internal / none | resume | `career_apply_wanted` rows | built | "all remote ones" filter (lane B) |
| `apply.prepare` | AP-26 (BUILT), audit B2 | internal / none | resume; preparation host | `career_apply_prepared` with hash | partial | no host for phone-only people (lane C, owner VM) |
| `apply.questions` | AP-16, PM-07 (BUILT) | internal / confirm_fact | — | answer rows | built | — |
| `approval.batch` | AP-21 (BUILT) | — / exact_payload_batch | — | card answered; jobs with hashes | partial | text yes refused until lane B (D-MS-1); ≥10 grammars across features |
| `apply.submit` | AP-22 (BUILT), AP-01..03 | external / exact_payload_batch | resume; executor | receipt + engine record | partial | 8 paths; caps until lanes A/C; cloud not deployed |
| `apply.confirm` | AP-23 (BUILT) | none | Gmail read | receipt confirmation | built | mail tracking off by default |
| `apply.dedupe` | AP-24 (BUILT) | — | — | ledger refusal | partial | company 30-day rule until lane A (D-MS-3) |
| `apply.by_email` | AP-28 (BUILT) | external / exact_payload_batch | Gmail send | provider message id | partial | behind `CAREER_EMAIL_SEND`; owner to confirm (APL-12) |
| `apply.portals_gated` | AP-04..13 | external | person signs in (D-013(b)) | — | missing/partial | Workday partial; iCIMS, Taleo, SuccessFactors, Oracle, Jobvite, BambooHR, long tail missing |
| `status.applications` | TR-01, TR-02 (BUILT) | none | — | — | partial | 5+ readers disagree (RC2/RC3) |
| `receipts.read` | TR-03 (BUILT) | none | — | — | built | cloud runner keeps hashes, not pictures |
| `connect.gmail` | EM-01 (BUILT), CO-01 (PARTIAL) | internal / none (consent on Google) | Google client | `user_oauth_connections` row | partial | connect-from-any-channel in #191 (open); scopes conflict with #196 |
| `connect.outlook` | EM-02 (MISSING) | internal | Microsoft app | connection row | missing | M4 lane |
| `connect.disconnect` | CO-03 (PARTIAL) | internal | — | row and vault gone; pending sends stopped | partial | Google revoke in #191/#196; pending-send stop is new (NET-12) |
| `mail.read_job_mail` | EM-03..10 (BUILT) | none | Gmail read | `career_mail_events` | built | `CAREER_MAIL_TRACKING` off; connecting doesn't trigger a first read |
| `people.import` | NW-01 (PARTIAL), ON-04 (PARTIAL) | internal | — | `career_people` rows | partial | account store in #222 (open) |
| `people.paths` | NW-02 (BUILT) | none | contacts | — | partial | #222 `pathTo`; contacts not joined to postings |
| `people.find_email` | NW-04 (PARTIAL), NW-03 (MISSING) | internal (paid lookup) | provider key | lookup rows | missing | finder missing; verification NOT_WIRED without key (M2) |
| `outreach.draft` | NW-05 (BUILT) | internal / none | confirmed facts; signature | draft rows with trace | partial | trace per claim not stored; batch max 10 (NO LIMITS) |
| `outreach.send` | NW-07 (BUILT) | external / exact_payload_batch | Gmail send | provider message id | partial | caps/warm-up/spacing (NO LIMITS removes); Outlook rail missing; text-yes grammar per D-MN-2 |
| `outreach.replies` | NW-07 (BUILT) | none | Gmail read | reply rows | partial | `classifyReply` has bounce/stop/reply/other only; needs interested/wants_call/not_interested/out_of_office (M5) |
| `outreach.followup` | TR-04 (BUILT), #214 | external / exact_payload_batch | Gmail send | provider message id | partial | #214 reminds; sending follow-ups waits on M1 |
| `intro.request` | NW-06 (PARTIAL) | external / exact_payload_batch | contacts; Gmail send | `career_intro_requests` | partial | #222 drafts and tracks; send through M1 |
| `calendar.free_busy` | EM-12 (PARTIAL) | none | calendar scope | — | missing | scopes requested, no Calendar API call anywhere (M5) |
| `calendar.invite` | EM-05, EM-12 (PARTIAL) | external / exact_payload_batch | calendar scope | event id | missing | M5 |
| `mail.reply_to_recruiter` | EM-11 (PARTIAL) | external / exact_payload_batch | Gmail send | message id | partial | no drafting of replies to a recruiter's own email |
| `prep.mock` | IP-02 (BUILT) | none | — | `mock_done` events | built | two mock engines (RC2) |
| `prep.brief` | IP-01 (PARTIAL) | none | — | — | partial | 38 curated companies; nothing fetched |
| `prep.thank_you` | IP-08 (BUILT) | external / exact_payload_batch | Gmail send | message id | partial | send behind `CAREER_EMAIL_SEND` |
| `offer.capture`, `offer.benchmark` | OF-01, OF-02 (BUILT) | none | — | — | built | — |
| `offer.counter_send` | OF-04 (PARTIAL) | external / exact_payload_batch | Gmail send | message id | missing | "There is no send path" (map) |
| `alerts.deliver` | PR-01..05 (BUILT) | external (to the person only) | channel | outbox row delivered | partial | `career-proactive`, `trainee-deliver` not deployed |
| `channel.link` | CH-09 (BUILT) | internal | — | `channel_contacts` | partial | D-023 pending |
| `erase.everything` | TS-05 (PARTIAL) | internal / confirm | — | 0 rows in every table | partial | application records missed (audit) |

Count: 47 rows; built 15, partial 26, missing 6 (the gated-portals row counts once, as missing). The counts are of this
table, by the architect's reading; they are not a measured score.

## 8. Acceptance for the layer itself

- **TI-S1 (resumable).** A plan started on Telegram ("email 50 PMs about internships"), blocked on "connect Gmail", is
  resumed from SMS after the connect ("ok done") without re-asking anything; the plan's `asked` shows one ask.
- **TI-S2 (ask once).** A person who gave the signature in plan A is not asked again in plan B.
- **TI-S3 (compound).** "find data internships in chicago and tell me what my tracker looks like" → two steps, both done.
- **TI-S4 (gate).** No capability with `effect = external` runs without an approved card whose hashes match: a mutation
  that skips the check turns a test red.
- **TI-S5 (verify).** A send whose provider call succeeded but whose record write failed is `unknown`, reconciled from
  the provider, and never sent twice.
- **TI-S6 (truthful).** The claim check rejects a rendered "sent" for a step without a message id.
- **TI-S7 (burst).** Two texts within 100 ms on one plan → both handled; plan revision advanced twice; nothing lost.
- **TI-S8 (registry boundary).** An import-boundary test: nothing outside the registered capabilities calls Gmail send,
  Graph sendMail, calendar insert, or the apply engine's submit.
- **TI-S9 (bar).** D-030 on the sealed set with both judges, measured on the build under test, before P6.
