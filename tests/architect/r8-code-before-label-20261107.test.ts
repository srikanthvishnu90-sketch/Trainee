// A CODE TYPED BEFORE ITS LABEL (r8, 2026-11-07; production has it too). "739201 is my verification code", "739 201 is the code
// Workday sent" and "482913 - that's the login code" were stored as typed: career_code_in_chat.ts only looked forward from a code
// word. Rule that never moves: no password or one-time code is stored or sent through chat (CLAUDE.md).
// Each message runs through chatInput then codeInChat, as handler-career.ts runs them. Leaks: no code digit survives in the text or
// in the stored user content. Keeps: ordinary numbers next to the word "code" are untouched.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/r8-code-before-label-20261107.test.ts
import assertNode from "node:assert/strict";
import { codeInChat } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";

function pass(raw: string): { text: string; userContent: string } {
  const input = chatInput(raw, [], 4000);
  if (!input.ok) throw new Error(`chatInput refused: ${input.error}`);
  const c = codeInChat(input.message, { userContent: input.userContent, removed: input.redacted, originalLength: raw.trim().length });
  return c ? { text: c.text, userContent: c.userContent } : { text: input.message, userContent: input.userContent };
}

const LEAKS: [string, string][] = [
  ["739201 is my verification code", "739201"],
  ["739 201 is the code Workday sent", "739 201"],
  ["482913 - that's the login code", "482913"],
  ["482913 – that's the code", "482913"],
  ["739201 is the code", "739201"],
  ["739201 is your one-time code.", "739201"],
  ["739201 was the sign-in code", "739201"],
  ["739201, my 2fa code", "739201"],
  ["551092 is my security code, can you enter it?", "551092"],
  ["310447 is the otp code from Greenhouse", "310447"],
  ["K7X9P2 is my verification code", "K7X9P2"],
  ["739.201 is my login code", "739.201"],
  ["I applied to 1200 jobs. 739201 is the code.", "739201"],
];

const KEEPS = [
  "120000 is my salary",
  "2024 is the year I got my code",
  "415 555 1234 is my number",
  "415 555 1234 is my code",
  "3 is the code review count",
  "12 is the number of codes I wrote",
  "94107 is my zip code",
  "4500 is the error code",
  "1200 is the code count",
  "1200 is a code smell",
  "Room 4521 is the code lab",
  "Job 739201 is the code for the role",
  "My offer was 120000, the code review is tomorrow.",
];

for (const [msg, code] of LEAKS) {
  Deno.test(`r8 code before label: removed: ${JSON.stringify(msg)}`, () => {
    const out = pass(msg);
    const digits = code.replace(/[^\dA-Za-z]/g, "");
    for (const s of [out.text, out.userContent]) {
      assertNode.ok(!s.includes(code), `kept ${code}: ${s}`);
      assertNode.ok(!s.replace(/[^\dA-Za-z]/g, "").includes(digits), `kept the digits of ${code}: ${s}`);
      assertNode.ok(s.includes("[code removed]"), `no marker: ${s}`);
    }
  });
}

for (const msg of KEEPS) {
  Deno.test(`r8 code before label: kept: ${JSON.stringify(msg)}`, () => {
    const out = pass(msg);
    assertNode.equal(out.text, msg);
    assertNode.equal(out.userContent, msg);
  });
}
