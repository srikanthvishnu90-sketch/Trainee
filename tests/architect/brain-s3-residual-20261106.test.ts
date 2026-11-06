// S3 residual (H021, H025). Offline. deno test -A --no-check tests/architect/brain-s3-residual-20261106.test.ts
import assertNode from "node:assert/strict";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";

const p = careerSystemPrompt("2026-11-06");
const rule = (start: RegExp) => {
  const i = p.search(start);
  assertNode.ok(i >= 0, `rule not found: ${start}`);
  const rest = p.slice(i + 1);
  const j = rest.search(/\n- /);
  return p.slice(i, j < 0 ? undefined : i + 1 + j);
};

Deno.test("S3-1: the nothing-sent rule does not mention overwhelmed; the acknowledgement comes first", () => {
  const r = rule(/When the\s+message is about acting on jobs/);
  assertNode.ok(!/overwhelmed/.test(r.split("When they say they are overwhelmed")[0]), "overwhelmed in trigger list");
  assertNode.ok(/acknowledgement rule below comes\s+first/.test(r));
});

Deno.test("S3-2: with no resume on file, no gaps are listed", () => {
  const r = rule(/With no resume on file/);
  assertNode.ok(/List NO gaps/.test(r));
  assertNode.ok(!/common gaps/.test(p));
  assertNode.ok(/live postings/.test(r));
});

Deno.test("S3-3: the overwhelmed rule forbids explaining missing profile items", () => {
  const r = rule(/They say they are overwhelmed/);
  assertNode.ok(/Never explain what is missing from their profile/.test(r));
  assertNode.ok(/list role types/.test(r));
});

Deno.test("S3-4: the overwhelmed ban on role lists applies only once a role is named; the track rule exists", () => {
  const r = rule(/They say they are overwhelmed/);
  assertNode.ok(/list role types to\s+someone overwhelmed who has already named the role they want/.test(r));
  assertNode.ok(/They ask you to track a posting: call track_application this turn \(never ask first\)/.test(p));
  assertNode.ok(/saved in their tracker/.test(p) && /without promising alerts you did not set/.test(p));
});

import { missingAck } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";

Deno.test("S3-5: missingAck", () => {
  const d = "I'm overwhelmed, just apply me to 3 roles";
  assertNode.equal(missingAck(d, "Nothing has been sent. Nothing matched. Which city?"), true);
  assertNode.equal(missingAck(d, "That sounds like a lot, and you don't have to carry it alone. Which city?"), false);
  assertNode.equal(missingAck(d, "I hear you. Which city?"), false);
  assertNode.equal(missingAck("find me intern roles", "Nothing has been sent. Which city?"), false);
});

Deno.test("S3-6: the rewrite carries the ack instruction once; a standing violation is kept and flagged", async () => {
  const seen: string[] = [];
  let i = 0;
  const bad = "Nothing has been sent. Nothing matched.\n\nWhich city?";
  const model = async (req: any) => { seen.push(JSON.stringify(req)); i++; return { content: [{ type: "text", text: bad }], stop_reason: "end_turn" }; };
  const r: any = await (runAgentTurn as any)({ system: "s", history: [], message: "I'm overwhelmed, just apply me to 3 roles", tools: [], model, ctx: { userId: "u", threadId: "t", now: 0, state: {} }, maxSteps: 4 });
  assertNode.equal(r.reply, bad);
  assertNode.deepEqual(r.flags, ["missing_ack"]);
  assertNode.equal(i, 2);
  assertNode.ok(seen.some((x) => /open with one short, warm sentence acknowledging that/.test(x)));
});
