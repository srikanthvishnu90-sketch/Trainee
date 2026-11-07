// The career turn's request hash (kept in the turn receipt, career_watch_kv) digests the message only after every redaction
// pass. Greptile on #564: hashedMessage was captured before the split-secret step, so "my verification code is" then "482913"
// stored careerRequestHash("482913"), which a million guesses recover. The Postgres scenario
// (flow-scenarios-adversarial-r2, "secrets") checks the stored receipts; this pins the order in the handler source.
import assertNode from "node:assert/strict";

Deno.test("request hash: captured after the split-secret step and the code-in-chat pass, and used only for the hash", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const at = (re: RegExp) => { const m = re.exec(src); assertNode.ok(m, `missing: ${re}`); return m!.index; };
  const split = at(/const red = lead \? redactPending\(message, lead\) : null;/);
  // #569: the pass is skipped only for a verified uploaded resume's text (fileText); it still runs before the capture.
  const codePass = at(/const codeShared = (?:fileText \? null : )?codeInChat\(message,/);
  const capture = at(/const hashedMessage = message;/);
  const use = at(/careerRequestHash\(hashedMessage,/);
  assertNode.ok(split < capture, "the hash input is taken after the split-secret redaction");
  assertNode.ok(codePass < capture, "the hash input is taken after the code-in-chat redaction");
  assertNode.ok(capture < use, "the hash is computed from that input");
  assertNode.equal(src.match(/const hashedMessage = /g)?.length, 1, "one capture");
  // nothing reassigns message between the capture and the hash
  assertNode.doesNotMatch(src.slice(capture + 1, use), /\bmessage\s*=(?!=)/, "message is not changed after the capture");
});
