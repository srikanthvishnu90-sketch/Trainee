// BRAIN ONE-ASK (release 7 S3: H001, H025, H035, H021, H027). Offline: no model, no network. The real measurement is S3.
//   deno test -A --no-check tests/architect/brain-reply-quality-20261106.test.ts
import assertNode from "node:assert/strict";
import { multiAsk, unbackedPromises } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";
import { STAGED_PROMPT_NOTE, routerAnswerBlock } from "../../supabase/functions/agent-chat/career_staged.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);

// Replies the guard must never flag (and the loop never alters): quoted interview questions, practice lists (bulleted, numbered,
// bare lines, inline), rhetorical openers, reflective questions earlier in the reply, a single ask.
const KEEP = [
  'For a final round they may ask "why us?" and "why this role?". Prepare a story for each. Which round is it?',
  "Practice these:\n1. Tell me about yourself?\n2. Why this firm?\n\nWhich one first?",
  "Practice out loud:\nWhy this firm?\nWhy this role?\nWhat is your biggest weakness?",
  "Try: Why this firm? Why this role? What is your biggest weakness?",
  "Worried about gaps? Many people are. What role are you after?",
  "Should you take it? What would you give up? Those decide it.\n\nWhich offer is it?",
  "What are the pros and cons of a PhD? Both matter here.",
  "Nothing matched. What city or remote setting should I search?",
  "I'll keep an eye on it while we talk. Which role?",
  "Here's the email:\n\nSubject: Follow-up\n\nHi Dana,\n\nCould you share the timeline? What should I prepare?\n\nI'll email you my availability tomorrow.\n\nThanks,\nSam",
  "Draft: Hi Dana, could you share the timeline? What should I prepare? I'll text you my availability tomorrow.",
];
Deno.test("BR-1: a reviewer's must-not-change inputs are not flagged", () => {
  for (const r of KEEP) assert(!multiAsk(r), r);
  for (const r of KEEP) eq(unbackedPromises(r, []).length, 0, r);
});

Deno.test("BR-2 true positives: a conjoined or doubled ask at the end of the reply is flagged", () => {
  assert(multiAsk("Hi, I'm Trainee. What role and city are you after?"));
  assert(multiAsk("The search came back empty.\n\nWhat city should I search? Do you have a school I should use?"));
  assert(multiAsk("Do you have a school and graduation date I should use?"));
  assert(multiAsk("Nothing matched.\n\nWhat city are you targeting?\nDo you have a school I should use?"), "two closing lines");
});

Deno.test("BR-3: a promise is judged in its own clause; a draft's content is never checked", () => {
  eq(unbackedPromises("Nothing matched, so I'll set a job alert for new roles.", []).length, 1);
  eq(unbackedPromises("Nothing matched. I'll set a job alert for new roles.", []).length, 1);
  eq(unbackedPromises("I'll set a job alert for you, but I won't send anything.", []).length, 1);
  eq(unbackedPromises("I won't set a job alert.", []).length, 0);
  eq(unbackedPromises("I'll text you my availability, Dana.\n\nHere's the email:\n\nHi Dana, I'll text you tomorrow.", []).length, 1);
  eq(unbackedPromises("Here's the email:\n\nHi Dana, I'll text you tomorrow.", []).length, 0);
});

Deno.test("BR-4: an alert promise with no matching tool result is flagged; a backed one, an offer, a negation, a question are not", () => {
  eq(unbackedPromises("I'll set a job alert for you.", []).map((c) => c.kind), ["an alert promised"]);
  eq(unbackedPromises("I'll text you when they appear.", []).length, 1);
  eq(unbackedPromises("I'll watch for new roles.", []).length, 1);
  eq(unbackedPromises("I'll start job alerts for these.", []).length, 1);
  eq(unbackedPromises("Here's the email:\n\nHi Dana, I'll start job alerts for you.", []).length, 0);
  eq(unbackedPromises("I won't watch for new roles.", []).length, 0);
  eq(unbackedPromises("If you want, I'll start job alerts.", []).length, 0);
  eq(unbackedPromises("I'll watch for postings like this.", []).length, 1);
  eq(unbackedPromises("I'll set a job alert for these roles.", [{ name: "set_job_alerts", ok: true }]).length, 0);
  eq(unbackedPromises("I'll set a job alert for these roles.", [{ name: "set_job_alerts", ok: false }]).length, 1);
  eq(unbackedPromises("If you want, I'll set a job alert.", []).length, 0);
  eq(unbackedPromises("I won't send anything without your yes.", []).length, 0);
  eq(unbackedPromises("Should I set a job alert?", []).length, 0);
});

Deno.test("BR-5: the prompt carries the new instructions", () => {
  const p = careerSystemPrompt("2026-11-06");
  assert(/asks for ONE thing/.test(p), "one thing");
  assert(/never "X and Y"/.test(p), "no conjoined ask");
  assert(/State only what happened this turn/.test(p) && /I'll set a job alert/.test(p), "no promises");
  assert(/nothing goes out without their yes/.test(p), "says nothing sent");
  assert(/With no resume on file, never present gaps as findings/.test(p) && /common gaps for this role/.test(p), "no resume gaps");
  assert(/Interview prep/.test(p) && /timeline/.test(p) && /before any clarifying question/.test(p), "prep plan first");
  assert(!/the role and city they are after/.test(p), "the role-and-city line is gone");
  assert(/never say they were done or that you will do them/.test(STAGED_PROMPT_NOTE) && /at most one question/.test(STAGED_PROMPT_NOTE));
  assert(/yours asks at most one thing and promises none/.test(routerAnswerBlock({ brain: true, router: { intent: "x", reply: "r" } } as any)));
});

// The loop: a flagged draft gets one rewrite request; if it stands, it is kept byte-for-byte.
function scripted(texts: string[], seenInputs: string[]) {
  let i = 0;
  return async (req: any) => { seenInputs.push(JSON.stringify(req)); const t = texts[Math.min(i++, texts.length - 1)]; return { content: [{ type: "text", text: t }], stop_reason: "end_turn" }; };
}
const run = (model: any) => (runAgentTurn as any)({ system: "s", history: [], message: "I feel overwhelmed, find me software intern roles", tools: [], model, ctx: { userId: "u", threadId: "t", now: 0, state: {} }, maxSteps: 4 });
Deno.test("BR-6: the loop asks the model once, then keeps a standing draft unchanged", async () => {
  const seen: string[] = [];
  const two = "Nothing matched. I'll set a job alert for you.\n\nWhat city should I search? Do you have a school I should use?";
  const r: any = await run(scripted([two, two], seen));
  eq(r.reply, two);
  eq(r.flags, ["many_asks", "unbacked_promise"]);
  eq(seen.length, 2, "one rewrite was requested");
  assert(seen.some((x) => /more than one thing/.test(x)));
});
Deno.test("BR-7: the rewrite replaces the draft when the model fixes it; unflagged replies make no extra call", async () => {
  const seen: string[] = [];
  const r: any = await run(scripted(["What role and city are you after?", "What role are you after?"], seen));
  eq(r.reply, "What role are you after?");
  const seen2: string[] = [];
  for (const k of KEEP) { seen2.length = 0; const q: any = await run(scripted([k], seen2)); eq(q.reply, k); eq(seen2.length, 1); }
});
Deno.test("BR-8: a conjoined ask that survives the rewrite is kept unchanged and flagged", async () => {
  const seen: string[] = [];
  const t = "Hi, I'm Trainee.\n\nWhat role and city are you after?";
  const r: any = await run(scripted([t, t], seen));
  eq(r.reply, t); eq(r.flags, ["many_asks"]); eq(seen.length, 2);
  const ok: any = await run(scripted(["What role are you after?"], []));
  eq(ok.flags, undefined);
});
