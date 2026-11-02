// MASS APPLY (2026-11-01): the engine's browser itself failing (DRIVER_ERROR: a crash or a timeout under load, never the
// employer's page) is ours to recover from, honestly:
//   send     driven once more under the same lease ONLY when the run provably never reached Submit (the Submit
//            authorization, asked right before the one click, was never requested); after Submit was reached it is
//            recorded unknown and never resent.
//   prepare  a dry run (never submits) is tried once more at once; twice failed is recorded as OUR error (not "the
//            employer's form refused"), and prepare_candidates retries an error within the hour, not after 7 days.
import assertNode from "node:assert/strict";
import { runCloudJob } from "../../workers/career-cloud/worker.ts";
import { prepareOne } from "../../workers/career-browser/prepare-ahead.ts";
import { authorizer, cardBound } from "../helpers/cloud_card_auth.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

async function send(script: ("crash_before_submit" | "crash_after_submit" | "ok")[]) {
  const bytes = new TextEncoder().encode("%PDF-1.4 TEST");
  const sha = await hex(bytes);
  const job = await cardBound({ id: "job-1", lease_token: "lease-1", user_id: "TEST-owner", company: "Test Co", url: "https://jobs.lever.co/test-co/de-1",
    payload: { posting: "lever:test-co:de-1", user_id: "TEST-owner", company: "Test Co", url: "https://jobs.lever.co/test-co/de-1", engine_approval: "c".repeat(64), resume_sha256: sha, fields: [] } });
  const auth = authorizer(), finished: any[] = [];
  const queue: any = { claim: async () => [], gatePresent: async () => true, authorize: auth.authorize,
    resume: async () => ({ filename: "resume.pdf", sha256: sha, b64: btoa(String.fromCharCode(...bytes)) }),
    finish: async (_j: unknown, state: string, evidence: any) => { finished.push({ state, reason: evidence?.reason ?? null }); } };
  let runs = 0;
  const runEngine = async (_a: string[], _e: unknown, controls?: { beforeEffect?: () => Promise<void> }) => {
    const step = script[Math.min(runs++, script.length - 1)];
    if (step === "crash_before_submit") return { result: { state: "not_submitted", reason: "DRIVER_ERROR" }, evidence: null };
    await controls?.beforeEffect?.();
    if (step === "crash_after_submit") return { result: { state: "not_submitted", reason: "DRIVER_ERROR" }, evidence: null };
    return { result: { state: "submitted_unconfirmed", reason: "employer confirmation on the page" }, evidence: null };
  };
  await runCloudJob(job as any, { queue, runEngine: runEngine as any, log: () => {} });
  return { runs, finished, phases: auth.calls.map((c) => c.phase) };
}

Deno.test("send: a browser crash before Submit is driven once more (authorized again); the second run's outcome is recorded", async () => {
  const r = await send(["crash_before_submit", "ok"]);
  eq(r.runs, 2);
  eq(r.finished.map((f) => f.state), ["submitted_unconfirmed"]);
  eq(r.phases.filter((p) => p === "before_engine").length >= 3, true, `authorized before each run: ${r.phases}`);
});

Deno.test("send: twice before Submit is not sent, once more is never tried (no loop)", async () => {
  const r = await send(["crash_before_submit", "crash_before_submit", "ok"]);
  eq([r.runs, r.finished.map((f) => f.state)], [2, ["not_submitted"]]);
});

Deno.test("send: a crash AFTER Submit was reached is unknown, never resent", async () => {
  const r = await send(["crash_after_submit", "ok"]);
  eq(r.runs, 1, "never driven again");
  eq(r.finished.map((f) => f.state), ["unknown_outcome"]);
});

Deno.test("send: a crash before Submit, then the retry crashes AFTER Submit: unknown (never 'not sent', so never sent twice)", async () => {
  const r = await send(["crash_before_submit", "crash_after_submit", "ok"]);
  eq(r.runs, 2, "no third run");
  eq(r.finished, [{ state: "unknown_outcome", reason: "DRIVER_ERROR_AT_SUBMIT" }]);
});

Deno.test("prepare: twice DRIVER_ERROR is recorded as our error (not 'refused'); an employer's refusal stays refused, not retried", async () => {
  const run = async (reasons: string[]) => {
    let runs = 0;
    const recorded: string[] = [];
    const db = { rpc: async (name: string, args: any) => { if (name === "career_apply_prepare_attempt_for") recorded.push(args.p_outcome); return { data: name === "career_apply_answers_for" ? [] : null, error: null }; } };
    const out = await prepareOne({ db, resumeFor: async () => ({ path: "/dev/null", sha256: "a".repeat(64), tag: null }),
      runEngine: async () => ({ result: { state: "not_submitted", reason: reasons[Math.min(runs++, reasons.length - 1)] }, evidence: {} }) } as any,
      { user_id: "u", job_id: "lever:acme:1", company: "Acme", url: "https://jobs.lever.co/acme/1", epoch: 0, version: 0 } as any);
    return { out, runs, recorded };
  };
  const a = await run(["DRIVER_ERROR"]);
  eq([a.runs, a.out.outcome, a.recorded], [2, "error", ["error"]]);
  const b = await run(["IDENTITY_NUMBER_REQUESTED"]);
  eq([b.runs, b.out.outcome], [1, "refused"]);
});
