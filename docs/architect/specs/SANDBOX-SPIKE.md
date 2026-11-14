# Sandbox spike: Pyodide inside a Supabase edge function (WO-124f, 2026-11-14)

This is a measurement only. It cost $0, adds no product code and opens no account or credential. It answers the open
decision in `WORK-ARTIFACTS.md` ("where code runs"): can Trainee run a person's code bundle (Python standard library plus
`sqlite3`, about 40 `unittest` tests) inside a Supabase edge function using Pyodide?

**Short answer: not as a plain cold load.** A cold Pyodide load alone uses 3.3 to 4.6 s of CPU, against a documented
2 s CPU limit per request. A memory snapshot (a private Pyodide API) cuts the load to about 0.45 s of CPU, but then peak
RSS reaches 240 to 270 MB, against a 256 MB cap, and the snapshot is 31 MB, against a 20 MB function size cap. The
sandbox also leaks: Python code can reach `globalThis` (and so `fetch` and `Deno.env`) unless Deno permissions are
revoked. Nobody has verified that the hosted Edge Runtime allows that revoke. The recommendation is in section 6.

## 1. Documented Supabase Edge Function limits

Source: <https://supabase.com/docs/guides/functions/limits>. It was read on 2026-11-14 through the Supabase docs
search, because the session's network does not reach supabase.com directly.

| Limit | Value |
|---|---|
| Maximum memory | 256 MB |
| Maximum duration (wall clock, the worker's lifetime) | Free 150 s, paid 400 s |
| Maximum CPU time | 2 s per request (CPU only, not async I/O) |
| Request idle timeout | 150 s (then 504) |
| Maximum function size | 20 MB after bundling with the CLI |
| Other | No Web Worker or Node `vm` API. Static files can't be deployed with the API flag (Docker CLI build only). No multithreaded Node libraries. |

The docs disagree on CPU time. The troubleshooting page
<https://supabase.com/docs/guides/troubleshooting/edge-function-cpu-limits> (and its KB copy
<https://supabase.com/kb/troubleshooting/edge-function-cpu-limits>) describes a budget of about 200 ms of active CPU.
Going over the CPU or memory limit returns 546 `WORKER_RESOURCE_LIMIT`
(<https://supabase.com/docs/guides/troubleshooting/edge-function-546-error-response.md>). This report uses the more
generous 2 s figure. Every conclusion below still holds, and gets stronger, if the real budget is 200 ms.

## 2. Setup

- Deno 2.9.6 (`deno --version`: v8 15.0.245.2, TypeScript 6.0.3), on Linux x86_64 with 4 cores and 16 GB of RAM. This
  is a cloud dev container, not Supabase hardware.
- Pyodide `npm:pyodide@314.0.7`, published 2026-09-14 (two months old). That release has Python 3.14.2 and SQLite
  3.39.0. `sqlite3` is in the core build, and no `loadPackage` is needed. A newer release, 314.0.8, came out on
  2026-11-13 and was not used because it is less than two weeks old.
- The fixture is written fresh for this spike, with invented data: `ledger.py`, a 74-line job-application ledger on
  in-memory `sqlite3` (schema, foreign keys with cascade, stage machine, funnel rates, median, search, date range). It
  has `test_ledger.py`, an exactly 40-test `unittest` suite. Natively (CPython 3.13) it reports `Ran 40 tests ... OK`.
- Mutation controls (D3): three corrupted copies of `ledger.py`:
  1. `<` becomes `<=` in the "cannot move backwards" check;
  2. the even-count median returns the upper middle value;
  3. `PRAGMA foreign_keys = ON` is removed.
- The runner (`run.ts`, appendix A) loads Pyodide, writes the bundle into Pyodide's in-memory FS, and runs the suite.
  It can run several variants in one process. It reports wall time, CPU from `process.cpuUsage()`, and RSS. Peak RSS
  is the child's `ru_maxrss`, measured by a small Python wrapper (`measure.py`), because `/usr/bin/time` isn't
  installed. CPU is the sum across all process threads, and V8 compiles WASM on background threads, so it can exceed
  wall time. The `--v8-flags=--single-threaded` runs give the figure closest to one core's CPU budget.

Commands (from the runner directory, with the npm cache warmed once by `deno cache --allow-scripts run.ts`):

```
python3 measure.py --allow-read --deny-net --allow-env run.ts ../bundle none                 # cold, real code
python3 measure.py --allow-read --deny-net --allow-env run.ts ../bundle none,1,2,3,none,none,none  # real + mutants + warm reruns
python3 measure.py --v8-flags=--single-threaded --allow-read --deny-net --allow-env run.ts ../bundle none
python3 measure.py --v8-flags=--liftoff-only   --allow-read --deny-net --allow-env run.ts ../bundle none
taskset -c 0 python3 measure.py --allow-read --deny-net --allow-env run.ts ../bundle none
deno run --allow-read --allow-write --deny-net --allow-env snap.ts make ../snap.bin && gzip -9k ../snap.bin
python3 measure.py --allow-read --deny-net --allow-env run.ts ../bundle none,1,2,3 --snapshot=../snap.bin.gz
deno run --allow-read --allow-net --allow-env run.ts ../bundle none --probe-net [--strip-js]
deno run --allow-read --allow-net --allow-env revoke.ts [--revoke]
```

Every run in the tables below used `--deny-net`, so the npm package loads fully offline from the Deno cache.

## 3. Results

### 3.1 Correctness
| Variant | Ran | Result | Failing tests |
|---|---|---|---|
| real code | 40 | OK | none |
| mutant 1 (`<` to `<=`) | 40 | FAILED (1 error) | `test_advance_same_stage_ok` |
| mutant 2 (median) | 40 | FAILED (1 failure) | `test_median_even` |
| mutant 3 (no foreign keys) | 40 | FAILED (2 failures) | `test_fk_enforced`, `test_remove_cascades` |

Pyodide runs stdlib `unittest` and `sqlite3` correctly, and the suite catches every mutant.

### 3.2 Cold load, plain `loadPyodide()` (no snapshot)
| Mode | Load wall | Load CPU | 40-test run wall / CPU | Peak RSS |
|---|---|---|---|---|
| default, 4 runs | 2.03-4.06 s (first run 4.06 s, then about 2.1 s) | 3.5-4.6 s | 0.26-0.46 s / 0.32-0.51 s | 190-216 MB |
| `--single-threaded`, 2 runs | 3.57-3.59 s | 3.27-3.57 s | 0.40-0.50 s / 0.40-0.50 s | 148-161 MB (in-process RSS) |
| `--liftoff-only`, 2 runs | 3.32-3.37 s | 3.38-3.42 s | 0.56-0.65 s / 0.56-0.64 s | 137-138 MB (in-process RSS) |
| pinned to one core, 1 run | 3.78 s | 3.74 s | 0.40 s / 0.38 s | 161 MB (in-process RSS) |

- Compiling the WASM itself is not the cost. `WebAssembly.compile` of `pyodide.asm.wasm` takes 27 ms (64 ms CPU)
  because it compiles lazily. The cost is starting the interpreter: instantiation, unpacking the stdlib, and Python
  initialisation.
- After a load, the memory breakdown is a JS heap of 31 MB, external memory of 15 MB, WASM linear memory of 30 MB, and
  process RSS of 152 MB. An empty Deno script peaks at 28 MB RSS.
- Warm reruns in the same interpreter are cheap. Later runs of the 40 tests took 21-60 ms wall and 35-93 ms CPU.
  Mutants 2 and 3 took 58 ms each, and mutant 1 took 90 ms.

**Each cold load used at least 3.27 s of CPU, more than the documented 2 s limit, before a single test ran.**

### 3.3 Cold load from a memory snapshot (private API)
`loadPyodide({ _makeSnapshot: true })` followed by `makeMemorySnapshot()` writes the snapshot, after `sqlite3`,
`unittest`, `json` and `io` are imported. `loadPyodide({ _loadSnapshot })` restores it. Both are marked `@private` in
`pyodide.d.ts`.

| Mode | Load wall | Load CPU | Real + 3 mutants | Whole process CPU | Peak RSS |
|---|---|---|---|---|---|
| default, 3 runs (snapshot gunzipped in-process) | 0.34-0.56 s | 0.44-0.49 s | real suite 0.17-0.25 s wall / 0.47-0.66 s CPU; each mutant 0.03-0.11 s | 1.46-1.64 s | **255-269 MB** |
| `--single-threaded`, 2 runs | 1.21-1.29 s | 1.18-1.26 s | real suite 1.19-1.34 s wall and CPU | about 2.4 s | 240-241 MB |
| raw snapshot load, no gunzip, 3 runs | 0.23-0.26 s | 0.34-0.37 s | n/a | n/a | 195-197 MB (in-process RSS) |

The snapshot is 31.5 MB raw and 6.5 MB gzipped.

### 3.4 Assets that would have to ship
| File | Raw | gzip -9 |
|---|---|---|
| `pyodide.asm.wasm` | 9.60 MB | 3.54 MB |
| `python_stdlib.zip` | 2.55 MB | 2.50 MB |
| `pyodide.asm.mjs` | 1.25 MB | 0.26 MB |
| `pyodide-lock.json` | 0.12 MB | 0.03 MB |
| `pyodide.mjs` | 0.02 MB | 0.01 MB |
| **minimum total** | **13.5 MB** | **6.3 MB** |
| optional snapshot | 31.5 MB | 6.5 MB |

The whole npm tarball is 6.5 MB, and 14 MB unpacked. Without the snapshot this fits under the 20 MB bundle cap. With
the snapshot it does not, unless the snapshot is fetched from Storage at start (more wall time and network) or shipped
gzipped and inflated in-process, which is what pushes RSS past 256 MB. Nobody has verified that the Supabase bundler
(eszip) carries the `.wasm` and `.zip` from an `npm:` package. Pyodide reads them with `node:fs` beside its module,
and the limits page says static files need the Docker CLI build.

### 3.5 Network and secrets isolation
Probe results (`run.ts --probe-net`, `escape.ts`, `revoke.ts`; the only host contacted was the public npm registry):

| What user Python tries | `--deny-net` | `--allow-net` (what an edge function has) | `--allow-net` with `jsglobals` stripped |
|---|---|---|---|
| `socket.create_connection` | "connects", but `recv` times out and DNS returns an Emscripten fake address (172.29.x). No real traffic. | same | same |
| `urllib` over HTTPS | `TLS not supported` | same | same |
| `import js; js.fetch(...)` | blocked by Deno (`NotCapable`) | **HTTP 200** | `AttributeError` |
| `pyodide_js.runPython.constructor("return globalThis")()`, then `fetch` | blocked by Deno | **HTTP 200** | **HTTP 200** |
| the same escape, reading `Deno.env` | n/a | **reads the secret** | **reads the secret** |
| the same, after `Deno.permissions.revoke` of net, env, run, write, ffi and sys | `NotCapable` for env and fetch | n/a | n/a |

Findings:
- Python's own sockets and TLS are inert in Pyodide. The real exit is the JS foreign-function interface.
- Stripping `jsglobals` is **not** a boundary. Any JS function object exposes `Function`, and `Function` reaches the
  real `globalThis`. Through it, a bundle could read the edge function's secrets (`SUPABASE_SERVICE_ROLE_KEY`,
  `ANTHROPIC_API_KEY`) and send them anywhere.
- Locally, network and env can be blocked completely after load with `--deny-net` or `Deno.permissions.revoke(...)`.
  Read access stays, so `/etc/hostname` was still readable. In the hosted Edge Runtime, a function can't set its own
  launch flags. Whether `Deno.permissions.revoke` works there has **not been verified**. Verifying it needs a deploy,
  which is an owner action. A revoke would also last for the rest of the worker's life, so the runner would have to be
  its own single-purpose function with no secrets, which returns its log only in the HTTP response.
- The spike measured no CPU or memory limit inside the interpreter. An infinite loop in a bundle would run until the
  platform kills the worker with a 546.

## 4. Alternatives

The rates below are list prices from public pages read on 2026-11-14, and the per-run costs are estimates from those
rates, not measurements. No account was opened.

| | Pyodide in a Supabase edge function | Vercel Sandbox | E2B | GitHub Actions as a runner |
|---|---|---|---|---|
| Isolation | One V8 isolate. JS escape as in 3.5, so it is safe only if the revoke works in production | Firecracker microVM with a network policy | Firecracker microVM | A throwaway VM, but its logs and artifacts are kept in GitHub |
| Python | 3.14 WASM: stdlib and `sqlite3`, no native wheels, no subprocess, no threads | Real CPython, pip | Real CPython, pip | Real CPython, pip |
| Cost per run (40 tests, about 5-10 s) | $0 extra (inside the plan's invocations) | Active CPU $0.128/h, memory $0.0212/GB-h (one regional table shows $0.0106), creations $0.60 per million; Hobby includes 5 CPU-h. **Well under $0.001 a run** (estimate) | $0.000014 per vCPU-s plus $0.0000045 per GiB-s. Hobby has no fee and one-time credits (amount disputed); Pro is $150 a month. **Under $0.001 a run** (estimate) | Linux 2-core about $0.006 a minute, rounded **up to a full minute per job**, so about $0.006 a run after the 2,000-3,000 included minutes on private repos |
| New credential | none | yes (a Vercel access token or OIDC for the Sandbox API, stored as a Supabase secret) | yes (E2B API key) | yes (a token that can dispatch workflows and read artifacts) |
| New vendor | none | **no**: Vercel already hosts `/file` and `/connect` (`vercel.json`, `api/`). A new product, so a new data-processing scope. | **yes** | no (GitHub already hosts the repo) |
| Latency (not measured here) | About 2-4 s cold or 0.3-0.6 s with a snapshot, if it fits at all, plus run time | Sandbox create plus a Python boot: vendor-claimed sub-second to a few seconds | Vendor-claimed sub-second start | Queueing plus a runner boot, typically tens of seconds to minutes. Too slow for a chat turn. |
| Data leaves the system | No | Yes: the person's code and fixtures go to Vercel's infrastructure | Yes: to a new third party | Yes, and worst: inputs and logs stay in a repo's Actions history (90-day default retention), visible to repo collaborators |
| Ops risk | Fighting CPU and memory caps; a private snapshot API that can break on any Pyodide upgrade | Vendor quota and outage; must enforce network deny and timeouts | Same, plus a new vendor's security review | Rate limits; a shared CI quota with the real gate |

Sources: Vercel Sandbox pricing <https://vercel.com/docs/vercel-sandbox/pricing>
(<https://docs.vercel.com/docs/vercel-sandbox/pricing> has the regional table). E2B pricing
<https://e2b.dev/docs/billing> and <https://docs.e2b.dev/faq/calculate-sandbox-price>. GitHub Actions billing
<https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions> and the
changelog <https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/>.
Vendor start-up claims were not measured.

A fifth option was not measured: **Pyodide in a Vercel Function** (Node). It has no new vendor, no new credential type
beyond what `/file` already uses, and much higher memory and CPU limits than an edge function. It has the same
JS-escape problem as 3.5, though, and Node has no permission revoke equal to Deno's in a Vercel Function, so it would
have to run with no secrets in its environment.

## 5. Risks of the Pyodide-in-edge path, stated plainly
1. **CPU.** A cold load is 1.6 to 2.3 times the documented 2 s limit, on a 4-core dev box. If the 200 ms figure in the
   troubleshooting page is the one enforced, the overshoot is 16 to 23 times.
2. **Memory.** The plain load peaks at 150 to 216 MB of a 256 MB cap, before a bigger bundle or larger test data. The
   snapshot path peaks at 240 to 270 MB, which is at or over the cap.
3. **Size.** 13.5 MB fits under 20 MB, and the snapshot does not. Whether npm `.wasm` and `.zip` assets get bundled is
   unverified.
4. **Escape.** Bundle code can reach `fetch` and the env through `Function`. Containing it depends on a
   `Deno.permissions.revoke` behaviour that nobody has verified in the hosted runtime.
5. **Fragility.** The only path that fits the CPU limit uses `_loadSnapshot` and `makeMemorySnapshot`, which are
   undocumented and tied to the exact Pyodide build.
6. **Scope.** Only the stdlib, no subprocess, no native wheels. Many realistic bundles (numpy, pandas, a CLI that
   shells out) won't run, or need `loadPackage` downloads at run time.

## 6. Recommendation

1. **Don't build 124g on Pyodide inside a Supabase edge function.** The measured cold-start CPU breaks the documented
   limit on every run. The snapshot workaround trades that for the memory cap and a private API. Neither path has
   working isolation from the function's secrets.
2. **Owner decision: Vercel Sandbox** for 124g. Vercel is already a Trainee vendor. Each run is a microVM with real
   CPython, a network policy and a hard timeout, and the list price is well under $0.001 a run. Its costs are one new
   credential (a Supabase secret the owner creates), the person's bundle leaving Supabase for Vercel, and a vendor
   dependency on the D2 check. Before 124g, a second $0 spike (once the owner provides the credential) should measure
   create-to-result latency and confirm that network deny holds.
3. **Reject GitHub Actions** as a runner. It has minute-plus latency, bills a full minute for every job, and keeps the
   person's inputs in Actions logs.
4. **E2B** is the fallback if Vercel Sandbox fails the latency or isolation spike. The price is similar, but it adds a
   new vendor and a new key.
5. Until the owner rules, the spec's rule stands: a code bundle is delivered with "tests not run here" and never with a
   claim that they ran (D8).

If the owner still wants $0 and no new vendor, the only defensible Pyodide shape is this one:
- a dedicated, secret-free edge function;
- it revokes net, env, run, write, ffi and sys right after load;
- it loads from a snapshot fetched from Storage;
- it runs one bundle per worker.

Before anything depends on it, one owner-approved test deploy has to show that the revoke works and that peak memory
stays under 256 MB.

## Appendix A: runner (`run.ts`, not committed as product code)

```ts
import process from "node:process";
const t0 = performance.now(); const c0 = process.cpuUsage();
const { loadPyodide } = await import("npm:pyodide@314.0.7");
const [dir, mutant = "none"] = Deno.args;
const snapArg = Deno.args.find((a) => a.startsWith("--snapshot="));
const snapBytes = snapArg ? new Uint8Array(await new Response(Deno.openSync(snapArg.slice(11)).readable
  .pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : undefined;
const py = await loadPyodide(snapBytes ? { _loadSnapshot: snapBytes } : {});
// ...record load wall/CPU/RSS, then for each variant in mutant.split(","):
//   write /work/ledger.py (real or with one replace()), /work/test_ledger.py, then
py.runPython(`
import sys, io, unittest, json, importlib
sys.path.insert(0, "/work"); importlib.invalidate_caches()
for m in ("ledger", "test_ledger"): sys.modules.pop(m, None)
r = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(
    unittest.defaultTestLoader.loadTestsFromName("test_ledger"))
json.dumps({"ran": r.testsRun, "failures": len(r.failures), "errors": len(r.errors), "ok": r.wasSuccessful()})
`);
```

Escape probe (`escape.ts`), the core of finding 3.5:

```python
import pyodide_js
g = pyodide_js.runPython.constructor("return globalThis")()   # Function constructor gives the real globalThis
await g.fetch("https://registry.npmjs.org/")                  # 200 unless Deno net permission is denied/revoked
g.Deno.env.get("SPIKE_FAKE_SECRET")                           # readable unless env permission is denied/revoked
```
