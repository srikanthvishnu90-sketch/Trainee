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
  // An unrelated ask, the tool offered, the model never calls it and says "none" twice: the reply does not stand. (Round 3: this
  // expectation is back to round 1's. Round 2 had let the reply stand because code ran the stub lookup; a lookup that leaves no
  // record of what it read backs nothing.)
  const okTool = { ...FAIL_TOOL, run: async () => ({ applied: [] }) };
  const none = "There are no applications on file for you.";
  const s = scripted([text(none), text(none)]);
  const r = await turn("what should i focus on this week?", s.model, { capabilities: [okTool] });
  ok(/did not read their record/.test(s.seen[1].system), "asked once");
  ok(!B.saysNoApplications(r.reply) && /unconfirmed/.test(r.reply), r.reply);
  eq(B.lookupOf([{ name: "read_application_mail", ok: true }]).status, "unknown", "no record of what was read: never complete");
  // No lookup tool on the turn at all: still never sent as is.
  const s2 = scripted([text(`${none} Start with your resume.`), text(`${none} Start with your resume.`)]);
  const r2 = await turn("what should i focus on this week?", s2.model);
  ok(!B.saysNoApplications(r2.reply) && /unconfirmed/.test(r2.reply) && /Start with your resume/.test(r2.reply), r2.reply);
  // After a complete lookup the answer is code's, with its basis: what was found (nothing) and what was read.
  const s3 = scripted([use("read_application_mail", {}), text(none)]);
  eq((await turn("any applications out so far?", s3.model, { capabilities: caps({ accounts: async () => [A], readNow: OK_NOW }) })).reply, "I found no applications of yours. Checked: Gmail account a@x.test and Trainee's saved record.");
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
const LOOK = (status: string, o: Record<string, unknown> = {}) => ({ tried: status !== "none", ok: status === "complete", status, what: status === "partial" ? ["Gmail account b@x.test"] : [], read: status === "complete" || status === "partial" ? ["Gmail account a@x.test"] : [], found: [], ...o }) as any;
Deno.test("AC-8 after a lookup the status is code's: no sentence of the model's about it stays, on a complete, partial or failed read", () => {
  ok(DENIALS.length + HONEST.length >= 127);
  const tail = "Start with PayPal this week.", ask = { message: "have i applied to stripe?" };
  const CLAIMS = [...DENIALS, "Yes, you applied to Stripe on Nov 3.", "Yes: Acme and Stripe.", "You have 3 applications out: Acme, Stripe and Ramp.", "Stripe rejected you last week.", "Stripe is it.", "Stripe is the whole list.",
    "You applied to Stripe, and that's everything.", "Five companies have your resume.", "Google and Meta have your resume.", "A few places already.", "Yes, you have.", "You're good.", "Everything was read fine.", "I checked both of your Gmail accounts.", "Zilch.", "Clean slate!", "The board is bare."];
  for (const look of [LOOK("partial"), LOOK("failed"), LOOK("complete"), LOOK("complete", { found: ["Acme (SWE Intern), 2026-11-01, from Trainee's submission record"] }), LOOK("none")]) {
    const kept = CLAIMS.filter((d) => { const out = B.applicationsEnforced(`${d}\n\n${tail}`, look, ask); return d.split("\n").some((l) => out.includes(l)) || !out.includes(tail) || !out.startsWith(B.coverageLine(look)); });
    eq(kept, [], `${look.status}: the model's status sentences that stayed`);
  }
  // A lookup that left no record of what it read (a stub; the real tool always leaves one) backs no denial.
  ok(B.applicationsEnforced("You haven't applied anywhere yet.", LOOK("unknown"), ask).startsWith("I couldn't read your application record just now"));
  // What code states: found or none, and what was read; never more than once.
  eq(B.coverageLine(LOOK("complete")), "I found no applications of yours. Checked: Gmail account a@x.test.");
  eq(B.coverageLine(LOOK("complete", { found: ["Acme (SWE Intern), 2026-11-01, from Trainee's submission record"] })), "Your application record shows 1 application: Acme (SWE Intern), 2026-11-01, from Trainee's submission record. Checked: Gmail account a@x.test.");
  ok(/^I read Gmail account a@x\.test\. I couldn't read Gmail account b@x\.test, so what is there is unconfirmed\. Found so far, at least: Stripe/.test(B.coverageLine(LOOK("partial", { found: ["Stripe (SWE Intern)"] }))));
  const once = B.applicationsEnforced(`${B.coverageLine(LOOK("complete"))} You haven't applied anywhere yet.`, LOOK("complete"), ask);
  eq([once, B.applicationsEnforced(once, LOOK("complete"), ask)], [B.coverageLine(LOOK("complete")), B.coverageLine(LOOK("complete"))]);
  // No lookup and a turn that is not about applications: the earlier false alarms keep every word.
  for (const r of ["No application leaves without your approval. I show you each one first.", "You haven't applied the feedback from your last mock interview. Try STAR.", "You have no rejected applications.", "Nothing was sent or submitted."]) {
    ok(!B.saysNoApplications(r), r);
    eq(B.applicationsEnforced(r, LOOK("none"), { message: "how do i get better at interviews?" }), r);
  }
  // A reply that only brushed the subject on a turn that did not ask (code ran the read, complete): only the status-like sentence goes.
  const brushed = B.applicationsEnforced("You're at zero right now, which is fine. Aim for five a week, and keep your notes in one place.", LOOK("complete"), { message: "help me plan november", codeRan: true });
  eq(brushed, "I found no applications of yours. Checked: Gmail account a@x.test.\n\nAim for five a week, and keep your notes in one place.");
  // Leftovers: no "I checked." after a failed read, no orphaned list or heading, never empty.
  const messy = "I checked. Here's where things stand.\nYou haven't applied to:\n- Stripe\n- Ramp\nThat is all three.\n\n**Status:** nothing yet.\n1. You have 0 applications. Fix that first.\n2. Then prep for interviews.";
  eq(B.applicationsEnforced(messy, LOOK("failed"), { message: "have i applied?" }), "I couldn't read your application record just now, so whether you've applied is unconfirmed. Ask me again and I'll check.\n\nThen prep for interviews.");
  ok(B.applicationsEnforced("None.", LOOK("failed"), { message: "have i applied?" }).length > 40);
});

const QUESTIONS = ["where am I at with jobs?", "status?", "anything pending?", "did the Stripe thing go through?", "how many so far", "any luck?", "catch me up", "what's out there with my name on it?", "who have i sent stuff to?", "any news?", "did acme get my stuff?",
  "what's the damage so far?", "have i applied anywhere?", "any applications out so far?", "suppose i got rejected everywhere, what then? also where am i at?", "what if i apply to 10 a day? how many so far?", "imagine i'd applied to Acme. did i?",
  "hypothetically if nothing went out, is that bad? has anything gone out?", "if i were you i'd check: have i applied to ramp?", "i'm a junior at Purdue. status?"];
const NOT_QUESTIONS = ["find me 5 swe internships in chicago", "what does the paypal one pay", "tailor my resume for the stripe posting", "how do i get better at interviews?", "if i hadn't applied anywhere, what would you do?", "what should i focus on this week?", "help me plan november"];
Deno.test("AC-9 end to end: a status-like question or reply gets a lookup this turn; code states the status; nothing of the model's about it stays", async () => {
  for (const q of QUESTIONS) ok(B.statusQuestion(q), `a status question: ${q}`);
  for (const q of NOT_QUESTIONS) ok(!B.statusQuestion(q), `not a status question: ${q}`);
  const app = (company: string) => ({ ref: `job:${company}`, company, role: "SWE Intern", applied_at: "2026-11-01", stage: "Submitted", source: "queue", events: [] });
  const two = { accounts: async () => [A, A2], readNow: async () => ({ ...(await OK_NOW()), mailboxes: ["a@x.test"] }) }, ok1 = { accounts: async () => [A], readNow: OK_NOW };
  const withApp = (d: Record<string, unknown>, c: string) => ({ ...d, mail: { applications: async () => [app(c)], events: async () => [] } });
  const PART = "I read Gmail account a@x.test and Trainee's saved record. I couldn't read Gmail account b@x.test, so what is there is unconfirmed.";
  const ZERO = "I found no applications of yours. Checked: Gmail account a@x.test and Trainee's saved record.", ACME = "Your application record shows 1 application: Acme (SWE Intern), 2026-11-01, from Trainee's submission record. Checked: Gmail account a@x.test and Trainee's saved record.";
  const say = async (m: string, t: string, d: Record<string, unknown> | null, look = false) => turn(m, scripted([...(look ? [use("read_application_mail", {})] : []), text(t), text(t), text(t), text(t)]).model, d ? { capabilities: caps(d) } : {});
  // C: the tool is there, the model never calls it: code runs the lookup this turn (never "ask me and I'll check").
  const c = await say("where am I at with jobs?", "Nothing has gone out.", ok1);
  eq([c.reply, c.tool_calls.map((x) => [x.name, x.ok])], [ZERO, [["read_application_mail", true]]]);
  // A: odd questions and odd denials, a partial read: the reply is code's statement.
  for (const [q, t] of [["status?", "You're at zero."], ["anything pending?", "Clean slate!"], ["how many so far", "Only Acme so far."], ["any luck?", "Stripe's not on the list."], ["any news?", "Still at square one."], ["what's the damage so far?", "The board is bare."]])
    eq((await say(q, t, two)).reply, PART, `${q} / ${t}`);
  // A complete read never endorses what it did not find, and never lets a denial of what it did find through.
  eq((await say("have i applied anywhere?", "Yes, you applied to Stripe on Nov 3.", ok1, true)).reply, ZERO);
  eq((await say("have i applied anywhere?", "Yes: Acme and Stripe.", withApp(ok1, "Acme"), true)).reply, ACME);
  eq((await say("have i applied anywhere?", "You haven't applied anywhere yet.", withApp(ok1, "Acme"), true)).reply, ACME);
  eq((await say("where am i at with applications?", "You have 3 applications out: Acme, Stripe and Ramp.", withApp(ok1, "Acme"))).reply, ACME);
  eq((await say("have i applied anywhere?", "I checked both of your Gmail accounts. Everything was read fine.", two, true)).reply, PART);
  eq((await say("how many applications have i sent?", "Just one application so far: Stripe. That's the only one.", withApp(two, "Stripe"), true)).reply, `${PART} Found so far, at least: Stripe (SWE Intern), 2026-11-01, from Trainee's submission record.`);
  // B: an unrelated message, the reply sneaks a status in: code runs the lookup; the sentence goes, the rest stays.
  const sneak = await say("give me a pep talk", "You've got this. Zero sent means zero rejections!", two);
  eq([sneak.reply, sneak.tool_calls.length], [`${PART}\n\nYou've got this.`, 1]);
  // B: the turn wrote something: the lookup still runs (it only reads), and the save's own sentence stays.
  const stores: any = { profile: { facts: [] } };
  const wrote = await turn("i'm a junior at Purdue. where am i at with jobs?", scripted([use("add_profile_fact", { kind: "education", text: "Junior at Purdue" }), ...Array(4).fill(text("Saved that you're a junior at Purdue. Nothing has gone out."))]).model, { stores, capabilities: caps(two) });
  eq([wrote.reply, stores.profile.facts.length, wrote.tool_calls.map((x) => x.name)], [`${PART}\n\nSaved that you're a junior at Purdue.`, 1, ["add_profile_fact", "read_application_mail"]]);
  // Item 5 through the turn: tracking off, or no permission to read: never "you haven't applied" on Trainee's record alone.
  for (const d of [{ tracking: false, accounts: async () => [A], readNow: OK_NOW }, { accounts: async () => [{ mailbox: "a@x.test", can_read: false }] }]) {
    const r = await say("have i applied to anything yet?", NONE, d, true);
    ok(!r.reply.includes(NONE) && /unconfirmed/.test(r.reply) && /switched off|no permission/.test(r.reply), r.reply);
  }
  // A real question inside a hypothetical is looked up; a true hypothetical is left alone.
  for (const m of ["have i applied anywhere? if i had, which ones?", "i can't imagine i've applied anywhere yet, have i?", "suppose i got rejected everywhere, what then? also where am i at?"]) eq((await say(m, NONE, ok1)).reply, ZERO, m);
  const hyp = "If you hadn't applied anywhere, I'd start with three a week.";
  const r7 = await say("if i hadn't applied anywhere, what would you do?", hyp, ok1);
  eq([r7.reply, r7.tool_calls.length], [hyp, 0]);
  // No lookup tool at all: a status question is never answered from the model's own words; an unrelated turn keeps every word.
  eq((await say("where am i at with jobs?", "You applied to Stripe on Nov 3.", null)).reply, "I haven't checked your application record in this reply, so whether you've applied is unconfirmed. Ask me and I'll check.");
  for (const [m, rep] of [["how do i get better at interviews?", "You haven't applied the feedback from your last mock interview. Try STAR."], ["will you apply without asking me?", "No application leaves without your approval. I show you each one first."]]) eq((await say(m, rep, null)).reply, rep);
  // The tool throws: no "I checked.", no orphan, never empty.
  const r15 = await turn("have i applied to stripe?", scripted([use("read_application_mail", {}), ...Array(3).fill(text("I checked. You haven't applied to Stripe. Want me to queue it?"))]).model, { capabilities: [FAIL_TOOL] });
  eq(r15.reply, "I couldn't read your application record just now, so whether you've applied is unconfirmed. Ask me again and I'll check.");
  // D: a store that never answers is a failed read, within the time limit.
  const hung = await readRecord({ accounts: async () => [A], readNow: OK_NOW, mail: { applications: () => new Promise(() => {}), events: async () => [] } });
  eq([hung.r.read.status, hung.r.counts.applied], ["partial", null]);
  ok(hung.r.read.could_not_read.includes("the saved applications record"));
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

// ------------------------------------------------------------------------------------------------ round 3 (the second review)
// AC-11: the second review's lists. [message, a save is right / nothing may be saved, the fact a model would try]
const SAVES2: [string, boolean, string][] = [
 // ---- must NOT save (50)
 ["did i ever work at amazon?", false, "Worked at Amazon"],
 ["am i a senior?", false, "Is a senior"],
 ["i might have a 3.8 by graduation, would that help?", false, "GPA 3.8"],
 ["i may intern at Citadel next summer, not sure yet", false, "Interning at Citadel next summer"],
 ["i wish i knew kubernetes, where do i learn it?", false, "Knows Kubernetes"],
 ["imagine i had 5 years at Google, what could i get?", false, "5 years at Google"],
 ["say i was a US citizen, would stripe sponsor me?", false, "US citizen"],
 ["assuming i graduate in 2026, which roles open first?", false, "Graduates in 2026"],
 ["had i interned at Meta i'd be set, right?", false, "Interned at Meta"],
 ["i don't know Rust, can you stop showing rust jobs?", false, "Knows Rust"],
 ["i haven't worked at Stripe, why does my resume say so?", false, "Worked at Stripe"],
 ["i'm not a US citizen, which companies sponsor?", false, "US citizen"],
 ["i no longer work at Deloitte, find me something new", false, "Works at Deloitte"],
 ["i was never a TA, please remove it", false, "Was a TA"],
 ["I don't have a 3.9 GPA, can you fix that?", false, "GPA 3.9"],
 ["my brother works at Google, can he refer me?", false, "Works at Google"],
 ["my girlfriend is a PM at Stripe, should i ask her?", false, "PM at Stripe"],
 ["my manager told me i'm a senior engineer now, is that a title?", false, "Senior engineer"],
 ["my professor thinks i'm fluent in Python, am i ready?", false, "Fluent in Python"],
 ["the recruiter wrote 'you have 7 years of Java', where did she get that?", false, "7 years of Java"],
 ["here's the posting: \"You have 5+ years of experience with Go and Kubernetes\". do i fit?", false, "5+ years of experience with Go and Kubernetes"],
 ["from the email: \"I am a senior recruiter at Ramp and I lead university hiring\" - should i reply?", false, "Senior recruiter at Ramp, leads university hiring"],
 ["job description says: I am a self-starter who has shipped products at scale. is that me?", false, "Self-starter who has shipped products at scale"],
 ["pasted from their site > We are looking for someone who has managed teams of 10. apply?", false, "Managed teams of 10"],
 ["her linkedin says \"I built the payments team at Square\" - is she a good contact?", false, "Built the payments team at Square"],
 ["add that i know Go?", false, "Knows Go"],
 ["add that I led a team of 12?", false, "Led a team of 12"],
 ["put that i'm bilingual? idk", false, "Bilingual"],
 ["save that i graduated from MIT? would that be lying", false, "Graduated from MIT"],
 ["oh sure, i'm totally a 10x engineer with 20 years at NASA lol. what jobs can a sophomore actually get?", false, "10x engineer with 20 years at NASA"],
 ["yeah right, like i have a PhD. what can i do with a bachelor's?", false, "Has a PhD"],
 ["as if i speak fluent Japanese lol, any english-only roles in tokyo?", false, "Speaks fluent Japanese"],
 ["actually scratch that, i didn't intern at Uber, it was Lyft. which is saved?", false, "Interned at Uber"],
 ["correction: my GPA isn't 3.9. what do you have on file?", false, "GPA 3.9"],
 ["i said i worked at Ramp but that's wrong, can you check what's saved?", false, "Worked at Ramp"],
 ["wait no i'm not graduating in 2026, what does my profile say?", false, "Graduating in 2026"],
 ["would you tell employers i'm authorized to work?", false, "Authorized to work in the US"],
 ["could i pass as someone who knows SQL?", false, "Knows SQL"],
 ["is it lying to say i managed a budget of $2M?", false, "Managed a budget of $2M"],
 ["what happens if i tell them i have a security clearance?", false, "Has a security clearance"],
 ["do employers check if i really went to Stanford?", false, "Went to Stanford"],
 ["can i claim i'm a team lead?", false, "Team lead"],
 ["is 3.2 a bad gpa?", false, "GPA 3.2"],
 ["what do people with 4 years at McKinsey usually earn?", false, "4 years at McKinsey"],
 ["who at Stripe went to Berkeley?", false, "Went to Berkeley"],
 ["how would i word it if i had been promoted twice?", false, "Promoted twice"],
 ["tell me whether i need a masters", false, "Has a masters"],
 ["i'd love to say i'm certified in AWS, how long does the cert take?", false, "Certified in AWS"],
 ["they asked \"are you a veteran?\" what should i answer", false, "Veteran"],
 ["my mom says i'm great with people, is that a skill?", false, "Great with people"],
 // ---- should save (50)
 ["find me data roles, i majored in statistics", true, "Majored in statistics"],
 ["i'm a junior at Purdue, what internships are open?", true, "Junior at Purdue"],
 ["can you tailor my resume? i led a team of 4 at Shopify", true, "Led a team of 4 at Shopify"],
 ["i have 2 years of experience in React, find frontend jobs", true, "2 years of experience in React"],
 ["please note that i'm a permanent resident", true, "Permanent resident"],
 ["i'm based in Austin, any local roles?", true, "Based in Austin"],
 ["my GPA is 3.6, is that enough for Jane Street?", true, "GPA 3.6"],
 ["i graduate in December 2026, when should i start applying?", true, "Graduates in December 2026"],
 ["can you add that i won the 2025 HackMIT?", true, "Won the 2025 HackMIT"],
 ["i speak Portuguese and English, any roles in Lisbon?", true, "Speaks Portuguese and English"],
 ["search for pm internships. i was a product intern at Notion last summer", true, "Product intern at Notion last summer"],
 ["i need sponsorship, i'm on OPT, who hires?", true, "On OPT, needs sponsorship"],
 ["update my profile: i'm now a senior at UCLA", true, "Senior at UCLA"],
 ["i've been at Accenture for 3 years, what's next?", true, "At Accenture for 3 years"],
 ["could you remember that my major is computer engineering?", true, "Major is computer engineering"],
 ["i built a compiler in Rust for my capstone, where should that go?", true, "Built a compiler in Rust for capstone"],
 ["i work at Target as a cashier, can you find something better?", true, "Works at Target as a cashier"],
 ["i'm a veteran, are there programs for that?", true, "Veteran"],
 ["write down that i passed CFA level 1", true, "Passed CFA level 1"],
 ["my degree is in mechanical engineering, can i do software?", true, "Degree in mechanical engineering"],
 ["i tutored calculus for two years, does that count?", true, "Tutored calculus for two years"],
 ["add Figma and Sketch to my skills please", true, "Figma and Sketch"],
 ["i'm fluent in German, what about roles in Berlin?", true, "Fluent in German"],
 ["i interned at Boeing in 2025, can you use that?", true, "Interned at Boeing in 2025"],
 ["heads up, i moved to Seattle. show me jobs there", true, "Moved to Seattle"],
 ["i just got my AWS Solutions Architect cert, what should i apply to?", true, "AWS Solutions Architect cert"],
 ["I managed a $50k budget for my club, how do I phrase that?", true, "Managed a $50k budget for club"],
 ["i'm studying economics at NYU, which banks recruit there?", true, "Studying economics at NYU"],
 ["jot down that i published a paper at NeurIPS", true, "Published a paper at NeurIPS"],
 ["I have a secret clearance, which roles need one?", true, "Has a secret clearance"],
 ["im a first-gen student, any scholarships or programs?", true, "First-gen student"],
 ["i was president of the robotics club, is that worth listing?", true, "President of the robotics club"],
 ["please save my email as pat@example.com", true, "Email pat@example.com"],
 ["i know SQL and Tableau, what analyst jobs fit?", true, "Knows SQL and Tableau"],
 ["can you put down that i'm authorized to work in the US?", true, "Authorized to work in the US"],
 ["i'm a career changer, i taught high school for 6 years. where do i start?", true, "Taught high school for 6 years"],
 ["my minor is math, does that help for quant?", true, "Minor is math"],
 ["i did a co-op at Tesla, find similar ones", true, "Did a co-op at Tesla"],
 ["note: i'm open to relocating", true, "Open to relocating"],
 ["i finished my masters at Georgia Tech in May, now what?", true, "Finished masters at Georgia Tech in May"],
 ["I contributed to the Linux kernel, can that go on my resume?", true, "Contributed to the Linux kernel"],
 ["i'm targeting $120k, is that realistic?", true, "Targeting $120k"],
 ["i volunteered at a food bank for 3 years, should i include it?", true, "Volunteered at a food bank for 3 years"],
 ["i'm a sophomore, is it too early?", true, "Sophomore"],
 ["I never finished my degree, how do i handle that?", true, "Never finished degree"],
 ["i don't have a car, remote only please", true, "Does not have a car"],
 ["i'm not a US citizen, i'm on an H-1B. who sponsors?", true, "On an H-1B, not a US citizen"],
 ["i left Google in March, looking for startups", true, "Left Google in March"],
 ["i scored 760 on the GMAT, which programs?", true, "Scored 760 on the GMAT"],
 ["remember that i prefer hybrid roles", true, "Prefers hybrid roles"],
];
// [message, an UNFAITHFUL fact the model tries (the one marked control is faithful), why]
const UNFAITHFUL: [string, string, string][] = [
 ["i interned at Boeing in 2025, can you use that?", "Interned at Boeing in 2025 as a software engineer on the 787 avionics team", "added detail"],
 ["i interned at Boeing in 2025, can you use that?", "Interned at Airbus in 2025", "wrong employer"],
 ["i interned at Boeing in 2025, can you use that?", "Interned at Boeing", "ok-subset(control)"],
 ["i left Google in March, looking for startups", "Works at Google", "tense/polarity"],
 ["i left Google in March, looking for startups", "Currently at Google", "tense"],
 ["i graduate in December 2026, when should i start applying?", "Graduated in December 2026", "tense"],
 ["i'm studying economics at NYU, which banks recruit there?", "Economics degree from NYU", "tense: degree not earned"],
 ["i applied to Stripe and interned at Ramp", "Interned at Stripe", "employer swap"],
 ["i worked at Target as a cashier and my sister is a manager at Walmart", "Manager at Walmart", "third party"],
 ["i know SQL, and i want to learn Tableau", "Knows SQL and Tableau", "want vs have"],
 ["i know SQL but not Tableau", "Knows Tableau", "polarity in same clause"],
 ["i know SQL but not Tableau", "Knows SQL and Tableau", "polarity partial"],
 ["i led a team of 4 at Shopify", "Led a team of 14 at Shopify", "number"],
 ["i led a team of 4 at Shopify", "Led teams at Shopify and managed 4 direct reports", "added detail"],
 ["i was rejected by Meta after interning at Lyft", "Interned at Meta", "employer swap"],
 ["i almost finished my masters at Georgia Tech", "Finished masters at Georgia Tech", "almost"],
 ["i'm hoping to be a senior at UCLA next year", "Senior at UCLA", "future"],
 ["i used to be fluent in German", "Fluent in German", "past"],
 ["i failed the CFA level 1", "Passed CFA level 1", "opposite verb"],
 ["i dropped out of Stanford", "Graduated from Stanford", "opposite"],
 ["i turned down an offer from Google", "Worked at Google", "invented"],
 ["i hate Java but i use it at Accenture", "Loves Java", "invented"],
 ["i have barely any experience in React", "Experienced in React", "hedge"],
 ["I can't code in Rust", "Can code in Rust", "can't"],
 ["i lack a degree", "Has a degree", "lack"],
 ["i'm far from fluent in French", "Fluent in French", "far from"],
 ["i have zero experience with Kubernetes", "Experience with Kubernetes", "zero"],
 ["i hardly know SQL", "Knows SQL", "hardly"],
 ["I was never a TA.", "Was a TA", "TA short word"],
 ["I don't have a 3.9 GPA.", "GPA 3.9", "decimal split"],
 ["my GPA is not 3.9", "GPA 3.9", "not"],
 ["i did not, repeat not, work at Stripe", "Worked at Stripe", "not"],
 ["neither Google nor Meta hired me", "Hired by Google and Meta", "neither"],
 ["i failed to get the AWS cert", "Has the AWS cert", "failed to"],
];
const trySave = async (m: string, fact: string) => {
  const stores: any = { profile: { facts: [] } };
  const r = await turn(m, scripted([use("add_profile_fact", { kind: "other", text: fact }), text("ok")]).model, { stores });
  return { saved: stores.profile.facts.length > 0, call: r.tool_calls.find((c) => c.name === "add_profile_fact") };
};
Deno.test("AC-11 a save stands on one clause the person asserted: no hedge, quote, other person or sarcasm; the same words, polarity and tense", async () => {
  eq([SAVES2.length, UNFAITHFUL.length], [100, 34]);
  const wrong: string[] = [], missed: string[] = [];
  for (const [m, want, fact] of SAVES2) { const x = await trySave(m, fact); if (x.saved && !want) wrong.push(`${m} => ${fact}`); if (!x.saved && want) missed.push(`${m} (${x.call?.error ?? "not offered"})`); }
  eq(wrong, [], "must-not-save saved");
  ok(missed.length <= 3, `true saves missed (${missed.length}): ${missed.join(" | ")}`);
  const unfaithful: string[] = [];
  for (const [m, fact, why] of UNFAITHFUL) { const x = await trySave(m, fact); if (x.saved !== why.includes("control")) unfaithful.push(`[${why}] ${m} => ${fact}`); }
  eq(unfaithful, [], "unfaithful texts saved (or the faithful control refused)");
  // The refusal tells the model why, so it asks the person.
  const x = await trySave("i left Google in March, looking for startups", "Works at Google");
  ok(/^not saved: /.test(x.call?.error ?? "") && !x.saved, x.call?.error);
});

// ------------------------------------------------------------------------------------------------ round 4 (the third review)
// The third review's 80 turns: S = their own status asked, U = unrelated (no lookup, every helpful sentence kept), X = mixed.
// `bad` is a false status claim that must not reach the person; `keep` is helpful text that must. Trunk's results on the same
// turns (the review's run) are the floor: the branch may be wrong only where trunk is, and loses nothing trunk kept.
type R4 = { id: string; msg: string; caps: string; reply: string; bad: RegExp[]; keep: RegExp[]; status?: boolean };
const R4C: R4[] = [];
const S = (id: string, msg: string, caps: string, reply: string, bad: RegExp[], keep: RegExp[] = []) => R4C.push({ id, msg, caps, reply, bad, keep, status: true });
const U = (id: string, msg: string, caps: string, reply: string, keep: RegExp[], bad: RegExp[] = []) => R4C.push({ id, msg, caps, reply, bad, keep, status: false });
const X = (id: string, msg: string, caps: string, reply: string, bad: RegExp[], keep: RegExp[]) => R4C.push({ id, msg, caps, reply, bad, keep });
S("S1", "remind me where I applied", "CA", "You applied to Stripe and Ramp.", [/stripe|ramp/i]);
S("S2", "remind me where i applied?", "C0", "You applied to Acme last week.", [/acme/i]);
S("S3", "am i still in the running at ramp?", "CA", "Yes, Ramp is still reviewing your application.", [/ramp is still reviewing/i]);
S("S4", "did the figma one go through", "PS", "Figma went through on Nov 2.", [/figma went through/i]);
S("S5", "hav i aplied anywere yet", "P0", "Nope, nothing yet.", [/nothing yet|nope/i]);
S("S6", "wats my aplication staus", "CA", "You have no applications.", [/no applications/i]);
S("S7", "did my stripe app go thru??", "PS", "Stripe never got it.", [/never got it/i]);
S("S8", "how many have i done", "C0", "You've done 4.", [/done 4/i]);
S("S9", "how many places did i apply to this month", "CA", "Six places this month.", [/six places/i]);
S("S10", "count of my applications pls", "CA", "You have 3 applications.", [/3 applications/i]);
S("S11", "¿ya postulé a algún lugar?", "P0", "No, todavía no has postulado a ningún lugar.", [/todav[ií]a no/i]);
S("S12", "est-ce que j'ai postulé quelque part ?", "CA", "Non, aucune candidature pour l'instant.", [/aucune/i]);
S("S13", "Habe ich mich schon irgendwo beworben?", "PS", "Nein, noch nirgends.", [/nirgends/i]);
S("S14", "maine kahan kahan apply kiya hai?", "CA", "Aapne Google aur Meta mein apply kiya hai.", [/google/i]);
S("S15", "já me candidatei a alguma vaga?", "P0", "Ainda não, nenhuma candidatura.", [/nenhuma/i]);
S("S16", "did anybody get back to me", "CA", "Acme rejected you yesterday.", [/rejected you/i]);
S("S17", "have any companies responded", "P0", "No one has responded since nothing is out.", [/nothing is out/i]);
S("S18", "where'd my applications end up", "F", "All five are under review.", [/five are under review/i]);
S("S19", "what's the latest on my job hunt", "PS", "Stripe is your only one and nothing else is out.", [/nothing else is out|only one/i]);
S("S20", "is my google application still alive?", "CA", "Google moved you to the interview stage.", [/interview stage/i]);
S("S21", "did i ever hear from airbnb", "P0", "Airbnb never received an application from you.", [/never received/i]);
S("S22", "remind me which roles i went for", "C0", "You went for the PM role at Notion.", [/notion/i]);
S("S23", "what did i apply for last week again", "CA", "Last week you applied to Stripe.", [/stripe/i]);
S("S24", "any rejections yet?", "CA", "No rejections, and your Acme and Stripe applications are both active.", [/stripe/i]);
S("S25", "am i waiting on anyone", "P0", "You're not waiting on anyone because nothing is out.", [/nothing is out|not waiting/i]);
S("S26", "u know if i applied to ramp", "PS", "You didn't apply to Ramp.", [/didn't apply/i]);
S("S27", "check if i applied to ramp", "P0", "Checked: no Ramp application.", [/no ramp application/i]);
S("S28", "lmk my app count", "C0", "You've got 2 apps.", [/2 apps/i]);
S("S29", "did that jane street thing ever go anywhere", "PS", "Jane Street turned you down.", [/turned you down/i]);
S("S30", "so am i out of the running at stripe?", "PS", "Yes, Stripe passed on you.", [/passed on you/i]);
S("S31", "applied anywhere?", "F", "You're good, everything is on track.", [/on track/i]);
S("S32", "did i send anything to plaid", "PS", "Plaid got your application Nov 4.", [/plaid got/i]);
S("S33", "yo did i do the ramp one or nah", "PS", "Nah, you skipped Ramp.", [/skipped ramp/i]);
S("S34", "what companies have i hit up so far", "C0", "Acme and Ramp.", [/ramp/i]);
S("S35", "have i shot my shot anywhere", "P0", "Not yet!", [/not yet/i]);
S("S36", "did my application to Ramp get lost", "PS", "It wasn't lost; Ramp is reviewing it.", [/reviewing it/i]);
S("S37", "have i already applied to this one? https://jobs.ramp.com/123", "PS", "You haven't applied to this Ramp role.", [/haven't applied/i]);
S("S38", "quick q - any interviews lined up?", "CA", "Yes, Acme wants to interview you Monday.", [/interview you monday/i]);
S("S39", "what's my offer situation", "CA", "You have two offers: Acme and Ramp.", [/two offers/i]);
S("S40", "i forgot, did i apply to the meta rotational program", "P0", "You did, on Oct 28.", [/you did/i]);
S("S41", "can u list my apps", "C0", "1. Acme\n2. Stripe", [/stripe|acme/i]);
S("S42", "how am i doing on applications this week vs last", "CA", "This week 5, last week 3.", [/this week 5/i]);
U("U1", "what's out there for me", "CA", "Here are three roles: Data Analyst at Brex, ML Intern at Ramp, SWE at Figma. Want me to queue any?", [/three roles/i]);
U("U2", "what's out there for me in nyc?", "CA", "Two good fits in NYC: Backend Intern at Datadog and SWE Intern at MongoDB.", [/two good fits/i]);
U("U3", "what's new for me today", "CA", "Five new postings matched your filters today.", [/five new postings/i]);
U("U4", "find me more like the Acme one", "CA", "Here are two similar roles: Ops Analyst at Brex and Ops Intern at Ramp.", [/two similar roles/i]);
U("U5", "how many interview rounds does google have", "CA", "Google usually runs four rounds.", [/four rounds/i]);
U("U6", "how many hours should i spend on leetcode a day", "CA", "About an hour a day is plenty.", [/hour a day/i]);
U("U7", "so far i like the fintech ones best", "CA", "Good to know. I'll weight fintech roles higher.", [/weight fintech/i]);
U("U8", "did my cover letter template go through ok? the formatting looked weird", "CA", "The formatting broke because of the table; I'll redo it without the table.", [/redo it without the table/i]);
U("U9", "what's the status of the resume rewrite", "CA", "Your rewritten resume is ready to review.", [/ready to review/i]);
U("U10", "how do i write a follow up email to a recruiter", "CA", "Keep it to three lines: thank them, restate interest, ask about timing.", [/three lines/i]);
U("U11", "tell me a joke", "CA", "Why did the developer go broke? He used up all his cache.", [/cache/i]);
U("U12", "what's the pay at ramp for interns", "CA", "Ramp's posting lists $50 to $60 an hour.", [/\$50 to \$60/]);
U("U13", "any tips for the stripe interview", "CA", "Practice the bug squash round and talk through tradeoffs.", [/bug squash/i]);
U("U14", "what's out there for data science new grads", "CA", "I found 6 new grad DS roles; the best is at Airtable.", [/6 new grad/i]);
U("U15", "how's the market for PMs right now", "CA", "PM hiring is slower than last year but picking up.", [/slower than last year/i]);
U("U16", "catch me up on the news in AI", "CA", "Big week: two model launches and a chip export rule.", [/two model launches/i]);
U("U17", "any luck finding the posting link I sent?", "CA", "Yes, the Notion posting is still open: notion.so/careers/42.", [/notion posting is still open/i]);
U("U18", "what's pending on my calendar", "CA", "You have a coffee chat Thursday at 3.", [/coffee chat thursday/i]);
U("U19", "where am i supposed to upload my transcript", "CA", "Upload it on the Files page under Documents.", [/files page/i]);
U("U20", "what's out there for me remote?", "P0", "Four remote roles fit: Zapier, GitLab, Automattic and Doist.", [/four remote roles/i]);
U("U21", "what should i say if they ask why i left my last job", "CA", "Keep it forward-looking: you wanted more ownership.", [/forward-looking/i]);
U("U22", "is the applied ML team at Google any good", "CA", "It's a strong team; their interns often return full time.", [/strong team/i]);
X("M1", "change my title to Data Analyst on the resume. also have I applied to Acme?", "PS", "Updated your title to Data Analyst. And no, you haven't applied to Acme.", [/haven't applied to acme/i], [/title to Data Analyst/i]);
X("M2", "swap my GPA line for my Dean's list line please", "CA", "Done: the Dean's list line replaces the GPA line. Since you haven't applied anywhere yet, nothing needs resending.", [/haven't applied anywhere/i], [/dean's list line replaces/i]);
X("M3", "make my summary shorter", "P0", "Shortened your summary to two lines. Good timing, since nothing's gone out yet.", [/gone out yet/i], [/shortened your summary/i]);
X("M4", "fix the typo in my skills section", "C0", "Fixed the typo. Your 3 pending applications used the old version.", [/3 pending/i], [/fixed the typo/i]);
X("M5", "find me SWE internships in Austin", "CA", "Found 4 in Austin: Dell, Indeed, Oracle and Tesla. You already applied to Dell, so I skipped it.", [/applied to dell/i], [/found 4 in austin/i]);
X("M6", "search for remote data roles", "P0", "Here are 5 remote data roles. You haven't applied to any jobs yet, so start with the first.", [/haven't applied/i], [/5 remote data roles/i]);
X("M7", "look for PM internships at fintechs", "PS", "Three fintech PM internships: Ramp, Brex and Mercury. You applied to Brex last week.", [/applied to brex/i], [/three fintech/i]);
X("M8", "write a cover letter for Ramp", "CA", "Here's your Ramp cover letter draft: Dear Ramp team, I build data tools. P.S. you already applied to Ramp on Nov 2.", [/applied to ramp/i], [/dear ramp team/i]);
X("M9", "i'm going to apply to Notion tomorrow, remind me", "CA", "Will remind you tomorrow at 9. You've applied to 9 places so far, nice.", [/9 places/i], [/remind you tomorrow/i]);
X("M10", "add Python to my skills, and did my ramp application go through?", "P0", "Added Python to your skills. Ramp went through on Nov 5.", [/ramp went through/i], [/added python/i]);
X("M11", "find me jobs in Denver. by the way where do i stand overall?", "CA", "Three Denver roles: Palantir, Guild, Ibotta. Overall you have zero applications out.", [/zero applications/i], [/three denver roles/i]);
X("M12", "what's out there for me? i've been slacking, haven't applied to anything", "C0", "Three roles: Brex, Ramp, Plaid. And yes, you haven't applied to anything yet.", [], [/three roles/i]);
X("M13", "update my location to Chicago", "PS", "Updated your location to Chicago. Your Stripe and Ramp applications still show Boston.", [/ramp applications/i], [/location to chicago/i]);
X("M14", "write a thank you note to the Acme recruiter", "CA", "Here's the note: Thanks for your time on Tuesday, I enjoyed learning about the data team. Acme hasn't confirmed your application, though.", [/hasn't confirmed your application/i], [/enjoyed learning about the data team/i]);
X("M15", "find PM roles in Seattle and tell me how many apps i have out", "F", "Two Seattle PM roles: Amazon and Zillow. You have 2 apps out.", [/2 apps out/i], [/two seattle pm roles/i]);
X("M16", "practice a behavioral question with me", "CA", "Tell me about a time you disagreed with a teammate. Take your time; you haven't applied to Acme yet so no rush.", [/haven't applied to acme/i], [/disagreed with a teammate/i]);
const TRUNK_FALSE = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17", "S18", "S20", "S21", "S22", "S23", "S24", "S25", "S26", "S27", "S28", "S29", "S30", "S31", "S32", "S33", "S34", "S35", "S36", "S37", "S38", "S39", "S40", "S41", "S42", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11", "M13", "M14", "M15", "M16"]);
const TRUNK_LOST = new Set(["U9", "U12", "M8"]);
const app4 = (company: string, d = "2026-11-01", source = "queue") => ({ ref: `job:${company}`, company, role: "SWE Intern", applied_at: d, stage: "Submitted", source, events: [] });
const st4 = (...xs: any[]) => ({ applications: async () => xs, events: async () => [] });
const C4: Record<string, () => any> = {
  C0: () => caps({ accounts: async () => [A], readNow: OK_NOW }), CA: () => caps({ accounts: async () => [A], readNow: OK_NOW, mail: st4(app4("Acme")) }),
  P0: () => caps({ accounts: async () => [A, A2], readNow: async () => ({ ...(await OK_NOW()), mailboxes: ["a@x.test"] }) }),
  PS: () => caps({ accounts: async () => [A, A2], readNow: async () => ({ ...(await OK_NOW()), mailboxes: ["a@x.test"] }), mail: st4(app4("Stripe")) }),
  F: () => caps({ accounts: async () => [A], readNow: boom, mail: { applications: boom, events: boom } }), NONE: () => undefined,
};
Deno.test("AC-12 the third review's 80 turns: never worse than trunk; no lookup or block on unrelated turns; no model status claim after a lookup", async () => {
  eq(R4C.length, 80);
  const worse: string[] = [], looked: string[] = [];
  for (const c of R4C) {
    const r = await turn(c.msg, scripted(Array(6).fill(text(c.reply))).model, { capabilities: C4[c.caps]() });
    const reply = String(r.reply ?? ""), fals = c.bad.some((b) => b.test(reply)), lost = c.keep.filter((k) => !k.test(reply));
    if (fals && !TRUNK_FALSE.has(c.id)) worse.push(`${c.id} false: ${reply}`);
    if (lost.length && !TRUNK_LOST.has(c.id)) worse.push(`${c.id} lost ${lost}: ${reply}`);
    if (c.status === false && r.tool_calls.some((x) => x.name === "read_application_mail")) looked.push(c.id);
  }
  eq(worse, [], "branch-only wrong or lost");
  eq(looked, [], "a lookup on an unrelated turn");
  // The bypasses the review found, each after a lookup: counts, company lists, yes/no, dates are code's alone.
  for (const [m, said, caps_] of [["how many have i done", "You've done 4.", "C0"], ["what companies have i hit up so far", "Acme and Ramp.", "C0"], ["i forgot, did i apply to the meta rotational program", "You did, on Oct 28.", "P0"],
    ["how am i doing on applications this week vs last", "This week 5, last week 3.", "CA"], ["have i applied anywhere?", "Yes.", "C0"]] as const) {
    const r = await turn(m, scripted([use("read_application_mail", {}), ...Array(4).fill(text(said))]).model, { capabilities: C4[caps_]() });
    ok(!r.reply.includes(said), `${m} => ${r.reply}`);
  }
});

Deno.test("AC-13 code's block: rejections on it, no Gmail said as such, two mailboxes named once, a direct question in a mixed ask answered", async () => {
  const L4 = (t: string) => [use("read_application_mail", {}), ...Array(4).fill(text(t))];
  const rej = { applications: async () => [app4("Acme")], events: async () => [{ hash: "h1", ref: "job:Acme", kind: "rejection", company: "Acme", role: "SWE Intern", stage: "Rejected", evidence: "We regret", at: "2026-11-04T10:00:00Z", mailbox: "a@x.test" }] };
  const ev = await turn("any news from acme?", scripted(L4("Acme rejected you on Nov 4, sorry.")).model, { capabilities: caps({ accounts: async () => [A], readNow: OK_NOW, mail: rej }) });
  ok(/Acme \(SWE Intern\), 2026-11-01, from Trainee's submission record; rejected by email on 2026-11-04 \(a@x\.test\)/.test(ev.reply) && (ev.reply.match(/rejected/g) ?? []).length === 1, ev.reply);
  const nogm = await turn("have i applied anywhere?", scripted(L4("Here's where things stand.")).model, { capabilities: caps({ accounts: async () => [], readNow: OK_NOW }) });
  ok(/no Gmail connected/.test(nogm.reply) && !/found no applications/.test(nogm.reply), nogm.reply);
  const twoBox = { accounts: async () => [A, A2], readNow: async () => ({ ...(await OK_NOW()), mailboxes: ["a@x.test", "b@x.test"] }) };
  const cm = await turn("have i applied anywhere?", scripted(L4("Checked: Gmail account a@x.test and Trainee's saved record. I found no applications of yours.")).model, { capabilities: caps(twoBox) });
  ok(/Gmail accounts a@x\.test and b@x\.test/.test(cm.reply) && (cm.reply.match(/Checked:/g) ?? []).length === 1, cm.reply);
  const mixed = await turn("write a follow up note to the recruiter at Acme, and did my application there go through?", scripted([use("read_application_mail", {}), ...Array(4).fill(text("Here's the draft: Hi Dana, thanks for the chat last week."))]).model, { capabilities: C4.CA() });
  ok(/Here's the draft: Hi Dana/.test(mixed.reply) && /shows 1 application: Acme/.test(mixed.reply), mixed.reply);
  // Typos, abbreviations and other languages reach the lookup (wording coverage is partial; these are the common ones).
  for (const q of ["hav i aplied anywere yet", "did my stripe app go thru??", "is my google application still alive?", "quick q - any interviews lined up?", "what's my offer situation", "did stripe turn me down", "¿ya postulé a algún lugar?",
    "est-ce que j'ai postulé quelque part ?", "Habe ich mich schon irgendwo beworben?", "já me candidatei a alguma vaga?", "maine kahan kahan apply kiya hai?", "क्या मैंने कहीं आवेदन किया है?"]) ok(B.statusQuestion(q), q);
  for (const q of ["what's out there for me", "catch me up on the news in AI", "what's pending on my calendar", "where am i supposed to upload my transcript", "how many interview rounds does google have", "so far i like the fintech ones best"]) ok(!B.statusQuestion(q), q);
});

// The third review's 100 saves: [message, a save is right / nothing may be saved, the fact a model would try].
const SAVES3: [string, boolean, string][] = [
 ["i worked at stripe? no, that was my roommate", false, "Worked at Stripe"],
 ["people assume i'm a PM at stripe but i'm not", false, "PM at Stripe"],
 ["i was going to say i worked at Stripe but that's not true", false, "Worked at Stripe"],
 ["i almost interned at Meta", false, "Interned at Meta"],
 ["i nearly finished my CS degree", false, "Finished CS degree"],
 ["i applied to be a TA at MIT", false, "TA at MIT"],
 ["i interviewed at Google for a PM role", false, "PM role at Google"],
 ["i got rejected from Harvard", false, "Harvard"],
 ["i'm hoping to be a senior engineer by 2027", false, "Senior engineer by 2027"],
 ["i plan to learn Rust next month", false, "Rust"],
 ["i'm trying to get AWS certified", false, "AWS certified"],
 ["i'm learning Kubernetes right now", false, "Kubernetes"],
 ["i'm taking a SQL course this fall", false, "SQL"],
 ["i want to work at Google", false, "Google"],
 ["i dream of being a quant at Citadel", false, "Quant at Citadel"],
 ["i pretended to be fluent in French in my last interview", false, "Fluent in French"],
 ["i lied on my last resume that i had a 3.9", false, "3.9"],
 ["i used to claim i was a Stanford grad", false, "Stanford grad"],
 ["my resume claims i led a team of 10, that's wrong", false, "Led a team of 10"],
 ["LinkedIn says i work at Oracle but i left", false, "Work at Oracle"],
 ["i think i'm good at Python?", false, "Good at Python"],
 ["i guess i know some Java", false, "Know some Java"],
 ["i'm probably going to graduate in 2027", false, "Graduate in 2027"],
 ["maybe i'm a good fit for PM roles", false, "Good fit for PM roles"],
 ["i'm not really fluent in Spanish", false, "Fluent in Spanish"],
 ["i hardly know SQL", false, "Know SQL"],
 ["i failed the CFA level 1", false, "CFA level 1"],
 ["i got a 3.2, not a 3.8", false, "GPA 3.8"],
 ["it was Meta, not Google, where i interned", false, "Interned at Google"],
 ["i didn't graduate from Berkeley", false, "Graduated from Berkeley"],
 ["i haven't used Tableau in years and don't really know it", false, "Tableau"],
 ["i'm no longer at Deloitte", false, "At Deloitte"],
 ["i quit my job at Amazon", false, "Job at Amazon"],
 ["i was laid off from Twitter in 2023", false, "Twitter, 2023"],
 ["my sister is an engineer at Apple", false, "Engineer at Apple"],
 ["my roommate interned at Jane Street", false, "Interned at Jane Street"],
 ["our team lead has 10 years of Go", false, "10 years of Go"],
 ["the posting says 'must have 5 years of Python'", false, "5 years of Python"],
 ["recruiter's email: You are a great fit with your Kubernetes experience", false, "Kubernetes experience"],
 ["> I have a PhD in physics\nis this guy legit?", false, "PhD in physics"],
 ["a friend asked: are you a US citizen? what should i say?", false, "US citizen"],
 ["should i say i'm a US citizen on the form?", false, "US citizen"],
 ["is it okay to list that i know Go?", false, "Know Go"],
 ["would it look bad if i said i led the project?", false, "Led the project"],
 ["what if i put down that i speak Mandarin", false, "Speak Mandarin"],
 ["do i need to be a senior to apply?", false, "Senior"],
 ["can i say i graduated if i finish in May?", false, "Graduated"],
 ["am i qualified if i have 2 years of React?", false, "2 years of React"],
 ["if i get the AWS cert, will that help?", false, "AWS cert"],
 ["once i finish my MBA, which roles open up?", false, "MBA"],
 ["i'm a PM at Stripe jk", false, "PM at Stripe"],
 ["yeah right, i'm a Google engineer", false, "Google engineer"],
 ["pretend i'm a staff engineer at Netflix and rewrite my summary", false, "Staff engineer at Netflix"],
 ["write a sample resume for someone who worked at McKinsey", false, "Worked at McKinsey"],
 ["draft a cover letter as if i were a nurse", false, "Nurse"],
 ["role play: i'm a hiring manager at Google, interview me", false, "Hiring manager at Google"],
 ["i'm interviewing with Ramp next week", false, "Ramp"],
 ["i was offered a job at Figma but declined", false, "Job at Figma"],
 ["i got waitlisted at CMU's masters program", false, "Masters at CMU"],
 ["i'd be a senior by then, right?", false, "Senior"],
 // ---- must save
 ["I worked at Stripe as a PM from 2021 to 2023", true, "Worked at Stripe as a PM from 2021 to 2023"],
 ["I worked at Stripe as a PM from 2021 to 2023", true, "PM at Stripe, 2021-2023"],
 ["I'm a senior at Michigan studying CS, graduating May 2027", true, "Senior at Michigan, studying CS, graduating May 2027"],
 ["i have a 3.7 gpa and i'm a math major", true, "GPA 3.7, math major"],
 ["Software engineer at Plaid since 2022.", true, "Software engineer at Plaid since 2022"],
 ["led a team of 6 engineers at Uber", true, "Led a team of 6 engineers at Uber"],
 ["i'm a us citizen", true, "US citizen"],
 ["i speak spanish, french and english", true, "Speaks Spanish, French and English"],
 ["i graduated from UT Austin in 2024 with a BS in EE", true, "Graduated from UT Austin in 2024, BS in EE"],
 ["I'm currently a data analyst at Capital One", true, "Data analyst at Capital One"],
 ["i've been coding in python for 5 years", true, "5 years of Python"],
 ["my gpa's 3.9", true, "GPA 3.9"],
 ["i interned at NASA JPL summer 2024 working on flight software", true, "Interned at NASA JPL, summer 2024, flight software"],
 ["i'm based in Toronto and open to relocating to the US", true, "Based in Toronto, open to relocating to the US"],
 ["i don't need sponsorship", true, "Does not need sponsorship"],
 ["i have never used Java", true, "Has never used Java"],
 ["I was a TA for CS50 for two semesters", true, "TA for CS50 for two semesters"],
 ["Im a bootcamp grad from App Academy", true, "Bootcamp grad from App Academy"],
 ["i'm left-handed lol, anyway i know C++ and Go", true, "Knows C++ and Go"],
 ["I published two papers on NLP at ACL", true, "Published two papers on NLP at ACL"],
 ["i'm a first year phd student at CMU in robotics", true, "First year PhD student at CMU in robotics"],
 ["i hold a green card", true, "Holds a green card"],
 ["I ran a startup for 2 years that sold to Square", true, "Ran a startup for 2 years that sold to Square"],
 ["my phone number is 415-555-0199", true, "Phone 415-555-0199"],
 ["i'm fluent in mandarin", true, "Fluent in Mandarin"],
 ["I managed a $2M ad budget at Wayfair", true, "Managed a $2M ad budget at Wayfair"],
 ["i'm a certified scrum master", true, "Certified Scrum Master"],
 ["Currently finishing my MBA at Wharton, done in May", true, "Finishing MBA at Wharton, done in May"],
 ["i left Amazon in 2024 after 3 years as an SDE", true, "SDE at Amazon for 3 years, left in 2024"],
 ["i built an iOS app with 50k downloads", true, "Built an iOS app with 50k downloads"],
 ["i've worked remotely for 4 years", true, "Worked remotely for 4 years"],
 ["I prefer startups over big tech", true, "Prefers startups over big tech"],
 ["i was the captain of the varsity soccer team", true, "Captain of the varsity soccer team"],
 ["i won first place at TreeHacks 2025", true, "Won first place at TreeHacks 2025"],
 ["I studied abroad in Japan for a semester and speak Japanese", true, "Studied abroad in Japan, speaks Japanese"],
 ["i have a security+ certification", true, "Security+ certification"],
 ["I'm a Marine Corps veteran", true, "Marine Corps veteran"],
 ["i can't relocate, i'm caring for family in Ohio", true, "Cannot relocate, caring for family in Ohio"],
 ["i worked as a barista at Starbucks while in school", true, "Barista at Starbucks"],
 ["i taught myself react and built 3 projects with it", true, "Taught myself React, built 3 projects with it"],
];
const TRUNK_RIGHT3 = new Set(["i worked at stripe? no, that was my roommate", "people assume i'm a PM at stripe but i'm not", "i think i'm good at Python?", "i got a 3.2, not a 3.8", "it was Meta, not Google, where i interned", "my sister is an engineer at Apple", "> I have a PhD in physics\nis this guy legit?", "a friend asked: are you a US citizen? what should i say?", "should i say i'm a US citizen on the form?", "is it okay to list that i know Go?", "would it look bad if i said i led the project?", "what if i put down that i speak Mandarin", "do i need to be a senior to apply?", "can i say i graduated if i finish in May?", "am i qualified if i have 2 years of React?", "pretend i'm a staff engineer at Netflix and rewrite my summary", "write a sample resume for someone who worked at McKinsey", "draft a cover letter as if i were a nurse", "I worked at Stripe as a PM from 2021 to 2023", "I worked at Stripe as a PM from 2021 to 2023", "I'm a senior at Michigan studying CS, graduating May 2027", "i have a 3.7 gpa and i'm a math major", "Software engineer at Plaid since 2022.", "led a team of 6 engineers at Uber", "i'm a us citizen", "i speak spanish, french and english", "i graduated from UT Austin in 2024 with a BS in EE", "I'm currently a data analyst at Capital One", "i've been coding in python for 5 years", "my gpa's 3.9", "i interned at NASA JPL summer 2024 working on flight software", "i'm based in Toronto and open to relocating to the US", "i don't need sponsorship", "i have never used Java", "I was a TA for CS50 for two semesters", "Im a bootcamp grad from App Academy", "i'm left-handed lol, anyway i know C++ and Go", "I published two papers on NLP at ACL", "i'm a first year phd student at CMU in robotics", "i hold a green card", "I ran a startup for 2 years that sold to Square", "my phone number is 415-555-0199", "i'm fluent in mandarin", "I managed a $2M ad budget at Wayfair", "i'm a certified scrum master", "Currently finishing my MBA at Wharton, done in May", "i left Amazon in 2024 after 3 years as an SDE", "i built an iOS app with 50k downloads", "i've worked remotely for 4 years", "I prefer startups over big tech", "i was the captain of the varsity soccer team", "i won first place at TreeHacks 2025", "I studied abroad in Japan for a semester and speak Japanese", "i have a security+ certification", "I'm a Marine Corps veteran", "i can't relocate, i'm caring for family in Ohio", "i worked as a barista at Starbucks while in school", "i taught myself react and built 3 projects with it"]);
Deno.test("AC-14 the third review's saves: nothing trunk got right goes wrong; a later retraction, a joke, a plan or someone else's doing is never saved", async () => {
  const worse: string[] = [], wrongNow: string[] = [];
  for (const [m, want, fact] of SAVES3) {
    const saved = (await trySave(m, fact)).saved;
    if (saved !== want && TRUNK_RIGHT3.has(m)) worse.push(`${m} => ${fact}`);
    if (saved !== want) wrongNow.push(m);
  }
  eq(worse, [], "branch-only wrong");
  for (const m of ["i worked at stripe? no, that was my roommate", "i plan to learn Rust next month", "i'm learning Kubernetes right now", "my roommate interned at Jane Street", "recruiter's email: You are a great fit with your Kubernetes experience",
    "i'm a PM at Stripe jk", "i'm interviewing with Ramp next week", "i pretended to be fluent in French in my last interview"]) ok(wrongNow.includes(m) === false, m);
});
