# Mass-apply scale audit (read-only, 2026-11-02, trunk 6cf5fa7bd)

Target: 10,000 users x 20 roles/day = 200,000/day (139/min); also 1,000 users (20,000/day) and 100 (2,000/day). Not found: `docs/architect/mass-apply-proof-runbook.md` does not exist (a proof runbook is unknown). Vercel limits below come from
`docs/launch/CLOUD-RUNNER.md` (lines 91-96), not verified here. Timings: 11.6 s/posting prepare, 11.4 s/send, LOCAL fake forms
(`MASS-APPLY-COST-2026-11-01.md`); real forms "30-90 s" (CLOUD-RUNNER.md:89). No real employer has been measured: unknown.

## 1. Limits on the path (default -> effect)
| Limit | Default | Where |
|---|---|---|
| Send starts per tick / concurrent / per ATS family | 2 / 2 / 1 | `cloud_runner_http.ts:19` |
| Prepare starts per tick / concurrent | 2 / 2 | `cloud_runner_http.ts:20` |
| Per-person/day, per-host/min (send and prepare) | none (null) | `cloud_runner_http.ts:22`; person pace null unless set |
| Cron cadence (dispatch, prepare-dispatch) | every minute, pg_net timeout 55 s | `schedule-career-cloud.sql:18-33` |
| SQL ceiling per tick / global | 500 / 10,000 | `20261026230017...sql:246,402` |
| Sandbox create parallelism per tick | 8 (max 32) | `cloud_runner.ts:142` |
| Sandbox timeout / lease / engine timeout / authorize | 13 min / 15 min / 10 min / 5 s | `cloud_runner.ts:246`, `worker.ts:471,483` |
| Postings per prepare request (one sandbox, serial) | 25 | `20261026230017...sql:322`; serial: `prepare-ahead.ts:106`, `prepare-runner.ts:66` |
| Results per ask / rows on page / tick-visible candidates | 25 / 30 / 500 global | `role_results.ts:15`, `telegram_jobs.ts:41`, `cloud_prepare.ts:144,190` |
| Receipt/ready/question reads per 5-min run | 2,000 each, no ORDER BY on receipts | `career-proactive/index.ts:50,65,179` |
| Outbox rows delivered | 20 per run, 1 run/min | `trainee-deliver/handler.ts:14`, `schedule-trainee-deliver.sql:16` |
| iMessage new contacts/day | 300 | `trainee-deliver/handler.ts:16` |
| Chat requests / person | 60 per hour | `agent-chat/handler-career.ts:233` |
| Model $ per person / calls per day | $0.05 / 100 | `career_spend_cap.ts:25-26` |
| Model $ GLOBAL per day | $20 (~6,700-10,000 brain turns at $0.002-0.003) | `model_budget.ts:22` |
| Sign-in: texts/link, tries/link, texts/account/h, tries/account/h, session | 3, 5, 10, 15, 2 h | `file_session.ts:12-23` |
| Cloud gate | 3 owner-confirmed hand sends per ATS; else waiver max 5 sends, 7 days | `20261024120000...sql:22,27` |
| ATS families the cloud can take | greenhouse, lever, ashby only | `20261026230017...sql:140` |

System maxima at defaults: SEND 2/min = 120/h = 2,880/day (60/h = 1,440/day if apps take 90 s, since ticks are 60 s and 2 slots).
PREPARE: 2 slots; a 20-posting request holds a slot ~232 s at local timing -> ~14,400 postings/day (720 users); at 60 s/posting the
13-min sandbox dies at ~13 postings and the slot is held to the 15-min lease -> ~8 requests/h x 13 = ~2,500 postings/day (125 users).
RECEIPTS: ~2,000 per 26 h window. DELIVERY: 20 x 1,440 = 28,800 rows/day for ALL messages (cards, questions, receipts).
## 2. First bottleneck
- **100 users (2,000/day, 83/h avg):** defaults sit at 70-80% of send and prepare capacity before any peak; a 3-hour evening peak
  (say 40% of volume = 267/h) is 2.2x the send cap -> multi-hour backlog. First to break: prepare (2 slots, serial). Receipts hit their
  2,000 cap exactly (`career-proactive/index.ts:50`, window 26 h `career_proactive_run.ts:259`), so new receipts can go unplanned.
- **1,000 users (20,000/day, 13.9/min):** send needs >=14 starts/tick (7x default) and ~21 slots at 90 s. Even with knobs raised, three
  walls: receipts 10x over the 2,000 read cap; delivery 20,000 receipts + cards = 70%+ of 28,800 rows/day; and prepare candidates
  (below) once a request waits ~36 min (500 newer wants at 13.9/min). Unraised, prepare is first.
- **10,000 users (200,000/day, 139/min):** sandboxes/day: 200k send + ~10k prepare. Slot-hours: prepare 645 h/day local (27 concurrent)
  to 3,333 h real (139); send 633 h (26) to 5,000 h (208). Dispatch must start 139/tick = 18 batches of 8 inside 55 s (<3 s per create+run
  pair; latency unknown). Receipts alone need 200,000/28,800 = 6.9 days of delivery. Global model budget ($20) is gone after ~8,000
  turns, i.e. at roughly 1,600 users each doing 5 turns (ask, answers, "show my applications"). DB: below.
## 3. Fairness (can 200 queued roles starve others?)
- Send: no. Card-cloud claim gives people turns (`20261027141000...sql:223-310`, <=4 each); text-card claim orders by per-person
  row_number (`20261026230017...sql:181`). But the text claim builds the window over EVERY queued row each call.
- Prepare: yes in proportion. Claim is FIFO by request, not by person (`20261026230017...sql:421`). One person's roles become 8 parts
  of 25 stamped the same instant (put, `:360`) and `reprepareQueued` kicks ALL waiting rows with no cap (`career_hosted_prepare.ts:24-33`).
  Later users wait behind all 8: 8 x 232 s / 2 slots = 15 min at local timing, ~1 h at real timing. No per-person/day number is set.
- Candidates are newest-first (`order by alerted_at desc`, `20261101130000...sql:126`): under backlog the OLDEST requests lose, the
  inverse of the FIFO claim.
- Failure sharing: one family pause hits everyone. 2 bot checks in the last 20 attempts of a family pause it 6 h for all users
  (`20261101120000...sql:23`). Person pause: 2 checks/day. Global model budget is first-come.
## 4. Single points of failure and unbounded work
1. `career_apply_prepare_candidates` (`20261101130000...sql:86-127`) is GLOBAL: unions all waiting wants and 14 days of ALL users'
   `career_outbox` alerts (`kind='alert' and key like`; no index on kind/created_at, indexes at `20261019020001:30-32`), joins postings,
   runs per-row subqueries, windows, then LIMIT. Called 3x per prepare request (`cloud_prepare.ts:144,190` and prepareAhead). Cost
   per call ~ O(all users' alerts + wants); total ~ O(requests x users). **Correctness bug:** the bridge hard-codes `p_limit: 500`
   and filters to the one user AFTER the global cut (`cloud_prepare.ts:144-145`); a user whose wants are outside the newest 500
   gets zero candidates and the reply "no longer open on file..." (`notPreparedText`, `:244`). Wrong message, nothing prepared.
2. Receipts: `career_apply_jobs` filter `state in (...) and updated_at >= since limit 2000` (`career-proactive/index.ts:49-50`) has no
   ORDER BY and no index on updated_at (indexes: `20261020000001:18-20`, `20261027141000:222`): full scan every 5 min, and past 2,000
   in 26 h the newest finishes are silently never receipted. One message per application, no batching (`career_apply_receipts.ts:115-125`).
3. Single dispatcher: `pg_advisory_xact_lock('career-cloud-dispatch-v1')` held for the whole claim transaction (`20261026230017...sql:249`),
   which for text cards includes the O(queue) window (`:181`), looped per family in 6s (`:259-266`); same for prepare (`:405`).
4. `career_apply_sweep_stale()` every 15 min scans all queued rows calling `career_apply_current` per row (`20261022150000...sql:69-77`).
5. The 15-min lease sweep `career_apply_sweep(p_now)` is called only by the VM store (`career_apply_store.ts:44,48`); no cron or
   dispatcher call exists. In the sandbox path a dead sandbox leaves `driving` forever (docs say swept: CLOUD-RUNNER.md:31).
6. Snapshot (1.49 GB, expires 30 days after last use, rebuilt ~25 min: CLOUD-RUNNER.md:246) and one Vercel token/project: if create
   fails, every claimed job is finished `not_submitted RUNNER_UNAVAILABLE` after 3 tries (`cloud_runner.ts:125-139`). The approval is
   consumed (attempts = 1), not requeued. Vercel rate-limiting converts approvals into failures at scale.
7. `career_watch_kv` gets 25 `tg:job:` + list + meta rows per ask, no TTL found (`telegram_jobs.ts:724-727`); `trainee_file_sessions/logins`
   cleanup: none found. Page draw: ~5 reads x 30 rows (`handler.ts:206-219`, `store.ts:19-31`), twice per POST; edge wall clock for
   "Apply to selected" (sequential `approveOne`, `handler.ts:704`): unknown.
8. Bridge: ~7 edge calls per send and ~6-7 per prepared posting -> ~3M invocations/day at 200k. Edge/PostgREST limits: unknown.
## 5. Cost per application and ceiling
- Sandbox: `MASS-APPLY-COST` estimate $0.0033 (local timing: 11.6 s prepare + send billed at 1-min memory minimum). Real forms (my
  arithmetic, 4 GB x $0.0212/GB-h = $0.0014/min, 60 s prepare + 90 s send + CPU) ~ $0.006. 200k/day = $660-$1,200/day; CLOUD-RUNNER.md:91
  gives $1.80-3.20 per 1,000 sends alone. Sandbox seconds are NOT metered in the database (none found); only model use is
  (`agent_turn_costs`).
- Model: prepare and send make 0 calls (cover notes off, `prepare-ahead.ts:507`). Chat turns ~$0.0025; per-person max $0.05/day = $500/day at
  10k users worst case, but the global $20 stops it first (then replies drop to non-AI steps with a note).
- Bandwidth: resume <=5 MB (`cloud_prepare.ts:37`), base64 through the edge function once per send, once per prepare sandbox, and once
  PER POSTING because `prepare_for` re-reads the whole resume only to read its filename (`cloud_prepare.ts:159`). At an assumed 200 KB
  resume: ~21 x 267 KB = 5.6 MB per 20-posting request, ~56 GB/day total. Proof stored = hashes and times only; screenshots die with the
  sandbox (CLOUD-RUNNER.md:36).
- Ceiling today: only starts/tick x concurrency (max $/day = starts x cost). Team Spend Management is an owner step (CLOUD-RUNNER.md:239),
  not enforced by code. A real ceiling = a SQL daily count of claims plus prepare postings checked inside the claim.
## 6. Abuse and safety
- Links: HMAC token, 24 h (`file_link.ts:9`); says which list, never who; a texted code to the account's own phone starts a 2 h session
  (`handler.ts:3-8`); numbers in section 1. No per-IP limit in `handler.ts` or `api/file.js`. Supabase Auth SMS provider limits and cost:
  unknown (`supabase/config.toml` silent). Every expired session needs a new SMS.
- Duplicate sends: strongest part. Unique live row per (user, job) (`20261101130000...sql:39`), claim `for update skip locked` with
  attempts = 1 and per-user advisory locks (`20261026230017...sql:185-193`), `posting_sent` re-check at claim and authorize, token bound to
  lease, never auto-retried (unknown_outcome). Residual: an unknown outcome is never reconciled except by employer email.
- Employer/ATS: per-host rate unset. The host back-off table is written only by `career_apply_requeue_refused_for`, called from the VM
  worker (`worker.ts:229,335`); the sandbox path has no requeue op (`cloud_runner.ts:150`, `sandbox-runner.ts:54`), so a 429 or
  Retry-After finishes the approval `not_submitted` and nothing holds the host; ticks keep hitting it. All sandboxes share datacenter
  egress (one IP measured, rotation unknown) and report HeadlessChrome/`webdriver=true` by design (CLOUD-RUNNER.md:52-53): expect checks,
  then 6 h family pauses for all users. Telegram's own limits (~30/s, ~1/s per chat) are not in the repo; 429 `retry_after` is honored
  (`telegram.ts:225-238`, `channel.ts:117-122`, backoff 1/5/30 min, 3 tries).
- Policy gate: 3 owner-confirmed hand sends per family (CLOUD-RUNNER.md:271); others only via manual SQL waivers.
## 7. Top 5 changes by capacity per effort
1. **Raise and ramp the six env knobs** (`cloud_runner_http.ts:19-20`, secrets by name): starts/tick 2 -> 30+, concurrent 2 -> 60+, per portal
   1 -> 20+, prepare 2 -> 30+. Lifts send ~15-70x for 0.5 day plus 1 day ramp test (also raise `model_budget.ts:22`, owner decision). Useless
   without 2 and 3.
2. **Scope the candidates query to the request** (new SQL fn taking user + job_ids, no 14-day alert union; bridge `cloud_prepare.ts:144,190`;
   new migration): fixes the silent "nothing to prepare" and the O(users) scan. 2 days.
3. **Parallel and fair preparation**: run prepareAhead with a limiter of 4-6 inside the sandbox or parts of <=5 (`prepare-runner.ts:66-70`,
   `prepare-ahead.ts:106`), and claim by person turns (`20261026230017...sql:421`). 3-6x prepare per slot, no 13-min kills. 2-3 days.
4. **Receipts and delivery**: keyset-page `finishedApplications` with an `updated_at` index and one batched message per user per run
   (`career-proactive/index.ts:50`, `career_apply_receipts.ts:115`); several delivery workers like `CAREER_SEND_WORKERS`
   (`schedule-career-proactive.sql:33`, `trainee-deliver/handler.ts:14`). Removes the 2,000 and 28,800/day walls. 3 days.
5. **Stop burning approvals**: add a bridge `requeue` op wired to `career_apply_requeue_refused_for` (`cloud_runner.ts:150`,
   `sandbox-runner.ts:54`, `worker.ts:229`) and requeue instead of `not_submitted` on create failure (`cloud_runner.ts:129-139`). Also
   schedule the lease sweep; make the text claim use `claim_turns` (`...sql:181`). 2-3 days.
