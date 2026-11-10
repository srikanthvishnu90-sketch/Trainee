#!/usr/bin/env node
"use strict";
// Release item 2: a batch of 60 through the runner's pool the way the apply VM drives it (workers/career-browser/apply-vm.cjs
// createWorker: claim -> prepare (payload hash, approval id, resume hash) -> applyOne with apply-vm's own options -> settle ->
// complete). Two uses:
//   - this CLI: 60 REAL postings from sample.csv, a DRY RUN. The queue is an in-memory stand-in for the career_apply_vm_* SQL
//     functions (the same transitions: a lease per claim, 'submitted_unconfirmed' only after the 'submitting' phase, a
//     'not_submitted' after 'submitting' recorded as unknown_outcome). The engine gets apply-vm's options unchanged plus the
//     strict guards (strict.cjs): every request but GET/HEAD/OPTIONS (and a GraphQL read) aborted, a page script cancelling
//     every form submit, robots.txt obeyed, page loads paced 1 a second per host, and the run stopped at the instant before the
//     Submit click (before apply-vm records 'submitting'), so nothing is ever sent.
//   - tests/career-batch60-fixture.test.cjs: 60 mock postings on tests/fixtures/mock-ats-server.cjs with the REAL queue (a
//     throwaway Postgres with every migration), submitted for real to the loopback mock, then the receipts and the one closeout.
// Counted per posting: exactly one outcome. Over the batch (each must be 0):
//   duplicates - a posting with more than one finish, one that reached Submit more than once, or two rows for one posting;
//   dropped    - a posting with no finish;
//   mismatches - a field, at the instant before Submit, whose approved value is not the approved payload's, or that holds
//                anything other than that value (pool.cjs fieldMismatch over ats-fill heldNow).
//   node scripts/browser-eval/batch60.cjs --sample scripts/browser-eval/sample.csv --n 60 --concurrency 6 --label batch60
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createWorker, queueHash, atsOf } = require("../../workers/career-browser/apply-vm.cjs");
const { applyOne, NeedsUser } = require("../../workers/career-browser/parallel-apply.cjs");
const { fieldMismatch, pickBatch } = require("./pool.cjs");

const STOP = "dry_run_stopped_before_submit";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// The engine apply-vm calls (its `applyOne` option), with apply-vm's own options passed through unchanged. Added: the dry
// run's guards (requestGate, initScript), and the audit of what each filled field holds at the instant before the click.
// dryRun: the run stops there, before apply-vm's own onPhase("submitting"), so the queue never records a click.
function auditedEngine({ guards = {}, dryRun, audits }) {
  return (browser, pool, opts) => applyOne(browser, pool, {
    ...opts, ...guards, audit: true,
    onPhase: async (phase, audit) => {
      if (phase === "submitting") {
        audits.push({ id: pool.id, pool, fields: audit ? audit.fields : null });
        if (dryRun) throw new NeedsUser(STOP);
      }
      return opts.onPhase(phase);
    },
  });
}

// In-memory stand-in for the career_apply_vm_* functions (supabase/migrations/20261028180000_career_apply_vm_worker.sql), for
// the CLI only: the real-site run has no database. rows: [{ id, user_id, url, payload, approval_id, resume: {b64, sha256, filename} }].
function memoryQueue(rows) {
  const jobs = rows.map((r) => ({ ...r, state: "queued", lease_token: null, vm_worker: null, vm_phase: null, attempts: 0, payload_hash: queueHash(r.payload), approval_hash: queueHash(r.payload) }));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const finishes = [], calls = {};
  const held = (j, a) => j && j.state === "driving" && j.lease_token === a.p_lease && j.vm_worker === (a.p_worker ?? j.vm_worker);
  const rpc = async (name, a = {}) => {
    calls[name] = (calls[name] || 0) + 1;
    switch (name) {
      case "career_apply_vm_claim": {
        const skip = new Set(a.p_skip_hosts || []), out = [], per = new Map();
        for (const j of jobs) if (j.state === "driving") per.set(j.user_id, (per.get(j.user_id) || 0) + 1);
        for (const j of jobs) {
          if (out.length >= a.p_limit) break;
          if (j.state !== "queued" || (per.get(j.user_id) || 0) >= a.p_per_user) continue;
          if (skip.has(new URL(j.url).host.toLowerCase().replace(/^www\./, ""))) continue;
          Object.assign(j, { state: "driving", lease_token: crypto.randomUUID(), vm_worker: a.p_worker, vm_phase: null, attempts: j.attempts + 1 });
          per.set(j.user_id, (per.get(j.user_id) || 0) + 1);
          out.push({ id: j.id, user_id: j.user_id, url: j.url, payload: j.payload, payload_hash: j.payload_hash, approval_hash: j.approval_hash, approval_id: j.approval_id, lease_token: j.lease_token });
        }
        return out;
      }
      case "career_apply_vm_heartbeat": {
        const j = byId.get(a.p_id);
        if (!held(j, a)) return { ok: false, why: "lease_lost" };
        if (a.p_phase) j.vm_phase = a.p_phase;
        return { ok: true };
      }
      case "career_apply_vm_resume": { const j = byId.get(a.p_id); return held(j, a) ? j.resume : null; }
      case "career_apply_vm_complete": {
        const j = byId.get(a.p_id);
        finishes.push({ id: a.p_id, state: a.p_state, reason: a.p_reason });
        if (!held(j, a)) throw new Error("invalid apply claim");
        let st = a.p_state, rs = a.p_reason || null;
        if (st === "submitted_unconfirmed" && j.vm_phase !== "submitting") throw new Error("invalid apply transition");
        if ((st === "not_submitted" || st === "failed") && j.vm_phase === "submitting") { st = "unknown_outcome"; rs = "application outcome unknown: it failed after Submit was pressed; not retried"; }
        Object.assign(j, { state: st, reason: rs, evidence: a.p_evidence || {}, confirmation_id: st === "submitted_unconfirmed" ? (a.p_evidence || {}).confirmation_id || null : null });
        return { id: j.id, state: j.state, reason: j.reason };
      }
      default: return null; // reap, host_ok_for, host_refused_for: nothing to hold in a one-batch run
    }
  };
  return { rpc, jobs, finishes, calls, open: () => jobs.filter((j) => j.state === "queued" || j.state === "driving").length };
}

// Run one worker until nothing is queued or driving (or the deadline), then stop it the way apply-vm stops (it waits for every
// application in flight).
async function drain(worker, open, deadlineMs) {
  const run = worker.run();
  const t0 = Date.now();
  while ((await open()) > 0 && Date.now() - t0 < deadlineMs) await new Promise((r) => setTimeout(r, 200));
  worker.stop();
  await run;
}

// The batch's numbers. batch: [{ id, url }]; finishes: every complete call [{ id, state, reason }]; final: Map id -> the row's
// final {state, reason} (the database's, after its own transition rules); audits: auditedEngine's list; posts: Map job -> count
// of submit requests the employer received (fixture only).
function tally({ batch, finishes, final, audits, posts }) {
  const fin = new Map(), reached = new Map(), urls = new Map();
  for (const f of finishes) fin.set(f.id, (fin.get(f.id) || 0) + 1);
  for (const a of audits) reached.set(a.id, (reached.get(a.id) || 0) + 1);
  for (const b of batch) urls.set(b.url, (urls.get(b.url) || 0) + 1);
  let duplicates = [...urls.values()].filter((n) => n > 1).length, dropped = 0, mismatches = 0;
  if (posts) duplicates += [...posts.values()].filter((n) => n > 1).length;
  const rows = batch.map((b) => {
    const f = final.get(b.id), nFin = fin.get(b.id) || 0, nReach = reached.get(b.id) || 0;
    if (nFin > 1 || nReach > 1) duplicates++;
    if (!f || !nFin || f.state === "queued" || f.state === "driving") { dropped++; return { ...b, outcome: "DROPPED", finishes: nFin }; }
    const row = { ...b, outcome: `${f.state}${f.reason ? ":" + f.reason : ""}`, finishes: nFin, reached_submit: nReach };
    if (nReach) {
      const a = audits.filter((x) => x.id === b.id).pop();
      const fields = a.fields || [];
      row.fields = fields.length;
      row.mismatches = fields.map((x) => ({ label: x.label, why: fieldMismatch(x, a.pool) })).filter((x) => x.why);
      if (!fields.length) row.mismatches.push({ label: "(none)", why: "no_fields_audited" });
      mismatches += row.mismatches.length;
    }
    return row;
  });
  const by_outcome = rows.reduce((m, x) => ((m[x.outcome] = (m[x.outcome] || 0) + 1), m), {});
  const one_outcome_each = rows.filter((x) => x.finishes === 1).length;
  return { rows, summary: { batch: batch.length, one_outcome_each, reached_submit: rows.filter((x) => x.reached_submit).length, duplicates, dropped, mismatches, by_outcome } };
}

// The TEST person's approved answers, as the queue payload carries them (fields by the form's label). Synthetic only.
const TEST_FIELDS = [
  ["First Name", "Testy"], ["Last Name", "Example"], ["Full name", "Testy Example"], ["Name", "Testy Example"],
  ["Email", "dry-run@example.invalid"], ["Phone", "+1 555 0100"], ["Location", "Chicago, IL"], ["Country", "United States"],
].map(([label, value], i) => ({ label, value, factId: `test-${i + 1}` }));

async function main() {
  const lib = require("./eval-lib.cjs");
  const { graphqlRead, robotsOk, PROVIDER_HOSTS } = require("./strict.cjs");
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const label = String(arg("label", "batch60")).replace(/[^A-Za-z0-9._-]/g, "-");
  const out = path.resolve(arg("out", path.join("artifacts", "browser-eval", label)));
  fs.mkdirSync(out, { recursive: true });
  const batch = pickBatch(lib.readSample(fs.readFileSync(arg("sample"), "utf8"), { max: 20 }), Number(arg("n", 60)))
    .map((x, i) => ({ id: crypto.randomUUID(), n: i + 1, provider: x.provider, url: x.url }));
  let pw; for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  if (!pw) { console.error("playwright not found (set UPMORE_PLAYWRIGHT_PATH)"); process.exit(2); }
  const ua = `Mozilla/5.0 ${lib.UA_TOKEN}`, robots = new Map(), pacer = lib.createPacer();
  const resumeBytes = fs.readFileSync(lib.syntheticResume(path.join(out, "fixtures"))), resumeSha = sha256(resumeBytes);
  const userId = "00000000-0000-4000-8000-00000000b060";

  // robots.txt first: a refused posting is not queued, and its outcome says so (still exactly one outcome).
  const pre = new Map(), rows = [], hosts = new Set();
  for (const b of batch) {
    const rb = await robotsOk(b.url, robots, ua);
    if (rb !== true) { pre.set(b.id, rb === "unreachable" ? "host_unreachable" : "robots_disallowed"); continue; }
    hosts.add(new URL(b.url).hostname.toLowerCase());
    for (const h of PROVIDER_HOSTS[b.provider] || []) hosts.add(h);
    const payload = { version: 1, user_id: userId, job_id: `batch60-${b.n}`, company: `${b.provider} posting ${b.n}`, url: b.url, fields: TEST_FIELDS, resume_sha256: resumeSha, destination: b.url };
    rows.push({ id: b.id, user_id: userId, url: b.url, payload, approval_id: crypto.randomUUID(), resume: { b64: resumeBytes.toString("base64"), sha256: resumeSha, filename: "resume.pdf" } });
  }
  const counts = { sends_blocked: 0, graphql_reads: 0 };
  const requestGate = async (req) => {
    let u; try { u = new URL(req.url()); } catch { return false; }
    if (/^(data|blob|about):$/.test(u.protocol)) return true;
    if (!/^(GET|HEAD|OPTIONS)$/.test(req.method())) { if (graphqlRead(req)) counts.graphql_reads++; else { counts.sends_blocked++; return false; } }
    if (["image", "media", "font"].includes(req.resourceType())) return false;
    if (req.isNavigationRequest()) await pacer.wait(u.host);
    return true;
  };
  const q = memoryQueue(rows), audits = [];
  const browser = await pw.chromium.launch({ headless: true });
  const t0 = Date.now();
  // One person, so per-person is the pool's width (a mass apply's one batch); apply-vm's defaults otherwise, retries 0 (a dry run).
  const concurrency = Number(arg("concurrency", 6));
  const worker = createWorker({ rpc: q.rpc, browser, workerId: "batch60-dry-run", concurrency, perUser: concurrency, allowHosts: [...hosts], retries: 0,
    stepTimeoutMs: 20000, pollMs: 100, evidenceDir: null, applyOne: auditedEngine({ guards: { requestGate, initScript: lib.SUBMIT_TRAP }, dryRun: true, audits }), log: (l) => console.log(l) });
  await drain(worker, async () => q.open(), Number(arg("deadline-min", 70)) * 60000);
  await browser.close();

  const final = new Map(q.jobs.map((j) => [j.id, { state: j.state, reason: j.reason }]));
  const finishes = [...q.finishes];
  for (const [id, why] of pre) { final.set(id, { state: "not_submitted", reason: why }); finishes.push({ id, state: "not_submitted", reason: why }); }
  const { rows: out_rows, summary } = tally({ batch, finishes, final, audits });
  const breaches = q.jobs.filter((j) => j.vm_phase === "submitting" || j.state === "submitted_unconfirmed" || j.state === "unknown_outcome").length;
  Object.assign(summary, { breaches, ...counts, site_not_supported_by_vm: batch.filter((b) => atsOf(b.url).refuse).length, wall_s: Math.round((Date.now() - t0) / 1000), concurrency });
  for (const x of out_rows) console.log(["BATCH60", String(x.n).padStart(2, "0"), x.provider, x.outcome, x.fields !== undefined ? `fields=${x.fields}` : "", x.mismatches ? `mismatch=${x.mismatches.length}${x.mismatches.length ? " " + JSON.stringify(x.mismatches.slice(0, 3)) : ""}` : "", x.url].join(" | "));
  console.log("BATCH60-SUMMARY " + JSON.stringify(summary));
  fs.writeFileSync(path.join(out, "batch60.jsonl"), out_rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(out, "batch60-summary.json"), JSON.stringify(summary, null, 2));
  if (breaches || summary.duplicates || summary.dropped || summary.mismatches || summary.one_outcome_each !== batch.length) process.exit(3);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { auditedEngine, memoryQueue, drain, tally, TEST_FIELDS, STOP, main };
