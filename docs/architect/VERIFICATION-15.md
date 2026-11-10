# Release verification ledger: the 15 items (owner list, 2026-11-09)

Every item starts unchecked. An item is checked only when all three kinds of evidence exist and are linked here:

- **A. Code proof:** the named tests pass in CI on the exact release commit (a run ID).
- **B. Measured proof:** a benchmark or eval over real inputs, with the number and its run ID. Where no benchmark exists yet,
  building one is part of the item.
- **C. Live proof:** a production transcript, database row or employer or mail record after the deploy, with time and ID.
  Synthetic and fixture runs never count as C.

A test that passes is not live proof. "Not verified" means no evidence exists yet. It does not mean the feature is missing.

Status key: **Not verified** (no A, B or C at the release commit), **Partial** (some of A, B or C), **Verified** (A, B and C).

---

| # | Item | Done when | Evidence today | Status | Next evidence step |
|---|---|---|---|---|---|
| 1 | Application layer | A job request becomes the exact application shown for review: target, resume, every answer from confirmed facts, nothing invented, one yes approves that payload hash. | A: R10 fixes 9 to 13 merged to trunk; trunk CI 23/23 at 1a69ec9f. Tests include `tests/architect/pending/r10-app-layer/r10-fix-12-review.test.ts` and `tests/architect/wo-107-standing.test.ts`. No B or C at a release commit. | Partial | Live: one real request through to the review card on production, with transcript and the stored payload hash. |
| 2 | 60 applications in one batch | 60 approved in one yes; each gets one outcome (confirmed, awaiting employer, uncertain, or held with a reason); zero duplicates, zero wrong answers, zero dropped. | A: `tests/architect/wo-042-sixty.test.ts`, `tests/architect/mass-submit-chat.test.ts`, `tests/db/career_apply_no_volume_ceiling.test.sql`, `tests/architect/wo-g-batch-closeout-pg.test.ts` (fixtures). B: the strict browser benchmark shows the runner completes 15 of 220 real postings, so 60 real submissions cannot succeed yet. | Not verified | Raise the strict pass rate first (item 4). Then a 60-posting dry-run batch on real postings, counting outcomes, duplicates and answers. Then a real batch only with the person's yes to each payload. |
| 3 | Resumes | Each delivered resume opens, can be copied and downloaded, matches the target, and invents no fact; checked in its delivered form (D.4 11). | A: resume tests in trunk CI (R9 resume fit and send, `tests/architect/r9-resume-fit-send-20261108.test.ts`). No B: no rendered-file benchmark. No C at R10. | Partial | Build a resume benchmark: N real profiles × target roles, each PDF and DOCX opened, text extracted and diffed against confirmed facts. Then a live delivery on Telegram. |
| 4 | Browser capability | The production runner completes supported postings to the instant before Submit, handles uploads, navigation and blockers, and hands back every shown check. | B: strict benchmark of the production runner on 220 real postings across 11 job sites (dry run, nothing sent). Run 42691170352: 14/220. Run 42696835430: 14/220. Run 42701998901: 15/220 (6.8%); 0 breaches each time. Run 42707036468 (with stop diagnostics) in progress. A: #668 runner tests pass locally; CI pending. | Not verified (15/220) | Fix by provider from the run 4 diagnostics; re-run the same 220; then a held-out 220. Public comparison: WebArena, Mind2Web, Online-Mind2Web and WebVoyager published scores, with method differences stated. |
| 5 | Networking and email | The right people are found from real sources, outreach is relevant with nothing invented, and only an approved exact message is sent. | A: outreach and contact tests in trunk CI. Contact connector approved (D-048), test mode first; CAREER_PEOPLE_SEARCH stays never-on. No B, no C. | Not verified | Owner: a test email address. Then a test-mode send to it, with the mail record as C. |
| 6 | File design and capability | Files open on a phone, follow C.1 and C.24, every link and action works, and there are no dead buttons. | A: `supabase/functions/_shared/file_family.ts` and its tests (#631). Serving every family and the chat card are not shipped (WO-E branches e4 to e8). | Not verified | Ship WO-E; a link-and-action crawler over every File family; live screenshots on a phone. |
| 7 | Bot responses | Every reply passes the rules in `docs/architect/specs/RESPONSE-RULES.md` (#667): answer first, context kept, specific blocker, honest progress. | A: `tests/edge/reply-rubric.test.ts` and the reply tests in trunk CI. B: brain eval S3 run 42636632019 passed at 1a69ec9f. The rubric sweep over every templated reply has not run (local disk full). No C at R10. | Partial | Rubric sweep in CI; the five Instinct continuations (B.6) replayed turn by turn; live Telegram transcript. |
| 8 | Job discovery | Current openings verified on the employer page, matched to the person, an honest count, and a scope given when the result is empty. | A: `tests/architect/r10-wo-c-search-replay.test.ts` (S1 and S2 through the real handler on Postgres). No B on live boards, no C at R10. | Partial | Live search replay after the deploy (the $1 guard); every link checked open. |
| 9 | Profile and memory | Facts only from what the person confirmed; reused answers marked; sensitive facts asked per application. | A: fact authority tests (`tests/db/career_thread_facts_authority.test.sql`, D-007 tests). No B, no C at R10. | Partial | A memory battery over multi-session transcripts; a live correction that is kept. |
| 10 | Company and role research | Sourced, dated, role-specific; interpretation labelled; nothing invented (E.5). | A: `tests/edge/research-reply.test.ts`, `tests/architect/research-reply-on-d047.test.ts`; CAREER_RESEARCH_REPLY on. No B, no C at R10. | Partial | A research benchmark over N companies with source checks; a live brief. |
| 11 | Interview preparation | Practice specific to the role, with feedback, tied to a real upcoming interview. | A: `tests/architect/f11-mock-interviews-handler.test.ts`. No B, no C. | Not verified | A practice-session eval; a live session. |
| 12 | Tracking and follow-through | Statuses read back from real state; replies tracked; one next action. | A: pipeline and status tests; `career_apply_status.ts` wording tests. No C at R10. | Not verified | A live status after a real submission, matched to the employer email. |
| 13 | Offers and negotiation | Correct comparison math, values labelled by source, no invented leverage. | A: `tests/architect/flow-offer-benchmark.test.ts`, `tests/architect/counter-offer-20261106.test.ts`. No C. | Not verified | Offer fixtures with hand-checked totals; a live comparison. |
| 14 | Accounts and channels | Sign-in, connections and delivery work on Telegram, WhatsApp and iMessage as intended. | A: channel and Telegram acceptance tests. The live R-4 check needs a Telegram test chat. | Not verified | Owner: Telegram test chat; then a live round trip on each channel that is switched on. |
| 15 | Release readiness | The work above is merged into the actual release, the journeys pass, and every gate (S1 to S4, Production approval) is cleared. | R10 merged to trunk 1a69ec9f (CI 23/23, S3 passed); release PR #665 is stale. Merged since: #658, #659, #667. Open: #666, #668. Not deployed. | Not verified | Finish 1 to 14 as far as code allows; re-cut; S3; owner ledger script; Production gate; post-deploy C for every item. |

## Owner items that block evidence

- A test email address for item 5.
- A Telegram test chat for items 7 and 14.
- The ledger script and the Production gate for item 15.
- Free the local disk (`/tmp/trainee-flow-pg-*`, about 11 GB) so the response sweep and the resume benchmark can run here.
