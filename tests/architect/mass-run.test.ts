// Mass submission (owner D-MS-2, 2026-10-27): the scheduler every executor uses (workers/career-browser/mass-run.ts):
// claims in batches, several at once across hosts, each employer host paced (at most hostMax at once, hostSpacingMs
// between starts), a verification check handed back once and never retried, a crashed run's journal recovered (a started
// application recorded unknown and never driven again; a claimed-but-unstarted one run under its lease or ended as not
// sent), and the cloud loop (career-cloud/worker.ts cloudLoop) on the same scheduler without its old bound of 6.
// Fake engines and an in-memory queue; the real database and browser are in mass-submit-pg.test.ts.
import { cloudLoop, type CloudJob, type CloudQueue } from "../../workers/career-cloud/worker.ts";
import { factsFromPayload, ownQueue, runLoop } from "../../workers/career-browser/approve-first.ts";
import { backoffMs, dbHostGate, fileJournal, handBack, hostOf, localHostGate, type MassJob, massRun, PacedLimiter, pacedPool, pacingFrom, pageRefusal, refusal } from "../../workers/career-browser/mass-run.ts";
import { prepareAhead, prepareDoor, preparePacing, shardOf } from "../../workers/career-browser/prepare-ahead.ts";
import { prepareHostStatus } from "../../supabase/functions/_shared/prepare_host_status.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { authorizer, cardBound, effectAware } from "../helpers/cloud_card_auth.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
};

// A queue of `n` jobs over `hosts` hosts; claim hands out up to `limit`, each once.
function queue(n: number, hosts: number) {
  const jobs: MassJob[] = Array.from({ length: n }, (_, i) => ({ id: `j${String(i).padStart(3, "0")}`, url: `https://h${i % hosts}.example.test/job/${i}`, lease_token: `L${i}` }));
  let left = [...jobs];
  const claims: number[] = [];
  return { jobs, claims, claim: async (limit: number) => { claims.push(limit); const out = left.slice(0, limit); left = left.slice(limit); return out; } };
}
// A meeting point for the "in parallel" checks (2026-10-30): each of the first `n` callers waits until `n` have arrived,
// then all go on; after that it is open. A scheduler that really runs n at once always meets it, however slow the
// machine (a short sleep inside each run only overlaps when the machine is quick enough); one that cannot run n at once
// never fills it, waits out `ms`, and the peak check after it fails as it should.
function meet(n: number, ms = 10_000) {
  let arrived = 0, open = false, go!: () => void;
  const all = new Promise<void>((r) => { go = r; });
  return async (): Promise<void> => {
    if (open) return;
    if (++arrived >= n) { open = true; go(); return; }
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((r) => { t = setTimeout(r, ms); })]);
    clearTimeout(t);
  };
}
// A run that takes `ms`, recording each start and end per host, and the peak at once (overall and per host); `together`
// (a meet) holds each run, once started, until that many are running.
function recorder(ms: (j: MassJob) => number, result: (j: MassJob) => { state: string; reason?: string } = () => ({ state: "submitted_unconfirmed" }), together?: () => Promise<void>) {
  const starts: { id: string; host: string; at: number }[] = [], runs = new Map<string, number>();
  let now = 0, peak = 0;
  const per = new Map<string, number>(), perPeak = new Map<string, number>();
  const run = async (j: MassJob, onStart: () => Promise<void>) => {
    // Stamped when the scheduler hands the job over (its decision), before any await: under load an await's delay is
    // the machine's, not the scheduler's.
    const at = performance.now();
    await onStart();
    const host = hostOf(j.url);
    runs.set(j.id, (runs.get(j.id) ?? 0) + 1);
    starts.push({ id: j.id, host, at });
    now++; peak = Math.max(peak, now);
    per.set(host, (per.get(host) ?? 0) + 1); perPeak.set(host, Math.max(perPeak.get(host) ?? 0, per.get(host)!));
    await together?.();
    await new Promise((r) => setTimeout(r, ms(j)));
    now--; per.set(host, per.get(host)! - 1);
    return { ...result(j), recorded: true };
  };
  return { run, starts, runs, peak: () => peak, perPeak };
}
const minGap = (starts: { host: string; at: number }[]) => {
  const by = new Map<string, number[]>();
  for (const s of starts) by.set(s.host, [...(by.get(s.host) ?? []), s.at]);
  let gap = Infinity;
  for (const ts of by.values()) for (let i = 1; i < ts.length; i++) gap = Math.min(gap, ts[i] - ts[i - 1]);
  return gap;
};
const never = async () => { throw Error("not expected"); };

Deno.test("mass-run: 40 jobs over 5 hosts, all run once; never more than the bound at once or per host; each host's starts at least its spacing apart; claimed in batches, not one at a time", async () => {
  const q = queue(40, 5), r = recorder(() => 40, undefined, meet(4));
  const t0 = performance.now();
  const out = await massRun({
    claim: q.claim, run: r.run, unstarted: never, orphaned: never, drain: true, idleMs: 5, stop: () => false, log: () => {},
    pacing: pacingFrom(() => undefined, { concurrency: 6, claimBatch: 25, hostMax: 2, hostSpacingMs: 60, startBudgetMs: 60_000 }),
  });
  void t0; // parallelism is pinned by the peak below, not by wall time (a loaded machine stretches every wait)
  eq(out.length, 40, "every job has an outcome");
  eq([...r.runs.values()].every((n) => n === 1) && r.runs.size, 40, "each job ran exactly once");
  assert(r.peak() <= 6 && r.peak() >= 4, `at most 6 at once, and in parallel (peak ${r.peak()})`);
  assert([...r.perPeak.values()].every((n) => n <= 2), `at most 2 at once on one host (${JSON.stringify([...r.perPeak])})`);
  assert(minGap(r.starts) >= 58, `each host's starts at least 60 ms apart (min ${minGap(r.starts).toFixed(1)} ms)`);
  assert(q.claims.some((n) => n > 1), `claims ask for more than one (${q.claims})`);
});

Deno.test("mass-run: runs longer than the spacing never put more than hostMax on one host at once", async () => {
  const q = queue(12, 2), r = recorder(() => 60, undefined, meet(4));
  await massRun({
    claim: q.claim, run: r.run, unstarted: never, orphaned: never, drain: true, idleMs: 5, stop: () => false, log: () => {},
    pacing: pacingFrom(() => undefined, { concurrency: 10, claimBatch: 25, hostMax: 2, hostSpacingMs: 0 }),
  });
  eq(r.runs.size, 12);
  eq([...r.perPeak.values()], [2, 2], "two at once on each host, never three");
});

Deno.test("mass-run: no number of ours: every host at full parallelism; a host that refuses (429 Retry-After, or a check) is held off for as long as it asked, then resumed; the refused application is never retried", async () => {
  // Defaults: no per-host number, no spacing; concurrency is this machine's capacity.
  const d = pacingFrom(() => undefined, {}, () => 7);
  eq([d.concurrency, d.claimBatch, d.hostMax, d.hostSpacingMs], [7, 7, Infinity, 0], "the only default is the machine's capacity");
  const q = queue(12, 2), logs: string[] = [];
  const refused = new Set<string>();
  const r = recorder(() => 5, (j) => {
    if (j.url.includes("h0.") && !refused.has("h0")) { refused.add("h0"); return { state: "not_submitted", reason: "HOST_RATE_LIMITED", retry_after_s: 0.2 } as any; }
    if (j.id === "j010") return { state: "not_submitted", reason: "CAPTCHA_AT_SUBMIT" }; // h0's last: the check never delays h1
    return { state: "submitted_unconfirmed" };
  });
  const gate = localHostGate();
  const out = await massRun({
    claim: q.claim, run: r.run, unstarted: never, orphaned: never, drain: true, idleMs: 5, stop: () => false, log: (l) => logs.push(l),
    pacing: pacingFrom(() => undefined, { concurrency: 2 }), gate,
  });
  eq(out.length, 12);
  eq([...r.runs.values()].every((n) => n === 1), true, "no job is run twice, a refused or checked one included");
  const h0 = r.starts.filter((s) => s.host === "h0.example.test").map((s) => s.at);
  assert(h0[1] - h0[0] >= 195, `after its 429 (Retry-After 0.2 s) h0 waited (${(h0[1] - h0[0]).toFixed(0)} ms)`);
  const h1 = r.starts.filter((s) => s.host === "h1.example.test").map((s) => s.at);
  // h1 is never held: while h0 waits out its 200 ms, h1 keeps starting (a claimed h0 item waits beside it, never in front
  // of it; on a leased queue it is given back instead, mass-scale-pg.test.ts).
  const duringHold = h1.filter((t) => t > h0[0] && t < h0[1]).length;
  assert(h1.length === 6 && duringHold >= 3, `h1 ran ${duringHold} while h0 was held (${h1.map((t) => (t - h0[0]).toFixed(0))} vs ${(h0[1] - h0[0]).toFixed(0)})`);
  assert(logs.some((l) => /refused \(rate limited\)/.test(l)) && logs.some((l) => /verification check, handed back to the person, never retried/.test(l)), logs.join("\n"));
  eq(backoffMs(0, null), 30_000); eq(backoffMs(3, null), 240_000); eq(backoffMs(30, null), 3_600_000); eq(backoffMs(5, 7), 7000);
  eq(refusal({ state: "not_submitted", reason: "HOST_RATE_LIMITED", retry_after_s: 9 }), { why: "rate_limited", retryAfterS: 9 });
  eq(refusal({ state: "needs_user", reason: "captcha" }), { why: "bot_check", retryAfterS: null });
  eq(refusal({ state: "submitted_unconfirmed" }), null);
  eq(handBack({ state: "needs_user", reason: "captcha" }), "captcha");
  eq(handBack({ state: "not_submitted", reason: "CAPTCHA_AT_SUBMIT" }), "captcha");
  eq(handBack({ state: "not_submitted", reason: "ACCOUNT_LOGIN_REQUIRED" }), "login_required");
  eq(handBack({ state: "not_submitted", reason: "needs_answers" }), null);
});

Deno.test("mass-run: on a leased queue, an application waiting on a host another instance holds off goes back to the queue at once, and only begun leases start engines", async () => {
  const gate = localHostGate();
  await gate.refused("h0.example.test", "rate_limited", 60, Date.now()); // another instance's refusal: h0 held for a minute
  const q = queue(8, 2), r = recorder(() => 2), back: string[] = [], begins: string[][] = [];
  const out = await massRun({
    claim: q.claim, run: r.run, orphaned: never, drain: true, idleMs: 5, stop: () => false, log: () => {}, gate,
    begin: async (jobs) => { begins.push(jobs.map((j) => j.id)); return new Set(jobs.map((j) => j.id).filter((id) => id !== "j003")); },
    unstarted: async (j, why) => { back.push(`${j.id}:${why}`); return { state: "released", reason: why, recorded: true }; },
    pacing: pacingFrom(() => undefined, { concurrency: 8 }),
  });
  eq(back.sort(), ["j000:HOST_HELD", "j002:HOST_HELD", "j004:HOST_HELD", "j006:HOST_HELD"], "h0's four go back, unstarted");
  eq([...r.runs.keys()].sort(), ["j001", "j005", "j007"], "only h1's begun leases ran (j003's lease was another instance's)");
  assert(begins.flat().every((id) => ["j001", "j003", "j005", "j007"].includes(id)), "nothing on a held host was begun");
  eq(out.length, 7);
});

Deno.test("mass-run: a crash mid-batch: on restart a started job is recorded unknown and never run again; a claimed one not started runs once; one past its lease budget is ended as not sent", async () => {
  const dir = await Deno.makeTempDir();
  const journal = fileJournal<MassJob>(`${dir}/journal`);
  const at = Date.now();
  // What the dead run left: a started one, two claimed and not started (one with time left, one past its budget).
  await journal.put({ id: "started-1", url: "https://a.test/1", lease_token: "L1" }, at - 1000);
  await journal.start("started-1");
  await journal.put({ id: "waiting-2", url: "https://b.test/2", lease_token: "L2" }, at - 1000);
  await journal.put({ id: "expired-3", url: "https://c.test/3", lease_token: "L3" }, at - 10 * 60_000);
  const st = await Deno.stat(`${dir}/journal`);
  eq((st.mode ?? 0) & 0o777, 0o700, "the journal folder is private");
  const ran: string[] = [], ended: string[] = [], orphans: string[] = [];
  const out = await massRun({
    claim: async () => [], drain: true, idleMs: 5, stop: () => false, log: () => {}, journal,
    run: async (j, onStart) => { await onStart(); ran.push(j.id); return { state: "submitted_unconfirmed", recorded: true }; },
    unstarted: async (j, why) => { ended.push(`${j.id}:${why}`); return { state: "not_submitted", reason: why, recorded: true }; },
    orphaned: async (j) => { orphans.push(j.id); return { state: "unknown_outcome", recorded: true }; },
    pacing: pacingFrom(() => undefined, { startBudgetMs: 240_000 }),
  });
  eq(orphans, ["started-1"], "the started one is recorded unknown");
  eq(ran, ["waiting-2"], "only the claimed-and-unstarted one with time left runs");
  eq(ended, ["expired-3:NOT_STARTED_IN_LEASE"], "one past its budget is never started late");
  eq(out.map((o) => [o.id, o.state]).sort(), [["expired-3", "not_submitted"], ["started-1", "unknown_outcome"], ["waiting-2", "submitted_unconfirmed"]]);
  eq((await journal.list()).length, 0, "every recorded one leaves the journal");
  // A journal write that fails before the engine: the engine never starts.
  let engine = 0;
  const bad = { ...journal, start: async () => { throw Error("disk full"); } };
  await journal.put({ id: "x-4", url: "https://d.test/4", lease_token: "L4" }, Date.now());
  const r2 = await massRun({
    claim: async () => [], drain: true, idleMs: 5, stop: () => false, log: () => {}, journal: bad,
    run: async (_j, onStart) => { try { await onStart(); engine++; return { state: "submitted_unconfirmed", recorded: true }; } catch { return { state: "not_submitted", reason: "JOURNAL", recorded: true }; } },
    unstarted: never, orphaned: never, pacing: pacingFrom(() => undefined),
  });
  eq([engine, r2[0].state], [0, "not_submitted"], "no durable start line, no engine");
});

Deno.test("mass-run: stop ends claiming; what is running finishes; what was claimed and not started is ended as not sent", async () => {
  const q = queue(6, 1), r = recorder(() => 30);
  let stop = false, started!: () => void;
  const first = new Promise<void>((res) => { started = res; });
  const ended: string[] = [];
  const done = massRun({
    claim: q.claim, run: (j, onStart) => { const p = r.run(j, onStart); started(); return p; }, orphaned: never, idleMs: 5, stop: () => stop, log: () => {},
    unstarted: async (j, why) => { ended.push(why); return { state: "not_submitted", reason: why, recorded: true }; },
    pacing: pacingFrom(() => undefined, { concurrency: 4, claimBatch: 6, hostMax: 1, hostSpacingMs: 1000 }),
  });
  // Stopped once the first has started (was: after a fixed 10 ms, which a loaded machine could reach before any start).
  await first;
  stop = true;
  const out = await done;
  eq(r.runs.size, 1, "one started (one host, 1 s apart)");
  assert(ended.length >= 1 && ended.every((w) => w === "WORKER_STOPPING"), JSON.stringify(ended));
  eq(out.length, r.runs.size + ended.length, "every claimed one has an outcome");
});

Deno.test("mass-run: the claim takes no more than can start inside the lease budget behind one slow host", async () => {
  // 40 jobs on one host, 50 ms apart, a start budget of 1 s: a claim of 50 would leave 30 to expire.
  const q = queue(40, 1), r = recorder(() => 1);
  const out = await massRun({
    claim: q.claim, run: r.run, orphaned: never, idleMs: 5, log: () => {}, drain: true, stop: () => false,
    unstarted: async (_j, why) => ({ state: "not_submitted", reason: why, recorded: true }),
    pacing: pacingFrom(() => undefined, { concurrency: 8, claimBatch: 50, hostMax: 1, hostSpacingMs: 50, startBudgetMs: 1_000 }),
  });
  eq(out.filter((o) => o.reason === "NOT_STARTED_IN_LEASE").length, 0, "nothing claimed is left to expire");
  eq(r.runs.size, 40, "all of them ran");
  assert(Math.max(...q.claims) <= 16, `claims stay small behind one host 50 ms apart (${q.claims})`);
});

Deno.test("the person's computer: runLoop claims a batch through their own queue and runs several at once, each job recorded once by its lease", async () => {
  const J = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, lease_token: `L-${i}`, url: `https://h${i % 3}.example.test/${i}`,
    payload: { user_id: "TEST-USER", fields: [], engine_approval: "a".repeat(64), resume_sha256: "b".repeat(64) } });
  const jobs = Array.from({ length: 9 }, (_, i) => J(i)), calls: { name: string; args: any }[] = [];
  const client = { rpc: (name: string, args: any) => {
    calls.push({ name, args });
    if (name === "career_apply_claim_own") return Promise.resolve({ data: jobs.splice(0, args.p_limit), error: null });
    return Promise.resolve({ data: { id: args.p_id, state: args.p_state }, error: null });
  } };
  let now = 0, peak = 0;
  const three = meet(3);
  const ran = await runLoop({
    queue: ownQueue(client), resume: { path: "/r.pdf", sha256: "b".repeat(64) }, writeFacts: async () => "/f.json", drain: true, idleMs: 1,
    runEngine: async () => { now++; peak = Math.max(peak, now); await three(); await new Promise((r) => setTimeout(r, 15)); now--; return { result: { state: "submitted_unconfirmed" }, evidence: {} }; },
    stop: () => false, sleep: async () => {}, log: () => {},
    pacing: pacingFrom(() => undefined, { concurrency: 4, claimBatch: 25, hostMax: 2, hostSpacingMs: 0 }),
  });
  eq(ran.length, 9);
  assert(peak >= 3 && peak <= 4, `several at once, never more than 4 (peak ${peak})`);
  assert(calls.some((c) => c.name === "career_apply_claim_own" && c.args.p_limit > 1), "a batch claim");
  const fin = calls.filter((c) => c.name === "career_apply_finish_own");
  eq(fin.length, 9, "each recorded once");
  eq(new Set(fin.map((c) => c.args.p_lease)).size, 9, "each by its own lease");
});

Deno.test("the person's computer: a captcha or a sign-in wall ends needs_user with its link, and the engine ran once", async () => {
  for (const reason of ["CAPTCHA_AT_SUBMIT", "ACCOUNT_LOGIN_REQUIRED"]) {
    const job = { id: "00000000-0000-4000-8000-000000000001", lease_token: "L", url: "https://h.example.test/1", payload: { user_id: "TEST-USER", fields: [], engine_approval: "a".repeat(64), resume_sha256: "b".repeat(64) } };
    let n = 0;
    const fin: any[] = [];
    const client = { rpc: (name: string, args: any) => {
      if (name === "career_apply_claim_own") { const out = n++ ? [] : [job]; return Promise.resolve({ data: out, error: null }); }
      fin.push(args);
      return Promise.resolve({ data: {}, error: null });
    } };
    let engine = 0;
    await runLoop({
      queue: ownQueue(client), resume: { path: "/r.pdf", sha256: "b".repeat(64) }, writeFacts: async () => "/f.json", drain: true, idleMs: 1,
      runEngine: async () => { engine++; return { result: { state: "not_submitted", reason }, evidence: {} }; },
      stop: () => false, sleep: async () => {}, log: () => {}, pacing: pacingFrom(() => undefined, { concurrency: 2, hostSpacingMs: 0 }),
    });
    eq(engine, 1, `${reason}: the engine ran once`);
    eq([fin[0].p_state, fin[0].p_evidence.reason, fin[0].p_evidence.link], ["needs_user", reason === "CAPTCHA_AT_SUBMIT" ? "captcha" : "login_required", job.url]);
  }
});

Deno.test("the cloud worker: cloudLoop runs more than 6 at once when asked (no bound of 6), paced per host", async () => {
  const RESUME = new TextEncoder().encode("%PDF-1.4 TEST");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", RESUME))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const mk = async (n: number): Promise<CloudJob> => {
    const fields = [{ name: "first_name", label: "First name", value: "TEST A", factId: `TEST-A-${n}` }];
    const payload: any = { version: 1, user_id: "A", job_id: `lever:t${n}:${n}`, company: `TEST Co ${n}`, url: `https://h${n % 4}.lever.test/t${n}/${n}`, fields,
      destination: `https://h${n % 4}.lever.test/t${n}/${n}/apply`, resume_sha256: sha, privacy_epoch: 1, account_version: 1, expires_at: "2099-01-01T00:00:00Z" };
    payload.engine_approval = await hashApplyPayload(factsFromPayload(payload).saved);
    return await cardBound({ id: `job-${n}`, lease_token: `lease-${n}`, user_id: "A", company: payload.company, url: payload.url, payload });
  };
  const jobs = await Promise.all(Array.from({ length: 24 }, (_, i) => mk(i)));
  let pending = [...jobs];
  const finished: string[] = [];
  const q: CloudQueue = {
    claim: async (limit) => { const out = pending.slice(0, limit); pending = pending.slice(limit); return out; },
    resume: async () => ({ filename: "r.pdf", sha256: sha, b64: btoa(String.fromCharCode(...RESUME)) }),
    finish: async (j, state) => { finished.push(`${j.id}:${state}`); },
    ask: async () => 0, gatePresent: async () => true, authorize: authorizer().authorize,
  };
  let now = 0, peak = 0;
  const seven = meet(7);
  const engine = effectAware(async () => { now++; peak = Math.max(peak, now); await seven(); await new Promise((r) => setTimeout(r, 40)); now--;
    return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: { post: { status: 200, mutations: 1 } } }; });
  const tmp = await Deno.makeTempDir();
  await cloudLoop({ queue: q, runEngine: engine, tmpRoot: tmp, idleMs: 5, drain: true, stop: () => false, log: () => {},
    pacing: { concurrency: 12, claimBatch: 25, hostMax: 3, hostSpacingMs: 0 } });
  eq(finished.length, 24);
  assert(peak > 6 && peak <= 12, `more than 6 at once, at most 12 (peak ${peak})`);
});

Deno.test("prepare-ahead: no per-person or per-run number: every posting the database offers, read a page at a time, several at once through one shared pool; many hosts split people by shard", async () => {
  const U = "7b0f8f8e-6a43-4a49-9d2c-0000000000e2";
  const cands = Array.from({ length: 120 }, (_, i) => ({ user_id: U, job_id: `g${i}`, company: `C${i}`, title: "T", url: `https://h${i % 6}.example.test/${i}`, location: "", description: "", epoch: 0, version: 0 }));
  const asked: any[] = [];
  const recorded = new Set<string>();
  const db = { rpc: async (name: string, args: any) => {
    // The database drops a posting from the candidates once its try is recorded.
    if (name === "career_apply_prepare_candidates") { asked.push(args); return { data: cands.filter((c) => !recorded.has(c.job_id)).slice(0, args.p_limit), error: null }; }
    if (name === "career_apply_prepare_attempt_for") { recorded.add(args.p_posting_job_id); return { data: null, error: null }; }
    if (name === "career_apply_answers_for") return { data: [], error: null };
    return { data: null, error: null };
  } };
  let now = 0, peak = 0;
  const five = meet(5);
  const limiter = new PacedLimiter({ concurrency: 5, hostMax: 1, hostSpacingMs: 0 });
  const out = await prepareAhead({ db, limiter, runEngine: never as any,
    resumeFor: async () => { now++; peak = Math.max(peak, now); await five(); await new Promise((r) => setTimeout(r, 5)); now--; return null; } });
  eq(out.length, 120, "every posting the database offered, for one person");
  eq(new Set(out.map((x) => x.job_id)).size, 120, "each once");
  assert(asked.length > 2 && asked.every((a) => a.p_limit <= 10 + 120), `read a page at a time (${asked.map((a) => a.p_limit)})`);
  assert(peak === 5, `five at once through the pool (peak ${peak})`);
  eq(preparePacing((k) => ({ PREPARE_AHEAD_CONCURRENCY: "9" } as any)[k]).concurrency, 9);
  eq(preparePacing(() => undefined, () => 11).concurrency, 11, "unset: this machine's capacity");
  // Shards split people with no overlap and no one left out.
  const shards = [0, 1, 2].map((i) => shardOf(`${i}/3`)!), ids = Array.from({ length: 300 }, () => crypto.randomUUID());
  eq(ids.every((u) => shards.filter((f) => f(u)).length === 1), true, "each person in exactly one shard");
  assert(shards.every((f) => ids.filter(f).length > 60), "each shard takes a share");
  eq([shardOf("3/3"), shardOf("x"), shardOf(undefined)], [null, null, null]);
  // The pool paces each host across separate callers.
  const shared = new PacedLimiter({ concurrency: 10, hostMax: 1, hostSpacingMs: 30 }), t: number[] = [];
  await Promise.all([pacedPool([1, 2], { url: () => "https://one.test/x", run: async () => { t.push(performance.now()); }, limiter: shared }),
    pacedPool([3], { url: () => "https://one.test/y", run: async () => { t.push(performance.now()); }, limiter: shared })]);
  t.sort((a, b) => a - b);
  assert(t[1] - t[0] >= 28 && t[2] - t[1] >= 28, `one host 30 ms apart across callers (${t.map((x) => x.toFixed(0))})`);
});

Deno.test("prepare-ahead serve: runs are no longer one after another; the same posting is not started twice at once; GET /status answers only the token", async () => {
  let active = 0, peak = 0;
  const seen: string[][] = [];
  const three = meet(3);
  const door = prepareDoor({ token: "t".repeat(40), run: async (only) => { seen.push(only.job_ids); active++; peak = Math.max(peak, active); await three(); await new Promise((r) => setTimeout(r, 30)); active--; return []; } });
  const U = "7b0f8f8e-6a43-4a49-9d2c-0000000000e2";
  const post = (ids: string[]) => door(new Request("http://w/prepare", { method: "POST", headers: { authorization: `Bearer ${"t".repeat(40)}` }, body: JSON.stringify({ user_id: U, job_ids: ids }) }));
  eq([(await post(["a"])).status, (await post(["b"])).status, (await post(["a", "c"])).status], [202, 202, 202]);
  for (let i = 0; i < 2000 && peak < 3; i++) await new Promise((r) => setTimeout(r, 5));
  eq(peak, 3, "three runs at once (the pool bounds them, not a chain)");
  eq(seen, [["a"], ["b"], ["c"]], "a posting already being prepared is not started again");
  eq((await door(new Request("http://w/status"))).status, 401);
  const st = await (await door(new Request("http://w/status", { headers: { authorization: `Bearer ${"t".repeat(40)}` } }))).json();
  eq([st.ok, st.service, st.runs], [true, "prepare-ahead", 3]);
  await new Promise((r) => setTimeout(r, 50));
});

Deno.test("phone-only preparation status: not configured, refused, unreachable and up are told apart, each in plain words; the token is never shown", async () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  const tok = "s".repeat(40);
  const off = await prepareHostStatus({ env: env({}) });
  eq(off.state, "not_configured");
  assert(/extension/.test(off.words) && !/CAREER_|NOT_WIRED/.test(off.words), off.words);
  assert(/CAREER_PREPARE_AHEAD_URL/.test(off.owner), off.owner);
  const on = env({ CAREER_PREPARE_AHEAD_URL: "https://prep.example.test/prepare", CAREER_PREPARE_AHEAD_TOKEN: tok });
  const seen: string[] = [];
  const f = (status: number, body: unknown) => (async (u: any, init: any) => { seen.push(String(u)); assert(init.headers.authorization === `Bearer ${tok}`); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  eq((await prepareHostStatus({ env: on, fetch: f(401, {}) })).state, "refused");
  eq((await prepareHostStatus({ env: on, fetch: f(200, { ok: true, service: "other" }) })).state, "unreachable");
  eq((await prepareHostStatus({ env: on, fetch: (async () => { throw Error("down"); }) as typeof fetch })).state, "unreachable");
  const up = await prepareHostStatus({ env: on, fetch: f(200, { ok: true, service: "prepare-ahead", in_flight: 2, runs: 5, started_at: "x" }) });
  eq([up.state, up.detail?.in_flight], ["up", 2]);
  eq(seen[0], "https://prep.example.test/status", "it reads the host's status, never its prepare door");
  for (const s of [off, up]) assert(!JSON.stringify(s).includes(tok), "the token is never in what it says");
  eq((await prepareHostStatus({ env: env({ CAREER_PREPARE_AHEAD_URL: "http://prep.example.test/x", CAREER_PREPARE_AHEAD_TOKEN: tok }) })).state, "unreachable", "plain http is refused");
});

// Owner rule (2026-10-27, back off then RESUME; 20261029190000): a claim let go before its engine started goes back to the
// queue (o.putBack) instead of being ended unsent: held behind another instance's refusal on a leased queue (until the
// hold), or the worker stopping. Its journal line is cleared BEFORE it is put back (a crash in between can never start
// it from the old lease); a started job is never put back.
Deno.test("mass-run: a claim let go before it started is put back (its host's hold as the time), journal line first; never one that started", async () => {
  const gate = localHostGate();
  const held = await gate.refused("h0.example.test", "rate_limited", 60, Date.now()); // another instance's refusal: h0 held for a minute
  const q = queue(6, 2), r = recorder(() => 2), order: string[] = [], put: { id: string; why: string; until: number }[] = [];
  const journal = {
    async put(job: MassJob) { order.push(`put:${job.id}`); }, async start(id: string) { order.push(`start:${id}`); },
    async done(id: string) { order.push(`done:${id}`); }, async list() { return []; },
  };
  const out = await massRun({
    claim: q.claim, run: r.run, orphaned: never, drain: false, idleMs: 5, stop: () => r.runs.size >= 3, log: () => {}, gate, journal,
    begin: async (jobs) => new Set(jobs.map((j) => j.id)),
    unstarted: async (j, why) => { throw Error(`ended unsent: ${j.id} ${why}`); },
    putBack: async (j, why, until) => { order.push(`back:${j.id}`); put.push({ id: j.id, why, until }); return { state: "queued", reason: why, recorded: true, not_before: until }; },
    pacing: pacingFrom(() => undefined, { concurrency: 8 }),
  });
  eq(put.map((p) => `${p.id}:${p.why}`).sort(), ["j000:HOST_HELD", "j002:HOST_HELD", "j004:HOST_HELD"], "h0's three go back, unstarted");
  assert(put.every((p) => p.until === held), `each not before its host's hold (${put.map((p) => p.until - held)})`);
  for (const p of put) assert(order.indexOf(`done:${p.id}`) >= 0 && order.indexOf(`done:${p.id}`) < order.indexOf(`back:${p.id}`), `${p.id}: journal line cleared before the put-back: ${order.join(" ")}`);
  assert(put.every((p) => !r.runs.has(p.id) && !order.includes(`start:${p.id}`)), "nothing put back had started");
  eq([...r.runs.keys()].sort(), ["j001", "j003", "j005"], "h1's ran");
  assert(out.filter((o) => o.state === "queued").length === 3 && out.every((o) => o.state !== "not_submitted"), JSON.stringify(out));
  // The worker stopping with claims waiting (spacing on one host): those go back too, not ended unsent.
  const q2 = queue(4, 1), r2 = recorder(() => 1), put2: string[] = [];
  let stop = false;
  await massRun({
    claim: q2.claim, run: async (j, onStart) => { stop = true; return await r2.run(j, onStart); }, orphaned: never, drain: true, idleMs: 5, stop: () => stop, log: () => {},
    unstarted: async (j, why) => { throw Error(`ended unsent: ${j.id} ${why}`); },
    putBack: async (j, why) => { put2.push(`${j.id}:${why}`); return { state: "queued", reason: why, recorded: true }; },
    pacing: pacingFrom(() => undefined, { concurrency: 4, hostSpacingMs: 1000 }),
  });
  eq(r2.runs.size, 1, "one started before the stop");
  assert(put2.length >= 1 && put2.every((x) => x.endsWith(":WORKER_STOPPING")), JSON.stringify(put2));
});

// A 503 at the page is a refusal for load with or without Retry-After (scripts/apply.ts pageRefusal), as a 429 is;
// nothing else is.
Deno.test("mass-run: pageRefusal: 429 and 503, with or without Retry-After, are refusals for load; nothing else is", () => {
  const at = Date.parse("2026-10-29T16:00:00Z");
  eq(pageRefusal(503, undefined, at), { status: 503, retry_after_s: null });
  eq(pageRefusal(503, "7", at), { status: 503, retry_after_s: 7 });
  eq(pageRefusal(503, "soon", at), { status: 503, retry_after_s: null });
  eq(pageRefusal(429, null, at), { status: 429, retry_after_s: null });
  eq(pageRefusal(429, "Thu, 29 Oct 2026 16:01:00 GMT", at), { status: 429, retry_after_s: 60 });
  for (const s of [200, 301, 302, 400, 403, 404, 500, 502, 504]) eq(pageRefusal(s, "7", at), null, String(s));
});
