// WO-124b: the XLSX writer and the independent formula evaluator (spec docs/architect/specs/WORK-ARTIFACTS.md, D1, D2).
// The first three tests are the D2 workbook test and the two D9 workbook tests (unknown is never zero; the mature
// baseline) from tests/architect/pending/work-artifacts-xlsx-checks-20261114.test.ts, repeated here unchanged so the
// gate runs them with 124b's code; that acceptance file moves out of pending/ with 124c,
// whose checkers it also imports. The other tests are the 124b review findings (rounds 1-4), moved here from the
// pending review files. Fixtures are invented and fictional.
import { strFromU8, strToU8, unzipSync, zipSync } from "npm:fflate@0.8.2";
import * as xlsx from "../../../supabase/functions/_shared/work/xlsx.ts";
import * as formula from "../../../supabase/functions/_shared/work/formula.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

const rows = [
  { cohort: "P", acquired: 1000, activated: 600, retained: 300, spend: 15000 },
  { cohort: "Q", acquired: 500, activated: 400, retained: 100, spend: 9000 },
  { cohort: "R", acquired: 300, activated: 0, retained: null, spend: 4000 }, // immature: retention unknown, never zero
];

Deno.test("D2: the workbook holds live formulas and the independent evaluator agrees with the model on every cell", () => {
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const bytes = xlsx.writeXlsx(book);
  const parts = unzipSync(bytes);
  const sheet = strFromU8(parts["xl/worksheets/sheet2.xml"] ?? parts["xl/worksheets/sheet1.xml"]);
  assert(/<f>/.test(sheet), "formulas are live <f> cells, not pasted values");
  assert(parts["xl/charts/chart1.xml"], "a chart part exists");
  const check = formula.recomputeAll(bytes, book.expected);
  eq(check.mismatches, [], "independent recompute matches the model on every cell");
  assert(check.cells > 0, "cells were actually compared");
});

Deno.test("D9: unknown is never zero, and an undefined rate is labelled, not an error", () => {
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const v = formula.recomputeAll(xlsx.writeXlsx(book), book.expected).values;
  eq(v["R.retained_per_acquired"], "Pending", "an immature cohort's retention reads Pending");
  const zero = xlsx.cohortWorkbook({ rows: [{ cohort: "Z", acquired: 0, activated: 0, retained: 0, spend: 0 }], mature: () => true });
  const vz = formula.recomputeAll(xlsx.writeXlsx(zero), zero.expected).values;
  eq(vz["Z.activation_rate"], "Undefined (0 acquired)", "a zero denominator is labelled");
  assert(!Object.values(vz).some((x) => /#DIV\/0!|#VALUE!/.test(String(x))), "no formula errors");
});

Deno.test("D9: a mature baseline is weighted totals, not an average of percentages, and excludes the immature cohort", () => {
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const v = formula.recomputeAll(xlsx.writeXlsx(book), book.expected).values;
  const want = (300 + 100) / (1000 + 500);
  assert(Math.abs(Number(v["baseline.retained_per_acquired"]) - want) <= 1e-9, "weighted baseline over mature P and Q only");
});

// Review of #852: the evaluator must recompute, not read the cached values. A formula is rewritten with its cached value
// kept; recomputeAll must report the mismatch.
Deno.test("124b: recomputeAll recomputes each formula from the bytes, so a formula that no longer matches its cached value is a mismatch", () => {
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const parts = unzipSync(xlsx.writeXlsx(book));
  const name = "xl/worksheets/sheet2.xml";
  const xml = strFromU8(parts[name]);
  // activated / acquired becomes acquired / activated inside the formula; the cached <v> is left as it was.
  const tampered = xml.replace("Inputs!C2/Inputs!B2", "Inputs!B2/Inputs!C2");
  assert(tampered !== xml, "the activation-rate formula was rewritten, its cached value kept");
  parts[name] = strToU8(tampered);
  const r = formula.recomputeAll(zipSync(parts), book.expected);
  assert(r.mismatches.length > 0, "the rewritten formula is caught although its cached value was kept");
});

Deno.test("124b review: a control character in a cohort name writes valid XML and reads back exactly", () => {
  const name = "Cohort\u000B A\u0001 _x0041_ & <B>";
  const rows = [
    { cohort: name, acquired: 1000, activated: 600, retained: 300, spend: 15000 },
    { cohort: "Q", acquired: 500, activated: 400, retained: 100, spend: 9000 },
  ];
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const bytes = xlsx.writeXlsx(book);
  const parts = unzipSync(bytes);
  for (const [n, b] of Object.entries(parts)) if (n.endsWith(".xml")) assert(!XML_BAD.test(strFromU8(b)), `${n} has a character XML 1.0 forbids`);
  eq(xlsx.esc("a\u000Bb"), "a_x000B_b", "a control is written as the OOXML escape");
  eq(xlsx.esc("_x0041_"), "_x005F_x0041_", "a literal escape-shaped text is itself escaped");
  const check = formula.recomputeAll(bytes, book.expected);
  eq(check.mismatches, [], "the evaluator still agrees with the model on every cell");
  assert(check.cells > 0, "cells were compared");
  assert(Object.values(check.values as Record<string, unknown>).includes(name), "the name reads back exactly, control characters included");
});

Deno.test("124b re-review: a CR in text survives an XML parser's end-of-line handling; leading spaces are preserved", () => {
  eq(xlsx.esc("a\rb"), "a_x000D_b", "CR is escaped the way Excel writes it");
  const name = "  Padded\r\nCohort ";
  const book = xlsx.cohortWorkbook({ rows: [{ cohort: name, acquired: 10, activated: 5, retained: 2, spend: 100 }], mature: (r) => r.retained !== null });
  const bytes = xlsx.writeXlsx(book);
  const sheets = Object.entries(unzipSync(bytes)).filter(([n]) => n.startsWith("xl/worksheets/")).map(([, b]) => strFromU8(b)).join("");
  assert(!/\r/.test(sheets), "no raw CR in a worksheet");
  assert(/<t xml:space="preserve">/.test(sheets), "inline text keeps its spaces");
  const check = formula.recomputeAll(bytes, book.expected);
  eq(check.mismatches, [], "the evaluator agrees");
  assert(Object.values(check.values as Record<string, unknown>).includes(name), "the name reads back exactly");
});

Deno.test("124b review 3: sheet names, defined names and cohort keys Excel or the checks would break are refused", () => {
  for (const n of ["", "x".repeat(32), "a:b", "a/b", "a?b", "a*b", "a[b]", "History", "'quoted'", "ctl\u0001"]) throws(() => xlsx.checkSheetName(n), `sheet ${JSON.stringify(n)}`);
  xlsx.checkSheetName("Metrics");
  for (const n of ["A1", "1abc", "has space", "R1C1"]) throws(() => xlsx.checkDefinedName(n), `name ${n}`);
  xlsx.checkDefinedName("net_cash");
  const row = (cohort: string) => ({ cohort, acquired: 10, activated: 5, retained: 2, spend: 100 });
  throws(() => xlsx.cohortWorkbook({ rows: [row("P"), row("P")], mature: () => true }), "a repeated cohort");
  throws(() => xlsx.cohortWorkbook({ rows: [row("baseline")], mature: () => true }), "the reserved name");
});

Deno.test("124b review 4: Excel-reserved defined names and over-long cohort names are refused", () => {
  for (const n of ["r", "c", "R", "C", "TRUE", "false"]) throws(() => xlsx.checkDefinedName(n), n);
  throws(() => xlsx.cohortWorkbook({ rows: [{ cohort: "x".repeat(40000), acquired: 1, activated: 1, retained: 1, spend: 1 }], mature: () => true }), "40,000 characters");
});
