"use strict";
/* BETA C04 (2026-11-04 interim evidence): "$24/hour counteroffer draft".
 *
 * The live case: a support job offered $24/hour; the person asked "should I counter?" and for a counteroffer draft for
 * review. Shipped behavior: the draft asked for the same $24/hour (the offer's own figure was read as the ask), used
 * "the firm" as the employer, never discussed the terms nobody had stated, and never answered "should I counter?".
 *
 * These checks run the deployed path (the real CareerHost and chain modules) and 128's counterPlan directly:
 *   - a counter never asks for the offer amount or less (hourly and annual);
 *   - "should I counter?" gets a direct answer, its figure said to be judgment when nothing is sourced, and a sourced
 *     benchmark only with its source and date;
 *   - the employer is the name the person gave, never "the firm" or a placeholder; unknown, the reply asks;
 *   - the package terms (benefits, schedule, start date) are raised and asked for in the draft;
 *   - "shorten to N words" re-fits the LAST draft and stays within N, keeping the pay ask;
 *   - nothing is sent: every draft is held for approval of its exact text.
 * Check: node --test tests/career-c04-counter-draft.test.cjs
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const Negotiation = D("128-career-negotiation.js");
const Writing = D("154-career-writing.js");

const NOW = Date.parse("2026-11-04T16:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));
// The C04 message as run live (C03/C04 used the "no external actions" safety wording).
const C04 = "A support job offered $24/hour. Should I counter? Draft a counteroffer for review only. No external actions and no changes to my profile.";
const PLACEHOLDER = /\bthe firm\b|\[[^\]]*\]|\{[^}]*\}|<[^>]*>|\bcompany name\b|\byour name\b/i;

function world() {
  const host = CareerHost.createCareerHost({
    CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"),
    CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"),
    CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
  });
  const threads = new Map();
  let account = {};
  let n = 0;
  return (text, tid = "t-c04") => {
    n += 1;
    const ctx = host.createTurnCtx({ userId: "u-c04", threadId: tid, now: NOW + n * 60000, accountPersistence: true, snapshot: threads.get(tid) || null, account: clone(account), watchState: {}, postings: [] });
    const out = host.runTurn(text, ctx);
    threads.set(tid, host.extractSnapshot(ctx));
    if (ctx._hostPatch && ctx._hostPatch.erase !== true) account = Object.assign({}, account, clone(ctx._hostPatch));
    return { out: Object.assign({}, (out && out.result) || {}, { intent: out && out.intent }), reply: String((out && out.reply) || "") };
  };
}
// The email inside a reply: from its Subject line to its sign-off.
const emailIn = (reply) => { const m = String(reply).match(/Subject:[\s\S]*?\n(?:Thank you,|Thanks,|Best,)[^\n]*(?:\n[A-Z][^\n]*)?/); return m ? m[0] : ""; };
const dollarsIn = (s) => [...String(s).matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
const words = (t) => Writing.draftWordCount(t);

test("C04 verbatim: a direct answer, a counter above $24/hour said to be judgment, the package terms, no placeholder, held", () => {
  const say = world();
  const { out, reply } = say(C04);
  assert.equal(out.intent, "negotiation_draft", reply);
  // The direct answer leads.
  assert.match(reply, /^Yes, counter once, in writing, at \$26 an hour/, reply);
  assert.match(reply, /my judgment, not market data/, "the figure is said to be judgment");
  assert.ok(!/median|percentile|market rate (is|for)|typically pay|pays? on average|BLS|Glassdoor|Indeed/i.test(reply.replace(/I won't quote a market rate/, "")), `no invented market data: ${reply}`);
  // The draft asks for more than the offer and never for $24 itself.
  const email = emailIn(reply);
  assert.ok(email, `the draft is in the reply: ${reply}`);
  assert.match(email, /Could you bring the rate to \$26 an hour\?/);
  assert.ok(!/(bring|meet|move)[^.?]*\$24\b/.test(email), `the ask is never the offer's own figure: ${email}`);
  // Package terms.
  for (const t of [/benefits/i, /schedule/i, /start date/i]) { assert.match(reply, t); assert.match(email, t); }
  // No placeholder; the employer is unknown, so the reply asks.
  assert.ok(!PLACEHOLDER.test(email), `placeholder in the draft: ${email}`);
  assert.match(reply, /which company made the offer\?/);
  // Held, nothing sent.
  assert.ok(out.draft && out.draft.status === "held" && out.draft.sent === false && out.draft.requires_approval === true, JSON.stringify(out.draft));
  assert.match(reply, /held for your review, nothing sent/);
  assert.ok(!out.sends, "nothing is sent");
});

test("C04: the employer comes from the person's own message; never \"the firm\"", () => {
  const say = world();
  const { out, reply } = say("Northwind Health offered me a customer support job at $24/hour. Should I counter? Draft a counteroffer for review only.");
  assert.equal(out.intent, "negotiation_draft");
  const email = emailIn(reply);
  assert.match(email, /^Subject: Customer support offer, Northwind Health/);
  assert.match(email, /at Northwind Health: \$24 an hour/);
  assert.ok(!PLACEHOLDER.test(email), email);
  assert.ok(!/which company made the offer/.test(reply), "a named employer is not asked for again");
});

test("C04: annual offers counter above the offer in yearly terms", () => {
  const say = world();
  const { out, reply } = say("I got an offer from Acme for an analyst role at $70,000 a year. Should I counter? Draft the counter email for review.");
  assert.equal(out.intent, "negotiation_draft", reply);
  const email = emailIn(reply);
  assert.match(email, /Could you bring the base salary to \$75,000 a year\?/, email);
  assert.match(reply, /my judgment, not market data/);
  const asks = dollarsIn(email.split("\n").filter((l) => /^Could you bring/.test(l)).join(" "));
  assert.ok(asks.length && asks.every((v) => v > 70000), `asked ${asks}`);
});

test("C04: a counter at or below the offer is refused, and the person's own higher target is used", () => {
  const say = world();
  say("A support job offered $24/hour. Should I counter?");
  const same = say("Can I counter at $24 an hour?");
  assert.match(same.reply, /^Not at \$24: that is at or below the \$24 an hour they already offered/, same.reply);
  assert.ok(!emailIn(same.reply), "no draft asks for the offer's own figure");
  const lower = say("Should I counter at $22 an hour?");
  assert.match(lower.reply, /^Not at \$22/, lower.reply);
  const mine = say("My target is $27 an hour. Draft the counter email for review.");
  assert.equal(mine.out.intent, "negotiation_draft", mine.reply);
  assert.match(emailIn(mine.reply), /Could you bring the rate to \$27 an hour\?/, mine.reply);
  assert.match(mine.reply, /asking for your figure \(\$27 an hour\)/);
});

test("C04: counterPlan never asks for the offer amount or less, in either unit", () => {
  for (const [rate, unit] of [[24, "hour"], [17.5, "hour"], [70000, "year"], [52000, "year"]]) {
    const p = Negotiation.counterPlan({ rate, unit, company: "Acme" }, { text: "should I counter?" });
    assert.ok(p.counter && p.counter.value > rate, `${rate}/${unit}: ${JSON.stringify(p.counter)}`);
    assert.equal(p.counter.basis, "judgment");
    assert.match(p.answer.verdict, /judgment, not market data/);
    for (const v of [rate, rate - 1]) {
      const r = Negotiation.counterPlan({ rate, unit, company: "Acme" }, { text: `counter at $${v}${unit === "hour" ? " an hour" : ""}` });
      assert.equal(r.counter, null, `${v} on a ${rate} offer`);
      assert.equal(r.draft, null, "no draft asks for the offer or less");
      assert.equal(r.rejected, v);
    }
  }
  // A sourced benchmark is cited with its source and date; one without a source is not used.
  const sourced = Negotiation.counterPlan({ rate: 24, unit: "hour", company: "Acme" }, { benchmark: { low: 23, median: 25, high: 28, unit: "hour", cite: "BLS OEWS May 2025, Austin metro", as_of: "May 2025" } });
  assert.equal(sourced.counter.basis, "sourced_range");
  assert.match(sourced.answer.reasons.join(" "), /BLS OEWS May 2025, Austin metro.*as of May 2025/);
  const unsourced = Negotiation.counterPlan({ rate: 24, unit: "hour", company: "Acme" }, { benchmark: { low: 23, median: 25, high: 28, unit: "hour" } });
  assert.equal(unsourced.counter.basis, "judgment", "an unsourced figure is never used as a benchmark");
  // Sourced figures at or below the offer: no pay counter is pushed.
  const below = Negotiation.counterPlan({ rate: 30, unit: "hour", company: "Acme" }, { benchmark: { low: 22, high: 28, unit: "hour", cite: "BLS OEWS", as_of: "May 2025" } });
  assert.equal(below.counter, null);
  assert.match(below.answer.verdict, /^On pay alone, probably not/);
});

test("C04: a placeholder employer is never used, and its absence is asked about", () => {
  for (const company of [null, "the firm", "The company", "employer"]) {
    const p = Negotiation.counterPlan({ rate: 24, unit: "hour", company }, {});
    assert.equal(p.company, null, String(company));
    assert.ok(p.needs.includes("company"));
    assert.match(p.companyQuestion, /which company made the offer\?/);
    assert.ok(!PLACEHOLDER.test(p.draft.body), p.draft.body);
  }
});

test("C04: \"shorten to N words\" re-fits the last draft, stays within N and keeps the ask", () => {
  const say = world();
  say(C04);
  for (const n of [40, 30, 25]) {
    const { out, reply } = say(`Shorten the draft to ${n} words`);
    assert.equal(out.intent, "negotiation_draft", reply);
    const email = emailIn(reply);
    assert.ok(email, reply);
    assert.ok(words(email) <= n, `${words(email)} words for a ${n}-word target:\n${email}`);
    assert.match(email, /\$26 an hour\?/, "the pay ask survives the cut");
    assert.match(email, /^Hi,$/m);
    assert.ok(out.draft && out.draft.status === "held" && out.draft.sent === false, "still held");
  }
});

test("C04: \"shorten to N\" binds to the latest draft, not an earlier one", () => {
  const say = world();
  say(C04);
  say("I'm Sam, a junior at UT Austin studying economics.");
  const net = say("Draft a networking email for review only");
  assert.equal(net.out.intent, "outreach_draft", net.reply);
  const { out, reply } = say("Shorten the draft to 30 words");
  assert.equal(out.intent, "outreach_draft", reply);
  assert.ok(!/\$26|\$24|offer/i.test(emailIn(reply) || reply.split("\n\n")[1] || ""), `re-fit the counter instead of the networking email: ${reply}`);
  assert.match(reply, /15 minutes/);
  assert.ok(words(out.draft.text) <= 30, out.draft.text);
});

test("C04: a draft ask that could not be drafted does not displace the held draft", () => {
  const say = world();
  say(C04);
  const none = say("Draft a networking email for review only");
  assert.notEqual(none.out.intent, "outreach_draft", "nothing was drafted");
  const { out, reply } = say("Shorten the draft to 30 words");
  assert.equal(out.intent, "negotiation_draft", reply);
  assert.ok(words(emailIn(reply)) <= 30);
});

/* Review round 1 (PR #517): monthly/weekly pay, unclear units, ranges, shortened legacy drafts, lower-case recipients,
 * and stated package terms. */
test("C04 r1: a monthly offer is countered in months, never restated as a year", () => {
  const say = world();
  const { out, reply } = say("They offered $4,000 a month for an analyst job. Should I counter? Draft a counteroffer.");
  assert.equal(out.intent, "negotiation_draft", reply);
  assert.ok(!/a year|annual|salary/i.test(reply), `a unit the person never used: ${reply}`);
  assert.match(reply, /^Yes, counter once, in writing, at \$4,300 a month/);
  assert.match(emailIn(reply), /Could you bring the monthly pay to \$4,300 a month\?/);
  const weekly = say("They offered $1,200 a week. Should I counter?", "t-week");
  assert.match(weekly.reply, /at \$1,290 a week/, weekly.reply);
  assert.ok(!/a year|a month/.test(weekly.reply), weekly.reply);
});

test("C04 r1: a figure with no period is not guessed at", () => {
  const say = world();
  const { out, reply } = say("They offered me $4,000 for the analyst job. Should I counter? Draft a counteroffer.");
  assert.match(reply, /^Is \$4,000 an hourly, weekly, monthly or yearly figure\?/, reply);
  assert.ok(!out.draft, "no draft without the unit");
  assert.ok(!/counter once|a year/.test(reply), reply);
});

test("C04 r1: a pay range is read, and any counter clears its top", () => {
  const say = world();
  const { reply } = say("They offered $22-24/hour for a support job. Should I counter? Draft a counteroffer for review.");
  assert.ok(!/No offer figure/i.test(reply), reply);
  assert.match(reply, /\$22 to \$24 an hour/);
  const asks = dollarsIn(emailIn(reply).split("\n").filter((l) => /^Could you bring/.test(l)).join(" "));
  assert.ok(asks.length && asks.every((v) => v > 24), `asked ${asks}`);
  const r = say("Should I counter at $23 an hour?");
  assert.match(r.reply, /^Not at \$23/, r.reply);
});

test("C04 r1: statedPayOf reads the person's unit and skips bonuses and asks", () => {
  const P = Negotiation.statedPayOf;
  assert.deepEqual(P("A support job offered $24/hour."), { rate: 24, low: null, unit: "hour", text: "$24/hour", current: [] });
  assert.equal(P("They offered $4,000 a month").unit, "month");
  assert.equal(P("offer $1,200 per week plus a $2,000 signing bonus").rate, 1200);
  assert.deepEqual([P("offered $70-80k").low, P("offered $70-80k").rate, P("offered $70-80k").unit], [70000, 80000, "year"]);
  assert.equal(P("offered $4,000").unit, null);
  assert.equal(P("counter at $27 an hour, they offered $24 an hour").rate, 24);
  assert.equal(P("a $5,000 signing bonus"), null);
});

test("C04 r1: shortening a draft without units keeps the ask sentence and never claims a cut it did not make", () => {
  const body = "Subject: Offer — Lincoln International\n\nDear Lincoln International team,\n\nThank you for the offer — $52 an hour, plus a $4,000 signing bonus for the summer analyst internship. I am excited about the role and the team.\n\nWould you be able to meet me at $56 an hour? The signing bonus as it stands works for me. With that, I am ready to sign ahead of the Friday deadline.\n\nThank you again for the opportunity — I look forward to your reply.";
  for (const n of [60, 40, 12]) {
    const d = Writing.refitDraft({ kind: "counter_email", text: body }, { words: n, mode: "exact" });
    assert.match(d.text, /Would you be able to meet me at \$56 an hour\?/, `the ask survives a ${n}-word cut:\n${d.text}`);
    assert.equal(d.askKept, true);
    if (d.words > n) assert.equal(d.floor, true, "over the target is reported as the floor, never as met");
    else assert.ok(d.words <= n);
  }
});

test("C04 r1: an outreach ask naming a lower-case firm is not taken by the no-recipient networking draft", () => {
  const say = world();
  const { reply } = say("write a cold email to someone at people inc.");
  assert.ok(!/^Who is the email to/.test(reply), reply);
});

test("C04 r1: package terms the person stated are not called missing", () => {
  const keys = (t) => Negotiation.missingTermsOf({}, t).map((m) => m.key);
  assert.deepEqual(keys("benefits include health insurance and it starts on Dec 1"), ["schedule"]);
  assert.deepEqual(keys("I have no benefits or schedule details yet"), ["benefits", "schedule", "start_date"]);
  assert.deepEqual(keys("full-time, Monday to Friday, with health insurance; start date unknown"), ["start_date"]);
});

/* Review round 2 (PR #517): current or past pay is context, never the offer or a floor; two candidate offers are
 * asked about; "counter at the same rate" is answered. */
const offerAsks = (reply) => dollarsIn(emailIn(reply).split("\n").filter((l) => /^Could you bring/.test(l)).join(" "));
for (const [name, msg] of [
  ["current pay first, joined by and", "I make $20/hour now and a support job offered $24/hour. Should I counter? Draft a counteroffer."],
  ["current pay in its own sentence", "My current job pays $20 an hour. A new support job offered $24 an hour. Should I counter? Draft a counteroffer."],
  ["reversed order", "They offered $24 an hour for a support job, I make $20 an hour. Should I counter? Draft a counteroffer."],
  ["three figures: current, offer and the person's own ask", "I make $20/hour, a support job offered $24/hour, and I want $27/hour. Should I counter? Draft a counteroffer."],
]) {
  test(`C04 r2: ${name}: the counter is measured against the $24 offer, never the $20 current pay`, () => {
    const say = world();
    const { out, reply } = say(msg);
    assert.equal(out.intent, "negotiation_draft", reply);
    assert.ok(!/\$20 an hour on the table|above the \$20|offer(?:ed)?:? \$20|for the offer[^.]*\$20/i.test(reply), `the current pay was read as the offer: ${reply}`);
    assert.match(emailIn(reply), /Thank you for the offer[^\n]*\$24 an hour/);
    const asks = offerAsks(reply);
    assert.ok(asks.length && asks.every((v) => v > 24), `asked ${asks}`);
    if (/I want \$27/.test(msg)) assert.deepEqual(asks, [27], "the person's own figure");
    assert.match(reply, /\$20(?:\/hour| an hour) as what you make now; that's context/);
    // The thread keeps $24, not $20, for the next turn.
    const next = say("Should I counter at $22 an hour?");
    assert.match(next.reply, /^Not at \$22: that is at or below the \$24 an hour/, next.reply);
  });
}

test("C04 r2: two candidate offers in the same unit are asked about, not guessed", () => {
  const say = world();
  const { out, reply } = say("Acme offered $24/hour and Beta offered $26/hour. Should I counter? Draft a counteroffer.");
  assert.match(reply, /^Which figure is the offer you're deciding on: \$24\/hour or \$26\/hour\?/, reply);
  assert.ok(!out.draft && !emailIn(reply), "no draft on a guessed offer");
  const P = Negotiation.statedPayOf;
  assert.deepEqual(P("I earn $20 an hour and I saw $24 and $26 posted").ambiguous, ["$24", "$26"]);
  assert.equal(P("I make $20 an hour right now"), null, "current pay alone is no offer");
});

test("C04 r2: \"counter at the same rate\" is answered: no counter at the offer, and the accept-and-ask-terms option", () => {
  const say = world();
  say("A support job offered $24/hour. Should I counter?");
  const { out, reply } = say("Can I just counter at the same rate?");
  assert.match(reply, /^Countering at the same \$24 an hour asks for nothing new/, reply);
  assert.match(reply, /accepts \$24 an hour and asks about the terms/);
  assert.ok(!out.draft && !emailIn(reply));
});
