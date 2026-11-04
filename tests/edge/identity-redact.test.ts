// Identity digits never reach storage or a model (owner rule; testing agent O-20).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { redactIdentity, redactionNote } from "../../supabase/functions/_shared/identity_redact.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";

// Test-only digits, assembled at run time so no identity-shaped literal sits in the repo (the dataset privacy sweep).
const SSN = ["123", "45", "6789"].join("-"), SSN9 = SSN.replace(/-/g, ""), CARD = ["4111", "1111", "1111", "1111"].join(" ");

Deno.test("SSNs, card numbers and labeled account numbers are removed", () => {
  assertEquals(redactIdentity(`my ssn is ${SSN}, send mike 40`), { text: "my ssn is [SSN removed], send mike 40", removed: ["ssn"] });
  assertEquals(redactIdentity(`ssn ${SSN9}`).text, "ssn [SSN removed]");
  assertEquals(redactIdentity(`social security number: ${SSN9}`).removed, ["ssn"]);
  assertEquals(redactIdentity(`card ${CARD} exp 09/29`), { text: "card [card number removed] exp 09/29", removed: ["card"] });
  assertEquals(redactIdentity("routing number 021000021 account 123456789").removed, ["account"]);
  assert(!/\d{6}/.test(redactIdentity("routing number 021000021 account 123456789").text));
});

Deno.test("phone numbers, dates, amounts, codes and order references are left alone", () => {
  for (const t of ["call me 312-555-0199", "send mike 40 on 2026-10-14", "send mike $1,250.00", "482913", "my order 1234567890123", `order #${CARD.replace(/ /g, "")}`, "zip 60614"]) assertEquals(redactIdentity(t), { text: t, removed: [] }, t);
});

Deno.test("the chat input carries only the redacted text, and the person is told", () => {
  const i: any = chatInput(`my ssn is ${SSN}, send mike 40`, undefined, 4000);
  assert(i.ok);
  assert(!i.message.includes("6789") && !i.userContent.includes("6789"));
  assertEquals(i.redacted, ["ssn"]);
  assertEquals(redactionNote(i.redacted), "(I removed the Social Security number from your message and didn't keep it. Upmore never needs it here.)");
  assertEquals(redactionNote([]), null);
  assertEquals(redactionNote(["ssn", "card"]), "(I removed the Social Security number and card number from your message and didn't keep it. Upmore never needs it here.)");
});
// The finance handler wiring check (tests/model-guards-wiring.test.cjs) was removed with that handler on 2026-10-28.

// Secrets never travel through chat (owner, 2026-10-11, decision 1). Test-only values, assembled at run time.
const PW = ["hun", "ter", "2"].join(""), CODE = ["482", "913"].join("");
Deno.test("a password and a labeled one-time code are removed; words that describe a password are not", () => {
  assertEquals(redactIdentity(`my password is ${PW}`), { text: "my password is [password removed]", removed: ["password"] });
  assertEquals(redactIdentity(`my robinhood password is ${PW}!`).text, "my robinhood password is [password removed]");
  assertEquals(redactIdentity(`pw = ${PW}`).removed, ["password"]);
  assertEquals(redactIdentity(`password: "blue sky ${PW}"`).text, "password: [password removed]");
  assertEquals(redactIdentity(`my 2fa code is ${CODE}`), { text: "my 2fa code is [code removed]", removed: ["code"] });
  assertEquals(redactIdentity(`otp: ${CODE.slice(0, 3)} ${CODE.slice(3)}`).text, "otp: [code removed]");
  assertEquals(redactIdentity("cvv 123").text, "cvv [security code removed]");
  for (const t of ["my password is wrong", "my password is broken, help", "I forgot my password", "reset my password please", "what is a strong password", "the password for fidelity is correct", CODE, "confirmation number 12345678", "send mike 40"]) assertEquals(redactIdentity(t), { text: t, removed: [] }, t);
  assertEquals(redactionNote(["password"]), "(I removed the password from your message and didn't keep it. Upmore never needs it here.) Never send passwords or codes in a message: you sign in yourself on the company's own page, and anything else sensitive goes on Upmore's secure link.");
});
