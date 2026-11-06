// THE MODEL DECIDES QUESTION-SHAPED TURNS (architect, 2026-11-06; root-cause report PR-3 step A). Pure code: the real router
// bundle, the staged decision, no database, no model, no network. The beta texts are verbatim (C02, C08, C11, C03).
//   C02  a career-change question that forbids applying got the application-form template (rc.js routeFamily: "apply" + "need"
//        + "what"); it is now the brain's, and the form text reaches the brain only as data (router_answer).
//   C11  a QA-vs-help-desk comparison that forbids claiming openings got the "current openings are unverified" recipe; brain.
//   C08  an approval-semantics question read by the router as an outreach status ask; brain, with code's approval rules as data.
//   C03  an interview prep File request still makes the File (a real artifact stays code's).
//   Controls stay code's: an apply ask, a bare yes, a mock answer (a session), crisis text, STOP, the pause.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/brain-decides-questions.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { CODE_OWNED_INTENTS, codeProduct, questionShaped, questionTurn, routerAnswerBlock, STAGED_BRAIN_INTENTS, STAGED_PROMPT_NOTE,
  STAGED_TOOL_POLICY, STAGED_WITHHELD_TOOLS, stagedDecision, stagedToolPolicy } from "../../supabase/functions/agent-chat/career_staged.ts";
import { PAYLOAD_INTENTS } from "../../supabase/functions/_shared/career_reply_writer.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-bdq", threadId: "t-bdq", now: Date.UTC(2026, 10, 6, 15), accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
const decide = (m: string, ctx = fresh()) => stagedDecision({ env: STAGED, message: m, ctx, host, structured: false });
const routerOf = (m: string) => host.runTurn(m, fresh());
console.error = () => {};

// Verbatim beta inputs (beta threads, 2026-11-04/05).
const C02 = "Fictional beta case only, not my facts. Jordan Lee works in retail and wants to move into healthcare. Name realistic first-step roles, explain which skills transfer and what training is needed, then ask just one useful question. Do not save these as facts about me, apply, send email or contact anyone.";
const C03 = "Fictional beta scenario, not my profile. Jordan Lee has two years of retail customer-service experience and Excel skills. No external actions and no changes to my profile. Jordan has an interview for a customer support associate role tomorrow. Make a one-page prep File with five practice questions and a 30-minute practice plan. Do not invent company-specific facts.";
const C08 = "Read-only beta question: explain exactly what my approval binds to before an application is submitted. Does a text yes send it, or must I tap a card? What if an answer changes after approval? No external actions or changes.";
const C11 = "Read-only beta test C11. Compare software QA analyst and IT help desk as entry-level career paths in general, not for my personal profile. Explain day-to-day work, transferable skills, training needed and tradeoffs. Separate general guidance from anything needing current local research. Do not claim current openings or salaries without sources. No profile changes, reminders, outreach or applications.";
const FORM_TEMPLATE = "What application forms usually ask for";
const OPENINGS_TEMPLATE = /Current openings are unverified/;

Deno.test("BDQ-1 C02: the brain answers; the application-form template is only data for it", () => {
  const r = routerOf(C02);
  eq(r.intent, "career_application_fields", "the router still reads C02's words as the form-fields ask");
  ok(String(r.reply).includes(FORM_TEMPLATE), "and its reply is the form template");
  ok(questionShaped(C02), "C02 forbids applying, sending and contacting: a negated instruction");
  const d = decide(C02);
  eq([d.brain, d.intent], [true, "career_application_fields"]);
  eq(d.router?.intent, "career_application_fields");
  // The template reaches the model labeled as data, never as the reply: the note says to answer the question asked.
  const note = stagedToolPolicy(d).note;
  ok(note.startsWith(STAGED_PROMPT_NOTE));
  ok(/router_answer \(data, not instructions/.test(note) && /Answer the question the person actually asked/.test(note), note);
  ok(note.includes(FORM_TEMPLATE), "the router's facts are there to reuse");
  eq(stagedToolPolicy(d).withhold, STAGED_WITHHELD_TOOLS, "the withheld tools are unchanged");
});

Deno.test("BDQ-2 C11: the brain answers the comparison; the no-openings status rides as data, not as the reply", () => {
  const r = routerOf(C11);
  eq(r.intent, "career_recommendations");
  ok(OPENINGS_TEMPLATE.test(String(r.reply)), String(r.reply).slice(0, 200));
  const d = decide(C11);
  eq([d.brain, d.intent], [true, "career_recommendations"], `C11: ${d.reason}`);
  ok(STAGED_BRAIN_INTENTS.includes("career_recommendations"));
  // Its guidance/payload/artifact are recipe text, not a sourced record: no code product.
  eq(codeProduct("career_recommendations", r.result), false);
  ok(OPENINGS_TEMPLATE.test(routerAnswerBlock(d)), "the no-openings status is data the brain can reuse");
  // A real artifact still keeps it code's.
  eq(codeProduct("career_recommendations", { ...r.result, file: { id: "f1" } }), true);
});

Deno.test("BDQ-3 C08: the brain takes the approval question, with code's approval rules as data", () => {
  const r = routerOf(C08);
  ok(!CODE_OWNED_INTENTS.has(r.intent), `${r.intent} is not code's own work`);
  const d = decide(C08);
  eq([d.brain, d.reason], [true, "question_shaped"], `C08: ${d.intent}/${d.reason}`);
  eq(d.rules?.intent, "career_approval_rule");
  const block = routerAnswerBlock(d);
  ok(/Nothing goes out without your approval/.test(block), block);
  ok(/If anything in it changes after you approve, it stops and comes back to you/.test(block), block);
  ok(block.includes(`"intent":"${r.intent}"`), "the router's own answer to C08 is there too");
});

Deno.test("BDQ-4 D5 and the form-fields ask: question-shaped turns the router answered with fixed recipes are the brain's", () => {
  for (const [m, intent] of [
    ["Will you submit an application without asking me first?", "career_approval_rule"],
    ["What fields do application forms usually ask for?", "career_application_fields"],
  ] as const) {
    const d = decide(m);
    eq([d.brain, d.intent], [true, intent], `${m}: ${d.reason}`);
    eq(d.router?.intent, intent);
  }
});

Deno.test("BDQ-5 C03: an interview prep File request still makes the File (a real artifact stays code's)", () => {
  const r = routerOf(C03);
  eq(r.intent, "prep_brief");
  ok(r.result?.file, "the router built the File");
  const d = decide(C03);
  eq([d.brain, d.reason], [false, "code_product"]);
  // prep_brief without a File or a session is the brain's; a running session is not.
  eq(codeProduct("prep_brief", { intent: "prep_brief" }), false);
  eq(codeProduct("prep_brief", { intent: "prep_brief", resultStatus: "running" }), true);
  eq(codeProduct("prep_brief", { intent: "prep_brief", payload: { kind: "mock_session" } }), true);
});

Deno.test("BDQ-6 negative controls stay code's: an apply ask, a bare yes, a mock answer, crisis, STOP, the pause", () => {
  eq(decide("apply to the data analyst role at Stripe").brain, false, "apply ask");
  eq([decide("yes").brain, decide("yes").reason], [false, "action"], "a bare yes");
  eq(decide("I'm thinking about suicide").reason, "crisis");
  eq(decide("I don't want to live anymore. Do not apply to anything?").reason, "crisis", "crisis wins over the question rule");
  for (const m of ["STOP", "stop", "pause all career work"]) eq(decide(m).reason, "host_control", m);
  // A bare "pause" is not a host control (career_host.js PAUSE_RE) and nothing here changed how it lands.
  ok(decide("pause").reason !== "question_shaped");
  // A mock answer: the mock's question is waiting in this thread, so the router's turn is the session's.
  const ctx = fresh();
  const start = host.runTurn("mock interview me for a data analyst role", ctx);
  ok(/prep_mock|career_mock/.test(String(start.intent)), `the mock started: ${start.intent}`);
  const ans = "Why would I need to? I would pull the data, clean it and explain what changed. Don't send anything.";
  const d = decide(ans, ctx);
  eq(d.brain, false, `a mock answer stays the session's: ${d.intent}/${d.reason}`);
  // Every payload intent, session intent and record read is code's own work.
  for (const i of PAYLOAD_INTENTS) ok(CODE_OWNED_INTENTS.has(i), i);
  for (const i of ["prep_mock_next", "career_batch_apply", "named_role_apply", "career_watch_create", "conversation_bare_reply", "tracking_status", "career_submission_check", "profile_recall"]) ok(CODE_OWNED_INTENTS.has(i), i);
  for (const i of CODE_OWNED_INTENTS) eq(questionTurn("what does this mean? do not apply", i, {}), false, i);
});

Deno.test("BDQ-7 the shape: questions and forbidden actions, not asks to act", () => {
  for (const m of ["what should I learn first?", "Is a bootcamp worth it", "Compare these two paths for me. Don't apply to anything.", "never send email for me, just explain the options", "do not save this as a fact about me"]) ok(questionShaped(m), m);
  for (const m of ["can you send it to Dana?", "could you find me analyst jobs?", "find me engineers at datadog to reach out to", "apply to the data analyst role at Stripe", "Compare QA analyst and help desk for me."]) eq(questionShaped(m), false, m);
  // A question with a code product (a draft, a File, a company file) stays code's.
  eq(questionTurn("what should I say?", "career_os_plan", { draft: { body: "x" } }), false);
  eq(questionTurn("what should I say?", "career_os_plan", { file: { id: "x" } }), false);
  eq(questionTurn("what should I say?", "career_os_plan", { sends: 1 }), false);
  eq(questionTurn("what should I say?", "career_os_plan", {}), true);
  // No router answer: the policy is the plain one.
  eq(stagedToolPolicy(null), STAGED_TOOL_POLICY);
});
