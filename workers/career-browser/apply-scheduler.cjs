"use strict";
// The pace of real submission (release 9, workstream A, 2026-11-07). Between a person's yes and the employer's form: which
// approved application is sent when, how a failure is retried or set aside, and what each send must leave behind. It
// never decides WHAT is sent: every job carries the exact payload the person approved and its hash, and nothing is sent
// unless that hash is still the payload's own at the moment of sending (D-MS-1). The send itself is injected (`submit`):
// in production one application through 149's doorstep (batch-executor.cjs, `only: [key]`), in the load test a stub ATS.
//
// Limits (owner, 2026-11-07, "200/day"; DECISIONS D-R9-1), each set by name in the worker's environment (limitsFromEnv):
//   CAREER_APPLY_PER_PERSON_HOUR    60   a person's pace: one send a minute at most, so 60 in any hour
//   CAREER_APPLY_PER_PERSON_DAY     200  sends for one person in any 24 hours
//   CAREER_APPLY_PER_EMPLOYER_HOUR  30   sends to one employer (its normalized name) in any hour, across every person
//   CAREER_APPLY_PER_SITE_MINUTE    30   requests to one site (the ATS host) in any minute, across every person
//   CAREER_APPLY_MAX_ATTEMPTS       4    tries of a send that failed before anything reached the employer
//   CAREER_APPLY_BACKOFF_BASE_MS    60000, doubling per try, at most CAREER_APPLY_BACKOFF_MAX_MS (3600000)
// A value that is not a whole number from 1 is the default, never "no limit": an unreadable cap is not permission.
//
// What happens to each job (state):
//   queued / retry_wait       waiting for its turn (counted: the posting is taken for this person)
//   confirmed                 sent, and the employer's own email (or the ATS's receipt by mail) confirms it   proof kept
//   submitted_unconfirmed     sent, with a confirmation page or an API receipt; waits for the email           proof kept
//   unknown_outcome           it may have reached the employer (posted, no proof; a failure after the click; a crash):
//                             never sent again (D-024)
//   needs_user                handed to the person (a captcha, a sign-in, a question): never solved, never retried here
//   dead_letter               never reached the employer, set aside with the reason (permanent, or retries exhausted);
//                             the posting is free for a later approval
//   withdrawn                 taken off the queue before its turn (its drive ended): never sent, the posting is free
// The same posting (its job id, or its canonical link: postingKey, the ledger's rule) is never applied to twice by one
// person while any job for it is counted. LinkedIn, Indeed and Handshake links are refused outright.
const crypto = require("node:crypto");

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const DEFAULT_LIMITS = Object.freeze({ perPersonHour: 60, perPersonDay: 200, perEmployerHour: 30, perSiteMinute: 30, maxAttempts: 4, backoffBaseMs: MIN, backoffMaxMs: HOUR });
const ENV_NAMES = Object.freeze({
  perPersonHour: "CAREER_APPLY_PER_PERSON_HOUR", perPersonDay: "CAREER_APPLY_PER_PERSON_DAY", perEmployerHour: "CAREER_APPLY_PER_EMPLOYER_HOUR",
  perSiteMinute: "CAREER_APPLY_PER_SITE_MINUTE", maxAttempts: "CAREER_APPLY_MAX_ATTEMPTS", backoffBaseMs: "CAREER_APPLY_BACKOFF_BASE_MS", backoffMaxMs: "CAREER_APPLY_BACKOFF_MAX_MS",
});
const WHOLE = /^\s*\+?[0-9]{1,10}\s*$/;
const whole = (v) => (typeof v === "number" ? (Number.isInteger(v) && v >= 1 ? v : null) : WHOLE.test(String(v == null ? "" : v)) && Number(v) >= 1 ? Number(v) : null);
function limitsFromEnv(env) {
  const e = env || {};
  const out = {};
  for (const [k, name] of Object.entries(ENV_NAMES)) out[k] = whole(e[name]) || DEFAULT_LIMITS[k];
  return out;
}
function mergeLimits(l) {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS)) if (l && whole(l[k])) out[k] = whole(l[k]);
  return out;
}

// The ledger's posting key, rule for rule (supabase/functions/_shared/career_apply.ts postingKey and its SQL twin
// career_apply_posting_key, 20261107120100; tests/architect/r9-apply-scheduler.test.ts holds them equal).
function postingKey(url) {
  const m = /^https?:\/\/([^/?#@]+)([^?#]*)(\?[^#]*)?/.exec(String(url == null ? "" : url).trim().toLowerCase());
  if (!m) return null;
  const h = m[1].replace(/^www\./, "").replace(/:(80|443)$/, "");
  let p = (m[2] || "").replace(/\/+$/, "");
  if (/^\/[^/]+\/.+\/(apply|application)$/.test(p)) p = p.replace(/\/(apply|application)$/, "").replace(/\/+$/, "");
  const ghJid = (/[?&]gh_jid=([0-9]+)/.exec(m[3] || "") || [])[1];
  if (ghJid) return "greenhouse.io/jobs/" + ghJid;
  if (/(^|\.)greenhouse\.io$/.test(h)) {
    const jid = (/\/jobs\/([0-9]+)$/.exec(p) || [])[1];
    if (jid) return "greenhouse.io/jobs/" + jid;
  }
  const q = (m[3] || "").slice(1).split("&")
    .filter((x) => x !== "" && !/^(utm_[a-z_]*|gh_src|src|source|ref|referrer|lever-[a-z-]*)(=|$)/.test(x))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("&");
  return h + p + (q ? "?" + q : "");
}
const normCompany = (c) => String(c == null ? "" : c).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ")
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g, " ").replace(/\s+/g, " ").trim();
const siteOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const NEVER_HOSTS = /(^|\.)(linkedin\.com|indeed\.com|joinhandshake\.com|handshake\.com)$/i;

// The hash of a payload as the approval binds it: SHA-256 of its JSON with every object's keys in order.
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
  : JSON.stringify(v === undefined ? null : v);
const payloadSha256 = (payload) => crypto.createHash("sha256").update(stable(payload)).digest("hex");

const COUNTED = new Set(["queued", "retry_wait", "sending", "confirmed", "submitted_unconfirmed", "unknown_outcome", "needs_user"]);
const WAITING = new Set(["queued", "retry_wait"]);
const PROOF_KINDS = new Set(["confirmation_page", "email", "api_receipt"]);

// A sliding-window counter of times: how many fall in [now - span, now], and when the next slot opens under a limit.
function windowFor() {
  const at = [];
  return {
    add: (t) => { at.push(t); },
    // A reservation taken back (the send it held posted nothing).
    remove: (t) => { const i = at.lastIndexOf(t); if (i >= 0) at.splice(i, 1); },
    // The earliest time >= now at which fewer than `limit` of the recorded times fall in the last `span`.
    openAt(now, span, limit) {
      while (at.length && at[0] <= now - span - DAY) at.shift(); // keep a day past any span in use
      let inWin = 0;
      for (let i = at.length - 1; i >= 0 && at[i] > now - span; i--) inWin++;
      if (inWin < limit) return now;
      return at[at.length - inWin + (inWin - limit)] + span;
    },
    last: () => (at.length ? at[at.length - 1] : null),
  };
}

function createApplyScheduler(o) {
  const x = o || {};
  if (typeof x.submit !== "function") throw Object.assign(new Error("createApplyScheduler: submit(job) is required"), { code: "SUBMIT_NOT_WIRED" });
  const now = typeof x.now === "function" ? x.now : () => Date.now();
  const L = mergeLimits(x.limits);
  const interval = Math.ceil(HOUR / L.perPersonHour);
  const jobs = new Map(); // id -> job, in enqueue order
  const people = new Map(), employers = new Map(), sites = new Map();
  const win = (m, k) => { if (!m.has(k)) m.set(k, windowFor()); return m.get(k); };
  let seq = 0;

  function counted(userId) { return [...jobs.values()].filter((j) => j.userId === userId && COUNTED.has(j.state)); }
  function enqueue(a) {
    const app = a || {};
    if (!app.id || !app.userId || (!app.jobId && !app.url)) return { ok: false, reason: "invalid_job" };
    if (jobs.has(app.id) && COUNTED.has(jobs.get(app.id).state)) return { ok: false, reason: "duplicate_job" };
    if (NEVER_HOSTS.test(siteOf(app.url))) return { ok: false, reason: "never_site" };
    if (!app.approvalHash || app.approvalHash !== app.payloadSha256) return { ok: false, reason: "not_approved" };
    if (!app.payload || payloadSha256(app.payload) !== app.payloadSha256) return { ok: false, reason: "payload_hash_mismatch" };
    const key = postingKey(app.url);
    if (counted(app.userId).some((j) => (app.jobId && j.jobId === app.jobId) || (key !== null && j.key === key))) return { ok: false, reason: "duplicate_job" };
    jobs.set(app.id, {
      id: app.id, runId: app.runId || null, userId: app.userId, jobId: app.jobId || null, company: app.company || "", url: app.url || "", key,
      employer: normCompany(app.company), site: siteOf(app.url), payload: app.payload, payloadSha256: app.payloadSha256, approvalHash: app.approvalHash,
      state: "queued", attempts: 0, dueAt: now(), seq: ++seq, proof: null, reason: null, history: [], ref: app.ref,
    });
    return { ok: true, reason: null };
  }

  // The earliest time this job may be sent, under every limit (its own retry time first).
  function eligibleAt(j, t) {
    const p = win(people, j.userId);
    const last = p.last();
    return Math.max(j.dueAt, last === null ? t : last + interval,
      p.openAt(t, DAY, L.perPersonDay), p.openAt(t, HOUR, L.perPersonHour),
      j.employer ? win(employers, j.employer).openAt(t, HOUR, L.perEmployerHour) : t,
      j.site ? win(sites, j.site).openAt(t, MIN, L.perSiteMinute) : t);
  }
  // `only` (optional): consider only the jobs it accepts (one run's, when a drive paces its own batch).
  function nextDueAt(only) {
    const t = now();
    let best = null;
    for (const j of jobs.values()) if (WAITING.has(j.state) && (!only || only(j))) { const e = eligibleAt(j, t); if (best === null || e < best) best = e; }
    return best;
  }
  const jitter = (id, n) => parseInt(crypto.createHash("sha256").update(`${id}:${n}`).digest("hex").slice(0, 8), 16) % Math.max(1, Math.floor(L.backoffBaseMs / 4));
  const backoff = (j) => Math.min(L.backoffBaseMs * 2 ** (j.attempts - 1), L.backoffMaxMs) + jitter(j.id, j.attempts);
  function settle(j, state, extra) { Object.assign(j, { state }, extra || {}); j.history.push({ at: now(), state, ...(extra && extra.reason ? { reason: extra.reason } : {}) }); }

  async function sendOne(j) {
    const t = now();
    // D-MS-1 at the moment of sending: the payload must still be exactly what was approved.
    if (payloadSha256(j.payload) !== j.approvalHash || j.payloadSha256 !== j.approvalHash) {
      settle(j, "dead_letter", { reason: "permanent: payload_changed_after_approval", deadAt: t });
      return;
    }
    j.attempts++;
    win(sites, j.site).add(t);
    // The person's and the employer's slots are taken before the send, not after it: drives for other people (and so for
    // the same employer) run side by side (batch-executor.cjs), and a slot counted only once the send returned would let
    // a second drive past the same limit while the first is still on the employer's form. Given back if nothing posted.
    win(people, j.userId).add(t);
    if (j.employer) win(employers, j.employer).add(t);
    j.state = "sending";
    let r;
    try { r = await x.submit(j); } catch (e) { r = { posted: null, outcome: "error", reason: String((e && e.message) || e).slice(0, 160) }; }
    const res = r || {};
    const reason = String(res.reason || res.outcome || "unknown").slice(0, 200);
    const reached = res.posted !== false; // anything but a clear "nothing was posted" may have reached the employer
    if (!reached) { win(people, j.userId).remove(t); if (j.employer) win(employers, j.employer).remove(t); }
    if (res.outcome === "submitted" && res.posted === true) {
      const pr = res.proof;
      if (pr && PROOF_KINDS.has(pr.kind) && String(pr.ref || "").trim()) {
        settle(j, pr.kind === "email" ? "confirmed" : "submitted_unconfirmed", { proof: { kind: pr.kind, ref: String(pr.ref).slice(0, 500), at: t }, reason: null });
      } else settle(j, "unknown_outcome", { reason: "posted_without_proof" });
      return;
    }
    if (reached) { settle(j, "unknown_outcome", { reason: `may_have_reached_employer: ${reason}` }); return; }
    if (res.outcome === "needs_user") { settle(j, "needs_user", { reason }); return; }
    if (res.outcome === "transient") {
      if (j.attempts < L.maxAttempts) { settle(j, "retry_wait", { dueAt: t + backoff(j), reason }); return; }
      settle(j, "dead_letter", { reason: `retries_exhausted: ${reason}`, deadAt: t });
      return;
    }
    settle(j, "dead_letter", { reason: `permanent: ${reason}`, deadAt: t });
  }

  // Send every waiting job whose turn has come, oldest due first; each send moves the windows the next one is judged by.
  async function tick(only) {
    const t = now();
    const order = [...jobs.values()].filter((j) => WAITING.has(j.state) && (!only || only(j))).sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
    let sent = 0;
    for (const j of order) {
      if (eligibleAt(j, t) > t) continue;
      await sendOne(j);
      sent++;
    }
    return { sent };
  }

  const view = (j) => j && { id: j.id, runId: j.runId, userId: j.userId, jobId: j.jobId, company: j.company, url: j.url, state: j.state, attempts: j.attempts, proof: j.proof, reason: j.reason, history: j.history.slice() };
  // A waiting job taken off the queue (its drive ended before its turn): never sent, no longer counted.
  function withdraw(id, reason) {
    const j = jobs.get(id);
    if (!j || !WAITING.has(j.state)) return false;
    settle(j, "withdrawn", { reason: String(reason || "withdrawn") });
    return true;
  }
  return {
    limits: L, enqueue, tick, nextDueAt, withdraw,
    job: (id) => view(jobs.get(id)),
    jobs: () => [...jobs.values()].map(view),
    deadLetters: () => [...jobs.values()].filter((j) => j.state === "dead_letter").map((j) => ({ id: j.id, userId: j.userId, reason: j.reason, attempts: j.attempts, at: j.deadAt })),
    stats() {
      const s = {};
      for (const j of jobs.values()) s[j.state] = (s[j.state] || 0) + 1;
      return s;
    },
  };
}

module.exports = { createApplyScheduler, limitsFromEnv, postingKey, payloadSha256, normCompany, DEFAULT_LIMITS, ENV_NAMES };
