// MIRROR WA-1 (architect, 2026-11-11): the owner's real WhatsApp benchmark against Instinct (evals/mirror/instinct-wa-batch1/),
// one person texting 23 asks in a row. At $0 (a dry run through the real handler) the router answered 18 of the 26 turns,
// and most of them were a different task from the one asked:
//   - "quiz me on a python question" served "Tell me about yourself", and from then on every message (the Python answer, the
//     code, "have i applied to anything yet?", "make that referral draft shorter", "say i'm a new grad...", "is that posting
//     still open?", "that citadel process from earlier") was scored as an interview answer on a keyword rubric;
//   - "what's citadel like ... give me real sources" served a coding question;
//   - "give me a 'tell me about yourself' answer i can reuse" served the question instead of the answer;
//   - "hypothetically if i had two offers, 120k in chicago vs 140k in nyc" was taken as a real offer ("Got it: Chicago metro,
//     $120,000") and asked for the job title;
//   - "what would you need from me to actually submit that paypal application? don't apply yet" got the onboarding list;
//   - "what should i actually be doing rn to land a swe internship" ran a search for "lock what should actually doing rn land".
// Each is the brain's now (it answers the ask, with the router's reply as data). Controls stay code's: a practice-question
// ask, a drill answer graded on its own key, a mock answer, a real offer, a search, an apply ask.
//   deno test -A --no-check tests/architect/mirror-wa-batch1.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-wa1", threadId: "t-wa1", now: Date.UTC(2026, 10, 11, 5), accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
const decide = (m: string, ctx = fresh()) => stagedDecision({ env: STAGED, message: m, ctx, host, structured: false });
console.error = () => {};

// Verbatim from the benchmark (the owner's prompts; C20's names are mapped to fictional ones there, not used here).
const C1 = "i need to lock in for recruiting, what should i actually be doing rn to land a swe internship for next summer";
const C3 = "find me 5 swe internships i could actually apply to right now, chicago or remote";
const C5 = "quiz me on a python question like it's a real interview, one at a time";
const C5F1 = "i'd count each number with a dict, then go through the list again and return the first one whose count is 1. o👎 time, o👎 space";
const C5F2 = "def first_unique(nums): counts = {}; [counts.update({n: counts.get(n,0)+1}) for n in nums]; return next(n for n in nums if counts[n]==1)";
const C6 = "have i applied to anything yet? trying to keep track";
const C7 = "hypothetically if i had two offers, 120k in chicago vs 140k in nyc, same kind of role, how would you think about it";
const C9 = "what's citadel like for new grad swe, culture pay interview process, give me real sources";
const C11 = "what would you need from me to actually submit that paypal application? don't apply yet just wanna know";
const C14 = "actually that referral draft from earlier, make it way shorter and less formal";
const C15 = "say i'm a new grad with zero internships and a mid gpa, how do i even get interviews";
const C17 = "give me a 'tell me about yourself' answer i can reuse for swe interviews, based on my actual background";
const C18 = "is that paypal internship posting still open? check rn";
const C21F = "uhh probably when one of my first agency clients didn't like the site i made. i redid it and learned to communicate better with clients";
const C23 = "that citadel process from earlier, how long was it again total?";

// A prep session the router started: a practice question is waiting in the thread.
function inSession() {
  const ctx = fresh();
  const served = host.runTurn(C5, ctx);
  eq(served.intent, "prep_brief", `the session started: ${served.intent}`);
  ok(served.result?.question, "a question is waiting");
  return ctx;
}

Deno.test("WA1-1 a message scored on the keyword rubric mid-session is the brain's, with the score as data", () => {
  for (const m of [C5F1, C5F2, C6, C14, C15, C18, C21F, C23]) {
    const d = decide(m, inSession());
    ok(d.brain, `${m.slice(0, 50)}: ${d.intent}/${d.reason}`);
    if (d.intent === "prep_brief") {
      eq(d.reason, "prep_rubric_read", m.slice(0, 50));
      ok(String(d.router?.reply ?? "").length > 0, "the router's read reaches the brain as data");
    }
  }
});

Deno.test("WA1-2 a prep serve that is not what was asked is the brain's", () => {
  for (const m of [C5, C9, C17]) {
    const d = decide(m);
    ok(d.brain, `${m.slice(0, 50)}: ${d.intent}/${d.reason}`);
  }
  // In a running session too.
  for (const m of [C9, C17]) ok(decide(m, inSession()).brain, m.slice(0, 50));
});

Deno.test("WA1-3 a hypothetical offer is the brain's, and the real record is not written", () => {
  const ctx = fresh();
  const d = decide(C7, ctx);
  ok(d.brain, `${d.intent}/${d.reason}`);
  ok(!JSON.stringify(ctx).includes("120000") && !JSON.stringify(ctx).includes("120,000"), "the probe wrote nothing to the real turn");
  // A real offer stays code's record.
  const real = decide("I got an offer: $120k base in Chicago for a software engineer role at Acme");
  eq(real.brain, false, `a real offer: ${real.intent}/${real.reason}`);
});

Deno.test("WA1-4 what it takes to submit a named application, with applying forbidden, is the brain's", () => {
  const d = decide(C11);
  ok(d.brain, `${d.intent}/${d.reason}`);
  // The bare onboarding ask stays code's.
  eq(decide("what do you need from me to get started").brain, false);
});

Deno.test("WA1-5 an advice question the router read as a search is the brain's; a search ask stays code's", () => {
  const d = decide(C1);
  ok(d.brain, `${d.intent}/${d.reason}`);
  const s = decide(C3);
  eq(s.brain, false, `a search: ${s.intent}/${s.reason}`);
});

Deno.test("WA1-6 controls: a practice-question ask and a drill graded on its own key stay code's session", () => {
  const ctx = inSession();
  const next = decide("give me another practice interview question", ctx);
  eq(next.brain, false, `another question: ${next.intent}/${next.reason}`);
  // A finance drill answer graded on the bank's own key is code's grade.
  const f = fresh();
  host.runTurn("drill me on the three financial statements", f);
  const ans = decide("The income statement's net income flows into retained earnings on the balance sheet and starts the cash flow statement, then non-cash items and working capital adjust it.", f);
  if (ans.intent === "prep_brief" && ans.reason === "prep_rubric_read") assertNode.fail("a drill-key grade is not a rubric read");
});

Deno.test("WA1-7 a search's role is the title, not the way the person talks", async () => {
  const { searchTextOf } = await import("../../supabase/functions/_shared/posting_constraints.ts");
  eq(searchTextOf(C3).role, "software engineer");
  eq(searchTextOf("find me 5 data analyst internships in Chicago").role, "data analyst");
});

Deno.test("WA1-8 a mock start that names its question asks that question (the brain's); a plain mock start stays code's", () => {
  const C21 = "ok behavioral round: ask me 'tell me about a time you failed' and then roast my answer";
  const d = decide(C21);
  ok(d.brain, `${d.intent}/${d.reason}`);
  // Architect amendment (D-061): G1 gives a practice-session start to the brain (G12, one question at a time); the session's own
  // answers stay code's (WA1-6). Nothing in either sends or saves.
  const plain = decide("mock interview me for a data analyst role");
  eq(plain.brain, true, `${plain.intent}/${plain.reason}`);
});

Deno.test("WA1-9 a long text is condensed once, under code's guards", async () => {
  const { condenseLimit, condensable, condensedOk, condenseReply, REPLY_TARGET } = await import("../../supabase/functions/agent-chat/career_brain.ts");
  eq(condenseLimit("what do you actually know about my work experience so far? like everything you remember"), REPLY_TARGET.long);
  eq(condenseLimit("what's citadel like for new grad swe, culture pay interview process, give me real sources"), REPLY_TARGET.long);
  eq(condenseLimit("what should i put at the very top of my resume for swe roles, be specific"), REPLY_TARGET.short);
  const long = "Start with PayPal and Pinterest. ".repeat(25) + "Pay is $28-$49/hour per the posting https://example.test/p. Nothing was sent. Want the plan?";
  ok(condensable({ reply: long, show: undefined, pending_approvals: [] } as any, REPLY_TARGET.short));
  ok(!condensable({ reply: long + "\n```py\nx=1\n```", show: undefined, pending_approvals: [] } as any, REPLY_TARGET.short), "code is never rewritten");
  ok(!condensable({ reply: long, show: { intent: "x", text: long }, pending_approvals: [] } as any, REPLY_TARGET.short), "a shown payload is never rewritten");
  ok(!condensable({ reply: long, show: undefined, pending_approvals: [{ tool: "t", input: {}, summary: "s" }] } as any, REPLY_TARGET.short), "an approval is never rewritten");
  ok(condensedOk(long, "Start with PayPal and Pinterest; the posting lists $28-$49/hour https://example.test/p. Nothing was sent. Want the plan?", REPLY_TARGET.short));
  ok(!condensedOk(long, "Start with PayPal; pay is $60/hour. Nothing was sent.", REPLY_TARGET.short), "a figure not in the long reply");
  ok(!condensedOk(long, "Start with PayPal https://other.test. Nothing was sent.", REPLY_TARGET.short), "a link not in the long reply");
  ok(!condensedOk(long, "Start with PayPal? Or Pinterest? Nothing was sent.", REPLY_TARGET.short), "two questions");
  ok(!condensedOk(long, "", REPLY_TARGET.short), "empty");
  const model = async () => ({ content: [{ type: "text", text: "Start with PayPal and Pinterest; the posting lists $28-$49/hour. Nothing was sent. Want the plan?" }] });
  eq(await condenseReply(model as any, long, REPLY_TARGET.short), "Start with PayPal and Pinterest; the posting lists $28-$49/hour. Nothing was sent. Want the plan?");
  const bad = async () => ({ content: [{ type: "text", text: "Pay is $99/hour." }] });
  eq(await condenseReply(bad as any, long, REPLY_TARGET.short), null, "a failed guard keeps the long reply");
});

Deno.test("WA1-10 a turn whose tools wrote anything is never condensed", async () => {
  const { condensable, REPLY_TARGET } = await import("../../supabase/functions/agent-chat/career_brain.ts");
  const long = "Hi Elena, I'm reaching out about the data scientist role. ".repeat(20);
  ok(condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "search_jobs", ok: true, effect: null }] } as any, REPLY_TARGET.short), "a read-only turn is condensed");
  ok(!condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "draft_outreach", ok: true, effect: null }] } as any, REPLY_TARGET.short), "a draft tool");
  ok(!condensable({ reply: long, pending_approvals: [], tool_calls: [{ name: "add_profile_fact", ok: true, effect: { kind: "write" } }] } as any, REPLY_TARGET.short), "a write");
});
