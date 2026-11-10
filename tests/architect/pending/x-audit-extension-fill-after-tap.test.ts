// x-audit (D-MS-1, coordinator rulings 2026-11-10 02:20 and 02:26): nothing is typed into an employer's page before the
// person's tap, in every family. An employer can save each field as it is typed (Ashby's ApiSetFormValue autosave) and
// the extension has no network guard (no declarativeNetRequest), so the guard is that the shipped extension never writes
// into the page before the tap. D-050: the extension is not a user path; this keeps it safe all the same.
// Static guard:
//   1. the shipped config has prefill: false (fixed in config.js, never read from storage);
//   2. every write into the page in content.js goes through prefillWrite(), and prefillWrite writes nothing unless prefill
//      is exactly true;
//   3. the background hands content.js prefill from the fixed config only.
// Pending until #703's follow-up lands: on trunk content.js:292, :311 (prepare), :438 (prepareWorkday) and :701 (useDraft)
// fill before the tap.
// Run: deno test -A --no-check tests/architect/pending/x-audit-extension-fill-after-tap.test.ts
import assertNode from "node:assert/strict";

const read = (p: string) => Deno.readTextFile(new URL(`../../../extension/${p}`, import.meta.url));
const [content, config, background] = await Promise.all([read("content.js"), read("config.js"), read("background.js")]);
const lineOf = (src: string, i: number) => src.slice(0, i).split("\n").length;
function enclosing(src: string, index: number): string {
  const all = [...src.slice(0, index).matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)];
  return all.length ? all[all.length - 1][1] : "(top level)";
}

Deno.test("the shipped extension types nothing into an employer's page before the person's tap", () => {
  // 1. shipped off, fixed in code
  assertNode.match(config, /\n\s*prefill:\s*false,/, "config.js ships prefill: false");
  assertNode.doesNotMatch(config, /prefill:\s*true/, "and nowhere true");
  // 2. one gate for every write into the page
  const writes = [...content.matchAll(/\bD\.(fill|fillWorkday|setValue|type)\s*\(/g)].map((m) => ({ fn: enclosing(content, m.index!), line: lineOf(content, m.index!) }));
  const outside = writes.filter((w) => w.fn !== "prefillWrite").map((w) => `content.js:${w.line} in ${w.fn}()`);
  assertNode.deepStrictEqual(outside, [], "every write into the page goes through prefillWrite()");
  const gate = /async function prefillWrite\([^)]*\)\s*\{\s*if \(ctx\?\.prefill !== true\) return false;/.exec(content);
  assertNode.ok(gate, "prefillWrite writes nothing unless prefill is exactly true");
  // 3. from the fixed config only
  assertNode.match(background, /prefill: \(await config\(\)\)\.prefill === true/, "the background passes the fixed config's prefill");
  assertNode.doesNotMatch(background, /storage[^\n]*prefill|prefill[^\n]*storage/, "never from storage");
});
