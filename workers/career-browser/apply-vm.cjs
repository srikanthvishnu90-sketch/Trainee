"use strict";
// The apply VM worker: claims approved applications from the queue (career_apply_vm_claim, round-robin across people,
// FOR UPDATE SKIP LOCKED), drives them in a bounded pool of headless Chromium contexts (parallel-apply.cjs) and writes the
// honest outcome back. No model calls. Stateless: any number of these, on any number of VMs, run against one database.
//
// What it enforces in code (CLAUDE.md, D-007, D-MS-2):
//  - the application is exactly the approved one: the queue's payload must hash (canonical JSON, sha256) to the hash the
//    person approved, and the resume the database returns must hash to the resume that hash binds; otherwise nothing is opened.
//  - LinkedIn / Indeed / Handshake are refused here as well as in the database; real employer hosts are driven only if the
//    VM's own allow-list (APPLY_VM_ALLOW_HOSTS) names them; loopback (mock forms) always passes for the dry run.
//  - isolation: every attempt is a fresh browser context (no cookies or storage shared between people or attempts); the
//    resume of one application is written to a private folder of its own and removed after.
//  - a verification check (captcha) or a sign-in wall stops the item as 'needs you' with its link. Never solved, never signed in.
//  - retries only BEFORE Submit (in-process, and the database re-queues a worker that died before it); "submitting" is
//    recorded in the database before the click, and nothing after it is ever re-sent.
//  - no volume cap of ours (D-MS-2). Concurrency is the machine's capacity; a portal that refuses (429 / 503 / bot check)
//    is held off for every worker through the database (career_apply_host_refused_for), and only then.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { applyOne, payloadHash, NeedsUser } = require("./parallel-apply.cjs");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
// The same canonical JSON as supabase/functions/_shared/career_apply_store.ts and career_apply_canonical in SQL.
function canonical(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  throw new Error("INVALID_APPLY_PAYLOAD");
}
const queueHash = (payload) => sha256(Buffer.from(canonical(payload), "utf8"));

const REFUSED = /(^|\.)(linkedin\.com|lnkd\.in|indeed\.com|joinhandshake\.com|handshake\.com)$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function atsOf(url) {
  let u;
  try { u = new URL(url); } catch { return { refuse: "invalid_url" }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (REFUSED.test(host)) return { refuse: "site_not_supported" };
  if (LOOPBACK.has(host)) { const m = /^\/(greenhouse|lever)\//.exec(u.pathname); return m ? { ats: m[1], host: u.host, local: true } : { refuse: "site_not_supported" }; }
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") return { ats: "greenhouse", host: u.host };
  if (host === "jobs.lever.co") return { ats: "lever", host: u.host };
  return { refuse: "site_not_supported" };
}

// PostgREST over fetch with the worker's key (a JWT for the apply_vm_worker role, or the service key at first).
function restRpc({ url, key, fetchImpl = fetch }) {
  return async (name, args = {}) => {
    const r = await fetchImpl(`${url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(args),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${name}: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

function machineSlots() {
  // One headless Chromium context with one employer page is about 450 MB on the test pages (docs/launch/APPLY-VM-RUNBOOK.md).
  return Math.max(1, Math.floor(os.freemem() / (450 * 1024 * 1024)));
}

function createWorker(o) {
  const rpc = o.rpc, log = o.log || ((l) => console.log(l)), browser = o.browser;
  const cfg = {
    workerId: o.workerId || `${os.hostname()}-${process.pid}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 64),
    concurrency: Math.max(1, o.concurrency || machineSlots()),
    perUser: Math.max(1, o.perUser || 1),
    hostMax: o.hostMax > 0 ? o.hostMax : Infinity, // engines at once on one portal on this VM (no number of ours by default)
    hostSpacingMs: o.hostSpacingMs || 0, // least time between two starts on one portal on this VM (0: none of ours)
    allowHosts: o.allowHosts || [],
    pollMs: o.pollMs ?? 1000, heartbeatMs: o.heartbeatMs ?? 20000, sweepMs: o.sweepMs ?? 30000, staleSeconds: o.staleSeconds ?? 120,
    retries: o.retries ?? 2, stepTimeoutMs: o.stepTimeoutMs ?? 15000,
    evidenceDir: o.evidenceDir === null ? null : (o.evidenceDir || path.join(os.tmpdir(), "apply-vm-evidence")), tmpDir: o.tmpDir || os.tmpdir(),
  };
  const apply = o.applyOne || applyOne;
  const inflight = new Map(); // job id -> { row, host, lost }
  const hostCount = new Map(), hostLast = new Map();
  const stats = { claimed: 0, done: {}, ms: [], refusedHosts: 0, completeErrors: 0 };
  let stopping = false;

  const rec = (state, reason) => { const k = `${state}${reason ? ":" + reason : ""}`; stats.done[k] = (stats.done[k] || 0) + 1; };

  async function complete(row, state, reason, evidence) {
    let last;
    for (let i = 0; i < 4; i++) {
      try { await rpc("career_apply_vm_complete", { p_id: row.id, p_lease: row.lease_token, p_worker: cfg.workerId, p_state: state, p_reason: reason || null, p_evidence: evidence || {} }); rec(state, reason); return true; }
      catch (e) { last = e; if (/invalid apply claim/.test(e.message)) break; await sleep(200 * (i + 1)); }
    }
    stats.completeErrors++; log(`COMPLETE_FAILED ${row.id} ${String(last && last.message).slice(0, 120)}`); return false;
  }

  // Everything checked before a browser is opened. Returns the pool payload, or { refuse: code }.
  async function prepare(row, dir) {
    const p = row.payload;
    if (!p || typeof p !== "object" || p.url !== row.url || p.user_id !== row.user_id) return { refuse: "APPROVED_APPLICATION_CHANGED" };
    let h;
    try { h = queueHash(p); } catch { return { refuse: "APPROVED_APPLICATION_CHANGED" }; }
    if (h !== row.payload_hash || h !== row.approval_hash) return { refuse: "APPROVED_APPLICATION_CHANGED" };
    const site = atsOf(row.url);
    if (site.refuse) return { refuse: site.refuse };
    if (!site.local && !cfg.allowHosts.includes(new URL(row.url).hostname.toLowerCase())) return { refuse: "host_not_allowed" };
    if (!/^[a-f0-9]{64}$/.test(String(p.resume_sha256 || ""))) return { refuse: "NO_RESUME" };
    const r = await rpc("career_apply_vm_resume", { p_id: row.id, p_lease: row.lease_token, p_worker: cfg.workerId });
    if (!r) return { refuse: "RESUME_NOT_IN_CLOUD" };
    const bytes = Buffer.from(r.b64, "base64");
    if (sha256(bytes) !== p.resume_sha256 || r.sha256 !== p.resume_sha256) return { refuse: "RESUME_CHANGED" };
    const name = /^[^/\\.][^/\\]{0,199}$/.test(r.filename) ? r.filename : "resume.pdf";
    fs.mkdirSync(path.join(dir, "resume"), { recursive: true, mode: 0o700 });
    const resumePath = path.join(dir, "resume", name);
    fs.writeFileSync(resumePath, bytes, { mode: 0o600 });
    const answers = {};
    for (const f of Array.isArray(p.fields) ? p.fields : []) {
      if (!f || typeof f.label !== "string" || f.value === null || f.value === undefined || typeof f.value === "object") continue;
      answers[f.label.replace(/\s*\*\s*$/, "").trim()] = String(f.value);
    }
    const pool = { id: row.id, ats: site.ats, url: row.url, facts: {}, answers, resume: { path: resumePath, sha256: p.resume_sha256, preparedWithSha256: p.resume_sha256 } };
    // parallel-apply needs {approval_id, hash} and cannot know whether approval_id is real. The claim (career_apply_vm_claim) only
    // hands out a row whose stored approval record is bound to this person and this payload hash, not revoked, not expired, and
    // returns that record's id (never a token read out of the payload); the last heartbeat before the click checks it again.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(row.approval_id || ""))) return { refuse: "NOT_APPROVED" };
    pool.approval = { approval_id: row.approval_id, hash: payloadHash(pool) };
    return { pool, host: site.host };
  }

  async function process(row) {
    const t0 = Date.now();
    const st = inflight.get(row.id);
    const dir = fs.mkdtempSync(path.join(cfg.tmpDir, "apply-vm-"));
    fs.chmodSync(dir, 0o700);
    const shotDir = cfg.evidenceDir ? path.join(cfg.evidenceDir, row.id) : undefined; // null: no screenshots kept (the scheduling load test)
    if (shotDir) fs.mkdirSync(shotDir, { recursive: true, mode: 0o700 });
    try {
      const prep = await prepare(row, dir);
      if (prep.refuse) { await complete(row, "not_submitted", prep.refuse, { nothing_sent: true, link: row.url }); return; }
      const onPhase = async (phase) => {
        if (st.lost) throw new NeedsUser("lease_lost");
        const r = await rpc("career_apply_vm_heartbeat", { p_id: row.id, p_lease: row.lease_token, p_worker: cfg.workerId, p_phase: phase });
        if (!r || r.ok !== true) throw new NeedsUser(r && r.why ? r.why : "lease_lost");
      };
      const res = await apply(browser, prep.pool, { allowHosts: cfg.allowHosts, retries: cfg.retries, stepTimeoutMs: cfg.stepTimeoutMs, shotDir, onPhase, backoffMs: 300 });
      await settle(row, res, shotDir, t0);
    } catch (e) {
      log(`JOB_ERROR ${row.id} ${String(e.message).split("\n")[0].slice(0, 120)}`);
      await complete(row, "not_submitted", "WORKER_ERROR", { nothing_sent: true, error: String(e.message).split("\n")[0].slice(0, 200) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const fileProof = (p) => { try { const b = fs.readFileSync(p); return { sha256: sha256(b), bytes: b }; } catch { return null; } };
  async function refused(row, why, retryAfter) {
    stats.refusedHosts++;
    try { await rpc("career_apply_host_refused_for", { p_id: row.id, p_lease: row.lease_token, p_reason: why, p_retry_after_seconds: retryAfter ?? null, p_now: new Date().toISOString() }); } catch (e) { log(`HOST_BACKOFF_FAILED ${e.message.slice(0, 100)}`); }
  }
  async function settle(row, res, shotDir, t0) {
    const before = shotDir && fileProof(path.join(shotDir, `${row.id}-1-filled.png`)), after = shotDir && fileProof(path.join(shotDir, `${row.id}-2-confirmation.png`));
    const ev = {
      attempts: res.attempts, timing: res.timing || null, ms: res.ms, link: row.url,
      answers_sent: (res.filled || []).map((f) => ({ field: f.field, source: f.source })), // labels only, never values
      proof: { before_sha256: before && before.sha256, after_sha256: after && after.sha256, screenshots_on: cfg.workerId },
    };
    if (res.status === "submitted_page_confirmed") {
      ev.confirmation_id = res.confirmation || null;
      if (after && after.bytes.length <= 36000) ev.proof.after_png_b64 = after.bytes.toString("base64");
      try { await rpc("career_apply_host_ok_for", { p_id: row.id, p_lease: row.lease_token, p_now: new Date().toISOString() }); } catch { /* the outcome matters more */ }
      return void (await complete(row, "submitted_unconfirmed", null, ev));
    }
    if (res.status === "needs_user") {
      if (res.reason === "bot_check") await refused(row, "bot_wall", null);
      return void (await complete(row, "needs_user", res.reason, { ...ev, handed_back: res.reason === "bot_check" ? "a verification check appeared; the person finishes it at the link" : "the employer asks the person to sign in; they finish it at the link" }));
    }
    if (res.status === "unknown_outcome") return void (await complete(row, "unknown_outcome", "application outcome unknown: " + String(res.reason || "").slice(0, 80), ev));
    // not_submitted
    // A required question the person has not answered (or one that could not be set and read back): handed back by name, never guessed.
    if (res.reason === "missing_required_answer" || res.reason === "field_not_filled") {
      const q = String(res.field || "").replace(/\s+/g, " ").slice(0, 80);
      return void (await complete(row, "needs_user", `${res.reason}${q ? ": " + q : ""}`, { ...ev, nothing_sent: true, field: res.field, needs: res.needs || null, handed_back: res.reason === "missing_required_answer" ? "a required question has no confirmed answer" : "a required question could not be filled in and checked" }));
    }
    if (res.reason === "retries_exhausted") {
      if (res.error === "page_load_429") await refused(row, "rate_limited", null);
      else if (/^page_load_5\d\d$/.test(res.error || "")) await refused(row, "server_busy", null);
      ev.error = res.error;
    }
    return void (await complete(row, "not_submitted", res.reason || "not_submitted", { ...ev, nothing_sent: true, field: res.field }));
  }

  async function runOne(row) {
    const host = new URL(row.url).host.toLowerCase();
    const st = { row, host, lost: false };
    inflight.set(row.id, st);
    try {
      // Polite pacing on one portal, only if the owner set it; the default is none of ours.
      for (;;) {
        const n = hostCount.get(host) || 0, wait = cfg.hostSpacingMs - (Date.now() - (hostLast.get(host) || 0));
        if (n < cfg.hostMax && wait <= 0) break;
        await sleep(Math.max(25, Math.min(wait > 0 ? wait : 100, 500)));
      }
      hostCount.set(host, (hostCount.get(host) || 0) + 1); hostLast.set(host, Date.now());
      try { await process(row); } finally { hostCount.set(host, hostCount.get(host) - 1); }
      stats.ms.push(Date.now() - (row._claimedAt || Date.now()));
    } finally { inflight.delete(row.id); }
  }

  async function tick() {
    const capacity = cfg.concurrency - inflight.size;
    if (capacity <= 0 || stopping) return 0;
    // Ask for work in batches: a claim has a fixed cost, so with engines still running wait until a quarter of the slots are free.
    if (inflight.size > 0 && capacity < Math.max(1, Math.ceil(cfg.concurrency / 4))) return 0;
    const skip = [...hostCount.entries()].filter(([, n]) => n >= cfg.hostMax).map(([h]) => h.toLowerCase().replace(/^www\./, "").replace(/:(80|443)$/, ""));
    const rows = await rpc("career_apply_vm_claim", { p_worker: cfg.workerId, p_limit: capacity, p_per_user: cfg.perUser, p_skip_hosts: skip });
    for (const r of rows || []) { r._claimedAt = Date.now(); stats.claimed++; runOne(r).catch((e) => log(`RUN_ERROR ${e.message}`)); }
    return (rows || []).length;
  }

  let timers = [];
  async function run() {
    timers.push(setInterval(async () => {
      for (const st of inflight.values()) {
        try { const r = await rpc("career_apply_vm_heartbeat", { p_id: st.row.id, p_lease: st.row.lease_token, p_worker: cfg.workerId, p_phase: null }); if (!r || !r.ok) st.lost = true; } catch { /* retried at the next beat */ }
      }
    }, cfg.heartbeatMs));
    let lastSweep = 0;
    while (!stopping) {
      try {
        if (Date.now() - lastSweep >= cfg.sweepMs) { lastSweep = Date.now(); await rpc("career_apply_vm_reap", { p_stale_seconds: cfg.staleSeconds }); }
        const n = await tick();
        if (n === 0) await sleep(cfg.pollMs);
      } catch (e) { log(`LOOP_ERROR ${String(e.message).slice(0, 160)}`); await sleep(Math.max(cfg.pollMs, 2000)); }
    }
    while (inflight.size) await sleep(100); // a stop never abandons an application in flight
    timers.forEach(clearInterval);
  }
  return { run, tick, stop() { stopping = true; }, stats, cfg, inflight, pct: (p) => pct(stats.ms, p) };
}

module.exports = { createWorker, restRpc, queueHash, canonical, atsOf, machineSlots };
