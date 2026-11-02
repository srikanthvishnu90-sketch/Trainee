# Cloud runner: one sandbox per approved application (F-RUNNER, 2026-10-26)

The cloud executor that submits an application after the person approved it, without anyone's computer. It is the
existing path, scaled out: the card, the person's tap, the one queue (`career_apply_jobs`), the one cloud claim
(`career_apply_cloud_claim_at`, `career_apply_cloud_refusal`), the existing engine (`scripts/apply.ts --submit --approved
<hash>`, run by `workers/career-cloud/worker.ts` `runCloudJob`) and the existing finish (`career_apply_cloud_finish`).
No second engine, queue, claim or cap.

Nothing here is deployed, no migration is applied, and no real employer was reached while building it.

## How it runs

```
pg_cron (every minute)
  └─ POST career-cloud-runner/dispatch                     (Supabase edge function, holds the service key)
       └─ career_apply_cloud_dispatch_claim(want, global, per_portal)
            └─ career_apply_cloud_claim_portal_at(≤6, now, family)   = claim_at with a family filter, generated from it
       └─ per claimed application: Vercel Sandbox from the runner snapshot (retry 1 s, 2 s, 4 s)
            └─ deno run workers/career-cloud/sandbox-runner.ts      (env: job id, sandbox id, token, bridge URL; no key)
                 └─ POST career-cloud-runner/job/{job,resume,sources,authorize,ask,finish}   (token = HMAC(id, lease, sandbox))
                 └─ runCloudJob → scripts/apply.ts --submit --approved <hash>   (its own process, no secret in its env)
                 └─ finish → career_apply_cloud_finish → the bridge stops the sandbox
```

- **Limits.** Global (`CLOUD_MAX_CONCURRENT`) and per portal family (`CLOUD_MAX_PER_PORTAL`) are enforced in SQL under one
  dispatch lock, counted from what is `driving` inside the lease. Starts per tick: `CLOUD_MAX_STARTS_PER_TICK`.
- **The per-person cap is the SQL one.** `career_apply_cloud_refusal` decides every claim: the person's own pace (if
  set), one employer per 30 days on the one ledger, the opt-in, pauses, the gate or waiver, the kill switch.
- **Retry and backoff.** The claim is one transaction: if it fails, nothing was claimed and the next tick asks again.
  A sandbox that cannot be created or started after 3 tries (1 s, 2 s, 4 s, ±25%) is stopped and its application is
  finished `not_submitted` / `RUNNER_UNAVAILABLE`: the engine never started, so nothing could have been sent, and it is not
  left to the 15-minute sweep (which would call it unknown). The finish is retried 4 times (worker.ts). An application is
  driven at most once, ever (`attempts = 1`); a sandbox that dies mid-run is swept to `unknown_outcome` and never re-sent.
- **Lease.** The sandbox times out at 13 minutes, inside the queue's 15-minute lease. The engine's own timeout is 10.
- **Credentials.** The sandbox has a job id, its own id, the lease-bound token and the bridge URL. The bridge reads the
  job, its lease and its person from the database for every call; a token for another sandbox, an earlier lease or a
  finished job opens nothing (tests/architect/cloud-runner.test.ts part 1).
- **Evidence.** The row keeps the answers sent, the employer's response, the screenshots' hashes and the times
  (`evidenceOf`). The screenshot files themselves go with the sandbox when it stops.

## Verification checks (captcha): what happens, and the risk

Trainee never solves or gets around a check. The engine detects one at open, review or Submit and the job ends
`needs_user` / `bot_check` with its link ("finish this one yourself"); it is never retried. The existing throttle then
pauses that portal family for the cloud for 6 hours (2% failures in its window, or 2 checks in its last 20) and a person
for the day (2 checks).

`career_apply_cloud_check_rates(days)` gives, per family and per employer host: attempts, checks, the check rate (always
with its counts), sends, and sent applications with no employer email after 24 hours.

**Measured from a Vercel Sandbox (2026-10-26):**
- Egress IP 44.200.136.80, `ec2-…compute-1.amazonaws.com`, AS14618 Amazon: a datacenter address.
- The engine's Chromium (Playwright 1.64.1, headless shell 156.0.8078.4) reports `navigator.webdriver = true`, user agent
  `HeadlessChrome/156…`, 0 plugins. The runner does not mask any of this, and must not: masking it is getting around the
  check.
- reCAPTCHA Enterprise's and hCaptcha's public scripts load from the sandbox (a neutral local page, no site key, no token).
- **No score could be measured.** A reCAPTCHA Enterprise score is only visible to the site key's owner (an assessment in
  their Google Cloud project). Using an employer's key on our own page would be using their check against them, so it
  was not done. Google's and hCaptcha's public test keys always pass and say nothing.

**Expectation:** invisible reCAPTCHA Enterprise (Greenhouse, Ashby) usually scores a headless browser on a cloud IP low.
Two outcomes follow, and only one is visible to the engine:
1. a challenge appears → detected → `needs_user`, counted;
2. the employer's server silently rejects or drops a low-score submit while the page says "received" → recorded
   `submitted_unconfirmed`. This is why the rates include `unconfirmed_after_24h`: compare it with the same host's rate on
   people's own browsers before trusting the cloud on that host.

**Fallback:** the person's own browser, the extension (`extension/`, `career_apply_extension_begin_own`), with their own IP,
cookies and a real window. Decide per host from the numbers: a host whose check rate or 24-hour unconfirmed rate is above
the owner's threshold goes to the extension only.

**To measure the score (owner):** create a reCAPTCHA Enterprise key in your own Google Cloud project for a domain you own,
put a page with it in a sandbox, and read the assessments for 20 loads. That is the only honest score number.

## Load model (measured 2026-10-26, Vercel Sandbox, iad1, 2 vCPU / 4 GB, from the snapshot)

| Measure | Value |
|---|---|
| Sandbox from snapshot: API says running | 26 ms after the request (`requestedAt` → `startedAt`) |
| First Chromium launch + first page (example.com) | 1.1 s |
| Engine dry run, local form | 3.4 s median (6 jobs) |
| Approved submit by runCloudJob, local form | 6.2 s median (6 jobs, serial) |
| One sandbox, 6 applications serial / 2 at a time / 3 at a time | 9.6 / 5.0 / 3.5 s wall per application |
| Active CPU | 60 s for 19 dry runs + 19 submits ≈ 3 s per application (local form) |
| Fresh install without snapshot | 23 s (npm 1 s, Chromium 9 s, system libraries 12 s, Deno 1 s) + clone 3.7 s |
| Snapshot size | 1.49 GB |
| The cloud worker's own suite in the sandbox | 3/3 pass in 34 s (tests/career-cloud-worker.test.cjs) |

A real employer form is slower than a local one (its scripts, the upload, the response): plan on 30–90 s per application.

**Cost per 1,000 applications (Pro, iad1):** one 2 vCPU / 4 GB sandbox per application, billed ≥ 1 minute of memory:
memory 4 GB × (1–2 min) × $0.0212/GB-h = $1.41–$2.83; active CPU ~10 s × $0.128/h = $0.36; creations $0.0006.
**≈ $1.80–$3.20 per 1,000 applications**, before the Supabase calls (a few per application) and the Pro plan itself.

**Throughput limits (Vercel Pro):** 10,000 concurrent sandboxes; sandbox creation is limited by vCPUs per minute, from
150/min idle (75 two-vCPU sandboxes per minute) ramping by 500/min each minute to 5,000/min (2,500 sandboxes per minute).
At 60 s per application that is up to ~2,500 applications per minute, about 3.6 million a day, once ramped. 1M people at
5 applications a day is ~3,500 a minute at a flat rate; it fits only if each sandbox runs a small batch (3 at a time
measured above) or the limit is raised (Enterprise). The per-host limits will bind long before Vercel does.

## Hosted apply: preparation and sending for a person with only a phone (FEATURE 17)

Nothing below is deployed or applied; go-live ships it when the owner runs it. Proven in
`tests/architect/flow-hosted-apply.test.ts` (the chat, the hosted door, the preparation sandbox, the card, the tap, the
send, the outcome loop, a verification check), `tests/architect/hosted-apply-unit.test.ts` and
`tests/db/career_cloud_hosted_apply.test.sql`.

### How it runs after go-live

```
Telegram/SMS/WhatsApp text "apply me to <link>"  -> agent-chat (FEATURE 1 apply turn: career_apply_wanted, waiting)
  └─ kickPrepare  POST <runner>/prepare  (Authorization: Bearer CAREER_PREPARE_AHEAD_TOKEN; 4 s timeout)
       └─ career_apply_prepare_request_put: only that person's waiting postings; a second kick is the same request
       └─ 202 and, at once (EdgeRuntime.waitUntil), the preparation dispatcher; pg_cron also ticks it every minute
pg_cron "career-cloud-prepare-dispatch"  POST <runner>/prepare-dispatch  (x-cloud-dispatch-secret)
  └─ career_apply_prepare_request_claim(want, global, per person per day, per site per minute)
  └─ one Vercel Sandbox per request: deno run workers/career-cloud/prepare-runner.ts (request id, sandbox id, token, bridge URL)
       └─ prepare-ahead.ts prepareAhead: the engine's dry run on the employer's form, confirmed facts and answers only,
          the resume the person keeps for the cloud byte for byte (career_apply_cloud_resumes); every call via POST <runner>/prep/<op>
       └─ finish: the card of what is ready, pushed now into their thread and outbox (career_apply_card_push_requested_for);
          else the form's questions texted now (career_apply_questions_push_requested_for); else why nothing could be prepared
trainee-deliver (every minute) -> their channel. Their numbered answers -> agent-chat -> prepared again at once (career_hosted_prepare.ts)
Their tap on the card (Telegram button, career_apply_card_answer_as) -> career_apply_jobs (queued, bound to the card's hash)
pg_cron "career-cloud-dispatch"  POST <runner>/dispatch -> career_apply_cloud_dispatch_claim2
  └─ card-cloud jobs through the bridge's own claim, unchanged; then text-card jobs (career_apply_cloud_text_claim_at)
  └─ one sandbox per job: sandbox-runner.ts -> runCloudJob -> scripts/apply.ts --submit --approved <hash>
       └─ authorization before the engine and before the one Submit: career_apply_cloud_authorize_any
       └─ finish -> receipt (career-proactive) -> their channel; "did it go through?" reads the row
```

**Bound on time, phone to card:** the kick dispatches at once; if it does not, the next minute's tick does. Measured in the
flow test on a local copy of Ramp's form: the card queued 9.9 to 13.1 s after the person's last message (5 runs: 9,861 to 13,061 ms), the
engine's dry run being most of it. After the bridge's checks below were added, 18.3 to 27.0 s in 3 runs (18,270 / 21,236 /
27,007 ms; second card 17,447 / 28,930 / 29,048 ms), on the same machine at a load average of 19 to 33 from other runs, so
the two sets are not a like-for-like comparison. The flow test holds the bound at 120 s. In production add sandbox creation (26 ms measured from the snapshot, up to 3 tries
over about 7 s), a real form's own load (the load model above says 30 to 90 s per application), and up to one minute for
delivery. The preparation's lease is 15 minutes and the sandbox's own timeout 13; a request that does not finish inside
its lease is expired, never re-run, and its postings stay in the person's queue.

**What the preparation sandbox may store** (review of #202, F5): the sandbox opens the employer's page, which nobody
trusts, so nothing it sends is trusted. The bridge stores a prepared application only when it is for the link this
request asked for (`career_apply_prepare_request_posting`: the posting's own link in `career_postings`, exactly) and its
card says what it sends (`career_prepared_card.ts`): the employer, every answer in the payload's order as the value sent
(or, for a box, "Yes (checked)"/"No"; for a choice, the person's own confirmed answer that filled it), the kept resume by
name and hash, the page's own fields, a verification line with no words of its own, the destination, the cover note
sent, and nothing else. What it cannot check: which option code of a select stands for the answer shown. A try may not
name a prepared application. The sandbox's token leaves its environment before the engine starts (`takeRunnerEnv`).

**The numbers count postings, not requests:** a request of any size is accepted whole and split into parts of 25
postings, one sandbox each (a batch, never a ceiling: NO LIMITS). Per person per day and per host per minute apply only
when someone set them (unset by default) and count the postings started. A part that fits only in part is split again
(the rest wait in a part of their own, same age, and record why: `per_person_day` or `per_site_minute`); "where are my
applications" says which (`waiting_day_limit`, `starting` "waiting its turn"). LinkedIn and Indeed postings are never taken
(`career_apply_never_automated`). A sandbox that never starts is told to the person (the chat had said it started).


**The text-card route** (finding 1, owner approval of code only, 2026-10-26): a job approved on the card shown in chat is
claimable by the cloud only when every one of these holds at the claim, and again at the authorization before the engine
and before Submit: the owner's kill switch `CAREER_AGENT_SUBMIT = 'on'`, `CAREER_CLOUD_APPLY = 'on'` and `CAREER_CLOUD_TEXT_CARDS = 'on'`
(all off by default); the approved sources' digest unchanged since the worker read them (at the authorization); the job is
exactly the card item's (same person, payload and hash; that number approved and queued; created inside the card's
showing and its answer; under 24 hours old); the account as approved; greenhouse, lever or ashby; an https destination;
the gate open or a live waiver with sends left; the person's opt-in for this account; no pause; under the person's daily
number only if someone chose one (their opt-in number, their own pace, `CLOUD_MAX_PER_PERSON_DAY` when set; Trainee has
no number of its own: NO LIMITS, D-MS-2); no employer cooldown (D-MS-3: only the exact posting is a duplicate); under
`CLOUD_MAX_PER_SITE_MINUTE` for the employer's host, when set; a card of any size (its items are claimed by number); their resume kept for the cloud byte for byte. The claim writes a
marker (`career_apply_cloud_text_claims`) the authorization requires. The gate, the waiver and the bridge are unchanged.

### Secrets and numbers (go-live sets them by name; the values never appear in a log)

| Name | What | Unset |
|---|---|---|
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | the sandbox host | the runner is not wired; it answers 503 |
| `CLOUD_SANDBOX_SNAPSHOT_ID` | the runner snapshot; `--build-snapshot` builds one at `--sha` (one sandbox, about 25 minutes, Vercel spend) | kept |
| `CLOUD_RUNNER_SECRET`, `CLOUD_DISPATCH_SECRET`, `CAREER_PREPARE_AHEAD_TOKEN` | the job/request tokens' key, the ticks' header, the chat's kick | generated (48 characters) |
| `CLOUD_BRIDGE_URL`, `CAREER_PREPARE_AHEAD_URL` | `<project>/functions/v1/career-cloud-runner` and `.../prepare` | derived, never asked |
| `CLOUD_RUNNER_ENABLED`, `CLOUD_PREPARE_ENABLED` | `on` turns sending / preparation on | not touched: off |
| `UPMORE_SCRIPT_SUBMIT_LIVE` | `1` binds a real Greenhouse, Ashby or Lever form's scripted Submit; handed to both sandboxes. Every Ashby form needs it (no `<form>` post) | Ashby postings stop at `SUBMIT_DESTINATION_NOT_BOUND`: no card, no send |
| `CLOUD_MAX_CONCURRENT`, `CLOUD_MAX_PER_PORTAL`, `CLOUD_MAX_STARTS_PER_TICK` | sending: global, per family, per tick | 2, 1, 2 (wave 1) |
| `CLOUD_MAX_PER_PERSON_DAY`, `CLOUD_MAX_PER_SITE_MINUTE` | sending: per person per 24 h, per employer host per minute | no number (NO LIMITS) |
| `CLOUD_PREPARE_MAX_CONCURRENT`, `CLOUD_PREPARE_STARTS_PER_TICK` | preparation: global, per tick | 2, 2 (wave 1) |
| `CLOUD_PREPARE_PER_PERSON_DAY`, `CLOUD_PREPARE_PER_SITE_MINUTE` | preparation: postings per person per 24 h, postings per employer host per minute | no number (NO LIMITS) |

The database switches stay the owner's, by SQL: `insert into career_cloud_settings (key, value) values
('CAREER_AGENT_SUBMIT', 'on'), ('CAREER_CLOUD_APPLY', 'on'), ('CAREER_CLOUD_TEXT_CARDS', 'on') on conflict (key) do update set value = excluded.value;`
(`CAREER_AGENT_SUBMIT` is the owner's kill switch for every route that submits; turning it off stops the text-card route at the
claim and at both authorizations.)

### Sizing (the code's defaults are the runner's capacity; a larger pool is set by name)

The owner's NO LIMITS rule (2026-10-27, D-MS-2/D-MS-3): Trainee has no number of its own on how many applications a person
sends or prepares, and no employer cooldown (only the exact posting is a duplicate). The per-person and per-site numbers
above are left unset; the brake is an outside system refusing (a portal's 429 or bot wall pauses that family, and a check
ends needs_user). The person's own pace, when they set one, still binds. What is sized here is the runner itself:

| | Default | Larger pool | Why |
|---|---|---|---|
| `CLOUD_MAX_CONCURRENT` / `CLOUD_MAX_PER_PORTAL` | 2 / 1 | 5 / 2 | the 2 vCPU sandbox measured 3.5 s per application at 3 at a time on a local form; real forms are 30 to 90 s |
| `CLOUD_PREPARE_MAX_CONCURRENT` | 2 | 5 | |

`select career_apply_cloud_check_rates(7)` shows each host's `bot_check_rate` and `unconfirmed_after_24h` with their
counts: what an outside system is refusing, which is what slows work down.

### How the cloud gate opens (unchanged; read from `career_apply_cloud_open`, 20261021080000)

A family (greenhouse, lever, ashby) opens for the cloud only when **3** of its applications are all of:
1. sent by a person listed in `career_cloud_settings.gate_user_ids` (`'{<owner user id>}'`; none listed: closed);
2. sent from their own computer or the extension (`source in ('own_computer', 'extension')`; a cloud send never counts);
3. `state = 'confirmed'` by the employer's email (`email_confirmed_at` and `confirmation_mail_hash` set by the mail run's
   match, `career_apply_confirm_as`), with that message's `career_mail_events` row (`kind = 'received'`, not flagged) still
   there for the application. A page's "thank you" never counts. Gmail must be connected for the mail run to see it.

Check: `select career_apply_cloud_open('ashby'), career_apply_cloud_report(30);`

**The owner's Ramp run and the gate: two options (finding 2; the owner chooses).**
- **(a) His own computer or the extension, with Gmail connected.** He approves the card in Telegram; his own runner
  (`career_apply_claim_own`, source `own_computer`) or the extension sends it; Ramp's confirmation email, matched by the
  mail run, makes it `confirmed`. With his user id in `gate_user_ids`, it is **1 of the 3** Ashby needs. It does not use
  the cloud sender.
- **(b) The cloud sender under a waiver.** The owner's operator writes one waiver
  (`insert into career_apply_cloud_gate_waivers (user_id, portal, max_sends, expires_at, note) values ('<his id>', 'ashby', 1,
  now() + interval '2 days', 'owner first real run');`), turns both switches on and opts in. It tests the cloud path for real,
  but by design it **does not count** toward the gate (a cloud send never does).

### Verification checks on the hosted path

A visible challenge (reCAPTCHA Enterprise's challenge frame, hCaptcha, Turnstile) at open, review or Submit is detected by
the engine, never solved: the job ends `needs_user` / `bot_check`, nothing reached the employer, it is never retried, it
counts for the throttle on its family, and the person's receipt says, word for word: "Ramp is not finished: a verification
check appeared, and Trainee never solves one, so finish this one yourself: open the link below, enter the answers you
approved on the card, complete the check on the page, then press Submit. Nothing reached Ramp. <link>". An invisible
low score that the employer's server drops silently cannot be seen by the engine; it shows up as `submitted_unconfirmed`
with no email after 24 hours (`unconfirmed_after_24h` in the rates).

## Owner steps (the manual path, for reference; go-live does steps 4 to 6 when VERCEL_TOKEN is given)


1. **Vercel.** In team `team_mn5D4XBK4MgqL0KgNlzvzfky`, project `trainee` (`prj_wU2a8WhzB8x1qIbqx3ChnhAVCIGv`): create an
   access token scoped to the team (Account Settings → Tokens). Set Spend Management on the team.
2. **Migration.** Apply `supabase/migrations/20261026100000_career_apply_cloud_runner.sql` (it is in
   `scripts/launch/trainee-go-live.sh`). If the card-cloud bridge (20261024130000) is applied later, run
   `select public.career_apply_cloud_claim_portal_install();` after it and check
   `select public.career_apply_cloud_runner_missing();` reads `{}`.
3. **Snapshot.** `VERCEL_TOKEN=… VERCEL_TEAM_ID=team_mn5D4XBK4MgqL0KgNlzvzfky VERCEL_PROJECT_ID=prj_wU2a8WhzB8x1qIbqx3ChnhAVCIGv
   deno run -A scripts/cloud-runner/build-snapshot.ts <trunk commit>` prints `SNAPSHOT snap_…`. Rebuild on every engine
   change. Snapshots expire 30 days after last use.
4. **Edge function secrets** (Supabase → Edge Functions → Secrets), by name:
   `CLOUD_RUNNER_SECRET` (random, ≥ 32 characters), `CLOUD_DISPATCH_SECRET` (random), `VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
   `VERCEL_PROJECT_ID`, `CLOUD_SANDBOX_SNAPSHOT_ID`, `CLOUD_BRIDGE_URL` (`https://<project>.supabase.co/functions/v1/career-cloud-runner`),
   and the limits only to raise them past wave 1 (unset, `CLOUD_MAX_CONCURRENT` 2, `CLOUD_MAX_PER_PORTAL` 1, `CLOUD_MAX_STARTS_PER_TICK` 2).
   Optional: `CLOUD_SANDBOX_REGION` (iad1), `CLOUD_SANDBOX_VCPUS` (2). Then `CLOUD_RUNNER_ENABLED=on`.
5. **Deploy** `supabase functions deploy career-cloud-runner --no-verify-jwt` (config.toml sets `verify_jwt = false`; the
   dispatcher checks its header secret, the bridge its per-job token).
6. **Schedule** (SQL, pg_cron + pg_net), every minute:
   `select cron.schedule('career-cloud-dispatch', '* * * * *', $$select net.http_post(url := '<CLOUD_BRIDGE_URL>/dispatch',
   headers := jsonb_build_object('x-cloud-dispatch-secret', '<CLOUD_DISPATCH_SECRET>'))$$);`
7. **Turn it on** only as the database already requires: `CAREER_CLOUD_APPLY = 'on'` in `career_cloud_settings`, the gate
   open per family (3 hand submissions confirmed by email) or a waiver, and each person's opt-in.

**Off:** unset `CLOUD_RUNNER_ENABLED`, or `CAREER_CLOUD_APPLY` to anything but `on` (the claim then returns nothing).

## Mass submission and preparation at scale (2026-10-27)

The VM cloud worker (`workers/career-cloud/worker.ts`) is no longer one loop that takes at most 6. Any number of instances
run against the one database, each running as many applications as its machine holds. They use fair leased claims,
reclaim after a crash, and hold off a site for every instance only when that site refuses (429, Retry-After, or a
verification check). There is no number of ours. The preparation host (`prepare-ahead.ts`) makes preparation reachable
for a person with only a phone (audit B2). Runbook, env names and the owner's steps: **docs/launch/MASS-SUBMISSION.md**.
The sandbox dispatcher above is unchanged.

## What the database still limits today (not changed here)

- The cloud gate: a family opens only after 3 hand submissions by the owner's gate testers, each confirmed by the
  employer's email; until then only waivers (one person, one family, at most 5 sends, at most 7 days).
- The draft card-cloud bridge (20261024130000), which the live authorization needs, allows one enrolled person at a time
  (`career_cloud_card_one_enrollment`) plus test users, and 15 cloud sends a day. At 1M people that is the owner's policy
  to change; the runner scales only as far as those rules let jobs through.
- The throttle pauses a whole family for 6 hours at 2% failures in its last 50 attempts. With datacenter checks, expect
  it to pause often; that is by design.
