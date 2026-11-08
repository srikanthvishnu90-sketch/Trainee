// A prepared application's own digests are never read as a card number (fix, 2026-11-08). missing-info-e2e.test.ts step 6
// failed now and then in CI (trunk 1dc46e5d, #592, two fix branches): the Acme card said '"engine_approval" needs you' and
// offered no Apply. Not a timing race: engine_approval is a fresh sha256 on every preparation, it is not bookkeeping, so its
// value went through the card-number check, and about one fresh digest in two hundred holds a Luhn-valid run of 13 to 19
// digits. Like UUIDs (#499, #503), a run of 32 or more hex characters is now taken out before that check.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isSecretField, secretFields, secretKey } from "../../supabase/functions/_shared/telegram_jobs.ts";

// A sha256 that read as a card number before the fix (a Luhn-valid digit run inside it).
const TRIPPED = "b3a6387d6bd868f02a139bc7e323f0d29401464333258df61b701ccd0799a3cf";

Deno.test("a payload's digests are bookkeeping, not secrets: the card shows what will be sent", () => {
  for (const k of ["engine_approval", "schema_hash", "manifest_hash"]) assertEquals(secretKey(k, TRIPPED), false, k);
  assertEquals(secretKey("replay_sources", [{ hash: TRIPPED }]), false);
  assertEquals(secretFields({ payload: { engine_approval: TRIPPED, fields: [{ name: "email", label: "Email", value: "a@b.test" }] }, card_lines: [] } as any), []);
  let flagged = 0;
  for (let i = 0; i < 20000; i++) {
    const h = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
    if (secretKey("engine_approval", h)) flagged++;
  }
  assertEquals(flagged, 0, "no fresh sha256 reads as a secret");
});

Deno.test("real secrets are still never shown or approved", () => {
  assert(isSecretField({ name: "card", label: "Card", value: "4111 1111 1111 1111" }), "a card number");
  assert(isSecretField({ name: "x", label: "Notes", value: "my card is 4111111111111111" }), "a card number in text");
  assert(isSecretField({ name: "ssn", label: "Notes", value: "123-45-6789" }), "an SSN");
  assert(isSecretField({ name: "t", label: "Notes", value: "sk_live_0123456789abcdefABCDEF" }), "a key");
  assert(secretKey("note", "4111111111111111"), "a card number under any key");
});
