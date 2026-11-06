// A hex digest is a hash, never a card number. A prepared application carries several sha256 digests (engine_approval,
// schema_hash, manifest_hash, fact ids such as "approved-local-resume:<sha256>"); a random 64-character digest holds a
// Luhn-valid run of 13 to 19 digits about one time in two hundred, and the card-number check read it as a secret: the results
// page showed "\"engine_approval\" needs you" and offered no Apply (missing-info-e2e.test.ts step 7 failed in CI on #546 and
// #548, passing on rerun). A real card number, alone or in words, is still a secret, and so is one next to a short hex word.
// Run: deno test -A --no-check tests/architect/secret-value-digest.test.ts
import assertNode from "node:assert/strict";
import { isSecretField, secretFields, secretKey, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// A sha256 the check flagged before the fix: "573759505661039849" inside it is an 18-digit Luhn-valid run.
const DIGEST = "60157ca77dde71b7c573759505661039849f7fb7896a1463322faa35d5cfe50d";
const CARD = "4242 4242 4242 4242";

Deno.test("a sha256 digest with a Luhn-valid digit run is not a secret; a card number still is", () => {
  eq(secretKey("engine_approval", DIGEST), false, "engine_approval");
  eq(secretKey("schema_hash", DIGEST.toUpperCase()), false, "upper-case digest");
  eq(secretKey("replay_sources", [{ fact_id: `approved-local-resume:${DIGEST}` }]), false, "a fact id carrying a digest");
  eq(isSecretField({ name: "why", label: "Why Globex?", value: `ref ${DIGEST}` }), false, "a digest inside an answer");
  const p = { payload: { version: 1, user_id: "u", job_id: "j", engine_approval: DIGEST, manifest_hash: DIGEST, fields: [{ name: "why", label: "Why", value: "I like it" }] } } as unknown as PreparedRow;
  eq(secretFields(p), [], "a prepared payload whose digests happen to hold a Luhn run");

  assert(isSecretField({ name: "note", label: "Note", value: CARD }), "a card number is a secret");
  assert(isSecretField({ name: "note", label: "Note", value: "4242424242424242" }), "a card number without spaces is a secret");
  assert(isSecretField({ name: "note", label: "Note", value: `my card is ${CARD} ok` }), "a card number in words is a secret");
  assert(isSecretField({ name: "note", label: "Note", value: `cafe ${CARD.replace(/ /g, "")}` }), "next to a short hex word, still a secret");
  assert(secretKey("note", `deadbeef 4242424242424242`), "a key holding a card number is a secret");
});
