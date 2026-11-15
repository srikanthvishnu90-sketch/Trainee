// WO-124d third review (2026-11-15), under D-088's structural bar: invisible characters, number characters that break a
// date, a sign before a slot, cell formats applied, own-key chart refs, and the scale backstop. Earlier tests unchanged.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "a", value: 5 }, { id: "p", value: 0.4, format: "0%" }];
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text }] });

Deno.test("124d review 3: invisible characters inside a number word neither hide it nor reach the file", () => {
  for (const t of ["for​ty percent", "for⁠ty percent", "fo‍rty", "t͏wenty", "f­orty percent"]) throwsNamed(() => doc(t), "LooseNumber", JSON.stringify(t));
  const xml = strFromU8(unzipSync(doc("Plain​ words­ here."))["word/document.xml"]);
  assert(!/[​­]/.test(xml), "invisible characters are not printed");
});

Deno.test("124d review 3: a number character that is not one digit breaks a date instead of joining one", () => {
  for (const t of ["revenue from 19⑳0 to 2050.", "stipend since 19⑳0.", "at ⑳:30", "Dec ⑳⑳, 2026", "2026-1½-14"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("In 2026, we grew.");
});

Deno.test("124d review 3: a sign before a slot is refused even with a space; the scale backstop covers common abbreviations", () => {
  for (const t of ["Net: − {{ref:a}}", "Net: - {{ref:a}}", "₹{{ref:a}} cr", "₹{{ref:a}} L", "${{ref:a}} tn", "${{ref:a}} mil", "${{ref:a}} grand", "{{ref:a}} billions of users", "{{ref:a}} ×"]) {
    throwsNamed(() => doc(t), "LooseNumber", t);
  }
});

Deno.test("124d review 3: a cell's own format is applied in text and charts; only the model's own cells are refs", () => {
  assert(/40%/.test(strFromU8(unzipSync(doc("Conversion was {{ref:p}}."))["word/document.xml"])), "0.4 with format 0% prints 40%");
  const deck = docs.writePptx({ title: "D", cells, slides: [{ title: "S", chart: { kind: "bar", series: [{ name: "c", refs: ["p"], labels: ["x"] }] } }] });
  const chart = Object.entries(unzipSync(deck)).find(([n]) => n.includes("charts/chart"))![1];
  assert(/formatCode>0%</.test(strFromU8(chart)), "the chart uses the cell's format");
  throwsNamed(() => doc("x {{ref:__proto__}} y"), "UnknownRef", "__proto__ is no cell");
  throwsNamed(() => docs.writePptx({ title: "D", cells, slides: [{ title: "S", chart: { kind: "bar", series: [{ name: "c", refs: ["constructor"], labels: ["x"] }] } }] }), "Error", "constructor is no cell");
});
