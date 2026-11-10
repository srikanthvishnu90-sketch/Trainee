// WO-G, owner order "fix everything in instinct's files": the two spec criteria with no test yet.
//   E-34  A login or verification wall during an application gives the person the exact next step, asks for and stores no
//         credential, and keeps the prepared work (spec B.3, E.3 #34). Proven here through the production cloud worker
//         (workers/career-cloud/worker.ts runCloudJob) and every surface that then speaks of the application.
//   E-39  "Submit job 2" after a clarification shows the payload review and never submits straight away (spec B.4, E.4
//         #39). Fail-first: on #632's head 780f788f, "Submit job 2" with no card as the thread's last word was not the card
//         turn's (parseCardReply read it as a name and cardTurn returned null), so no review was shown.
// Fake model only (none is called), no network, $0.
import assertNode from "node:assert/strict";
import { runCloudJob, type CloudQueue } from "../../workers/career-cloud/worker.ts";
import { factsFromPayload } from "../../workers/career-browser/approve-first.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { receiptText } from "../../supabase/functions/_shared/career_apply_receipts.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
import { closeoutLine, stageOf } from "../../supabase/functions/_shared/application_review.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { textOf } from "../../supabase/functions/_shared/file_kinds.ts";
import { CARD_INTENT, cardTurn } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { db, T, U as CARD_U } from "./mass-submit-fixture.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "dddddddd-0000-4000-8000-00000000e034", URL_ = "https://boards.greenhouse.io/wogwall/jobs/34", NOW = Date.parse("2026-11-09T16:00:00Z");
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
// Words that would ask the person for a credential, or carry one.
const ASKS_CREDENTIAL = /\b(?:send|text|tell|give|share|type|enter|reply with)\b[^.]*\b(?:password|passcode|one[- ]time code|verification code|login|credentials?)\b/i;

async function wall(reason: "login_required" | "captcha") {
  const resume = new TextEncoder().encode("%PDF-1.4\n% TEST resume E-34\n%%EOF\n"), sha = hex(await crypto.subtle.digest("SHA-256", resume));
  const base = { version: 1, user_id: U, job_id: "greenhouse:wogwall:34", company: "TEST Wall Co", title: "TEST Analyst", url: URL_, destination: URL_, resume_sha256: sha, page_field_names: [],
    fields: [{ name: "first_name", label: "First Name", value: "Ada", factId: "F-1" }, { name: "q1", label: "Why this role?", value: "I like turning data into decisions.", factId: "F-2" }],
    privacy_epoch: 1, account_version: 1, expires_at: new Date(Date.now() + 86_400_000).toISOString() };
  const payload = { ...base, engine_approval: await hashApplyPayload(factsFromPayload(base).saved) }, hash = await hashApplyPayload(payload);
  const job = { id: "J34", lease_token: "L34", user_id: U, company: "TEST Wall Co", url: URL_, job_id: base.job_id, payload, payload_hash: hash, approval_hash: hash, claimed_at: new Date().toISOString() };
  const finished: { state: string; evidence: Record<string, unknown> }[] = [], effects: string[] = [];
  const queue: CloudQueue = {
    claim: async () => [], gatePresent: async () => true, ask: async () => 0, authorize: async (_j, phase) => { effects.push(phase); },
    resume: async () => ({ b64: btoa(String.fromCharCode(...resume)), sha256: sha, filename: "TEST_Resume.pdf" }),
    finish: async (_j, state, evidence) => { finished.push({ state, evidence }); },
  };
  // The employer's page puts up a sign-in wall, or a verification check at Submit: the engine stops before the one Submit.
  const engine = async () => ({ result: { state: "needs_user", reason } , evidence: null });
  const out = await runCloudJob(job as any, { queue, runEngine: engine as any, log: () => {} });
  return { out, finished, effects, payload };
}

Deno.test("E-34: a login or verification wall gives the exact next step, asks for and stores no credential, and keeps the prepared work", async () => {
  for (const reason of ["login_required", "captcha"] as const) {
    const { out, finished, effects, payload } = await wall(reason);
    eq([out.state, finished.length, finished[0].state], ["needs_user", 1, "needs_user"], reason);
    assert(!effects.includes("before_effect"), `${reason}: Submit was never authorized, so nothing was sent`);
    const ev = finished[0].evidence;
    // The prepared work is kept: every approved answer, the resume by hash and the link where the person finishes it.
    eq((ev.answers as any[]).map((a) => [a.label, a.value]), payload.fields.map((f) => [f.label, f.value]), `${reason}: the approved answers are kept`);
    eq([ev.resume_sha256, ev.link], [payload.resume_sha256, URL_], `${reason}: the resume and the link are kept`);
    assert(!/password|passcode|one[- ]time|otp/i.test(JSON.stringify(ev)), `${reason}: no credential is stored`);
    const row = { id: "J34", company: "TEST Wall Co", title: "TEST Analyst", url: URL_, state: "needs_user", reason: String(ev.reason ?? (reason === "captcha" ? "bot_check" : reason)), created_at: "2026-11-09T15:00:00Z", updated_at: "2026-11-09T15:05:00Z" };
    for (const [where, text] of [["receipt", receiptText(row)], ["status", statusLine(row)], ["closeout", closeoutLine(row)]] as const) {
      assert(!ASKS_CREDENTIAL.test(text), `${reason} ${where}: never asks for a credential: ${text}`);
      assert(!/\bsubmitted\b(?! yet)/i.test(text.replace(/not submitted/i, "")), `${reason} ${where}: never says submitted: ${text}`);
    }
    const step = receiptText(row);
    if (reason === "login_required") assert(/sign in to an account first, and Trainee never signs in for you, so finish this one yourself at this link/.test(step) && step.includes(URL_), step);
    else assert(/open the link below, enter the answers you approved on the card, complete the check on the page, then press Submit/.test(step) && step.includes(URL_) && /Nothing reached TEST Wall Co/.test(step), step);
    eq(stageOf(row), "needs_you");
    // The proof File keeps the prepared answers visible and says it needs the person, never "submitted".
    const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW, records: { application: async () => ({ ...row, confirmation_id: null, payload }) as never } });
    const made = await svc.create(U, "application_proof", { application_id: "J34" });
    assert(made.ok, JSON.stringify(made));
    const file = textOf(store.all()[0], { now: NOW });
    assert(file.includes("Status: Needs you.") && file.includes("Why this role?: I like turning data into decisions.") && !/Status: Submitted/.test(file), file);
  }
});

Deno.test("E-39: 'Submit job 2' after a clarification shows the payload review; it never submits straight away", async () => {
  const w = db({ n: 3 });
  // The thread's last word is the clarification ("Do you mean submit the application for job 2, or send you the revised resume PDF?").
  const lastWord = { intent: "agent" as string | null };
  const store = { ...w.store, lastAssistantIntent: async () => lastWord.intent };
  for (const m of ["Submit job 2.", "submit job 2", "Send application #2", "approve job 2"]) {
    const r = await cardTurn({ message: m, userId: CARD_U, threadId: "TH", now: T, store });
    eq(r?.status, "shown", `${m}: ${r?.reply}`);
    assert(r!.reply.startsWith(`Nothing was submitted. Before anything goes to an employer, review #2 below: its exact answers and the resume it sends. To approve just that one, reply "only 2".`), r!.reply);
    for (const l of w.prepared[1].card_lines) assert(r!.reply.includes(l), `${m}: the card shows job 2's exact lines: ${l}`);
  }
  eq([w.answerCalls.length, w.queue.length], [0, 0], "nothing was approved or queued");
  // Only an explicit answer to the card it now shows approves, and only what it names.
  lastWord.intent = CARD_INTENT;
  const card = await w.store.latestOpen(CARD_U);
  const yes = await cardTurn({ message: "only 2", userId: CARD_U, threadId: "TH", now: T, store: { ...store, lastShownCard: async () => card!.id } });
  eq(yes?.status, "answered", yes?.reply);
  eq(w.queuedCompanies(), [w.prepared[1].company], "exactly job 2, after its review");
});
