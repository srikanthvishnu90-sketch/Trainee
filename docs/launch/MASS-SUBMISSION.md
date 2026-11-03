# Mass submission at scale: workers, refusals, crash recovery, preparation hosts

Owner rules (2026-10-27):
- D-MS-2: no product volume cap.
- 19:52 CDT: "operate these things at large scale". The target is 100,000 people at once, each running hundreds of applications a day.
- 19:55 CDT: "no person limit, never set a limit".

This page is the runbook for the executors that prepare and submit approved applications. Nothing here is deployed, no
migration is applied, and no real employer was reached while building it.

## What runs, and what slows it

Every executor uses one scheduler, `workers/career-browser/mass-run.ts`:
- the cloud worker `workers/career-cloud/worker.ts`;
- the person's own computer `workers/career-browser/approve-first.ts run`;
- the preparation host `workers/career-browser/prepare-ahead.ts`.

- **No number of ours.** A worker runs as many applications at once as its machine has browsers for. That is about 450 MB of
  free memory per headless Chromium (`machineSlots`), and it applies to every employer site. There is no per-person,
  per-site, per-run or per-day number. The owner may set one (table below), but none is needed.
- **The site decides.** A site that refuses is held off, and so is the rest of the work on it:
  - a 429, or a 503 with Retry-After, on the employer's page before anything is filled. The engine stops with `HOST_RATE_LIMITED`; nothing was sent.
  - a verification check (captcha).

  The hold lasts as long as the site asked. Otherwise it is 30 s, doubling on each refusal in a row, and the site is asked
  again at least every hour. The next success clears it. The hold is shared by every instance through the database
  (`career_apply_host_backoff`), so one instance's refusal stops every instance. Until the database lane ships that
  table, each instance holds off on its own and says so once at start.
- **A captcha is never solved.** The application ends `needs_user` with its link, and is never retried. A sign-in wall
  (`ACCOUNT_LOGIN_REQUIRED`) does the same. A rate-limited one ends `not_submitted`, with "the employer's site was
  turning visitors away for a while (too many requests), so nothing was filled in" on the receipt.

## Many instances: leases, fairness, crash recovery

Run as many instances as you like, on any machines, all against the one database. There is no leader and no single loop.

- **Claim.** `career_apply_claim_fair(limit, lease_s, after)` leases queued applications without starting them. It uses
  `FOR UPDATE SKIP LOCKED`, so concurrent claims never wait on each other, and there is no global lock. Each instance
  walks every waiting person in id order from its own cursor (`after`, the last person it was served from) and takes one
  application per person per lap. A person with 5,000 queued never holds back
  another person's first, and when few people are waiting each still gets full speed. It skips any site that is being
  held off right now.
- **Begin.** Right before the engines start, `career_apply_lease_begin(ids, leases)` turns the leases this round starts into
  drives (`attempts = 1`). This happens only under the instance's own live lease.
- **Crash.**
  - An instance that dies before beginning loses nothing: its leases lapse (2 minutes) and any instance claims them.
  - One that dies after beginning leaves drives that the sweep (`career_apply_lease_sweep`, 15 minutes) records as
    `unknown_outcome`. Those are never driven again, so exactly once holds.
  - The instance's own journal (`CLOUD_JOURNAL_DIR`, 0700, fsynced before each engine start) records those drives as
    unknown on its next start, without waiting for the sweep.
- **Stopping** (SIGTERM). Nothing new starts. The runs in flight finish and are recorded. Leases claimed and not started
  are given back (`career_apply_lease_release`).

These five functions and the back-off table are the **Request to the database lane**. Their exact reference SQL is
`tests/flow/host-backoff.sql`, which the tests load into a throwaway database. The production claim must also apply
`career_apply_cloud_refusal(j, now)` to each row it leases: the kill switch, the gate or waiver, the opt-in, the pauses and
the person's own pace. The reference SQL leaves that out because the test has no cloud settings. Once it ships, the
worker's `restQueue` gets `begin` (the `CloudQueue.begin` hook, already in `worker.ts`) and calls
`career_apply_claim_fair`. Until they ship, the cloud worker uses
today's `career_apply_cloud_claim`. Today's claim starts drives as it claims and returns at most 6 rows a call; the worker
calls it again at once, so it still runs at full width. Its guards are unchanged (gate, opt-in, pauses, the payload-hash
re-check).

**Measured** (`tests/architect/mass-scale-pg.test.ts`, real Postgres 16, a 2 vCPU / 7 GB container; the engine is a 5 ms
stand-in so the database and scheduler are what is measured; the browser path is measured in `mass-submit-pg.test.ts`):
see the PR for the numbers of the run at the owner's target size (10,000 people × 50 + one person with 5,000; 20 worker
processes, one killed mid-run and replaced). Each application ran once, fairness held, and no instance started on a
refusing site inside its hold.

## Owner: scaling out

| What | How |
|---|---|
| More submitters | Start more `workers/career-cloud/worker.ts` instances (systemd units, containers, VMs: any number), each with its own `CLOUD_JOURNAL_DIR` on local disk and the same env file (docs/launch/CLOUD-WORKER.md). |
| How many browsers per instance | Nothing to set: the machine's free memory decides. `MASS_SUBMIT_CONCURRENCY` only if you want fewer. |
| More preparation | Start more `prepare-ahead.ts serve` / `daily` hosts with `PREPARE_AHEAD_SHARD=i/n` (0/3, 1/3, 2/3 for three hosts): each takes its share of the people, no lock between them. The chat's kick (`CAREER_PREPARE_AHEAD_URL`) can point at a load balancer in front of them. |
| The database | The claim is a loose index scan over `career_apply_jobs_queued_user_ref` (one row per person per pass) and the per-site hold is one small row per site; neither reads more than it returns. |

Optional numbers (none needed; set one only if you want to slow something yourself):

| Name | Unset means |
|---|---|
| `MASS_SUBMIT_CONCURRENCY` / `PREPARE_AHEAD_CONCURRENCY` / `CLOUD_CONTEXTS` | as many as the machine holds |
| `MASS_SUBMIT_CLAIM_BATCH` | the free browsers at each claim |
| `MASS_SUBMIT_HOST_MAX`, `MASS_SUBMIT_HOST_SPACING_MS` | none: every site at full parallelism until it refuses |
| `MASS_SUBMIT_START_BUDGET_MS` | 240000: a claimed application starts within 4 minutes of its claim (inside the queue's 15-minute lease) or is given back |
| `MASS_SUBMIT_JOURNAL_DIR` / `CLOUD_JOURNAL_DIR` | `~/.local/state/upmore/apply-journal` / `$CLOUD_EVIDENCE_DIR/journal` |
| `PREPARE_AHEAD_SHARD` | this host prepares for everyone |

## Preparation host: phone-only preparation (audit B2)

A person with only a phone gets a card only if a server prepares their applications. The extension and the desktop runner
need a computer, and an edge function cannot start a browser. The preparation host is `prepare-ahead.ts`. It prepares
every posting the database offers, a page at a time (one page is what the machine runs at once), until none is left.

| Env name (0600 file on each host) | Needed | What |
|---|---|---|
| `SUPABASE_URL` | yes | the project URL |
| `PREPARE_AHEAD_KEY` | once the database lane ships the `career_prepare` role | used instead of the service key |
| `SUPABASE_SERVICE_ROLE_KEY` | until then | stays in the worker process; the engine's process gets only `PATH`, `HOME`, `TMPDIR`, `DENO_DIR` and the Playwright/Chromium paths (`prepareEngineEnv`) |
| `CAREER_PREPARE_AHEAD_TOKEN` | for `serve` | random, 32+ characters; the chat's kick and `GET /status` carry it |
| `UPMORE_PLAYWRIGHT_PATH` | yes | Playwright (docs/launch/CLOUD-WORKER.md) |
| `CAREER_PREPARE_AHEAD=on` | for `daily` | the scheduled day's preparation and its card |
| `PREPARE_AHEAD_SHARD` | with several hosts | `i/n` |

Steps (the owner; none of them has been done):
1. Set up the VM or VMs as in docs/launch/CLOUD-WORKER.md section 1.
2. Create `/etc/trainee/prepare.env` (0600) with the names above.
3. Add a systemd unit `trainee-prepare.service`. It is the same as `trainee-cloud.service` except for
   `EnvironmentFile=/etc/trainee/prepare.env` and
   `ExecStart=/home/trainee/.deno/bin/deno run -A workers/career-browser/prepare-ahead.ts serve --port 8787`.
4. Put HTTPS in front of port 8787, for example Caddy: `prepare.<domain> { reverse_proxy 127.0.0.1:8787 }`. With several
   hosts, put a load balancer in front of them.
5. Optional: a timer every 15 minutes running `prepare-ahead.ts daily` with `CAREER_PREPARE_AHEAD=on`.
6. Run go-live with `CAREER_PREPARE_AHEAD_URL=https://prepare.<domain>/prepare` and the same `CAREER_PREPARE_AHEAD_TOKEN`.
   It sets both on agent-chat. The smoke then reads `GET /status`: a wrong token must be refused, and the right one must
   answer `{ok:true, service:"prepare-ahead"}`.

Until step 6, the smoke prints `NOT RUN preparation host (phone-only preparation): NOT_WIRED`. Also,
`prepareHostStatus` (supabase/functions/_shared/prepare_host_status.ts) returns `not_configured` with a sentence for the
person: "Nothing prepares applications for you yet unless the Upmore extension is running on a computer; your queued
postings wait until it is." Wiring that sentence into the chat's apply reply is the chat lane's (Request in the PR).
