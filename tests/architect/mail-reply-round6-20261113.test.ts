// Review of e1f9e31d6 (PR #820), round 6, 2026-11-13. At $0.
//   1  a code cue with no value of its own carries forward through its paragraph (up to four sentences, never past a blank
//      line) to the first sentence with a number: that number is the code, in redaction and in whole-mail withholding.
//   2  "code" after booking, order, tracking, reservation and the other non-credential words is not a code, in withholding as
//      in redaction (one shared list).
//   deno test -A --no-check tests/architect/mail-reply-round6-20261113.test.ts
import assertNode from "node:assert/strict";
import * as S from "../../supabase/functions/_shared/mail_security.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const s: any = S;
const withheld = (text: string) => s.securityMail({ from: "noreply@app.example", subject: "Hi", text });

Deno.test("1 the code after its cue, several sentences on in the same paragraph (c3, c10 and variants)", () => {
  const cases: [string, string, string][] = [
    ["c3", "Your login code is next. Please copy it now. Do not share. 552019", "552019"],
    ["c3a", "Your verification code is below. Keep it private. Thanks! 663102", "663102"],
    ["c3b", "Here is your sign-in code. Please copy it. It expires soon. Do not share it. 7 1 9 2 0 4", "7 1 9 2 0 4"],
    ["c3c", "Your one-time code is next. Copy it now. Thanks.\n551987", "551987"],
    ["c10", "Here's the code you asked for. Enjoy! Have a great day. 448190", "448190"],
    ["c10a", "Here is the PIN you asked for. Have fun! 7731", "7731"],
    ["c10b", "Here's the code. Enjoy your day! 4 4 8 1 9 0", "4 4 8 1 9 0"],
    ["c10c", "This is the code you need. Good luck with the test! See you soon. 448-190", "448-190"],
  ];
  for (const [n, text, code] of cases) {
    ok(!s.redactSecrets(text).includes(code), `${n} redacted: ${s.redactSecrets(text)}`);
    eq(withheld(text), true, `${n} withheld`);
  }
  // The carry stops at a blank line, and what it reaches keeps the ordinary-mail exemptions (phone, time, date).
  eq(s.redactSecrets("Your code is next.\n\nInvoice 55120 is attached."), "Your code is next.\n\nInvoice 55120 is attached.");
  eq(s.redactSecrets("The door code will be texted. See you Tuesday. Call 415-555-0134 or come at 9:30 on 2026-11-18."), "The door code will be texted. See you Tuesday. Call 415-555-0134 or come at 9:30 on 2026-11-18.");
  // A sentence with a number of its own ends the carry: the later number is not taken.
  eq(s.redactSecrets("Your code is next. Room 2104 is on floor 3. Thanks. 556677 people visit yearly."), "Your code is next. Room 2104 is on floor 3. Thanks. 556677 people visit yearly.");
});

Deno.test("2 a booking, order, reservation or tracking code is not a credential (f14 and variants): kept and not withheld", () => {
  for (const [n, text, code] of [
    ["f14", "Your booking code follows. 4412987", "4412987"],
    ["f14a", "Your order code follows. 99812733", "99812733"],
    ["f14b", "Your reservation code is below. Have a nice stay! 4412987", "4412987"],
    ["f14c", "Your tracking code follows. 94001118992", "94001118992"],
  ] as const) {
    eq(withheld(text), false, `${n} not withheld`);
    ok(s.redactSecrets(text).includes(code), `${n} kept: ${s.redactSecrets(text)}`);
  }
});
