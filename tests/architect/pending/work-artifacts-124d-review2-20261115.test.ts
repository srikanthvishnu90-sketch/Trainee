// WO-124d second review (2026-11-15): slot neighbours by allow-list, no "General" format, fraction and multiplier
// words, per-character date masking, E-notation output, degenerate decks and series. Earlier tests are unchanged.
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "a", value: 5 }, { id: "b", value: 280 }, { id: "c", value: 19 }, { id: "p", value: 0.4 }, { id: "big", value: 1e21 }];
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text }] });

Deno.test("124d review 2: a slot's neighbours cannot change the figure it prints", () => {
  for (const t of ["Loss of -{{ref:a}}", "Loss of −{{ref:a}}", "ratio .{{ref:a}}", "O.{{ref:a}}", "{{ref:c}} {{ref:b}} users", "{{ref:c}} {{ref:b}}",
    "{{ref:c}}'{{ref:b}}", "{{ref:a}}.{{ref:b}}", "$ {{ref:a}} bn", "{{ref:a}} k", "{{ref:a}} mn", "{{ref:a}} lakh", "{{ref:a}} x faster",
    "{{ref:a}}‰", "{{ref:a}}٪", "{{ref:a}}％", "{{ref:a}}﹪", "x{{ref:a}}", "l{{ref:a}}"]) throwsNamed(() => doc(t), "LooseNumber", t);
  for (const t of ["Cash is ${{ref:a}}.", "It was {{ref:a}}, then {{ref:b}}.", "({{ref:a}})", "Cash: €{{ref:a}}!"]) doc(t);
});

Deno.test("124d review 2: General is not a format; number words that are fractions or multipliers are refused", () => {
  throwsNamed(() => doc("{{ref:p|General}}"), "LooseNumber", "General in a slot");
  throwsNamed(() => docs.writeDocx({ title: "T", cells, blocks: [{ kind: "para", text: "x {{ref:p}}." }], formats: { p: "General" } }), "BadFormat", "General in formats");
  for (const t of ["a third of users", "a quarter of revenue", "revenue doubled", "tripled", "tenfold", "thousands of rows", "a couple"]) throwsNamed(() => doc(t), "LooseNumber", t);
});

Deno.test("124d review 2: one typographic character does not switch off the date exception", () => {
  doc("In 2026… we grew.");
  doc("Acme™ started on 2026-11-14.");
});

Deno.test("124d review 2: E-notation output, empty decks, empty or mixed-format series are refused", () => {
  throwsNamed(() => doc("Rows: {{ref:big}}."), "RangeError", "1e+21 prints in E-notation");
  throwsNamed(() => docs.writePptx({ title: "D", cells, slides: [] }), "RangeError", "zero slides");
  throwsNamed(() => docs.writePptx({ title: "D", cells, slides: [{ title: "S", chart: { kind: "bar", series: [{ name: "s", refs: [], labels: [] }] } }] }), "RangeError", "a series with no values");
  throwsNamed(() => docs.writePptx({ title: "D", cells, formats: { p: "0%", b: "#,##0" }, slides: [{ title: "S", chart: { kind: "bar", series: [{ name: "s", refs: ["p", "b"], labels: ["x", "y"] }] } }] }), "RangeError", "mixed formats");
  throwsNamed(() => docs.writeDocx({ title: "T", cells, blocks: [{ kind: "image", text: "x" } as unknown as docs.DocBlock] }), "RangeError", "unknown block kind");
});
