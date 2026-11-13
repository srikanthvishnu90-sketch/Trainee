// Owner must-fix: "check connected email before saying I haven't applied" (D-024, D-007). An independent review rejected #785
// (D-067); each finding is reproduced here at $0 (scripted model, in-memory stores, no Gmail call) and then fixed.
//   AC-1  a failed read is never a read and never a zero: per account and per store, "could not read", the count unknown;
//         one account or one store failing is a partial read, said as partial.
//   AC-2  only a successful lookup satisfies "checked email": after a failed one a reply saying "you haven't applied" is asked
//         again once with the failure, and if it still says so the outgoing reply says it is unconfirmed (code, not the prompt).
//   AC-3  the reply decides, not only the ask: any reply saying they have no applications needs a successful lookup this turn.
//   AC-4  a fact stated inside a request ("can you add that I interned at Google?") is a statement: add_profile_fact is offered
//         and the save is accepted (the guarantee the X2 control of mirror-wa-batch1-gaps-handler had before #785).
//   (AC-5, pay by location, moved with posting_pay.ts to its own branch, ag/posting-pay-by-location.)
// Round 2 (the adversarial review of round 1):
//   AC-6  a save is accepted only from what the message asserts in the first person; never from a question about what to say, a
//         condition, someone else's words, a topic, or the opposite of a negated statement (the reviewer's 45 + 40 more).
//   AC-7  the reviewer's matrix (accounts x live read x stores x tracker, 476 cells): nothing unread is said to be read, no count
//         and no "complete" from an incomplete read, a hung or malformed live read is a failed one; no scope / tracking off too.
//   AC-8  structural, not by phrasing: after a partial or failed read none of the reviewer's 77 denials survives in any wording,
//         and after a complete read none of the 127 replies loses a sentence.
//   AC-9  end to end: code runs the lookup when the model did not; the coverage is said by code; a real question inside a
//         hypothetical is looked up; nothing honest is stripped; no orphaned list, "I checked." or empty reply.
//   AC-10 the code-written lines outside the brain say their basis (Trainee's own record; email not checked).
//   deno test -A --no-check tests/architect/applied-check-failclosed-20261113.test.ts
import assertNode from "node:assert/strict";
import * as B from "../../supabase/functions/agent-chat/career_brain.ts";
import * as N from "../../supabase/functions/_shared/agent/turn_notes.ts";
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
const caps = (d: Record<string, unknown>) => capabilityTools({ readTimeoutMs: 50, tracking: true, connectUrl: "https://x.test/connect", situation: null, files: null, people: null, inbox: null, reply: null, snapshot: null, cursor: null, mail: empty, ...d } as any);
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
  // Round 2: after a failed read the words about their applications are code's (the coverage line); nothing else is added.
  const r2 = (await turn("have i applied to anything yet?", s2.model, { capabilities: [FAIL_TOOL] })).reply;
  ok(/^I couldn't read your application record just now, so whether you've applied is unconfirmed\./.test(r2) && !B.saysNoApplications(r2), r2);
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


// ------------------------------------------------------------------------------------------------ round 2
// [message, a save is right (true) / nothing may be saved (false), the fact a model would try to save]
const SAVES: [string, boolean, string][] = [
  // the reviewer's 45
  ["can you add that I interned at Google last summer?", true, "Interned at Google last summer"], ["put down that I know Rust", true, "Knows Rust"], ["note I graduated in 2024", true, "Graduated in 2024"],
  ["also I worked at Stripe", true, "Worked at Stripe"], ["did I mention I led a team of 5?", true, "Led a team of 5"], ["could you save my GPA as 3.7?", true, "GPA 3.7"], ["can you remember i'm a US citizen?", true, "US citizen"],
  ["please add: fluent in Spanish", true, "Fluent in Spanish"], ["add Rust to my skills pls", true, "Rust"], ["btw i'm graduating may 2027, does that change anything?", true, "Graduating May 2027"],
  ["can u update my profile, i switched my major to stats", true, "Switched major to stats"], ["will you write down that my school is Lakeshore?", true, "School is Lakeshore"],
  ["do you have it that I was a TA for CS101?", true, "TA for CS101"], ["would it help that I speak Mandarin?", true, "Speaks Mandarin"], ["what can I get with my 3 years at Deloitte?", true, "3 years at Deloitte"],
  ["hey can you find swe internships? i know python and go", true, "Knows Python and Go"], ["is it bad that I only have one internship?", true, "Has one internship"],
  ["since I'm on an F-1 visa, which companies sponsor?", true, "On an F-1 visa"], ["can you jot that i did research with prof lee", true, "Did research with Prof Lee"], ["log that I finished the AWS cert", true, "Finished the AWS cert"],
  ["can you add something about leadership?", false, "Leadership experience"], ["should I say I know Rust?", false, "Knows Rust"], ["what if I had interned at Google?", false, "Interned at Google"],
  ["my friend interned at Google, can you find similar roles?", false, "Interned at Google"], ["do you think I should add that I managed people?", false, "Managed people"],
  ["my recruiter said I have 5 years of experience, is that right?", false, "5 years of experience"], ["can you note that I never interned at Google?", false, "Interned at Google"],
  ["I never interned at Google, can you stop suggesting it?", false, "Interned at Google"], ["should I put down that I'm fluent in French even though I'm not?", false, "Fluent in French"],
  ["would it look better if I said I led a team of 5?", false, "Led a team of 5"], ["can you add a line about Python to my resume?", false, "Knows Python"],
  ["could I say I graduated in 2024?", false, "Graduated in 2024"], ["is it ok to write that i worked at stripe?", false, "Worked at Stripe"], ["do I need to mention my GPA?", false, "GPA"],
  ["how do I note a gap year on my resume?", false, "Took a gap year"], ["what would you save if I told you I interned at Meta?", false, "Interned at Meta"],
  ["the posting says candidates must know Rust, do I qualify?", false, "Knows Rust"], ["can you remember to check Stripe tomorrow?", false, "Check Stripe tomorrow"],
  ["do recruiters care whether i was a TA?", false, "Was a TA"], ["am I supposed to include that I'm a citizen?", false, "Citizen"], ["can you record a mock interview with me?", false, "Mock interview"],
  ["have i told you i worked at stripe? (i didn't, i'm asking what's saved)", false, "Worked at Stripe"], ["my roommate says i should claim i know kubernetes, thoughts?", false, "Knows Kubernetes"],
  ["include my linkedin? or not", false, "LinkedIn"], ["I didn't graduate in 2024, did you save that?", false, "Graduated in 2024"],
  // 40 more
  ["can you note that I'm graduating in May 2027?", true, "Graduating May 2027"], ["please put down that I worked at Ramp last fall", true, "Worked at Ramp last fall"],
  ["could you add that I have a 3.8 GPA?", true, "GPA 3.8"], ["can you save that I'm based in Chicago?", true, "Based in Chicago"], ["I'm a junior at Lakeshore, what internships fit?", true, "Junior at Lakeshore"],
  ["I worked at Stripe in 2024. can you tailor my resume?", true, "Worked at Stripe in 2024"], ["will you remember that I know Python and SQL?", true, "Knows Python and SQL"],
  ["can you write down that my major is statistics?", true, "Major is statistics"], ["also i'm authorized to work in the US, does that help?", true, "Authorized to work in the US"],
  ["can you add Go to my skills?", true, "Go"], ["note that I led a team of 4 at the robotics club", true, "Led a team of 4 at the robotics club"],
  ["do I need sponsorship given that I'm on an F-1 visa?", true, "On an F-1 visa"], ["can you log that I passed the CFA level 1 exam?", true, "Passed the CFA level 1 exam"],
  ["btw I speak Spanish and Portuguese, can you find roles that use them?", true, "Speaks Spanish and Portuguese"], ["can you include that I was captain of the debate team?", true, "Captain of the debate team"],
  ["I never worked in finance, can you note that I never worked in finance?", true, "Never worked in finance"], ["can you jot down that my GPA is 3.6?", true, "GPA is 3.6"],
  ["since I have 2 years at Deloitte, what level should I target?", true, "2 years at Deloitte"], ["could you record that I graduated from Lakeshore in 2025?", true, "Graduated from Lakeshore in 2025"],
  ["would it help that I've published a paper?", true, "Published a paper"],
  ["should I mention that I speak French?", false, "Speaks French"], ["can I claim I led the robotics team?", false, "Led the robotics team"], ["would it be fine to say I have a 3.9 GPA?", false, "GPA 3.9"],
  ["my brother works at Stripe, can he refer me?", false, "Works at Stripe"], ["I don't have a security clearance, does that matter?", false, "Has a security clearance"],
  ["I'm not a US citizen, which roles sponsor?", false, "US citizen"], ["can you add a section on projects?", false, "Projects"], ["people say I should list Excel, should I?", false, "Knows Excel"],
  ["if I get the AWS cert, will you add it?", false, "AWS cert"], ["do I have to include my graduation year?", false, "Graduation year"], ["can you note what the recruiter said about visas?", false, "Recruiter said visas"],
  ["I wasn't on the dean's list, can you remove that?", false, "Dean's list"], ["is it true that I need a 3.5 GPA for Citadel?", false, "GPA 3.5"], ["maybe I should put that I managed a budget?", false, "Managed a budget"],
  ["can you save this posting for later?", false, "Posting for later"], ["she told me I'm overqualified, am I?", false, "Overqualified"], ["would you add that I know SQL if I took a course?", false, "Knows SQL"],
  ["I haven't graduated yet, can I still apply?", false, "Graduated"], ["does it matter whether I interned or not?", false, "Interned"], ["could I write that I'm bilingual?", false, "Bilingual"],
];
Deno.test("AC-6 a save is accepted only from a first-person assertion in the message; never a doubt, a topic, someone else, or the opposite", async () => {
  eq(SAVES.length, 85);
  const wrong: string[] = [], missed: string[] = [];
  for (const [m, want, fact] of SAVES) {
    const s = scripted([use("add_profile_fact", { kind: "other", text: fact }), text("ok")]);
    const stores: any = { profile: { facts: [] } };
    const r = await turn(m, s.model, { stores });
    const saved = stores.profile.facts.length > 0 || !!r.tool_calls.find((c) => c.name === "add_profile_fact")?.ok;
    if (saved && !want) wrong.push(`${m} => ${stores.profile.facts.map((f: any) => f.text).join("|")}`);
    if (!saved && want) missed.push(m);
  }
  eq(wrong, [], "nothing they did not assert is saved");
  ok(missed.length <= 2, `true saves missed: ${missed.join(" | ")}`);
  // A negated statement is saved only as negated.
  const neg = scripted([use("add_profile_fact", { kind: "other", text: "Never interned at Google" }), text("ok")]);
  ok((await turn("I never interned at Google, can you stop suggesting it?", neg.model)).tool_calls[0]?.ok, "their own negated words are theirs");
});

Deno.test("AC-7 the read matrix: nothing unread is read, no count from an incomplete read, a hung or malformed read is failed", async () => {
  const okNow = (extra: any = {}) => async () => ({ status: "ok", read: 0, statuses: [], offers: [], read_through: "2026-11-13T00:00:00Z", ...extra });
  const reads: Record<string, { f: (b: string[]) => any; truth: (b: string[]) => string[] }> = {
    ok_all: { f: (b) => okNow({ mailboxes: b }), truth: (b) => b }, ok_nofield: { f: () => okNow(), truth: (b) => b }, ok_first_only: { f: (b) => okNow({ mailboxes: b.slice(0, 1) }), truth: (b) => b.slice(0, 1) },
    throws: { f: () => boom, truth: () => [] }, timeout: { f: () => () => new Promise(() => {}), truth: () => [] }, empty_mailboxes: { f: () => okNow({ mailboxes: [] }), truth: () => [] },
    ERROR: { f: () => async () => ({ status: "ERROR", detail: "x", statuses: [], offers: [] }), truth: () => [] }, NOT_WIRED: { f: () => async () => ({ status: "NOT_WIRED" }), truth: () => [] },
    mal_null: { f: () => async () => null, truth: () => [] }, mal_obj: { f: () => async () => ({}), truth: () => [] }, mal_str: { f: () => async () => "ok", truth: () => [] },
    mal_ok_no_through: { f: (b) => async () => ({ status: "ok", mailboxes: b }), truth: (b) => b }, mal_mailboxes_string: { f: (b) => okNow({ mailboxes: b[0] }), truth: (b) => b.slice(0, 1) },
    mal_mailboxes_other: { f: () => okNow({ mailboxes: ["zzz@x.test"] }), truth: () => [] }, mal_status_OK: { f: (b) => async () => ({ status: "OK", mailboxes: b }), truth: () => [] },
    none_cursor: { f: () => null, truth: (b) => b }, none_nocursor: { f: () => null, truth: () => [] },
  };
  const stores: Record<string, any> = { ok_ok: empty, apps_throw: { applications: boom, events: async () => [] }, events_throw: { applications: async () => [], events: boom }, both_throw: { applications: boom, events: boom },
    apps_null: { applications: async () => null, events: async () => [] }, events_null: { applications: async () => [], events: async () => null }, no_store: null };
  let cells = 0; const bad: string[] = [];
  for (const accts of [[A], [A, A2]]) for (const [rn, rd] of Object.entries(reads)) for (const [sn, st] of Object.entries(stores)) for (const tracker of [false, true]) {
    cells++;
    const boxes = accts.map((a) => a.mailbox), truth = rd.truth(boxes), complete = truth.length === boxes.length && sn === "ok_ok";
    const x = await readRecord({ accounts: async () => accts, readNow: rd.f(boxes), mail: st, cursor: async () => (rn === "none_cursor" ? "2026-11-10T00:00:00Z" : null) },
      tracker ? { trackStore: { rows: [{ company: "Stripe", role: "SWE Intern", stage: "Applied", applied_at: "2026-11-01" }] } } : {});
    const said = /Gmail accounts? read \(([^)]*)\)/.exec(x.said)?.[1].split(", ") ?? [];
    const p = [...said.filter((m) => !truth.includes(m)).map((m) => `claims read ${m}`), typeof x.r.counts.applied === "number" && !complete ? "a count" : "", x.c.turn.counts && !complete ? "turn.counts" : "",
      (x.r.read.status === "complete") !== complete ? `status ${x.r.read.status}` : "", !complete && !/unknown/.test(x.r.note) ? "note" : ""].filter(Boolean);
    if (p.length) bad.push(`${accts.length} ${rn} ${sn} ${tracker}: ${p.join("; ")}`);
  }
  eq([cells, bad], [476, []]);
  // Item 5: reading switched off, no permission to read, or a second account without it: not complete, the reason named, no count.
  for (const [d, why] of [[{ tracking: false, accounts: async () => [A], readNow: OK_NOW }, /a@x\.test \(reading email is switched off\)/], [{ accounts: async () => [{ mailbox: "a@x.test", can_read: false }] }, /a@x\.test \(no permission to read mail\)/],
    [{ accounts: async () => [A, { mailbox: "b@x.test", can_read: false }], readNow: OK_NOW }, /b@x\.test \(no permission to read mail\)/]] as [Record<string, unknown>, RegExp][]) {
    const x = await readRecord(d);
    ok(x.r.read.status === "partial" && x.r.counts.applied === null && x.r.read.could_not_read.some((w: string) => why.test(w)), `${why}: ${JSON.stringify(x.r.read)}`);
  }
});

// The reviewer's replies: [reply, says or implies they have not applied / have none]
const DENIALS = ["Nothing's gone out yet.", "Nothing has gone out yet.", "Your tracker is empty.", "I couldn't find any applications.", "You're yet to apply.", "You are yet to apply anywhere.", "Zero so far.", "None on record.", "None so far.", "None yet.",
  "You still need to apply to Stripe.", "That one isn't submitted.", "That one hasn't been submitted yet.", "Stripe isn't in your applications.", "Your application count is 0.", "Applications sent: 0", "Applications: none", "- Applied: none", "**Applications:** 0",
  "You’ve applied nowhere so far.", "You've applied to nothing yet.", "You haven’t put in an application anywhere.", "You have yet to send an application.", "Your pipeline is empty.", "Your applications list is empty.", "There aren't any applications in your record.",
  "There aren’t any applications yet.", "Stripe: not applied", "Stripe — not applied yet", "| Stripe | Not applied |", "Status: not yet applied.", "You haven't applied 😅", "0 applications 🙃 let's fix that", "You're at zero applications.", "You are starting from zero.",
  "You're starting from scratch on applications.", "This would be your first application.", "Let's get your first application out.", "No apps yet.", "You haven't applied to any jobs.", "You have not applied for this role.", "I don't see that you've applied to Stripe.",
  "It doesn't look like you've applied to Stripe.", "It looks like you haven't applied.", "Doesn't look like anything's been submitted.", "Haven't applied to Stripe yet, so go for it.", "Since you haven't applied anywhere, start with three this week.",
  "Because you have no applications out, there's nothing to follow up on.", "There's nothing to follow up on yet.", "You have nothing pending.", "I found nothing for Stripe in your Gmail.", "Your Gmail has no confirmation from Stripe.", "No confirmation emails from any employer.",
  "Stripe is not among the companies you've applied to.", "You've only researched roles, not applied to any.", "So far it's all research, no submissions.", "No submissions yet.", "You have made no submissions.", "You haven't sent anything out.", "You haven't sent any applications.",
  "U haven't applied anywhere yet", "you have NOT applied to Stripe", "You havent submitted anything", "You haven`t applied.", "Not yet — you haven't applied to Stripe.", "The Stripe application was never sent.", "Your Stripe application didn't go through.",
  "Your application to Stripe is still a draft, it was not submitted.", "You've applied to 0 roles.", "You have applied to zero companies.", "Total applied: 0.", "Applied to none of these.", "None of these have been applied to.", "You haven't applied to: Stripe, Ramp, PayPal.",
  "Not applied:\n- Stripe\n- Ramp", "Je hebt nog nergens gesolliciteerd.", "No has aplicado a ninguna.", "Isn't in your applications.", "Doesn't look like you've applied.", "That's the only one.", "Nothing to follow up on."];
const HONEST = ["No.", "If you hadn't applied anywhere, I'd start with three applications a week.", "Suppose you haven't applied: then start small.", "You said \"I haven't applied anywhere\" — want me to check your email to confirm?", "You told me you haven't applied anywhere yet.",
  "No applications are needed.", "No application is required for the info session.", "You don't need any application for the career fair.", "I haven't checked your applications, so I can't say whether you've applied.", "I can't confirm you haven't applied.",
  "I can't say you haven't applied until I read your Gmail.", "I'm not saying you haven't applied; I just can't see your inbox.", "Don't worry if you haven't applied yet.", "Many students haven't applied anywhere by November.", "Most people have no applications out this early.",
  "Your Gmail shows 2 applications: Stripe and Ramp.", "You applied to Stripe on Nov 2; no reply yet.", "You applied to Stripe, and there's been no response to your application.", "Stripe hasn't replied to your application.", "No interviews yet from your 3 applications.",
  "There's no update on your Ramp application.", "Applications that haven't been submitted stay as drafts.", "The employer hasn't applied any filters.", "I never submit without your yes.", "No application leaves without your approval.", "Zero applications go out without your yes.",
  "Trainee sends no applications on its own.", "This posting takes no applications after Dec 1.", "They accept no applications from sophomores.", "No application was made by Trainee this turn.", "Nothing shows a deadline on the posting.", "Nothing on file for your GPA yet.",
  "I have nothing on record for your graduation year.", "You haven't uploaded a resume, so I can't apply yet.", "You haven't confirmed your resume.", "You haven't told me your major.", "Want to apply? You haven't applied to this one according to what you told me earlier, right?",
  "Not applying anywhere is fine for now if finals come first.", "You have 3 applications out and 0 rejections.", "0 of your 3 applications were rejected.", "You applied to 4 places; none of your applications were rejected.", "You have no rejected applications.",
  "No new applications since Monday: still Stripe and Ramp.", "You haven't applied anywhere new since Monday; Stripe and Ramp stand.", "You haven't applied the feedback from your last mock interview.", "You didn't apply the resume edits yet.", "I could not submit: the form needs a login.",
  "Before you apply, check the deadline.", "You shouldn't apply without a resume.", "Never applied through Workday before? Here's how."];
const LOOK = (status: string, o: Record<string, unknown> = {}) => ({ tried: status !== "none", ok: status === "complete", status, what: status === "partial" ? ["Gmail account b@x.test"] : [], read: status === "failed" || status === "none" ? [] : ["Gmail account a@x.test"], found: [], ...o }) as any;
Deno.test("AC-8 after a partial or failed read no denial survives in any wording; after a complete read no sentence is lost", () => {
  ok(DENIALS.length + HONEST.length >= 127);
  const tail = "Start with PayPal this week.";
  for (const status of ["partial", "failed"]) {
    const kept = DENIALS.filter((d) => { const out = B.applicationsEnforced(`${d}\n\n${tail}`, LOOK(status), { message: "have i applied to stripe?" }); return d.split("\n").some((l) => out.includes(l)) || !out.includes(tail) || !/unconfirmed/.test(out); });
    eq(kept, [], `${status}: denials that survived`);
  }
  // A complete read (and an employer found): every reply stands whole. With nothing found, the basis is added after it.
  for (const r of [...DENIALS, ...HONEST]) {
    eq(B.applicationsEnforced(r, LOOK("complete", { found: ["Stripe"] }), { message: "have i applied to stripe?" }), r);
    const zero = B.applicationsEnforced(r, LOOK("complete"), { message: "have i applied to stripe?" });
    ok(zero.startsWith(r) && zero.endsWith("Checked: Gmail account a@x.test."), zero);
  }
  // No read at all, on a turn that is not about applications: the review's false alarms keep every word.
  for (const r of ["No application leaves without your approval. I show you each one first.", "You haven't applied the feedback from your last mock interview. Try STAR.", "You have no rejected applications."]) {
    ok(!B.saysNoApplications(r), r);
    eq(B.applicationsEnforced(r, LOOK("none"), { message: "how do i get better at interviews?" }), r);
  }
  // A false trigger (the reply only brushed the subject, code ran the read, it was partial): no sentence is stripped.
  const brushed = "Your Ramp application is a good model for the next one. Try STAR.";
  ok(B.applicationsEnforced(brushed, LOOK("partial"), { message: "how do i get better at interviews?", codeRan: true }).startsWith(brushed));
  // What stays after an incomplete read: an employer the lookup found, said without a bound; and what has nothing to do with it.
  const part = LOOK("partial", { found: ["Stripe"] });
  const out = B.applicationsEnforced("I checked. Your Gmail shows Stripe (SWE Intern). That's the only one. You haven't applied to Ramp.\n\nWant help with interview prep?", part, { message: "where have i applied?" });
  ok(out.includes("Your Gmail shows Stripe (SWE Intern).") && out.includes("Found so far, at least: Stripe.") && out.includes("Want help with interview prep?") && !/only one|Ramp/.test(out), out);
  ok(out.includes("I read Gmail account a@x.test") && out.includes("couldn't read Gmail account b@x.test"), out);
  // Leftovers: no "I checked." after a failed read, no orphaned list or heading, never empty; and applying it twice changes nothing.
  const messy = "I checked. Here's where things stand.\nYou haven't applied to:\n- Stripe\n- Ramp\nThat is all three.\n\n**Status:** nothing yet.\n1. You have 0 applications. Fix that first.\n2. Then prep for interviews.";
  const held = B.applicationsEnforced(messy, LOOK("failed"), { message: "have i applied?" });
  eq(held, "I couldn't read your application record just now, so whether you've applied is unconfirmed. Ask me again and I'll check.\n\nThen prep for interviews.");
  eq(B.applicationsEnforced(held, LOOK("failed"), { message: "have i applied?" }), held);
  ok(B.applicationsEnforced("None.", LOOK("failed"), { message: "have i applied?" }).length > 40);
});

Deno.test("AC-9 end to end: code looks up when the model did not, says the coverage, and keeps what is honest", async () => {
  const partial = { accounts: async () => [A, A2], readNow: async () => ({ ...(await OK_NOW()), mailboxes: ["a@x.test"] }) };
  const one = { ...partial, mail: { applications: async () => [{ ref: "job:1", company: "Stripe", role: "SWE Intern", applied_at: "2026-11-01", stage: "Submitted", source: "queue", events: [] }], events: async () => [] } };
  const L = (t: string) => [use("read_application_mail", {}), text(t), text(t), text(t)];
  // Partial read: no wording of "not applied" gets through, and code says what was and was not read.
  for (const esc of ["You haven't applied to Stripe.", "Stripe isn't in your applications.", "No, it doesn't look like you've applied to Stripe.", "None on record for Stripe.", "You're yet to apply to Stripe.", "Nope, zero so far.", "Stripe: not applied."]) {
    const r = await turn("have i applied to stripe?", scripted(L(esc)).model, { capabilities: caps(partial) });
    ok(!r.reply.includes(esc) && /I read Gmail account a@x\.test.*couldn't read Gmail account b@x\.test.*unconfirmed/.test(r.reply), `${esc} => ${r.reply}`);
  }
  for (const total of ["You've applied to 1 place: Stripe.", "Just one application so far: Stripe. That's the only one."]) {
    const r = await turn("how many applications have i sent?", scripted(L(total)).model, { capabilities: caps(one) });
    ok(!/1 place|only one|Just one/.test(r.reply) && r.reply.includes("Found so far, at least: Stripe."), r.reply);
  }
  // Item 5 through the turn: tracking off, or no permission to read: never "you haven't applied" on Trainee's record alone.
  for (const d of [{ tracking: false, accounts: async () => [A], readNow: OK_NOW }, { accounts: async () => [{ mailbox: "a@x.test", can_read: false }] }, { accounts: async () => [A, { mailbox: "b@x.test", can_read: false }], readNow: OK_NOW }]) {
    const r = await turn("have i applied to anything yet?", scripted(L(NONE)).model, { capabilities: caps(d) });
    ok(!r.reply.includes(NONE) && /unconfirmed/.test(r.reply) && /switched off|no permission/.test(r.reply), r.reply);
  }
  // A complete read with nothing found: the reply stands and shows its basis.
  const ok1 = { accounts: async () => [A], readNow: OK_NOW };
  eq((await turn("have i applied to anything yet?", scripted(L(NONE)).model, { capabilities: caps(ok1) })).reply, `${NONE}\n\nChecked: Gmail account a@x.test and Trainee's saved record.`);
  // The model never looks: code runs the lookup and puts the record to the model once (its rewrite is the reply).
  const seen: any[] = [];
  const lazy = async (p: any) => { seen.push(p); return p.tools?.length ? text("You haven't applied anywhere yet, so start with PayPal.") : text(/Record: /.test(JSON.stringify(p.messages)) ? "Your record shows no applications yet, so start with PayPal." : ""); };
  const r5 = await turn("what should i focus on this week?", lazy, { capabilities: caps(ok1) });
  eq(r5.tool_calls.map((c) => [c.name, c.ok]), [["read_application_mail", true]], "code ran the lookup");
  ok(seen.some((p) => !p.tools?.length && /"applied":\[\]/.test(JSON.stringify(p.messages))), "the model was asked once with the record as facts");
  eq(r5.reply, "Your record shows no applications yet, so start with PayPal.\n\nChecked: Gmail account a@x.test and Trainee's saved record.");
  // Item 6: a real question inside a hypothetical is looked up; a true hypothetical is left alone.
  for (const m of ["have i applied anywhere? if i had, which ones?", "i can't imagine i've applied anywhere yet, have i?", "if i was rejected by stripe, have i applied anywhere else?"]) {
    const r = await turn(m, scripted([text(NONE), text(NONE), text(NONE)]).model, { capabilities: caps(ok1) });
    ok(r.tool_calls.some((c) => c.name === "read_application_mail" && c.ok) && r.reply.includes("Checked: Gmail account a@x.test"), `${m} => ${r.reply}`);
  }
  const hyp = "If you hadn't applied anywhere, I'd start with three a week.";
  const r7 = await turn("if i hadn't applied anywhere, what would you do?", scripted([text(hyp), text(hyp)]).model, { capabilities: caps(ok1) });
  eq([r7.reply, r7.tool_calls.length], [hyp, 0]);
  // Item 8: a turn that is not about applications, no lookup tool: nothing honest is stripped.
  for (const [m, rep] of [["how do i get better at interviews?", "You haven't applied the feedback from your last mock interview. Try STAR."], ["will you apply without asking me?", "No application leaves without your approval. I show you each one first."]])
    eq((await turn(m, scripted([text(rep), text(rep)]).model)).reply, rep);
  // Item 7: the tool throws: no "I checked.", no orphan, never empty.
  const r15 = await turn("have i applied to stripe?", scripted(L("I checked. You haven't applied to Stripe. Want me to queue it?")).model, { capabilities: [FAIL_TOOL] });
  eq(r15.reply, "I couldn't read your application record just now, so whether you've applied is unconfirmed. Ask me again and I'll check.");
});

Deno.test("AC-10 the code-written lines outside the brain say their basis", async () => {
  const { statusReply } = await import("../../supabase/functions/_shared/career_apply_status.ts");
  const { overviewTurn } = await import("../../supabase/functions/_shared/career_overview.ts");
  const { findTargets } = await import("../../supabase/functions/_shared/career_people_provider.ts");
  const basis = /Trainee's own record/, mail = /email was not checked/;
  for (const m of ["did my application go through?", "did my stripe application go through?", "status of my applications"]) { const r = (statusReply as any)(m, [], NOW)?.reply ?? ""; ok(basis.test(r) && mail.test(r), `${m} => ${r}`); }
  const sit: any = { tasks: [], unreadable: [], today: { used: 0, limit: null }, goal: null, alerts: null, capabilities: {}, questions: [] };
  const o = (overviewTurn as any)({ message: "any update?", situation: sit, now: NOW })?.reply ?? "";
  ok(/Nothing is in flight/.test(o) && basis.test(o) && mail.test(o), o);
  const t = await (findTargets as any)("u", { kind: "applied", titles: [], seniority: [] }, { store: { appliedCompanies: async () => [] } });
  ok(basis.test(t.reply) && mail.test(t.reply) && !/You haven't applied/.test(t.reply), t.reply);
  const src = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/career_inbox_followups.ts", import.meta.url));
  ok(/on record, so there's no \$\{what\} to send\. That is Trainee's own record and your tracker; your email was not checked for this answer\./.test(src), "the follow-up line names its basis");
});
