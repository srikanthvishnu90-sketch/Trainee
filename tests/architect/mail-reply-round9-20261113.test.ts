// Review of 3361e2908 (PR #820), round 9, 2026-11-13. At $0.
//   1  a carried redaction redacts only its token: it never withholds the mail (withholding stays for true security mail).
//   2  a credential cue is the credential noun phrase itself (verification code, one-time code, login code, your password
//      is/:, PIN, OTP), not the same words in another sense ("the verification of your references", "sign in with your
//      password as usual", "use code below at checkout").
//   3  after a credential cue, "$" before a plain 6-digit run does not make it a price (e4).
//   deno test -A --no-check tests/architect/mail-reply-round9-20261113.test.ts
import assertNode from "node:assert/strict";
import * as S from "../../supabase/functions/_shared/mail_security.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const s: any = S;
const ordinary = (text: string) => s.securityMail({ from: "dana@acme.com", subject: "Update", text });

Deno.test("1-2 words in another sense are no credential cue: the mail is readable, withheld never, its numbers kept", () => {
  for (const text of [
    "The verification of your references is complete. Offer: 145000 base",
    "Verification of your degree came back fine. Start date 2027-01-05, salary 98000.",
    "The verification of employment is done. Your employee ID is 204481.",
    "Sign in with your password as usual. Your application number is 77120934",
    "Log in with your password as before. Candidate number 55120934 is yours.",
    "Sign in with your usual password. Requisition 4482910 is open.",
    "Use code below at checkout. Order 774012 ships Monday.",
    "Use the code below at checkout for 20% off. Order 774012 ships Monday.",
    "Enter this code at checkout. Your order 991203 is confirmed.",
  ]) {
    eq(ordinary(text), false, `not withheld: ${text}`);
    eq(s.redactSecrets(text), text, text);
  }
});

Deno.test("1 a code carried from its cue is redacted, and only that: the mail is not withheld for it", () => {
  for (const [text, code] of [["Your code follows. Order 12 ships today. 662019", "662019"], ["Your login code follows. Order 552019.", "552019"], ["Your one-time code follows. Booking 7731.", "7731"]] as const) {
    ok(!s.redactSecrets(text).includes(code), s.redactSecrets(text));
    eq(ordinary(text), false, text);
  }
});

Deno.test("3 e4: '$' before a plain 6-digit run after a credential cue is still the code (and two variants)", () => {
  for (const [text, code] of [["Your verification code follows. $662019", "662019"], ["Your login code is next. $552019.", "552019"], ["Your one-time code follows. Thanks! $448190", "448190"]] as const) {
    ok(!s.redactSecrets(text).includes(code), `redacted: ${s.redactSecrets(text)}`);
  }
  // A price stays a price.
  eq(s.redactSecrets("Your verification code follows. It costs $12.99 or $1,200. 662019"), "Your verification code follows. It costs $12.99 or $1,200. [removed]");
});
