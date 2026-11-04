// Owner's Telegram-first list (2026-10-28) #1 and #6: what a person reads after "apply" never mentions an extension or
// the 30-day employer rule, and a search reply never shows a raw fit score or an internal word. The apply modules' reply
// strings (their string and template literals, comments left out) are read here; the search reply's rendering is
// asserted end to end in tests/architect/f05-search-judge*.test.ts.
// Check: deno test -A --no-check tests/edge/reply-copy-owner-list.test.ts
import assertNode from "node:assert/strict";

const ROOT = new URL("../../", import.meta.url);
// String and template literals of a TypeScript source, with line comments and block comments removed first.
function literals(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");
  return [...noComments.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "");
}
const FILES = ["supabase/functions/_shared/career_apply_chat.ts", "supabase/functions/_shared/career_apply_want.ts", "supabase/functions/_shared/career_search_judge.ts"];

Deno.test("apply and search replies: no extension, no 30-day rule, no raw /100 fit score, no 'model judge' wording", () => {
  for (const f of FILES) {
    const lits = literals(Deno.readTextFileSync(new URL(f, ROOT)));
    for (const l of lits) {
      assertNode.ok(!/\bextension\b/i.test(l), `${f}: "${l.slice(0, 140)}"`);
      assertNode.ok(!/\b30 days\b/i.test(l) || !/employer|company|per /i.test(l), `${f}: "${l.slice(0, 140)}"`);
      assertNode.ok(!/\$\{[^}]*score\}\/100/.test(l), `${f}: "${l.slice(0, 140)}"`);
      assertNode.ok(!/model judge is off|judge is not set up/i.test(l), `${f}: "${l.slice(0, 140)}"`);
    }
  }
});
