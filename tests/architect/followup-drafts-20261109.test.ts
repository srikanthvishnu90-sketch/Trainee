// deno-lint-ignore-file no-explicit-any require-await
// R10 WO-H fix 14b (owner order 2026-11-09; spec B.6 continuation 4, E.4 items 36-41): follow-up and thank-you drafts. Replays the
// spec's turns through the agent brain (agentTurn) with a scripted model ($0): an ambiguous document or recipient gets one short
// question and no draft; "make it warmer" never licenses an invented meeting, offer, referral or relationship; every figure and
// name in a draft is the person's own or a confirmed fact; a company name is never turned into a guessed address. Nothing is sent.
// Every test here fails on trunk (no draft_followup tool; "write a thank-you note" was routed to the tracking log).
import assertNode from "node:assert/strict";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { followupDraftAsk } from "../../supabase/functions/agent-chat/career_staged.ts";
import { checkFollowup, enforceFollowupAsk } from "../../supabase/functions/_shared/followup_draft.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-09T15:00:00Z");
const FACTS = [{ kind: "project", value: "Built a Python screening workflow that combined company, revenue and contact data across 100+ targets", status: "confirmed" },
  { kind: "gpa", value: "GPA 3.9", needs_confirmation: true }]; // unconfirmed: never usable

// The scripted brain: each step is a draft_followup input or a text reply; after the steps it ends its turn.
async function turn(message: string, history: any[], steps: (Record<string, unknown> | string)[]) {
  let k = 0;
  const model = async () => {
    const s = k < steps.length ? steps[k++] : "Here it is.";
    return typeof s === "string" ? { content: [{ type: "text", text: s }], stop_reason: "end_turn" } : { content: [{ type: "tool_use", id: `d${k}`, name: "draft_followup", input: s }], stop_reason: "tool_use" };
  };
  const t: any = await agentTurn({ message, history, stores: { profile: { facts: FACTS } }, userId: "u1", threadId: "t1", now: NOW, model } as any);
  return { t, calls: t.tool_calls.filter((c: any) => c.name === "draft_followup") };
}

Deno.test("WO-H/D1 continuation 4: an ambiguous document gets one short question and no draft", async () => {
  const { t, calls } = await turn("Write a short note to go with this one.", [{ role: "user", content: "Make the resume one page." }, { role: "assistant", content: "Here is the revised resume PDF. I also kept the application packet." }],
    [{ kind: "note", recipient: "Maya", documents: ["the revised resume PDF", "the application packet"], body: "Hi Maya, here it is." },
      "The revised resume PDF, or the application packet? Also, should I send it from your Gmail? Here is a draft: Hi Maya, here it is."]);
  eq(calls.length, 1);
  eq(t.reply, "The revised resume PDF, or the application packet?", "one question; no draft, no second question");
});

Deno.test("WO-H/D2 continuation 4: a name that fits two people gets one question; no recipient named also asks", async () => {
  const a = checkFollowup({ kind: "note", recipient: "Sam", recipient_options: ["Sam P.", "Sam Lee"], document: null, documents: [], body: "Hi Sam", tone: null }, { said: "write a note to Sam", facts: [] });
  eq([a.status, (a as any).ask, (a as any).options], ["ask", "recipient", ["Sam P.", "Sam Lee"]]);
  const b = checkFollowup({ kind: "thank_you", recipient: null, recipient_options: [], document: null, documents: [], body: "Hi, thanks", tone: null }, { said: "write a thank-you note", facts: [] });
  eq([b.status, (b as any).ask], ["ask", "recipient"]);
});

Deno.test("WO-H/D3 continuation 4 turns 5-7: drafts get warmer without an invented past; the shown draft is the checked one", async () => {
  const h = [{ role: "user", content: "Now send it to Maya." }, { role: "assistant", content: "Which Maya, and where should I send it?" }, { role: "user", content: "Maya at the company." },
    { role: "assistant", content: "I still need the exact recipient or the conversation you mean. I can draft a short note while you find it." }];
  const five = await turn("What would you say?", h, [{ kind: "note", recipient: "Maya", document: "revised resume", body: "Hi Maya, attaching my revised resume for the data analyst internship. Thanks for taking a look. [Your name]" }]);
  eq(five.t.reply, "Draft for Maya, with revised resume, not sent:\n\nHi Maya, attaching my revised resume for the data analyst internship. Thanks for taking a look. [Your name]");
  ok(!/@/.test(five.t.reply), "no address is guessed from the company");
  const h2 = [...h, { role: "user", content: "What would you say?" }, { role: "assistant", content: five.t.reply }];
  // "Make it warmer": the first try invents a meeting, a referral and a figure; code refuses it and the model rewrites.
  const six = await turn("Make it warmer.", h2, [
    { kind: "note", recipient: "Maya", document: "revised resume", tone: "warmer", body: "Hi Maya, it was great meeting you last week, and thanks again to Jordan for the referral! I am attaching my revised resume; I screened 300 targets in my project. Warmly, [Your name]" },
    { kind: "note", recipient: "Maya", document: "revised resume", tone: "warmer", body: "Hi Maya, I am attaching my revised resume for the data analyst internship. I would really appreciate any feedback when you have a chance. Thanks for your time, [Your name]" }]);
  eq(six.calls.map((c: any) => c.ok), [true, true]);
  ok(/Hi Maya, I am attaching my revised resume[^]*Thanks for your time, \[Your name\]$/.test(six.t.reply), six.t.reply);
  ok(!/meeting|referral|Jordan|300/.test(six.t.reply), "nothing from the refused draft reaches the person");
  const seven = await turn("A little less formal.", [...h2, { role: "user", content: "Make it warmer." }, { role: "assistant", content: six.t.reply }],
    [{ kind: "note", recipient: "Maya", document: "revised resume", tone: "less formal", body: "Hi Maya, here is my revised resume for the data analyst internship. I would love your feedback if you have a chance. Thanks, [Your name]" }]);
  ok(seven.t.reply.endsWith("Hi Maya, here is my revised resume for the data analyst internship. I would love your feedback if you have a chance. Thanks, [Your name]"));
});

Deno.test("WO-H/D4 a thank-you after an interview: the interview the person named is fine; an invented offer, referral or relationship is not", () => {
  const said = "Write a thank-you note to Maya after my interview at Lakefront Transit Analytics";
  const good = checkFollowup({ kind: "thank_you", recipient: "Maya", recipient_options: [], document: null, documents: [], tone: "warmer",
    body: "Hi Maya, thank you for taking the time to interview me for the data analyst internship at Lakefront Transit Analytics. I enjoyed hearing about the team's work and would be glad to bring my Python screening workflow across 100+ targets to it. Best, [Your name]" }, { said, facts: [FACTS[0].value] });
  eq(good.status, "ok", JSON.stringify(good));
  for (const [bad, why] of [
    ["Hi Maya, thank you for the interview and for the generous offer. Best, [Your name]", /an offer/],
    ["Hi Maya, thank you for the interview. Sam P. referred me and I am grateful. Best, [Your name]", /referral/],
    ["Hi Maya, thank you for the interview; it was great to see my former manager there. Best, [Your name]", /relationship/],
    ["Hi Maya, thank you for the interview. As we discussed on our call last Tuesday, I can start in May. Best, [Your name]", /figure|name|meeting/],
    ["Hi Maya, thank you for the interview. My GPA is 3.9. Best, [Your name]", /figure "3\.9"/],
    ["Hi Maya, thank you for the interview. I'll also copy maya@lakefront.example. Best, [Your name]", /never guess an address/],
  ] as [string, RegExp][]) {
    const r: any = checkFollowup({ kind: "thank_you", recipient: "Maya", recipient_options: [], document: null, documents: [], tone: null, body: bad }, { said, facts: [FACTS[0].value] });
    ok(r.status === "rewrite" && r.problems.some((p: string) => why.test(p)), `${bad} -> ${JSON.stringify(r)}`);
  }
  // The person's own words license what they said happened: "after our call" names the call.
  eq(checkFollowup({ kind: "follow_up", recipient: "Maya", recipient_options: [], document: null, documents: [], tone: null, body: "Hi Maya, thanks again for our call. Best, [Your name]" }, { said: "write a follow-up to Maya after our call", facts: [] }).status, "ok");
});

Deno.test("WO-H/D5 routing: thank-you and follow-up draft asks reach the brain; other turns are untouched", () => {
  for (const m of ["Write a thank-you note to Maya after my interview", "Draft a follow-up email for my Stripe interview", "can you help me write a thank you email", "rewrite the follow-up"]) ok(followupDraftAsk(m), m);
  for (const m of ["I sent a thank-you note to Maya", "log my follow-up with Stripe", "follow up on my application status"]) ok(!followupDraftAsk(m), m);
  eq(enforceFollowupAsk("Which Maya? And what's her email? Here's a draft."), "Which Maya?");
});
