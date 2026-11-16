# Sandbox spike 2: results (2026-11-16 00:3x UTC)

Run by the architect with the owner's written approval (2026-11-15, in chat: "i approve u to work on alll of this", covering the
Vercel credential). Plan: `SANDBOX-SPIKE-2-PLAN.md`. Script: `scripts/spikes/sandbox-spike-2.ts` (refuses without
`--yes-owner-approved`, refuses in CI). Raw output: `scripts/spikes/sandbox-spike-2/result-20261116.json`.

- SDK `npm:@vercel/sandbox@3.9.1` (4.0.0 was 3 days old and not used), Deno, from a laptop in the US Central time zone,
  project `trainee`, default region.
- Credential: `VERCEL_OIDC_TOKEN` from `vercel env pull` in a scratch folder outside the repo; the pull wrote only that one
  variable. It never entered the VM (see "env" below), went through no chat, and is not committed.
- Every sandbox: 1 vCPU, `persistent: false`, `deny-all` unless stated, 60 s timeout (20 s in F), `stop()` in `finally`.
- Fixture: written fresh for this spike (`scripts/spikes/sandbox-spike-2/`): `ledger.py` (in-memory `sqlite3` job ledger) and
  `test_ledger.py`, exactly 40 `unittest` tests; three mutants (`<` to `<=`, even median, foreign keys off). Locally:
  `Ran 40 tests ... OK`; mutants FAILED (errors=3), (failures=1), (failures=2).

## Timings (5 repetitions each; milliseconds from the calling process)
| Run | What | Median | Worst |
|---|---|---|---|
| A | cold `create()`, `vercel/sandbox/python:3.14` | 201 | 345 |
| A | first command (`python3 -c "print(1)"`) | 196 | 216 |
| B | cold `create()`, default `universal` image | 173 | 182 |
| B | first command | 146 | 248 |
| D | create + write bundle + 40 tests + read result | **770** | **983** |
| E | create + real code + 3 mutants in one session | 2175 | 3408 |

D passed 5/5 (exit 0, "OK"); in E the real code passed and every mutant failed with the expected counts, every time.
Proposed 124g bar (median D <= 15 s, worst <= 30 s): **met by a factor of about 20**. Run C (a pytest snapshot) was not run:
the suite uses `unittest` from the standard library, cold create is already about 0.2 s, and a snapshot adds storage
cost, so 124g should not use one.

## Run F: output size and the session timeout
- A 2 MB stdout returned whole (exit 0, 266 ms).
- **Finding for 124g:** when the session timeout (20 s) passes during a command, `runCommand` does NOT reject. It resolves
  after about 19.7 s with exit code **143** (SIGTERM) and empty output. 124g must therefore report any exit other than
  0, and any run without the test runner's own success line, as "tests not run (timed out)" or failed, never passed;
  a rejection is not the only failure signal.

## Network deny (`deny-all`): every route out failed
| Probe | Exit | Result |
|---|---|---|
| DNS, system resolver (`getent hosts example.com`) | 2 | no answer |
| DNS, raw UDP to 8.8.8.8:53 | 1 | timed out |
| DNS, raw UDP to 1.1.1.1:53 | 1 | timed out |
| HTTPS by name | 6 | could not resolve host |
| HTTP by name | 6 | could not resolve host |
| HTTPS by raw IP (1.1.1.1) | 28 | connection timed out |
| TCP 1.1.1.1:443 / :80 | 1 / 1 | timed out |
| IPv6 (2606:4700:4700::1111) | 7 | could not connect |
| ICMP | 127 | `ping` is not installed in the image (not a network result) |
| Cloud metadata 169.254.169.254 | 28 | timed out |
| `pip download requests` | 1 | no distribution found |

Control (`allow-all`, once each): DNS resolved example.com (exit 0) and HTTPS returned 200, so the probes work.
`env` inside the VM held only CA-bundle paths, `HOME`, `LANG`, `PATH`, `PWD`, `SHELL`, `SHLVL`; no `VERCEL_*` token or other
secret, and no file under `/vercel` mentions one. The "update the policy from inside the VM" check needs a credential the VM
does not hold, which is the property that matters.

## Cost
Model spend: none (no model call; the $93 ledger is untouched). Vercel Sandbox: 30 creations in all (7 in a one-repetition
smoke run, 23 in the full run) and under 3 vCPU-minutes by the script's own upper bound; the Usage page had not yet
updated when this was written (Sandbox lines unchanged at $0.0329 billed for the month). At list prices this is well under
$0.05.

## What 124g takes from it
`runInSandbox(bundle, cmd)`: `vercel/sandbox/python:3.14`, 1 vCPU, `deny-all`, not persistent, a timeout of about 60 s,
`stop()` in `finally`, no snapshot; pass only on exit 0 plus the runner's success line; exit 143 or a rejection gives "tests
not run (timed out)"; the credential stays in the edge function's environment (production `VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
`VERCEL_PROJECT_ID` as Supabase secrets, created when 124g ships). The 15.88 MB SDK still needs the edge-function size check.
