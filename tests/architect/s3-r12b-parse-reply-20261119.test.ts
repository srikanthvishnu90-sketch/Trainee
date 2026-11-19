// S3 r12b (2026-11-19, sitting #2 on 8e80264f2, pass 1 at 36/38): the structural causes behind the dev H002 and H005 splits.
// Each is a class of message, pinned here on messages of that class (most are not the eval's own words):
//   1. a place read from "in <city>" stops at the verb or connector after it ("in Chicago looking for ...", "in Austin seeking ...");
//   2. the router's remembered role text starts at a word, never mid-word, and leaves out the words of asking;
//   3. a negated workplace ("nothing in an office", "no office", "not onsite") is a remote-only limit, never role words;
//   4. an acknowledgement ("ok thanks") gets the length of one brief acknowledgement or one short next step;
//   5. a reply never says a stated fact is waiting for their yes unless a confirmation is really open.
// No model, no network.
//   deno test -A --no-check tests/architect/s3-r12b-parse-reply-20261119.test.ts
import assertNode from "node:assert/strict";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { lengthNote, replyKind, replyLength, statesNothing } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { confirmClaimsDropped } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { confirmationOpen } from "../../supabase/functions/agent-chat/career_brain.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);

Deno.test("r12b-1 a place after 'in' stops at the verb or connector that follows it", () => {
  const cases: [string, string][] = [
    ["I'm a data analyst in Chicago looking for analyst roles", "chicago"],
    ["software engineer in Austin seeking backend roles", "austin"],
    ["nurse in Denver and want day shift jobs", "denver"],
    ["I live in Seattle searching for marketing jobs", "seattle"],
    ["accountant in Boston hoping to find audit roles", "boston"],
    ["teacher in Houston trying to move into instructional design roles", "houston"],
  ];
  for (const [m, place] of cases) eq(searchTextOf(m).place, place, m);
  // A known city written before other words is still that city, whatever the next word is.
  eq(searchTextOf("barista in Portland currently wanting coffee roaster roles").place, "portland");
  // A real multi-word place is kept whole.
  eq(searchTextOf("data analyst roles in San Francisco").place, "san francisco");
  eq(searchTextOf("data analyst roles in New York and remote").place, "new york");
  for (const [m] of cases) ok(!/\b(?:looking|seeking|searching|hoping|trying)\b/.test(searchTextOf(m).role), `no verb in the role: ${m}`);
});

const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-r12b", threadId: "t-r12b", now: Date.UTC(2026, 10, 19, 15), accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });

Deno.test("r12b-2 the router's remembered role text starts at a word and leaves out the words of asking", () => {
  const cases: [string, RegExp][] = [
    ["I'm a data analyst in Chicago looking for analyst roles", /^analyst roles$/i],
    ["I'm a backend engineer in Austin seeking platform engineer roles", /^platform engineer roles$/i],
    ["I'm a nurse in Columbus searching for travel nurse jobs", /^travel nurse jobs$/i],
  ];
  for (const [m, want] of cases) {
    const ctx = fresh();
    host.runTurn(m, ctx);
    const rt = String(ctx.discovery?.lastParams?.roleText ?? "");
    ok(want.test(rt), `${m}: roleText ${JSON.stringify(rt)}`);
    // Never sliced mid-word: the role text's first word is a whole word of the message.
    const first = rt.split(/\s+/)[0].toLowerCase();
    ok(m.toLowerCase().split(/[^a-z]+/).includes(first), `${m}: ${JSON.stringify(first)} is a whole word of the message`);
  }
  // A short ask keeps its whole role, as before.
  const ctx = fresh();
  host.runTurn("find me data analyst roles in Chicago", ctx);
  eq(String(ctx.discovery?.lastParams?.roleText ?? "").toLowerCase(), "data analyst roles");
});

Deno.test("r12b-3 a negated workplace is a remote-only limit, never role words", () => {
  const cases = [
    "I want remote data analyst roles, nothing in an office",
    "data analyst roles, no office",
    "data analyst jobs but not onsite",
    "I want data analyst roles, I don't want to work in an office",
    "data analyst roles, never in person",
  ];
  for (const m of cases) {
    const st = searchTextOf(m);
    eq(st.role, "data analyst", m);
    eq(st.remote, true, `${m}: remote`);
  }
  // Not a negated workplace: hybrid is still allowed, and office days are a count, not "no office".
  eq(searchTextOf("data analyst roles, hybrid ok, not fully onsite").remote, false);
  eq(searchTextOf("data analyst roles with no more than 2 office days").remote, false);
  eq(searchTextOf("office manager roles in Denver").role, "office manager", "the word office in a title stays");
});

Deno.test("r12b-4 an acknowledgement gets one brief acknowledgement or one short next step", () => {
  for (const m of ["ok thanks", "thanks!", "thank you", "cool, thanks", "got it", "sounds good", "ok", "perfect thank you", "great, thanks so much"]) {
    eq(replyKind(m), "ack", m);
    const l = replyLength(m);
    ok(l.upper <= 200, `${m}: ${l.upper}`);
    ok(/one short/.test(lengthNote(l)) && !/Keep every fact/.test(lengthNote(l)), `${m}: the note asks for brevity, not a recap`);
  }
  // It states nothing, so no record write is offered on it (career_brain.ts withholds add_profile_fact; D67-7 pins the withholding).
  for (const m of ["ok thanks", "thank you", "got it"]) ok(statesNothing(m), m);
  ok(!statesNothing("thanks, I'm a junior at Lakeshore"), "a thanks that states a fact still offers the write");
  // A thanks that asks something, or asks for work, is not a bare acknowledgement.
  for (const m of ["thanks, what about remote roles?", "ok thanks, now find me data analyst jobs", "thanks for that, can you draft the email"]) ok(replyKind(m) !== "ack", m);
});

Deno.test("r12b-5 a stated fact is never said to wait for a yes unless a confirmation is open", () => {
  const r1 = 'The first thing you told me today was: "I want remote data analyst roles, nothing in an office." It\'s on your record as your goal, and it\'s still waiting for your yes. Is that right?';
  const out1 = confirmClaimsDropped(r1);
  ok(!/waiting for your yes/i.test(out1), out1);
  ok(out1.includes("It's on your record as your goal.") && out1.includes("Is that right?") && out1.includes("nothing in an office"), out1);
  eq(confirmClaimsDropped("Your goal is saved. It still needs your confirmation."), "Your goal is saved.");
  eq(confirmClaimsDropped("Your school is on file but still awaiting your confirmation before I use it."), "Your school is on file.");
  // Applications and cards waiting for a yes are real, and are left alone.
  const apps = "4 sent today. 2 applications are waiting for your yes: text \"show my applications\".";
  eq(confirmClaimsDropped(apps), apps);
  const draft = "The draft to Sofia is waiting for your yes before it goes out.";
  eq(confirmClaimsDropped(draft), draft);
  // Plain "not confirmed yet" is true and stays.
  const plain = "It's on your record as your goal, not yet confirmed by you.";
  eq(confirmClaimsDropped(plain), plain);
  // When is a confirmation open: a card, a restore question, an approval asked this turn, or the thread's open question about a fact.
  eq(confirmationOpen({ stores: {} }), false);
  eq(confirmationOpen({ stores: { trackStore: { _careerThread: { lastDiscussion: { intent: "career_goal_record", pendingQuestion: false } } } } }), false);
  eq(confirmationOpen({ stores: { trackStore: { _careerThread: { lastDiscussion: { intent: "career_goal_record", pendingQuestion: true } } } } }), true);
  eq(confirmationOpen({ stores: {}, cardPending: true }), true);
  eq(confirmationOpen({ stores: {}, restoreAsk: { fact_id: "f1" } }), true);
  eq(confirmationOpen({ stores: {}, pendingApprovals: 1 }), true);
  // A search's open question is not a confirmation of a fact.
  eq(confirmationOpen({ stores: { trackStore: { _careerThread: { lastDiscussion: { intent: "career_discovery", pendingQuestion: true } } } } }), false);
});

// 6. (found on the r12b probes: dev H010 failed 2 of 3 fixed probes and 1 of 3 baseline probes) the brain's mock asked the bank's
// first question with the mock's role and employer added ("... why this data analyst role at Northwind Ledger."); the r12 match
// (prepSameQuestion) needed the asked wording not much longer, so "next question" served the same question again. A bank question
// whose every content word was asked is the same question, whatever context the brain wrote around it.
import { recordPrepAsked } from "../../supabase/functions/agent-chat/career_staged.ts";
Deno.test("r12b-6 a bank question asked with the mock's context added is served, never asked again", () => {
  const serve = (asked: string | null) => {
    const ctx: any = fresh();
    if (asked) recordPrepAsked(ctx, "prep_mock_start", asked);
    return String(host.runTurn("keep going — next question", ctx).reply);
  };
  for (const said of ["Question 1: Tell me about yourself and why this data analyst role at Northwind Ledger.",
    "Question 1: Tell me about yourself and why this product manager role at Acme Robotics matters to you."]) {
    const next = serve(said);
    ok(!/Tell me about yourself/.test(next) && /Here is your question: /.test(next), `repeated after ${said}: ${next}`);
  }
  // (a question with the same frame but other content is not the same question)
  ok(/Tell me about yourself/.test(serve("Question 1: Tell me about a time you failed at Northwind Ledger.")));
});
