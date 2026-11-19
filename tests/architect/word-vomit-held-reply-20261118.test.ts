// Word-vomit benchmark (evals/word-vomit WV07, WV13): the brain ran the application lookup on its own while answering
// something else ("3 interviews next week, more to apply to, and my resume is trash"), and the status hold, strict because the
// model had looked, dropped the whole answer, leaving only code's line about an empty record. A turn that did not ask about its
// applications and whose reply says nothing about them is untouched; one whose reply does speak of them is still held.
import assertNode from "node:assert/strict";
import * as B from "../../supabase/functions/agent-chat/career_brain.ts";

const LOOK = B.lookupOf([{ name: "read_application_mail", ok: true }], { status: "complete", could_not_read: [], read: ["Trainee's saved record"], found: [] }, { unreadable: [], found: [] });
const MSG = "i have like 3 interviews next week and also still need to apply to more stuff but also my resume is kinda trash?? idk where to start";
const ANSWER = "Start with the interviews, since they're dated. Tell me the three companies and I'll build a prep sheet for each. Then we fix the resume's top third, and after that I'll line up a batch of roles for one yes.";

Deno.test("word-vomit: a model-run lookup on a turn not about applications leaves a non-status answer untouched", () => {
  assertNode.equal(B.statusLike(ANSWER), false);
  assertNode.equal(B.applicationsEnforced(ANSWER, LOOK, { message: MSG, codeRan: false }), ANSWER);
});
Deno.test("word-vomit: the same turn's status sentence is still code's", () => {
  const out = B.applicationsEnforced(`You haven't applied anywhere yet. ${ANSWER}`, LOOK, { message: MSG, codeRan: false });
  assertNode.ok(out.startsWith(B.coverageLine(LOOK)), out);
  assertNode.ok(!/haven't applied anywhere/.test(out), out);
});
