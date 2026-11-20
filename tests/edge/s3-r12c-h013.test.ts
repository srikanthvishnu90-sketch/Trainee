// S3 r12c (the subscription sitting for 2789d3090: dev H013 split the judges). The transcripts are in
// evals/career/results/s3sub-2789d30903203bd7af2833bcb80ad4facf0c5705-p1.json / -p2.json.
// Run: deno test -A --no-check tests/edge/s3-r12c-h013.test.ts
import { consentRule, heldReply, OWN_RECORD_NOTE, type Look } from "../../supabase/functions/agent-chat/career_brain.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }

// ---------------------------------------------------------------------------------------------------------------- H013
const ownEmpty: Look = { tried: true, ok: true, status: "complete", what: [], read: [], found: [], own: true };

Deno.test("S3 r12c / H013: on a held applications turn the rule that nothing goes out without their yes is kept", () => {
  // (p2: "stop — don't submit anything yet" -> list_applications; the strict hold kept only code's record line and the search offer)
  const draft = "Understood, I'm holding everything. Nothing goes out without your yes to the card that shows it. You have no applications on file. Tell me the role you want and I'll search and shortlist first.";
  const out = heldReply(draft, ownEmpty, true);
  assert(out.startsWith("Trainee's saved record shows no applications of yours.") && out.includes(OWN_RECORD_NOTE), out);
  assert(out.includes("Nothing goes out without your yes to the card that shows it."), out);
  assert(!/You have no applications on file/.test(out), "the model's own status sentence is still code's to state");
  for (const ok of ["I won't submit anything until you approve it.", "Nothing goes out without your yes.", "Nothing will go out until you approve it."])
    assert(consentRule(ok), ok);
  // (review of PR #871, B3: a word of status, an application or a draft named, is held even in the rule's shape)
  for (const held of ["Nothing will be submitted without your yes.", "Nothing gets sent without your explicit yes.", "I'll only submit after your yes to that exact application."])
    assert(!consentRule(held), held);
});

Deno.test("S3 r12c / H013: a status report dressed as the rule is still held", () => {
  for (const bad of ["Nothing was submitted without your yes.", "Your 3 applications went out with your approval, none without your yes.", "Acme replied, and nothing goes out without your yes.", "You applied to only Stripe, and nothing goes out without your yes."])
    assert(!consentRule(bad), bad);
  const out = heldReply("Nothing was submitted without your yes. Want me to search?", ownEmpty, true);
  assert(!/Nothing was submitted without your yes/.test(out), out);
});

// (probe-r12c-fix2-2 and the traced replay of H013: the rule was joined to a status clause, and the sentence went whole)
Deno.test("S3 r12c / H013: the rule joined to a status clause stays as its own clause; the status clause still goes", () => {
  const cases: [string, string][] = [
    ["Understood, and there's nothing to stop: you have no applications queued, prepared or sent, so nothing is in flight and nothing was waiting on you. Nothing was submitted, and nothing goes out without your yes to the card that shows it.", "Nothing goes out without your yes to the card that shows it."],
    ["Understood, nothing is in flight: you have no applications queued, prepared or sent, so there is nothing to stop and nothing will go out without your yes. Nothing was submitted.", "Nothing will go out without your yes."],
    ["You applied to 3 roles, and nothing goes out without your yes.", "Nothing goes out without your yes."],
  ];
  for (const [draft, rule] of cases) {
    const out = heldReply(draft, ownEmpty, true);
    assert(out.includes(rule), `${draft}\n=> ${out}`);
    assert(!/you have no applications|nothing is in flight|applied to 3|Nothing was submitted/i.test(out.replace(OWN_RECORD_NOTE, "")), `a status clause stood: ${out}`);
  }
});
