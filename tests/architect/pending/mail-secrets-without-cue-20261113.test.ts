// Pending (fails until fixed): secrets in mail that mail_security.ts does not yet keep from the model, because nothing marks
// them (no code cue in their sentence, no secret shape, no link). From the reviews of PR #814 and #820. Not an allowed list:
// every one must stop leaking. Run explicitly: deno test -A --no-check tests/architect/pending/mail-secrets-without-cue-20261113.test.ts
import assertNode from "node:assert/strict";
import * as S from "../../../supabase/functions/_shared/mail_security.ts";
import { SECRET_MAIL } from "../helpers/mail_security_tables.ts";
import { SECRET_109 } from "../helpers/mail_round3_tables.ts";
import { PENDING_109, PENDING_59, PENDING_TEXTS } from "../helpers/mail_pending_leaks.ts";

const s: any = S;
const seen = (from: string, subject: string, text: string) => {
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 200);
  if (s.securityMail({ from, subject, text: `${snippet}\n${text}` })) return "";
  return [subject, snippet, text].map((x) => s.redactSecrets(x)).join("\n");
};
Deno.test("PENDING no secret without a cue reaches the model: the round-2 table's three", () => {
  const leaks = (SECRET_MAIL as any[]).filter((m) => PENDING_59.includes(m.n)).filter((m) => (m.secrets ?? []).some((x: string) => seen(m.from, m.subject, m.text ?? m.snippet ?? "").includes(x))).map((m) => m.n);
  assertNode.deepStrictEqual(leaks, []);
});
Deno.test("PENDING no secret without a cue reaches the model: the round-3 table's sixteen", () => {
  const leaks = SECRET_109.filter((c) => PENDING_109.includes(c[0])).filter(([, from, subject, text, pieces]) => pieces.every((p) => seen(from, subject, text).normalize("NFKC").includes(p.normalize("NFKC")))).map((c) => c[0]);
  assertNode.deepStrictEqual(leaks, []);
});
Deno.test("PENDING no secret without a cue reaches the model: restored inputs and the round-4 corpus", () => {
  const leaks = PENDING_TEXTS.flatMap(([text, secrets]) => secrets.filter((x) => s.redactSecrets(text).includes(x)).map((x) => `${x} in ${JSON.stringify(text)}`));
  assertNode.deepStrictEqual(leaks, []);
});
