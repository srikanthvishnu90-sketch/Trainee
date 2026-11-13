// WO-039: the cloud worker (D-010: the owner's VM, holding only this worker and its service key; D-017: the fallback
// to the person's own computer; D-022: unlocked in code only by the gate in the database).
//
// A long-running Deno process. It claims approved applications for anyone who turned the cloud on, through one door:
// career_apply_cloud_claim (20261021080000_career_apply_cloud.sql), which refuses every job whose portal family has not
// passed the gate (3 hand submissions confirmed by the employer's email), whose person has not said yes in chat, whose
// portal or person is paused, or that is over the person's daily limit or a second one to the same company in 30 days.
//
// Each claimed job runs the same engine as the person's own computer (scripts/apply.ts --submit --approved <hash>),
// headless, in its own process, so its own browser and its own fresh context: cookies and storage never cross people.
// The answers are rebuilt from the approved payload alone (approve-first's factsFromPayload) and, with the approved
// resume fetched for this job only, written to a private temp folder (0700, files 0600) that is removed in finally,
// whatever happens. The engine submits only if the application is still exactly the approved one.
//
// A verification check (a captcha) at open, review or Submit is never solved or got around: the job goes back to the
// person with its link ("finish this one yourself"), and the check counts in the telemetry, which pauses a portal or a
// person before failures pile up under their name.
import { approvedQuestionsAfterRefusal, assertApprovedPayload, factsFromPayload, type RunEngine } from "../career-browser/approve-first.ts";
import { questionsToStore } from "../career-browser/ask-once.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { authorizeCurrentCloudJob } from "./current_sources.ts";
import { dbHostGate, fileJournal, handBack, type HostGate, type Journal, type JournalResult, massRun, type Pacing, pacingFrom, requeueMissing, sentNothingRefusal, unstartedWhy } from "../career-browser/mass-run.ts";

// The resume file gate (career_tailor.ts), loaded when first used: the email the approved application sends is the one compared.
// deno-lint-ignore no-explicit-any
const fileGate = async (bytes: Uint8Array, payload: any): Promise<string[]> => {
  const g = await import("../../supabase/functions/_shared/career_tailor.ts");
  return g.resumeFileContactProblems(bytes, { confirmed: g.approvedEmails(payload) });
};
export interface CloudJob {
  id: string;
  lease_token: string;
  user_id: string;
  company: string;
  url: string;
  payload: any;
  payload_hash: string;
  approval_hash: string;
  job_id?: string;
  approval_id?: string;
  card_id?: string;
  card_hash?: string;
  execution_mode?: string;
}
export interface CloudResume { filename: string; sha256: string; b64: string }
export interface CloudQueue {
  claim(limit: number): Promise<CloudJob[]>;
  authorize(job: CloudJob, phase: "before_engine" | "before_effect"): Promise<void>;
  resume(job: CloudJob): Promise<CloudResume | null>;
  finish(job: CloudJob, state: string, evidence: Record<string, unknown>, outcome: Outcome, errorKind: string | null): Promise<unknown>;
  // Ask, never guess: the questions a required field with no confirmed fact raised, as the person's open questions (the
  // rows Messages asks), for the job this worker holds the lease on (career_apply_cloud_ask). Returns how many were kept.
  ask(job: CloudJob, questions: Record<string, unknown>[]): Promise<number>;
  gatePresent(): Promise<boolean>;
  // Many instances (the database lane's leased claim, docs/launch/CLOUD-RUNNER.md "Many instances"): a claim that only
  // leases, and the begin that turns the leases this round starts into drives. Absent: the claim starts drives itself.
  begin?(jobs: CloudJob[]): Promise<Set<string>>;
  // Owner rule (2026-10-27, back off then RESUME): the employer's site refused before anything was sent; the same job
  // goes back to the queue, not handed out before `until` (career_apply_requeue_refused_for, 20261029180000). Returns
  // when it may be handed out again (epoch ms), or null when the database does not have the requeue yet. Absent: the
  // job is recorded not_submitted as before.
  requeue?(job: CloudJob, reason: string, retryAfterS: number | null, until: number): Promise<number | null>;
  // A claim whose engine never started (the worker stopping, no start inside its lease budget, its host held): the same
  // job back to the queue, not handed out before `until` (career_apply_requeue_unstarted_for, 20261029190000). Returns
  // when it may be handed out again (epoch ms), or null when it cannot be put back (a database without it, or one that
  // refuses it, e.g. a card approval that expired since): then it is recorded not sent. Absent: recorded not sent.
  putBack?(job: CloudJob, why: string, until: number): Promise<number | null>;
}
// "interrupted": the worker was stopped on purpose (systemctl stop, Ctrl+C) while the engine ran. The application is
// unknown and never re-driven, but a deliberate shutdown is not a failure the employer saw, so the throttle skips it.
export type Outcome = "submitted" | "bot_check" | "error" | "not_sent" | "interrupted";

const OUTCOMES = new Set(["confirmed", "submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"]);
// Stopped before anything left the browser, by design (a changed application, a question the person never answered, a
// form that asks for what Trainee never fills): not sent, and not a failure the employer saw.
const BY_DESIGN = new Set([
  "APPROVED_APPLICATION_CHANGED", "APPROVED_BODY_MISMATCH", "needs_answers", "IDENTITY_NUMBER_REQUESTED", "ACCOUNT_LOGIN_REQUIRED",
  "RESUME_CHANGED", "RESUME_NOT_IN_CLOUD", "NO_ENGINE_APPROVAL", "CONFLICTING_APPROVED_ANSWERS", "FACTS_EXPIRED", "ACCOUNT_PAUSED",
  "FACTS_ERASED", "duplicate_job", "daily_cap", "company_cooldown", "UNCONFIRMED_HIDDEN_FIELD", "UNSUPPORTED_FILE_ARTIFACT",
  "SUBMIT_DESTINATION_NOT_BOUND", "SUBMIT_DESTINATION_UNEXPECTED", "SCRIPT_SUBMIT_FAMILY_MISMATCH", "PERSON_SUBMITS_NEEDS_HEADED", "HANDOFF_NEEDS_HEADED",
  "APPROVED_MANIFEST_CHANGED", "INVALID_APPROVED_SCHEMA", "CONTRACT_REFUSED", "FACT_OWNER_MISMATCH",
  "CARD_CLOUD_PERMISSION_REVOKED", "CARD_CLOUD_AUTH_REQUIRED", "CARD_CLOUD_AUTH_REFUSED", "CARD_CLOUD_AUTH_PROTOCOL", "CARD_CLOUD_AUTH_TIMEOUT",
  "APPROVED_SOURCE_WITHDRAWN", "CARD_CLOUD_SOURCE_READ_FAILED", "CARD_CLOUD_AUTHORIZATION_REFUSED",
  // MASS APPLY (2026-11-01): the posting closed after the approval (its page 404/410 at the open, nothing filled): that one
  // posting ends, nothing sent; it is no failure of the site, so it never counts toward pausing the ATS.
  "POSTING_CLOSED",
  // fix/r9-apply-completion: an approved payload that cannot be hashed again (career_apply_store.ts hashApplyPayload) is
  // refused before anything is filled or sent. It is this one application's own fault, never the site's: counted as an error
  // it paused Greenhouse for every person for 6 hours (2 of the last 50 attempts) in the 1,000-task eval.
  "INVALID_APPLY_PAYLOAD",
]);
const BOT_CHECK = (state: string, reason: string) =>
  (state === "needs_user" && reason === "captcha") || (state === "not_submitted" && reason === "CAPTCHA_AT_SUBMIT");

// What the queue records for one engine result: the final state, its reason, and the telemetry outcome. A bot check is
// always handed back as needs_user (the person finishes it at the link) and never as sent.
export function settle(result: { state?: string; reason?: string } | null): { state: string; reason: string; outcome: Outcome; errorKind: string | null } {
  const state = String(result?.state ?? ""), reason = String(result?.reason ?? "").split(":")[0].slice(0, 80);
  if (!result || !OUTCOMES.has(state)) {
    return { state: "unknown_outcome", reason: "the engine gave no result after it started; not retried", outcome: "error", errorKind: "ENGINE_NO_RESULT" };
  }
  if (BOT_CHECK(state, reason)) return { state: "needs_user", reason: "bot_check", outcome: "bot_check", errorKind: reason };
  // The employer's sign-in wall: the person signs in and finishes it at the link (never retried; not a failure the employer saw).
  if (handBack({ state, reason }) === "login_required") return { state: "needs_user", reason: "login_required", outcome: "not_sent", errorKind: reason };
  if (state === "confirmed" || state === "submitted_unconfirmed") return { state, reason, outcome: "submitted", errorKind: null };
  if (state === "not_submitted" && BY_DESIGN.has(reason)) return { state, reason, outcome: "not_sent", errorKind: reason };
  return { state, reason, outcome: "error", errorKind: reason || state };
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((n) => n.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", b as BufferSource));
const b64bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);

// What the queue keeps for one cloud application: the answers sent (from the approved payload, which the engine read
// back field by field before it clicked), the employer's response, the screenshots by path and hash (masked; they stay
// on the VM), and the time. Kept under the queue's 64 KB evidence limit.
export async function evidenceOf(job: CloudJob, run: any, s: ReturnType<typeof settle>, t: { started: number; finished: number }) {
  const ev = run?.evidence ?? {}, dir = run?.result?.evidence_path ?? null;
  const shots: Record<string, string> = {};
  for (const name of ["before-review.png", "after-submit.png"]) {
    if (!dir) break;
    try {
      shots[name] = await sha256(await Deno.readFile(`${dir}/${name}`));
    } catch { /* not taken: the run stopped before it */ }
  }
  const answers = (Array.isArray(job.payload?.fields) ? job.payload.fields : [])
    .filter((f: any) => !(f?.value && typeof f.value === "object"))
    .map((f: any) => ({ label: clip(f.label, 300), value: clip(f.value, 2000), fact: clip(f.factId, 200) }));
  const why = new Map((Array.isArray(run?.result?.contract) ? run.result.contract : []).map((c: any) => [c?.label, clip(c?.why, 200)]));
  const questions = (Array.isArray(run?.result?.questions) ? run.result.questions : []).slice(0, 40).map((q: any) => ({
    label: clip(q?.label, 300), type: clip(q?.type, 40), options: (Array.isArray(q?.options) ? q.options : []).slice(0, 60).map((o: unknown) => clip(o, 200)),
    ...(why.get(q?.label) ? { why: why.get(q?.label) } : {}),
  }));
  const out: Record<string, unknown> = {
    reason: s.reason || null,
    confirmation_id: run?.result?.confirmation_id ?? null,
    by: "cloud",
    answers,
    resume_sha256: job.payload?.resume_sha256 ?? null,
    response: ev.post || ev.observation
      ? { status: ev.post?.status ?? null, destination: ev.post?.destination ?? null, final_url: clip(ev.observation?.url_after, 500) || null,
        page_text: clip(ev.observation?.page_text, 600) || null }
      : null,
    screenshots: { dir, sha256: shots },
    started_at: new Date(t.started).toISOString(),
    finished_at: new Date(t.finished).toISOString(),
    ...(s.outcome === "bot_check" ? { link: job.url, handed_back: "a verification check appeared; the person finishes it at the link" } : {}),
    ...(s.reason === "login_required" ? { link: job.url, handed_back: "the employer's site asks the person to sign in; they finish it at the link" } : {}),
    // WO-102: a question the engine stopped on (needs_answers) goes back with the job in the form's own terms, so it is
    // asked of the person rather than lost. Never an answer.
    ...(s.reason === "needs_answers" ? { questions } : {}),
    // MASS APPLY: the browser's own failure (scripts/apply.ts driver_error), kept so a DRIVER_ERROR's cause can be found.
    ...(typeof run?.result?.driver_error === "string" ? { driver_error: clip(run.result.driver_error, 200) } : {}),
  };
  if (JSON.stringify(out).length > 60000) out.answers = answers.map((a: any) => ({ ...a, value: a.value.slice(0, 200) }));
  if (JSON.stringify(out).length > 60000 && out.questions) out.questions = questions.map((q: any) => ({ ...q, options: [] }));
  return out;
}

// One claimed job, start to finish. The engine runs at most once per claim; whatever happens, the facts and resume
// written for it are removed before this returns, and the outcome goes back with the lease.
export async function runCloudJob(job: CloudJob, d: {
  queue: CloudQueue;
  runEngine: RunEngine;
  tmpRoot?: string;
  now?: () => number;
  log?: (line: string) => void;
  stopping?: () => boolean;
  // Mass submission: awaited right before the engine starts (the scheduler's durable journal line). If it throws, the
  // engine never starts and the job is recorded not_submitted: nothing was sent.
  beforeEngine?: () => Promise<void>;
  // The scheduler puts back a job whose site refused before anything was sent (mass-run.ts sentNothingRefusal): such a
  // run is returned with requeue: true and not finished here.
  requeueRefusal?: boolean;
  // Submit worker round (2026-10-31): the engine's answer, awaited before the queue records it (the scheduler's journal),
  // so a worker that dies between the two records that answer on its next start instead of "unknown".
  beforeFinish?: (r: JournalResult) => Promise<void>;
}) {
  // Capture the claimed job and lease before asynchronous work; the child never selects its authority.
  job = structuredClone(job);
  const now = d.now ?? Date.now, log = d.log ?? ((l: string) => console.log(l)), started = now();
  let s: ReturnType<typeof settle> = { state: "not_submitted", reason: "DRIVER_ERROR", outcome: "error", errorKind: "DRIVER_ERROR" };
  let run: any = null, began = false, putBack = false;
  const dir = await Deno.makeTempDir({ dir: d.tmpRoot, prefix: "trainee-cloud-" });
  try {
    await Deno.chmod(dir, 0o700);
    const p = job.payload;
    await assertApprovedPayload(p, { url: job.url, user_id: job.user_id });
    const authorize = async (phase: "before_engine" | "before_effect") => {
      const hash = await hashApplyPayload(p);
      if (!/^[0-9a-f]{64}$/.test(job.payload_hash || "") || hash !== job.payload_hash || hash !== job.approval_hash ||
        p.company !== job.company || p.url !== job.url || p.user_id !== job.user_id ||
        (job.job_id !== undefined && p.job_id !== job.job_id)) throw Error("APPROVED_APPLICATION_CHANGED");
      if (typeof d.queue.authorize !== "function") throw Error("CARD_CLOUD_AUTH_REQUIRED");
      await d.queue.authorize(job, phase);
    };
    await authorize("before_engine");
    // OWNER RULE (2026-10-26, "never submit applications without a real resume"): no resume bound, no run.
    if (!/^[a-f0-9]{64}$/.test(String(p?.resume_sha256 ?? ""))) throw Object.assign(Error("NO_RESUME"), { code: "NO_RESUME" });
    const r = await d.queue.resume(job);
    if (!r) throw Object.assign(Error("RESUME_NOT_IN_CLOUD"), { code: "RESUME_NOT_IN_CLOUD" });
    const bytes = b64bytes(r.b64);
    if ((await sha256(bytes)) !== p.resume_sha256 || r.sha256 !== p.resume_sha256) throw Object.assign(Error("RESUME_CHANGED"), { code: "RESUME_CHANGED" });
    // The submit gate: a resume whose own text shows a placeholder email or phone at its top is never sent.
    // The file gate (career_tailor.ts): only a contact read with confidence is refused, against the email this application sends.
    if ((await fileGate(bytes, p)).length) throw Object.assign(Error("RESUME_CONTACT_UNCONFIRMED"), { code: "RESUME_CONTACT_UNCONFIRMED" });
    const name = /^[^/\\.][^/\\]{0,199}$/.test(r.filename) ? r.filename : "resume.pdf";
    // The resume in its own folder, so no file name it may have (facts.json) can stand in for the facts.
    await Deno.mkdir(`${dir}/resume`, { mode: 0o700 });
    const resumePath = `${dir}/resume/${name}`, factsPath = `${dir}/facts.json`;
    await Deno.writeFile(resumePath, bytes, { mode: 0o600 });
    await Deno.writeTextFile(factsPath, JSON.stringify(factsFromPayload(p)), { mode: 0o600 });
    await authorize("before_engine");
    if (d.beforeEngine) await d.beforeEngine();
    let effectRequested = false, effectAuthorized = false;
    began = true;
    const drive = () => d.runEngine(["--url", job.url, "--facts", factsPath, "--resume", resumePath, "--submit", "--approved", p.engine_approval], undefined, {
      beforeEffect: async () => {
        if (effectRequested) throw Error("CARD_CLOUD_AUTH_PROTOCOL");
        effectRequested = true;
        await authorize("before_effect");
        effectAuthorized = true;
      },
    });
    run = await drive();
    // MASS APPLY (2026-11-01): the engine's browser itself failed (DRIVER_ERROR: a crash or a timeout under load, not the
    // employer's page). Driven once more, under the same lease, ONLY when the run provably never reached Submit: the
    // Submit authorization (beforeEffect, asked right before the one click) was never requested, and the engine says
    // nothing left the browser (not_submitted). Its own exactly-once store refuses a resend of anything it recorded as
    // sent. Authorized again before the second run. Reached Submit and then failed: recorded unknown, never resent.
    const crashed = () => run?.result?.state === "not_submitted" && run?.result?.reason === "DRIVER_ERROR";
    if (crashed() && !effectRequested) {
      log(`${job.id}: the browser failed before Submit (DRIVER_ERROR); driven once more`);
      await authorize("before_engine");
      run = await drive();
    }
    // Whichever run was last: once ANY run reached Submit (the authorization was asked), a crash is never "not sent".
    if (crashed() && effectRequested) run = { ...run, result: { ...run.result, state: "unknown_outcome", reason: "DRIVER_ERROR_AT_SUBMIT" } };
    if (["confirmed", "submitted_unconfirmed"].includes(run?.result?.state || "") && !effectAuthorized) throw Error("CARD_CLOUD_AUTH_REQUIRED");
    // Refused at the page's open, before anything was filled, and no effect was ever asked for: nothing was sent.
    putBack = !!d.requeueRefusal && !effectRequested && sentNothingRefusal(run?.result) !== null;
    s = settle(run?.result ?? null);
    if (s.state === "unknown_outcome" && d.stopping?.()) s = { ...s, outcome: "interrupted", errorKind: "WORKER_STOPPED" };
  } catch (e: any) {
    // Before the engine started nothing could have been sent; after it started, nothing is known.
    const code = String(e?.code || e?.message || e).split(":")[0].slice(0, 80);
    const recovered = !began && ["CONTRACT_REFUSED", "APPROVED_APPLICATION_CHANGED"].includes(code)
      ? await approvedQuestionsAfterRefusal(job.payload, { url: job.url, user_id: job.user_id }) : null;
    if (recovered) { run = { result: recovered, evidence: null }; s = settle(recovered); }
    else s = began
      ? { state: "unknown_outcome", reason: "the run stopped after the engine started; not retried",
        outcome: d.stopping?.() ? "interrupted" : "error", errorKind: d.stopping?.() ? "WORKER_STOPPED" : code }
      : settle({ state: "not_submitted", reason: code });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  if (putBack) {
    log(`${job.id}: the employer's site refused before anything was sent (HOST_RATE_LIMITED); it goes back to the queue`);
    return { id: job.id, user_id: job.user_id, state: "refused", reason: "HOST_RATE_LIMITED", outcome: "not_sent" as Outcome, errorKind: "HOST_RATE_LIMITED",
      recorded: false, requeue: true, status: typeof run?.result?.status === "number" ? run.result.status as number : null,
      ...(typeof run?.result?.retry_after_s === "number" ? { retry_after_s: run.result.retry_after_s as number } : {}) };
  }
  const evidence: Record<string, unknown> = await evidenceOf(job, run, s, { started, finished: now() });
  // Ask, never guess: a stop on required fields with no confirmed fact (needs_answers) puts each one to the person as an
  // open question, keyed as the person's computer keys it (ask-once.ts), while the lease is still held, before finish.
  // An identity or bank number is never asked by text (NEVER_BY_TEXT); the person types it on the form.
  if (s.reason === "needs_answers") {
    const result = { ...(run?.result ?? {}), posting: run?.result?.posting || job.payload?.posting || job.payload?.job_id || job.url, company: run?.result?.company || job.company };
    const { questions } = questionsToStore(result, { facts: {}, answered: new Set() });
    evidence.asked = 0;
    try {
      if (questions.length) evidence.asked = await d.queue.ask(job, questions);
    } catch (e: any) {
      evidence.ask_error = String(e?.message ?? e).slice(0, 200);
    }
    if ((Array.isArray(result.questions) ? result.questions.length : 0) > questions.length) evidence.not_asked_by_text = "typed on the form (an identity or bank number), never by text";
  }
  if (began && d.beforeFinish) {
    try { await d.beforeFinish({ state: s.state, reason: s.reason, outcome: s.outcome, errorKind: s.errorKind, evidence }); }
    catch { /* the journal could not keep it: the record below is still made */ }
  }
  let recorded = false;
  for (let i = 0; i < 4 && !recorded; i++) {
    try {
      await d.queue.finish(job, s.state, evidence, s.outcome, s.errorKind);
      recorded = true;
    } catch {
      if (i < 3) await new Promise((res) => setTimeout(res, 50 * 2 ** i));
    }
  }
  log(`${job.id}: ${s.state} (${s.outcome}${s.errorKind ? ", " + s.errorKind : ""})${recorded ? "" : "; NOT RECORDED: the queue marks it unknown after 15 minutes"}`);
  // The seconds a host that refused for load asked for (HOST_RATE_LIMITED), for the shared back-off (mass-run.ts refusal).
  const retry = typeof run?.result?.retry_after_s === "number" ? { retry_after_s: run.result.retry_after_s as number } : {};
  return { id: job.id, user_id: job.user_id, ...s, recorded, ...retry };
}

// The loop (owner D-MS-2, 2026-10-27: no product volume cap, safety pacing only): claims approved applications in
// batches (MASS_SUBMIT_CLAIM_BATCH) and runs up to `concurrency` at once (MASS_SUBMIT_CONCURRENCY, or CLOUD_CONTEXTS as
// before), one engine process and so one browser context per job, each employer host paced (MASS_SUBMIT_HOST_MAX at once,
// MASS_SUBMIT_HOST_SPACING_MS between starts, widened after a verification check; mass-run.ts). A queue that cannot be
// read waits and asks again. stop() ends claiming; the applications in flight finish and are recorded, and any claimed
// but not started goes back to the queue, the same job, to run later once (queue.putBack, 20261029190000; nothing was
// sent; a database without it records it not_submitted). With a journal (CLOUD_JOURNAL_DIR) a worker that died leaves
// each started job recorded unknown_outcome on its next start (never re-driven) and each claimed-but-unstarted one run
// under its lease, or put back when its lease budget has no time left.
export async function cloudLoop(o: {
  queue: CloudQueue;
  runEngine: RunEngine;
  stop: () => boolean;
  contexts?: number;
  pacing?: Partial<Pacing>;
  journal?: Journal<CloudJob>;
  // The hosts' refusals shared by every instance (mass-run.ts dbHostGate); absent, this process's own.
  gate?: HostGate;
  drain?: boolean;
  idleMs?: number;
  tmpRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}) {
  const log = o.log ?? ((l: string) => console.log(l));
  // How many at once: `contexts` or the pacing's concurrency; unset, this machine's capacity (mass-run.ts machineSlots).
  const pacing = pacingFrom(() => undefined, { ...(o.contexts !== undefined ? { concurrency: Math.max(1, Math.floor(o.contexts)) } : {}), ...o.pacing });
  const done: Awaited<ReturnType<typeof runCloudJob>>[] = [];
  const finishOnce = async (job: CloudJob, state: string, reason: string, outcome: Outcome, errorKind: string) => {
    const evidence = { reason, by: "cloud" };
    for (let i = 0; i < 4; i++) {
      try {
        await o.queue.finish(job, state, evidence, outcome, errorKind);
        return true;
      } catch (e: any) {
        // A claim the database already closed (its 15-minute sweep): nothing is left to record.
        if (/invalid apply (claim|transition)/i.test(String(e?.body ?? e?.message ?? ""))) return true;
        if (i < 3) await new Promise((r) => setTimeout(r, 50 * 2 ** i));
      }
    }
    return false;
  };
  await massRun<CloudJob>({
    claim: (n) => o.queue.claim(n),
    onClaimError: (e: any) => {
      log(`The queue could not be read (${e?.message ?? e}); asking again shortly. Nothing was run.`);
      return "wait";
    },
    run: async (job, onStart, onResult) => {
      const r: any = await runCloudJob(job, { queue: o.queue, runEngine: o.runEngine, tmpRoot: o.tmpRoot, log, stopping: o.stop, beforeEngine: onStart,
        requeueRefusal: typeof o.queue.requeue === "function", beforeFinish: onResult });
      if (r.requeue) return { state: r.state, reason: r.reason, recorded: false, retry_after_s: r.retry_after_s ?? null, requeue: true, status: r.status ?? null };
      done.push(r);
      return { state: r.state, reason: r.reason, recorded: r.recorded, retry_after_s: (r as { retry_after_s?: number }).retry_after_s ?? null };
    },
    // The site refused before anything was sent: the same job back to the queue until the site allows (its approval and
    // hash kept). A database without the requeue records it not sent, as before. If it cannot be written at all, the
    // database's sweep closes the drive as unknown after 15 minutes (never driven again).
    requeue: async (job, q) => {
      for (let i = 0; i < 4; i++) {
        try {
          const nb = await o.queue.requeue!(job, q.reason, q.retryAfterS, q.until);
          if (nb === null) break;
          log(`${job.id}: queued again (nothing was sent; the employer's site asked us to wait; runs again after ${new Date(nb).toISOString()})`);
          const r = { id: job.id, user_id: job.user_id, state: "queued", reason: "HOST_RATE_LIMITED", outcome: "not_sent" as Outcome, errorKind: "HOST_RATE_LIMITED", recorded: true };
          done.push(r);
          return { state: "queued", reason: "HOST_RATE_LIMITED", recorded: true, not_before: nb };
        } catch (e: any) {
          const text = String(e?.body ?? e?.message ?? e);
          if (requeueMissing(text)) break;
          if (/invalid apply (claim|transition)/i.test(text)) return { state: "closed", reason: "HOST_RATE_LIMITED", recorded: true };
          if (i < 3) await new Promise((r) => setTimeout(r, 50 * 2 ** i));
          else return { state: "unrecorded", reason: "HOST_RATE_LIMITED", recorded: false };
        }
      }
      const recorded = await finishOnce(job, "not_submitted", "HOST_RATE_LIMITED", "not_sent", "HOST_RATE_LIMITED");
      log(`${job.id}: not_submitted (not_sent, HOST_RATE_LIMITED)${recorded ? "" : "; NOT RECORDED: the queue marks it unknown after 15 minutes"}`);
      const r = { id: job.id, user_id: job.user_id, state: "not_submitted", reason: "HOST_RATE_LIMITED", outcome: "not_sent" as Outcome, errorKind: "HOST_RATE_LIMITED", recorded };
      done.push(r);
      return r;
    },
    // Claimed and never started (the scheduler cleared its journal line first): the same job back to the queue, to run
    // later once (owner: back off, then RESUME). A database that cannot put it back records it not sent, as before.
    putBack: typeof o.queue.putBack !== "function" ? undefined : async (job, why, until) => {
      for (let i = 0; i < 4; i++) {
        try {
          const nb = await o.queue.putBack!(job, why, until);
          if (nb === null) break;
          log(`${job.id}: queued again (not started: ${why.split(":")[0]}; nothing was sent; runs later, after ${new Date(nb).toISOString()})`);
          done.push({ id: job.id, user_id: job.user_id, state: "queued", reason: why, outcome: "not_sent" as Outcome, errorKind: why.split(":")[0], recorded: true });
          return { state: "queued", reason: why, recorded: true, not_before: nb };
        } catch (e: any) {
          if (/invalid apply (claim|transition)/i.test(String(e?.body ?? e?.message ?? e))) return { state: "closed", reason: why, recorded: true };
          if (i < 3) await new Promise((r) => setTimeout(r, 50 * 2 ** i));
        }
      }
      const recorded = await finishOnce(job, "not_submitted", why, "not_sent", why);
      log(`${job.id}: not_submitted (not_sent, ${why})${recorded ? "" : "; NOT RECORDED: the queue marks it unknown after 15 minutes"}`);
      const r = { id: job.id, user_id: job.user_id, state: "not_submitted", reason: why, outcome: "not_sent" as Outcome, errorKind: why, recorded };
      done.push(r);
      return r;
    },
    unstarted: async (job, why) => {
      const recorded = await finishOnce(job, "not_submitted", why, "not_sent", why);
      log(`${job.id}: not_submitted (not_sent, ${why})${recorded ? "" : "; NOT RECORDED: the queue marks it unknown after 15 minutes"}`);
      const r = { id: job.id, user_id: job.user_id, state: "not_submitted", reason: why, outcome: "not_sent" as Outcome, errorKind: why, recorded };
      done.push(r);
      return r;
    },
    // The worker died after the engine answered and before the queue recorded it: that answer is recorded now (the board's
    // own confirmation, or its refusal), under the same lease; never driven again. A lease the database already swept is
    // left as the sweep recorded it (unknown; the employer's email can still confirm it).
    recovered: async (job, res) => {
      const state = OUTCOMES.has(res.state) ? res.state : "unknown_outcome";
      const outcome = (["submitted", "bot_check", "error", "not_sent", "interrupted"].includes(String(res.outcome)) ? res.outcome : "error") as Outcome;
      const evidence = { ...(res.evidence ?? {}), by: "cloud", recovered_from_journal: true };
      let recorded = false;
      for (let i = 0; i < 4 && !recorded; i++) {
        try {
          await o.queue.finish(job, state, evidence, outcome, res.errorKind ?? null);
          recorded = true;
        } catch (e: any) {
          if (/invalid apply (claim|transition)/i.test(String(e?.body ?? e?.message ?? ""))) { recorded = true; break; }
          if (i < 3) await new Promise((r) => setTimeout(r, 50 * 2 ** i));
        }
      }
      log(`${job.id}: ${state} (recorded from the journal: the worker stopped after the employer answered)${recorded ? "" : "; NOT RECORDED: the queue marks it unknown after 15 minutes"}`);
      const r = { id: job.id, user_id: job.user_id, state, reason: String(res.reason ?? ""), outcome, errorKind: res.errorKind ?? null, recorded };
      done.push(r as any);
      return r;
    },
    orphaned: async (job) => {
      const reason = "the worker stopped while this application ran; not retried";
      const recorded = await finishOnce(job, "unknown_outcome", reason, "interrupted", "WORKER_STOPPED");
      log(`${job.id}: unknown_outcome (interrupted, WORKER_STOPPED)${recorded ? "" : "; NOT RECORDED: the queue marks it unknown after 15 minutes"}`);
      const r = { id: job.id, user_id: job.user_id, state: "unknown_outcome", reason, outcome: "interrupted" as Outcome, errorKind: "WORKER_STOPPED", recorded };
      done.push(r);
      return r;
    },
    ...(typeof o.queue.begin === "function" ? { begin: (jobs: CloudJob[]) => o.queue.begin!(jobs) } : {}),
    pacing,
    stop: o.stop,
    journal: o.journal,
    gate: o.gate,
    drain: o.drain,
    idleMs: o.idleMs ?? 15_000,
    sleep: o.sleep,
    log,
  });
  return done;
}

// What the engine's process may see of the worker's environment: where its tools are, nothing else. The service key and
// every other secret stay in the worker (clearEnv), so neither the engine nor Chromium nor a page can read them.
// UPMORE_SCRIPT_SUBMIT_LIVE=1 (the owner's switch, off unless set on the worker's host): a real Greenhouse, Ashby or Lever
// form that submits from its own script is clicked by Trainee, with its one request bound at the network layer
// (scripts/apply.ts script submit binding). Unset, those forms stop at SUBMIT_DESTINATION_NOT_BOUND as before.
export const ENGINE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "DENO_DIR", "PLAYWRIGHT_BROWSERS_PATH", "UPMORE_PLAYWRIGHT_PATH", "UPMORE_CHROMIUM_PATH",
  "UPMORE_SCRIPT_SUBMIT_LIVE"];
export function engineEnv(from: (k: string) => string | undefined = (k) => Deno.env.get(k)) {
  const env: Record<string, string> = { UPMORE_MASK_SCREENSHOTS: "1", UPMORE_BROWSER_HEADED: "0" };
  for (const k of ENGINE_ENV_KEYS) {
    const v = from(k);
    if (v) env[k] = v;
  }
  return env;
}

// The restricted parent/child channel carries no RPC selector, job, lease or service credential. Only the
// captured parent's beforeEffect closure can authorize one effect. stdout remains bounded even for malformed children.
export const CLOUD_AUTH_PREFIX = "CLOUD_AUTH ";
export function cloudEngineRunner(o: { root: string; evidenceRoot: string; deno?: string; timeoutMs?: number; authorizeTimeoutMs?: number }): RunEngine {
  return async (args, _env, controls) => {
    const submitting = args.includes("--submit");
    if (submitting && typeof controls?.beforeEffect !== "function") throw Error("CARD_CLOUD_AUTH_REQUIRED");
    if (args.some((a) => a.startsWith("--cloud-authorize"))) throw Error("CARD_CLOUD_AUTH_PROTOCOL");
    const nonce = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const evidenceDir = `${o.evidenceRoot}/${crypto.randomUUID()}`;
    const child = new Deno.Command(o.deno || Deno.execPath(), {
      args: ["run", "-A", o.root + "/scripts/apply.ts", ...args, "--evidence-dir", evidenceDir,
        ...(submitting ? ["--cloud-authorize-stdio", "--cloud-authorize-nonce", nonce] : [])],
      stdin: submitting ? "piped" : "null", stdout: "piped", stderr: "piped", clearEnv: true, env: engineEnv(),
    }).spawn();
    let protocolFailed = false, requested = false, authorized = false, bytes = 0, pending = "", resultLine = "";
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    const writer = submitting ? child.stdin.getWriter() : null;
    const timer = setTimeout(kill, o.timeoutMs ?? 600_000);
    const processLine = async (line: string) => {
      if (line.startsWith(CLOUD_AUTH_PREFIX)) {
        if (!submitting || requested || line.length > 1024) throw Error("CARD_CLOUD_AUTH_PROTOCOL");
        requested = true;
        let request;
        try { request = JSON.parse(line.slice(CLOUD_AUTH_PREFIX.length)); } catch { throw Error("CARD_CLOUD_AUTH_PROTOCOL"); }
        if (!request || Object.keys(request).sort().join(",") !== "nonce,phase,v" || request.v !== 1 ||
          request.nonce !== nonce || request.phase !== "before_effect") throw Error("CARD_CLOUD_AUTH_PROTOCOL");
        let allowed = false, authorizationTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([controls!.beforeEffect(), new Promise<never>((_, reject) => {
            authorizationTimer = setTimeout(() => reject(Error("CARD_CLOUD_AUTH_TIMEOUT")), o.authorizeTimeoutMs ?? 5000);
          })]);
          allowed = authorized = true;
        } catch { /* refusal is returned to the child without authority details */ }
        finally { clearTimeout(authorizationTimer); }
        await writer!.write(new TextEncoder().encode(CLOUD_AUTH_PREFIX + JSON.stringify({ v: 1, nonce, allow: allowed }) + "\n"));
      } else if (line.startsWith("RESULT ")) {
        if (resultLine) throw Error("CARD_CLOUD_AUTH_PROTOCOL");
        resultLine = line;
      }
    };
    const stdout = (async () => {
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        bytes += chunk.length;
        if (bytes > 2_000_000) throw Error("CARD_CLOUD_AUTH_PROTOCOL");
        pending += chunk;
        let at;
        while ((at = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, at).replace(/\r$/, "");
          pending = pending.slice(at + 1);
          await processLine(line);
        }
        if (pending.length > 262144) throw Error("CARD_CLOUD_AUTH_PROTOCOL");
      }
      if (pending) await processLine(pending);
    })().catch(() => { protocolFailed = true; kill(); });
    const stderr = (async () => {
      let size = 0;
      for await (const chunk of child.stderr) { size += chunk.length; if (size > 2_000_000) { protocolFailed = true; kill(); break; } }
    })();
    let status: Deno.CommandStatus;
    try { [, , status] = await Promise.all([stdout, stderr, child.status]); }
    finally { clearTimeout(timer); await writer?.close().catch(() => {}); }
    // scripts/apply.ts prints RESULT and exits 1 on every refusal (FACT_OWNER_MISMATCH, a changed application, a refused
    // card authorization): that result is the refusal, not "no result". A sent state is trusted only from a clean exit.
    if (protocolFailed || !resultLine) return null;
    const result = JSON.parse(resultLine.slice(7));
    if (!status.success && ["confirmed", "submitted_unconfirmed"].includes(result?.state)) return null;
    if (submitting && ["confirmed", "submitted_unconfirmed"].includes(result?.state) && !authorized) return null;
    let evidence = null;
    try { evidence = JSON.parse(await Deno.readTextFile(evidenceDir + "/evidence.json")); }
    catch { /* refused before the evidence folder was used */ }
    return { result, evidence };
  };
}

// The queue over PostgREST with the service key, the worker's only credential. Nothing but these five functions.
export function restQueue(o: { url: string; key: string; fetch?: typeof fetch }): CloudQueue {
  const f = o.fetch ?? fetch;
  const rpc = async (name: string, args: unknown) => {
    const r = await f(`${o.url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: o.key, Authorization: `Bearer ${o.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const text = await r.text();
    if (!r.ok) throw Object.assign(Error(`${name}: ${r.status} ${text.slice(0, 200)}`), { status: r.status, body: text });
    return text ? JSON.parse(text) : null;
  };
  return {
    async claim(limit) {
      const rows = await rpc("career_apply_cloud_claim", { p_limit: limit });
      if (!Array.isArray(rows)) throw Error("APPLY_QUEUE_UNAVAILABLE");
      // Only rows this claim took (an id and a lease): a database before 20261030140000 could return an all-null row.
      return rows.filter((r: any) => r && typeof r.id === "string" && typeof r.lease_token === "string");
    },
    authorize: (job, phase) => authorizeCurrentCloudJob(job, phase, { rpc }),
    resume: (job) => rpc("career_apply_cloud_resume", { p_id: job.id, p_lease: job.lease_token }),
    ask: (job, questions) => rpc("career_apply_cloud_ask", { p_id: job.id, p_lease: job.lease_token, p_questions: questions }),
    finish: (job, state, evidence, outcome, errorKind) =>
      rpc("career_apply_cloud_finish", { p_id: job.id, p_lease: job.lease_token, p_state: state, p_evidence: evidence, p_outcome: outcome, p_error_kind: errorKind }),
    async requeue(job, reason, retryAfterS, until) {
      try {
        const r = await rpc("career_apply_requeue_refused_for", { p_id: job.id, p_lease: job.lease_token, p_reason: reason,
          p_retry_after_s: retryAfterS, p_until: new Date(until).toISOString() });
        const nb = Date.parse(r?.not_before);
        return Number.isFinite(nb) ? nb : until;
      } catch (e: any) {
        if (e?.status === 404 || requeueMissing(String(e?.body ?? ""))) return null;
        throw e;
      }
    },
    async putBack(job, why, until) {
      try {
        const r = await rpc("career_apply_requeue_unstarted_for", { p_id: job.id, p_lease: job.lease_token, p_why: unstartedWhy(why),
          p_until: new Date(until).toISOString() });
        const nb = Date.parse(r?.not_before);
        return Number.isFinite(nb) ? nb : until;
      } catch (e: any) {
        const body = String(e?.body ?? "");
        if (e?.status === 404 || requeueMissing(body) || /career_apply_requeue_unstarted|invalid unstarted reason/i.test(body)) return null;
        // No longer this worker's claim: nothing to record (the caller treats it as closed).
        if (/invalid apply (claim|transition)/i.test(body)) throw e;
        // The database refused it for another reason (a card approval expired since): recorded not sent instead.
        if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) return null;
        throw e;
      }
    },
    async gatePresent() {
      try {
        return typeof (await rpc("career_apply_cloud_open", { p_portal: "lever" })) === "boolean";
      } catch (e: any) {
        if (e?.status === 404 || /PGRST202|could not find the function/i.test(String(e?.body ?? ""))) return false;
        throw e;
      }
    },
  };
}

// Before the loop: the worker refuses to start without the gate function in the database, with a key that is not the
// service key, or with its env file readable by anyone but its owner.
export async function preflight(o: { queue: CloudQueue; key: string; envFile?: string | null }) {
  const role = (() => {
    try {
      const part = o.key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4))).role ?? null;
    } catch {
      return null;
    }
  })();
  if (role !== "service_role") return { ok: false as const, why: "NOT_THE_SERVICE_KEY: the cloud worker runs only with the service role key (a JWT whose role is service_role)" };
  if (o.envFile) {
    const st = await Deno.stat(o.envFile);
    if ((st.mode ?? 0) & 0o077) return { ok: false as const, why: `ENV_FILE_NOT_PRIVATE: chmod 600 ${o.envFile}` };
  }
  if (!(await o.queue.gatePresent())) {
    return { ok: false as const, why: "GATE_FUNCTION_MISSING: apply 20261021080000_career_apply_cloud.sql first; nothing was claimed" };
  }
  return { ok: true as const };
}

// deno run -A workers/career-cloud/worker.ts, with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLOUD_EVIDENCE_DIR and
// UPMORE_CLOUD_ENV_FILE from the systemd env file (docs/launch/CLOUD-WORKER.md); the pacing names MASS_SUBMIT_* (or
// CLOUD_CONTEXTS for how many at once) and CLOUD_JOURNAL_DIR are optional (docs/launch/CLOUD-RUNNER.md).
if (import.meta.main) {
  const env = (k: string) => Deno.env.get(k) || "";
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("usage: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env file (docs/launch/CLOUD-WORKER.md)");
    Deno.exit(2);
  }
  const queue = restQueue({ url, key });
  const ok = await preflight({ queue, key, envFile: env("UPMORE_CLOUD_ENV_FILE") || null });
  if (!ok.ok) {
    console.error(ok.why);
    Deno.exit(2);
  }
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const evidenceRoot = env("CLOUD_EVIDENCE_DIR") || `${Deno.env.get("HOME")}/trainee-evidence`;
  await Deno.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await Deno.chmod(evidenceRoot, 0o700);
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(sig, () => {
      stopping = true;
      console.log("Stopping: no new claims; the applications in flight finish and are recorded (systemd: KillMode=mixed).");
    });
  }
  // No number of ours (owner, 2026-10-27): as many at once as this machine holds unless the owner sets one; a site slows
  // only when it refuses. Many instances may run this at once (docs/launch/CLOUD-RUNNER.md "Many instances").
  const pacing = pacingFrom((k) => Deno.env.get(k), /^\d+$/.test(env("CLOUD_CONTEXTS")) ? { concurrency: Number(env("CLOUD_CONTEXTS")) } : {});
  const journalDir = env("CLOUD_JOURNAL_DIR") || `${evidenceRoot}/journal`;
  console.log(`Cloud worker up: up to ${pacing.concurrency} at once on this machine; a site that refuses is backed off for every instance. ` +
    "The kill switch and the gate are read from the database on every claim.");
  // Every instance shares the hosts' refusals through the database (career_apply_host_backoff_*; until the database lane
  // ships them, each instance backs off on its own and says so once).
  const gateRpc = { rpc: async (name: string, args?: unknown) => {
    const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(args ?? {}) });
    const text = await r.text();
    return r.ok ? { data: text ? JSON.parse(text) : null, error: null } : { data: null, error: { message: `${r.status} ${text.slice(0, 200)}` } };
  } };
  await cloudLoop({ queue, runEngine: cloudEngineRunner({ root, evidenceRoot }), stop: () => stopping, pacing, journal: fileJournal<CloudJob>(journalDir), gate: dbHostGate(gateRpc) });
}
