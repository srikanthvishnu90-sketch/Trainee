// WO-021 W1 + W4: approve first, then apply without asking twice (D-014: one stack, D-017: the person's own browser).
//
// prepare: the engine's dry run (scripts/apply.ts without --submit) on one posting. When everything is answered it
// returns the card (every answer, the destination, the resume) and the queue payload. The payload carries the engine's
// approval hash, so the application that runs later must be exactly the one shown.
// run: claims approved applications from career_apply_jobs and runs the engine with --submit --approved <hash>. The
// answers are rebuilt from the approved payload itself, so the engine reproduces the same application or stops it
// (APPROVED_APPLICATION_CHANGED, nothing sent). The outcome goes back with career_apply_finish; an engine that gave no
// result is recorded unknown_outcome and never retried.
import { mapQuestion } from "../../supabase/functions/_shared/question_map.ts";
import { CARD_MARK, resumeCardLine as sharedResumeCardLine } from "../../supabase/functions/_shared/career_prepared_card.ts";
import { createRequire } from "node:module";
import { normLabel, questionFieldType } from "../../supabase/functions/_shared/career_apply.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
// WO-102: the submission-quality contract, the extension's own functions (never copied).
import { QUARANTINE_VERSION, quarantinedFact, trustedManifest } from "../../extension/src/apply_core.ts";
import { applicationApprovalHash } from "../../scripts/apply.ts";
import { factDependencies } from "../../supabase/functions/_shared/fact_quarantine.ts";
import { rowQuestionLabel, rowQuestionType } from "../../supabase/functions/_shared/row_answer.ts";
import { fileJournal, handBack, type HostGate, type Journal, massRun, PacedLimiter, type Pacing, pacingFrom, requeueMissing, sentNothingRefusal, unstartedWhy } from "./mass-run.ts";

export interface EngineResult {
  result: {
    state: string;
    reason?: string;
    confirmation_id?: string | null;
    evidence_path?: string;
    fields?: string[];
    // D-024: the engine's proof of a click (scripts/apply.ts), kept with the queue's record.
    proof?: Record<string, unknown>;
  };
  evidence: any;
}
// env: extra environment for this one run (WO-096: the drive's queue row and lease, for reading the emailed code).
export interface EngineControls { beforeEffect: () => Promise<void> }
export type RunEngine = (args: string[], env?: Record<string, string>, controls?: EngineControls) => Promise<EngineResult | null>;
// WO-096: what the engine needs to read the code an employer emails for this approved drive through the person's own
// session (the career-email-code function checks the row is theirs, being driven, under this lease). null: not offered.
export type EmailCodeEnv = (job: Job) => Promise<Record<string, string> | null>;

export interface Job {
  id: string;
  lease_token: string;
  url: string;
  user_id?: string;
  payload: any;
}

const OUTCOMES = new Set([
  "confirmed",
  "submitted_unconfirmed",
  "needs_user",
  "failed",
  "not_submitted",
  "unknown_outcome",
]);

// WO-028: a resume Trainee tailored for this posting (tailor_resume) is said as such on the card, with the persona it
// used, and tagged on the payload so the queue counts tailored and untailored applications apart. The database keeps the
// tag only when that exact file is one Trainee stored for this person (career-resumes/<user_id>/<sha256>.pdf).
export interface ResumeTag {
  tailored: true;
  persona: string | null;
}
// The card's resume line and answer marks are the server's own rules (career_prepared_card.ts), which the hosted bridge
// checks every card against before it stores the application.
export function resumeCardLine(filename: string, sha256: string, tag?: ResumeTag | null): string {
  return sharedResumeCardLine(filename, sha256, tag);
}
// "--tailored-resume <persona|base>" on the command line; the rest goes to the engine.
export function takeResumeTag(args: string[]): { tag: ResumeTag | null; rest: string[] } {
  const i = args.indexOf("--tailored-resume");
  if (i < 0) return { tag: null, rest: args };
  const v = String(args[i + 1] ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9 -]{0,23}$/.test(v)) throw Error("--tailored-resume needs a persona name or 'base'");
  return {
    tag: { tailored: true, persona: v === "base" ? null : v },
    rest: [...args.slice(0, i), ...args.slice(i + 2)],
  };
}

export async function prepare(o: {
  url: string;
  factsPath: string;
  resumePath: string;
  account: { epoch: number; version: number };
  now: number;
  ttlHours?: number;
  runEngine: RunEngine;
  resumeTag?: ResumeTag | null;
}) {
  const run = await o.runEngine(["--url", o.url, "--facts", o.factsPath, "--resume", o.resumePath]);
  if (!run || run.result.reason !== "dry_run" || !run.evidence?.approval_hash) {
    return { ready: false as const, result: run?.result ?? { state: "not_submitted", reason: "ENGINE_NO_RESULT" } };
  }
  const ev = run.evidence;
  // WO-102: each answer goes with the source the engine's contract judged it by (the event that confirmed it, its
  // provenance, whether it may attest, and where a texted answer was kept), so the approved run is judged again on it.
  const fields = ev.fields.map((f: any) => ({ name: f.name, label: f.label, value: f.value, factId: f.factId, ...sourceOf(ev.sources?.[f.factId]) }));
  const payload = {
    version: 1,
    user_id: ev.payload.user_id,
    job_id: ev.payload.posting,
    company: ev.payload.company,
    url: o.url,
    fields,
    destination: ev.payload.destination,
    resume_sha256: ev.payload.resume.sha256,
    page_field_names: Object.keys(ev.payload.page_fields || {}).sort(),
    engine_approval: ev.approval_hash,
    ...(typeof ev.payload.schema_hash === "string" ? { schema_hash: ev.payload.schema_hash } : {}),
    privacy_epoch: o.account.epoch,
    account_version: o.account.version,
    expires_at: new Date(o.now + (o.ttlHours ?? 24) * 3600_000).toISOString(),
    ...(ev.trust?.quarantine_version ? { quarantine_version: String(ev.trust.quarantine_version), manifest_hash: String(ev.trust.manifest_hash ?? "") } : {}),
    ...(ev.trust?.manifest_hash ? { replay_sources: Array.isArray(ev.replay_sources) ? ev.replay_sources : Object.values(ev.sources ?? {}) } : {}),
    ...(o.resumeTag?.tailored
      ? { resume_tailored: true, ...(o.resumeTag.persona ? { resume_persona: o.resumeTag.persona } : {}) }
      : {}),
  };
  // What the person reads before the yes: every answer as the form itself shows it (the engine's readback, so a select
  // reads "Yes", never its internal value "1"), the resume once by name, and where it goes. Nothing on the card that the
  // application does not carry, and nothing the application carries that is not on the card.
  const shown = (f: any) => {
    const r = ev.readback?.[f.name];
    return typeof r === "string" ? r : typeof r === "boolean" ? (r ? "Yes (checked)" : "No") : String(f.value);
  };
  const card = [
    payload.company,
    ...fields.filter((f: any) => f.value !== payload.resume_sha256).map((f: any) => `${MARK[mapQuestion({ label: f.label }).kind] ?? ""}${f.label}: ${shown(f)}`),
    resumeCardLine(ev.payload.resume.filename, payload.resume_sha256, o.resumeTag),
    ...(payload.page_field_names.length
      ? [`Also sent, set by the employer's page, unchanged: ${payload.page_field_names.join(", ")}`]
      : []),
    ...((ev.payload.verification || []).length
      ? [
        `The page runs a verification check (${
          ev.payload.verification.join(", ")
        }); its token carries none of your answers`,
      ]
      : []),
    `Sends to ${payload.destination}`,
  ];
  let approved_snapshot: { schema: any[]; original: typeof payload } | undefined;
  if (Array.isArray(ev.schema)) {
    if (await hashApplyPayload(ev.schema) !== payload.schema_hash) throw Error("INVALID_APPROVED_SCHEMA");
    await assertApprovedPayload(payload, { url: o.url, user_id: payload.user_id });
    approved_snapshot = JSON.parse(JSON.stringify({ schema: ev.schema, original: payload }));
  }
  const queued = { ...payload, ...(approved_snapshot ? { approved_snapshot } : {}) };
  return { ready: true as const, payload: queued, hash: await hashApplyPayload(queued), card };
}

// On the card, an answer the person must read as theirs says so: a consent they give, a legal statement they make, an
// answer about this job's terms. The mark is drawn from the question's meaning; the application carries the answer only.
const MARK: Record<string, string> = CARD_MARK;

// The approved answers as the engine's confirmed facts: each under its question, with its fact id, so the engine maps
// the same question to the same answer and the approval hash comes out the same. WO-102: each carries the source it was
// approved on (provenance, confirmation event, whether it may attest), and the engine judges them again by the same
// contract (scripts/apply.ts trustedFacts): an answer prepared without a source (before WO-102), or one whose source the
// contract no longer keeps, is asked again and nothing is sent. A texted answer goes back as his answer row under the key
// it was kept by (a file fact may never carry a text-answer id); the picked resume is the file passed, by its hash.
export function factsFromPayload(payload: any) {
  const answers: Record<string, any> = {}, saved: Record<string, any> = {};
  const text_answers: TextAnswer[] = [];
  const bindings = new Map<string, string>(), metadata = new Map<string, string>(), ids = new Map<string, string>();
  const originalSources = (Array.isArray(payload.replay_sources) ? payload.replay_sources : []).map((s: any) => ({
    label: `source ${s?.key ?? ""}`, factId: s?.factId, ...sourceOf(s),
  }));
  for (const f of [...payload.fields, ...originalSources]) {
    if (f.value && typeof f.value === "object") continue; // the resume is passed as a file, checked by its hash
    const id = String(f.factId ?? "");
    if (id === `approved-local-resume:${payload.resume_sha256}` && f.source?.key === "resume" &&
      f.source?.table === "answers" && f.source?.value === payload.resume_sha256) continue;
    // A row's employer/title is derived from one structured work_history fact. Rebuild that original fact,
    // not four unrelated answers indexed by repeated labels. The engine replans it against the live schema
    // and checks engine_approval (including schema/options, fields and source events) before submission.
    const source = f.source;
    if (source && Object.hasOwn(source, "value")) {
      if (!["answers", "saved"].includes(source.table) || typeof source.key !== "string" || !source.key ||
        typeof source.value !== "string" || !source.value || !id) throw Error("INVALID_APPROVED_SOURCE: " + f.label);
      const coordinate = JSON.stringify([source.table, source.key]);
      const binding = JSON.stringify([id, source.value]);
      const evidence = JSON.stringify([f.provenance ?? null, f.confirmation_event_id ?? null, f.authorizes === true]);
      if ((bindings.has(coordinate) && bindings.get(coordinate) !== binding) || (ids.has(id) && ids.get(id) !== coordinate)) {
        throw Error("CONFLICTING_APPROVED_SOURCE: " + f.label);
      }
      if (bindings.has(coordinate)) {
        if (metadata.get(coordinate) !== evidence) {
          // Inconsistent authority cannot be repaired from the snapshot. Keep it untrusted so the canonical
          // contract asks again (and manifest revalidation stops a bound run before effects).
          (source.table === "answers" ? answers : saved)[source.key] = { value: source.value, factId: id, confirmed: true,
            provenance: "", confirmation_event_id: "", ...(f.user_id ? { user_id: f.user_id } : {}) };
          for (let i = text_answers.length - 1; i >= 0; i--) if (`text-answer:${text_answers[i].id}` === id) text_answers.splice(i, 1);
        }
        continue;
      }
      bindings.set(coordinate, binding); metadata.set(coordinate, evidence); ids.set(id, coordinate);
      if (id.startsWith("text-answer:") && f.confirmation_event_id === id && f.provenance === `owner answered this question (${id})`) {
        text_answers.push({ id: id.slice("text-answer:".length), key: source.table === "answers" ? `fact:${source.key}` : source.key, kind: "", answer: source.value });
      } else {
        (source.table === "answers" ? answers : saved)[source.key] = {
          value: source.value, factId: f.factId, confirmed: true,
          ...(f.provenance ? { provenance: String(f.provenance) } : {}),
          ...(f.confirmation_event_id ? { confirmation_event_id: String(f.confirmation_event_id) } : {}),
          ...(f.authorizes === true ? { authorizes: true } : {}),
          ...(f.user_id ? { user_id: String(f.user_id) } : {}),
        };
      }
      continue;
    }
    if (id.startsWith("text-answer:") && f.source?.key) {
      text_answers.push({ id: id.slice("text-answer:".length), key: f.source.table === "answers" ? `fact:${f.source.key}` : String(f.source.key), kind: "", answer: String(f.value) });
      continue;
    }
    const key = normLabel(f.label);
    if (Object.hasOwn(saved, key) && saved[key].value !== f.value) {
      throw Error("CONFLICTING_APPROVED_ANSWERS: " + f.label);
    }
    saved[key] = {
      value: f.value, factId: f.factId, confirmed: true,
      ...(f.provenance ? { provenance: String(f.provenance) } : {}),
      ...(f.confirmation_event_id ? { confirmation_event_id: String(f.confirmation_event_id) } : {}),
      ...(f.authorizes === true ? { authorizes: true } : {}),
      ...(f.user_id ? { user_id: String(f.user_id) } : {}),
    };
  }
  return { user_id: payload.user_id, answers, saved, ...(text_answers.length ? { text_answers } : {}) };
}
// The source an answer was approved on, from the engine's manifest entry (evidence.sources), for the payload.
function sourceOf(tf: any) {
  if (!tf || typeof tf !== "object") return {};
  return {
    provenance: String(tf.provenance ?? ""), confirmation_event_id: String(tf.event ?? ""), ...(tf.authorizes === true ? { authorizes: true } : {}),
    source: { table: tf.table, key: tf.key, value: tf.value },
  };
}
// The engine's canonical approval identity (scripts/apply.ts): validate the queued field/source/schema binding
// before reconstructing facts. Otherwise a changed payload could silently re-create an older approved answer.
export async function engineApprovalFromPayload(payload: any): Promise<string | null> {
  if (payload.schema_hash === undefined) {
    const modern = payload.manifest_hash !== undefined || payload.quarantine_version !== undefined || payload.replay_sources !== undefined ||
      (Array.isArray(payload.fields) && payload.fields.some((f: any) => f?.source && Object.hasOwn(f.source, "value")));
    if (modern) throw Error("INVALID_APPROVED_SCHEMA");
    return null; // genuinely legacy approvals are still re-judged by the engine
  }
  if (!/^[a-f0-9]{64}$/.test(String(payload.schema_hash))) throw Error("INVALID_APPROVED_SCHEMA");
  const facts = factsFromPayload(payload);
  const manifest = trustedManifest({ owner: payload.user_id, file: facts, rows: facts.text_answers ?? [], resume: { sha256: payload.resume_sha256 } });
  if (manifest.hash !== payload.manifest_hash) throw Error("APPROVED_MANIFEST_CHANGED");
  return await applicationApprovalHash({ userId: payload.user_id, posting: payload.job_id, destination: payload.destination,
    fields: payload.fields, resumeSha256: payload.resume_sha256, schemaHash: payload.schema_hash,
    pageFieldNames: payload.page_field_names, manifest });
}
// WO-102, before an approved run starts: what in this payload the contract can never send, whatever the engine finds.
// An answer from a quarantined fact (D-007: F-027..F-079, the answer-all delegation) or derived from one, a texted answer
// with no key it was kept by, or an approval judged under other quarantine rules. Empty: the engine judges the rest.
export function payloadTrust(payload: any): string[] {
  const why: string[] = [];
  if (payload?.quarantine_version !== undefined && payload.quarantine_version !== QUARANTINE_VERSION) {
    why.push(`approved under the quarantine rules ${String(payload.quarantine_version)}, not ${QUARANTINE_VERSION}`);
  }
  for (const f of Array.isArray(payload?.fields) ? payload.fields : []) {
    const label = String(f?.label ?? f?.name ?? "");
    const dependencies = factDependencies(f);
    if (quarantinedFact({ factId: f?.factId, provenance: f?.provenance })) why.push(`"${label}": its fact is quarantined (D-007)`);
    else if (dependencies === null) why.push(`"${label}": malformed dependency metadata`);
    else if (dependencies.some((x: unknown) => quarantinedFact({ factId: x }))) {
      why.push(`"${label}": derived from a quarantined fact (D-007)`);
    } else if (String(f?.factId ?? "").startsWith("text-answer:") && !f?.source?.key) why.push(`"${label}": a texted answer with no question it answered`);
  }
  return why;
}
// Shared before-effects boundary for the desktop and cloud workers. Replaying original source values is safe only
// after the queued printed answers, source manifest and schema have been checked against the approved identity.
export async function assertApprovedPayload(payload: any, context?: { url: string; user_id?: string }): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(String(payload?.engine_approval))) throw Error("NO_ENGINE_APPROVAL");
  if ((Array.isArray(payload.fields) ? payload.fields : []).some((f: any) => f?.user_id !== undefined && f.user_id !== payload.user_id)) throw Error("FACT_OWNER_MISMATCH");
  const untrusted = payloadTrust(payload);
  if (untrusted.length) throw Error("CONTRACT_REFUSED: " + untrusted.join("; "));
  const expected = await engineApprovalFromPayload(payload);
  if (expected !== null && context && (context.url !== payload.url ||
    (Object.hasOwn(context, "user_id") && context.user_id !== payload.user_id))) throw Error("APPROVED_APPLICATION_CHANGED");
  if (expected !== null && expected !== payload.engine_approval) throw Error("APPROVED_APPLICATION_CHANGED");
}
// A refused drive never runs to discover its questions. Only an intact original approval + hash-bound schema can
// supply them. This helper never repairs an approval or returns answers; changed values and contexts stay refused.
export async function approvedQuestionsAfterRefusal(payload: any, context: { url: string; user_id?: string }) {
  try {
    const snapshot = payload?.approved_snapshot, original = snapshot?.original, schema = snapshot?.schema;
    if (!original || original.approved_snapshot || !Array.isArray(schema) || !Array.isArray(original.fields) || !Array.isArray(payload.fields) ||
      original.engine_approval !== payload.engine_approval || await hashApplyPayload(schema) !== original.schema_hash) return null;
    if (new Set(schema.map((f: any) => f?.name)).size !== schema.length || !schema.every((f: any) =>
      typeof f?.name === "string" && typeof f.label === "string" && typeof f.type === "string" && Array.isArray(f.options) &&
      f.options.every((o: any) => typeof o?.label === "string" && typeof o.value === "string"))) return null;
    await assertApprovedPayload(original, context);
    const unchanged = (p: any) => Object.fromEntries(Object.entries(p).filter(([key]) => !["fields", "approved_snapshot"].includes(key)));
    if (await hashApplyPayload(unchanged(original)) !== await hashApplyPayload(unchanged(payload))) return null;
    const prior = new Map(original.fields.map((f: any) => [f.name, f])), now = new Map(payload.fields.map((f: any) => [f.name, f]));
    if (prior.size !== original.fields.length || now.size !== payload.fields.length || [...now.keys()].some(name => !prior.has(name))) return null;
    const questions = [];
    for (const [name, old] of prior as Map<string, any>) {
      const f: any = now.get(name), field = schema.find((x: any) => x.name === name);
      if (f && await hashApplyPayload(f) === await hashApplyPayload(old)) continue;
      if (!field?.required || field.label !== old.label) return null;
      if (f) {
        const fixed = (x: any) => ({ name: x.name, label: x.label, value: x.value, source: x.source ?? null });
        if (await hashApplyPayload(fixed(f)) !== await hashApplyPayload(fixed(old)) || !payloadTrust({ fields: [f] }).length ||
          (f.user_id !== undefined && f.user_id !== payload.user_id)) return null;
      }
      const options = (Array.isArray(field.options) ? field.options : []).map((o: any) => String(o.label));
      questions.push({ label: rowQuestionLabel(field), type: rowQuestionType(field, original.job_id, questionFieldType(field)), options: options.length <= 60 ? options : [] });
    }
    return questions.length ? { state: "not_submitted", reason: "needs_answers", posting: original.job_id, company: original.company,
      fields: questions.map(q => q.label), questions } : null;
  } catch { return null; }
}
// What the engine reads for the desktop prepare (WO-102): the person's facts file as it is, and their texted answers
// beside it as their own answer rows. Never merged under the file's facts (factsWithTextAnswers lets the file silently
// win over a texted answer that disagrees); the engine's contract keeps the agreeing ones and asks again on a conflict.
export function engineFacts(facts: any, rows: TextAnswer[]) {
  return { ...(facts && typeof facts === "object" ? facts : {}), text_answers: (rows || []).filter((r) => r && typeof r.key === "string") };
}

// Ask once and the service-key check live in ask-once.ts, shared with the browser extension (WO-031).
import { factsWithTextAnswers, jwtRole, questionsToStore, type TextAnswer } from "./ask-once.ts";
export { factsWithTextAnswers, jwtRole, questionsToStore, type TextAnswer };

export async function runApproved(d: {
  claim: () => Promise<Job[]>;
  finish: (id: string, lease: string, state: string, evidence: Record<string, unknown>) => Promise<unknown>;
  resumeFor: (job: Job) => Promise<{ path: string; sha256: string }>;
  writeFacts: (job: Job, facts: unknown) => Promise<string>;
  runEngine: RunEngine;
  emailCode?: EmailCodeEnv;
  // FEATURE 14 (D-024, G6): the proof's two pictures go to the queue's receipt store while the lease is held, before the
  // finish (career_apply_receipt_attach_own). Optional: without it the pictures stay on this computer, as before.
  attach?: ReceiptAttach;
  // Mass submission: awaited right before the engine starts (the scheduler's durable journal line). If it throws, the
  // engine never starts and the application is recorded not_submitted: nothing was sent.
  beforeEngine?: (job: Job) => Promise<void>;
  // The scheduler puts back a job whose host refused before anything was sent (mass-run.ts sentNothingRefusal): such a
  // run is not finished here (it is returned with requeue: true and recorded by the scheduler's requeue). Without it, the
  // run is recorded not_submitted as before.
  requeueRefusal?: boolean;
}) {
  const done: { id: string; state: string; reason?: string; retry_after_s?: number | null; requeue?: boolean; status?: number | null }[] = [];
  for (const job of await d.claim()) {
    let state = "not_submitted", evidence: Record<string, unknown> = {};
    let started = false;
    try {
      const p = job.payload;
      await assertApprovedPayload(p, job);
      // OWNER RULE (2026-10-26, "never submit applications without a real resume"): the approved payload binds a resume
      // (its sha256) and a resume file is handed over for it; otherwise the engine never starts. The engine checks the
      // file's bytes against the approved hash before it fills anything (the trusted manifest's resume).
      if (!/^[a-f0-9]{64}$/.test(String(p?.resume_sha256 ?? ""))) throw Error("NO_RESUME");
      const resume = await d.resumeFor(job);
      if (!resume || typeof resume.path !== "string" || !resume.path) throw Error("NO_RESUME");
      if (resume.sha256 !== p.resume_sha256) throw Error("RESUME_CHANGED");
      const factsPath = await d.writeFacts(job, factsFromPayload(p));
      // WO-096: this drive is the person's approved application, so the code its employer emails may be read for it.
      const codeEnv = d.emailCode ? await d.emailCode(job) : null;
      if (d.beforeEngine) await d.beforeEngine(job);
      started = true;
      const run = await d.runEngine([
        "--url",
        job.url,
        "--facts",
        factsPath,
        "--resume",
        resume.path,
        "--submit",
        "--approved",
        p.engine_approval,
        "--application-id",
        job.id,
        ...(codeEnv ? ["--email-code", "account"] : []),
      ], codeEnv ?? undefined);
      if (!run || !OUTCOMES.has(run.result.state)) {
        state = "unknown_outcome";
        evidence = { reason: "the engine gave no result after it started; not retried" };
      } else if (d.requeueRefusal && sentNothingRefusal(run.result as any)) {
        // The employer's site refused at the page's open, before anything was filled or sent (HOST_RATE_LIMITED): not
        // finished here; the scheduler puts the same job back until the site allows, then it runs again.
        const rr: any = run.result;
        done.push({ id: job.id, state: "refused", reason: "HOST_RATE_LIMITED", requeue: true, status: typeof rr.status === "number" ? rr.status : null,
          ...(typeof rr.retry_after_s === "number" ? { retry_after_s: rr.retry_after_s } : {}) });
        continue;
      } else if (handBack(run.result)) {
        // A verification check or the employer's sign-in wall: the person finishes it at the link; never retried. The
        // engine stopped before anything was sent.
        state = "needs_user";
        evidence = { reason: handBack(run.result), link: job.url, engine_reason: run.result.reason ?? null, evidence_path: run.result.evidence_path ?? null };
      } else {
        state = run.result.state;
        // D-024 (G6): the proof is kept with the record only if it was taken for this application and this approval;
        // a picture of another application's page never stands as this one's. Without it, never "confirmed".
        const proof: any = run.result.proof;
        const bound = !!proof && proof.application_id === job.id && proof.approval_hash === p.engine_approval &&
          !!proof.before_click && !!proof.run_id;
        if (state === "confirmed" && !(bound && proof.after_submit)) state = "submitted_unconfirmed";
        evidence = {
          reason: run.result.reason ?? null,
          confirmation_id: run.result.confirmation_id ?? null,
          evidence_path: run.result.evidence_path ?? null,
          // The employer's site refused for load (HOST_RATE_LIMITED): the seconds it asked for, so the host is held off as
          // long as it asked (mass-run.ts refusal), not the default doubling.
          ...(typeof run.result.retry_after_s === "number" ? { retry_after_s: run.result.retry_after_s } : {}),
          ...(bound ? { proof } : proof ? { proof_refused: "PROOF_NOT_THIS_APPLICATION" } : {}),
        };
        // FEATURE 14: the pictures and the page's text go to the receipt store, never into the row's evidence (hashes only).
        if (bound && d.attach) await attachProof(job, proof, run.result.evidence_path, d.attach, confirmationText(state, run.evidence));
      }
    } catch (e: any) {
      // Before the engine started nothing could have been sent; after it started, nothing is known.
      state = started ? "unknown_outcome" : "not_submitted";
      evidence = { reason: String(e?.message || e) };
    }
    await d.finish(job.id, job.lease_token, state, evidence);
    done.push({ id: job.id, state, reason: evidence.reason as string | undefined,
      ...(typeof evidence.retry_after_s === "number" ? { retry_after_s: evidence.retry_after_s } : {}) });
  }
  return done;
}

// FEATURE 14 (D-024, G6): the receipt's pictures and the employer's own words.
export type ReceiptAttach = (job: Job, kind: "before-click" | "after-submit" | "page-text", sha256: string, b64: string) => Promise<unknown>;
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// Each picture the bound proof names, read from the run's private evidence folder and sent only if its bytes are the
// picture the proof's hash names, then the page's text after the click when there is one. Anything that cannot be read
// or sent is logged and left on this computer; it never changes the outcome (the finish records it either way, and the
// receipt then shows no picture or no page text).
const hexOf = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function attachProof(job: Job, proof: any, dir: string | undefined, attach: ReceiptAttach, pageText?: string | null): Promise<string[]> {
  const sent: string[] = [];
  for (const [key, kind] of [["before_click", "before-click"], ["after_submit", "after-submit"]] as const) {
    const shot = proof?.[key];
    if (!dir || !shot?.file || !/^[a-f0-9]{64}$/.test(String(shot.sha256)) || /[\/]/.test(String(shot.file))) continue;
    try {
      const bytes = await Deno.readFile(`${dir}/${shot.file}`);
      const hex = await hexOf(bytes);
      if (hex !== shot.sha256) throw Error("the file is not the picture the proof names");
      await attach(job, kind, hex, toBase64(bytes));
      sent.push(kind);
    } catch (e: any) {
      console.error(`receipt picture ${kind} not attached: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  if (pageText) {
    try {
      const bytes = new TextEncoder().encode(pageText);
      await attach(job, "page-text", await hexOf(bytes), toBase64(bytes));
      sent.push("page-text");
    } catch (e: any) {
      console.error(`receipt page text not attached: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return sent;
}
// What the employer's page said after the click, as the engine read it (evidence.json observation), bounded: only for an
// application that may have reached the employer. It is the employer's text (it may echo the person's answers), kept
// only on the person's own receipt.
export function confirmationText(state: string, ev: any): string | null {
  if (!["confirmed", "submitted_unconfirmed", "unknown_outcome"].includes(state)) return null;
  const t = String(ev?.observation?.page_text ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  return t || null;
}

// The person's own queue, signed in as them (D-017; migration 20261020010000_career_apply_own_worker.sql): it claims and
// finishes only that person's approved applications. The client is a Supabase client holding the person's own session,
// never the service key.
export interface RpcClient {
  rpc: (name: string, args: unknown) => PromiseLike<{ data: any; error: any }>;
}
export function ownQueue(client: RpcClient) {
  const must = (r: { data: any; error: any }) => {
    if (r.error) {
      // An expired or refused sign-in is not a queue outage: asking again would never work.
      const text = `${r.error.code ?? ""} ${r.error.message ?? ""}`;
      // A claim the database already closed (its lease swept after 15 minutes, or finished): nothing is left to record.
      if (/invalid apply (claim|transition)/i.test(text)) throw Error("APPLY_CLAIM_CLOSED");
      throw Error(/PGRST30[0-3]|jwt|not signed in/i.test(text) ? "SIGNED_OUT" : "APPLY_QUEUE_UNAVAILABLE");
    }
    return r.data;
  };
  return {
    async claim(limit: number): Promise<Job[]> {
      const rows = must(await client.rpc("career_apply_claim_own", { p_limit: limit }));
      if (!Array.isArray(rows)) throw Error("APPLY_QUEUE_UNAVAILABLE");
      return rows;
    },
    async finish(id: string, lease: string, state: string, evidence: Record<string, unknown>) {
      return must(
        await client.rpc("career_apply_finish_own", { p_id: id, p_lease: lease, p_state: state, p_evidence: evidence }),
      );
    },
    // Owner rule (2026-10-27, back off then RESUME): the employer's site refused before anything was sent; the same job
    // goes back to the queue, not handed out before `until` (20261029180000_career_apply_refusal_requeue.sql). Returns
    // when it may be handed out again (epoch ms), or null when this database does not have the requeue yet.
    async requeue(id: string, lease: string, reason: string, retryAfterS: number | null, until: number): Promise<number | null> {
      const r = await client.rpc("career_apply_requeue_refused_own",
        { p_id: id, p_lease: lease, p_reason: reason, p_retry_after_s: retryAfterS, p_until: new Date(until).toISOString() });
      if (r.error && requeueMissing(`${r.error.code ?? ""} ${r.error.message ?? ""}`)) return null;
      const nb = Date.parse(must(r)?.not_before);
      return Number.isFinite(nb) ? nb : until;
    },
    // Owner rule (back off then RESUME): a claim whose engine never started (the worker stopping, no start inside its lease
    // budget, its host held) goes back to the queue, the same job, not handed out before `until`
    // (20261029190000_career_apply_unstarted_requeue.sql). Returns when it may be handed out again (epoch ms), or null when
    // it cannot be put back (a database without the requeue, or one that refuses it): then it is recorded not sent.
    async putBack(id: string, lease: string, why: string, until: number): Promise<number | null> {
      const r = await client.rpc("career_apply_requeue_unstarted_own",
        { p_id: id, p_lease: lease, p_why: unstartedWhy(why), p_until: new Date(until).toISOString() });
      if (r.error) {
        const text = `${r.error.code ?? ""} ${r.error.message ?? ""}`;
        if (requeueMissing(text) || /career_apply_requeue_unstarted|invalid unstarted reason/i.test(text)) return null;
        // A refusal other than "no longer your claim" (an approval expired since): not put back; recorded not sent.
        if (r.error.code === "P0001" && !/invalid apply (claim|transition)/i.test(text)) return null;
      }
      const nb = Date.parse(must(r)?.not_before);
      return Number.isFinite(nb) ? nb : until;
    },
    // FEATURE 14: one picture of the proof, under the drive's lease (20261026140000_career_apply_receipt_store.sql).
    async attach(id: string, lease: string, kind: string, sha256: string, b64: string) {
      return must(
        await client.rpc("career_apply_receipt_attach_own", { p_id: id, p_lease: lease, p_kind: kind, p_sha256: sha256, p_bytes_b64: b64 }),
      );
    },
  };
}

// The worker on the person's own computer (owner D-MS-2, 2026-10-27: no product volume cap, safety pacing only). It
// claims the person's approved applications in batches (MASS_SUBMIT_CLAIM_BATCH) and runs several at once across
// different employers (MASS_SUBMIT_CONCURRENCY), each employer host paced (MASS_SUBMIT_HOST_MAX at once,
// MASS_SUBMIT_HOST_SPACING_MS between starts; mass-run.ts). With a visible browser or a hand-off (--headed, --handoff) the
// person may be needed at the window, so it runs one at a time. A queue that cannot be read waits and is asked again;
// nothing runs without a claim. Recording the outcome is retried, because an application the employer confirmed must not
// read as unknown over a network blip; if it still cannot be recorded, the drive is left to the database, which marks it
// unknown after 15 minutes and never re-drives it, and the local evidence path is reported. The engine never runs twice
// for one claim: with a journal (MASS_SUBMIT_JOURNAL_DIR), a run that died leaves each started application recorded
// unknown on the next start and each claimed-but-unstarted one run under its lease or put back in the queue (20261029190000;
// a database without it: ended as not sent).
export async function runLoop(o: {
  queue: ReturnType<typeof ownQueue>;
  resume: { path: string; sha256: string };
  writeFacts: (job: Job, facts: unknown) => Promise<string>;
  runEngine: RunEngine;
  stop: () => boolean;
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  emailCode?: EmailCodeEnv;
  pacing?: Pacing;
  journal?: Journal<Job>;
  drain?: boolean;
  // The hosts' refusals (mass-run.ts): absent, this process's own (localHostGate).
  gate?: HostGate;
}) {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? ((l: string) => console.log(l));
  const ran: { id: string; state: string; reason?: string; recorded: boolean }[] = [];
  // Recorded, or the database already closed the claim (its 15-minute sweep): either way nothing is left to record.
  const record = async (id: string, lease: string, state: string, evidence: Record<string, unknown>) => {
    for (let i = 0; i < 4; i++) {
      try {
        await o.queue.finish(id, lease, state, evidence);
        return true;
      } catch (e: any) {
        if (e?.message === "APPLY_CLAIM_CLOSED") return true;
        if (i < 3) await sleep(2_000 * 2 ** i);
      }
    }
    return false;
  };
  const say = (d: { id: string; state: string; reason?: string }, recorded: boolean) => {
    ran.push({ ...d, recorded });
    log(
      `${d.id}: ${d.state}${d.reason ? " (" + d.reason + ")" : ""}` +
        (recorded ? "" : "; NOT RECORDED: the queue will mark it unknown, the local evidence has the result"),
    );
  };
  await massRun<Job>({
    claim: (n) => o.queue.claim(n),
    onClaimError: (e: any) => {
      if (e?.message === "SIGNED_OUT") {
        log("Your sign-in has expired. Sign in again to keep going; nothing else was run.");
        return "stop";
      }
      log("The queue could not be read; asking again shortly. Nothing was run.");
      return "wait";
    },
    run: async (job, onStart) => {
      let recorded = false;
      const [d] = await runApproved({
        claim: async () => [job],
        finish: async (id, lease, state, evidence) => { recorded = await record(id, lease, state, evidence); },
        resumeFor: async () => o.resume,
        writeFacts: o.writeFacts,
        runEngine: o.runEngine,
        emailCode: o.emailCode,
        beforeEngine: () => onStart(),
        requeueRefusal: typeof (o.queue as any).requeue === "function",
        // FEATURE 14: the proof's pictures go with the receipt (a queue without the call keeps them on this computer).
        ...(typeof (o.queue as any).attach === "function"
          ? { attach: (j: Job, kind: string, sha: string, b64: string) => o.queue.attach(j.id, j.lease_token, kind, sha, b64) }
          : {}),
      });
      if (d.requeue) return { state: d.state, reason: d.reason ?? null, recorded: false, retry_after_s: d.retry_after_s ?? null, requeue: true, status: d.status ?? null };
      say(d, recorded);
      return { state: d.state, reason: d.reason ?? null, recorded, retry_after_s: d.retry_after_s ?? null };
    },
    // The site refused before anything was sent: the same job back to the queue until the site allows (its approval kept).
    // A database without the requeue records it not sent, as before. Retried like a finish; if it still cannot be written
    // the database's sweep closes the drive as unknown after 15 minutes (never driven again).
    requeue: async (job, q) => {
      const evidence = { reason: "HOST_RATE_LIMITED", ...(q.retryAfterS !== null ? { retry_after_s: q.retryAfterS } : {}) };
      for (let i = 0; i < 4; i++) {
        try {
          const nb = await (o.queue as any).requeue(job.id, job.lease_token, q.reason, q.retryAfterS, q.until);
          if (nb === null) {
            const recorded = await record(job.id, job.lease_token, "not_submitted", evidence);
            say({ id: job.id, state: "not_submitted", reason: "HOST_RATE_LIMITED" }, recorded);
            return { state: "not_submitted", reason: "HOST_RATE_LIMITED", recorded };
          }
          say({ id: job.id, state: "queued", reason: `the employer's site asked us to wait; nothing was sent; runs again after ${new Date(nb).toISOString()}` }, true);
          return { state: "queued", reason: "HOST_RATE_LIMITED", recorded: true, not_before: nb };
        } catch (e: any) {
          // The database already closed this claim (its 15-minute sweep): nothing is left to record.
          if (e?.message === "APPLY_CLAIM_CLOSED") return { state: "closed", reason: "HOST_RATE_LIMITED", recorded: true };
          if (i < 3) await sleep(2_000 * 2 ** i);
        }
      }
      say({ id: job.id, state: "unrecorded", reason: "HOST_RATE_LIMITED" }, false);
      return { state: "unrecorded", reason: "HOST_RATE_LIMITED", recorded: false };
    },
    // Claimed and never started (the scheduler cleared its journal line first): the same job back to the queue, to run
    // later once (owner: back off, then RESUME). A database that cannot put it back records it not sent, as before.
    putBack: typeof (o.queue as any).putBack !== "function" ? undefined : async (job, why, until) => {
      for (let i = 0; i < 4; i++) {
        try {
          const nb = await (o.queue as any).putBack(job.id, job.lease_token, why, until);
          if (nb === null) break;
          say({ id: job.id, state: "queued", reason: `not started (${why.split(":")[0]}); nothing was sent; it goes back to the queue and runs later` }, true);
          return { state: "queued", reason: why, recorded: true, not_before: nb };
        } catch (e: any) {
          if (e?.message === "APPLY_CLAIM_CLOSED") return { state: "closed", reason: why, recorded: true };
          if (i < 3) await sleep(2_000 * 2 ** i);
        }
      }
      const recorded = await record(job.id, job.lease_token, "not_submitted", { reason: why });
      say({ id: job.id, state: "not_submitted", reason: why }, recorded);
      return { state: "not_submitted", reason: why, recorded };
    },
    // Claimed and never started: nothing was sent.
    unstarted: async (job, why) => {
      const recorded = await record(job.id, job.lease_token, "not_submitted", { reason: why });
      say({ id: job.id, state: "not_submitted", reason: why }, recorded);
      return { state: "not_submitted", reason: why, recorded };
    },
    // Started by a run that died: it may have been sent, so it is unknown and never driven again.
    orphaned: async (job) => {
      const reason = "the worker stopped while this application ran; not retried";
      const recorded = await record(job.id, job.lease_token, "unknown_outcome", { reason });
      say({ id: job.id, state: "unknown_outcome", reason }, recorded);
      return { state: "unknown_outcome", reason, recorded };
    },
    // The command line passes the owner's pacing (MASS_SUBMIT_*: batches, several at once); a caller that gives none
    // keeps the earlier serial behaviour (claim one, run one, unpaced).
    pacing: o.pacing ?? pacingFrom(() => undefined, { concurrency: 1, claimBatch: 1, hostMax: 1, hostSpacingMs: 0 }),
    stop: o.stop,
    journal: o.journal,
    gate: o.gate,
    drain: o.drain,
    idleMs: o.idleMs ?? 30_000,
    sleep,
    log,
  });
  return ran;
}

// The engine as a child process: scripts/apply.ts with a fresh private evidence folder; reads its RESULT line and its
// evidence file. No result line is null (the caller decides what that means). The person is in the loop for anything
// that is theirs (a verification at the click, a code the employer emails): the engine's lines reach them as they are
// printed and their Enter reaches the engine.
// `isolate`: the engine's whole environment (the server's preparation: no database key or other secret reaches the engine,
// Chromium or a page); absent, the engine inherits this process's environment (the person's own computer).
export function engineRunner(o: { root: string; extra?: string[]; deno?: string; isolate?: Record<string, string> }): RunEngine {
  return async (args, env) => {
    const evidenceDir = await Deno.makeTempDir({ prefix: "trainee-evidence-" });
    await Deno.remove(evidenceDir);
    const child = new Deno.Command(o.deno || Deno.execPath(), {
      args: ["run", "-A", o.root + "/scripts/apply.ts", ...args, ...(o.extra || []), "--evidence-dir", evidenceDir],
      ...(o.isolate ? { clearEnv: true, env: { ...o.isolate, ...(env ?? {}) } } : env ? { env } : {}),
      stdin: "inherit",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const stderr = new Response(child.stderr).text();
    let out = "", pending = "";
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      out += chunk;
      const lines = (pending + chunk).split("\n");
      pending = lines.pop()!;
      for (const l of lines) if (!l.startsWith("RESULT ")) console.log(l);
    }
    await child.status;
    await stderr;
    const line = out.split("\n").filter((l) => l.startsWith("RESULT ")).at(-1);
    if (!line) return null;
    const result = JSON.parse(line.slice(7));
    let evidence = null;
    try {
      evidence = JSON.parse(await Deno.readTextFile(evidenceDir + "/evidence.json"));
    } catch { /* a refusal before the evidence folder was used */ }
    return { result, evidence };
  };
}

// WO-039: what a hand submission's evidence says was sent, for career_apply_record_own: the posting, the employer and the
// page it was sent from (the engine's own observation, never typed by hand), and its outcome. Only a run that sent the
// application is recorded, and the page's family must be the posting's.
export function handRecord(ev: any): { job_id: string; company: string; url: string; state: string } {
  const state = ev?.result?.state, posting = String(ev?.payload?.posting ?? ""), url = String(ev?.observation?.url_before ?? "");
  if (!["submitted_unconfirmed", "confirmed", "unknown_outcome"].includes(state) || !posting) {
    throw Error(`That run did not send an application (${state ?? "no result"})`);
  }
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) throw Error();
    host = u.hostname.toLowerCase();
  } catch {
    throw Error("The evidence has no https page the application was sent from");
  }
  const fam = /(^|\.)greenhouse\.io$/.test(host) ? "greenhouse" : /(^|\.)lever\.co$/.test(host) ? "lever"
    : /(^|\.)ashbyhq\.com$/.test(host) ? "ashby" : /(^|\.)smartrecruiters\.com$/.test(host) ? "smartrecruiters" : null;
  if (!fam || !posting.startsWith(fam + ":")) throw Error("The page and the posting in the evidence do not match");
  return { job_id: posting, company: String(ev.payload.company ?? ""), url, state };
}

// The person signs this computer in themselves, in a browser window on the Upmore app, the same way they sign in
// anywhere (their own password or Google, their own 2FA). The session is read only from the app's own origin, after
// they are signed in, from where the app keeps it (supabase-js: localStorage "sb-<project>-auth-token"); it stays in
// memory for this run and is never printed or written anywhere. The window is a fresh browser: nothing is loaded from
// or saved to disk. Ten minutes, then SIGN_IN_TIMEOUT.
export async function signInInBrowser(o: {
  appUrl: string;
  headed: boolean;
  timeoutMs?: number;
  say?: (line: string) => void;
}): Promise<{ access_token: string; refresh_token: string }> {
  const req = createRequire(import.meta.url);
  let pw: any = null;
  for (const t of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), "playwright"]) {
    if (!t) continue;
    try {
      pw = req(t);
      break;
    } catch { /* next */ }
  }
  if (!pw) throw Error("PLAYWRIGHT_UNRESOLVABLE");
  const app = new URL(o.appUrl);
  const chrome = Deno.env.get("UPMORE_CHROMIUM_PATH");
  const browser = await pw.chromium.launch({
    headless: !o.headed,
    ...(Deno.env.get("UPMORE_CHROMIUM_SANDBOX") === "off" ? { args: ["--no-sandbox"] } : { chromiumSandbox: true }),
    ...(chrome ? { executablePath: chrome } : {}),
  });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(app.href);
    (o.say ?? console.log)(
      "Sign in to Upmore in the browser window. Trainee reads only your session from the app's own page, keeps it " +
        "in memory for this run, and never prints or saves it.",
    );
    const deadline = Date.now() + (o.timeoutMs ?? 600_000);
    while (Date.now() < deadline) {
      let origin = "";
      try {
        origin = new URL(page.url()).origin;
      } catch { /* about:blank while navigating */ }
      if (origin === app.origin) {
        const raw = await page.evaluate(() => {
          const ls = (globalThis as any).localStorage;
          for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (/^sb-[a-z0-9]+-auth-token$/.test(k)) return ls.getItem(k);
          }
          return null;
        }).catch(() => null);
        if (raw) {
          try {
            const j = JSON.parse(raw), s = j.currentSession ?? j;
            if (typeof s.access_token === "string" && typeof s.refresh_token === "string" && s.refresh_token) {
              return { access_token: s.access_token, refresh_token: s.refresh_token };
            }
          } catch { /* not a session yet */ }
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw Error("SIGN_IN_TIMEOUT");
  } finally {
    await browser.close();
  }
}

// The person's own sign-in on this computer: UPMORE_SUPABASE_URL, UPMORE_SUPABASE_ANON_KEY (public) and either the
// person's session in UPMORE_ACCESS_TOKEN and UPMORE_REFRESH_TOKEN or, with UPMORE_APP_URL, their own sign-in in a
// browser window. Never printed. A service key is refused: it would let this computer act on other people's
// applications. Exits with a plain line when it cannot sign in.
async function signedInClient(cmd: string): Promise<any> {
  const env = (k: string) => Deno.env.get(k) || "";
  let [url, anon, access, refresh, appUrl] = [
    "UPMORE_SUPABASE_URL",
    "UPMORE_SUPABASE_ANON_KEY",
    "UPMORE_ACCESS_TOKEN",
    "UPMORE_REFRESH_TOKEN",
    "UPMORE_APP_URL",
  ].map(env);
  if (!url || !anon || (!(access && refresh) && !appUrl)) {
    console.error(
      `usage: approve-first.ts ${cmd} ..., with UPMORE_SUPABASE_URL, UPMORE_SUPABASE_ANON_KEY ` +
        "and UPMORE_APP_URL (you sign in in a browser window), or UPMORE_ACCESS_TOKEN and UPMORE_REFRESH_TOKEN",
    );
    Deno.exit(2);
  }
  const refuse = () => {
    console.error("SERVICE_KEY_REFUSED: this computer runs only your own applications; sign in as yourself.");
    Deno.exit(2);
  };
  if ([anon, access].some((t) => jwtRole(t) === "service_role")) refuse();
  if (!(access && refresh)) {
    try {
      ({ access_token: access, refresh_token: refresh } = await signInInBrowser({ appUrl, headed: true }));
    } catch (e: any) {
      console.error(`Not signed in (${e?.message ?? "error"}); nothing was run.`);
      Deno.exit(2);
    }
    if (jwtRole(access) === "service_role") refuse();
  }
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: true } });
  const signed = await client.auth.setSession({ access_token: access, refresh_token: refresh });
  if (signed.error || !signed.data.session) {
    console.error("Your sign-in has expired or was not accepted. Sign in again; nothing was run.");
    Deno.exit(2);
  }
  return client;
}

// Command line, for the owner's own machine (the first cohort): prepare one posting, or run one approved payload.
//   deno run -A workers/career-browser/approve-first.ts prepare <url> <facts.json> <resume.pdf> <epoch> <version>
//     [--tailored-resume <persona|base>]   (the resume is one tailor_resume made for this posting)
//   deno run -A workers/career-browser/approve-first.ts run-one <payload.json> <resume.pdf> [engine args...]
if (import.meta.main) {
  const [cmd, ...rest] = Deno.args;
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  if (cmd === "prepare") {
    const [url, facts, resume, epoch, version, ...more] = rest;
    const { tag, rest: extra } = takeResumeTag(more);
    const r = await prepare({
      url,
      factsPath: facts,
      resumePath: resume,
      account: { epoch: Number(epoch), version: Number(version) },
      now: Date.now(),
      runEngine: engineRunner({ root, extra }),
      resumeTag: tag,
    });
    console.log("PREPARED " + JSON.stringify(r));
  } else if (cmd === "run-one") {
    const [payloadFile, resume, ...extra] = rest;
    const payload = JSON.parse(await Deno.readTextFile(payloadFile));
    const bytes = await Deno.readFile(resume);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const dir = await Deno.makeTempDir({ prefix: "trainee-facts-" });
    const done = await runApproved({
      // One payload run by hand, outside the queue: nothing is recorded (finish does nothing), and its proof is bound to
      // a fresh id of the queue's own shape.
      claim: async () => [{ id: crypto.randomUUID(), lease_token: "local", url: payload.url, payload }],
      finish: async () => {},
      resumeFor: async () => ({ path: resume, sha256 }),
      writeFacts: async (_j, facts) => {
        const f = dir + "/facts.json";
        await Deno.writeTextFile(f, JSON.stringify(facts), { mode: 0o600 });
        return f;
      },
      runEngine: engineRunner({ root, extra }),
    });
    console.log("RAN " + JSON.stringify(done));
  } else if (cmd === "run") {
    const [resume, ...extra] = rest;
    if (!resume) {
      console.error("usage: approve-first.ts run <resume.pdf> [engine args]");
      Deno.exit(2);
    }
    const client = await signedInClient("run");
    const bytes = await Deno.readFile(resume);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const dir = await Deno.makeTempDir({ prefix: "trainee-facts-" });
    let stopping = false;
    Deno.addSignalListener("SIGINT", () => {
      stopping = true;
      console.log("Stopping after the applications running now; nothing new starts.");
    });
    // A visible browser or a hand-off may need the person at the window: one at a time. Otherwise as many at once as this
    // computer holds; a site slows only when it refuses (mass-run.ts; MASS_SUBMIT_* only if the owner sets a number).
    const attended = extra.some((a) => a === "--headed" || a === "--handoff" || a === "--person-submits");
    const pacing = pacingFrom((k) => Deno.env.get(k), attended ? { concurrency: 1 } : {});
    if (attended) pacing.concurrency = 1;
    console.log(attended
      ? "Running your approved applications one at a time (you may be needed at the window). Ctrl+C stops after the current one."
      : `Running your approved applications, up to ${pacing.concurrency} at once (what this computer can hold); a site that turns us away is given time before we try it again. Ctrl+C stops after the ones running.`);
    const journalDir = Deno.env.get("MASS_SUBMIT_JOURNAL_DIR") || `${Deno.env.get("HOME") || dir}/.local/state/upmore/apply-journal`;
    await runLoop({
      pacing,
      journal: fileJournal<Job>(journalDir),
      queue: ownQueue(client),
      resume: { path: resume, sha256 },
      writeFacts: async (job, facts) => {
        const f = `${dir}/${job.id}.json`;
        await Deno.writeTextFile(f, JSON.stringify(facts), { mode: 0o600 });
        return f;
      },
      runEngine: engineRunner({ root, extra }),
      stop: () => stopping,
      // WO-096: the code an employer emails after the approved submit is read from the person's own Gmail through the
      // career-email-code function, as them, for this drive only. Their current session (refreshed by the client); the
      // engine gets it in its environment, never on its command line.
      emailCode: async (job) => {
        const { data } = await client.auth.getSession();
        const access = data?.session?.access_token;
        return access ? { UPMORE_ACCESS_TOKEN: access, UPMORE_APPLY_JOB_ID: job.id, UPMORE_APPLY_LEASE: job.lease_token } : null;
      },
    });
  } else if (cmd === "prepare-batch") {
    // WO-022: the engine's dry run on each posting in a file (one https link a line), on this computer, signed in as the
    // person. Each ready application is stored for its card (career_apply_prepare_own: the database computes its hash and
    // checks it is theirs, for their current account); a posting with open questions is listed with them. Nothing is
    // sent: the card in their thread and their one text decide.
    const [urlsFile, facts, resume, ...more] = rest;
    const { tag, rest: extra } = takeResumeTag(more);
    if (!urlsFile || !facts || !resume) {
      console.error(
        "usage: approve-first.ts prepare-batch <urls.txt> <facts.json> <resume.pdf> [--tailored-resume <persona|base>] [engine args]",
      );
      Deno.exit(2);
    }
    const urls = [
      ...new Set(
        (await Deno.readTextFile(urlsFile)).split("\n").map((l) => l.trim()).filter((l) => /^https:\/\/\S+$/.test(l)),
      ),
    ];
    // D-MS-2: no product number. The file's size is the person's own choice; the employers' sites are paced below.
    if (!urls.length) {
      console.error("The file must hold at least one https job link, one a line.");
      Deno.exit(2);
    }
    const client = await signedInClient("prepare-batch");
    const acct = await client.rpc("career_apply_account_own");
    if (acct.error || !acct.data) {
      console.error("Your account has no job settings yet; text Trainee first. Nothing was prepared.");
      Deno.exit(2);
    }
    if (acct.data.paused) {
      console.error("Your account is paused; nothing was prepared.");
      Deno.exit(2);
    }
    // Ask once: what the person already answered by text goes in beside their facts file as their own answers, in a file
    // only they can read, removed when the batch ends. WO-102: the engine's contract keeps what agrees and asks again
    // where a texted answer and the file disagree (engineFacts; never factsWithTextAnswers, where the file silently won).
    const texted = await client.rpc("career_apply_answers_own");
    if (texted.error) console.log(`Your texted answers could not be read (${texted.error.message}); preparing without them.`);
    const rows: TextAnswer[] = texted.error ? [] : texted.data ?? [];
    const merged = engineFacts(JSON.parse(await Deno.readTextFile(facts)), rows);
    // The facts the contract keeps decide how far a new question's answer may travel (questionsToStore's haveFact).
    const trusted = trustedManifest({ owner: merged.user_id, file: merged, rows, resume: null }).answers;
    const factsDir = await Deno.makeTempDir({ prefix: "trainee-facts-" });
    const factsPath = `${factsDir}/facts.json`;
    await Deno.writeTextFile(factsPath, JSON.stringify(merged), { mode: 0o600 });
    const answered = new Set(rows.map((r) => r.key));
    let ready = 0, asked = 0;
    // Several dry runs at once across employers, each employer's site paced (MASS_SUBMIT_*; mass-run.ts). Nothing is sent.
    const limiter = new PacedLimiter(pacingFrom((k) => Deno.env.get(k)));
    // One person's question store, written one at a time so "asked once" holds across the runs in parallel.
    let asking: Promise<unknown> = Promise.resolve();
    try {
      await Promise.all(urls.map((url) => limiter.run(url, async () => {
        // One posting that fails never stops the others: it is named, and nothing was sent for it.
        const r = await prepare({
          url,
          factsPath,
          resumePath: resume,
          account: { epoch: Number(acct.data.epoch), version: Number(acct.data.version) },
          now: Date.now(),
          runEngine: engineRunner({ root, extra }),
          resumeTag: tag,
        }).catch((e) => ({ ready: false as const, result: { state: "not_submitted", reason: String(e?.message ?? e).slice(0, 200) } as any }));
        if (!r.ready) {
          const q = (r.result as any).fields?.length ? `: ${(r.result as any).fields.join("; ")}` : "";
          console.log(`NOT READY ${url} (${r.result.reason ?? r.result.state})${q}`);
          const ask = r.result.reason === "needs_answers" ? questionsToStore(r.result, { facts: trusted, answered }) : null;
          if (ask?.questions.length) {
            await (asking = asking.then(async () => {
              const put = await client.rpc("career_apply_questions_put_own", { p_job_id: ask.posting, p_questions: ask.questions });
              if (put.error) console.log(`  questions not stored (${put.error.message})`);
              else asked += ask.questions.length;
            }));
          }
          return;
        }
        const saved = await client.rpc("career_apply_prepare_own", { p_payload: r.payload, p_card_lines: r.card });
        if (saved.error) console.log(`NOT STORED ${url} (${saved.error.message})`);
        else {
          ready++;
          console.log(`READY ${url} (${r.payload.company})`);
        }
      })));
    } finally {
      await Deno.remove(factsDir, { recursive: true }).catch(() => {});
    }
    console.log(
      `${ready} of ${urls.length} ready. Text Trainee "show my applications" to see the card; nothing is sent before your yes.`,
    );
    if (asked) {
      console.log(
        `${asked} question${asked === 1 ? "" : "s"} only you can answer went to Trainee. Text "what do you need from me" to answer each once; then prepare again.`,
      );
    }
  } else if (cmd === "record") {
    // WO-039: a hand submission (scripts/apply.ts --headed --person-submits --submit, the owner's first trials) recorded
    // as this person's own computer's, so the employer's confirmation email can count it toward the cloud's gate. Every
    // value comes from the engine's own evidence, never from the command line.
    const [evidenceDir] = rest;
    if (!evidenceDir) {
      console.error("usage: approve-first.ts record <evidence folder printed by apply.ts>");
      Deno.exit(2);
    }
    let rec;
    try {
      rec = handRecord(JSON.parse(await Deno.readTextFile(`${evidenceDir}/evidence.json`)));
    } catch (e: any) {
      console.error(`${e?.message ?? e}; nothing was recorded.`);
      Deno.exit(2);
    }
    const client = await signedInClient("record");
    const r = await client.rpc("career_apply_record_own", { p_job_id: rec.job_id, p_company: rec.company, p_url: rec.url, p_state: rec.state });
    console.log(r.error ? `NOT RECORDED (${r.error.message})` : `RECORDED ${rec.job_id}: it counts once the employer's email confirms it.`);
  } else if (cmd === "cloud-resume") {
    // WO-039: the resume the cloud may send, by its hash, kept until the person turns the cloud off or erases.
    const [resume] = rest;
    if (!resume) {
      console.error("usage: approve-first.ts cloud-resume <resume.pdf>");
      Deno.exit(2);
    }
    const bytes = await Deno.readFile(resume);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const client = await signedInClient("cloud-resume");
    const r = await client.rpc("career_apply_cloud_resume_put_own", { p_filename: resume.split("/").pop(), p_b64: btoa(bin) });
    console.log(r.error ? `NOT STORED (${r.error.message})` : `STORED ${r.data}: the cloud can send applications approved with this resume.`);
  } else {
    console.error("usage: approve-first.ts prepare|run-one|run|prepare-batch|record|cloud-resume ...");
    Deno.exitCode = 2;
  }
}
