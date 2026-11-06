// A CODE IN A LONG MESSAGE IS STILL REMOVED (architect, 2026-11-06; Greptile P1 on release PR #549, A23). codeInChat returned
// before its own check for any message over 400 characters, while chat accepts 4,000 (MAX_MESSAGE_LEN). identity_redact.ts
// needs a code label, so "The Workday portal sent me 739201, can you enter it?" inside a longer message kept its code and the
// handler stored userContent with it. Redaction (the text answered and the text stored) now covers the whole accepted
// message; only the choice of the fixed safety reply keeps its 400-character limit (a long message is a pasted document or
// a longer ask, and its own turn answers it). The year rule is the same at every length.
//   deno test -A --no-check tests/architect/code-in-chat-long.test.ts
import assertNode from "node:assert/strict";
import { codeInChat } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const turn = (m: string) => {
  const i = chatInput(m, [], 4000, { codePending: false }) as any;
  ok(i.ok !== false, `chat accepts ${m.length} characters`);
  return { i, c: codeInChat(i.message, { userContent: i.userContent, removed: i.redacted, codePending: false }) };
};
const FILLER = "I have been applying to analyst roles all month and keeping notes on every posting, every recruiter and every follow-up. ";
const long = (core: string, n = 4) => `${FILLER.repeat(n)}${core} ${FILLER.repeat(n)}`.trim();

Deno.test("CIL-1 an unlabeled code inside a message over 400 characters is removed from the answered and the stored text", () => {
  for (const [core, token] of [
    ["The Workday portal sent me 739201, can you enter it?", "739201"],
    ["Greenhouse sent me code 482913.", "482913"],
    ["here's my verification code for the portal: K7X9P2.", "K7X9P2"],
  ] as const) {
    for (const n of [4, 14]) {
      const m = long(core, n);
      ok(m.length > 400 && m.length <= 4000, `${m.length} characters`);
      const { i, c } = turn(m);
      // What the handler answers with and stores: codeInChat's text when it returns, else chat_input's (identity_redact.ts
      // already removed a labeled code such as "code 482913").
      const text = c?.text ?? i.message, stored = c?.userContent ?? i.userContent;
      ok(!text.includes(token) && !stored.includes(token), `${core} (${m.length} chars): redacted (${stored.slice(0, 80)}...)`);
      ok(/\[code removed\]/.test(stored), "the removal is marked");
      if (c) eq(c.reply, false, "a long message does not get the fixed safety reply; its own turn answers it");
    }
  }
  // The finding's own wording carries no label, so only codeInChat can remove it: it returns, without the safety reply.
  const { c } = turn(long("The Workday portal sent me 739201, can you enter it?"));
  ok(c && c.removed.includes("code") && c.reply === false, JSON.stringify(c?.removed));
});

Deno.test("CIL-2 a short message still gets the fixed safety reply; long ordinary text and years stay untouched", () => {
  const { c } = turn("The Workday portal sent me 739201, can you enter it?");
  ok(c && c.reply === true && !c.text.includes("739201"), JSON.stringify(c));
  for (const core of ["my verification from 2019 is still on file.", "I graduated in 2024 and the portal is Workday.", "I applied to 1200 jobs last year."]) {
    const { i, c } = turn(long(core));
    eq(c, null, `${core}: nothing to remove in a long message`);
    ok(i.message.includes(core), "the text is kept as typed");
  }
});
