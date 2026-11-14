// Review of 11cd87b8c (PR #820), round 10, 2026-11-13. At $0.
//   1  a number taken under a credential cue does not end the carry, in any language: every credential-shaped run in the
//      paragraph window is redacted (k3 "Commande 4471. 772019").
//   2  a negated or non-giving statement about a password ("doesn't change", "no cambia", "ne change pas", "as usual",
//      "never share") is no credential cue: the numbers after it stay (m8 "sala 4410").
//   deno test -A --no-check tests/architect/mail-reply-round10-20261113.test.ts
import assertNode from "node:assert/strict";
import * as S from "../../supabase/functions/_shared/mail_security.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const s: any = S;

Deno.test("1 k3 and variants: the code after a labelled number is still taken", () => {
  for (const [text, code] of [
    ["Votre code de vérification suit. Commande 4471. 772019", "772019"],
    ["Tu código de verificación sigue. Pedido 5512. 330918", "330918"],
    ["Ihr Bestätigungscode folgt. Bestellung 8801. 448190", "448190"],
  ] as const) ok(!s.redactSecrets(text).includes(code), `redacted: ${s.redactSecrets(text)}`);
});

Deno.test("2 m8 and variants: a password statement that gives nothing is no cue; the room number stays", () => {
  for (const text of [
    "Tu contraseña no cambia. Nos vemos en la sala 4410.",
    "Votre mot de passe ne change pas. Rendez-vous en salle 4410.",
    "Your password doesn't change. See you in room 4410.",
    "Never share your password with anyone. The interview is in room 4410.",
    "Sign in as usual with your password. Meet us in suite 4410.",
  ]) {
    eq(s.redactSecrets(text), text, text);
    eq(s.securityMail({ from: "dana@acme.com", subject: "Onsite", text }), false, text);
  }
  // A password that is given is still taken.
  ok(!s.redactSecrets("Your new password follows. Kx7!pQ2z").includes("Kx7!pQ2z"));
});
