// ADVICE QUESTIONS (2026-11-01): a question about networking or interviews goes to the staged brain; an instruction (build a
// list, email someone, apply, submit, send) stays on code's path, where every external effect needs the person's approval of
// the exact payload. Runs the real staged decision on the in-flight world (evals/career/world.ts), no model, no spend.
import assertNode from "node:assert/strict";
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
import { openWorld, USER } from "../../evals/career/world.ts";
import { adviceQuestion, STAGED_WITHHELD_TOOLS, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";

const W = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const env = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };

async function decide(message: string) {
  const w = await openWorld(W);
  const ctx: any = w.H.createTurnCtx({ userId: USER, threadId: "A", now: w.now, accountPersistence: true, snapshot: w.th("A").snapshot, account: w.account, postings: w.kb });
  return stagedDecision({ env, message, ctx, host: w.H, structured: false });
}

Deno.test("advice questions about outreach and interviews go to the brain", async () => {
  for (const [m, intent] of [
    ["how do i network into investment banking with no connections", "outreach_clarification"],
    ["whats a good subject line for a cold email to a recruiter", "outreach_clarification"],
    ["should i message alumni on linkedin or email them?", "outreach_clarification"],
    ["what questions should i ask at the end of an interview", "prep_brief"],
    ["how should i prepare for a case interview", "prep_brief"],
  ] as const) {
    const d = await decide(m);
    assertEquals([d.brain, d.reason, d.intent], [true, "advice_question", intent], m);
  }
});

Deno.test("instructions stay on code's path: list building, emailing someone, a named company's prep", async () => {
  for (const m of ["find me software engineers at datadog to reach out to", "build me a list of 20 analysts at goldman", "email the recruiter at stripe",
    "help me message a recruiter at stripe", "prep me for my stripe interview"]) {
    const d = await decide(m);
    assertEquals(d.brain, false, `${m}: ${d.reason}`);
  }
});

Deno.test("an approval-gated action is never an advice question, whatever the router answered", () => {
  const plan = { intent: "outreach_clarification", payload: { kind: "campaign_plan" }, sends: 0 };
  for (const m of ["send the jordan email", "apply to brex", "submit figma", "email them all", "queue the stripe application", "please send it", "can you send emails to 100 recruiters for me",
    "can you apply to every data analyst job?", "could you draft and send a note to the plaid recruiter?",
    "how about you build me a list of alumni to email?", "what if you find 30 recruiters and get their names?"]) {
    assertEquals(adviceQuestion(m, "outreach_clarification", plan), false, m);
    assertEquals(adviceQuestion(m, "prep_brief", {}), false, m);
  }
  // A result that carries a draft, a send, an offer or a company file stays code's even for a question.
  for (const r of [{ draft: { body: "x" } }, { sends: 1 }, { offer: {} }, { company: "Stripe" }, { resultStatus: "running" }, { question: { q: "x" } }, { payload: { kind: "mock_session" } }]) {
    assertEquals(adviceQuestion("how should i prepare for a case interview", "prep_brief", r), false, JSON.stringify(r));
  }
  // Other intents are untouched by this rule.
  assertEquals(adviceQuestion("how do i get my applications sent?", "career_batch_apply", {}), false);
  // The brain path holds no tool that applies, starts or stops alerts, or checks contacts (STAGED_WITHHELD_TOOLS).
  for (const t of ["queue_applications", "set_job_alerts", "stop_job_alerts", "verify_contacts"]) assert(STAGED_WITHHELD_TOOLS.includes(t), t);
});
