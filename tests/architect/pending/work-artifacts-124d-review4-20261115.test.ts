// WO-124d fourth review (2026-11-15, D-088 structural bar): a sign behind a slot's prefix, the checked text is the
// printed text, conservative PDF widths, one format per chart. Earlier tests unchanged.
import { strFromU8, unzipSync, unzlibSync } from "npm:fflate@0.8.2";
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "net", value: 500 }, { id: "users", value: 19280, format: "#,##0" }, { id: "lift", value: 0.4, format: "0%" }];
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text }] });
function pdfText(pdf: Uint8Array): string {
  const s = new TextDecoder("latin1").decode(pdf);
  let out = s.replace(/stream\n[^]*?endstream/g, " ");
  for (const m of s.matchAll(/stream\n/g)) {
    const st = m.index! + 7, en = s.indexOf("endstream", st);
    try { out += new TextDecoder("latin1").decode(unzlibSync(pdf.subarray(st, s[en - 1] === "\n" ? en - 1 : en))); } catch { /* not Flate */ }
  }
  return out;
}

Deno.test("124d review 4: a sign is refused anywhere in the prefix run before a slot", () => {
  for (const t of ["Net: -({{ref:net}})", "Net: - ${{ref:net}}", "Net: − $ {{ref:net}}", "-'{{ref:net}}'", "Net: －{{ref:net}}", "Net: ‒ {{ref:net}}", "Net: minus {{ref:net}}"]) {
    throwsNamed(() => doc(t), "LooseNumber", t);
  }
  doc("Net is ${{ref:net}}.");
  doc("({{ref:net}})");
});

Deno.test("124d review 4: the text checked is the text printed", () => {
  const xml = strFromU8(unzipSync(doc("Net {{ref:net​}} now"))["word/document.xml"]);
  assert(!/\{\{/.test(xml) && /500/.test(xml), "an invisible character inside a slot is removed before render, not printed as a literal");
  const pdf = docs.writePdf({ title: "Ti­tle", cells, blocks: [{ kind: "para", text: "Net cash: ­{{ref:net}}" }] });
  assert(!/\xAD/.test(pdfText(pdf)), "no soft hyphen reaches the PDF, where Helvetica would draw it as a minus");
});

Deno.test("124d review 4: PDF widths are never below the real glyph widths, so clipping is reported", () => {
  const p = docs.pages(docs.writePdf({ title: "T", cells, wrapTables: false, blocks: [{ kind: "table", rows: [["A", "B"], ["æ".repeat(43), "™".repeat(33)]] }] }));
  assert(p.clipped.length >= 2, `both over-wide cells are reported: ${JSON.stringify(p.clipped)}`);
});

Deno.test("124d review 4: a chart's series share one number format", () => {
  throwsNamed(() => docs.writePptx({ title: "D", cells, slides: [{ title: "S", chart: { kind: "bar", series: [{ name: "Lift", refs: ["lift"], labels: ["a"] }, { name: "Users", refs: ["users"], labels: ["a"] }] } }] }), "RangeError", "0% and #,##0 on one axis");
});
