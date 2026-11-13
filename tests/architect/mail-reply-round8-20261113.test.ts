// Review of 186ded15d (PR #820), round 8, 2026-11-13. At $0.
// Only a credential cue carries (one-time, login, sign-in, verification, security, access or 2FA code; password, passcode,
// PIN, OTP; their translations); promo, discount, coupon, order, booking, dress and zip codes never do. While it waits in its
// paragraph, the first credential-shaped token reached is the secret whatever label precedes it (Ref, Order, Booking do not
// save it). Skipped only by format: fewer than 4 digits, a year next to (c)/Inc/a month, a price, a phone, a date or a time.
// After a password cue, a mixed token (letters with digits or symbols, 6 to 64 characters) is credential-shaped.
//   deno test -A --no-check tests/architect/mail-reply-round8-20261113.test.ts
import assertNode from "node:assert/strict";
import * as S from "../../supabase/functions/_shared/mail_security.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const s: any = S;
const withheld = (text: string) => s.securityMail({ from: "noreply@app.example", subject: "Hi", text });

Deno.test("a credential cue's secret is taken whatever its label (c7, e1, e2, e6, two variants each)", () => {
  const cases: [string, string, string][] = [
    ["c7", "Your one-time password. It's Kx7!pQ2z.", "Kx7!pQ2z"],
    ["c7a", "Your temporary password follows. Use Blue#Lake42 to sign in once.", "Blue#Lake42"],
    ["c7b", "Here is your new passcode. Keep it safe. Tr0ub4dor&3", "Tr0ub4dor&3"],
    ["e1", "Your code follows. Ref 448190.", "448190"],
    ["e1a", "Your verification code follows. Ref: 662019", "662019"],
    ["e1b", "Your security code is below. Reference 7 7 1 2 0 4.", "7 7 1 2 0 4"],
    ["e2", "Your login code follows. Order 552019.", "552019"],
    ["e2a", "Your sign-in code follows. Order #330918", "330918"],
    ["e2b", "Your 2FA code is next. Order no. 448-190.", "448-190"],
    ["e6", "Your one-time code follows. Booking 7731.", "7731"],
    ["e6a", "Your PIN follows. Booking 4821", "4821"],
    ["e6b", "Your OTP is below. Booking ref 99120", "99120"],
  ];
  for (const [n, text, secret] of cases) {
    ok(!s.redactSecrets(text).includes(secret), `${n} redacted: ${s.redactSecrets(text)}`);
    eq(withheld(text), true, `${n} withheld`);
  }
});

Deno.test("non-credential codes never carry, and carried cues skip numbers only by format", () => {
  for (const text of [
    "Your promo code follows. Order 552019 ships today.", "Your discount code is below. Booking 7731 confirmed.", "Your coupon code follows. Ref 448190.",
    "The dress code follows. Suite 4412.", "Your zip code is below. 94016 is fine.",
    "Your code follows. Interview on Nov 20 at 3pm. Call 312 555 0199. Save 20%.", "Your code is next. Room 2104 is on floor 3. Thanks. 556677 people visit yearly.",
    "Your booking code follows. 4412987",
  ]) {
    eq(s.redactSecrets(text), text, text);
    eq(s.securityMail({ from: "dana@acme.com", subject: "Onsite", text }), false, text);
  }
  // Format skips: a year by (c)/Inc, a price, a date, a phone; then the code.
  eq(s.redactSecrets("Your login code follows. © 2025 Acme Inc. Total $12.99. Due 11/20/2026. Call 312 555 0199. 552019"),
    "Your login code follows. © 2025 Acme Inc. Total $12.99. Due 11/20/2026. Call 312 555 0199. [removed]");
});
