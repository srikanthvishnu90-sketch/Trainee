// MASS APPLY at scale (docs/architect/mass-apply-scale-audit.md section 7, fixes 1 and 3): "mass apply must work at scale for anyone".
//   1. The runner's sizing defaults are raised to what the audit recommends (starts per tick 30, concurrent 60, per ATS family 20,
//      preparation starts 30 and concurrent 60, sandboxes created at once 16). Still env-settable by name; a typo cannot take the
//      tick down (it is clamped to what the database's claim accepts); the optional per-person/per-site numbers stay unset by
//      default and still bind when set, so the caps that bound spend are unchanged.
//   2. Preparation is fair and parallel: one sandbox prepares its postings several at once (bounded, default 4, at most 8), so a
//      25-posting part is not 25 serial minutes in a 13-minute sandbox; the dispatcher creates preparation sandboxes in bounded
//      parallel like the send tick; the database claims requests in turns per person (tests/db/career_apply_prepare_fair_claim.test.sql
//      and the pg test below, CI only).
// These are unit tests: no database, no network, no sandbox host.
import assertNode from "node:assert/strict";
import { createRunnerHandler, LIMIT_CEILINGS, LIMIT_DEFAULTS, runnerLimits } from "../../supabase/functions/_shared/cloud_runner_http.ts";
import { dispatch, type SandboxHost } from "../../supabase/functions/_shared/cloud_runner.ts";
import { dispatchPrepare } from "../../supabase/functions/_shared/cloud_prepare.ts";
import { PREPARE_PARALLEL, runPrepareRequest } from "../../workers/career-cloud/prepare-runner.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SECRET = "TEST-scale-runner-secret-0123456789abcdef0123";
const env = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] });
const noSleep = async () => {};

// ------------------------------------------------------------------------------------------------ 1. the numbers
Deno.test("scale 1a: the defaults are the audit's recommended minimums, and are consistent with each other", () => {
  const d = LIMIT_DEFAULTS as Record<string, number>;
  assert(d.CLOUD_MAX_STARTS_PER_TICK >= 30, `send starts per tick ${d.CLOUD_MAX_STARTS_PER_TICK}`);
  assert(d.CLOUD_MAX_CONCURRENT >= 60, `send concurrent ${d.CLOUD_MAX_CONCURRENT}`);
  assert(d.CLOUD_MAX_PER_PORTAL >= 20, `per ATS family ${d.CLOUD_MAX_PER_PORTAL}`);
  assert(d.CLOUD_PREPARE_STARTS_PER_TICK >= 30, `prepare starts per tick ${d.CLOUD_PREPARE_STARTS_PER_TICK}`);
  assert(d.CLOUD_PREPARE_MAX_CONCURRENT >= 30, `prepare concurrent ${d.CLOUD_PREPARE_MAX_CONCURRENT}`);
  assert(d.CLOUD_DISPATCH_PARALLEL >= 16 && d.CLOUD_DISPATCH_PARALLEL <= 32, `sandboxes created at once ${d.CLOUD_DISPATCH_PARALLEL}`);
  // A tick cannot start more than can run, and one family cannot be given more than the whole pool.
  assert(d.CLOUD_MAX_STARTS_PER_TICK <= d.CLOUD_MAX_CONCURRENT && d.CLOUD_PREPARE_STARTS_PER_TICK <= d.CLOUD_PREPARE_MAX_CONCURRENT);
  assert(d.CLOUD_MAX_PER_PORTAL <= d.CLOUD_MAX_CONCURRENT);
  // The defaults are what an unset environment yields.
  const l = runnerLimits(env());
  eq([l.send.want, l.send.global, l.send.perPortal, l.prepare.want, l.prepare.global, l.parallel],
    [d.CLOUD_MAX_STARTS_PER_TICK, d.CLOUD_MAX_CONCURRENT, d.CLOUD_MAX_PER_PORTAL, d.CLOUD_PREPARE_STARTS_PER_TICK, d.CLOUD_PREPARE_MAX_CONCURRENT, d.CLOUD_DISPATCH_PARALLEL]);
});

Deno.test("scale 1b: every default is still settable by name; nonsense falls back to the default, never to zero or to a crash", () => {
  const set = runnerLimits(env({ CLOUD_MAX_STARTS_PER_TICK: "7", CLOUD_MAX_CONCURRENT: "9", CLOUD_MAX_PER_PORTAL: "3", CLOUD_PREPARE_STARTS_PER_TICK: "4",
    CLOUD_PREPARE_MAX_CONCURRENT: "5", CLOUD_DISPATCH_PARALLEL: "6" }));
  eq([set.send.want, set.send.global, set.send.perPortal, set.prepare.want, set.prepare.global, set.parallel], [7, 9, 3, 4, 5, 6]);
  for (const bad of ["", "0", "-3", "x", "1e999", "NaN"]) {
    const l = runnerLimits(env({ CLOUD_MAX_STARTS_PER_TICK: bad, CLOUD_MAX_CONCURRENT: bad, CLOUD_DISPATCH_PARALLEL: bad }));
    eq([l.send.want, l.send.global, l.parallel], [LIMIT_DEFAULTS.CLOUD_MAX_STARTS_PER_TICK, LIMIT_DEFAULTS.CLOUD_MAX_CONCURRENT, LIMIT_DEFAULTS.CLOUD_DISPATCH_PARALLEL], `"${bad}"`);
  }
});

Deno.test("scale 1c: a number past what the database's claim accepts is clamped, so a typo cannot stop the whole tick", () => {
  // career_apply_cloud_dispatch_claim2 / career_apply_prepare_request_claim raise 'invalid ... limits' for p_want > 500 or p_global/p_per_portal > 10000:
  // the tick would then claim nothing, for everyone, every minute.
  const big = runnerLimits(env({ CLOUD_MAX_STARTS_PER_TICK: "99999", CLOUD_MAX_CONCURRENT: "9999999", CLOUD_MAX_PER_PORTAL: "9999999",
    CLOUD_PREPARE_STARTS_PER_TICK: "99999", CLOUD_PREPARE_MAX_CONCURRENT: "9999999", CLOUD_DISPATCH_PARALLEL: "500" }));
  eq([big.send.want, big.send.global, big.send.perPortal, big.prepare.want, big.prepare.global, big.parallel],
    [500, 10000, 10000, 500, 10000, 32]);
  eq(LIMIT_CEILINGS, { CLOUD_MAX_STARTS_PER_TICK: 500, CLOUD_MAX_CONCURRENT: 10000, CLOUD_MAX_PER_PORTAL: 10000,
    CLOUD_PREPARE_STARTS_PER_TICK: 500, CLOUD_PREPARE_MAX_CONCURRENT: 10000, CLOUD_DISPATCH_PARALLEL: 32 });
  // The ceilings are the database's own bounds (read from the migration, not restated).
  const sql = Deno.readTextFileSync(`${ROOT}/supabase/migrations/20261026230017_career_cloud_hosted_apply.sql`);
  assert((sql.match(/p_want not between 0 and 500 or p_global is null or p_global not between 1 and 10000/g) ?? []).length >= 2, "both claims bound want 500 and global 10000");
  assert(/p_per_portal is null or p_per_portal not between 1 and 10000/.test(sql));
});

Deno.test("scale 1d: the spend caps are unchanged: per-person and per-site numbers are unset by default, bind when set, and reach the claim", async () => {
  const none = runnerLimits(env());
  eq([none.send.perPersonDay, none.send.perSiteMinute, none.prepare.perPersonDay, none.prepare.perSiteMinute], [null, null, null, null], "NO LIMITS: still no default");
  const set = runnerLimits(env({ CLOUD_MAX_PER_PERSON_DAY: "40", CLOUD_MAX_PER_SITE_MINUTE: "60", CLOUD_PREPARE_PER_PERSON_DAY: "100", CLOUD_PREPARE_PER_SITE_MINUTE: "90" }));
  eq([set.send.perPersonDay, set.send.perSiteMinute, set.prepare.perPersonDay, set.prepare.perSiteMinute], [40, 60, 100, 90]);
  // Through the real handler, the claim receives exactly the (raised) numbers and the optional caps.
  const bodies: Record<string, any> = {};
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    const name = u.split("/rpc/")[1];
    if (name) bodies[name] = JSON.parse(String(init?.body ?? "{}"));
    return Response.json([]);
  }) as typeof fetch;
  const host: SandboxHost = { create: async () => "s", run: async () => {}, stop: async () => {} };
  const base = { SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "k", CLOUD_RUNNER_SECRET: SECRET, CLOUD_DISPATCH_SECRET: "D".repeat(40),
    CLOUD_BRIDGE_URL: "https://bridge.test", CLOUD_RUNNER_ENABLED: "on", CLOUD_PREPARE_ENABLED: "on" };
  const tick = (path: string, e: Record<string, string>) => createRunnerHandler({ env: env({ ...base, ...e }), fetch: f, host })(
    new Request(`https://x/functions/v1/career-cloud-runner${path}`, { method: "POST", headers: { "x-cloud-dispatch-secret": "D".repeat(40) }, body: "{}" }));
  await tick("/dispatch", { CLOUD_MAX_PER_PERSON_DAY: "40", CLOUD_MAX_PER_SITE_MINUTE: "60" });
  eq(bodies.career_apply_cloud_dispatch_claim2, { p_want: LIMIT_DEFAULTS.CLOUD_MAX_STARTS_PER_TICK, p_global: LIMIT_DEFAULTS.CLOUD_MAX_CONCURRENT,
    p_per_portal: LIMIT_DEFAULTS.CLOUD_MAX_PER_PORTAL, p_per_person_day: 40, p_per_site_minute: 60 });
  await tick("/prepare-dispatch", { CLOUD_PREPARE_PER_PERSON_DAY: "100", CLOUD_PREPARE_PER_SITE_MINUTE: "90" });
  eq(bodies.career_apply_prepare_request_claim, { p_want: LIMIT_DEFAULTS.CLOUD_PREPARE_STARTS_PER_TICK, p_global: LIMIT_DEFAULTS.CLOUD_PREPARE_MAX_CONCURRENT,
    p_per_person_day: 100, p_per_site_minute: 90 });
  // A hostile value is clamped before it reaches the database.
  await tick("/dispatch", { CLOUD_MAX_STARTS_PER_TICK: "100000", CLOUD_MAX_PER_PERSON_DAY: "40", CLOUD_MAX_PER_SITE_MINUTE: "60" });
  eq(bodies.career_apply_cloud_dispatch_claim2.p_want, 500);
});

Deno.test("scale 1e: a send tick never creates more sandboxes than it claimed, and never more at once than the create bound", async () => {
  const claimed = Array.from({ length: 40 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, lease_token: crypto.randomUUID(), user_id: "u", company: "c", url: "https://x", payload: {}, payload_hash: "h", approval_hash: "a", job_id: `j${i}`, state: "driving", source: "cloud" }));
  let live = 0, peak = 0, created = 0;
  const host: SandboxHost = {
    create: async () => { created++; live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 3)); live--; return `sbx_${created}`; },
    run: async () => {}, stop: async () => {},
  };
  const rpc = async () => claimed;
  const l = runnerLimits(env());
  const out = await dispatch({ rpc, host, secret: SECRET, bridgeUrl: "https://b", limits: l.send, parallel: l.parallel, retry: { sleep: noSleep }, log: () => {} });
  eq([out.claimed, out.started.length, created], [40, 40, 40], "one sandbox per claimed job, no extra");
  assert(peak > 1, "created in parallel, not one by one");
  assert(peak <= l.parallel, `at most ${l.parallel} creates at once (peak ${peak})`);
});

// ------------------------------------------------------------------------------------------------ 2a. preparation dispatch
Deno.test("scale 2a: the preparation tick creates its sandboxes in bounded parallel, in order, and one failure does not stop the others", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, user_id: `00000000-0000-4000-8000-${String(i % 5).padStart(12, "0")}`, job_ids: ["a"], lease_token: crypto.randomUUID() }));
  let live = 0, peak = 0, n = 0;
  const failing = new Set([3, 17]);
  const host: SandboxHost = {
    create: async () => { const k = n++; live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; if (failing.has(k)) throw Error("rate limited"); return `sbx_${k}`; },
    run: async () => {}, stop: async () => {},
  };
  const names: string[] = [];
  const rpc = async (name: string) => { names.push(name); return name === "career_apply_prepare_request_claim" ? rows : null; };
  const out = await dispatchPrepare({ rpc, host, secret: SECRET, bridgeUrl: "https://b", limits: runnerLimits(env()).prepare, parallel: 8, retry: { tries: 1, sleep: noSleep }, log: () => {} } as any);
  eq(out.claimed, 30);
  eq(out.started.length + out.unavailable.length, 30, "every claimed request is either started or told it was not");
  eq(out.unavailable.length, 2, "two creates failed; the other 28 started");
  assert(peak > 1 && peak <= 8, `creates in parallel, at most 8 at once (peak ${peak})`);
  eq(out.started.map((s) => s.request), rows.filter((_, i) => ![...out.unavailable.map((u) => u.request)].includes(rows[i].id)).map((r) => r.id), "started are reported in the claim's order");
  eq(names.filter((x) => x === "career_apply_prepare_request_finish").length, 2, "each failure is finished 'failed' once");
});

// ------------------------------------------------------------------------------------------------ 2b. inside one sandbox
function sandboxRun(n: number, o: { parallel?: number; hostOf?: (i: number) => string } = {}) {
  const U = "7b0f8f8e-6a43-4a49-9d2c-0000000000f1";
  const cands = Array.from({ length: n }, (_, i) => ({ user_id: U, job_id: `greenhouse:co:${i}`, company: `Co${i}`, title: "Intern", url: `${o.hostOf?.(i) ?? "https://boards.greenhouse.io"}/co/jobs/${i}`, location: "", description: "", epoch: 0, version: 0 }));
  const recorded = new Set<string>(), finishes: any[] = [], resumeAt: number[] = [];
  let live = 0, peak = 0;
  const db = { rpc: async (name: string, args: any) => {
    if (name === "career_apply_prepare_candidates") return { data: cands.filter((c) => !recorded.has(c.job_id)).slice(0, args.p_limit), error: null };
    if (name === "career_apply_prepare_attempt_for") { recorded.add(args.p_posting_job_id); return { data: null, error: null }; }
    if (name === "career_apply_answers_for") return { data: [], error: null };
    return { data: null, error: null };
  } };
  const bridge: any = { db, call: async (op: string, extra: any) => {
    if (op === "request") return { id: "r", user_id: U, job_ids: cands.map((c) => c.job_id) };
    if (op === "resume") { live++; peak = Math.max(peak, live); resumeAt.push(performance.now()); await new Promise((r) => setTimeout(r, 4)); live--; return null; } // no resume: recorded no_resume, no engine
    if (op === "finish") { finishes.push(extra); return { push: "ok" }; }
    return null;
  } };
  const run = () => runPrepareRequest({ bridge, runEngine: (async () => { throw Error("no engine in this test"); }) as any, schema: false, log: () => {}, ...(o.parallel ? { parallel: o.parallel } : {}) });
  return { run, peak: () => peak, finishes, recorded };
}

Deno.test("scale 2b: one sandbox prepares its postings several at once, bounded (default 4), every posting exactly once, outcomes in order", async () => {
  eq(PREPARE_PARALLEL, { default: 4, max: 8 });
  const s = sandboxRun(25);
  const r = await s.run();
  eq(r.outcomes.length, 25, "all 25 postings of a part");
  eq(new Set(r.outcomes.map((x) => x.job_id)).size, 25, "each once");
  eq(r.outcomes.map((x) => x.job_id), Array.from({ length: 25 }, (_, i) => `greenhouse:co:${i}`), "in the request's order");
  assert(s.peak() > 1, "not one at a time");
  eq(s.peak(), 4, `exactly the default bound at the peak (${s.peak()})`);
  eq(s.finishes.length, 1, "finished once, with every outcome");
  eq(s.finishes[0].outcomes.length, 25);
});

Deno.test("scale 2c: the bound is settable, never below 1, never above the sandbox's browsers (8); one host does not serialise the part", async () => {
  const serial = sandboxRun(10, { parallel: 1 });
  await serial.run();
  eq(serial.peak(), 1, "parallel 1 is serial");
  const wide = sandboxRun(30, { parallel: 100 });
  await wide.run();
  eq(wide.peak(), 8, "a number past the max is held to 8");
  const zero = sandboxRun(6, { parallel: 0 });
  await zero.run();
  assert(zero.peak() >= 1 && zero.peak() <= PREPARE_PARALLEL.default, "0 means the default, not a stall");
  const oneHost = sandboxRun(12, { hostOf: () => "https://jobs.lever.co" });
  await oneHost.run();
  eq(oneHost.peak(), 4, "twelve postings on one ATS host still run four at once (a refusal, not a number of ours, holds a host off)");
});

Deno.test("scale 2d: the work per request is bounded: a part is 25 postings and the sandbox lease fits its parallel run", () => {
  const sql = Deno.readTextFileSync(`${ROOT}/supabase/migrations/20261026230017_career_cloud_hosted_apply.sql`);
  assert(/cardinality\(job_ids\) between 1 and 25/.test(sql), "a request holds at most 25 postings");
  // 25 postings at 60 s each (real forms, CLOUD-RUNNER.md) in a 13-minute sandbox: serial overruns it, 4 at once does not.
  const perPostingS = 60, sandboxS = 13 * 60;
  assert(25 * perPostingS > sandboxS, "serial would be killed (the audit's finding)");
  assert(Math.ceil(25 / PREPARE_PARALLEL.default) * perPostingS <= sandboxS, "four at once finishes inside the sandbox");
});

// ------------------------------------------------------------------------------------------------ 2e. the migration's own agreement
Deno.test("scale 2e: the fair-claim migration, its rollback, the go-live list and the db runner agree", () => {
  const f = "20261102130000_career_apply_prepare_fair_claim.sql";
  const sql = Deno.readTextFileSync(`${ROOT}/supabase/migrations/${f}`);
  assert(/create or replace function public\.career_apply_prepare_request_claim\(p_want integer, p_global integer, p_per_person_day integer,\s+p_per_site_minute integer\)/.test(sql), "same signature");
  assert(/row_number\(\) over \(partition by x\.user_id order by x\.created_at, x\.id\)/.test(sql) && /order by q\.turn, q\.created_at, q\.id/.test(sql), "turns per person, then oldest");
  assert(/z\.state = 'running'/.test(sql), "a person's running requests count against their turn");
  assert(/for update skip locked/.test(sql) && /pg_advisory_xact_lock\(hashtextextended\('career-prepare-dispatch-v1', 0\)\)/.test(sql), "still one dispatcher, rows locked as taken");
  assert(/p_want not between 0 and 500 or p_global is null or p_global not between 1 and 10000/.test(sql), "limits validated as before");
  const down = Deno.readTextFileSync(`${ROOT}/supabase/rollbacks/${f.replace(".sql", ".down.sql")}`);
  assert(/order by created_at, id for update skip locked/.test(down) && !/q\.turn/.test(down), "the rollback is the oldest-first body");
  const golive = Deno.readTextFileSync(`${ROOT}/scripts/launch/trainee-go-live.sh`);
  assert(golive.includes(`  ${f}\n`), "in go-live's MIGRATIONS");
  assert(golive.includes("prosrc like '%order by q.turn%'"), "with a live mark that tells the new body from the old");
  const run = Deno.readTextFileSync(`${ROOT}/tests/db/run.sh`);
  assert(run.includes('== 20261102130000_*') && run.includes("career_apply_prepare_fair_claim.test.sql"), "the db runner defers it and runs its test");
  // go-live's default sizing is the code's.
  const wave = golive.match(/declare -A CLOUD_WAVE1=\(([^)]*)\)/)![1];
  const got: Record<string, number> = {};
  for (const m of wave.matchAll(/\[(CLOUD_[A-Z_]+)\]=(\d+)/g)) got[m[1]] = Number(m[2]);
  eq(got, { ...LIMIT_DEFAULTS }, "go-live sets the same numbers the code defaults to");
});
