// Live-12 C22 (2026-11-16; evals/mirror/instinct-wa-batch1/): "what's the going rate for swe interns in chicago, hourly", sent right
// after a behavioral practice question (C21), was read as the answer to that question (turn_notes.ts practiceAnswerOf: no "?", the
// last ask a practice ask), so the brain was told to review it as a practice answer. A question about pay or a going rate is a new
// ask, never an answer; a real answer in the same place still is one.
//   PP-1  the pay asks (by their shape: a question or request) are not practice answers; answers are, negotiation stories included
//   PP-2  through the real brain turn, C22's prompt carries no practice-answer note
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/practice-pay-ask-20261116.test.ts
import assertNode from "node:assert/strict";
import { practiceAnswerOf } from "../../../supabase/functions/_shared/agent/turn_notes.ts";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const C21 = "ok behavioral round: ask me 'tell me about a time you failed' and then roast my answer";
const ASKED = "Tell me about a time you failed. Give me the situation, what you got wrong, what it cost and what you changed. I'll roast it.";
const history = [{ role: "user", content: C21 }, { role: "assistant", content: ASKED }];

Deno.test("PP-1 a question about pay or a going rate after a practice question is a new ask; a real answer is still an answer", () => {
  for (const m of ["what's the going rate for swe interns in chicago, hourly", "how much do data analysts make in denver", "whats the salary range for new grad pms at stripe", "typical hourly pay for nursing assistants"]) ok(!practiceAnswerOf(m, history), m);
  for (const m of ["uhh probably when one of my first agency clients didn't like the site i made. i redid it and learned to communicate better", "i missed a deadline on a group project because i didn't flag a blocker early, it cost us a grade and now i raise blockers the same day"]) ok(practiceAnswerOf(m, history), m);
  // Review of f7abd6c30: the shape decides, not the words. A negotiation story that mentions pay or a market rate is an answer.
  const nego = [{ role: "user", content: "ok behavioral round: ask me 'tell me about a time you negotiated' and then roast my answer" }, { role: "assistant", content: "Tell me about a time you negotiated something hard. Give me the situation and what you did." }];
  for (const m of [
    "At Rallyup I negotiated the pay for our two part-time coaches: I benchmarked the market rate in our city, showed the owner the numbers, and we settled at $22 an hour, which kept both of them through the season.",
    "I pushed my manager to raise salaries for the team after showing the average salary data, and he agreed.",
    "At Pixelforge a client wanted to cut our fee; I showed them what they would pay for a rebuild elsewhere and we kept the price.",
  ]) ok(practiceAnswerOf(m, nego), m);
  ok(!practiceAnswerOf("what's the going rate for swe interns in chicago, hourly", nego), "a pay question after it is still a new ask");
});

Deno.test("PP-2 through the real brain turn, C22's prompt carries no practice-answer note", async () => {
  const seen: any[] = [];
  await agentTurn({ message: "what's the going rate for swe interns in chicago, hourly", history, stores: { profile: null }, userId: "u-pp2", threadId: "th", now: Date.parse("2026-11-16T15:00:00Z"),
    model: async (p: any) => { seen.push(p); return { content: [{ type: "text", text: "I don't have a verified figure for that yet." }], stop_reason: "end_turn" }; } } as any);
  ok(seen.length > 0 && !/THEY ARE ANSWERING THE PRACTICE QUESTION/.test(String(seen[0].system)), "C22 was read as a practice answer");
});
