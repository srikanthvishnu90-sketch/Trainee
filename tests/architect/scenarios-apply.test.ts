// The apply flow and mass submission at scale (owner rules, binding): one yes approves exactly the batch shown, each item
// by its hash; no volume cap of Trainee's own; back off only when an outside system refuses (a 429 with or without
// Retry-After, a 503 with one, a verification check), then resume; block only the exact same posting; never submit
// without a confirmed resume; a job running when a worker crashes is recorded unknown and never driven again; each
// approved application is submitted at most once. ~12,000 generated scenarios (tests/architect/scenarios/
// apply-generator.ts, seeded) on the real pure code:
//   postings   wantsFrom, screenPicks, queueWants (career_apply_want.ts), postingKey (posting_key.ts), admitApplication and
//              the SQL's own key rule (career_apply.ts): the same posting in any form is one posting; two postings are two
//   history    an earlier application in each queue state, around the 30-day mark, in several time zones: the same
//              posting is blocked while its earlier application counts (any age); another posting at the same company
//              never is (no employer cooldown, D-MS-3)
//   employers  screenPicks against current-employer facts: exact refuses, one name the leading words of the other asks,
//              unrelated / past / wished / unconfirmed pass; "apply anyway" passes
//   resumes    runApproved (approve-first.ts): the engine never starts without the approved resume file, byte-hash equal
//   retry      retryAfterSeconds and the host gate's wait: seconds and HTTP dates honored, garbage is the default doubling
//   hosts      runLoop (approve-first.ts) over massRun with a fake queue and engine: every job started once and recorded
//              once; the gate is told exactly the outside refusals (with the seconds the host asked); nothing starts on a
//              held host before its time; every host resumes; no number of ours
//   crashes    runLoop killed at five points and started again on the same journal: a started job is unknown, never
//              driven again; an unstarted one runs once under its lease (or is ended unsent); a recorded one stays recorded
//   cloud      cloudLoop (career-cloud/worker.ts): a host's Retry-After reaches the shared gate
//   workers    several runLoops on one queue: each job once
//   resume     back off, then RESUME (20261029180000): a host that refused before anything was sent (429 seconds, a date,
//              garbage, none; 503) 1-12 times then clears: the same job goes back to the queue, is never claimed before
//              its not-before time or twice at once, runs again and is submitted once; each refusal backs off again (the
//              host's Retry-After, else doubling), no cap of ours; a check, a wall and an unknown are never retried;
//              workers killed around a requeue: once the engine may have sent, never driven again; what the person is told
//              (a waiting job is approved and waiting; the same posting again is never "duplicate" or "already applied")
//   unstarted  claimed and never started (20261029190000): a worker stopped mid-batch, out of its lease budget, its host
//              held, killed during another job's engine and restarted past the budget: the same job goes back to the
//              queue and is submitted once later; never put back once its engine started; a check is the person's, an
//              unknown never retried; a 503 with no Retry-After is a refusal for load and resumes
// The end-to-end sample on real Postgres is flow-scenarios-apply.test.ts. No network, no model, no Chromium.
import assertNode from "node:assert/strict";
import {
  AGES, BACKOFF_REFUSING, backoffCases, BLOCKING, type CrashCase, crashCases, employerCases, historyCases, type Link, NOW, OUTSIDE_REFUSAL, postingCases, resumeCases,
  requeueCrashCases, RESUME_SHA, retryCases, rng, type SchedCase, schedCases, type UnstartedCase, unstartedCases,
} from "./scenarios/apply-generator.ts";
import { memoryWantStore, queueWants, samePosting, screenPicks, wantsFrom } from "../../supabase/functions/_shared/career_apply_want.ts";
import { formUrlFor, postingKey } from "../../supabase/functions/_shared/posting_key.ts";
import { admitApplication, postingKey as sqlKey } from "../../supabase/functions/_shared/career_apply.ts";
import { trackedFromRows } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
import { answerText } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { factsFromPayload, type Job, ownQueue, runApproved, runLoop } from "../../workers/career-browser/approve-first.ts";
import { cloudLoop, type CloudQueue } from "../../workers/career-cloud/worker.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { authorizer, cardBound, effectAware } from "../helpers/cloud_card_auth.ts";
import { backoffMs, type HostGate, hostOf, type Journal, type JournalEntry, localHostGate, pacingFrom, retryAfterSeconds } from "../../workers/career-browser/mass-run.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261029;
const U = "00000000-0000-4000-8000-0000000a9901";

// One report per part: every failure named by its input, the first few printed.
type Report = { name: string; total: number; fails: Map<string, string[]> };
const report = (name: string): Report => ({ name, total: 0, fails: new Map() });
function check(rep: Report, ok: boolean, kind: string, detail: () => string) {
  if (ok) return;
  if (!rep.fails.has(kind)) rep.fails.set(kind, []);
  rep.fails.get(kind)!.push(detail());
}
function done(rep: Report) {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[apply] ${rep.name}: ${rep.total} scenarios, ${n} failures`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 400)}`); }
  console.log(lines.join("\n"));
  eq(n, 0, lines.join("\n"));
}
// The link a pick is queued at (wantsFrom's own rule: a posting known by its id goes to its board's form).
const eff = (l: Link) => formUrlFor(String(l.job_id ?? "")) ?? l.url;
const pick = (l: Link) => ({ url: l.url, job_id: l.job_id, company: l.company, title: l.title });

// ------------------------------------------------------------------------------------------------ postings
const POSTINGS = postingCases(rng(SEED), 4000);
Deno.test(`postings: ${POSTINGS.length} generated pairs (the same posting in many forms, and different postings): exact-only dedupe on every path`, async () => {
  const rep = report("postings");
  for (const c of POSTINGS) {
    rep.total++;
    const name = () => `${c.family}/${c.form} same=${c.same}: ${JSON.stringify(c.a)} vs ${JSON.stringify(c.b)}`;
    const ka = postingKey(eff(c.a)), kb = postingKey(eff(c.b));
    check(rep, !!ka && !!kb, "a posting link is not read as a posting", () => `${name()} -> ${ka} / ${kb}`);
    // One posting is one key, compared as the queue compares them (samePosting: without case).
    check(rep, (samePosting(ka) === samePosting(kb)) === c.same, c.same ? "the same posting keyed twice" : "two postings keyed as one", () => `${name()} -> ${ka} / ${kb}`);
    // One batch with both: the same posting is queued once; two postings both.
    const w = wantsFrom([pick(c.a), pick(c.b)], NOW);
    check(rep, w.refused.length === 0 && w.ok.length === (c.same ? 1 : 2), "wantsFrom", () => `${name()} -> ok ${w.ok.length}, refused ${JSON.stringify(w.refused.map((x) => x.reason))}`);
    // Already applied to a: b is refused as the same posting exactly when it is one.
    const apps = trackedFromRows([{ id: "r1", company: c.company, state: "submitted_unconfirmed", created_at: new Date(NOW - 86_400_000).toISOString(), updated_at: new Date(NOW).toISOString(), url: eff(c.a) }]);
    const s = screenPicks([pick(c.b)], { apps, facts: [], now: NOW });
    const dup = s.refused.some((x) => /same posting/.test(x.reason));
    check(rep, dup === c.same, c.same ? "screenPicks missed the same posting" : "screenPicks blocked another posting", () => `${name()} -> ${JSON.stringify(s.refused.map((x) => x.reason))}`);
    check(rep, !s.refused.some((x) => /days|once per company|cooldown/i.test(x.reason)), "an employer rule", () => `${name()} -> ${JSON.stringify(s.refused.map((x) => x.reason))}`);
    // The database's own rule, mirrored (career_apply.ts admitApplication: the job id, or the canonical link).
    const adm = admitApplication([{ user_id: U, job_id: ka ?? c.a.url, company: c.company, at: NOW - 86_400_000, state: "submitted_unconfirmed", url: eff(c.a) }],
      { user_id: U, job_id: kb ?? c.b.url, company: c.company, url: eff(c.b) }, NOW);
    check(rep, (adm.reason === "duplicate_job") === c.same && (adm.ok || adm.reason === "duplicate_job"), "admitApplication", () => `${name()} -> ${JSON.stringify(adm)} (sql keys ${sqlKey(eff(c.a))} / ${sqlKey(eff(c.b))})`);
    // The queue, one turn after the other.
    const store = memoryWantStore();
    await queueWants(store, U, [pick(c.a)], NOW);
    const q = await queueWants(store, U, [pick(c.b)], NOW + 60_000);
    check(rep, c.same ? q.queued === 0 && q.already === 1 : q.queued === 1, "queueWants", () => `${name()} -> ${JSON.stringify({ queued: q.queued, already: q.already, refused: q.refused.map((x) => x.reason) })}`);
  }
  console.log(`[apply] postings by form: ${JSON.stringify(Object.fromEntries([...new Set(POSTINGS.map((c) => `${c.same ? "same" : "diff"}:${c.form}`))].sort().map((k) => [k, POSTINGS.filter((c) => `${c.same ? "same" : "diff"}:${c.form}` === k).length])))}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ history
const HISTORY = historyCases(rng(SEED + 1), 2000);
Deno.test(`history: ${HISTORY.length} earlier applications around the 30-day mark in several time zones: the same posting blocked while its application counts; another posting at the company never`, () => {
  const rep = report("history");
  for (const h of HISTORY) {
    rep.total++;
    const name = () => `${h.candidate} state=${h.state} age=${h.age} at ${h.applied_at}: ${eff(h.prior.a)} then ${eff(h.b)}`;
    const apps = trackedFromRows([{ id: "r1", company: h.prior.company, state: h.state, created_at: h.applied_at, updated_at: h.applied_at, url: eff(h.prior.a) }]);
    const s = screenPicks([pick(h.b)], { apps, facts: [], now: NOW });
    const blocked = s.refused.some((x) => /same posting/.test(x.reason));
    check(rep, blocked === h.blocked, h.blocked ? "the same posting was not blocked" : "a posting was blocked that is not a counted duplicate", () => `${name()} -> ${JSON.stringify(s.refused.map((x) => x.said))}`);
    check(rep, !s.refused.some((x) => /days|once per company|cooldown/i.test(`${x.reason} ${x.said}`)), "an employer cooldown", () => `${name()} -> ${JSON.stringify(s.refused.map((x) => x.said))}`);
    const adm = admitApplication([{ user_id: U, job_id: postingKey(eff(h.prior.a)) ?? "x", company: h.prior.company, at: Date.parse(h.applied_at), state: h.state, url: eff(h.prior.a) }],
      { user_id: U, job_id: postingKey(eff(h.b)) ?? "y", company: h.prior.company, url: eff(h.b) }, NOW);
    check(rep, (adm.reason === "duplicate_job") === h.blocked && (adm.ok || adm.reason === "duplicate_job"), "admitApplication", () => `${name()} -> ${JSON.stringify(adm)}`);
  }
  // The instants themselves: every zone's spelling is the same instant, and the boundary ages are what they say.
  for (const h of HISTORY) eq(Date.parse(h.applied_at), NOW - AGES[h.age], h.applied_at);
  console.log(`[apply] history: ${HISTORY.filter((h) => h.blocked).length} blocked (same posting, counted state), ${HISTORY.filter((h) => !h.blocked).length} not; states ${[...BLOCKING].join("/")} count`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ employers
const EMPLOYERS = employerCases(rng(SEED + 2), 2000);
Deno.test(`employers: ${EMPLOYERS.length} current-employer facts against a posting's employer: exact refused, partial asked, unrelated passes`, () => {
  const rep = report("employers");
  for (const e of EMPLOYERS) {
    rep.total++;
    const p = { url: "https://jobs.lever.co/acme/0f6e0c2a-1b2c-4d3e-8f90-123456789abc", company: e.company, title: "Data Analyst" };
    const s = screenPicks([p], { apps: [], facts: [e.fact], now: NOW, ...(e.goAhead ? { message: `apply to the Data Analyst role at ${e.company} anyway` } : {}) });
    const got = s.refused.some((x) => x.ask === "employer") ? "ask" : s.refused.some((x) => /current employer/.test(x.reason)) ? "refused" : "pass";
    check(rep, got === e.expect, `${e.kind}${e.goAhead ? "+anyway" : ""}: expected ${e.expect}`, () => `fact ${JSON.stringify(e.fact.value ?? e.fact.text)} (${e.fact.kind}, ${e.fact.status}, needs_confirmation ${e.fact.needs_confirmation}) vs posting at ${JSON.stringify(e.company)} -> ${got}: ${JSON.stringify(s.refused.map((x) => x.reason))}`);
    if (got !== "pass") check(rep, s.ok.length === 0, "a refused or asked posting was passed", () => e.company);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ resumes
const RESUMES = resumeCases(rng(SEED + 3), 600);
Deno.test(`resumes: ${RESUMES.length} approved payloads with every resume binding: the engine starts only with the approved file`, async () => {
  const rep = report("resumes");
  for (const c of RESUMES) {
    rep.total++;
    let engine = 0;
    const job: Job = { id: "j1", lease_token: "L1", url: "https://jobs.lever.co/acme/0f6e0c2a-1b2c-4d3e-8f90-123456789abc", user_id: U,
      payload: { version: 1, user_id: U, job_id: "lever:acme:0f6e0c2a", url: "https://jobs.lever.co/acme/0f6e0c2a-1b2c-4d3e-8f90-123456789abc", fields: [], engine_approval: "e".repeat(64),
        ...(c.payloadSha === undefined ? {} : { resume_sha256: c.payloadSha }) } };
    const fin: string[] = [];
    await runApproved({
      claim: async () => [job], finish: async (_id, _l, state) => { fin.push(state); },
      resumeFor: async () => c.file as any, writeFacts: async () => "/tmp/facts.json",
      runEngine: async () => { engine++; return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null }; },
    });
    check(rep, (engine === 1) === c.starts, c.starts ? "the approved file did not start" : "the engine started without the approved resume", () => `${c.kind}: payload ${JSON.stringify(c.payloadSha)} file ${JSON.stringify(c.file)}`);
    check(rep, eq2(fin, [c.starts ? "submitted_unconfirmed" : "not_submitted"]), "recorded", () => `${c.kind} -> ${fin}`);
  }
  done(rep);
});
const eq2 = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------------------------------------ Retry-After
const RETRIES = retryCases(rng(SEED + 4), 1500);
Deno.test(`retry: ${RETRIES.length} Retry-After values: seconds and HTTP dates honored (at most a day), garbage is no answer; the gate waits that long or the default doubling`, async () => {
  const rep = report("retry");
  for (const c of RETRIES) {
    rep.total++;
    const got = retryAfterSeconds(c.header, NOW);
    check(rep, got === c.expect, `${c.form}`, () => `${JSON.stringify(c.header)} -> ${got}, expected ${c.expect}`);
    const until = await localHostGate().refused("h.example.test", "rate_limited", got, NOW);
    const want = c.expect === null ? 30_000 : c.expect * 1000;
    check(rep, until - NOW === want, `${c.form}: the gate's wait`, () => `${JSON.stringify(c.header)} -> held ${until - NOW} ms, expected ${want}`);
    // A refusal always holds the host for some time unless the host itself said "now" (0 seconds, or a date already past).
    check(rep, until - NOW > 0 || c.expect === 0, "a refusal not held", () => JSON.stringify(c.header));
  }
  eq([backoffMs(0, null), backoffMs(1, null), backoffMs(7, null), backoffMs(20, null)], [30_000, 60_000, 3_600_000, 3_600_000]);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ the worker, faked around
// A queue with the database's transitions (career_apply_claim_own / career_apply_finish_own): a claim takes queued rows
// to driving under a fresh lease; a finish needs driving and the lease, else "invalid apply transition".
interface Row { id: string; url: string; state: string; lease_token: string | null; claimed_at: string | null; reason: string | null; finishes: number;
  not_before?: number; requeues?: number; claims?: number[]; early?: number; putbacks?: number; badPutBacks?: number }
type Life = { dead: boolean; die: () => void };
const never = <T>() => new Promise<T>(() => {});
function life(): Life & { died: Promise<void> } {
  let res: () => void = () => {};
  const died = new Promise<void>((r) => { res = r; });
  const l = { dead: false, died, die: () => { if (!l.dead) { l.dead = true; res(); } } };
  return l;
}
// requeue: the database has 20261029180000 (career_apply_requeue_refused_own, and no claim before a job's not_before) and
// 20261029190000 (career_apply_requeue_unstarted_own: a claim whose engine never started goes back); without them, a
// refusal and an unstarted claim are recorded not sent, as before. `started(id)`: the test's engine says it started under
// the row's current lease; a put-back of that lease is counted as a violation (badPutBacks) and refused.
function fakeDb(urls: string[], o: { requeue?: boolean } = {}) {
  const rows = new Map<string, Row>(urls.map((url, i) => [`j${String(i).padStart(3, "0")}`, { id: `j${String(i).padStart(3, "0")}`, url, state: "queued", lease_token: null, claimed_at: null, reason: null, finishes: 0, requeues: 0, claims: [], early: 0, putbacks: 0, badPutBacks: 0 }]));
  const startedLeases = new Set<string>();
  const started = (id: string) => { const l = rows.get(id)?.lease_token; if (l) startedLeases.add(l); };
  const payload = (r: Row) => ({ version: 1, user_id: U, job_id: r.id, url: r.url, fields: [], engine_approval: "e".repeat(64), resume_sha256: RESUME_SHA });
  let seq = 0;
  const rpc = async (name: string, a: any, l?: Life, hook?: (name: string, a: any) => void) => {
    if (l?.dead) return await never<any>();
    hook?.(name, a);
    if (l?.dead) return await never<any>();
    if (name === "career_apply_claim_own") {
      const t = Date.now();
      const out = [...rows.values()].filter((r) => r.state === "queued" && (!o.requeue || (r.not_before ?? 0) <= t)).slice(0, Math.max(0, a.p_limit));
      for (const r of out) { r.state = "driving"; r.lease_token = `L${++seq}`; r.claimed_at = new Date(t).toISOString(); r.claims!.push(t); if (t < (r.not_before ?? 0)) r.early!++; }
      return { data: out.map((r) => ({ id: r.id, lease_token: r.lease_token, url: r.url, user_id: U, claimed_at: r.claimed_at, payload: payload(r) })), error: null };
    }
    if (name === "career_apply_finish_own") {
      const r = rows.get(a.p_id);
      if (!r || r.state !== "driving" || r.lease_token !== a.p_lease) return { data: null, error: { message: "invalid apply transition" } };
      r.state = a.p_state; r.reason = String(a.p_evidence?.reason ?? ""); r.finishes++;
      return { data: { id: r.id, state: r.state }, error: null };
    }
    if (name === "career_apply_requeue_refused_own" && o.requeue) {
      const r = rows.get(a.p_id);
      if (!r || r.state !== "driving" || r.lease_token !== a.p_lease) return { data: null, error: { message: "invalid apply claim" } };
      if (!["rate_limited", "server_busy", "quota"].includes(a.p_reason)) return { data: null, error: { message: "invalid portal refusal" } };
      // The gate's hold (the SQL takes the later of it and the host's Retry-After; the test's gate already counts it, scaled).
      const nb = Math.max(Date.parse(a.p_until), Date.now());
      r.state = "queued"; r.lease_token = null; r.claimed_at = null; r.not_before = nb; r.requeues!++; r.reason = "waiting: the employer's site asked us to slow down";
      return { data: { id: r.id, state: "queued", not_before: new Date(nb).toISOString() }, error: null };
    }
    if (name === "career_apply_requeue_unstarted_own" && o.requeue) {
      const r = rows.get(a.p_id);
      if (!["worker_stopping", "not_started_in_lease", "host_held", "journal_unwritable"].includes(a.p_why)) return { data: null, error: { code: "P0001", message: "invalid unstarted reason" } };
      if (!r || r.state !== "driving" || r.lease_token !== a.p_lease) return { data: null, error: { code: "P0001", message: "invalid apply claim" } };
      if (startedLeases.has(a.p_lease)) { r.badPutBacks!++; return { data: null, error: { code: "P0001", message: "invalid apply transition" } }; }
      const nb = Math.max(Date.parse(a.p_until), Date.now());
      r.state = "queued"; r.lease_token = null; r.claimed_at = null; r.not_before = nb; r.putbacks!++; r.reason = "waiting: approved, not started yet";
      return { data: { id: r.id, state: "queued", not_before: new Date(nb).toISOString() }, error: null };
    }
    return { data: null, error: { message: `no function ${name}` } };
  };
  // The database's own sweep (a drive past its lease is unknown, never driven again).
  const sweep = () => { for (const r of rows.values()) if (r.state === "driving") { r.state = "unknown_outcome"; r.reason = "swept"; } };
  return { rows, rpc, sweep, started };
}
// A journal kept in memory (the durable file, as another process would find it), seen through one worker's life.
function memJournal() {
  const entries = new Map<string, JournalEntry<Job>>();
  const view = (l: Life, hooks: { start?: (id: string, phase: "before" | "after") => void; done?: (id: string) => void } = {}, downtimeMs = 0): Journal<Job> => ({
    async put(job, claimedAt) { if (l.dead) return await never(); entries.set(job.id, { job: structuredClone(job), claimedAt, started: false }); },
    async start(id) {
      hooks.start?.(id, "before");
      if (l.dead) return await never();
      const e = entries.get(id)!;
      entries.set(id, { ...e, started: true });
      hooks.start?.(id, "after");
      if (l.dead) return await never();
    },
    async done(id) { hooks.done?.(id); if (l.dead) return await never(); entries.delete(id); },
    async list() {
      return [...entries.values()].map((e) => ({ job: { ...structuredClone(e.job), claimed_at: e.job.claimed_at ? new Date(Date.parse(e.job.claimed_at as any) - downtimeMs).toISOString() : null } as any, claimedAt: e.claimedAt - downtimeMs, started: e.started }))
        .sort((a, b) => a.claimedAt - b.claimedAt);
    },
  });
  return { entries, view };
}
// A gate that records what it is told and holds a host a few milliseconds (the real waits are the retry part's).
function recGate() {
  const calls: { host: string; why: string; retryAfterS: number | null; at: number; until: number }[] = [], holds = new Map<string, number>();
  const gate: HostGate = {
    shared: true,
    async until(hosts) { return new Map(hosts.map((h) => [h, holds.get(h) ?? 0])); },
    async refused(host, why, retryAfterS, at) { const until = at + 4; calls.push({ host, why, retryAfterS, at, until }); holds.set(host, Math.max(holds.get(host) ?? 0, until)); return until; },
    async ok() {},
  };
  return { gate, calls };
}
const appId = (args: string[]) => args[args.indexOf("--application-id") + 1];
const quiet = { log: () => {}, sleep: async () => {}, idleMs: 1, writeFacts: async () => "/tmp/facts.json", resume: { path: "/tmp/resume.pdf", sha256: RESUME_SHA } };

// ------------------------------------------------------------------------------------------------ hosts
// On a queue without the requeue (a database before 20261029180000): a refused job is recorded not sent, as before, and
// the scheduler still never drives anything twice. With the requeue, the resume part below.
const SCHED = schedCases(rng(SEED + 5), 1500);
Deno.test(`hosts: ${SCHED.length} batches over hosts that answer, rate-limit (seconds, dates, garbage, none), are busy, check, wall, fail or time out: every job once, the gate told exactly the refusals, held hosts wait, then resume; no number of ours`, async () => {
  const rep = report("hosts");
  for (const c of SCHED) {
    rep.total++;
    const db = fakeDb(c.jobs.map((j) => j.url));
    const plan = new Map(c.hosts.map((h) => [h.host, h]));
    const seen = new Map<string, number>(), engine = new Map<string, number>(), starts: { id: string; host: string; at: number }[] = [];
    const told = new Map<string, number | null>(); // job -> the seconds the engine reported, for each refusal
    let inFlight = 0, peak = 0;
    const { gate, calls } = recGate();
    const name = () => `case ${c.id} slots ${c.slots}: ${c.hosts.map((h) => `${h.host}=${h.behavior}${h.header !== null ? `(${JSON.stringify(h.header)})` : ""}`).join(", ")}; ${c.jobs.length} jobs`;
    await runLoop({
      ...quiet, queue: ownQueue({ rpc: (n, a) => db.rpc(n, a) }), stop: () => false, drain: true, gate,
      pacing: pacingFrom(() => undefined, { concurrency: c.slots }),
      runEngine: async (args) => {
        const id = appId(args), url = args[args.indexOf("--url") + 1], h = plan.get(hostOf(url))!;
        starts.push({ id, host: h.host, at: Date.now() });
        engine.set(id, (engine.get(id) ?? 0) + 1);
        const n = (seen.get(h.host) ?? 0) + 1;
        seen.set(h.host, n);
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        const limited = (status: number) => { const s = retryAfterSeconds(h.header, Date.now()); told.set(id, s); return { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status, retry_after_s: s }, evidence: null }; };
        switch (h.behavior) {
          case "ok": return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
          case "rate_limited_seconds": case "rate_limited_date": case "rate_limited_garbage": case "rate_limited_none": return limited(429);
          case "busy_503": return limited(503);
          case "refuses_mid_batch": return n > h.refuseFrom! ? limited(429) : { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
          case "captcha": return { result: { state: "needs_user", reason: "captcha" }, evidence: null };
          case "login_wall": return { result: { state: "not_submitted", reason: "ACCOUNT_LOGIN_REQUIRED" }, evidence: null };
          case "server_error": return { result: { state: "failed", reason: "SUBMIT_HTTP_500" }, evidence: null };
          case "timeout": return null;
        }
      },
    });
    // Every job started once and recorded once: nothing dropped behind a refusal (each host resumed), nothing twice.
    for (const j of c.jobs) {
      const id = [...db.rows.values()].find((r) => r.url === j.url)!.id;
      check(rep, engine.get(id) === 1, "a job's engine did not start exactly once", () => `${name()}: ${j.url} started ${engine.get(id) ?? 0}`);
    }
    for (const r of db.rows.values()) {
      check(rep, r.finishes === 1 && !["queued", "driving"].includes(r.state), "a job not recorded exactly once", () => `${name()}: ${r.id} ${r.state} x${r.finishes}`);
      const h = plan.get(hostOf(r.url))!;
      const want = { ok: "submitted_unconfirmed", captcha: "needs_user", login_wall: "needs_user", server_error: "failed", timeout: "unknown_outcome" }[h.behavior as string] ?? null;
      if (want) check(rep, r.state === want, `${h.behavior} recorded as ${want}`, () => `${name()}: ${r.id} ${r.state} (${r.reason})`);
    }
    // The gate was told exactly the outside refusals, each with the seconds the host asked for (or none).
    const refusedIds = new Set(starts.filter((s) => {
      const h = plan.get(s.host)!;
      return OUTSIDE_REFUSAL.has(h.behavior) || (h.behavior === "refuses_mid_batch" && told.has(s.id));
    }).map((s) => s.id));
    check(rep, calls.length === refusedIds.size, "the gate was not told exactly the refusals", () => `${name()}: told ${calls.length} (${calls.map((x) => `${x.host}:${x.why}`).join(",")}), refusals ${refusedIds.size}`);
    for (const k of calls) {
      const h = plan.get(k.host)!;
      check(rep, OUTSIDE_REFUSAL.has(h.behavior) || h.behavior === "refuses_mid_batch", "held off a host that did not refuse", () => `${name()}: ${k.host} ${h.behavior}`);
      check(rep, k.why === (h.behavior === "captcha" ? "bot_check" : "rate_limited"), "the refusal's kind", () => `${name()}: ${k.host} ${h.behavior} -> ${k.why}`);
      if (h.behavior !== "captcha") {
        const asked = [...told.values()];
        check(rep, asked.some((s) => s === k.retryAfterS), "the gate was not given the seconds the host asked for", () => `${name()}: ${k.host} ${h.behavior} header ${JSON.stringify(h.header)} -> gate got ${k.retryAfterS}, engine said ${JSON.stringify(asked)}`);
      }
    }
    // Held hosts wait: no start on a host after its refusal and before its time.
    for (const k of calls) {
      const early = starts.filter((s) => s.host === k.host && s.at > k.at && s.at < k.until);
      check(rep, early.length === 0, "a start inside a host's hold", () => `${name()}: ${k.host} held ${k.at}..${k.until}, started ${early.map((s) => s.at)}`);
    }
    // No number of ours: with every host answering, as many run at once as the machine's slots (or the jobs) allow.
    if (c.hosts.every((h) => h.behavior === "ok")) check(rep, peak >= Math.min(c.slots, c.jobs.length), "fewer at once than the slots", () => `${name()}: peak ${peak}`);
  }
  const d = pacingFrom(() => undefined, {}, () => 9);
  eq([d.concurrency, d.claimBatch, d.hostMax, d.hostSpacingMs], [9, 9, Infinity, 0], "the only default is the machine's capacity");
  done(rep);
});

// ------------------------------------------------------------------------------------------------ crashes
const CRASHES = crashCases(rng(SEED + 6), 1000);
async function crashRun(c: CrashCase) {
  const urls = Array.from({ length: c.jobs }, (_, i) => `https://c${c.id}-${i % c.hosts}.example.test/job/${i}`);
  const db = fakeDb(urls), j = memJournal(), engine = new Map<string, number>(), by1 = new Set<string>();
  const target = `j${String(c.at).padStart(3, "0")}`;
  const one = life(), two = life();
  const behave = async (args: string[], l: Life, who: number) => {
    if (l.dead) return await never<any>();
    const id = appId(args);
    engine.set(id, (engine.get(id) ?? 0) + 1);
    if (who === 1) by1.add(id);
    if (who === 1 && id === target && c.point === "during_engine") { l.die(); return await never<any>(); }
    await new Promise((r) => setTimeout(r, 0));
    if (l.dead) return await never<any>();
    return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
  };
  const hook1 = (name: string, a: any) => {
    if (name === "career_apply_finish_own" && a.p_id === target && c.point === "after_engine_before_record") one.die();
  };
  const w1 = runLoop({
    ...quiet, stop: () => false, drain: true, gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: c.slots }),
    queue: ownQueue({ rpc: (n, a) => db.rpc(n, a, one, hook1) }),
    journal: j.view(one, {
      start: (id, phase) => {
        if (id !== target) return;
        if (phase === "before" && c.point === "before_journal_start") one.die();
        if (phase === "after" && c.point === "after_start_before_engine") one.die();
      },
      done: (id) => { if (id === target && c.point === "after_record_before_clear") one.die(); },
    }),
    runEngine: (args) => behave(args, one, 1),
  });
  // The first worker dies at its point (or, if it never reaches it, finishes).
  await Promise.race([one.died, w1]);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const before = new Map([...db.rows.values()].map((r) => [r.id, r.state]));
  const startedBy1 = new Set([...j.entries.values()].filter((e) => e.started).map((e) => e.job.id));
  // Started again on the same journal (an hour later when the claims' time has run out).
  await runLoop({
    ...quiet, stop: () => false, drain: true, gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: c.slots }),
    queue: ownQueue({ rpc: (n, a) => db.rpc(n, a, two) }), journal: j.view(two, {}, c.budgetLeft ? 0 : 3_600_000),
    runEngine: (args) => behave(args, two, 2),
  });
  db.sweep();
  return { db, engine, by1, target, before, startedBy1, died: one.dead };
}
Deno.test(`crashes: ${CRASHES.length} workers killed at five points and started again on the same journal: started is unknown and never driven again, unstarted runs once or ends unsent, recorded stays`, async () => {
  const rep = report("crashes");
  for (const c of CRASHES) {
    rep.total++;
    const r = await crashRun(c);
    const name = () => `case ${c.id}: ${c.jobs} jobs on ${c.hosts} hosts, slots ${c.slots}, killed ${c.point} of ${r.target}${c.budgetLeft ? "" : ", restarted after the lease"}`;
    check(rep, r.died, "the worker never reached its crash point", name);
    for (const row of r.db.rows.values()) {
      const n = r.engine.get(row.id) ?? 0;
      check(rep, n <= 1, "an engine started twice", () => `${name()}: ${row.id} x${n}`);
      check(rep, !["queued", "driving"].includes(row.state), "left unfinished", () => `${name()}: ${row.id} ${row.state}`);
      // Started by the dead worker and not recorded by it: unknown, and the restart never drove it.
      if (r.startedBy1.has(row.id) && ["driving"].includes(r.before.get(row.id)!)) {
        check(rep, row.state === "unknown_outcome", "a started job not recorded unknown", () => `${name()}: ${row.id} ${row.state}`);
        check(rep, n === (r.by1.has(row.id) ? 1 : 0), "a started job driven again", () => `${name()}: ${row.id} engine x${n}`);
      }
      // What the dead worker recorded stays (a sent application never turns unknown or is sent again).
      const was = r.before.get(row.id)!;
      if (!["queued", "driving"].includes(was)) check(rep, row.state === was && row.finishes === 1, "a recorded outcome changed", () => `${name()}: ${row.id} ${was} -> ${row.state} x${row.finishes}`);
      if (row.state === "submitted_unconfirmed") check(rep, n === 1, "recorded sent without one engine start", () => `${name()}: ${row.id}`);
      if (row.state === "not_submitted") check(rep, n === 0, "recorded unsent after an engine start", () => `${name()}: ${row.id}`);
    }
    const t = r.db.rows.get(r.target)!, n = r.engine.get(r.target) ?? 0;
    if (c.point === "before_journal_start") {
      check(rep, c.budgetLeft ? t.state === "submitted_unconfirmed" && n === 1 : t.state === "not_submitted" && n === 0, "the unstarted job", () => `${name()}: ${t.state} engine x${n}`);
    } else if (c.point === "after_record_before_clear") {
      check(rep, t.state === "submitted_unconfirmed" && n === 1, "the recorded job", () => `${name()}: ${t.state} engine x${n}`);
    } else {
      check(rep, t.state === "unknown_outcome" && n === (c.point === "after_start_before_engine" ? 0 : 1), "the started job", () => `${name()}: ${t.state} engine x${n}`);
    }
  }
  console.log(`[apply] crashes by point: ${JSON.stringify(Object.fromEntries(["before_journal_start", "after_start_before_engine", "during_engine", "after_engine_before_record", "after_record_before_clear"].map((p) => [p, CRASHES.filter((c) => c.point === p).length])))}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ the cloud worker
Deno.test("hosts, the cloud worker: 120 batches whose hosts rate-limit with a Retry-After: the shared gate is given the seconds asked for; each job once", async () => {
  const rep = report("hosts (cloud)");
  const r = rng(SEED + 8);
  const RESUME = new TextEncoder().encode("%PDF-1.4 TEST apply scenarios");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", RESUME))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const tmp = await Deno.makeTempDir({ prefix: "trainee-apply-scen-" });
  try {
    for (let k = 0; k < 120; k++) {
      rep.total++;
      const n = r.int(2, 8), asked = r.pick([0, 1, 30, 120, 3600, null]);
      const jobs = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const payload: any = { version: 1, user_id: "A", job_id: `lever:t${k}:${i}`, company: `TEST Co ${i}`, url: `https://c${k}-${i % 2}.lever.test/t/${i}`, fields: [{ name: "first_name", label: "First name", value: "TEST A", factId: `TEST-A-${i}` }],
          destination: `https://c${k}-${i % 2}.lever.test/t/${i}/apply`, resume_sha256: sha, privacy_epoch: 1, account_version: 1, expires_at: "2099-01-01T00:00:00Z" };
        payload.engine_approval = await hashApplyPayload(factsFromPayload(payload).saved);
        return await cardBound({ id: `job-${k}-${i}`, lease_token: `lease-${k}-${i}`, user_id: "A", company: payload.company, url: payload.url, payload });
      }));
      let pending = [...jobs];
      const finished: string[] = [], engine = new Map<string, number>();
      const q: CloudQueue = {
        claim: async (limit) => { const out = pending.slice(0, limit); pending = pending.slice(limit); return out; },
        resume: async () => ({ filename: "r.pdf", sha256: sha, b64: btoa(String.fromCharCode(...RESUME)) }),
        finish: async (j, state) => { finished.push(`${j.id}:${state}`); }, ask: async () => 0, gatePresent: async () => true, authorize: authorizer().authorize,
      };
      const { gate, calls } = recGate();
      await cloudLoop({ queue: q, tmpRoot: tmp, idleMs: 1, drain: true, stop: () => false, log: () => {}, gate, pacing: pacingFrom(() => undefined, { concurrency: r.int(1, 4) }),
        runEngine: effectAware(async (args: string[]) => {
          const url = args[args.indexOf("--url") + 1];
          engine.set(url, (engine.get(url) ?? 0) + 1);
          return url.includes(`c${k}-0.`) ? { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status: 429, retry_after_s: asked }, evidence: null }
            : { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: { post: { status: 200, mutations: 1 } } };
        }) });
      const limited = jobs.filter((j) => j.url.includes(`c${k}-0.`)).length;
      check(rep, finished.length === n && [...engine.values()].every((x) => x === 1) && engine.size === n, "each job once", () => `batch ${k}: ${finished.length} finished, engine ${JSON.stringify([...engine])}`);
      check(rep, calls.length === limited && calls.every((c) => c.why === "rate_limited" && c.retryAfterS === asked), "the gate was not given the seconds asked for",
        () => `batch ${k}: asked ${asked}, gate got ${JSON.stringify(calls.map((c) => c.retryAfterS))} for ${limited} refusals`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ workers
Deno.test("workers: 300 rounds of 2-6 workers draining one queue at once: every job started once and recorded once", async () => {
  const rep = report("workers");
  const r = rng(SEED + 7);
  for (let k = 0; k < 300; k++) {
    rep.total++;
    const n = r.int(5, 40), workers = r.int(2, 6), hosts = r.int(1, 6);
    const db = fakeDb(Array.from({ length: n }, (_, i) => `https://w${k}-${i % hosts}.example.test/job/${i}`));
    const engine = new Map<string, number>();
    await Promise.all(Array.from({ length: workers }, () => runLoop({
      ...quiet, stop: () => false, drain: true, gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: r.int(1, 5) }),
      queue: ownQueue({ rpc: (nm, a) => db.rpc(nm, a) }),
      runEngine: async (args) => { const id = appId(args); engine.set(id, (engine.get(id) ?? 0) + 1); await new Promise((x) => setTimeout(x, 0)); return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null }; },
    })));
    for (const row of db.rows.values()) check(rep, engine.get(row.id) === 1 && row.finishes === 1 && row.state === "submitted_unconfirmed", "a job not run and recorded exactly once", () => `round ${k} (${workers} workers, ${n} jobs): ${row.id} engine x${engine.get(row.id) ?? 0}, ${row.state} x${row.finishes}`);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ back off, then resume
// Owner rule (binding, 2026-10-27): "Back off only when an outside system refuses (429, quota, bot wall), then RESUME".
// A job whose host refused before anything was sent goes back to the queue (career_apply_requeue_refused_own,
// 20261029180000) and runs again once the host's hold ends: submitted once, with no new approval. The fake queue below has
// the requeue; the hosts part above is the same scheduler on a database without it (recorded not sent, as before).
// The gate is the worker's own rule (backoffMs: Retry-After, else 30 s doubling) on a scaled clock: one logical second
// is 1/SCALE s here, so the waits are real but short; what was asked for is kept for the assertions.
const SCALE = 5000;
function scaledGate() {
  const level = new Map<string, number>(), held = new Map<string, number>();
  const calls: { host: string; why: string; retryAfterS: number | null; level: number; logical: number; at: number; until: number }[] = [];
  const gate: HostGate = {
    shared: true,
    async until(hosts) { return new Map(hosts.map((h) => [h, held.get(h) ?? 0])); },
    async refused(host, why, retryAfterS, at) {
      const lv = level.get(host) ?? 0, logical = backoffMs(lv, retryAfterS);
      level.set(host, lv + 1);
      const until = Math.max(held.get(host) ?? 0, at + Math.ceil(logical / SCALE));
      held.set(host, until);
      calls.push({ host, why, retryAfterS, level: lv, logical, at, until });
      return until;
    },
    async ok(host) { level.set(host, 0); },
  };
  return { gate, calls };
}
const BACKOFF = backoffCases(rng(SEED + 9), 240);
Deno.test(`resume: ${BACKOFF.length} batches whose hosts refuse (429 with seconds, a date, garbage, none; 503) 1-12 times then clear, beside hosts that answer, check, wall or time out, 1-3 workers at once: every refused job runs again and is submitted once; each refusal backs off again; checks and unknowns never retried`, async () => {
  const rep = report("resume");
  for (const c of BACKOFF) {
    rep.total++;
    const db = fakeDb(c.jobs.map((j) => j.url), { requeue: true });
    const plan = new Map(c.hosts.map((h) => [h.host, h]));
    const engine = new Map<string, number>(), attempts = new Map<string, number>(), refusedOf = new Map<string, number>();
    const starts: { id: string; host: string; at: number }[] = [], inFlight = new Set<string>();
    let overlap = 0;
    const { gate, calls } = scaledGate();
    const name = () => `case ${c.id} slots ${c.slots} workers ${c.workers}: ${c.hosts.map((h) => `${h.host}=${h.behavior}x${h.refuseTimes}${h.header !== null ? `(${JSON.stringify(h.header)})` : ""}`).join(", ")}; ${c.jobs.length} jobs`;
    let stopAll = false;
    const deadline = setTimeout(() => { stopAll = true; }, 30_000);
    await Promise.all(Array.from({ length: c.workers }, () => runLoop({
      ...quiet, queue: ownQueue({ rpc: (n, a) => db.rpc(n, a) }), stop: () => stopAll, drain: true, gate,
      pacing: pacingFrom(() => undefined, { concurrency: c.slots }),
      runEngine: async (args) => {
        const id = appId(args), url = args[args.indexOf("--url") + 1], h = plan.get(hostOf(url))!;
        if (inFlight.has(id)) overlap++;
        inFlight.add(id);
        starts.push({ id, host: h.host, at: Date.now() });
        engine.set(id, (engine.get(id) ?? 0) + 1);
        const n = (attempts.get(h.host) ?? 0) + 1;
        attempts.set(h.host, n);
        await new Promise((r) => setTimeout(r, 1));
        inFlight.delete(id);
        if (BACKOFF_REFUSING.has(h.behavior) && n <= h.refuseTimes) {
          refusedOf.set(id, (refusedOf.get(id) ?? 0) + 1);
          // The engine's own parse of the header, at the fixed instant the dates were written for (a 503 with no
          // Retry-After: none, the default doubling).
          const s = retryAfterSeconds(h.header, NOW);
          return { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status: h.behavior.startsWith("busy_503") ? 503 : 429, retry_after_s: s } as any, evidence: null };
        }
        switch (h.behavior) {
          case "captcha": return { result: { state: "needs_user", reason: "captcha" }, evidence: null };
          case "login_wall": return { result: { state: "not_submitted", reason: "ACCOUNT_LOGIN_REQUIRED" }, evidence: null };
          case "timeout": return null;
          default: return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
        }
      },
    })));
    clearTimeout(deadline);
    check(rep, !stopAll, "the workers did not drain the queue in time", name);
    check(rep, overlap === 0, "a job driven twice at once", () => `${name()}: ${overlap}`);
    const hostOfId = new Map([...db.rows.values()].map((r) => [r.id, hostOf(r.url)]));
    for (const r of db.rows.values()) {
      const h = plan.get(hostOf(r.url))!, n = engine.get(r.id) ?? 0, refused = refusedOf.get(r.id) ?? 0;
      check(rep, r.finishes === 1 && !["queued", "driving"].includes(r.state), "a job not recorded exactly once", () => `${name()}: ${r.id} ${r.state} x${r.finishes}`);
      check(rep, r.early === 0, "a job claimed before its not-before time", () => `${name()}: ${r.id} early x${r.early}`);
      if (BACKOFF_REFUSING.has(h.behavior)) {
        // Refused, put back, run again: submitted once, its engine started once per refusal and once more.
        check(rep, r.state === "submitted_unconfirmed", "a refused job did not run again and get submitted", () => `${name()}: ${r.id} ${r.state} (${r.reason}) after ${refused} refusals`);
        check(rep, r.requeues === refused && n === refused + 1, "requeues and engine starts do not match the refusals", () => `${name()}: ${r.id} refused ${refused}, requeued ${r.requeues}, engine x${n}`);
      } else {
        const want = ({ ok: "submitted_unconfirmed", captcha: "needs_user", login_wall: "needs_user", timeout: "unknown_outcome" } as Record<string, string>)[h.behavior];
        check(rep, r.state === want && n === 1 && r.requeues === 0, `${h.behavior}: ${want}, driven once, never put back`, () => `${name()}: ${r.id} ${r.state} engine x${n} requeued ${r.requeues}`);
      }
    }
    // Every refusal held its host again (the gate was told each one), as long as the host asked, or 30 s doubling.
    for (const h of c.hosts) {
      const mine = calls.filter((k) => k.host === h.host);
      const refusals = [...refusedOf.entries()].filter(([id]) => hostOfId.get(id) === h.host).reduce((a, [, x]) => a + x, 0);
      if (BACKOFF_REFUSING.has(h.behavior)) {
        const jobsHere = [...db.rows.values()].filter((r) => hostOf(r.url) === h.host).length;
        check(rep, mine.length === refusals && (jobsHere === 0 || refusals === h.refuseTimes), "the gate was not told each refusal", () => `${name()}: ${h.host} told ${mine.length}, refused ${refusals} of ${h.refuseTimes}`);
        const asked = retryAfterSeconds(h.header, NOW);
        for (const k of mine) {
          check(rep, k.logical === (asked !== null ? Math.min(asked * 1000, 86_400_000) : Math.min(3_600_000, 30_000 * 2 ** k.level)), "the wait is not the host's Retry-After or the doubling",
            () => `${name()}: ${h.host} ${JSON.stringify(h.header)} level ${k.level} -> ${k.logical} ms`);
        }
        // Refusals in a row with no Retry-After back off longer each time (nothing answered in between on this host).
        if (asked === null && c.slots === 1 && c.workers === 1) {
          const levels = mine.map((k) => k.level);
          check(rep, levels.every((lv, i) => lv === i), "a refusal in a row did not back off longer", () => `${name()}: ${h.host} levels ${levels}`);
        }
      } else if (h.behavior === "captcha") {
        check(rep, mine.every((k) => k.why === "bot_check"), "a check told as a load refusal", () => `${name()}: ${h.host}`);
      } else {
        check(rep, mine.length === 0, "held off a host that did not refuse", () => `${name()}: ${h.host} ${h.behavior}`);
      }
      // Held hosts wait: no engine start on a host after a refusal and inside its hold.
      for (const k of mine) {
        const early = starts.filter((s) => s.host === h.host && s.at > k.at && s.at < k.until);
        check(rep, early.length === 0, "a start inside a host's hold", () => `${name()}: ${h.host} held ${k.at}..${k.until}, started ${early.map((s) => s.at)}`);
      }
    }
  }
  console.log(`[apply] resume: ${BACKOFF.filter((c) => c.hosts.some((h) => h.refuseTimes >= 8)).length} batches with a host refusing 8-12 times in a row`);
  done(rep);
});

// The cloud worker (cloudLoop, career_apply_requeue_refused_for): the same, over a queue that puts a job back and hands it
// out only after its time; a refused run never asked for its effect (nothing was sent).
Deno.test("resume, the cloud worker: 120 batches whose host refuses 1-4 times with a Retry-After then clears: each job put back, run again, submitted once; never claimed before its time", async () => {
  const rep = report("resume (cloud)");
  const r = rng(SEED + 11);
  const RESUME = new TextEncoder().encode("%PDF-1.4 TEST apply scenarios");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", RESUME))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const tmp = await Deno.makeTempDir({ prefix: "trainee-apply-resume-" });
  try {
    for (let k = 0; k < 120; k++) {
      rep.total++;
      const n = r.int(1, 6), refuse = r.int(1, 4), asked = r.pick([0, 1, 5, 30, 90, null]);
      const jobs = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const payload: any = { version: 1, user_id: "A", job_id: `lever:r${k}:${i}`, company: `TEST Co ${i}`, url: `https://r${k}-${i % 2}.lever.test/t/${i}`, fields: [{ name: "first_name", label: "First name", value: "TEST A", factId: `TEST-A-${i}` }],
          destination: `https://r${k}-${i % 2}.lever.test/t/${i}/apply`, resume_sha256: sha, privacy_epoch: 1, account_version: 1, expires_at: "2099-01-01T00:00:00Z" };
        payload.engine_approval = await hashApplyPayload(factsFromPayload(payload).saved);
        return await cardBound({ id: `job-${k}-${i}`, lease_token: `lease-${k}-${i}-0`, user_id: "A", company: payload.company, url: payload.url, payload });
      }));
      const queued = new Map(jobs.map((j) => [j.id, { job: j, notBefore: 0, driving: false, requeues: 0 }]));
      const finished: string[] = [], engine = new Map<string, number>(), effects = new Map<string, number>();
      let early = 0, refusedSoFar = 0, seq = 0;
      const q: CloudQueue = {
        claim: async (limit) => {
          const t = Date.now(), out = [];
          for (const x of queued.values()) {
            if (out.length >= limit || x.driving) continue;
            if (x.notBefore > t) continue;
            x.driving = true;
            out.push({ ...x.job, lease_token: `lease-${x.job.id}-${++seq}` });
          }
          return out;
        },
        requeue: async (job, reason, _retry, until) => {
          const x = queued.get(job.id)!;
          if (!x.driving || !["rate_limited", "server_busy"].includes(reason)) throw Error("invalid apply transition");
          x.driving = false; x.notBefore = until; x.requeues++;
          return until;
        },
        resume: async () => ({ filename: "r.pdf", sha256: sha, b64: btoa(String.fromCharCode(...RESUME)) }),
        finish: async (j, state) => { finished.push(`${j.id}:${state}`); queued.delete(j.id); }, ask: async () => 0, gatePresent: async () => true, authorize: authorizer().authorize,
      };
      const { gate, calls } = scaledGate();
      await cloudLoop({ queue: q, tmpRoot: tmp, idleMs: 1, drain: true, stop: () => false, log: () => {}, gate, pacing: pacingFrom(() => undefined, { concurrency: r.int(1, 4) }),
        runEngine: effectAware(async (args: string[]) => {
          const url = args[args.indexOf("--url") + 1], id = jobs.find((j) => j.url === url)!.id;
          engine.set(id, (engine.get(id) ?? 0) + 1);
          const x = queued.get(id);
          if (x && Date.now() < x.notBefore) early++;
          if (url.includes(`r${k}-0.`) && refusedSoFar < refuse) {
            refusedSoFar++;
            return { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status: 429, retry_after_s: asked }, evidence: null };
          }
          effects.set(id, (effects.get(id) ?? 0) + 1);
          return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: { post: { status: 200, mutations: 1 } } };
        }) });
      const onHost = jobs.filter((j) => j.url.includes(`r${k}-0.`)).length, refusals = onHost ? refuse : 0;
      check(rep, finished.length === n && finished.every((f) => f.endsWith(":submitted_unconfirmed")) && queued.size === 0, "each job submitted once", () => `batch ${k}: ${JSON.stringify(finished)}, left ${queued.size}`);
      check(rep, [...engine.values()].reduce((a, b) => a + b, 0) === n + refusals && [...effects.values()].every((x) => x === 1) && effects.size === n, "a refused run asked for an effect, or a job ran a wrong number of times",
        () => `batch ${k}: engine ${JSON.stringify([...engine])}, effects ${JSON.stringify([...effects])}, refusals ${refusals}`);
      check(rep, early === 0, "a job run before its time", () => `batch ${k}: ${early}`);
      check(rep, calls.length === refusals && calls.every((c) => c.why === "rate_limited" && c.retryAfterS === asked), "the gate was not told each refusal with the seconds asked for",
        () => `batch ${k}: asked ${asked}, gate got ${JSON.stringify(calls.map((c) => c.retryAfterS))} for ${refusals} refusals`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
  done(rep);
});

// A worker killed around a requeue, started again on its journal: what may have been sent is unknown and never driven
// again; what was put back runs once more and is submitted once.
const REQUEUE_CRASHES = requeueCrashCases(rng(SEED + 10), 300);
Deno.test(`resume, crashes: ${REQUEUE_CRASHES.length} workers killed around a requeue and started again: a job is never driven again once its engine may have sent; a job put back runs once more`, async () => {
  const rep = report("resume crashes");
  for (const c of REQUEUE_CRASHES) {
    rep.total++;
    const urls = Array.from({ length: c.jobs }, (_, i) => `https://rc${c.id}-${i % 2}.example.test/job/${i}`);
    const db = fakeDb(urls, { requeue: true }), j = memJournal(), engine = new Map<string, number>();
    const target = `j${String(c.at).padStart(3, "0")}`, one = life(), two = life();
    const behave = async (args: string[], l: Life, who: number) => {
      if (l.dead) return await never<any>();
      const id = appId(args), n = (engine.get(id) ?? 0) + 1;
      engine.set(id, n);
      if (who === 1 && id === target && n === 2 && c.point === "during_second_engine") { l.die(); return await never<any>(); }
      await new Promise((r) => setTimeout(r, 0));
      if (l.dead) return await never<any>();
      // The target's host refuses its first attempt (Retry-After 0: back at once), then answers.
      if (id === target && n === 1) return { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status: 429, retry_after_s: 0 } as any, evidence: null };
      return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
    };
    const rpc1 = async (n: string, a: any) => {
      if (n === "career_apply_requeue_refused_own" && a.p_id === target && c.point === "after_refusal_before_requeue") { one.die(); return await never<any>(); }
      const r = await db.rpc(n, a, one);
      if (n === "career_apply_requeue_refused_own" && a.p_id === target && c.point === "after_requeue_before_clear") { one.die(); return await never<any>(); }
      return r;
    };
    const w1 = runLoop({ ...quiet, stop: () => false, drain: true, gate: scaledGate().gate, pacing: pacingFrom(() => undefined, { concurrency: c.slots }),
      queue: ownQueue({ rpc: rpc1 }), journal: j.view(one), runEngine: (args) => behave(args, one, 1) });
    await Promise.race([one.died, w1]);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const name = () => `case ${c.id}: ${c.jobs} jobs, slots ${c.slots}, killed ${c.point} of ${target}`;
    check(rep, one.dead, "the worker never reached its crash point", name);
    await runLoop({ ...quiet, stop: () => false, drain: true, gate: scaledGate().gate, pacing: pacingFrom(() => undefined, { concurrency: c.slots }),
      queue: ownQueue({ rpc: (n, a) => db.rpc(n, a, two) }), journal: j.view(two), runEngine: (args) => behave(args, two, 2) });
    db.sweep();
    for (const r of db.rows.values()) {
      const n = engine.get(r.id) ?? 0;
      check(rep, !["queued", "driving"].includes(r.state), "left unfinished", () => `${name()}: ${r.id} ${r.state}`);
      if (r.id !== target) check(rep, n <= 1 && (r.state !== "submitted_unconfirmed" || n === 1), "another job driven twice", () => `${name()}: ${r.id} engine x${n} ${r.state}`);
    }
    const t = db.rows.get(target)!, n = engine.get(target) ?? 0;
    if (c.point === "after_refusal_before_requeue") {
      // The refusal was never written: the journal says the engine started, so it is unknown and never driven again.
      check(rep, t.state === "unknown_outcome" && n === 1 && t.requeues === 0, "a run whose requeue was lost was driven again", () => `${name()}: ${t.state} engine x${n} requeued ${t.requeues}`);
    } else if (c.point === "after_requeue_before_clear") {
      // Put back before the worker died: the restart finds the row no longer its drive (nothing to record), and runs it once more.
      check(rep, t.state === "submitted_unconfirmed" && n === 2 && t.requeues === 1 && t.finishes === 1, "a requeued job did not run once more", () => `${name()}: ${t.state} engine x${n} requeued ${t.requeues} finishes ${t.finishes}`);
    } else {
      // Its second engine may have sent: unknown, never a third.
      check(rep, t.state === "unknown_outcome" && n === 2 && t.requeues === 1, "a job whose second engine may have sent was driven again", () => `${name()}: ${t.state} engine x${n}`);
    }
  }
  done(rep);
});

// The person is told, from the record, in plain words: a job waiting on a host is approved and waiting (never "not sent",
// never "duplicate"); approving the same posting again says it is already in their applications, never "you already
// applied" (it may never have been sent).
Deno.test("resume, what the person is told: a waiting job reads as approved and waiting; the same posting approved again is never called a duplicate or applied", () => {
  const reason = "waiting: the employer's site asked us to slow down (too many requests); nothing was sent, and it goes again by itself after 2026-10-29 16:02 UTC";
  const line = statusLine({ id: "j1", company: "Acme", state: "queued", reason, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() });
  eq(/^Acme: approved, not sent yet; waiting: the employer's site asked us to slow down .*nothing was sent, and it goes again by itself after 2026-10-29 16:02 UTC\.$/.test(line), true, line);
  eq(/duplicate|not sent \(/i.test(line), false, line);
  const card = answerText([{ n: 1, company: "Acme", result: "duplicate" } as any]);
  eq(/already in your applications \(sent, or approved and waiting to go\)/.test(card) && !/duplicate|already applied/i.test(card), true, card);
});

// ------------------------------------------------------------------------------------------------ claimed, never started
// Owner rule (binding, 2026-10-27): no limits of Trainee's own; back off only when an outside system refuses, then RESUME;
// each approved application submitted at most once. A claim the worker lets go before its engine started (stopped
// mid-batch, out of its lease budget, its host held, killed and restarted past the budget) goes back to the queue
// (career_apply_requeue_unstarted_own/_for, 20261029190000) and runs later, once; before, it was recorded not_submitted
// and lost. The fake queue's put-back refuses (and counts) any lease whose engine had started.
const UNSTARTED = unstartedCases(rng(SEED + 12), 240);
type UOut = { db: ReturnType<typeof fakeDb>; starts: Map<string, number>; refusals: Map<string, number>; unknownBy1: Set<string>; overlap: number; timedOut: boolean };
async function unstartedRun(c: UnstartedCase): Promise<UOut> {
  const db = fakeDb(c.jobs.map((j) => j.url), { requeue: true });
  const plan = new Map(c.hosts.map((h) => [h.host, h]));
  const starts = new Map<string, number>(), refusals = new Map<string, number>(), inFlight = new Set<string>(), unknownBy1 = new Set<string>();
  let overlap = 0, startsBy1 = 0, stop1 = false, giveUp = false;
  const one = life();
  const j = memJournal();
  const target = `j${String(c.at).padStart(3, "0")}`;
  const engine = async (args: string[], who: number) => {
    if (who === 1 && one.dead) return await never<any>();
    const id = appId(args), url = args[args.indexOf("--url") + 1], h = plan.get(hostOf(url))!;
    db.started(id);
    if (inFlight.has(id)) overlap++;
    inFlight.add(id);
    starts.set(id, (starts.get(id) ?? 0) + 1);
    if (who === 1) startsBy1++;
    if (c.mode === "stop" && who === 1 && startsBy1 >= c.after + 1) stop1 = true;
    // Killed during this engine (the target's, or the one after `after` starts when the target is not reached first).
    if (c.mode === "kill" && who === 1 && (id === target || startsBy1 > c.after + 1)) { one.die(); return await never<any>(); }
    await new Promise((r) => setTimeout(r, 1));
    inFlight.delete(id);
    if (who === 1 && one.dead) return await never<any>();
    // Refused for load at the page's open, a 503 with no Retry-After: the first time only, then it answers.
    if (h.behavior === "busy_503_none" && !refusals.has(id)) {
      refusals.set(id, 1);
      return { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status: 503, retry_after_s: null } as any, evidence: null };
    }
    switch (h.behavior) {
      case "captcha": return { result: { state: "needs_user", reason: "captcha" }, evidence: null };
      case "timeout": return null;
      default: return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
    }
  };
  const deadline = setTimeout(() => { giveUp = true; }, 20_000);
  // Spacing between starts on one host keeps claims waiting (pending), so a stop or a short budget finds some unstarted.
  const spaced = pacingFrom(() => undefined, { concurrency: c.slots, hostSpacingMs: 3 });
  const gate = scaledGate().gate;
  if (c.mode === "stop" || c.mode === "out_of_time") {
    // Out of time: a lease budget shorter than the spacing (pacingFrom keeps its 1 s floor; the scheduler takes it as given).
    const pacing = c.mode === "out_of_time" ? { ...spaced, startBudgetMs: 2 } : spaced;
    await runLoop({ ...quiet, queue: ownQueue({ rpc: (n, a) => db.rpc(n, a) }), stop: () => stop1 || giveUp, drain: true, gate, pacing, journal: j.view(life()),
      runEngine: (args) => engine(args, 1) });
  } else if (c.mode === "kill") {
    const w1 = runLoop({ ...quiet, queue: ownQueue({ rpc: (n, a) => db.rpc(n, a, one) }), stop: () => giveUp, drain: true, gate, pacing: spaced, journal: j.view(one),
      runEngine: (args) => engine(args, 1) });
    await Promise.race([one.died, w1]);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    // What the dead worker left driving: started (its journal says so) or never written to its journal (a lost line) is
    // unknown, never driven again (the restart's orphan record, or the database's sweep); a journal line not started is
    // put back by the restart and runs once.
    for (const row of db.rows.values()) {
      if (row.state !== "driving") continue;
      const e = j.entries.get(row.id);
      if (!e || e.started) unknownBy1.add(row.id);
    }
    // Started again on the same journal after the claims' budget: the unstarted ones cannot run under their old lease.
    await runLoop({ ...quiet, queue: ownQueue({ rpc: (n, a) => db.rpc(n, a) }), stop: () => giveUp, drain: true, gate, pacing: spaced,
      journal: j.view(life(), {}, 3_600_000), runEngine: (args) => engine(args, 2) });
  } else {
    // Held: the last host is held off by another instance's refusal for a while, longer than the lease budget: what this
    // worker claimed for it cannot start in time and goes back, to be taken again once the hold ends.
    const held = c.hosts[c.hosts.length - 1].host, holdUntil = Date.now() + 12;
    const hgate: HostGate = { shared: true, async until(hosts) { return new Map(hosts.map((h) => [h, h === held ? holdUntil : 0])); }, async refused(_h, _w, _s, at) { return at + 2; }, async ok() {} };
    await runLoop({ ...quiet, queue: ownQueue({ rpc: (n, a) => db.rpc(n, a) }), stop: () => giveUp || Date.now() > holdUntil + 200, drain: true, gate: hgate,
      pacing: { ...spaced, startBudgetMs: 4 }, journal: j.view(life()), runEngine: (args) => engine(args, 1) });
  }
  // Whatever the first worker put back, fresh workers drain (put back means it runs later; one waiting on its host's hold
  // is taken by the next worker that asks after the hold).
  do {
    await runLoop({ ...quiet, queue: ownQueue({ rpc: (n, a) => db.rpc(n, a) }), stop: () => giveUp, drain: true, gate: scaledGate().gate, pacing: spaced, runEngine: (args) => engine(args, 2) });
    await new Promise((r) => setTimeout(r, 2));
  } while (!giveUp && [...db.rows.values()].some((x) => x.state === "queued"));
  clearTimeout(deadline);
  db.sweep();
  return { db, starts, refusals, unknownBy1, overlap, timedOut: giveUp };
}
Deno.test(`unstarted: ${UNSTARTED.length} batches whose worker lets claims go before they start (stopped mid-batch, out of its lease budget, its host held, killed and restarted past the budget) beside hosts that answer, check, time out or answer a 503 with no Retry-After: every approved job ends exactly once; an unstarted one is put back and submitted once later; none put back after its engine started`, async () => {
  const rep = report("unstarted");
  const putBacks: Record<string, number> = {};
  for (const c of UNSTARTED) {
    rep.total++;
    const r = await unstartedRun(c);
    const plan = new Map(c.hosts.map((h) => [h.host, h]));
    const name = () => `case ${c.id} ${c.mode} slots ${c.slots} after ${c.after}: ${c.hosts.map((h) => `${h.host}=${h.behavior}`).join(", ")}; ${c.jobs.length} jobs`;
    check(rep, !r.timedOut, "the workers did not drain the queue in time", name);
    check(rep, r.overlap === 0, "a job driven twice at once", () => `${name()}: ${r.overlap}`);
    for (const row of r.db.rows.values()) {
      const h = plan.get(hostOf(row.url))!, n = r.starts.get(row.id) ?? 0, refused = r.refusals.get(row.id) ?? 0;
      putBacks[c.mode] = (putBacks[c.mode] ?? 0) + (row.putbacks ?? 0);
      check(rep, row.badPutBacks === 0, "a claim put back after its engine started", () => `${name()}: ${row.id} x${row.badPutBacks}`);
      // (A claim the dead worker never wrote to its journal is closed by the database's sweep: unknown, with no finish.)
      check(rep, (row.finishes === 1 || (r.unknownBy1.has(row.id) && row.finishes === 0)) && !["queued", "driving"].includes(row.state), "a job not recorded exactly once", () => `${name()}: ${row.id} ${row.state} x${row.finishes}`);
      check(rep, row.early === 0, "a job claimed before its not-before time", () => `${name()}: ${row.id} early x${row.early}`);
      // Engines: one per refusal before anything was sent, and one more; a job whose engine started otherwise, once.
      check(rep, n <= refused + 1, "a job driven again after its engine started", () => `${name()}: ${row.id} engine x${n}, refused ${refused}`);
      if (r.unknownBy1.has(row.id)) {
        check(rep, row.state === "unknown_outcome" && n <= 1, "a job running when its worker died is not unknown, or was driven again", () => `${name()}: ${row.id} ${row.state} engine x${n}`);
        continue;
      }
      const want = ({ ok: "submitted_unconfirmed", busy_503_none: "submitted_unconfirmed", captcha: "needs_user", timeout: "unknown_outcome" } as Record<string, string>)[h.behavior];
      check(rep, row.state === want, `${h.behavior}: ${want} (an approved job is never lost unsent)`, () => `${name()}: ${row.id} ${row.state} (${row.reason}) engine x${n} put back ${row.putbacks}`);
      check(rep, n === refused + 1, `${h.behavior}: driven once (and once more after a refusal before anything was sent)`, () => `${name()}: ${row.id} engine x${n}, refused ${refused}`);
    }
  }
  console.log(`[apply] unstarted: put back by mode ${JSON.stringify(putBacks)}`);
  // Every way of letting a claim go was met (and put back) somewhere in the battery.
  for (const m of ["stop", "out_of_time", "held", "kill"]) check(rep, (putBacks[m] ?? 0) > 0, `no claim was let go (${m})`, () => JSON.stringify(putBacks));
  done(rep);
});

// The cloud worker (cloudLoop, career_apply_requeue_unstarted_for): stopped mid-batch, the claims it had not started go
// back and a fresh worker sends each once; one that cannot be put back (its card approval expired: the database refuses)
// is recorded not sent, never left driving.
Deno.test("unstarted, the cloud worker: 120 batches stopped mid-batch: the claims not started go back and are submitted once by the next worker; a refused put-back is recorded not sent", async () => {
  const rep = report("unstarted (cloud)");
  const r = rng(SEED + 13);
  const RESUME = new TextEncoder().encode("%PDF-1.4 TEST apply scenarios");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", RESUME))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const tmp = await Deno.makeTempDir({ prefix: "trainee-apply-unstarted-" });
  let backs = 0;
  try {
    for (let k = 0; k < 120; k++) {
      rep.total++;
      const n = r.int(3, 9), after = r.int(1, 2), refuseOne = k % 4 === 3;
      const jobs = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const payload: any = { version: 1, user_id: "A", job_id: `lever:u${k}:${i}`, company: `TEST Co ${i}`, url: `https://u${k}-${i % 2}.lever.test/t/${i}`, fields: [{ name: "first_name", label: "First name", value: "TEST A", factId: `TEST-A-${i}` }],
          destination: `https://u${k}-${i % 2}.lever.test/t/${i}/apply`, resume_sha256: sha, privacy_epoch: 1, account_version: 1, expires_at: "2099-01-01T00:00:00Z" };
        payload.engine_approval = await hashApplyPayload(factsFromPayload(payload).saved);
        return await cardBound({ id: `job-${k}-${i}`, lease_token: `lease-${k}-${i}-0`, user_id: "A", company: payload.company, url: payload.url, payload });
      }));
      const rows = new Map(jobs.map((j) => [j.id, { job: j, driving: false, lease: "", started: false, putbacks: 0, finished: [] as string[], bad: 0 }]));
      const engine = new Map<string, number>();
      let seq = 0, refusedPut = 0;
      const queue = (): CloudQueue => ({
        claim: async (limit) => {
          const out = [];
          for (const x of rows.values()) {
            if (out.length >= limit || x.driving || x.finished.length) continue;
            x.driving = true; x.started = false; x.lease = `lease-${x.job.id}-${++seq}`;
            out.push({ ...x.job, lease_token: x.lease });
          }
          return out;
        },
        putBack: async (job, why) => {
          const x = rows.get(job.id)!;
          if (!x.driving || x.lease !== job.lease_token) throw Object.assign(Error("invalid apply claim"), { body: "invalid apply claim" });
          if (x.started) { x.bad++; throw Object.assign(Error("invalid apply transition"), { body: "invalid apply transition" }); }
          if (!/^(WORKER_STOPPING|NOT_STARTED_IN_LEASE|HOST_HELD|JOURNAL_UNWRITABLE)/.test(why)) throw Error("invalid unstarted reason");
          // Every fourth batch: its first put-back is refused (a card approval that expired since): recorded not sent.
          if (refuseOne && refusedPut === 0) { refusedPut++; return null; }
          x.driving = false; x.putbacks++; backs++;
          return Date.now();
        },
        resume: async () => ({ filename: "r.pdf", sha256: sha, b64: btoa(String.fromCharCode(...RESUME)) }),
        finish: async (j, state) => { const x = rows.get(j.id)!; if (x.lease !== j.lease_token || !x.driving) throw Error("invalid apply transition"); x.finished.push(state); x.driving = false; },
        ask: async () => 0, gatePresent: async () => true, authorize: authorizer().authorize,
      });
      let startsBy1 = 0, stop = false;
      const run = (who: number) => effectAware(async (args: string[]) => {
        const url = args[args.indexOf("--url") + 1], id = jobs.find((j) => j.url === url)!.id;
        rows.get(id)!.started = true;
        engine.set(id, (engine.get(id) ?? 0) + 1);
        if (who === 1 && ++startsBy1 >= after) stop = true;
        await new Promise((res) => setTimeout(res, 1));
        return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: { post: { status: 200, mutations: 1 } } };
      });
      const pacing = pacingFrom(() => undefined, { concurrency: r.int(1, 3), hostSpacingMs: 3 });
      await cloudLoop({ queue: queue(), tmpRoot: tmp, idleMs: 1, drain: true, stop: () => stop, log: () => {}, gate: localHostGate(), pacing, runEngine: run(1) });
      await cloudLoop({ queue: queue(), tmpRoot: tmp, idleMs: 1, drain: true, stop: () => false, log: () => {}, gate: localHostGate(), pacing, runEngine: run(2) });
      const total = [...rows.values()];
      check(rep, total.every((x) => x.bad === 0), "a claim put back after its engine started", () => `batch ${k}`);
      check(rep, total.every((x) => x.finished.length === 1 && !x.driving), "a job not recorded exactly once", () => `batch ${k}: ${JSON.stringify(total.map((x) => [x.job.id, x.finished, x.driving]))}`);
      const sent = total.filter((x) => x.finished[0] === "submitted_unconfirmed"), unsent = total.filter((x) => x.finished[0] === "not_submitted");
      check(rep, sent.every((x) => engine.get(x.job.id) === 1) && unsent.every((x) => !engine.has(x.job.id)), "a job driven a wrong number of times", () => `batch ${k}: ${JSON.stringify([...engine])}`);
      check(rep, sent.length + unsent.length === n && unsent.length === (refuseOne && refusedPut ? 1 : 0), "an unstarted job lost unsent (only a refused put-back is recorded not sent)", () => `batch ${k}: ${unsent.length} not sent, refused put-backs ${refusedPut}`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
  check(rep, backs > 0, "no claim was put back", () => String(backs));
  done(rep);
});
