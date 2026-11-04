# Handoff: the application submission path (architect lane), 2026-10-27

This is the end-of-usage state, written as the owner asked (relay, 10:23 PM CDT). Each step is finished and verified
before the next one counts. "Pushed", "merged", "deployed" and "verified live" are four different facts, labelled
separately below. There are no secret values here, only the names of settings.

## Where the code is

| Branch | Head | Pushed | GitHub CI on that head | Merged to `trunk` | Merged to `main` | Deployed | Verified live |
|---|---|---|---|---|---|---|---|
| `arch/submit-path` | `fd606d9d` | yes | **RED** (`career-and-shared-tests-core`; attribution below) | up to `d671223c` only, through the third session's `arch/diagnosis-1240` (merge `f77487ef`). `352f7071`, `32d1aa0e`, `fd606d9d` (docs and test fixtures) are **not** on trunk | **no** | **no**: not by me, not known | **no** |
| `arch/submit-path-join-1255` (candidate, CI only) | `986bdf37` = `arch/submit-path` merged onto Muse's `02a40c29` | yes | running at the time of writing (runs `40449759778` and the one after it) | **no** | **no** | **no** | **no** |
| `arch/alerts-watch-bridge` (paused at ALERTS-PAUSE-1126) | `adcf6473` | yes | not re-checked | yes, through `arch/diagnosis-1240` (merge `a6497a80`) | **no** | **no** | **no** |
| `arch/backend-g6-receipts` (the base) | `6bf3478e` | yes | green | yes, through the above | **no** | **no** | **no** |

- **Uncommitted:** nothing in any of these worktrees.
- **Correction:** an earlier version of this doc, and my earlier reports, said "verified" from local runs alone. GitHub
  CI has been red on every `arch/submit-path` push since the base. The architect-tests step passes there; the node step
  `career-and-shared-tests-core` fails. "Verified in the repo" below means local runs, which are listed with their
  counts. It does not mean CI green.

### Why CI is red on `arch/submit-path`, and whose it is

I bisected locally. The base `6bf3478e` passes every one of these suites. I took the head and put back to their base
versions either the agent-chat handler (mine) or the router files (`142-career-router.js`, `router_core.js`,
`router_core.career.js`: Muse's branch `muse/2026-10-24-router-messagepath-fixes`, merged in as JOIN-1233 asked).

| Suite (pass/fail) | `6bf3478e` base | head | head, base **handler** | head, base **router** | candidate join on Muse's `02a40c29` |
|---|---|---|---|---|---|
| career-alert-intents | 8/0 | 7/1 | 7/1 | 8/0 | 9/0 |
| career-bundle-reachability | 1/0 | 0/1 | 0/1 | 1/0 | 1/0 |
| career-depth-memory | 13/0 | 12/1 | 12/1 | 13/0 | 13/0 |
| career-document-delivery | 6/0 | 5/1 | 5/1 | 6/0 | 6/0 |
| career-resume-phrase-scope-20261024 | absent | 3/1 | 3/1 | 0/4 (tests the new router) | 4/0 |
| career-submit-chatpath-20261025 | absent | 6/9 | 6/9 | 5/10 (tests the new router) | 15/0 |
| career-v240-live-gaps | 11/0 | 10/1 | 10/1 | 11/0 | 11/0 |
| career-v241-live-gaps | 6/0 | 5/1 | 5/1 | 6/0 | 6/0 |
| career-v242-live-gaps | 2/0 | 1/1 | 1/1 | 1/1 | 2/0 |
| career-ibtn-integration | 32/0 | 31/1 | 31/1 | 32/0 | 32/0 |
| career-textpath-heldout-blind1-20261024 (CI, fresh HOME) | absent | 0/15 → 15/15 after `fd606d9d` | | | 15/15 |

CI's own list at `32d1aa0e` (run `40448874128`, gate core: 3058 tests, 33 failed, 24 skipped) is exactly these rows:
- the 15 heldout-blind1 cases;
- the 9 chatpath cases;
- alert-intents #15;
- bundle-reachability #365 (subtest 3, "manages a watch");
- depth-memory #561;
- document-delivery #575;
- ibtn-integration #1100;
- resume-phrase-scope #2133;
- the v240, v241 and v242 wrappers (probe j (a)/(b), LIVE-shaped, chain, and the throwing tailor leg).

Every other step passed: architect-tests, career-edge 151/0, typecheck, bundle, and gate (browser).

**Full local cross-check.** I ran the gate's whole core node list (270 suites, fresh `HOME`, `CI=true`) at the base, at
the head and at the join, and compared the failing test names. Failures this container has at base too (browser and
engine drive suites that pass in CI) are environment, not code.
- **Head, failing and not failing at base:** exactly CI's list above, plus B-05.
- **Join, failing and not failing at base:** only B-05.
- **B-05 (career artifact size) is a local artifact.** Without esbuild the stager measures RAW, an upper bound: head
  4,263,383 B and join 4,276,533 B, over the 4,200,000 B ceiling. CI sets `ESBUILD_BIN`. With esbuild, B-05 passes
  everywhere:

  | | Bundled size |
  |---|---|
  | base | 3,764,692 B |
  | head | 3,912,964 B |
  | join | 3,923,925 B |

  **Watch item:** about 276 KB (6.6%) of headroom remains. The career graph grew 159 KB since the base, mostly the router.

- **Mine, fixed:**
  - v242's staged fake did not serve the `agent_messages` read and the `career_events` insert that my evidence step
    makes, so its control case threw. Fixed in `32d1aa0e` (test fixture only).
  - The heldout-blind1 harness appends to `$HOME/workspace/…`, which does not exist on CI runners. That gave 15
    ENOENT failures, here and on Muse's head (run `40223344044`). Fixed in `fd606d9d`: the harness creates the
    directory first. The path and the records are unchanged.
- **Not mine:** every other red row is the router at Muse's `49364988` (the `career_watch_create` misroute and the
  chatpath suite). They pass on Muse's newer `02a40c29` (REGRESSION-1255) joined with my head, so no router edit is
  needed from this lane. Bringing `02a40c29` into `arch/submit-path` is a join of router code, and CHECKPOINT-1315
  pauses that. I pushed it only as the candidate branch above, so CI can show the result. The coordinator decides the
  join.
- **Not a defect after all:** the handler's thread read (`handler-career.ts:515`) has no try/catch. supabase-js 2.117.1
  turns a fetch failure into `{ error }` with default settings and does not throw it (`postgrest-js dist/index.cjs:418`).
  The handler already holds every fact on `{ error }`. Only a test fake can throw there, so no handler patch is
  proposed.

The candidate join, run locally: the router bundle is verified. The architect suite gives 1360 passed, 0 failed. Real
Postgres 16 with Chromium gives flow-real-person, flow-connected, handler-submit-path 11/11 and submit-real-person 16/16.
The only failure is pending router (c), which is expected red (issue 2).
- **Edits paused:** CHECKPOINT-1315 holds router_core and 142, the 155 batch stack, the agent-chat handler and the
  career bundles until the coordinator's release.
- **Never done by this lane:** a real employer submit, a deploy, a migration applied to a live database, a schedule, or
  spend.

## The one path, step by step

The path: the person texts → the server prepares (`workers/career-browser/prepare-ahead.ts`) → the card → the person's
own approval → `career_apply_claim_own` → the engine submits on their computer (`approve-first.ts` `runApproved`) → the
outcome is recorded → chat reads it back.

**Where every step stands:**
- **Pushed:** yes, on `arch/submit-path`.
- **Merged to trunk:** yes.
- **Merged to main:** no.
- **Deployed:** no.
- **Verified live:** no.
- **Verified in the repo:** locally yes; GitHub CI no (red, see above). Locally means synthetic people, a real throwaway Postgres 16, a real Chromium, and an
  employer page on 127.0.0.1. No real site was ever reached.

| Step | What it does | Verified in the repo by |
|---|---|---|
| 1. Entry: the resume | The router shows each entry's words (Muse, e0aad64b). The person says yes. agent-chat's evidence step (`career_router_evidence.ts`) gives each shown entry a `career_events` `fact_confirmed` row naming their upload. An entry not shown, not in the upload, or whose event fails is put back to draft, and the reply says so, never "Confirmed". | handler (a1, a2, a3); flow-real-person chat step; submit-real-person 1, 1a, 1a1, 1a2, 1b, 1c |
| 1. Entry: name, email, phone, work authorization | The person's own chat words are offered back word for word with the date (`contact_draft.ts`, `eligibility_draft.ts`). Only "use N" writes. A statement alone writes nothing. Citizenship answers neither eligibility question. With confirmed entries but no name or email, prepare asks for those once. | handler (b1, b2, c1, c2); flow-real-person; submit-real-person 2–3c |
| 2. Approval | The card answer approves the listed items of one card, up to 8, in one call. Each item is bound to its exact payload hash. A changed payload is refused at approval and closed as not sent at claim. A chat "yes" does not approve (Option A). | flow-integrated; flow-connected; flow-real-person tap step |
| 3. Action | The engine submits exactly the approved answers and the tailored resume, once. | flow-real-person drive step (Jordan / Rivera / email / phone / no / yes and the tailored resume byte for byte, once); flow-connected G1, G4 |
| 4. Receipt and follow-through | The outcome is recorded in `career_apply_jobs` (a page's thank-you is `submitted_unconfirmed`, never `confirmed`). "Where are my applications" and "did my application to X go through" are read back from `career_apply_jobs` only (`career_apply_status.ts`). The receipt text comes from the recorded rows (G6). | handler (d1, d2, d3); flow-real-person read-back; flow-connected receipt step |

### Evidence (last runs, at `d671223c`, real Postgres 16.15 and Chromium 141, `CI=true`, never a skip)

| Run | Result |
|---|---|
| `bash tests/flow/run-real-flow.sh` | flow-real-person 1 test, 10 steps; flow-connected 2 tests; handler-submit-path 11 tests: **all passed** |
| Architect suite (`--ignore=tests/architect/pending tests/architect/`) | **1360 passed, 0 failed** |
| `tests/architect/submit-real-person.test.ts` | 16/16 |
| `tests/career-submit-split-1146.test.cjs` (Muse) | 13/13 |
| `scripts/build-router-core.py --career-only --check` | verified |

Before and after for handler-submit-path (same 9 seam assertions, before a1 and a3 moved in):

| Head | Result |
|---|---|
| 6bf3478e | 4 passed, 5 failed |
| 455da675 | 8 passed, 1 failed |
| d671223c | 11 of 11 |

How to run it, what it needs and how long it takes: `docs/architect/SUBMIT-PATH-2026-10-25.md` ("Running the real flows
yourself"). Where esm.sh is blocked, add `IMPORT_MAP=tests/flow/supabase-npm.json` (the same supabase-js 2.117.1 from
npm).

## Remaining issues (open, in order of what blocks a real person)

0. **GitHub CI is red on `arch/submit-path`.** The cause is the router join, not this lane (see "Why CI is red" above).
   The fix is the coordinator's call to join Muse's `02a40c29` (candidate: `arch/submit-path-join-1255`). Read that
   branch's CI result before trusting any "green".
1. **Not on main, not deployed, not verified live.**
   - **To deploy:** agent-chat (`handler-career.ts` and its `_shared` modules), and the router bundle.
   - **To apply, in this order:** the migrations `20261025100000_career_apply_one_ledger.sql`,
     `20261025110000_career_apply_bridge_reconcile.sql` and `20261025120000_career_apply_prepare_ahead.sql`. They are
     listed in `scripts/launch/trainee-go-live.sh:136-138`. These are the owner's to apply.
   - **No live database migration has been run** by this lane.
2. **Router (c), Muse's lane, red.** It is in `tests/architect/pending/handler-submit-router.test.ts`. At 49364988 the
   sponsorship reply no longer claims a save, but it still says "The prepared packet built on the old answer is invalid"
   to a person with no packet.
3. **The volume ceilings are still in place** (CAPS-1218, owner: "no cap on volume"). The inventory with file and line
   is in `SUBMIT-PATH-2026-10-25.md`. Removal (code and migration drafts, failing-first) waits for the coordinator's
   release under CHECKPOINT-1315.
4. **One per company per 30 days is kept, unresolved.** It is not user-approved policy and not an exact-duplicate rule;
   different roles at one company may be legitimate. The owner decides.
5. **Approval model, the owner's call.** The database approves a batch per card, hash-bound. The chat refuses a text
   "yes" (Option A, `career_apply_cards.ts:174-181`). The owner's words "a yes does handle a batch of submissions" fit
   the database and not the chat refusal. Neither is changed.
6. **Nothing has been submitted to a real employer through this path.** No email-confirmed submission exists either, so
   the cloud gate (3 hand submissions confirmed by email per portal) cannot open except by waiver.
7. **The person's computer must run the worker.** The executor on this path is `approve-first.ts` on their machine. The
   cloud worker uses the same engine, but needs the owner's VM, opt-in and gate.
8. **Alerts lane, paused.** It is preserved at `adcf6473`. The alert-path suite was 11/27 before the last edits and was
   not re-run. The real-Postgres alerts test is in `pending/`.
9. **Known pre-existing failure, not this lane's.** `tests/proactive-wiring.test.cjs` "scheduler: the function exists"
   expects `deno check …agent-proactive/index.ts` in ci.yml. It fails identically at 6bf3478e.

## Settings the path reads (names only; values are the owner's)

| Where | Settings |
|---|---|
| agent-chat | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CAREER_MODEL`, `CAREER_EMAIL_SEND`, `CAREER_BATCH_EXECUTOR`, `UPMORE_CAREER_WORKER_URL`, `UPMORE_CAREER_WORKER_SECRET` |
| The person's computer and the engine | `UPMORE_PLAYWRIGHT_PATH`, `UPMORE_CHROMIUM_PATH`, `UPMORE_CHROMIUM_SANDBOX` |
| prepare-ahead | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Tests | the same names, with fake values set inside the tests (`service-test-key`, `anon-test-key`). No real key is in the repo. |

## Signatures other lanes call (at d671223c)

All are listed with file and line in `docs/architect/SUBMIT-PATH-2026-10-25.md` ("Functions" and "Handler-level
contract"):
- `evidenceResumeConfirmation`
- `resumeConfirmationContext`
- `heldReply`
- `contactDraft`
- `statusAsk`, `statusReply`, `applicationsTurn`, `supabaseApplications`
- `prepareAhead`
