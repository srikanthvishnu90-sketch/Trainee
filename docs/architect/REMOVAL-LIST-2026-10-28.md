# Removal list, 2026-10-28 (Q3: remove what makes the software bad)

This is an inventory of dead, duplicate and off-path code on `trunk` at `22fb03dc9`, with evidence. Each item says:
- what it is;
- why it hurts (bugs, confusion, size, cost);
- whether it is safe to remove, and the evidence (callers on the launch path, deploys, tests);
- the status.

**Launch path** means the one path the architect chose (`docs/architect/HANDOFF-SUBMIT-PATH-2026-10-27.md`): chat → card → batch
approval → `career_apply_claim_own` → engine (`workers/career-browser/approve-first.ts`), plus what go-live deploys
(`scripts/launch/trainee-go-live.sh` `DEPLOY_FNS`).

**Out of scope for Q3:**
- the mass-submit session's files (155, the apply SQL, workers, the card size);
- Q1's reply wording;
- Q2's posting screen and materials.

Items in those areas are listed here only so nobody loses them.

**Nothing listed as REMOVED is live.** A removal counts only once its PR is merged into `trunk` AND deployed by the owner's
go-live. Several PRs are held or unmerged (see each row), and none has been deployed. The live project's `cron.job` holds only
`cancel-watcher-daily`, `plaid-sync-6h` and `upmore-proactive`, which are not go-live jobs; no cron job is removed by anything
here unless the owner names it.

**Status words:**
- **Removed in #N**: removed in that PR; live only after the PR is merged and the owner deploys it.
- **OTHER LANE**: an open branch or PR already removes it.
- **OWNER**: the owner decides, because a rule or a pending decision covers it.
- **NEXT**: safe, not yet done.

## 1. The eight apply paths

The eight paths, by the code that can submit or queue a submission, and the database call that starts each one:

| # | Path | Entry → executor | On the launch path? | Evidence |
|---|---|---|---|---|
| 1 | Chat card, person's own computer | `career_apply_chat.ts` → `career_apply_cards.ts` (card, `career_apply_card_answer_as`) → `career_apply_store.ts` `career_apply_enqueue` → `approve-first.ts` `career_apply_claim_own` → engine | **Yes, the launch path** | HANDOFF-SUBMIT-PATH steps 1–4; `tests/flow/run-real-flow.sh`, `tests/architect/submit-real-person.test.ts` |
| 2 | Cloud worker on the owner's VM | `career_apply_cloud_claim` → `workers/career-cloud/worker.ts` (446 lines) | No. It needs the owner's VM, an opt-in and the cloud gate. | `CLOUD_RUNNER_ENABLED`, `CAREER_CLOUD_APPLY` off by default (audit §6) |
| 3 | Hosted runner (Vercel Sandbox) | `career_apply_cloud_dispatch_claim` → `_shared/cloud_runner.ts` → `career-cloud-runner` → `workers/career-cloud/sandbox-runner.ts` | No. Go-live does not deploy `career-cloud-runner`, and sandbox time needs the owner's approval. | #202 ships it with go-live (OTHER LANE) |
| 4 | Extension, the person's browser | `extension/background.js` → `career_apply_extension_begin_own` | No (the person clicks submit; `agentSubmits: false`) | `extension/manifest.json`, audit §6 |
| 5 | Extension, agent submits | `career_apply_extension_begin_agent_own` (WO-101) | No: off by default | `extension/background.js` |
| 6 | Apply by email | `_shared/career_apply_email.ts` (351 lines) → `career_apply_email_reserve_as` / `_finish_as` | No. It needs `gmail.send`, and there are 0 Google connections live; Google verification is pending (#196). | audit SEC3 |
| 7 | Old batch stack | router 142 → 155 batch intents (`career_batch_turn_commit_v1` in `career_persistence.js:30`) → `workers/career-browser/batch-executor.cjs` (331) → 149 `runApply` / `submitDoorstep` → `board-service.cjs` | No. It reaches no real site (G3a), and go-live never deploys its executor. **But the chat can still create batch intents** through the router. | SUBMIT-PATH-2026-10-25 "Old batch stack (off this path, no real site: G3a)" |
| 8 | Task intents | router → `career_task_turn_commit_v1` → `workers/career-browser/authority.cjs` (56) + `service.cjs` (281) | No. Same as 7: the executor is on the VM worker, not deployed by go-live. | `career_persistence.js:30` |

**Why eight hurts:** every guard has to be built eight times. For example:
- the resume-required rule had to be added to extension begin, card answer, cloud claim and the desktop runner (audit B4);
- the volume caps lived in at least five places (SUBMIT-PATH "Volume ceilings").

Every guard that fails open on one path is a bug on that path.

**Safe to remove?**
- **Paths 7 and 8 (old batch stack, task intents)** are the clear candidates. They submit nowhere real. Removing them takes out:
  - 155 (998 lines);
  - `batch-executor.cjs`, `authority.cjs` and `service.cjs`;
  - the `career_batch_*_v1` and `career_task_*_v1` RPCs;
  - the router branches that create those intents.

  **Not yet safe:**
  - the router (`142-career-router.js`, `career_persistence.js`) still emits the intents;
  - #223 and `feat/mass-submit-workers-20261027` both edit 155;
  - 149 and 150 are also the form engine that `extension_domain.js` bundles for path 4.

  Order: cut the router emit (Q1 or Muse lane), then delete 155, the executor and the RPCs in one PR, after #223 lands. **NEXT, blocked on #223.**
- **Paths 2, 3 and 6** are not dead. They are the owner's planned routes (cloud, hosted, email) and are off by default. **OWNER**: keep them or retire them.
- **Paths 4 and 5:** keep path 4 (it is the fallback ladder's "the person's browser" step). Path 5 is off by default. **OWNER.**

## 2. Volume caps (owner, 2026-10-27, D-MS-2 / D-MS-3: no product volume cap; block only exact duplicates)

| Cap | Where | Status |
|---|---|---|
| `SPEC_CAPS` 15/day, 5/vendor/day, 1/company/30 days | `packages/domain/149-career-portal-apply.js:122-123, 624-667` and its three `CAP_REACHED` stops | OTHER LANE. #237 is closed; `feat/mass-submit-workers-20261027` (51feaaa8) removes the same caps and adds per-portal refusal pacing. Not on trunk yet. |
| 155's `CAP_REACHED` deferral and the "today's application limit" text | `155-career-batch-apply.js:480-482, 780-782, 812-823, 906, 983` | Dead once 149 never returns `CAP_REACHED`. OTHER LANE (#223, mass-submit-workers) |
| One per company per 30 days | TS: `career_apply.ts:45, 91`; `career_apply_want.ts`. SQL: `career_apply_ledger_refusal` (latest `20261025160000:39, 103`), the cloud refusal, `career_apply_want_guard`, `career_erase_complete` | OTHER LANE: `feat/mass-submit-db-20261027` removes the TS side and adds `20261027141000_career_apply_mass_submit.sql` |
| Per-person product daily limit 25/50 | was `career_apply_daily_limit` and `least(...)` | Already gone on trunk (`20261025140000_career_apply_no_volume_ceiling.sql`; `tests/db/career_apply_daily_limit.test.sql` "no product daily number"). Only the person's own pace remains. |
| `MAX_PER_CARD = 8`; SQL `between 1 and 8` | `career_apply_cards.ts:54`, `20261020030000_career_apply_cards.sql:21, 78` | OTHER LANE (#223 chat side; Builder A for the SQL) |
| Claim size `least(6, p_limit)`; `claim(limit = 1)`; cloud `min(6, contexts)` | `20261025100000:263, 275`; `approve-first.ts:408, 443`; `workers/career-cloud/worker.ts:236` | OTHER LANE (`feat/mass-submit-workers-20261027` edits approve-first.ts and worker.ts) |
| Prepare-ahead 10 per person a day, 30-day cooldown; SQL clamps 25 per person, 200 per run | `career_prepare_ahead.ts:18, 20`; `20261025120000_career_apply_prepare_ahead.sql:75-77` | OTHER LANE (`feat/mass-submit-workers-20261027` edits prepare-ahead.ts) |
| Outreach: `DEFAULT_DAILY 20`, `MAX_DAILY 30`, warm-up 10 a day for 7 days, `BATCH_MAX 10`, `RECIPIENT_CAP 3` | `career_outreach.ts:40, 65` | OTHER LANE (networking at scale: #225 and #229 rewrite `career_outreach.ts`). Check that they are gone when those land. |
| Introductions: `WEEKLY_CAP = 3` | `career_connector.ts:81` | **OWNER.** It limits asks to a third party (double opt-in), not the person's own volume. |
| Model spend: `MAIL_MODEL_DAILY_CAP 200`, `DAILY_DRAFTS 60` | `career_mail_model.ts:45`, `career_essay_card.ts:19` | **Keep.** These are spend guards (audit X7), not volume caps. |

## 3. Finance (Upmore) code: reachability from Trainee

**Evidence:** the career-only deploy is the static import graph of `agent-chat/index-career.ts` (`scripts/career/stage-career.cjs`). I staged it on trunk and got 104 files. **None** of them is finance code: no plaid, broker, alpaca, budget, stripe, simplefin, biller, money or subscription module. So no finance path is reachable from Trainee chat today.

| Item | Size | Why it hurts | Status |
|---|---|---|---|
| Model gateway: one secret (`MODEL_PROVIDER=anthropic`) moved every Trainee model call to Anthropic | `_shared/model_gateway.ts:25-36` (trunk) | Breaks the owner rule "OpenAI only, no Anthropic API spend" (audit SEC11) | **Removed in #241 (open, unmerged).** The Anthropic branch inside `callModel` remains, reachable only from the finance planner's tests. NEXT, together with the planner. |
| 20 finance functions: agent-exec, agent-message-inbound, -turn, -worker, agent-payments, agent-proactive, agent-workflows, broker-oauth-callback, -start, cancel-watcher, exec-vault-store, manual-connect, news-feed, plaid, plaid-sync, simplefin-claim, -proxy, stripe-checkout, -credits, -webhook | about 16 still ACTIVE live (audit §5) | Live drift, anon-callable definers (audit SEC2), attack surface | Go-live does not deploy them today; #239 (unmerged) would make the script refuse if that changed (`UPMORE_ONLY_FNS`). **OWNER**: retire the live functions and delete the directories ("whether to retire the Upmore finance leftovers", handoff §8). |
| 3 legacy finance pg_cron jobs: `upmore-proactive` hourly, `plaid-sync-6h`, `cancel-watcher-daily` | live | One embeds a bearer token (SEC9); one answers 401 on every run (O2) | **OWNER.** They are the only jobs in the live `cron.job` and are not go-live jobs. #239 (unmerged, held) gives go-live an explicit `--unschedule-cron <exact names>` allowlist; by default step 5 removes nothing. |
| Finance domain modules in `packages/domain` (38-agent-biller-model, 48-money-math, 54-agent-money, 60-agent-money-plans, 68-agent-cancel, 71-alpaca, 73/74/77 broker, 80-money-answers, 84-money-owed, 85-subscription-savings, 93-budgets, 96-year-in-money, 100-subscription-list, 101-money-in, 104-cancelled-charge, and more) | the full `router_core.js` bundle is 7.5 MB, against 2.9 MB for the career-only one | Size, confusion; the gate rebuilds and checks the finance bundle on every PR | **OWNER.** Only the finance handler (`agent-chat/handler.ts`, `flow_router.ts`, `proactive.ts`, `broker_connect.ts`, `manual_connect.ts`) imports `router_core.js`. Retiring finance deletes the full bundle and its build step. |
| `index.html` (8.1 MB): the Upmore app, mentioning "Upmore" 9,306 times | root | The audit's B7: the web is still Upmore | **OWNER**, and #195 (Trainee web at `/app`) |
| `scripts/launch/go-live.sh` and `scripts/launch/rollback/agent-chat-v203/` (336 KB) | the finance go-live and its rollback copy, which calls Anthropic directly (`index.ts:37, 705`) | A rollback through it would put Anthropic calls back in production | **OWNER**, with the finance retirement. Only `go-live.sh:133` references it, and `trainee-go-live.sh` never does. |
| `workers/web_agent.py`, `workers/hn_deals.py`, `workers/imessage_sender.py` | 670 lines | Upmore workers: `index.html` queues `web_agent_jobs`; `imessage_sender` is a TEST ONLY bridge | **OWNER**, with the Upmore app |
| `OUTAGE_REPLY` says "the AI service **Upmore** uses" | `model_gateway.ts:179` (trunk) | Trainee users read "Upmore" | Q1 (reply wording). Flagged to Q1. |
| `finance-management-design.md`, `new-income-routes-research-2026-09-23.md`, `UPMORE-APP-README.md` | root docs | Confusion | **OWNER**, with the finance retirement |

## 4. One-off and stale files

| Item | Status |
|---|---|
| `surgery1.py` and `surgery2.py`: one-time rewrites of the Upmore app | **Removed in #240 (open, unmerged).** No caller outside `docs/`. |
| `qa_fix_rejects.py`: hard-codes `/home/hatch/...` | **Removed in #240 (open, unmerged)** |
| `PR-BODY-ATS-LOGOS.md`: an old PR body | **Removed in #240 (open, unmerged)** |
| `PR-BODY.md` | Keep: `tests/career-forms-ci-coverage.test.cjs` reads it |
| `claude-progress.txt`, `BENCHMARKS.md`, `benchmark_list.json` | Keep: the append-only log of the 2026-10-12 benchmark run, treated like the archive (D-006) |

## 5. Router and canned replies (Q1 and Muse lanes, listed only)

- `packages/domain/142-career-router.js` is 15,255 lines of regex routing. It is what people talk to while `AGENT_BRAIN_RELEASED = false`, and it scored 60.5% (audit B6). Its branches that create batch and task intents feed only paths 7 and 8 (section 1). The consolidation (one brain, one reply writer) is awaiting the owner's decision (handoff §7).
- About 5,560 hard-coded replies; 149 literals in `_shared/career_*.ts` (audit Q3). The ones that leak internal codes:
  - `BOARD_NOT_WIRED — no board adapter is wired…`;
  - "What I can't do from this handler today…";
  - 155's `CAP_REACHED` "today's application limit" text, dead after the caps go.

  Q1 owns the wording. Q3 deletes only replies that are provably dead; 155's goes with 155.

## 6. Live drift and the stale `main`

- **Production is not trunk** (audit B5): agent-chat v251 is unrecorded, 33 of 65 migrations are live, and 25 functions are deployed, 16 of them finance. #239 (held, unmerged) would add an explicit cron allowlist and a guard against deploying a finance function. The rest is one trunk sha through the go-live pipeline. **OWNER.**
- **`main`** is 2,311 commits behind trunk and holds 18 commits trunk lacks:
  - `site/` landing-page work (e.g. `site/privacy.html`, 106 lines);
  - the sealed-eval CI recovery workflows (`ci(seal)`).

  Vercel's `trainee` project serves `site/` from `main`. It is not safe to delete or reset `main` until:
  - the owner sets Vercel's production branch to `trunk` (handoff §8);
  - those 18 commits are on trunk (`site/privacy.html` and the seal workflows).

  **OWNER**, then **NEXT**: one PR bringing those files to trunk.

## 7. Open PRs older than 2026-10-24 (the stale-PR pass)

**Method:** for each PR, check whether its head is on trunk, compare patch-ids (`git cherry`), compare each touched file's blob with trunk, and grep trunk for the substance.

**Closed as superseded, each with an evidence comment:** #144 (WO-094 on trunk does the same: `workers/career-browser/production-sources.cjs:36-38, 97`) and #147 (the candidate it repaired is merged: 6b6551cf is an ancestor of trunk). #237 was also closed. No further PR is to be closed until a semantic check shows trunk covers it.

**Semantic check (2026-10-28):** I took each stale PR's added or changed test files at its head, put them on current `trunk` (22fb03dc9) and ran them (`node --test` for `.cjs`, `deno test --no-check` for `.ts`, `CI=true`, this machine). A PR is superseded only if its tests pass there. **None did, so no further PR is closed.**

| PR | Result on trunk | Reading |
|---|---|---|
| #99 | `career-extension-browser` 0 pass / 55 fail | env (no jsdom / Chromium sandbox here), inconclusive; the fix is not on trunk |
| #102 | `wo-083-corrections` 2 pass / 5 fail; `wo-002-career-tools` 7 / 1 | behavior not on trunk |
| #107 | `wo-076-ready-first`, `wo-066-chat-to-queue` 0 / 1 each | module missing on trunk |
| #108 | `wo-074-standing-answers` does not load | `standing_answers.ts` missing on trunk |
| #110, #111, #113, #115 | each test file fails (0 pass) | fixtures and helpers missing on trunk |
| #114 | `career-brutal-residuals` 5 / 8 | 8 residuals still reproduce on trunk |
| #116 | 15 portal and browser test files, 0 pass | seven portal families not on trunk |
| #119 | `career-mi106-repost-stale` 3 / 8 | repost handling not on trunk |
| #128, #129, #137, #141 | their `wo-*` tests do not load, or 0 / 17 | their modules are missing on trunk |
| #139 | `trainee-go-live` 12 / 3, `deploy-provenance` 8 / 4 | its expectations differ from trunk's script |
| #146 | `career-link-liveness` 0 / 1, `career-pool-liveness` 0 / 9 | **not superseded**; its liveness tests fail on trunk |
| #142 | no test files | its migration is live but not on trunk |
| #163, #167, #140, #148 | not run (evidence or doc PRs, or a bundle of the above) | stay open |

| PR | Note |
|---|---|
| #99 WO-082, #102 WO-083, #108 WO-074, #110, #111, #113, #115, #116, #119 (WO-081 ports), #114 WO-088, #128 WO-091d, #129 WO-097, #141 WO-105, #142, #148, #163, #167 | Their tests and files are not on trunk by name; coverage by other trunk code is **not** ruled out, so each needs a semantic check |
| #107 WO-076 ready-first ("4x the daily limit as candidates") | May conflict with NO LIMITS (D-MS-2); needs a semantic check before any decision |
| #137 WO-101 Gmail connect | Overlaps #191 and #196; the architect decides which survives |
| #139 go-live deploys every function the product calls | `career-essay-draft`, `career-email-code`, `extension-sync` and `gmail-oauth` are still not in `DEPLOY_FNS`; its telegram-inbound / whatsapp-inbound half looks superseded by `trainee-telegram` / `trainee-whatsapp` |
| #140 merge train 2026-10-21 | Its last comment says HOLD; it bundles #108, #128, #129, #137 and #139. Decide after those |
| #142 batch trigger fix | Its migration was **applied live on 2026-10-20** but is not on trunk (live drift); it also edits frozen archive files (D-006) |
| #146 link liveness | **Not superseded**: its liveness tests fail on current trunk |

**Not touched, as instructed, and listed for the owner:**
- #193 live verification suite;
- #195 web app at `/app`;
- #198 sealed eval;
- #199 invite waves;
- #201 resume files;
- #203 handoff;
- #208 three-channel readiness;
- #215 SMS resume attachments;
- #216 family workflows;
- #218 channel approvals;
- #219 router (c);
- #220 stitched correction fence.

All twelve are newer than 2026-10-24 and outside this pass.
