// AN ASK TO SEE THE DRAFT STAYS CODE'S (architect, 2026-11-06; side effect of PR #544). #544 made a turn that forbids an
// action ("do not ... send") question-shaped, so the staged brain took it. "Don't send it, just show me the draft" forbids a
// send but ASKS FOR THE HELD DRAFT: it lost code's draft path (the held, unsent draft that needs approval) and got brain prose
// with no draft card. A negated send plus a show-the-draft ask is an instruction, not a question: it stays the router's.
// Genuine "don't do X" questions still go to the brain. Pure code: the real router bundle, the staged decision, no
// database, no model, no network.
//   deno test -A --no-check tests/architect/show-draft-stays-code.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { questionShaped, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-sdc", threadId: "t-sdc", now: Date.UTC(2026, 10, 6, 15), accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
const decide = (m: string, ctx = fresh()) => stagedDecision({ env: STAGED, message: m, ctx, host, structured: false });
console.error = () => {};

const SHOW_ASKS = [
  "Don't send it, just show me the draft",
  "Don't send it yet. Let me see the draft first",
  "Do not send anything, I just want to see the email first",
  "don't send it — show me the draft?",
  "Please don't email them yet, can I see the draft?",
  "Don't send that. Show me what you wrote",
  "Do not submit it, just show me the letter",
];

Deno.test("SDC-1 a negated send that asks to see the draft is an instruction, not a question", () => {
  for (const m of SHOW_ASKS) eq(questionShaped(m), false, m);
});

Deno.test("SDC-2 the staged decision keeps the show-the-draft ask on code's path (no draft yet: code's own clarification)", () => {
  for (const m of SHOW_ASKS) {
    const d = decide(m);
    ok(d.reason !== "question_shaped", `${m}: ${d.intent}/${d.reason}`);
  }
  const d = decide("Don't send it, just show me the draft");
  eq([d.brain, d.intent, d.reason], [false, "outreach_clarification", "action"]);
});

Deno.test("SDC-3 on a thread with a plan, the ask serves the held draft: unsent, code's product", () => {
  const ctx = fresh();
  host.runTurn("Help me network into healthcare consulting", ctx);
  const m = "Don't send it, just show me the draft";
  const d = decide(m, ctx);
  eq([d.brain, d.intent], [false, "outreach_draft"], `${d.intent}/${d.reason}`);
  const r = host.runTurn(m, ctx);
  eq(r.intent, "outreach_draft");
  ok(r.result?.draft, "the held draft is the turn's product");
  eq(r.result?.sends, 0, "nothing is sent");
  eq(r.result?.draft?.sends, 0, "the draft is held, unsent");
});

Deno.test("SDC-4 genuine 'don't do X' questions still go to the brain", () => {
  for (const m of [
    "never send email for me, just explain the options",
    "Don't send anything. What should a cold email to a recruiter say?",
    "Don't apply anywhere yet. What should I learn first?",
    "Do not send it. Why does the draft mention Acme?",
    "do not save this as a fact about me",
    "Don't email anyone, just show me how networking works",
  ]) ok(questionShaped(m), m);
  const d = decide("Don't send anything. What should a cold email to a recruiter say?");
  eq(d.brain, true, `${d.intent}/${d.reason}`);
});
