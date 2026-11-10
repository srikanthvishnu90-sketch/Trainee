// deno-lint-ignore-file no-explicit-any
// R10 WO-H fix 14b, review items 7 and 8 (2026-11-09; spec B.6 continuation 4). Item 7: a thank-you for, or a recollection of, a
// meeting or interview needs that event to be in the past and with this recipient: an upcoming interview, or a meeting with someone
// else, never licenses "thank you for the interview" or "great talking with you". Item 8: once the thread's last reply was a draft,
// continuation 4's turns stay on the draft (the brain's draft_followup), never career_tailor's resume or outreach clarification;
// without a draft just shown, the same words keep their old route. No model, no network.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { draftContinuation, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { checkFollowup } from "../../supabase/functions/_shared/followup_draft.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const draft = (body: string, said: string, facts: string[] = [], kind: any = "thank_you") =>
  checkFollowup({ kind, recipient: "Maya", recipient_options: [], document: null, documents: [], tone: null, body }, { said, facts }) as any;

Deno.test("item 7: an upcoming interview is not a past one; nothing thanks Maya for it or recalls talking", () => {
  for (const said of ["I have an interview with Maya next week. Write a thank-you note to Maya.", "My interview with Maya is tomorrow, write her a thank-you note", "Write a note to Maya before my interview"]) {
    for (const body of ["Hi Maya, thank you for taking the time to interview me. Best, [Your name]", "Hi Maya, it was great talking with you. Best, [Your name]"]) {
      const r = draft(body, said);
      ok(r.status === "rewrite" && r.problems.some((p: string) => /has not happened yet or was with someone else/.test(p)), `${said} | ${body} -> ${JSON.stringify(r)}`);
    }
  }
});

Deno.test("item 7: a meeting with a different person is not a meeting with Maya", () => {
  const said = "I met Sam at the career fair yesterday. Write a thank-you note to Maya.";
  const r = draft("Hi Maya, it was great meeting you at the career fair. Best, [Your name]", said);
  ok(r.status === "rewrite" && r.problems.some((p: string) => /with Maya that has not happened yet or was with someone else/.test(p)), JSON.stringify(r));
  const i = draft("Hi Maya, thank you for the interview. Best, [Your name]", "I interviewed with Sam P. yesterday. Write a thank-you note to Maya.");
  eq(i.status, "rewrite", JSON.stringify(i));
});

Deno.test("item 7: a past event with Maya (in the person's words or a confirmed fact) still licenses the thanks", () => {
  for (const [said, facts] of [
    ["Write a thank-you note to Maya after my interview at Lakefront Transit Analytics", []],
    ["I met Maya at the career fair yesterday. Write her a thank-you note.", []],
    ["Write a thank-you note to Maya", ["Interviewed with Maya at Lakefront Transit Analytics last week"]],
    ["Write a thank-you note after my interview yesterday. It's for Maya.", []],
  ] as [string, string[]][]) {
    const body = /met Maya/.test(said) ? "Hi Maya, it was great meeting you at the career fair. Best, [Your name]" : "Hi Maya, thank you for taking the time to interview me. Best, [Your name]";
    const r = draft(body, said, facts);
    eq(r.status, "ok", `${said} -> ${JSON.stringify(r)}`);
  }
  eq(draft("Hi Maya, thanks again for our call. Best, [Your name]", "write a follow-up to Maya after our call", [], "follow_up").status, "ok");
});

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const ON = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
const TURNS = ["Send this one.", "The PDF to me.", "Now send it to Maya.", "Maya at the company.", "What would you say?", "Make it warmer.", "A little less formal."];
const decide = (m: string, drafted: boolean) => {
  const ctx = host.createTurnCtx({ userId: "u-d8", threadId: "t-d8", now: Date.UTC(2026, 10, 9, 15), snapshot: null, accountPersistence: true });
  if (drafted) (ctx as any)._draftThread = true;
  return stagedDecision({ env: ON, message: m, ctx, host, structured: false });
};

Deno.test("item 8: after a draft_followup turn, continuation 4's turns 1-7 stay on the draft (the brain), never career_tailor or outreach clarification", () => {
  for (const m of TURNS) {
    const d = decide(m, true);
    ok(d.brain === true && !["career_tailor", "outreach_clarification"].includes(d.reason), `${m}: ${JSON.stringify(d)}`);
  }
  for (const m of ["Make it warmer.", "Send this one.", "Now send it to Maya."]) eq(decide(m, true).reason, "draft_continuation", m);
});

Deno.test("item 8: without a draft just shown, the same words keep their old route ('Make it warmer.' is the resume's)", () => {
  ok(!decide("Make it warmer.", false).brain || decide("Make it warmer.", false).reason !== "draft_continuation");
  eq(decide("Make it warmer.", false).intent, "career_tailor", "make it warmer, with no draft, is a tailoring turn");
  for (const m of ["find data analyst internships in Chicago", "apply to the first one", "what's my status?"]) ok(!draftContinuation(m), m);
});
