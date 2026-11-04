# The apply VM: owner runbook (2026-10-28)

One small VM that sends approved applications for many people at once, with our own browsers (no Browserbase). A phone-only
person says "apply me to <link>", approves the card, and this VM fills and submits it. Without it, Apply only queues.

Nothing here is deployed, no migration is applied, no credential exists and no employer was contacted while building it.
Everything below is a thing YOU do. Where a number appears it says whether it was measured and where.

## 0. What it is, and what it is not

- `workers/career-browser/apply-vm.cjs` (the loop) + `parallel-apply.cjs` (PR #262, the form driver) + `docker/apply-vm/` (image + compose).
- `supabase/migrations/20261028180000_career_apply_vm_worker.sql` (the database side; you apply it, or nobody does).
- Greenhouse-style and Lever-style forms only. Ashby submits from page script (a person must press Submit) and is not driven.
  LinkedIn, Indeed and Handshake are refused in the database and again in the worker. Workday, iCIMS, Taleo, SuccessFactors, Oracle
  and similar sign-in portals are handed to the person (section 9). Any other host stays queued and is reported as "not supported yet".
- Rules that do not move: the person approved the exact payload (the worker re-hashes it and refuses any difference); one resume
  per person (the worker re-hashes the file); facts and answers only from the approved payload, a required question with no answer
  stops the item as "needs you"; no captcha is ever solved; no account is ever created and no password or one-time code is ever
  handled; no model call; no number of ours limits volume (D-MS-2), only a portal that refuses slows that portal.

## 1. Cost and size

| | Hetzner | AWS |
|---|---|---|
| Suggested first VM | CPX32-class, 4 vCPU / 8 GB (D-010) | `c6i.xlarge` 4 vCPU / 8 GB, or `t3.large` 2 vCPU / 8 GB to start |
| Rough price (CHECK it at checkout, prices change) | about EUR 15 to 25 / month | about USD 125 / month on demand (`c6i.xlarge`), about USD 60 (`t3.large`) |
| Disk | 40 GB is plenty (screenshots are deleted after 30 days) | 30 GB gp3 |

Per application: no model spend, no per-application fee. Supabase compute and egress are unchanged apart from about 10 small RPC calls
per application. A second VM doubles the price and the capacity (section 8).

## 2. Capacity math (measured on a 2-vCPU / 8 GB machine that also ran Postgres and the test harness)

Browser path, real headless Chromium on the local mock Greenhouse/Lever forms, through the real worker and a real database
(`scripts/career/apply-vm-loadtest.cjs --skip-sim`, 90 applications each):

| Run | Concurrency | Throughput | Per application p50 / p95 |
|---|---|---|---|
| mock employer answers instantly | 6 | 4.0 apps/s | 1.4 s / 1.6 s |
| mock employer adds 1.5 s to the page and to Submit | 12 | 3.0 apps/s | 3.8 s / 4.6 s |

- The CPU-bound figure is about 4 apps/s on 2 shared vCPUs: roughly **2 apps/s per core, about 7,000 apps/hour per core** with Postgres
  and the harness stealing part of that CPU. A real VM runs no Postgres, so this is conservative for our side of the work.
- Real employer pages are heavier than the mock (scripts, trackers, larger documents) and answer slower. Plan with a third of the
  measured figure: **about 2,000 to 2,500 apps/hour per core; a 4-vCPU VM about 8,000 to 10,000 apps/hour.** Not measured against any real
  employer (the staged plan below measures one posting). If a real portal is heavier than assumed, the number falls and the plan below shows it on posting 1.
- Memory is the other limit: about 450 MB per Chromium context is the repo's own figure (`mass-run.ts`, not re-measured here), so an 8 GB
  VM holds about 12 to 14 at once. The default concurrency is what free memory holds; set `APPLY_VM_CONCURRENCY` lower if the VM swaps.
- Waiting on an employer is cheap and a core is not: with slow portals raise concurrency to about 3 per core before CPU is the limit.

Scheduling path (the database, the claim, the leases, fairness) with the browser replaced by a 50 ms stand-in, 4 workers x 16 at once,
**1,001 people, 20,500 queued applications (1,000 people x 20, plus one person with a 500-item batch queued last)**:

| Measure | Result |
|---|---|
| Throughput | 205 applications/s, all 20,500 done in 100 s, none lost, none twice |
| Per application, claim to finish, p50 / p95 / max | 221 ms / 372 ms / 1.1 s (50 ms of that is the stand-in) |
| Time until every person had their first item claimed (max wait) | 9.7 s (p50 4.9 s, p95 9.2 s) |
| Fairness: items finished per person when half of everything was done | min 10, max 12 of 20 (Jain index 0.998) |
| The 500-item person | finished last (99.4 s) and delayed nobody: everyone else finished by 97.6 s |
| Claims split across the 4 workers | 5081 / 5099 / 5175 / 5145 |

This proves the database side holds many people at once with one Postgres on 2 shared vCPUs. It does NOT prove Chromium throughput at
that scale: 205/s is the queue, not the browsers (the table above is the browsers).

A scale bug the test found, fixed in the migration: an existing trigger (`career_apply_jobs_confirmation`) scanned the whole queue on every
confirmation write (190 ms at 20,000 rows, growing with the table), which capped the first run at 10 apps/s. It now uses its index (about 1 ms).

## 3. Accounts you need (one time)

1. A Hetzner Cloud account (or AWS). Add a payment method. Create ONE project. You decide and pay; nothing else needs an account.
2. Your Supabase project (existing). You need its dashboard (SQL editor, Settings > API > JWT Secret). You do NOT give the VM the service key.
3. This repo's GitHub (read access is enough to clone; the VM holds no push key).

## 4. Supabase side (you do this, from your own computer)

1. Review and apply `supabase/migrations/20261028180000_career_apply_vm_worker.sql` (SQL editor or your usual migration step). It adds
   columns, the `apply_vm_worker` role (can run the VM functions and read no table), the claim/heartbeat/resume/complete/reap/triage functions,
   the status functions and one performance fix. Everything is OFF until step 3.
   It needs the card-cloud bridge (`20261024130000`) applied first: the VM claims a row only with a stored approval from the bridge (bound to the
   person and the exact payload hash, not revoked, not expired; `cloud_bound_refusal`), and a row without one is closed `NOT_APPROVED` and never
   leased. An enqueue alone, or a hash the enqueuer wrote, is not an approval. Without the bridge nothing is approved (it fails closed). The
   same check runs again in the heartbeat that precedes the Submit click, so a revoke or expiry after the claim stops the item. The bridge's
   eligibility list (`test_users`, or its enrollment) still applies: it is the bridge's own rule for who a card-bound row may be sent for.
2. Mint the worker's key on your own computer (the secret never touches a file, the repo or chat):
   `SUPABASE_JWT_SECRET='<paste from Settings > API>' node scripts/launch/mint-apply-vm-jwt.cjs 90`
   It prints a JWT with role `apply_vm_worker`, valid 90 days. If your project signs with the newer asymmetric keys, PostgREST will not accept it:
   then use the service role key for stage 1 ONLY and tell me; that is not least privilege.
3. Turn it on, narrowly, in the SQL editor. Stage 1 and 2 (dry run, drills):
   ```
   insert into career_cloud_settings(key,value) values ('APPLY_VM','on'),('APPLY_VM_USER_IDS','<your user id>'),('APPLY_VM_ALLOW_LOCAL','on')
     on conflict (key) do update set value = excluded.value, updated_at = now();
   ```
   `APPLY_VM_USER_IDS` is who the VM may send for ('*' later means every person who said yes to cloud sending in chat). `APPLY_VM_ALLOW_LOCAL`
   lets it open mock forms on the VM itself; turn it off (`'off'`) before stage 3.
4. The kill switch, any time: `update career_cloud_settings set value='off' where key='APPLY_VM';` The worker re-checks it, and that the account is
   still current, in the same database call that records "submitting", right before it clicks Submit. Items in flight finish; nothing new starts.

## 5. The VM (exact commands)

Create an Ubuntu 24.04 VM (Hetzner: Cloud > Add Server > Ubuntu 24.04 > CPX32 > your SSH key; AWS: launch instance, same image, no inbound ports but SSH).
Inbound: SSH from your IP only. The worker makes outbound HTTPS calls only.

As root:
```
apt-get update && apt-get install -y ca-certificates curl git ufw docker.io docker-compose-v2
ufw default deny incoming && ufw allow OpenSSH && ufw --force enable
git clone https://github.com/srikanthvishnu90-sketch/upmore-agent.git /opt/upmore-agent
cd /opt/upmore-agent && git checkout <the merged branch or this PR's branch>
# Chromium's sandbox needs this profile (Playwright's own). Use the file from the Playwright tag that matches the image (1.64.1):
curl -fsSL -o docker/apply-vm/seccomp_profile.json https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/utils/docker/seccomp_profile.json
install -d -m 700 /etc/apply-vm
install -m 600 docker/apply-vm/worker.env.example /etc/apply-vm/worker.env
nano /etc/apply-vm/worker.env     # SUPABASE_URL and APPLY_VM_KEY (type or paste them yourself)
```
Environment variables (all in `/etc/apply-vm/worker.env`, never in the repo): `SUPABASE_URL`, `APPLY_VM_KEY` (required); `APPLY_VM_ALLOW_HOSTS`
(empty for the dry run; later `boards.greenhouse.io,job-boards.greenhouse.io,jobs.lever.co`); optional `APPLY_VM_CONCURRENCY`, `APPLY_VM_PER_USER`,
`APPLY_VM_HOST_MAX`, `APPLY_VM_HOST_SPACING_MS`, `APPLY_VM_WORKER_ID`; `APPLY_VM_CHROMIUM_SANDBOX=on` (never `off` on this VM).

Build, then start the worker with the mock forms (dry run profile):
```
cd /opt/upmore-agent
docker compose -f docker/apply-vm/docker-compose.yml build
docker compose -f docker/apply-vm/docker-compose.yml --profile dryrun up -d
docker compose -f docker/apply-vm/docker-compose.yml logs -f worker      # APPLY_VM_START ..., then APPLY_VM_STATS every minute
```
The image and compose file were NOT built or run when written (no Docker daemon in that session). The worker code itself ran against real Chromium
and real Postgres in the tests below, with Chromium's sandbox off because that session ran as root. Expect to fix one or two Docker details on the first build, in stage 1, where nothing real is at stake.
Stop: `docker compose -f docker/apply-vm/docker-compose.yml stop` (no new claims; in-flight applications finish and are recorded; up to 5 minutes).

## 6. Staged first run (do not skip a stage)

**Stage 0: unit proof, on your computer or CI.** `node --test tests/career-apply-vm.test.cjs` (needs Postgres 16 and Playwright; builds a throwaway database in about a minute).
It must be 9/9. Nine tests: switch off by default, least privilege, two or three workers never claim the same item, fairness, refusals, honest outcomes and dead workers, hash refusal, end to end on mock forms with a bot check and a 429, sign-in wall.

**Stage 1: dry run against local mock forms (no employer).** On the VM with the `dryrun` profile up and `APPLY_VM_ALLOW_LOCAL=on`:
1. Upload your resume the way the cloud already does: `deno run -A workers/career-browser/approve-first.ts cloud-resume <resume.pdf>` (from your own computer).
2. Paste `scripts/career/apply-vm-dryrun-seed.sql` into the SQL editor after putting your user id on the marked line. It queues five approved test applications aimed at `127.0.0.1:8787`.
3. Watch: `select job_id,state,reason,vm_phase,vm_worker from career_apply_jobs where job_id like 'DRYRUN-%' order by job_id;`
   Pass = all five `submitted_unconfirmed` (never `confirmed`: only the employer's email does that), `select jsonb_pretty(career_apply_status_for('<your id>'))` says `submitted` with a confirmation code,
   and the mock received five submissions (`docker compose ... exec worker node -e "fetch('http://127.0.0.1:8787/__submissions').then(r=>r.json()).then(s=>console.log(s.length))"`).

**Stage 2: drills (still mock).** (a) `docker compose ... kill -s SIGKILL worker` mid-run, start again: items that were not yet at Submit return to the queue after about 2 minutes and finish; none that had reached
Submit is re-sent (they show `unknown_outcome`). (b) Set `APPLY_VM` to `'off'`: nothing new is claimed. (c) Re-run the seed with a job whose URL is `/greenhouse/bot1` or `/lever/login1`: the item stops as `needs_user` / `bot_check` or `login_required`.

**Stage 3: ONE hand-picked real posting, with your explicit approval.** Not before stages 1 and 2 are clean.
1. Choose one Greenhouse or Lever posting for a role you actually want, for you only.
2. Write to the architect: "approve the real-posting test: <exact link>". Nothing real is sent without that written yes.
3. Set `APPLY_VM_ALLOW_LOCAL` to `'off'`; put exactly that posting's host in `APPLY_VM_ALLOW_HOSTS` (for example `jobs.lever.co`); restart the worker.
4. Apply through the product so the card shows the exact payload; approve it yourself. Watch the log and the status function. Check the employer's confirmation email arrives (that is what makes it `confirmed`).
5. Record what you saw: seconds from approval to submitted, whether the form filled correctly, the bot-check behavior. These replace the guesses in section 2.

**Stage 4: widen.** Only after stage 3 is clean: a few more of your own postings, then `APPLY_VM_USER_IDS='*'` (people who turned cloud sending on in chat), and more VMs. The Lever/Greenhouse gate rules in `docs/launch/CLOUD-WORKER.md` are separate; decide in writing whether this path honors them.

## 7. Many people at once: how it behaves

- **Fairness.** The claim serves the longest-waiting people first, `APPLY_VM_PER_USER` items each (default 1), and more each when fewer people wait. A 500-item batch
  gets the same share per round as a person with 3 items (measured in section 2).
- **Isolation.** Every attempt is a fresh browser context: no cookies or storage cross people or attempts (the end-to-end test checks the cookie on every submission). Each application's resume is written to a private folder of its
  own and deleted after; the resume bytes come from that person's own row and must hash to the resume their approval names. A worker holds a lease on one row and cannot touch another worker's.
- **Per-portal politeness without a cap.** The worker can limit engines per host (`APPLY_VM_HOST_MAX`) and space starts (`APPLY_VM_HOST_SPACING_MS`); the default is neither (D-MS-2). What slows a portal is that portal refusing:
  a 429, a 5xx page, or a verification check records a hold-off in the database (30 s doubling to an hour, or the portal's own Retry-After) that EVERY worker on EVERY VM honors, and the claim skips that host until it expires.
  A 429 is not asked again by the same item.
- **Stateless workers.** The database holds every lease. Add capacity by running the same compose file on another VM with its own env file and its own `APPLY_VM_WORKER_ID`.

## 8. Operating it

- Status the bot should read: `career_apply_status_for(user, job_id)` (service) or `career_apply_my_status(job_id)` (signed-in person) returns `queued`, `preparing`, `sending`, `submitted`, `confirmed`, `needs_you`, `not_sent` or `unknown`
  with a machine `detail` code and, for `submitted`, the confirmation code and the screenshot hash. `submitted` means the employer's page showed a confirmation; `confirmed` only after the employer's own email.
  `unknown` means it may or may not have been sent and it will not be retried: tell the person to check their email.
- The proof: a small confirmation-page screenshot is stored in the row when it is under 36 KB (`evidence.proof.after_png_b64`); every screenshot (including the filled form) is kept on the VM under the `apply-vm-evidence` volume with its hash in the row.
  Delete old ones: `docker compose ... exec worker find /var/lib/apply-vm/evidence -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} +`.
- Rotate the key: re-run the mint script, edit `/etc/apply-vm/worker.env`, `docker compose ... up -d`.
- Logs: one line per problem, `APPLY_VM_STATS` each minute; never an answer or a fact.

## 9. Sites that need the person to sign in (account-gated portals): the employer login handoff

The product never creates an employer account and never sees a password or a one-time code. Today (built and tested):
1. The database refuses to queue-drive Workday, iCIMS, Taleo, SuccessFactors, Oracle, UltiPro, Dayforce, BrassRing, ADP and Paycom links: the item becomes `needs_you` / `login_required` with the link,
   and says plainly that nothing was sent. A Greenhouse or Lever form that unexpectedly shows a password box does the same (the worker never types into it).
2. The person signs in and finishes it in their own browser at the link (the existing own-computer path). Nothing else is claimed to have happened.

Designed, NOT built (it needs a product decision and a security review; the database half exists): a **secure handoff page** for portals the VM could otherwise fill once signed in.
- The worker opens the portal in the person's own persistent browser context on the VM and stops at the sign-in wall (`needs_you`).
- The person opens a one-time, short-lived link to a remote view of THAT context (not a chat), signs in and completes any verification THEMSELVES on the employer's own page, then closes the view.
  Passwords and codes go from their keyboard to the employer's page only; the product records neither.
- The page calls `career_apply_vm_handoff_requeue(user, job)`; the worker resumes the same context, and it is then claimed like any item (a fresh approval hash check, "submitting" recorded before the click).
- Needs: a remote-browser view with its own authentication and expiry, a per-person encrypted browser profile that is deleted on erase, and your yes on keeping an employer session on our VM. None of it is in this PR.

## 10. Honest limits (read before relying on it)

- **Unproven against any real employer.** Everything above ran on local mock forms. Real Greenhouse and Lever pages have more fields (custom questions, EEO, location pickers) than the mock; the worker stops
  and asks (`needs_you`, naming the field) rather than guess. Expect a meaningful share of real postings to stop that way until the answers a person confirmed cover their typical questions.
- **Bot checks on a datacenter address are not measured** (NOT_RUN, as in CLOUD-WORKER.md). A check stops the item and holds that portal off for everyone; it is never solved. If a portal challenges a VM address often, throughput there is near zero and the fix is not ours to buy around.
- **The Docker image and compose file have not been built.** The seccomp profile is fetched at deploy time and not reviewed here.
- **Greenhouse and Lever script-submit variants** (where the page needs a person's click) are not driven; Ashby is not driven.
- **Throughput numbers are from a 2-vCPU test machine** that also ran Postgres, not from your VM, and from mock pages. The 205 apps/s is the queue, not the browsers.
- **`submitted` is the employer page's word.** Only the employer's email makes `confirmed`; email matching is the existing path (WO-032) and was not exercised here.
- **Screenshots stay on the VM** (30-day cleanup is yours to run) except the small confirmation image kept in the row.
- **Not wired in this PR:** the go-live script's migration list and `tests/db/run.sh` do not yet list the new migration; the bot's text for each status is the model's to write from the status codes, not canned here.
