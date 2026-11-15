# Sandbox spike 2: Vercel Sandbox latency and network deny (plan, 2026-11-15)

Owner ruling D-087 (2026-11-15): code and tests in a person's work artifacts run in Vercel Sandbox. Before WO-124g builds on
it, this second spike measures two things: how long a test run takes end to end, and whether *all* outbound network from
the VM is blocked. This file is the plan only. Nothing here has run against Vercel.

## What blocks running it: a credential, which is the owner's
The SDK (`npm:@vercel/sandbox`) authenticates the process that calls it. It does not authenticate the VM. The calling process
needs one of:
- **Local run (recommended for the spike):** a `VERCEL_OIDC_TOKEN`, written into `.env.local` by `vercel link` and then
  `vercel env pull` in a scratch folder linked to the `trainee` project. The token is valid for about 12 hours. The owner
  runs those two commands. The token never goes through chat and is never committed. `.env.local` is outside the repo.
- **From a Supabase edge function (needed for 124g, not for this spike):** `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and
  `VERCEL_PROJECT_ID` as Supabase secrets. That is a production credential, so the owner creates it after this spike.

Already checked at $0, with no credential (2026-11-15, Deno 2.9.6):
- `npm:@vercel/sandbox` loads in Deno and exports `Sandbox`.
- `Sandbox.create()` with no credential refuses with `LocalOidcContextError` before any sandbox exists, so nothing is
  created or billed by accident.
- The package and its dependencies are 15.88 MB (`deno info`). The spike must also check that an edge function bundling
  it still fits Supabase's function size limit.

## Cost: designed to fit in included usage, and confirmed before running
Vercel Sandbox is billed for active vCPU time, memory, sandbox creations, outbound data and snapshot storage. The plan
keeps every run at 1 vCPU, `persistent: false` (no snapshot storage, except in run C below, which deletes its snapshot),
a 60-second session timeout and `stop()` in a `finally`. Downloads into the VM are free; nothing is served from it.
- **Budget:** at most 40 sandbox creations and about 20 vCPU-minutes in total.
- **Before running:** the owner checks the included Sandbox usage on the account's plan (Vercel dashboard, Usage). If
  this budget is not inside it, the spike is model-free but not $0, and it needs the owner's written yes to the amount.
- **Not touched:** the $93 model ledger (D-085). The spike makes no model call.

## Runs (each repeated 5 times; report the median and the worst)
Setup for every run: `Sandbox.create({ image, resources: { vcpus: 1 }, persistent: false, networkPolicy: "deny-all",
timeout: 60_000 })`, then `stop()` in `finally`. Timings use `performance.now()` around each call, from the calling
process. The region is the project default, and it is recorded.

| Run | What | Measured |
|---|---|---|
| A | Cold create, `vercel/sandbox/python:3.14` | `create()` until resolved; `runCommand("python3", ["-c", "print(1)"])` round trip |
| B | Cold create, default `universal` image | the same, to compare image size against boot time |
| C | Create from a snapshot holding pytest (built once in a separate sandbox allowed `pypi.org` and `files.pythonhosted.org` only, then deleted) | `create()` from the snapshot; time to the first command |
| D | The 40-test bundle from spike 1 (`SANDBOX-SPIKE.md`): `writeFiles`, then `python3 -m pytest -q` | write, run, read `stdout`, `exitCode`; total time from the tool's point of view |
| E | D plus its mutation controls (D3: each mutant must fail), run in one session | total time for real code + N mutants |
| F | A 2 MB output and a test that sleeps past `timeout` | that a session timeout rejects `runCommand` and is reported "tests not run (timed out)", never as passed |

Pass bar for 124g (proposed; the owner can change it): median run D at 15 s or less from the tool's call, worst at 30 s
or less. Over that, a bundle's tests run after the reply ("tests are running; I'll send the result"), never blocking a turn.

## Network deny: every route out must fail
In a `deny-all` sandbox, each probe below runs through `bash -c` with a 5-second timeout and must fail. The exit code and
stderr are recorded for each.

| Probe | Command (inside the VM) |
|---|---|
| DNS (system resolver) | `getent hosts example.com` |
| DNS (direct UDP) | `python3 -c` sending a raw DNS query over UDP to 8.8.8.8 and to 1.1.1.1 port 53 |
| HTTPS by name | `curl -sS --max-time 5 https://example.com` |
| HTTP by name | `curl -sS --max-time 5 http://example.com` |
| HTTPS by raw IP | `curl -sSk --max-time 5 https://93.184.215.14` (and an IP read from the host, since DNS is blocked) |
| Raw TCP | Python `socket.create_connection(("1.1.1.1", 443), 5)` and port 80 |
| IPv6 | `curl -6 --max-time 5 https://[2606:4700:4700::1111]` |
| ICMP | `ping -c1 -W2 1.1.1.1` |
| Cloud metadata | `curl --max-time 3 http://169.254.169.254/` and `http://169.254.169.254/latest/meta-data/` |
| Through a package tool | `pip download requests --no-deps -d /tmp/x` |
| Credential in the VM | `env` contains no `VERCEL_OIDC_TOKEN`, `VERCEL_TOKEN` or other secret, and `/vercel` has none |

Control, so a pass is not a broken probe: the same probes in an `allow-all` sandbox must succeed (HTTPS, DNS). Each
probe is run once there.

Also checked: after `sandbox.update({ networkPolicy: "allow-all" })` is called from *inside* the VM, nothing changes. The
VM holds no credential, so it cannot call the API. That is the property that matters: a person's code cannot open its
own network.

## Output
`docs/architect/specs/SANDBOX-SPIKE-2.md`, with:
- the table of timings for runs A-F;
- the probe table with each result;
- the region and SDK version;
- the sandbox creations and vCPU-minutes actually used, read from the Usage page, so the cost is real and not estimated.

The spike script lives in `scripts/spikes/sandbox-spike-2.ts`. It refuses to start unless `--yes-owner-approved` is
passed, and it never runs in CI. No product code changes in this spike.

## What 124g takes from it
- `runInSandbox(bundle, cmd)` uses the settings above: 1 vCPU, `deny-all`, not persistent, a short timeout, and stop in
  `finally`. It uses the snapshot image only if run C is clearly faster.
- A timeout or a create failure gives a "not run" check with its reason (D8), never a pass.
- The credential is read only in the edge function's environment, never passed into the VM (`env` stays empty).
