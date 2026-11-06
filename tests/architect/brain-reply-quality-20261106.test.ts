// BRAIN ONE-ASK (release 7 S3: H001, H025, H035, H021, H027). Offline: no model, no network. The real measurement is S3.
//   deno test -A --no-check tests/architect/brain-reply-quality-20261106.test.ts
import assertNode from "node:assert/strict";
import { multiAsk, trimToOneAsk, unbackedPromises } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";
import { STAGED_PROMPT_NOTE, routerAnswerBlock } from "../../supabase/functions/agent-chat/career_staged.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);

Deno.test("BR-1 H025: two questions in one reply are reduced to the first", () => {
  const r = "The search came back empty.\n\nWhat city or remote setting should I search? Do you have a school or graduation date I should use?";
  eq(multiAsk(r).extra.length, 1);
  const t = trimToOneAsk(r);
  eq((t.match(/\?/g) || []).length, 1);
  assert(t.includes("What city or remote setting should I search?") && t.includes("came back empty"));
});

Deno.test("BR-2 H001: a conjoined ask is flagged, a single ask is not", () => {
  eq(multiAsk("Hi, I'm Trainee. What role and city are you after?").conjoined.length, 1);
  eq(multiAsk("Hi, I'm Trainee. What role are you after?").conjoined.length, 0);
  eq(multiAsk("Do you have a school and graduation date I should use?").conjoined.length, 1);
  eq(multiAsk("What are the pros and cons of a PhD?").conjoined.length, 0);
});

Deno.test("BR-3: list items and quoted drafts are not counted as extra asks", () => {
  const r = "Practice these:\n1. Tell me about yourself?\n2. Why this firm?\n\nWhich one first?";
  eq(multiAsk(r).extra.length, 0);
  eq(trimToOneAsk(r), r);
});

Deno.test("BR-4 H025/H035: a promise with no matching tool result is flagged; a backed one, an offer and a negation are not", () => {
  eq(unbackedPromises("I'll set a job alert for these roles so new postings reach you.", []).map((c) => c.kind), ["an alert promised"]);
  eq(unbackedPromises("I'll text you when they appear.", []).length, 1);
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

// The loop: a two-question final gets one rewrite request; if it stands, the extra question is trimmed.
function scripted(texts: string[], seenInputs: string[]) {
  let i = 0;
  return async (req: any) => { seenInputs.push(JSON.stringify(req)); const t = texts[Math.min(i++, texts.length - 1)]; return { content: [{ type: "text", text: t }], stop_reason: "end_turn" }; };
}
Deno.test("BR-6: the loop asks the model once, then trims a standing second question", async () => {
  const seen: string[] = [];
  const two = "Nothing matched. What city should I search? Do you have a school I should use?";
  const model = scripted([two, two], seen);
  const r: any = await (runAgentTurn as any)({ system: "s", history: [], message: "I feel overwhelmed, find me software intern roles", tools: [], model, ctx: { userId: "u", threadId: "t", now: 0, state: {} }, maxSteps: 4 });
  eq((String(r.reply).match(/\?/g) || []).length, 1, r.reply);
  assert(seen.length >= 2, "one rewrite was requested");
  assert(seen.some((x) => /more than one thing/.test(x)));
});
