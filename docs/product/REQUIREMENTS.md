> **SUPERSEDED (2026-10-28):** the current inventory of features, depth and status is `docs/architect/FEATURES.md`. Kept for history; do not use as current.

# Upmore careers: the requirements and where each one stands

Owner, 2026-10-19: the whole product follows one path: **understand you, find suitable opportunities, prepare your
application, get approval, apply, track what happens, help you win the interview.** These 15 areas are requirements,
not claims. This page holds each one against the code, strictly, so the build order follows the truth.

Audited 2026-10-19 against `origin/trunk` (unmerged `wo/*` branches noted) by three read-only audits; every row names
its files and tests. Status:
- **LIVE**: ran for a real user in production, with a recorded receipt.
- **BUILT**: code on trunk, reachable from the chat or a function, and a test that exercises it.
- **MODULE**: code and a test, but nothing in chat calls it (or only on an unmerged branch).
- **PARTIAL**: part of the requirement; the row says which part is missing.
- **NONE**: nothing.

**Tally: 78 sub-requirements. LIVE 0, BUILT 25, MODULE 2, PARTIAL 49, NONE 2.**

## What the tally hides (read this first)
1. **No requirement is LIVE.** Nothing has run end to end for a real person, and no application has been submitted.
2. **The live chat cannot see real jobs.** The default brain (the keyword router, D-008) is handed `postings: []` in
   `agent-chat/handler-career.ts`. The 2,179 ingested boards reach chat only through the model brain behind
   `CAREER_BRAIN=agent`, and that brain has no tailor, cover-letter or apply tool. Many BUILT rows are built on the router,
   so they work on an empty pool in production.
3. **Chat cannot take a resume in** (images are ignored, no ingest route) and **never hands a tailored file back.**
4. **Two apply stacks disagree.** Modules 149/150/155 (15 per day, one at a time, batch approval only through a
   structured API field a text never sends) and `career_apply.ts` + `scripts/apply.ts` + the queue on `wo/009b-*`
   (25 per day, concurrent). The owner's rule is 15 per day. D-014 below makes it one.
5. **A texted "yes" cannot approve a batch today**, an alert cannot turn into an application (10d), and over-cap
   applications never resume although the summary says they will (7g).

## 1. Your career profile and memory

| id | requirement | status | evidence |
|---|---|---|---|
| 1a | read resume; collect exp/edu/skills/goals | PARTIAL | chat saves typed facts (agent add_profile_fact, wo-002-career-tools; router captureStatedFacts, career-depth-memory); resume parsing only as module D/122 ingestResume (career-profile.test.cjs), no chat route; handler-career.ts ignores images |
| 1b | work auth, location, salary, availability, roles | PARTIAL | location wired; sponsorship correction (142); 130 interview stores answers only when ctx.interviewAnswer is set, which the host never sets; salary/availability only as agent free-text facts |
| 1c | confirmed vs suggestions vs open questions | PARTIAL | agent splits confirmed/draft facts (wo-002 T2/T8); router stated facts carry no confirmation state; no store of suggestions or open questions |
| 1d | corrections, latest resume, no re-ask | PARTIAL | corrections persist across threads (migration 20261016120000; career-lf08-stated-fact-parity); "use the new resume" works only on fixture text, in-process store; ask-once recall 130 answerFromProfile |
| 1e | see/change/export/delete | PARTIAL | see: 130 profileExport; delete: host erase; no downloadable export; the agent has no tool to edit or delete a fact |

## 2. Job discovery

| id | requirement | status | evidence |
|---|---|---|---|
| 2a | openings across boards | BUILT | career-ingest + career_ingest.ts (2,179 boards) -> search_jobs (wo-006-ingest, edge/career-ingest); reachable only with CAREER_BRAIN=agent |
| 2b | filter role/location/level/pay/arrangement | PARTIAL | keyword match only (career_search.ts); no pay data; seniority and remote stored but not filtered |
| 2c | drop duplicate/expired/suspicious | PARTIAL | expired close on a full re-read; duplicates only by ATS id; cross-board dedupe (121) and scam checks (142) run only on the router's empty pool |
| 2d | source, deadline, last-checked | PARTIAL | url/provider/board, first_seen_at, last_seen_at stored; no deadline column |
| 2e | keep watching | BUILT | set_job_alerts -> career-proactive every 5 min (wo-007-alerts, edge/career-alerts, edge/career-proactive); matching by title keywords + place, not profile fit |

## 3. Job matching and career direction

| id | requirement | status | evidence |
|---|---|---|---|
| 3a | explain fit and why | BUILT | search_jobs returns fit reasons and gaps (career-ingest B11/B12); router role hypotheses 154 |
| 3b | realistic/stretch/ineligible | PARTIAL | knockouts rank last with reason (B11); Reach/Match/Safety only tested in 121 |
| 3c | missing skills + projects | BUILT | 154 skillGapPlan via router (capability2-bundle, capability2-grounding) |
| 3d | correct recommendations, exclude companies/types | MODULE | 121 excluded_companies + recordFeedback (career-jobs DISC-006); no chat route writes exclusions; search and alerts ignore them |
| 3e | score is never a hire chance | PARTIAL | router guards (144 oddsRefusal, career-gauntlet-g1); agent path passes a raw fit score with no guard and prompt.ts says "Tell them their real odds" |

## 4. Resume editing and tailoring

| id | requirement | status | evidence |
|---|---|---|---|
| 4a | master + per-role version | PARTIAL | router tailor saves a per-job artifact (142 -> 123; career-router-wedge); the "master" is the fact bank, not a resume document; versionId from an in-process counter |
| 4b | select and rewrite from facts only | PARTIAL | selectFacts + truth-audit hard gate (career-tailor); bullets copied verbatim except one family's template |
| 4c | JD language without inventing | PARTIAL | JD skills only when evidenced; bullets not rephrased toward the posting |
| 4d | formatting/dates/contact/extraction | PARTIAL | 148 renders PDF/DOCX with a parse check (career-render); phone never rendered (148:47); original formatting replaced; files not returned in chat |
| 4e | show diff, approve/undo | PARTIAL | 123 diffResume tested as a module only; router passes no base resume; no approve/undo |
| 4f | exact version per application | PARTIAL | 141 binds resume_sha256 on replica forms; persisted queue + resume-sha check only on wo/009b-* branches |

## 5. Application answers and cover letters

| id | requirement | status | evidence |
|---|---|---|---|
| 5a | company-specific letters/answers | PARTIAL | 123 needs company records (37); router cover-letter route passes {} so it always refuses; only the 133 packet route attaches a letter |
| 5b | respect limits and the question | PARTIAL | fixed limits only (letters 150-250 words, resume one page); a form question's own limit is never read |
| 5c | claims from experience | BUILT | fact-cited letters and essay outlines + banned-phrase check (career-essay-tailor, career-tailor) |
| 5d | reuse only same-meaning answers | PARTIAL | regex category or exact label (career_apply.ts; wo-009-plan); not wired to chat; meaning-based reuse is WO-020 |
| 5e | ask instead of guessing | PARTIAL | 141 turns unknown/consent fields into questions on replica forms only; batch ask-once list not wired; real forms need the worker, NOT_WIRED in the edge function |

## 6. Application review and approval

| id | requirement | status | evidence |
|---|---|---|---|
| 6a | show employer/role/destination/answers/docs | PARTIAL | batch card (155 prepareRun -> 132 batchCard) shows company, role, fit only (speakSummary claims "the exact answers"); payload/destination/resume hash only in the single-task worker review (local portals only) |
| 6b | one approval for exact batch | BUILT | 155 approveRun (cardSha256 + approvalRef) via handler-career.ts -> career_task_bridge; career-batch-delegation, career-loop-acceptance (structured career_batch field only; texting never sends it) |
| 6c | re-review on change | BUILT | 155 APPROVAL_SET_CHANGED, 149 APPROVAL_PAYLOAD_MISMATCH, worker REVIEW_CHANGED_REAPPROVAL_REQUIRED |
| 6d | remove job / change answer / cancel | PARTIAL | only account-wide STOP/pause cancels queued intents; no per-job remove or answer edit |
| 6e | ready/blocked/awaiting counts | PARTIAL | 155 summarizeRun ready count + per-item stops; no awaiting-input count |

## 7. Mass applying

| id | requirement | status | evidence |
|---|---|---|---|
| 7a | "apply to suitable..." -> queue | PARTIAL | 155 parseApplyAsk requires a number; production discovery is operator config not in the repo; agent brain has no apply tool |
| 7b | concurrency + per-user/employer limits | PARTIAL | trunk: limits only (149 SPEC_CAPS), 155 runs one at a time; concurrency only in pull.cjs on wo/009b-5 |
| 7c | layouts/uploads/dropdowns/multi-page | BUILT | 150 bindings + 149 multi-round; career-portal-browser, career-owned-worker-browser, career-portal-lever-radio (skip without Playwright) |
| 7d | readback + right resume | BUILT | 149 ANSWER_OBSERVATION_MISMATCH, 150 RESUME_SHA_MISMATCH; post-fill resume check only in apply.ts (branch) |
| 7e | stop only affected app | BUILT | 155 per-app UNCOVERED_QUESTION; career-loop-acceptance |
| 7f | never submit twice | BUILT | 149 ALREADY_SUBMITTED/RECONCILE_REQUIRED, executor claims once, worker write-ahead fence, turn_key replay |
| 7g | queue over time, 15/day | PARTIAL | 149:71 SPEC_CAPS perDay 15 (career-portal-caps); over-cap items get resumeOn but nothing reads it (never resume; speakSummary claims they do); career_apply.ts DEFAULT_DAILY 25 / max 50, branch SQL p_daily 25, D-011 says 25 |
| 7h | submitted only on employer confirm | BUILT | 149 completes only on accepted + confirmationId; career-portal-browser, career-portal-submit-integrity |

## 8. Browser help and recovery

| id | requirement | status | evidence |
|---|---|---|---|
| 8a | same session for login/CAPTCHA | NONE | CAPTCHA_HANDOFF hands the posting URL; sessions expire after 10 min idle; login portals pending (D-013) |
| 8b | handoff then continue | PARTIAL | single-use handoff ticket (career-captcha-seam) but no drive resumes from the saved point |
| 8c | recover timeouts/changed pages/crashes | PARTIAL | safe stops only (DRIVER_TIMEOUT, SESSION_EXPIRED, payload change, crash -> uncertain); no recovery |
| 8d | unknown -> investigate before retry | PARTIAL | 149 unknown_outcome/reconcile; resolveUnknownOutcomes has no caller; batch path never investigates |
| 8e | name unsupported sites | BUILT | 149 UNTESTED_ATS_HOST/AGGREGATOR_APPLY_FORBIDDEN, FAMILY_NOT_DRIVEABLE |

## 9. Application tracking and receipts

| id | requirement | status | evidence |
|---|---|---|---|
| 9a | one record per role with states | PARTIAL | 126 tracker Saved/Submitted/Interview/Rejected; preparing/needs-input/approved in separate records |
| 9b | store confirmation/time/docs privately | PARTIAL | confirmation id/text/screenshot/time in 149 + career_batch_runs_v1; documents only as sha256; career_apply_jobs on branch only |
| 9c | match inbox responses | MODULE | 126 ingestMessage, 132 parseInboxConfirmations; no inbox reader wired |
| 9d | what changed + next step | BUILT | 142 tracking-event route; career-track-events, career-next-step-routing |
| 9e | never confuse filled/saved/sent with submitted | BUILT | 149 doorstep vs completed; career-portal-submit-integrity, career-doorstep-safety-regression |

## 10. Job alerts and reminders

| id | requirement | status | evidence |
|---|---|---|---|
| 10a | suitable new roles | PARTIAL | deployed alerts match title keywords + location only; profile-fit gating (151) only in a host script marked no deploy |
| 10b | why + closing date | PARTIAL | fit lines + deadline only in the host script; deployed alert text has neither |
| 10c | no repeats, drop closed | BUILT | outbox key alert:<job_id>; closed_at filtered; edge/career-alerts, career-proactive |
| 10d | alert -> prepare/approve | NONE | alerts carry only "Apply: <url>"; the batch ask starts from scratch |
| 10e | quiet hours/frequency/delivery | BUILT | career_alerts.ts quiet 22-07, max_instant_per_day, report_hour; outbox delivered_at |

## 11. Networking

| id | requirement | status | evidence |
|---|---|---|---|
| 11a | Find employees/alumni/recruiters/HMs from permitted sources | PARTIAL | 135-career-graph.js mergeIdentities/rankPaths/publicSourceLookup and 124 buildList only rank and dedupe contact lists the person supplies; nothing fetches contacts from any source, and nothing over text fills ctx.contacts (only a LinkedIn CSV parse in 122); career-graph.test.cjs, career-referrals-completion.test.cjs |
| 11b | Explain relevance + where contact came from | BUILT | 135 rankPaths why/via, source_list, publicSourceLookup; 124 email_source; router handleGraph*; career-referrals-completion.test.cjs, career-graph.test.cjs (works only on supplied records) |
| 11c | Verified vs guessed addresses | BUILT | 124 normVerification, honestYield verified vs pattern-inferred, riskyMaxFraction; career-outreach.test.cjs, career-spec1-gates.test.cjs; the DNS verifier needs an injected lookup, and none is injected in prod |
| 11d | Personal outreach from experience + contact's work | PARTIAL | 124 draftFor uses sourced personalization_facts + user.experience, but router handleOutreach passes personalization_facts [] and user {name}; 141 outreachUserOf reads ctx.experience, not profile facts |
| 11e | Track replies, follow-ups, sending disabled | BUILT | 124 classifyReply/runFollowUps, 135 next_touch_at, router handleReply*/handleFollowUp*; career-send-disabled.test.cjs, career-outreach-w03.test.cjs; replies only when pasted, no inbox reader wired |

## 12. Interview preparation

| id | requirement | status | evidence |
|---|---|---|---|
| 12a | Practice on actual role/company/submitted resume | PARTIAL | 127 questionBank + CIR records (~45 companies) + JD keywords + stories from facts; not tied to the submitted resume version or the tracked application |
| 12b | Technical/behavioral/career Qs + follow-ups | PARTIAL | interview-banks/*.md, 127 drills; follow-ups are two keyword templates in router handlePrepAnswer |
| 12c | Check reasoning/substance | PARTIAL | 127 scoreAnswer is a regex STAR rubric; real substance checks only for 2 finance accounting items |
| 12d | Truthful stories, concise answers | BUILT | 127 buildStoryBank/failureStoryFromFacts/structureDrill/checkAnswerClaims; career-prep.test.cjs, career-prep-fin-a2.test.cjs |
| 12e | Remember weak areas, retest | PARTIAL | mockSummary fix_first, but the mock state is deleted on completion; no stored weak-area history, no measured retest |

## 13. Offers and negotiation

| id | requirement | status | evidence |
|---|---|---|---|
| 13a | Compare comp/responsibilities/location/priorities | PARTIAL | 128 compareOffers (comp only) is MODULE: the router never calls it; nothing compares responsibilities, location or priorities |
| 13b | Trade-offs + unclear details | PARTIAL | parseOffer.missing, totalComp assumptions; no trade-off reasoning |
| 13c | Negotiation talking points + drafts | BUILT | 128 counterStrategy/extensionDraft/declineDraft/roleplayTurn via router; career-negotiation.test.cjs |
| 13d | Acceptance under person's control | BUILT | 128 approvalCard sends:false; send disabled at the 124 sink; career-send-disabled.test.cjs |

## 14. A simple chat experience

| id | requirement | status | evidence |
|---|---|---|---|
| 14a | Incomplete requests, follow-ups, corrections | PARTIAL | Default router is keyword-based with typo repair; free-form understanding is only in the agent brain (flag off, no eval results) |
| 14b | Know current task, what it has, what blocks | PARTIAL | resultStatus + missing[] per handler; task status only in the career_task API field, which texting never sends |
| 14c | Smallest useful question, plain progress | BUILT | 140 ensureNextStep, router clarification; career-generic-closer-guard.test.cjs, career-next-step-routing.test.cjs |
| 14d | Pause/resume/cancel from chat | PARTIAL | career_host.js PAUSE/RESUME/ERASE (exact phrases only), channel STOP/START; no per-task cancel |
| 14e | Useful work or clear next action | BUILT | 140 ensureNextStep / generic-closer guard |

## 15. Reliability for many users

| id | requirement | status | evidence |
|---|---|---|---|
| 15a | Isolate facts/docs/sessions | PARTIAL | RLS + per-user RPCs; browser-session isolation only in the undeployed worker (portal_browser NOT_WIRED) |
| 15b | Durable queues, fair limits, retries, spend | PARTIAL | outbox + inbound claim, turn_key replay, 60 turns/hr, daily contacts; D-002 $1/user/month cap not enforced (only metered); apply queue only on an unmerged branch |
| 15c | Spikes without losing/mixing | PARTIAL | revision_conflict + turn_key idempotency; trainee-inbound runs the turn inline and a failed turn is never retried; no load test |
| 15d | Measure completion/errors/dupes/effort/speed/cost | PARTIAL | only cost per turn (agent brain); evals/career/results empty; no live metrics |
| 15e | Test deployed journey, keep evidence | PARTIAL | trainee-smoke.cjs + go-live test; no committed run receipts |

## Progress (crossed off only with evidence; newest state, 2026-10-19 19:45 UTC)
Labels: VERIFIED (what it ran against), ASSUMED, NOT_RUN. The standard is `docs/product/STANDARD.md`.

**P0: one real application**
- [x] Trunk green again: the ingest deadline used two clocks (red on every branch from 12:01 UTC). VERIFIED: PR #19,
  career-ingest 12/13 before, 13/13 after; merged 852ea88d.
- [ ] Planner precision on trunk (contact facts only in free-text boxes about the person). VERIFIED on 1,925 real
      questions, 4 tests red first; PR #20 in CI.
- [ ] Engine fixes (`wo/009b-4-engine`, not merged):
  - [x] the resume answer only goes into an upload; negated or combined sponsorship questions are asked; a Greenhouse
        paste box is the upload's alternative. VERIFIED: architect suite 78/78, each rule red first; ask-once rebuilt.
  - [x] a normal redirect after submit is an acknowledgement (303 to a thank-you page). VERIFIED: engine test, red first; PR #23
  - [x] a rejection before anything was sent is "not sent", never "unknown". VERIFIED: engine test; PR #23
  - [x] the employer's own hidden fields shown in the review and sent unchanged (real Lever forms carry 3-13 each). VERIFIED on a fixture with Lever's field shapes; PR #23
  - [~] a visible browser and a hand-off when a verification appears, resuming from the same page. VERIFIED on a fixture; a real captcha provider's requests are still blocked after the first fill (next commit)
  - [x] identity numbers refused; a "Yes" fact checks a consent box; `--state-dir` only for local fixtures. VERIFIED: engine tests; PR #23
  - [x] one daily cap of 15 everywhere, not raisable (owner, 2026-10-19). VERIFIED: architect, store and SQL tests; PR #23
- [ ] Module 150 precision and the active-challenge fix (Codex C-01). VERIFIED by the architect on Codex's branch:
      22/22 and portal 92/92; PR not yet open.
- [ ] The owner's 3 real applications per ATS, each confirmed by the employer's email. NOT_RUN.
- [ ] D-014: one apply stack. NOT_RUN.
- [ ] Chat sees real jobs (the default brain is handed `postings: []`). NOT_RUN.

**Stage 8 launch gates for mass applying (STANDARD section 6)**
- [ ] 1. Owner gate complete for the launch ATS set. NOT_RUN.
- [ ] 2. Readback-verified fill on all 17 captured forms in CI, captcha-detector defect fixed. The fix exists on
      Codex's branch, not merged.
- [ ] 3. Outcome states with confirmation-email proof. NOT_RUN (no inbox reader is wired).
- [~] 4. Cost model at 1,000 and 10,000 users with real vendor numbers: written (`cost-model-applying.md`), unit prices sourced, totals ASSUMED until real runs measure them.
- [ ] 5. Kill switch and rollback runbook, exercised once. NOT_RUN.
- [ ] 6. Metrics live with alert thresholds. NOT_RUN.

## Build order (the path, in order; the first unproven step is the work)

**P0: one real application, then many.** Owner of the work: the architect.
1. The submission engine (`scripts/apply.ts`) fixed and test-first (resume hash never typed as an answer; one fact
   never reused for a question that means something else; a normal redirect after submit is an acknowledgement; a
   rejection before anything was sent is "not sent", never "unknown"; the employer's own hidden fields shown and sent
   unchanged; a visible browser and a real hand-off when a verification appears; identity numbers refused; 15 per day).
2. The owner's 3 real applications per ATS from his own machine, each confirmed by the employer's email
   (`docs/architect/apply-trials.md`). Until then nothing applies for anyone else.
3. **D-014: one apply stack.** The planner `career_apply.ts` (with WO-020's meaning map), the queue `career_apply_jobs`
   at 15 per day, the shared browser helper. Modules 149/150/155 are retired as their tested parts move over (the
   caps, confirmation proof, batch card, per-item stops), never by deleting a test.
4. Chat sees real jobs: the router reads `career_postings` (or the model brain becomes the default once WO-019's
   conversation eval passes at 17 of 20).

**P1: approval and the loop over text.** A texted yes approves the exact listed batch (6b over text), the batch card
shows answers, destination and resume (6a), per-job remove and answer change (6d), an alert turns into a prepared
application (10d), over-cap items resume the next day (7g), resume in by text and the tailored file back (1a, 4d).

**P2: quality with evidence.** Tailoring (4b, 4c, 4e) and answers (5a, 5b, 5d) under the evidence standard below;
matching that respects exclusions (3d) and never shows a score as odds on any path (3e).

**P3: after the application.** Interview practice tied to the submitted resume with remembered weak areas (12a, 12e),
offer comparison wired (13a, 13b), networking contacts from permitted sources (11a, 11d).

## The evidence standard (owner, 2026-10-19)
Every product rule ships with its reason: either a source (a study, the ATS vendor's own documentation, a recruiter
survey) recorded in `docs/research/<area>.md` with its link and date, or a result measured on our own data (as the
question-coverage and classifier-precision numbers were). A rule with neither is a hypothesis and is labelled one.
Research comes first for tailoring (area 4) and answers (area 5), because they come next on the path. Numbers are
looked up with their source, never quoted from memory.

## Who does what
- **The architect (lead engineer):** P0 in full, the design and the hard engines of every later step, the research
  behind every rule, and the final verification. Every claim on this page is updated only from a test or a receipt.
- **Codex (second engineer):** bounded task cards in `docs/architect/cards/` with exact code and proofs; the standing
  review of every apply-path PR (C-02); test data at scale (synthetic resumes of every shape, labelled question sets
  from the captured forms, spot-checked by the architect); nightly eval runs in CI; mechanical ports and refactors;
  turning each row above into tests. Codex does not decide product rules or touch the submission engine.
