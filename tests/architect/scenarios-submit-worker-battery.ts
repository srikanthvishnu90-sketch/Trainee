// Submit worker round (2026-10-31): what happens AFTER the person's yes, on the worker's own decisions, in memory. A seeded
// battery (SEED, N scenarios) over five families, each through the real code (no copy of it):
//   drive    one claimed application through runCloudJob (workers/career-cloud/worker.ts) against a fake queue and a fake
//            employer board: every board answer (a confirmation, a 200 with no proof, a 200 error page, 429/503 at the page,
//            a 5xx after the POST, a verification check at open or at Submit, a required question with no confirmed answer,
//            a sign-in wall, an engine that dies or gives nothing), every change between the yes and the Submit (the payload
//            or its approval changed, the resume replaced or missing, another account's fact, the job handed to the wrong
//            person, the approval or the posting withdrawn before the engine or before the click), and a queue that cannot
//            record the outcome.
//   restart  the worker killed at each step (claimed, started, the board answered, the answer journaled, the outcome
//            recorded) and started again on the same journal (cloudLoop + massRun), the database's lease swept or not.
//   mail     the employer's confirmation email against the queue (planConfirmations), a drive still recorded as running.
//   words    every state and reason any worker or the database records, as "where are my applications" says it.
//   backoff  a host's Retry-After and the doubling: never negative, never more than a day, each refusal later than the last.
// Invariants (every scenario): the board receives at most one application per person and posting, only after the authorized
// effect, only the approved payload, with the confirmed resume, under the person the job belongs to; a sent state is recorded
// only for an application the board took, and an application the board may have taken is never recorded as not sent;
// a verification check or a sign-in wall is handed back and never retried; a question with no confirmed answer is asked
// (no value) and never filled; the private folder is gone; every ended state reads as words, never a code.
import { runCloudJob, cloudLoop, type CloudJob, type CloudQueue } from "../../workers/career-cloud/worker.ts";
import { backoffMs, BACKOFF_CEIL_MS, type Journal, type JournalEntry, type JournalResult, retryAfterSeconds, RETRY_AFTER_MAX_S } from "../../workers/career-browser/mass-run.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { planConfirmations, type QueueRow } from "../../supabase/functions/_shared/career_apply_confirm.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
// A line the person reads is words: no worker code in it (HOST_RATE_LIMITED, needs_answers), never "no reason recorded".
export function readableReason(text: string): boolean {
  return !!text && !/no reason recorded/.test(text) && !/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(text) && !/\b[a-z]+_[a-z0-9_]+\b/.test(text);
}
import { type MailIn, parseFrom } from "../../supabase/functions/_shared/career_mail.ts";

export const SEED = 20261031;
export const N = Number(Deno.env.get("SUBMIT_WORKER_N") ?? 10_000);

// ------------------------------------------------------------------------------------------------ the dice
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)], int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), chance: (p: number) => next() < p };
}

// ------------------------------------------------------------------------------------------------ the scenarios
export const BOARD = ["confirmed", "unconfirmed", "error_page_200", "rate_429", "rate_503", "server_5xx_after_post", "captcha_open", "captcha_submit",
  "needs_answers", "login_wall", "engine_null", "engine_dies_before_click", "engine_dies_after_post", "timeout"] as const;
export const CHANGE = ["none", "none", "none", "payload_changed", "approval_changed", "resume_replaced", "resume_missing", "no_resume_bound", "other_account_fact",
  "wrong_person", "withdrawn_before_engine", "withdrawn_before_click", "posting_closed_before_click"] as const;
export const CRASH = ["claimed", "started", "board_answered", "answer_journaled", "recorded"] as const;
export const STATES = ["queued", "driving", "confirmed", "submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"] as const;
// Every reason code a worker or the database records (scripts/apply.ts, approve-first.ts, mass-run.ts, worker.ts, the claims).
export const CODES = ["HOST_RATE_LIMITED", "CAPTCHA_AT_SUBMIT", "captcha", "bot_check", "login_required", "ACCOUNT_LOGIN_REQUIRED", "needs_answers",
  "APPROVED_APPLICATION_CHANGED", "APPROVED_BODY_MISMATCH", "APPROVED_MANIFEST_CHANGED", "INVALID_APPROVED_SCHEMA", "CONTRACT_REFUSED: \"Salary\": its fact is quarantined (D-007)",
  "CONFLICTING_APPROVED_ANSWERS", "RESUME_CHANGED", "RESUME_NOT_IN_CLOUD", "NO_RESUME", "FACTS_EXPIRED", "ACCOUNT_PAUSED", "FACTS_ERASED",
  "FACT_OWNER_MISMATCH", "duplicate_job", "daily_cap", "IDENTITY_NUMBER_REQUESTED", "UNCONFIRMED_HIDDEN_FIELD", "UNSUPPORTED_FILE_ARTIFACT",
  "SUBMIT_DESTINATION_NOT_BOUND", "SUBMIT_DESTINATION_UNEXPECTED", "SCRIPT_SUBMIT_FAMILY_MISMATCH", "PERSON_SUBMITS_NEEDS_HEADED", "HANDOFF_NEEDS_HEADED",
  "CARD_CLOUD_PERMISSION_REVOKED", "CARD_CLOUD_AUTH_REQUIRED", "CARD_CLOUD_AUTH_REFUSED", "CARD_CLOUD_AUTH_PROTOCOL", "CARD_CLOUD_AUTH_TIMEOUT",
  "CARD_CLOUD_AUTHORIZATION_REFUSED", "NO_ENGINE_APPROVAL", "APPROVED_SOURCE_WITHDRAWN", "NOT_APPROVED", "DRIVER_ERROR", "ENGINE_NO_RESULT",
  "worker_stopping", "not_started_in_lease", "host_held", "journal_unwritable", "WORKER_STOPPING", "NOT_STARTED_IN_LEASE", "JOURNAL_UNWRITABLE: disk full",
  "FORM_DID_NOT_SETTLE", "SUBMIT_EFFECT_UNCERTAIN", "SUBMIT_ACKNOWLEDGEMENT_UNCERTAIN", "PROOF_CAPTURE_FAILED", "user_declined", "timeout",
  "not sent: the posting closed before we sent it", "not sent: the employer closed this posting before it was sent",
  "not sent: your approval expired before we could send it; nothing was sent. Approve it again if you still want it",
  "not sent: the application changed after it was approved", "not sent: this exact posting was already sent (recorded after you approved this one)",
  "not sent: it carried a resume other than the one on file (one confirmed resume)", "application outcome unknown: the drive stopped before recording it; not retried",
  "the run stopped after the engine started; not retried", "the engine gave no result after it started; not retried", null, ""] as const;

export type Scenario =
  | { n: number; family: "drive"; board: typeof BOARD[number]; change: typeof CHANGE[number]; requeue: boolean; finishFails: number; retryAfter: string | null; fields: number }
  | { n: number; family: "restart"; crash: typeof CRASH[number]; board: "confirmed" | "unconfirmed" | "captcha_open" | "error_page_200"; swept: boolean; age: "fresh" | "late"; others: number }
  | { n: number; family: "mail"; rows: { state: typeof STATES[number]; company: number; ageH: number; title: number; hashed: boolean }[]; mails: { company: number; atH: number; title: number; kind: "received" | "rejection" }[] }
  | { n: number; family: "words"; state: typeof STATES[number]; reason: string | null; company: string }
  | { n: number; family: "backoff"; retryAfter: string | null; level: number; refusals: number };

export function generate(seed = SEED, n = N): Scenario[] {
  const r = rng(seed), out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r.next();
    if (roll < 0.42) {
      out.push({ n: i, family: "drive", board: r.pick(BOARD), change: r.pick(CHANGE), requeue: r.chance(0.7),
        finishFails: r.chance(0.004) ? r.pick([1, 4]) : 0, retryAfter: r.pick([null, "0", "7", "120", "Wed, 21 Oct 2026 07:28:00 GMT", "soon", "-1", "999999"]), fields: r.int(0, 4) });
    } else if (roll < 0.62) {
      out.push({ n: i, family: "restart", crash: r.pick(CRASH), board: r.pick(["confirmed", "unconfirmed", "captcha_open", "error_page_200"] as const),
        swept: r.chance(0.25), age: r.chance(0.3) ? "late" : "fresh", others: r.int(0, 2) });
    } else if (roll < 0.77) {
      const rows = Array.from({ length: r.int(1, 4) }, () => ({ state: r.pick(STATES), company: r.int(0, 2), ageH: r.int(-30, 24 * 16), title: r.int(0, 1), hashed: r.chance(0.1) }));
      const mails = Array.from({ length: r.int(1, 3) }, () => ({ company: r.int(0, 2), atH: r.int(-2, 2), title: r.int(0, 1), kind: r.pick(["received", "rejection"] as const) }));
      out.push({ n: i, family: "mail", rows, mails });
    } else if (roll < 0.92) {
      const junk = r.chance(0.15) ? `${r.pick(["SOME_NEW_CODE", "board_said_no", "HTTP_502", "x"])}` : null;
      out.push({ n: i, family: "words", state: r.pick(STATES), reason: junk ?? r.pick(CODES), company: r.pick(["Acme", "Beta Labs", "", "Gamma & Sons"]) });
    } else {
      out.push({ n: i, family: "backoff", retryAfter: r.pick([null, "0", "30", "86400", "86401", "999999999", "-5", "1.5", "Retry in 5", "Wed, 21 Oct 2026 07:28:00 GMT", "Sun Nov  6 08:49:37 1994", ""]),
        level: r.int(0, 40), refusals: r.int(1, 30) });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ helpers
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", b as BufferSource));
const enc = new TextEncoder();
export const OWNER = "00000000-0000-4000-8000-00000005b001", OTHER = "00000000-0000-4000-8000-00000005b0ff";
const RESUME_BYTES = enc.encode("%PDF-1.4 TEST submit-worker resume");
const OTHER_BYTES = enc.encode("%PDF-1.4 TEST a different resume");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const SENT = new Set(["confirmed", "submitted_unconfirmed"]);
const MAYBE_SENT = new Set(["confirmed", "submitted_unconfirmed", "unknown_outcome"]);

export async function approvedJob(n: number, o: { fields?: number; user?: string } = {}): Promise<CloudJob> {
  const user = o.user ?? OWNER, url = `https://jobs.lever.co/sw${n % 97}/${n}`;
  const payload = {
    version: 1, user_id: user, job_id: `lever:sw${n % 97}:${n}`, company: `TEST Employer ${n % 97}`, url, destination: url,
    engine_approval: (await sha(enc.encode(`approval-${n}`))), resume_sha256: await sha(RESUME_BYTES),
    privacy_epoch: 1, account_version: 1, expires_at: "2026-11-02T00:00:00Z",
    fields: Array.from({ length: o.fields ?? 2 }, (_, i) => ({ name: `f${i}`, label: `TEST question ${i}`, value: `TEST answer ${i}`, factId: `F-${100 + i}`,
      provenance: "owner stated in chat (TEST)", confirmation_event_id: `evt-${i}`, user_id: user })),
  };
  const h = await hashApplyPayload(payload);
  return { id: crypto.randomUUID(), lease_token: crypto.randomUUID(), user_id: user, company: payload.company, url, payload, payload_hash: h, approval_hash: h, job_id: payload.job_id };
}

// The employer's board: what it received, per person and posting, with what (the payload's hash and the resume's).
export function board() {
  const got: { user: string; posting: string; payloadHash: string; resume: string; accepted: boolean }[] = [];
  return {
    got,
    post(job: CloudJob, accepted: boolean, resume: string, payloadHash: string) { got.push({ user: job.user_id, posting: String(job.payload?.job_id), payloadHash, resume, accepted }); },
    accepted: (posting: string) => got.filter((g) => g.posting === posting && g.accepted).length,
    posts: (posting: string) => got.filter((g) => g.posting === posting).length,
  };
}

// ------------------------------------------------------------------------------------------------ family: drive
export async function runDrive(s: Extract<Scenario, { family: "drive" }>, tmpRoot: string): Promise<string[]> {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} drive ${s.board}/${s.change}: ${m}`);
  const job = await approvedJob(s.n, { fields: s.fields });
  const approved = { hash: job.approval_hash, resume: job.payload.resume_sha256 as string, user: job.user_id, id: job.id, lease: job.lease_token };
  // What changed between the yes and this claim (the claimed row as the worker receives it).
  if (s.change === "payload_changed") job.payload = { ...job.payload, fields: [...job.payload.fields, { name: "x", label: "TEST injected", value: "TEST", factId: "F-150", provenance: "owner stated (TEST)", confirmation_event_id: "e", user_id: OWNER }] };
  if (s.change === "approval_changed") job.approval_hash = "f".repeat(64);
  if (s.change === "no_resume_bound") { delete job.payload.resume_sha256; job.payload_hash = job.approval_hash = await hashApplyPayload(job.payload); }
  if (s.change === "other_account_fact") { job.payload.fields[0] = { ...(job.payload.fields[0] ?? { name: "f0", label: "TEST" }), user_id: OTHER, value: "VSECRET other account" }; job.payload_hash = job.approval_hash = await hashApplyPayload(job.payload); }
  if (s.change === "wrong_person") job.user_id = OTHER;
  const b = board(), calls: string[] = [], asked: Record<string, unknown>[][] = [], finished: { id: string; lease: string; state: string; evidence: any; outcome: string }[] = [];
  let finishFails = s.finishFails, engineRuns = 0, effectAsked = 0;
  const queue: CloudQueue = {
    claim: async () => [],
    gatePresent: async () => true,
    authorize: async (j, phase) => {
      calls.push(`authorize:${phase}`);
      if (j.id !== approved.id || j.lease_token !== approved.lease) throw Error("invalid apply claim");
      if (s.change === "withdrawn_before_engine" && phase === "before_engine") throw Error("CARD_CLOUD_PERMISSION_REVOKED");
      if (s.change === "withdrawn_before_click" && phase === "before_effect") throw Error("CARD_CLOUD_PERMISSION_REVOKED");
      if (s.change === "posting_closed_before_click" && phase === "before_effect") throw Error("posting_closed");
    },
    resume: async () => {
      calls.push("resume");
      if (s.change === "resume_missing") return null;
      const bytes = s.change === "resume_replaced" ? OTHER_BYTES : RESUME_BYTES;
      return { filename: "resume.pdf", sha256: s.change === "resume_replaced" ? await sha(OTHER_BYTES) : approved.resume, b64: b64(bytes) };
    },
    finish: async (j, state, evidence, outcome) => {
      calls.push("finish");
      if (finishFails > 0) { finishFails--; throw Error("TEST queue unreachable"); }
      finished.push({ id: j.id, lease: j.lease_token, state, evidence, outcome });
    },
    ask: async (_j, q) => { calls.push("ask"); asked.push(q); return q.length; },
  };
  if (s.requeue) queue.requeue = async () => null;
  const questions = Array.from({ length: Math.max(1, s.fields) }, (_, i) => ({ label: `TEST required question ${i}`, type: "input_text", options: [] }));
  const runEngine = async (args: string[], _env: unknown, controls?: { beforeEffect?: () => Promise<void> }) => {
    engineRuns++;
    const factsPath = args[args.indexOf("--facts") + 1], resumePath = args[args.indexOf("--resume") + 1];
    const resumeSha = await sha(await Deno.readFile(resumePath));
    JSON.parse(await Deno.readTextFile(factsPath));
    const click = async () => {
      effectAsked++;
      await controls!.beforeEffect!();
    };
    const sentWhat = await hashApplyPayload(job.payload);
    switch (s.board) {
      case "confirmed": case "unconfirmed": {
        try { await click(); } catch { return { result: { state: "not_submitted", reason: "CARD_CLOUD_AUTHORIZATION_REFUSED" }, evidence: null }; }
        b.post(job, true, resumeSha, sentWhat);
        return { result: { state: s.board === "confirmed" ? "confirmed" : "submitted_unconfirmed", confirmation_id: s.board === "confirmed" ? `TEST-C-${s.n}` : null }, evidence: { post: { status: 200 } } };
      }
      case "error_page_200": {
        try { await click(); } catch { return { result: { state: "not_submitted", reason: "CARD_CLOUD_AUTHORIZATION_REFUSED" }, evidence: null }; }
        b.post(job, false, resumeSha, sentWhat);
        return { result: { state: "failed", reason: "FORM_DID_NOT_SETTLE" }, evidence: { post: { status: 200 }, observation: { page_text: "There was an error with your submission" } } };
      }
      case "rate_429": case "rate_503":
        return { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status: s.board === "rate_429" ? 429 : 503, ...(retryAfterSeconds(s.retryAfter, Date.now()) !== null ? { retry_after_s: retryAfterSeconds(s.retryAfter, Date.now()) } : {}) }, evidence: null };
      case "server_5xx_after_post": {
        try { await click(); } catch { return { result: { state: "not_submitted", reason: "CARD_CLOUD_AUTHORIZATION_REFUSED" }, evidence: null }; }
        b.post(job, s.n % 2 === 0, resumeSha, sentWhat); // the board may or may not have kept it
        return { result: { state: "unknown_outcome", reason: "SUBMIT_EFFECT_UNCERTAIN" }, evidence: { post: { status: 502 } } };
      }
      case "captcha_open": return { result: { state: "needs_user", reason: "captcha" }, evidence: null };
      case "captcha_submit": return { result: { state: "not_submitted", reason: "CAPTCHA_AT_SUBMIT" }, evidence: null };
      case "needs_answers": return { result: { state: "not_submitted", reason: "needs_answers", posting: job.payload.job_id, company: job.company, questions }, evidence: null };
      case "login_wall": return { result: { state: "not_submitted", reason: "ACCOUNT_LOGIN_REQUIRED" }, evidence: null };
      case "engine_null": case "timeout": return null;
      case "engine_dies_before_click": throw Error("TEST engine crashed");
      case "engine_dies_after_post": {
        try { await click(); } catch { return { result: { state: "not_submitted", reason: "CARD_CLOUD_AUTHORIZATION_REFUSED" }, evidence: null }; }
        b.post(job, true, resumeSha, sentWhat);
        throw Error("TEST engine crashed after the POST");
      }
    }
  };
  const r: any = await runCloudJob(job, { queue, runEngine: runEngine as any, tmpRoot, log: () => {}, requeueRefusal: s.requeue });
  const posting = String(job.payload.job_id);
  // The board.
  if (engineRuns > 1) fail(`the engine ran ${engineRuns} times`);
  if (effectAsked > 1) fail(`the click was authorized ${effectAsked} times`);
  if (b.accepted(posting) > 1 || b.posts(posting) > 1) fail(`the board received ${b.posts(posting)} applications for one posting`);
  for (const g of b.got) {
    if (g.payloadHash !== approved.hash) fail("the board received a payload other than the approved one");
    if (g.resume !== approved.resume) fail("the board received a resume other than the confirmed one");
    if (g.user !== approved.user) fail("the board received the application under another person");
  }
  const changed = s.change !== "none";
  if (changed && b.got.length) fail("an application changed after the yes still reached the board");
  if (JSON.stringify(b.got).includes("VSECRET")) fail("another account's fact reached the board");
  // The record.
  if (r.requeue) {
    if (!["rate_429", "rate_503"].includes(s.board) || effectAsked || b.got.length) fail(`put back although something may have been sent (${s.board})`);
    if (finished.length) fail("put back and also finished");
  } else {
    if (!r.recorded && s.finishFails < 4) fail("not recorded although the queue answered");
    if (s.finishFails >= 4 && r.recorded) fail("recorded although the queue never answered");
    const state = r.state;
    if (SENT.has(state) && !b.accepted(posting)) fail(`recorded ${state} but the board took nothing`);
    if (b.accepted(posting) && !MAYBE_SENT.has(state)) fail(`the board took it but it was recorded ${state}`);
    if (b.posts(posting) && !b.accepted(posting) && SENT.has(state)) fail(`an error page recorded as ${state}`);
    if ((s.board === "captcha_open" || s.board === "captcha_submit") && !changed && (state !== "needs_user" || r.reason !== "bot_check")) fail(`a verification check ended ${state}/${r.reason}`);
    if (s.board === "login_wall" && !changed && (state !== "needs_user" || r.reason !== "login_required")) fail(`a sign-in wall ended ${state}/${r.reason}`);
    if (s.board === "needs_answers" && !changed) {
      if (state === "confirmed" || state === "submitted_unconfirmed") fail("a required question with no answer was sent");
      if (!asked.length) fail("a required question with no confirmed answer was not asked");
      for (const q of asked.flat()) if ("value" in q || "answer" in q) fail(`a question was asked with an answer in it: ${JSON.stringify(q)}`);
    }
    if (s.board !== "needs_answers" && asked.length) fail("asked a question the board never raised");
    for (const f of finished) {
      if (f.id !== approved.id || f.lease !== approved.lease) fail("finished a job or lease other than the one claimed");
      const text = statusLine({ id: f.id, company: job.company, state: f.state, reason: f.evidence?.reason ?? null, created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z" });
      if (!readableReason(text)) fail(`the person reads a code: ${text}`);
      if (JSON.stringify(f.evidence ?? {}).includes("VSECRET") && s.change !== "other_account_fact") fail("another account's fact in the evidence");
    }
    if (changed && SENT.has(state)) fail(`sent after ${s.change}`);
  }
  // The private folder.
  for await (const _ of Deno.readDir(tmpRoot)) { fail("the private folder was left behind"); break; }
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: restart
export function memoryJournal<J extends { id: string }>(): Journal<J> & { entries: Map<string, JournalEntry<J>> } {
  const entries = new Map<string, JournalEntry<J>>();
  return {
    entries,
    async put(job, claimedAt) { entries.set(job.id, { job: structuredClone(job), claimedAt, started: false }); },
    async start(id) { const e = entries.get(id); if (!e) throw Error("JOURNAL_GONE"); e.started = true; },
    async result(id, r: JournalResult) { const e = entries.get(id); if (!e) throw Error("JOURNAL_GONE"); e.started = true; e.result = structuredClone(r); },
    async done(id) { entries.delete(id); },
    async list() { return [...entries.values()].map((e) => structuredClone(e)).sort((a, b) => a.claimedAt - b.claimedAt); },
  };
}

// The queue as the database keeps it, for one worker: rows with a state and a lease, the 15-minute sweep.
export function memoryQueue(rows: (CloudJob & { state: string; claimed_at: string; recorded?: any })[], o: { resumeB64: string; resumeSha: string }) {
  const log: string[] = [];
  const row = (j: CloudJob) => rows.find((x) => x.id === j.id && x.lease_token === j.lease_token);
  const q: CloudQueue = {
    claim: async (n) => {
      const out = rows.filter((x) => x.state === "queued").slice(0, n);
      for (const x of out) { x.state = "driving"; x.lease_token = crypto.randomUUID(); x.claimed_at = new Date().toISOString(); }
      return out.map((x) => structuredClone({ id: x.id, lease_token: x.lease_token, user_id: x.user_id, company: x.company, url: x.url, payload: x.payload, payload_hash: x.payload_hash, approval_hash: x.approval_hash, job_id: x.job_id, claimed_at: x.claimed_at }) as CloudJob);
    },
    gatePresent: async () => true,
    authorize: async (j) => { const x = row(j); if (!x || x.state !== "driving") throw Error("invalid apply claim"); },
    resume: async () => ({ filename: "resume.pdf", sha256: o.resumeSha, b64: o.resumeB64 }),
    finish: async (j, state, evidence) => {
      const x = row(j);
      if (!x) throw Object.assign(Error("invalid apply claim"), { body: "invalid apply claim" });
      if (x.state !== "driving") throw Object.assign(Error("invalid apply transition"), { body: "invalid apply transition" });
      x.state = state === "confirmed" ? "submitted_unconfirmed" : state; x.recorded = evidence; log.push(`finish ${j.id} ${state}`);
    },
    ask: async (_j, qs) => qs.length,
    putBack: async (j) => {
      const x = row(j);
      if (!x || x.state !== "driving") throw Object.assign(Error("invalid apply transition"), { body: "invalid apply transition" });
      x.state = "queued"; x.lease_token = null as unknown as string; log.push(`putBack ${j.id}`);
      return Date.now();
    },
  };
  return { q, log };
}

export async function runRestart(s: Extract<Scenario, { family: "restart" }>, tmpRoot: string): Promise<string[]> {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} restart ${s.crash}/${s.board}/${s.age}${s.swept ? "/swept" : ""}: ${m}`);
  const resumeSha = await sha(RESUME_BYTES);
  const job = await approvedJob(s.n);
  const others = await Promise.all(Array.from({ length: s.others }, (_, i) => approvedJob(s.n * 10 + i + 1)));
  const claimedAt = Date.now() - (s.age === "late" ? 20 * 60_000 : 5_000);
  const rows = [{ ...structuredClone(job), state: "driving", claimed_at: new Date(claimedAt).toISOString() },
    ...others.map((o) => ({ ...structuredClone(o), state: "queued", claimed_at: "" }))];
  const b = board();
  // What the first run did before it died (the board's side and the journal's).
  const journal = memoryJournal<CloudJob>();
  const accepted = ["confirmed", "unconfirmed"].includes(s.board);
  const answer: JournalResult = s.board === "confirmed" ? { state: "confirmed", reason: "", outcome: "submitted", errorKind: null, evidence: { confirmation_id: `TEST-C-${s.n}`, by: "cloud" } }
    : s.board === "unconfirmed" ? { state: "submitted_unconfirmed", reason: "", outcome: "submitted", errorKind: null, evidence: { by: "cloud" } }
    : s.board === "captcha_open" ? { state: "needs_user", reason: "bot_check", outcome: "bot_check", errorKind: "captcha", evidence: { reason: "bot_check", by: "cloud" } }
    : { state: "failed", reason: "FORM_DID_NOT_SETTLE", outcome: "error", errorKind: "FORM_DID_NOT_SETTLE", evidence: { reason: "FORM_DID_NOT_SETTLE", by: "cloud" } };
  const jobClaimed = { ...structuredClone(job), claimed_at: rows[0].claimed_at } as CloudJob;
  await journal.put(jobClaimed, claimedAt);
  const reachedBoard = ["board_answered", "answer_journaled", "recorded"].includes(s.crash);
  if (s.crash !== "claimed") await journal.start(job.id);
  if (reachedBoard && (accepted || s.board === "error_page_200")) b.post(job, accepted, resumeSha, job.approval_hash);
  if (s.crash === "answer_journaled" || s.crash === "recorded") await journal.result(job.id, answer);
  if (s.crash === "recorded") { rows[0].state = answer.state === "confirmed" ? "submitted_unconfirmed" : answer.state; rows[0].recorded = answer.evidence; }
  // The database's sweep, if the lease ran out while the worker was down.
  if (s.swept && rows[0].state === "driving" && s.age === "late") rows[0].state = "unknown_outcome";
  const { q } = memoryQueue(rows, { resumeB64: b64(RESUME_BYTES), resumeSha });
  let engineRuns = 0, oldLease = 0;
  const ran = new Map<string, number>();
  const runEngine = async (args: string[], _e: unknown, controls?: { beforeEffect?: () => Promise<void> }) => {
    engineRuns++;
    const url = args[args.indexOf("--url") + 1];
    const id = rows.find((x) => x.url === url)!.id;
    ran.set(id, (ran.get(id) ?? 0) + 1);
    if (id === job.id && rows.find((x) => x.id === id)!.lease_token === job.lease_token) oldLease++;
    await controls!.beforeEffect!();
    const target = rows.find((x) => x.id === id)!;
    b.post(target as CloudJob, true, resumeSha, target.approval_hash);
    return { result: { state: "confirmed", confirmation_id: `TEST-R-${id.slice(0, 6)}` }, evidence: {} };
  };
  await cloudLoop({ queue: q, runEngine: runEngine as any, stop: () => false, contexts: 2, journal, drain: true, idleMs: 1, sleep: async () => {}, tmpRoot, log: () => {} });
  const posting = String(job.payload.job_id), r0 = rows[0];
  if (b.accepted(posting) > 1 || b.posts(posting) > 1) fail(`the board received the application ${b.posts(posting)} times`);
  for (const o of others) if (b.accepted(String(o.payload.job_id)) !== 1) fail(`another approved application was sent ${b.accepted(String(o.payload.job_id))} times`);
  if (s.crash !== "claimed" && ran.get(job.id)) fail("an application whose engine had started was driven again");
  if (b.accepted(posting) && !MAYBE_SENT.has(r0.state)) fail(`the board took it but the record says ${r0.state}`);
  if (SENT.has(r0.state) && !b.accepted(posting)) fail(`recorded ${r0.state} but the board took nothing`);
  if (s.crash === "answer_journaled" && !(s.swept && s.age === "late")) {
    const want = answer.state === "confirmed" ? "submitted_unconfirmed" : answer.state;
    if (r0.state !== want) fail(`the employer's journaled answer (${answer.state}) was not recorded: ${r0.state}`);
    if (!r0.recorded?.recovered_from_journal) fail("the recovered record does not say it came from the journal");
  }
  if (s.crash === "started" && !(s.swept && s.age === "late") && r0.state !== "unknown_outcome") fail(`a run that died while the engine ran ended ${r0.state}`);
  if (s.crash === "claimed" && s.age === "fresh" && !s.swept && b.accepted(posting) !== 1) fail("a claim that never started was not run once");
  // Past its lease budget: never started under that lease; put back, it may run once under a new claim.
  if (s.crash === "claimed" && s.age === "late" && oldLease) fail("a claim past its lease budget was started late, under its old lease");
  if (s.crash === "claimed" && s.age === "late" && !s.swept && b.accepted(posting) !== 1) fail("a claim put back for its lapsed budget was not run once later");
  if (journal.entries.size) fail(`the journal kept ${journal.entries.size} line(s) after everything was recorded`);
  for (const x of rows) {
    if (x.state === "driving") fail("a row was left driving");
    const text = statusLine({ id: x.id, company: x.company, state: x.state, reason: x.recorded?.reason ?? null, created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z" });
    if (!readableReason(text)) fail(`the person reads a code: ${text}`);
  }
  for await (const _ of Deno.readDir(tmpRoot)) { fail("the private folder was left behind"); break; }
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: mail
const COMPANIES = [{ name: "Stripe", url: "https://job-boards.greenhouse.io/stripe/jobs/1", from: "Stripe <no-reply@us.greenhouse-mail.io>" },
  { name: "Plaid", url: "https://jobs.lever.co/plaid/2", from: "Plaid <no-reply@hire.lever.co>" },
  { name: "Ramp", url: "https://jobs.ashbyhq.com/ramp/3", from: "Ramp <no-reply@ashbyhq.com>" }];
const TITLES = ["Data Analyst", "Software Engineer, Payments"];
const authFor = (from: string) => {
  const d = parseFrom(from).domain;
  return [`mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=AbC; spf=pass (google.com: domain of bounce@${d} designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@${d}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${d}`];
};
export function runMail(s: Extract<Scenario, { family: "mail" }>): string[] {
  const bad: string[] = [], fail = (m: string) => bad.push(`#${s.n} mail: ${m}`);
  const NOW = Date.parse("2026-10-31T15:00:00Z"), H = 3_600_000;
  const rows: QueueRow[] = s.rows.map((r, i) => ({ id: `J${i}`, company: COMPANIES[r.company].name, title: TITLES[r.title], url: COMPANIES[r.company].url, state: r.state,
    submitted_at: new Date(NOW - r.ageH * H).toISOString(), confirmation_hash: r.hashed || r.state === "confirmed" ? `${i}`.repeat(64).slice(0, 64) : null }));
  const mails: MailIn[] = s.mails.map((m, i) => {
    const c = COMPANIES[m.company];
    return { hash: String.fromCharCode(97 + i).repeat(64), date: new Date(NOW + m.atH * H).toISOString(), from: c.from,
      subject: m.kind === "received" ? `Thank you for applying to ${c.name}` : `Your application to ${c.name}`,
      snippet: m.kind === "received" ? `We have received your application for the ${TITLES[m.title]} role and will review it shortly.`
        : `Thank you for your interest in the ${TITLES[m.title]} role. Unfortunately we have decided to move forward with other candidates.`, auth: authFor(c.from) };
  });
  const plan = planConfirmations(mails, rows);
  const confirmedRows = new Map<string, number>();
  for (const p of plan) {
    if (p.kind !== "confirm") continue;
    const r = rows.find((x) => x.id === p.id)!;
    confirmedRows.set(r.id, (confirmedRows.get(r.id) ?? 0) + 1);
    if (!["submitted_unconfirmed", "unknown_outcome", "confirmed", "driving"].includes(r.state)) fail(`confirmed a ${r.state} application`);
    if (r.confirmation_hash && s.rows[Number(r.id.slice(1))].hashed) fail("confirmed an application another email confirmed");
    const m = mails.find((x) => x.hash === p.hash)!;
    if (Date.parse(m.date) < Date.parse(r.submitted_at)) fail("confirmed by an email sent before the application");
    if (Date.parse(m.date) - Date.parse(r.submitted_at) > 14 * 24 * H) fail("confirmed by an email more than 14 days later");
    if (r.company !== COMPANIES[s.mails[mails.indexOf(m)].company].name) fail("confirmed by another employer's email");
  }
  for (const [id, k] of confirmedRows) if (k > 1) fail(`application ${id} confirmed by ${k} emails`);
  if (new Set(plan.map((p) => p.hash)).size !== plan.length) fail("one email used twice");
  // The new rule: an application still recorded as being driven, which is the only open application an email of its
  // employer fits (after the claim, inside 14 days, the same role), is confirmed by one of those emails, never dropped.
  const OPEN = ["submitted_unconfirmed", "unknown_outcome", "confirmed", "driving"];
  const fit = (r: QueueRow, i: number) => r.company === COMPANIES[s.mails[i].company].name && OPEN.includes(r.state) && !r.confirmation_hash &&
    Date.parse(r.submitted_at) <= Date.parse(mails[i].date) && Date.parse(mails[i].date) - Date.parse(r.submitted_at) <= 14 * 24 * H && r.title === TITLES[s.mails[i].title];
  for (const r of rows.filter((x) => x.state === "driving" && !x.confirmation_hash)) {
    const its = mails.map((_, i) => i).filter((i) => fit(r, i));
    if (its.length && its.every((i) => rows.filter((x) => fit(x, i)).length === 1) &&
      !plan.some((p) => p.kind === "confirm" ? p.id === r.id : p.ids.includes(r.id))) fail("the employer's email for an application still recorded as being driven was dropped");
  }
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: words
export function runWords(s: Extract<Scenario, { family: "words" }>): string[] {
  const text = statusLine({ id: "J", company: s.company, state: s.state, reason: s.reason, created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z" });
  const bad: string[] = [];
  if (!readableReason(text)) bad.push(`#${s.n} words ${s.state}/${s.reason}: the person reads a code: ${text}`);
  if (/not sent \(not sent/i.test(text)) bad.push(`#${s.n} words: "not sent" twice: ${text}`);
  if (["failed", "not_submitted"].includes(s.state) && /\bsubmitted\b(?! yet)/.test(text.replace(/not sent/, ""))) bad.push(`#${s.n} words: an unsent one reads as submitted: ${text}`);
  return bad;
}

// ------------------------------------------------------------------------------------------------ family: backoff
export function runBackoff(s: Extract<Scenario, { family: "backoff" }>): string[] {
  const bad: string[] = [], now = Date.parse("2026-10-21T07:00:00Z");
  const ra = retryAfterSeconds(s.retryAfter, now);
  if (ra !== null && (!Number.isInteger(ra) || ra < 0 || ra > RETRY_AFTER_MAX_S)) bad.push(`#${s.n} backoff: Retry-After ${s.retryAfter} read as ${ra}`);
  if (s.retryAfter !== null && /^\d+$/.test(s.retryAfter.trim()) && ra !== Math.min(Number(s.retryAfter), RETRY_AFTER_MAX_S)) bad.push(`#${s.n} backoff: delay-seconds ${s.retryAfter} read as ${ra}`);
  if (s.retryAfter && !/^\d+$/.test(s.retryAfter) && !/GMT$|\d{4}$/.test(s.retryAfter) && ra !== null) bad.push(`#${s.n} backoff: ${s.retryAfter} read as a wait`);
  // A host that keeps refusing: each wait at least the last (to the ceiling), never more than a day, never negative.
  let last = 0, t = now;
  for (let i = 0; i < s.refusals; i++) {
    const w = backoffMs(s.level + i, ra);
    if (!(w >= 0) || w > 86_400_000) bad.push(`#${s.n} backoff: wait ${w}`);
    if (ra === null && w < last) bad.push(`#${s.n} backoff: refusal ${i} waits less than the one before`);
    if (ra === null && w > BACKOFF_CEIL_MS) bad.push(`#${s.n} backoff: above the hour ceiling`);
    last = w; t += w;
  }
  if (t < now) bad.push(`#${s.n} backoff: time went backwards`);
  return bad;
}

export async function runScenario(s: Scenario, tmpRoot: string): Promise<string[]> {
  switch (s.family) {
    case "drive": return await runDrive(s, tmpRoot);
    case "restart": return await runRestart(s, tmpRoot);
    case "mail": return runMail(s);
    case "words": return runWords(s);
    case "backoff": return runBackoff(s);
  }
}

// Part `part` of `parts` (by scenario number), with a tally per family.
export async function runPart(part: number, parts: number) {
  const all = generate().filter((s) => s.n % parts === part);
  const tmpRoot = await Deno.makeTempDir({ prefix: "submit-worker-battery-" });
  const bad: string[] = [], tally: Record<string, number> = {};
  try {
    for (const s of all) {
      const d = `${tmpRoot}/${s.n}`;
      await Deno.mkdir(d);
      bad.push(...await runScenario(s, d));
      await Deno.remove(d, { recursive: true }).catch(() => {});
      tally[s.family] = (tally[s.family] ?? 0) + 1;
    }
  } finally {
    await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
  }
  return { ran: all.length, tally, bad };
}
