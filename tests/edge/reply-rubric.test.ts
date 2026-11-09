// WO-N: the reply rubric (supabase/functions/_shared/reply_rubric.ts), rule by rule, on the replies the spec quotes.
// Bad examples are Trainee's actual replies (APP-LAYER-15-FIXES.md A.2 and F); good examples are the target replies of A.5
// and B (labelled there as proposed, not executed). Check: deno test -A --no-check tests/edge/reply-rubric.test.ts
import assertNode from "node:assert/strict";
import {
  answersFirst, apologyLoop, blockerNamed, boilerplateTails, channelLength, checkReply, endsAtDecision, internalWords,
  inventedFacts, repeatsAsk, type RubricInput, type RuleId, timeZoneRule, unprovenActions,
} from "../../supabase/functions/_shared/reply_rubric.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const rules = (vs: { rule: RuleId }[]) => vs.map((v) => v.rule);
const passes = (vs: { rule: RuleId; detail: string; quote?: string }[], what: string) =>
  assertNode.deepStrictEqual(vs, [], `${what} should pass: ${JSON.stringify(vs)}`);
const fails = (vs: { rule: RuleId }[], rule: RuleId, what: string) => ok(rules(vs).includes(rule), `${what} should break ${rule}: ${JSON.stringify(vs)}`);

// ------------------------------------------------------------------------------------------------- the spec's own words
const ASK_RESUME_1 = "Can you turn the resume I uploaded into a clean one-page PDF for data analyst internships? Keep the facts as written, don't add experience, and send me the actual PDF.";
const BAD_RESUME_1 = "There is no document file on this conversation yet to send you.\nA file exists here only once a resume has been tailored in this chat — tailoring renders the PDF from your confirmed facts, and the file then rides with my reply. Name the role (or paste the posting) and I will tailor your resume and send the PDF here.";
const ASK_RESUME_2 = "The role is a data analyst internship, like I said. Please tailor the resume for that and generate the one-page PDF. If a fact needs my confirmation, ask me the specific question rather than adding anything.";
const BAD_RESUME_2 = "Your resume is tailored for Ads Conversion Modeling, Machine Learning Engineering Manager at reddit.\nIt leads with your proven skills, and every line traces to a fact already on your profile. Skill gap, named plainly: Machine Learning is required by the posting and not on your profile, so it was not added to the resume. Eligibility verdict: this record meets the posting's hard requirements, but some required skills the posting names are not evidenced in the record — they are named in the gap list that travels with this packet.\nSaved as PDF and DOCX files, attached for your review — parse check PASS. Picked first from the 5 roles that fit your profile in the current list — grounded in your profile record and the posting's own text, as of November 2026. There is no name or email at the top of this file: none was typed for it and none was confirmed with your resume, so nothing is printed there.\nWhat name and email should go at the top of your resume?\nWhat changed: Same as your base resume; it already fits this posting.";
const ASK_RESUME_3 = "That's the wrong role. I asked for a data analyst internship, not a machine learning manager job at Reddit. Please fix the target and send a download link for the PDF too, since the attachment isn't opening here. Don't apply to anything.";
const BAD_RESUME_3 = "I haven't started that batch: nothing was searched, prepared or sent, because the runner for that kind of ask is not switched on. What does run: say \"apply to the top 10 <role> jobs in <city>\", or pick from a list I showed (\"apply to all of them\", \"apply to 1 and 3\"), and I put those postings on your apply list; each one is prepared, shown to you exactly as it would be sent, and goes to the employer only after your yes to that card.";
const ASK_SEARCH_1 = "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet.";
const BAD_SEARCH_1 = "Nothing was invented to fill the list. Widen the role or the place and I'll search again.";
const ASK_SEARCH_2 = "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements.";
const BAD_SEARCH_2 = "The window, checked against the record.\nI cannot answer that from the record: your graduation date is not stated. Eligibility here is a comparison of two stated facts, and one of them is unknown — I will not guess it. Ask the employer for the exact window wording, or check the posting text, and the comparison is mechanical.\nTell me when you're ready to start: get the posting's exact graduation wording and check it against your stated graduation date. Source: graduation date and posting window as supplied in context (one of the two is missing — named in the unknowns), as of 2026-10-13. Get the posting's exact graduation wording and check it against your stated graduation date.\nTell me what you'd like to do next.\nYou've reached today's limit on AI-written answers, so this reply comes from Trainee's built-in steps without the AI. The limit resets at midnight UTC.";
const BAD_F1 = "Nothing was invented to fill the list. Widen the role or the place and I'll search again. And nothing is sent anywhere before your resume is confirmed: its entries are waiting for your word (reply \"yes, that's my resume\" if they're right).";
const ASK_F3 = "Stop the people list. I didn't ask for analysts to contact, any drafts, or an application batch. Don't contact anyone or start any new work. I asked for company research, and you haven't answered it. Leave everything unsent.";
const BAD_F3 = "Stopped everything I can reach: the global pause is now set for your account, which blocks every send path this product controls. I could not read the queue's own records in this session, so how many already went out and how many were waiting is unverified. Next step — the moment the queue records load, I reconcile them and report the exact counts here; you do not need to ask again.";

const GOOD_COMPARATOR = "Here is the one-page PDF, ordered toward data analyst internships. It is built from your saved intake notes rather than the original resume file, so I left GPA off because the sources disagree and marked the contact details to fill in. I did not add experience; I reordered and tightened the supplied draft.";
const GOOD_WRONG_ROLE = "I used the wrong role. I will redo the draft for data analyst internships and will not apply anywhere.";
const GOOD_LIMIT = "I hit the daily AI-answer limit, so I cannot finish this search right now. It resets at 6 pm Chicago time today; I have not applied anywhere.";
const GOOD_AMBIGUOUS = "Do you mean submit the application for job 2, or send you the revised resume PDF?";
const GOOD_RESULT = "I verified 3 open matches. 2 are in Chicago and 1 is remote US; I did not find five within the scope checked.";
const GOOD_APPLY_WHICH = "Which role should this go to? Before sending, I will show you the target, the final resume and the exact application answers. The draft still has contact placeholders, so it is not ready for submission.";
const GOOD_PICK = "Lakefront first, if you can work onsite on Tuesdays and Thursdays. It has the clearest connection to your Python and SQL work. Prairie is second because it is remote, but I cannot call it eligible until your graduation date is confirmed. Northline is a reasonable backup if the Evanston commute works.";
const GOOD_REMOTE = "That removes Lakefront and Northline from this shortlist. Prairie is the only remote example remaining; graduation eligibility is still unresolved. I would keep searching for remote-US analytics roles rather than fill the list with onsite jobs.";
const GOOD_NOT_QUALIFY = "No. The inspected role page has a specific graduation window and office locations. I have not confirmed your graduation date, relocation willingness or the rest of the application requirements. The brief prepares an interview; it does not establish eligibility or guarantee a job is still accepting applications.";
const GOOD_MAYA_DRAFT = "Draft: Hi Maya, here is my revised resume for the data analyst internship. I would love your feedback if you have a chance. Thanks, [Your name].";
const GOOD_CLOSEOUT = "Submitted Data Analyst Intern at Lakefront at 3:10 pm CST. Confirmation: LTA-55120. Prairie is ready but not submitted because the form asks for your graduation date and I do not have it. What is your graduation date?";

// ---------------------------------------------------------------------------------------------------- 1. answers first
Deno.test("answers_first: the spec's target replies lead with the answer", () => {
  for (const [ask, reply] of [
    [ASK_RESUME_1, GOOD_COMPARATOR], [ASK_RESUME_3, GOOD_WRONG_ROLE], [ASK_SEARCH_2, GOOD_LIMIT], ["Send this one.", GOOD_AMBIGUOUS],
    [ASK_SEARCH_1, GOOD_RESULT], ["Now apply with it.", GOOD_APPLY_WHICH], ["Which is best for me?", GOOD_PICK], ["I need remote only.", GOOD_REMOTE],
    ["Does this mean I qualify for the internship?", GOOD_NOT_QUALIFY], ["A little less formal.", GOOD_MAYA_DRAFT], ["The PDF to me.", "Here is the revised PDF."],
  ]) passes(answersFirst({ ask, reply }), reply.slice(0, 50));
});
Deno.test("answers_first: a preamble, a process statement or another workflow is not an answer", () => {
  fails(answersFirst({ ask: ASK_SEARCH_1, reply: BAD_SEARCH_1 }), "answers_first", "A.2 empty search");
  fails(answersFirst({ ask: ASK_SEARCH_2, reply: BAD_SEARCH_2 }), "answers_first", "A.2 graduation lecture");
  fails(answersFirst({ ask: ASK_RESUME_3, reply: BAD_RESUME_3 }), "answers_first", "A.2 batch reply to a correction");
  fails(answersFirst({ ask: "What's Stripe like to work for?", reply: "Great question! Stripe is a payments company." }), "answers_first", "canned opener");
  fails(answersFirst({ ask: "anything new?", reply: "on it — looking for roles now" }), "answers_first", "an ack as the answer");
});

// -------------------------------------------------------------------------------------------------- 2. ends at decision
Deno.test("ends_at_decision: the decision is the last sentence", () => {
  passes(endsAtDecision({ ask: "Send this one.", reply: GOOD_AMBIGUOUS, decisionPending: true }), "B.4 clarification");
  passes(endsAtDecision({ ask: "Apply", reply: GOOD_CLOSEOUT, decisionPending: true }), "B.3 closeout with the open question last");
  passes(endsAtDecision({ ask: "approve it", reply: "The packet for Lakefront is below.\nReply yes to submit it, or tell me what to change." , decisionPending: true }), "a yes/no choice");
  passes(endsAtDecision({ ask: "status?", reply: "Here is the revised PDF.", decisionPending: false }), "no decision pending");
});
Deno.test("ends_at_decision: a question buried under more prose, or a pending decision never put", () => {
  fails(endsAtDecision({ ask: ASK_RESUME_2, reply: BAD_RESUME_2 }), "ends_at_decision", "A.2 resume turn 2 (\"What changed\" after the question)");
  fails(endsAtDecision({ ask: "Now apply with it.", reply: "I can prepare it. The draft still has contact placeholders.", decisionPending: true }), "ends_at_decision", "pending, no question");
  fails(endsAtDecision({ ask: "x", reply: "I have the draft ready. Which Maya do you mean? I can draft a note in the meantime. It will be short." }), "ends_at_decision", "a question in the middle, prose after it");
  passes(endsAtDecision({ ask: "Now send it to Maya.", reply: "Which Maya, and where should I send it? I can draft a short note while you find it." }), "B.6 continuation 4: the question leads");
});

// ----------------------------------------------------------------------------------------------- 3. no unproven action
Deno.test("unproven_action: a claim needs this turn's proof", () => {
  fails(unprovenActions({ ask: ASK_RESUME_2, reply: BAD_RESUME_2, proofs: [] }), "unproven_action", "A.2 'attached' / 'parse check PASS' with nothing proved");
  fails(unprovenActions({ ask: ASK_F3, reply: BAD_F3, proofs: [] }), "unproven_action", "F.3 global pause claimed, not read back");
  fails(unprovenActions({ ask: "Apply", reply: GOOD_CLOSEOUT, proofs: [] }), "unproven_action", "'Submitted' with no receipt");
  passes(unprovenActions({ ask: "Apply", reply: GOOD_CLOSEOUT, proofs: ["submitted"] }), "B.3 closeout with the employer receipt");
  passes(unprovenActions({ ask: "The PDF to me.", reply: "Here is the revised PDF.", proofs: ["file"] }), "B.4 the file rides with the reply");
  fails(unprovenActions({ ask: "The PDF to me.", reply: "Here is the revised PDF.", proofs: [] }), "unproven_action", "'here is the PDF' with no file");
});
Deno.test("unproven_action: negations, conditions and future steps are not claims", () => {
  for (const reply of [GOOD_WRONG_ROLE, GOOD_LIMIT, GOOD_APPLY_WHICH, "Nothing was sent or submitted.", "Once you say yes I'll submit it.", "I have not applied anywhere."]) {
    passes(unprovenActions({ ask: "x", reply, proofs: [] }), reply);
  }
  ok(checkReply({ ask: "x", reply: "Sent." }).skipped.includes("unproven_action"), "no proofs given: the rule is reported skipped");
});

// ------------------------------------------------------------------------------------------------- 4. no invented fact
const FACTS = ["Python screening workflow across 100+ targets", "Skills: Python, SQL", "Target: data analyst internship, Chicago"];
Deno.test("invented_fact: names, numbers and links come from the facts or the ask", () => {
  fails(inventedFacts({ ask: ASK_RESUME_2, reply: BAD_RESUME_2, facts: FACTS }), "invented_fact", "A.2 the Reddit ML manager role");
  fails(inventedFacts({ ask: "less wordy", reply: "Proposed replacement: Built a Python workflow that screened 250 targets.", facts: FACTS }), "invented_fact", "a changed count");
  fails(inventedFacts({ ask: "link?", reply: "Apply here: https://jobs.example.com/made-up", facts: FACTS }), "invented_fact", "an invented link");
  fails(inventedFacts({ ask: "Maya at the company", reply: "I'll draft it to maya@acme.com.", facts: FACTS }), "invented_fact", "a guessed address (E.4 41)");
  passes(inventedFacts({ ask: "Can you make the first bullet less wordy?", reply: "Proposed replacement: Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets.", facts: FACTS }), "B.6 the supplied scale");
  passes(inventedFacts({ ask: "A little less formal.", reply: GOOD_MAYA_DRAFT, facts: ["Maya", "data analyst internship"] }), "placeholders and the ask's own names");
  ok(checkReply({ ask: "x", reply: "Acme." }).skipped.includes("invented_fact"), "no facts given: the rule is reported skipped");
});

// ------------------------------------------------------------------------------------------------ 5. blocker named
Deno.test("blocker_named: a stop says what blocked it, with evidence", () => {
  fails(blockerNamed({ ask: ASK_SEARCH_1, reply: BAD_SEARCH_1 }), "blocker_named", "A.2 empty search with no scope or reason");
  fails(blockerNamed({ ask: ASK_RESUME_3, reply: BAD_RESUME_3 }), "blocker_named", "A.2 'not switched on'");
  fails(blockerNamed({ ask: "x", reply: "I couldn't do that right now. Try again later." }), "blocker_named", "no reason");
  passes(blockerNamed({ ask: ASK_SEARCH_2, reply: GOOD_LIMIT }), "A.5 at the limit");
  passes(blockerNamed({ ask: ASK_SEARCH_1, reply: GOOD_RESULT }), "B.2 a bounded result");
  const blocker = { what: "the job board search connection", evidence: "Greenhouse returned 503 for 4 of 4 boards" };
  fails(blockerNamed({ ask: ASK_SEARCH_1, reply: "I could not finish the search because of a connection problem.", blocker }), "blocker_named", "named but no evidence");
  passes(blockerNamed({ ask: ASK_SEARCH_1, reply: "I could not search: the job board connection failed — Greenhouse returned 503 for all 4 boards I checked.", blocker }), "named with evidence");
});

// --------------------------------------------------------------------------- 6. no echo, no apology loop, no boilerplate
Deno.test("repeats_ask: no echo, and no asking again for what was given", () => {
  fails(repeatsAsk({ ask: ASK_RESUME_1, reply: BAD_RESUME_1 }), "repeats_ask", "A.5 pattern 1: 'Name the role' after the role");
  fails(repeatsAsk({ ask: ASK_SEARCH_1, reply: "You asked me to find 5 data analyst internships in Chicago. Here they are." }), "repeats_ask", "echo opener");
  fails(repeatsAsk({ ask: "Find data analyst internships in Chicago", reply: "Which city should I look in?" }), "repeats_ask", "asks the place again");
  passes(repeatsAsk({ ask: "Now apply with it.", reply: GOOD_APPLY_WHICH }), "B.6: no role was given, so asking is right");
  passes(repeatsAsk({ ask: ASK_SEARCH_1, reply: GOOD_RESULT }), "B.2 result");
});
Deno.test("apology_loop: one apology at most, never twice running", () => {
  fails(apologyLoop({ ask: "x", reply: "Sorry about that. My mistake — sorry again." }), "apology_loop", "three in one");
  fails(apologyLoop({ ask: "x", reply: "Sorry, I used the wrong role.", previousReplies: ["Sorry, that was wrong."] }), "apology_loop", "again after one");
  fails(apologyLoop({ ask: "x", reply: "I apologize for any confusion. Here it is." }), "apology_loop", "stock apology");
  passes(apologyLoop({ ask: ASK_RESUME_3, reply: GOOD_WRONG_ROLE }), "A.5 owns the mistake without a loop");
});
Deno.test("boilerplate_tail: no resume tail on a search, no next-step filler, no let-me-know", () => {
  fails(boilerplateTails({ ask: "Can you try that search again now?", reply: BAD_F1 }), "boilerplate_tail", "F.1 resume-confirmation tail");
  fails(boilerplateTails({ ask: ASK_SEARCH_2, reply: BAD_SEARCH_2 }), "boilerplate_tail", "A.2 'Tell me what you'd like to do next'");
  fails(boilerplateTails({ ask: "x", reply: "Here is the PDF. Let me know if you need anything else!" }), "boilerplate_tail", "let-me-know");
  passes(boilerplateTails({ ask: "is my resume right? how do I confirm it", reply: "Your resume has 4 entries. Reply \"yes, that's my resume\" if they're right." }), "the confirm prompt where it is the ask");
  passes(boilerplateTails({ ask: ASK_SEARCH_1, reply: GOOD_RESULT }), "B.2 result");
});

// ------------------------------------------------------------------------------------------------- 7. no internal words
Deno.test("internal: no ids, codes or system words", () => {
  fails(internalWords({ ask: ASK_RESUME_2, reply: BAD_RESUME_2 }), "internal", "A.5 pattern 3 'parse check PASS', 'record'");
  fails(internalWords({ ask: ASK_RESUME_3, reply: BAD_RESUME_3 }), "internal", "A.5 pattern 4 'runner'");
  fails(internalWords({ ask: "x", reply: "BATCH_NOT_STARTED_REPLY" }), "internal", "a constant name");
  fails(internalWords({ ask: "x", reply: "Your application app_8f3c2a91b7d4e6f0 is queued." }), "internal", "a row id");
  fails(internalWords({ ask: "x", reply: "Done (job_1234)." }), "internal", "a queue code");
  fails(internalWords({ ask: ASK_F3, reply: BAD_F3 }), "internal", "F.3 'the queue's own records'");
  for (const reply of [GOOD_COMPARATOR, GOOD_PICK, GOOD_CLOSEOUT, "Apply: https://boards.greenhouse.io/acme/jobs/4012345678"]) passes(internalWords({ ask: "x", reply }), reply.slice(0, 40));
});

// ------------------------------------------------------------------------------------------------- 8. channel length
Deno.test("channel_length: short asks get short replies; bubbles fit the channel", () => {
  fails(channelLength({ ask: "Which is best for me?", reply: BAD_RESUME_2, channel: "telegram" }), "channel_length", "A.2 wall of text for a short ask");
  passes(channelLength({ ask: "Which is best for me?", reply: GOOD_PICK, channel: "telegram" }), "B.6 the pick");
  const list = Array.from({ length: 5 }, (_, k) => `${k + 1}. Acme ${k} / Data Analyst Intern. Location: Chicago, hybrid. Student window: graduating 2027. Checked: Nov 9, 3 pm CST.\nhttps://boards.greenhouse.io/acme/jobs/${k}`).join("\n");
  passes(channelLength({ ask: ASK_SEARCH_1, reply: `I verified 5 open matches in Chicago.\n${list}`, channel: "telegram" }), "a shortlist's items are the content asked for");
  fails(channelLength({ ask: "x", reply: "a", bubbles: ["one", "two", "three", "four", "five"], channel: "whatsapp" }), "channel_length", "five text bubbles on WhatsApp");
  fails(channelLength({ ask: "long please", reply: "word ".repeat(1200), channel: "sms" }), "channel_length", "over SMS's size");
});

// ------------------------------------------------------------------------------------------------------ 9. time zone
Deno.test("time_zone: times in the person's own zone, no stale 'as of' date", () => {
  const now = new Date("2026-11-08T23:17:00Z");
  fails(timeZoneRule({ ask: ASK_SEARCH_2, reply: BAD_SEARCH_2, timeZone: "America/Chicago", now }), "time_zone", "A.2 'midnight UTC' and 'as of 2026-10-13'");
  ok(timeZoneRule({ ask: ASK_SEARCH_2, reply: BAD_SEARCH_2, timeZone: "America/Chicago", now }).length === 2, "both the UTC time and the stale date");
  fails(timeZoneRule({ ask: "x", reply: "It resets at 7 pm EST.", timeZone: "America/Chicago", now }), "time_zone", "another zone's clock");
  fails(timeZoneRule({ ask: "x", reply: "Checked at 2026-11-08T23:17:00Z.", timeZone: "America/Chicago", now }), "time_zone", "a raw timestamp");
  passes(timeZoneRule({ ask: "x", reply: GOOD_LIMIT, timeZone: "America/Chicago", now }), "A.5 '6 pm Chicago time'");
  passes(timeZoneRule({ ask: "x", reply: "Checked Nov 8, 5:17 pm CST.", timeZone: "America/Chicago", now }), "the person's abbreviation");
});

// ------------------------------------------------------------------------------------------------------- the whole rubric
Deno.test("checkReply: every observed reply of A.2 and F fails; the spec's target replies pass", () => {
  const now = new Date("2026-11-08T23:17:00Z"), timeZone = "America/Chicago";
  const bad: RubricInput[] = [
    { ask: ASK_RESUME_1, reply: BAD_RESUME_1 }, { ask: ASK_RESUME_2, reply: BAD_RESUME_2, proofs: [] }, { ask: ASK_RESUME_3, reply: BAD_RESUME_3 },
    { ask: ASK_SEARCH_1, reply: BAD_SEARCH_1 }, { ask: ASK_SEARCH_2, reply: BAD_SEARCH_2 }, { ask: "Can you try that search again now?", reply: BAD_F1 },
    { ask: ASK_F3, reply: BAD_F3, proofs: [] },
  ];
  for (const b of bad) ok(!checkReply({ ...b, now, timeZone }).ok, `should fail: ${b.reply.slice(0, 60)}`);
  const good: RubricInput[] = [
    { ask: ASK_RESUME_1, reply: GOOD_COMPARATOR, proofs: ["file"] }, { ask: ASK_RESUME_3, reply: GOOD_WRONG_ROLE, proofs: [] },
    { ask: ASK_SEARCH_2, reply: GOOD_LIMIT, proofs: [] }, { ask: "Send this one.", reply: GOOD_AMBIGUOUS, decisionPending: true, proofs: [] },
    { ask: "Now apply with it.", reply: GOOD_APPLY_WHICH, decisionPending: true, proofs: [] }, { ask: "Which is best for me?", reply: GOOD_PICK, proofs: [] },
    { ask: "I need remote only.", reply: GOOD_REMOTE, proofs: [] }, { ask: "Does this mean I qualify for the internship?", reply: GOOD_NOT_QUALIFY, proofs: [] },
    { ask: "Apply to the first one.", reply: GOOD_CLOSEOUT, decisionPending: true, proofs: ["submitted"] },
  ];
  for (const g of good) { const r = checkReply({ ...g, now, timeZone }); ok(r.ok, `should pass: ${g.reply.slice(0, 60)}: ${JSON.stringify(r.violations)}`); }
});
