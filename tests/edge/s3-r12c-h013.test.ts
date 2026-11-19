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
  for (const ok of ["Nothing will be submitted without your yes.", "I won't submit anything until you approve it.", "Nothing gets sent without your explicit yes.", "I'll only submit after your yes to that exact application."])
    assert(consentRule(ok), ok);
});

Deno.test("S3 r12c / H013: a status report dressed as the rule is still held", () => {
  for (const bad of ["Nothing was submitted without your yes.", "Your 3 applications went out with your approval, none without your yes.", "Acme replied, and nothing goes out without your yes.", "You applied to only Stripe, and nothing goes out without your yes."])
    assert(!consentRule(bad), bad);
  const out = heldReply("Nothing was submitted without your yes. Want me to search?", ownEmpty, true);
  assert(!/Nothing was submitted without your yes/.test(out), out);
});
