// Owner must-fix: "check connected email before saying I haven't applied" (D-024, D-007). An independent review rejected #785
// (D-067); each finding is reproduced here at $0 (scripted model, in-memory stores, no Gmail call) and then fixed.
//   AC-1  a failed read is never a read and never a zero: per account and per store, "could not read", the count unknown;
//         one account or one store failing is a partial read, said as partial.
//   AC-2  only a successful lookup satisfies "checked email": after a failed one a reply saying "you haven't applied" is asked
//         again once with the failure, and if it still says so the outgoing reply says it is unconfirmed (code, not the prompt).
//   AC-3  the reply decides, not only the ask: any reply saying they have no applications needs a successful lookup this turn.
//   AC-4  a fact stated inside a request ("can you add that I interned at Google?") is a statement: add_profile_fact is offered
//         and the save is accepted (the guarantee the X2 control of mirror-wa-batch1-gaps-handler had before #785).
//   AC-5  pay listed by location is the posting's own location's range, or every range with its place, or none; never the
//         first range unlabelled.
//   deno test -A --no-check tests/architect/applied-check-failclosed-20261113.test.ts
import assertNode from "node:assert/strict";
import * as B from "../../supabase/functions/agent-chat/career_brain.ts";
import * as N from "../../supabase/functions/_shared/agent/turn_notes.ts";
import * as P from "../../supabase/functions/_shared/posting_pay.ts";
import { capabilityTools } from "../../supabase/functions/_shared/agent/capability_tools.ts";
import { EMPTY_REPLY, INCOMPLETE_REPLY, MAX_STEPS_REPLY } from "../../supabase/functions/_shared/agent/loop.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.UTC(2026, 10, 13);
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
function scripted(steps: any[]) {
  const seen: any[] = [];
  let n = 0;
  return { seen, model: async (p: any) => { seen.push(p); return p.tools?.length ? steps[n++] ?? text("ok") : text(""); } };
}
const turn = (message: string, model: any, extra: Record<string, unknown> = {}) =>
  B.agentTurn({ message, history: [], stores: { profile: { facts: [] } }, userId: "u-ac", threadId: "th-ac", now: NOW, model, ...extra } as any);
const A = { mailbox: "a@x.test", can_read: true }, A2 = { mailbox: "b@x.test", can_read: true };
const boom = async () => { throw new Error("boom"); };
const empty = { applications: async () => [], events: async () => [] };
const caps = (d: Record<string, unknown>) => capabilityTools({ tracking: true, connectUrl: "https://x.test/connect", situation: null, files: null, people: null, inbox: null, reply: null, snapshot: null, cursor: null, mail: empty, ...d } as any);
const readRecord = async (d: Record<string, unknown>, state: Record<string, unknown> = {}) => {
  const c: any = { userId: "u1", threadId: "t", now: NOW, state, turn: { message: "have i applied to Google?", added: [] } };
  const r: any = await caps(d).find((t) => t.name === "read_application_mail")!.run({}, c);
  return { r, c, said: JSON.stringify(r.coverage) };
};
const OK_NOW = async () => ({ status: "ok", read: 0, statuses: [], offers: [], read_through: "2026-11-13T00:00:00Z" });
const SAYS_READ = /Gmail accounts? read \(/;

Deno.test("AC-1 a failed read is never counted as read and never a zero", async () => {
  // The blocker: Gmail connected, the live read throws and both stores throw.
  let x = await readRecord({ accounts: async () => [A], readNow: boom, mail: { applications: boom, events: boom } });
  eq(x.r.read.status, "failed");
  ok(x.r.counts.applied === null && x.c.turn.counts === undefined, `no count from a failed read: ${JSON.stringify(x.r.counts)}`);
  ok(!SAYS_READ.test(x.said) && /could not read/.test(x.said) && x.said.includes("a@x.test"), x.said);
  eq(x.r.mail.accounts_read, []); eq(x.r.mail.accounts_failed, ["a@x.test"]);
  ok(/unknown|unconfirmed/i.test(x.r.note) && !/counts\.applied applications went/.test(x.r.note), x.r.note);
  // The live read answers ERROR and the stores are empty: the stores were read, the mailbox was not.
  x = await readRecord({ accounts: async () => [A], readNow: async () => ({ status: "ERROR", detail: "gmail 500", statuses: [], offers: [] }) });
  eq([x.r.read.status, x.r.counts.applied, x.c.turn.counts], ["partial", null, undefined]);
  ok(!SAYS_READ.test(x.said) && x.r.read.could_not_read.some((w: string) => w.includes("a@x.test")), x.said);
  // Which accounts are connected could not be read: nothing says whether a Gmail holds a confirmation.
  x = await readRecord({ accounts: boom });
  eq([x.r.mail.gmail, x.r.counts.applied], ["unknown", null]);
  ok(x.r.read.status !== "complete" && /could not/.test(x.said), x.said);
  // Two accounts, one read: partial, each named on its side.
  x = await readRecord({ accounts: async () => [A, A2], readNow: async () => ({ ...(await OK_NOW()), mailboxes: ["a@x.test"] }) });
  eq([x.r.read.status, x.r.counts.applied], ["partial", null]);
  eq([x.r.mail.accounts_read, x.r.mail.accounts_failed], [["a@x.test"], ["b@x.test"]]);
  ok(/1 Gmail account read \(a@x\.test\)/.test(x.said) && /could not read[^"]*b@x\.test/.test(x.said), x.said);
  // The live read worked, one store did not; what was found is "at least", never the total.
  x = await readRecord({ accounts: async () => [A], readNow: OK_NOW, mail: { applications: async () => [], events: boom } },
    { trackStore: { rows: [{ company: "Stripe", role: "SWE Intern", stage: "Applied", applied_at: "2026-11-01" }] } });
  eq(x.r.read.status, "partial");
  ok(x.r.counts.applied === null && x.c.turn.counts === undefined && /mail events/.test(x.said), x.said);
  if (x.r.applied.length) eq(x.r.counts.applied_at_least, x.r.applied.length);
  // Everything read and nothing found: a real zero, with what was read.
  x = await readRecord({ accounts: async () => [A], readNow: OK_NOW });
  eq([x.r.read.status, x.r.counts.applied, x.c.turn.counts, x.r.read.could_not_read], ["complete", 0, { applied: 0 }, []]);
  ok(/1 Gmail account read \(a@x\.test\), through 2026-11-13/.test(x.said), x.said);
  // No Gmail connected, stores read: complete for what exists, and the coverage says no email was read.
  x = await readRecord({ accounts: async () => [] });
  eq([x.r.read.status, x.r.counts.applied], ["complete", 0]);
  ok(/no Gmail is connected/.test(x.said));
});

const FAIL_TOOL = { name: "read_application_mail", effect: "read", description: "test", input_schema: { type: "object", properties: {} }, run: boom };
const NONE = "You haven't applied to anything yet.";
Deno.test("AC-2 a failed lookup does not count as checked; the claim is re-asked once, then said as unconfirmed", async () => {
  const pc = B.processCheck({ draftAsk: false, planSearch: false, parts: [], history: true, mail: true })!;
  const failed = [{ name: "read_application_mail", ok: false, error: "boom" }];
  ok(/failed|could not/.test(pc(`I checked your email: ${NONE}`, failed) ?? ""), "a failed call is not a lookup");
  eq(pc("I couldn't read your Gmail just now, so I can't confirm what you've applied to.", failed), null, "the honest reply stands");
  eq(pc("Your Gmail shows Bank A.", [{ name: "read_application_mail", ok: true }]), null);
  // A lookup that returned, with a partial or failed read, is not a successful lookup either.
  const part = B.processCheck({ draftAsk: false, planSearch: false, parts: [], history: true, mail: true, record: () => ({ status: "partial", could_not_read: ["Gmail account b@x.test"] }) })!;
  ok((part(NONE, [{ name: "read_application_mail", ok: true }]) ?? "").includes("b@x.test"));
  // Through the turn: the tool throws, the model says "not applied" twice.
  const s = scripted([use("read_application_mail", {}), text(NONE), text(`No. ${NONE} Start with PayPal.`)]);
  const r = await turn("have i applied to anything yet?", s.model, { capabilities: [FAIL_TOOL] });
  ok(s.seen.length === 3 && /lookup[^.]*failed/i.test(s.seen[2].system), "asked again once, with the failure");
  ok(!B.saysNoApplications(r.reply) && /unconfirmed/.test(r.reply), r.reply);
  // The model corrects itself on the re-ask: its own words stand.
  const fixed = "I couldn't read your application record just now, so I can't confirm whether you've applied anywhere.";
  const s2 = scripted([use("read_application_mail", {}), text(NONE), text(fixed)]);
  eq((await turn("have i applied to anything yet?", s2.model, { capabilities: [FAIL_TOOL] })).reply, fixed);
  // The real tool, Gmail failing: the zero never reaches the person.
  const s3 = scripted([use("read_application_mail", {}), text("You have 0 applications so far."), text("You have 0 applications so far.")]);
  const r3 = await turn("how many applications have i sent?", s3.model, { capabilities: caps({ accounts: async () => [A], readNow: boom, mail: { applications: boom, events: boom } }) });
  ok(!B.saysNoApplications(r3.reply) && /unconfirmed/.test(r3.reply) && r3.reply.includes("a@x.test"), r3.reply);
});

// [reply, asserts that the person has no applications / has not applied]
const REPLIES: [string, boolean][] = [
  ["There are no applications on file for you.", true], ["You haven't applied anywhere yet.", true], ["I don't see any applications from you so far.", true],
  ["Nothing submitted so far.", true], ["You have 0 applications.", true], ["You haven't applied to anything yet.", true], ["You have not applied to Google.", true],
  ["I checked your email and found no record of an application to Google.", true], ["Nothing in your Gmail shows a Google application, so you're clear to apply.", true],
  ["No, you have not yet applied there.", true], ["Nope, no Stripe application on my end.", true], ["You have no applications on record.", true],
  ["Zero applications so far.", true], ["You didn't apply to Stripe.", true], ["You never applied to Citadel.", true], ["I couldn't find any applications in your inbox.", true],
  ["Your tracker is empty right now.", true], ["No applications yet, so start with PayPal.", true], ["You've not submitted any applications.", true],
  ["Looks like you have yet to apply anywhere.", true], ["None of your applications have gone out.", true], ["I see no sign of a Ramp application.", true],
  ["you havent applied to any of these", true], ["You haven’t applied to PayPal.", true], ["There's nothing on record for you yet.", true],
  ["You have not submitted anything to Google.", true], ["Not applied anywhere yet.", true], ["No record of you applying to Stripe.", true],
  ["You haven't applied to this one yet per your tracker.", true], ["I don't have any applications on file for you.", true],
  ["So far you haven't sent in a single application.", true], ["No applications have been submitted yet.", true],
  ["Here's the plan.\nYou haven't applied anywhere, so this week is for applications.", true],
  ["No applications are needed for this event.", false], ["Nothing was sent or submitted.", false], ["I haven't submitted anything for you.", false],
  ["No applications were sent by me.", false], ["I couldn't read your application record just now, so whether you've applied is unconfirmed.", false],
  ["If you haven't applied yet, I can queue it for you.", false], ["Have you applied to Stripe already?", false], ["There is no application fee for this program.", false],
  ["Applications open in January.", false], ["Your Gmail shows 3 applications: Stripe, Ramp and PayPal.", false], ["You applied to Stripe on Nov 2.", false],
  [EMPTY_REPLY, false], [INCOMPLETE_REPLY, false], [MAX_STEPS_REPLY, false], ["The posting has no application deadline listed.", false],
  ["I can't check your applications right now, so I can't confirm whether you applied.", false], ["PayPal's internship pays $28 - $49 hourly.", false],
  ["Want me to check whether you've applied to Google?", false], ["No cover letter is required for this application.", false],
  ["Let me know once you've applied and I'll track it.", false], ["The role hasn't opened applications yet.", false], ["Nothing has been sent, saved or submitted.", false],
  ["You have 10 applications out.", false], ["No account, saved application or submission was created, and nothing was applied for.", false],
  ["I couldn't make that File: nothing on record for the path comparison: no comparison has been made for you yet.", false], ["You don't need to apply separately for the Chicago office.", false],
];
Deno.test("AC-3 a reply that says they have no applications needs a successful lookup, however the ask was phrased", async () => {
  ok(REPLIES.length >= 40);
  const wrong = REPLIES.filter(([r, want]) => B.saysNoApplications(r) !== want).map(([r, want]) => `${want ? "missed" : "false alarm"}: ${r}`);
  eq(wrong, [], `${REPLIES.length} replies`);
  // The gate: with no lookup every asserting reply is held; with a successful lookup it stands; a failed one holds it.
  const pc = B.processCheck({ draftAsk: false, planSearch: false, parts: [], noneClaim: true })!;
  for (const [r, asserts] of REPLIES) {
    eq(pc(r, []) !== null, asserts, `no lookup: ${r}`);
    eq(pc(r, [{ name: "read_application_mail", ok: true }]), null, `lookup ok: ${r}`);
    eq(pc(r, [{ name: "read_application_mail", ok: false, error: "x" }]) !== null, asserts, `lookup failed: ${r}`);
  }
  // The asks the review found unread.
  for (const a of ["any applications out so far?", "is my application to PayPal in?", "am i already in for the Citadel internship?", "which companies got my resume?", "do you see an application from me at Ramp?", "have i applied to anything yet?", "did i apply to stripe already"]) ok(N.historyAskOf(a), a);
  for (const a of ["what does the paypal one pay", "find me 5 internships", "when do applications open for citadel?"]) ok(!N.historyAskOf(a), a);
  // An unrelated ask, the tool offered, the model never calls it and says "none" twice: the reply does not stand.
  const okTool = { ...FAIL_TOOL, run: async () => ({ applied: [] }) };
  const none = "There are no applications on file for you.";
  const s = scripted([text(none), text(none)]);
  const r = await turn("what should i focus on this week?", s.model, { capabilities: [okTool] });
  ok(/did not read their record/.test(s.seen[1].system), "asked once");
  ok(!B.saysNoApplications(r.reply) && /unconfirmed/.test(r.reply), r.reply);
  // No lookup tool on the turn at all: still never sent as is.
  const s2 = scripted([text(`${none} Start with your resume.`), text(`${none} Start with your resume.`)]);
  const r2 = await turn("what should i focus on this week?", s2.model);
  ok(!B.saysNoApplications(r2.reply) && /unconfirmed/.test(r2.reply) && /Start with your resume/.test(r2.reply), r2.reply);
  // After a successful lookup the same sentence is the record's answer and stands.
  const s3 = scripted([use("read_application_mail", {}), text(none)]);
  eq((await turn("any applications out so far?", s3.model, { capabilities: [okTool] })).reply, none);
});

Deno.test("AC-4 a fact stated inside a request is a statement: add_profile_fact is offered and the save is accepted", async () => {
  const states = ["can you add that I interned at Google last summer?", "could you save my GPA as 3.7?", "did you note that i worked at Stripe in 2024?", "can you remember i'm a US citizen?",
    "put down that I led a team of 4 at the robotics club", "please note that I graduate in May 2027", "also I worked at Ramp last fall, can you tailor my resume?",
    "do I need sponsorship given that I'm on an F-1 visa?", "can you add Python and Go to my skills?", "I worked at Stripe in 2024. can you tailor my resume?", "I'm a junior at Lakeshore, what internships fit?"];
  for (const m of states) ok(!N.statesNothing(m), `states something: ${m}`);
  for (const m of ["what should i put at the top of my resume?", "have i applied to anything yet?", "what internships fit me?", "find me 5 swe internships in chicago", "i need to lock in for recruiting, what should i actually be doing?"]) ok(N.statesNothing(m), `states nothing: ${m}`);
  eq(N.statementsOf("what internships fit me?").stated, "");
  const msg = "can you add that I interned at Google last summer?";
  const s = scripted([use("add_profile_fact", { kind: "experience", text: "Interned at Google last summer" }), text("Saved as a draft: you interned at Google last summer. Tell me if that's off.")]);
  const stores: any = { profile: { facts: [] } };
  const r = await turn(msg, s.model, { stores });
  ok(s.seen[0].tools.some((t: any) => t.name === "add_profile_fact"), "add_profile_fact is offered (the X2 guarantee before #785)");
  const call = r.tool_calls.find((c) => c.name === "add_profile_fact");
  ok(call?.ok, `the save is accepted: ${JSON.stringify(call)}`);
  ok(stores.profile.facts.some((f: any) => /Google/.test(f.text) && f.status === "draft"), "saved as a draft, from their words");
  // A number they did not say is still refused (D-007).
  const s2 = scripted([use("add_profile_fact", { kind: "education", text: "GPA 4.0" }), text("ok")]);
  ok(!(await turn("could you save my GPA as 3.7?", s2.model)).tool_calls.find((c) => c.name === "add_profile_fact")?.ok);
});

const COLON = "Pay ranges. San Jose, CA: $32 - $55 per hour. Chicago, IL: $28 - $49 per hour.";
const ALL_COLON = "San Jose, CA: $32 - $55 per hour; Chicago, IL: $28 - $49 per hour";
const PIPE = "Pay by location: San Jose, California | ($32 - $55 Hourly) Chicago, Illinois | ($28 - $49 Hourly) Austin, Texas | ($27 - $47 Hourly)";
const ZONES = "Zone A: $120,000 - $150,000. Zone B: $110,000 - $138,000. Zone C: $100,000 - $125,000.";
const BAY = "Bay Area: $150,000 - $180,000 per year. All other US locations: $130,000 - $160,000 per year.";
const REMOTE = "New York, NY: $50 - $60 per hour. Remote: $40 - $48 per hour.";
const STATES = "California: $35 - $45 per hour. Illinois: $30 - $40 per hour. Texas: $28 - $38 per hour.";
const MIXED = "San Jose, CA: $32 - $55 per hour ($66,560 - $114,400 per year). Chicago, IL: $28 - $49 per hour ($58,240 - $101,920 per year).";
const PROSE = "The range is $32-$55 per hour in San Jose and $28-$49 per hour in Chicago.";
const PORTLAND = "Portland, Oregon | ($30 - $40 Hourly) Portland, Maine | ($20 - $25 Hourly)";
const PART = "The base range is $100,000 - $120,000. In San Francisco, CA: $120,000 - $140,000.";
// [posting text, the posting's location, the pay read]
const PAY: [string, string | null, string | null][] = [
  [COLON, "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"], [COLON, "San Jose, CA", "$32 - $55 per hour (San Jose, CA)"], [COLON, "New York, NY", ALL_COLON],
  [COLON, null, ALL_COLON], [COLON, "Remote", ALL_COLON], [COLON, "Chicago", "$28 - $49 per hour (Chicago, IL)"], [COLON, "Chicago, Illinois", "$28 - $49 per hour (Chicago, IL)"],
  [COLON, "San Jose, CA; Chicago, IL", ALL_COLON], [COLON, "Chicago, IL or Remote", "$28 - $49 per hour (Chicago, IL)"],
  [ZONES, "Chicago, IL", "Zone A: $120,000 - $150,000; Zone B: $110,000 - $138,000; Zone C: $100,000 - $125,000"],
  [BAY, "San Francisco, CA", "$150,000 - $180,000 per year (Bay Area)"], [BAY, "Chicago, IL", "Bay Area: $150,000 - $180,000 per year; All other US locations: $130,000 - $160,000 per year"],
  [REMOTE, "Remote", "$40 - $48 per hour (Remote)"], [REMOTE, "Remote - US", "$40 - $48 per hour (Remote)"], [REMOTE, "New York, NY", "$50 - $60 per hour (New York, NY)"],
  [STATES, "Chicago, IL", "$30 - $40 per hour (Illinois)"], ["CA: $35 - $45 per hour; IL: $30 - $40 per hour", "Chicago, Illinois", "$30 - $40 per hour (IL)"],
  [PIPE, "Austin, Texas", "$27 - $47 Hourly (Austin, Texas)"], [PIPE, "Chicago, IL", "$28 - $49 Hourly (Chicago, Illinois)"],
  [PIPE, "Scottsdale, Arizona", "San Jose, California: $32 - $55 Hourly; Chicago, Illinois: $28 - $49 Hourly; Austin, Texas: $27 - $47 Hourly"],
  ["Compensation by location\nSan Jose, CA\n$32 - $55 per hour\nChicago, IL\n$28 - $49 per hour", "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  [MIXED, "Chicago, IL", "$28 - $49 per hour / $58,240 - $101,920 per year (Chicago, IL)"],
  [MIXED, "Austin, TX", "San Jose, CA: $32 - $55 per hour / $66,560 - $114,400 per year; Chicago, IL: $28 - $49 per hour / $58,240 - $101,920 per year"],
  [PROSE, "Chicago, IL", "$28-$49 per hour (Chicago)"], [PROSE, "Austin, TX", "San Jose: $32-$55 per hour; Chicago: $28-$49 per hour"],
  // A bare "$32-$55" with no period after it is not read as pay at all (payFrom's floor): none, never a guess.
  ["The hourly range is $32-$55 in San Jose and $28-$49 in Chicago.", "Chicago, IL", null],
  [PORTLAND, "Portland, ME", "$20 - $25 Hourly (Portland, Maine)"], [PORTLAND, "Portland", "Portland, Oregon: $30 - $40 Hourly; Portland, Maine: $20 - $25 Hourly"],
  ["Pay: San Jose, California | ($32 - $55 Hourly)", "Chicago, IL", "San Jose, California: $32 - $55 Hourly"], ["Pay: San Jose, California | ($32 - $55 Hourly)", "San Jose, CA", "$32 - $55 Hourly"],
  ["Chicago, IL - $28 to $49 per hour; San Jose, CA - $32 to $55 per hour", "Chicago, IL", "$28 to $49 per hour (Chicago, IL)"],
  ["NYC: $60/hr. Chicago: $50/hr.", "New York, NY", "$60/hr (NYC)"], [PART, "Chicago, IL", null], [PART, "San Francisco, CA", "$120,000 - $140,000 (San Francisco, CA)"],
  ["San Jose, CA: $30 - $40 per hour. Chicago, IL: $30 - $40 per hour.", "Austin, TX", "$30 - $40 per hour"],
  ["Pay: $40-$50/hr. Benefits.", "Chicago, IL", "$40-$50/hr"], ["Pay: $40-$50/hr plus a $5,000 signing bonus.", null, "$40-$50/hr"], ["Competitive pay and benefits.", "Chicago, IL", null],
];
Deno.test("AC-5 pay listed by location: the posting's own place, or every range with its place, or none", () => {
  ok(PAY.length >= 25);
  const wrong = PAY.map(([t, loc, want]) => ({ t, loc, want, got: P.placedPay(t, loc) })).filter((x) => x.got !== x.want);
  eq(wrong, [], `${PAY.length} postings`);
  // Never another place's range without its place: for every by-location text and every location tried.
  for (const [t, loc] of PAY.filter(([t]) => [COLON, PIPE, STATES, MIXED, PROSE, REMOTE].includes(t))) {
    const got = P.placedPay(t, loc) ?? "";
    ok(got === "" || /[(:]/.test(got.replace(/\$[\d,.]+/g, "")), `unlabelled: ${got}`);
  }
});
