// x-audit (D-MS-1, coordinator ruling 2026-11-10, option (a)): the extension fills an employer's live form only AFTER the
// person's tap, then verifies and submits in the same task. Before the tap the card is built from the plan, so an
// employer that autosaves as fields are typed (Ashby's ApiSetFormValue) receives nothing before the yes. The extension
// has no network guard (no declarativeNetRequest), so the only guard is never typing into the page before the tap.
// Static guard: every call that writes into the page (D.fill, D.fillWorkday) sits in a function reached only from the
// tap (submit, or what it calls); none sits in prepare(), prepareWorkday(), refresh() or the panel's draft path.
// Pending: on trunk content.js:292, :311 (prepare) and :438 (prepareWorkday) fill before the tap.
// Run: deno test -A --no-check tests/architect/pending/x-audit-extension-fill-after-tap.test.ts
import assertNode from "node:assert/strict";

const src = await Deno.readTextFile(new URL("../../../extension/content.js", import.meta.url));
// The function each line belongs to: the nearest `function name(` or `async function name(` above it.
function enclosing(index: number): string {
  const head = src.slice(0, index);
  const all = [...head.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)];
  return all.length ? all[all.length - 1][1] : "(top level)";
}
const PRE_TAP = new Set(["prepare", "prepareWorkday", "refresh", "snapshot", "survey", "useDraft", "signInFirst"]);

Deno.test("no write into the employer's page happens before the person's tap", () => {
  const writes = [...src.matchAll(/\bD\.(fill|fillWorkday|setValue|type)\s*\(/g)].map((m) => ({
    call: m[0], fn: enclosing(m.index!), line: src.slice(0, m.index!).split("\n").length,
  }));
  assertNode.ok(writes.length > 0, "content.js still fills the form somewhere (after the tap)");
  const before = writes.filter((w) => PRE_TAP.has(w.fn)).map((w) => `content.js:${w.line} ${w.call} in ${w.fn}()`);
  assertNode.deepStrictEqual(before, [], `fills before the tap:\n${before.join("\n")}`);
});
