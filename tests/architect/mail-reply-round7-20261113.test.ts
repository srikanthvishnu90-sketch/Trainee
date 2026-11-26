// Review of ff63f1cb5 (PR #820), round 7, 2026-11-13. At $0.
// A code cue carried through its paragraph does not stop at numbers that are not code-shaped (a year next to Inc, an order
// or ref number, fewer than 4 digits, a price, a phone, a date); it takes the first code-shaped run, in redaction and in
// whole-mail withholding. Ordinary mail after a cue keeps its numbers.
//   deno test -A --no-check tests/architect/mail-reply-round7-20261113.test.ts
import assertNode from "node:assert/strict";
import * as S from "../../supabase/functions/_shared/mail_security.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const s: any = S;

Deno.test("the carry skips numbers that are not codes and takes the code (d5, two more, five variants)", () => {
  const cases: [string, string][] = [
    ["Your one-time code: see below. Thanks! Team Acme. 2024 Acme Inc. 662019", "662019"],
    ["Your code follows. Order 12 ships today. 662019", "662019"],
    ["Your sign-in code follows. Ref 88. 553201", "553201"],
    ["Your verification code is below. Total $12.99 was refunded. 7 7 1 2 0 4", "7 7 1 2 0 4"],
    ["Here is your login code. Call 312 555 0199 with questions. 448-190", "448-190"],
    ["Your one-time code follows. Booking 4412987 is confirmed. 330918", "330918"],
    ["Your code is next. We met on 2026-11-18 at 9:30. 552019", "552019"],
    ["Your security code is below. © 2025 Acme Inc, 1 Main St. 61902837", "61902837"],
  ];
  for (const [text, code] of cases) {
    ok(!s.redactSecrets(text).includes(code), `redacted: ${s.redactSecrets(text)}`);
    // Round 9 (review of 3361e2908): a carried code is redacted only; it no longer withholds the whole mail.
  }
  // The numbers it skipped stay.
  eq(s.redactSecrets("Your code follows. Order 12 ships today. 662019"), "Your code follows. Order 12 ships today. [removed]");
  eq(s.redactSecrets("Your verification code is below. Total $12.99 was refunded. 7 7 1 2 0 4"), "Your verification code is below. Total $12.99 was refunded. [removed]");
});

Deno.test("ordinary mail after a code cue keeps its numbers and is not withheld", () => {
  for (const text of ["Your code follows. Interview on Nov 20 at 3pm. Call 312 555 0199. Save 20%.", "Your code is next. Room 2104 is on floor 3. Thanks. 556677 people visit yearly.",
    "The door code will be texted. See you Tuesday. Call 415-555-0134 or come at 9:30 on 2026-11-18.", "Your booking code follows. 4412987"]) {
    eq(s.redactSecrets(text), text, text);
    eq(s.securityMail({ from: "dana@acme.com", subject: "Onsite", text }), false, text);
  }
});
