// A YEAR IS NOT A ONE-TIME CODE (architect, 2026-11-06; side effect of PR #544, A23). After a code word ("verification"),
// career_code_in_chat.ts took a 4-digit year for a code only when it was led by "in", "since" or "of": "my verification
// from 2019", "verification during 2023", "verification in March 2024" lost their year to "[code removed]" and got the
// safety text instead of an answer. A 19xx/20xx number in a year context (a date preposition or a month before it) is a
// year; a real code is still caught, and digits right after "code" with no year context stay removed (over-redaction is
// the safe side). Pure code: chat_input.ts (identity_redact.ts) then codeInChat, as the handler runs them.
//   deno test -A --no-check tests/architect/code-in-chat-years.test.ts
import assertNode from "node:assert/strict";
import { codeInChat } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const turn = (m: string) => {
  const i = chatInput(m, [], 4000, { codePending: false }) as any;
  return { i, c: codeInChat(i.message, { userContent: i.userContent, removed: i.redacted, codePending: false }) };
};

Deno.test("CIY-1 a year after 'verification' (or another code word) in a year context is a year, not a code", () => {
  for (const m of [
    "my verification from 2019 is still on file",
    "verification in 2024",
    "I did my background verification in 2024",
    "my employment verification during 2023 was fine",
    "my identity verification was done back in 2021",
    "the degree verification from 2020 should still count",
    "verification since 2022 has been clean",
    "my verification was completed in March 2024",
    "my OTP app has worked since 2018",
    "I set up 2FA around 2020",
    "my verification until 2025 is valid",
  ]) {
    const { i, c } = turn(m);
    eq(c, null, `${m}: no code here (got ${JSON.stringify(c?.text)})`);
    ok(/\b(?:19|20)\d\d\b/.test(i.message), `${m}: the year is kept in the stored text (${i.message})`);
  }
});

Deno.test("CIY-2 real codes are still caught, and ambiguous digits right after 'code' stay removed", () => {
  for (const [m, token] of [
    ["my verification code is 4821", "4821"],
    ["code: 482193", "482193"],
    ["verification code 2019", "2019"],
    ["the code is 2024", "2024"],
    ["code 2024", "2024"],
    ["Greenhouse sent me verification code 2023, what do I do", "2023"],
    ["the one-time code they texted is 1987", "1987"],
    ["verification code from the portal: 2024", "2024"],
  ] as const) {
    const { c } = turn(m);
    ok(c, `${m}: found`);
    ok(c!.removed.includes("code"), `${m}: ${c!.removed}`);
    ok(!c!.text.includes(token) && !c!.userContent.includes(token), `${m}: redacted (${c!.text})`);
  }
});
