// ONE-TIME CODES AND PASSWORDS IN CHAT (architect, 2026-11-06; root-cause report PR-6, offline registry A23). Pure code: the
// chat input's redaction (chat_input.ts -> identity_redact.ts) then career_code_in_chat.ts, as the handler runs them.
//   - a code or password shared in chat is found, and the text that is stored and answered carries no token;
//   - ordinary numbers (a GPA, a pay rate, a count, a year, a zip or error code, a phone number) never trigger it;
//   - the reply is fixed safety text; the redaction note keeps only what was removed (its own "never send" line is the reply's).
// The handler wiring (intent, no model call, no containment, the stored row) is tests/architect/brain-decides-questions-handler.test.ts.
//   deno test -A --no-check tests/architect/code-in-chat.test.ts
import assertNode from "node:assert/strict";
import { CODE_IN_CHAT_INTENT, CODE_IN_CHAT_REPLY, codeInChat, noteForCodeTurn } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { redactionNote } from "../../supabase/functions/_shared/identity_redact.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const turn = (m: string, codePending = false) => {
  const i = chatInput(m, [], 4000, { codePending }) as any;
  return { i, c: codeInChat(i.message, { userContent: i.userContent, removed: i.redacted, codePending }) };
};

export const SHARED: [string, string, "code" | "password"][] = [
  ["Greenhouse sent me code 482913", "482913", "code"],
  ["The Workday portal sent me 739201, can you enter it?", "739201", "code"],
  ["here's my verification code for the portal: K7X9P2", "K7X9P2", "code"],
  ["my workday password is Tr0ub4dor!x", "Tr0ub4dor!x", "password"],
];
export const ORDINARY = ["my GPA is 3.4", "they offered me $24/hour", "I have 2 years of retail experience", "I applied to 1200 jobs last year",
  "my zip code is 60601", "I graduated in 2024 and the portal is Workday", "the error code was 500123", "call me at 555-123-4567",
  "I wrote 5000 lines of code", "I learned to code in 2019", "my recruiter sent me 3 roles", "the job id is 482913 on the portal",
  "How do you handle a portal email verification code?", "The verification code expired", "Do you store my portal password?"];

Deno.test("CIC-1 four codes and passwords shared in chat: found, and the stored and answered text carries no token", () => {
  for (const [m, token, kind] of SHARED) {
    const { c } = turn(m);
    ok(c, `${m}: found`);
    ok(c!.removed.includes(kind), `${m}: ${c!.removed}`);
    ok(!c!.text.includes(token) && !c!.userContent.includes(token), `${m}: redacted: ${c!.text}`);
    ok(/\[(code|password) removed\]/.test(c!.text), c!.text);
  }
  // Split across lines, with a question after it, and a spaced 2FA code.
  for (const m of ["Lever texted me 5521. What now?", "2FA is 48 21 93."]) { const { c } = turn(m); ok(c && !/\d{2}/.test(c.text), `${m}: ${c?.text}`); }
});

Deno.test("CIC-2 ordinary numbers and questions about codes never trigger it", () => {
  for (const m of ORDINARY) eq(turn(m).c, null, m);
});

Deno.test("CIC-3 while an employer's emailed code is waiting, the situation turn answers (WO-100); the code is still removed", () => {
  const { i, c } = turn("Plaid emailed me a code, it's 482913", true);
  eq(c, null);
  ok(!i.message.includes("482913"), i.message);
});

Deno.test("CIC-4 the reply is fixed safety text; the note keeps only what was removed", () => {
  eq(CODE_IN_CHAT_INTENT, "career_code_in_chat");
  ok(/don't share one-time codes or passwords in chat/.test(CODE_IN_CHAT_REPLY));
  ok(/If your Gmail is connected, Trainee reads an employer's emailed code itself, and only during an application you approved/.test(CODE_IN_CHAT_REPLY));
  ok(/type the code into the employer's portal yourself/.test(CODE_IN_CHAT_REPLY));
  const note = noteForCodeTurn(redactionNote(["code"]));
  eq(note, "(I removed the one-time code from your message and didn't keep it. Upmore never needs it here.)");
  eq(noteForCodeTurn(redactionNote(["card"])), redactionNote(["card"]), "a note with nothing to trim is unchanged");
  eq(noteForCodeTurn(null), null);
});
