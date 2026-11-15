// WO-124a third review (2026-11-15): claims read by subject and tone; non-US number groups; revoke scan reads text,
// not markup, and compares numbers as numbers. Earlier tests are unchanged. Fixtures are invented.
import { zipSync } from "npm:fflate@0.8.2";
import * as model from "../../../supabase/functions/_shared/work/model.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("124a review 3 D8: no assurance passes a failed check, however it is worded", () => {
  const failed = proof.report([{ name: "formulas recomputed independently", ran: true, ok: false }, { name: "tests run in sandbox", ran: true, ok: false }], []);
  const phrases = ["Downstream figures stand.", "Everything adds up.", "The totals reconcile.", "Numbers tie.", "Totals hold.", "Numbers are good.",
    "The formulas are fine.", "I made sure the formulas compute.", "No discrepancies.", "No mismatches.", "Matches the source exactly.", "0 failures",
    "none failed", "No failing tests", "None of the tests failed", "Every test came back fine.", "Suite: 40 of 40", "40/40.", "Looks good.",
    "Everything is in order.", "Nothing wrong.", "nothing is broken", "Zero defects.", "no regressions", "Fully functional.", "Shippable.", "Approved.",
    "Signed off.", "Perfect.", "I guarantee it", "I can confirm the figures", "Tests did not fail."];
  for (const p of phrases) eq(proof.boundClaims(p, failed).ok, false, p);
  for (const p of ["Here is your workbook.", "The recompute failed on two cells, so I have not sent it.", "Tests were not run here."]) eq(proof.boundClaims(p, failed).ok, true, `honest or neutral: ${p}`);
  const green = proof.report([{ name: "formulas recomputed independently", ran: true, ok: true }], []);
  eq(proof.boundClaims("Formulas were recomputed independently and match.", green).ok, true, "an 'and' clause carries its subject");
});

Deno.test("124a review 3 D1: a number grouped any way but US style is listed", () => {
  for (const t of ["Growth was 12,5 percent", "3,5%", "0,4", "1,5x faster", "12,34 users", "17,2800 users", "₹1,23,456 paid", "1.234,56 EUR", "€19,2k", "1,2 million"]) {
    eq(model.loose(t, { a: 12.5, b: 0.035, c: 0.4, d: 123456 }).length > 0, true, t);
  }
  eq(model.loose("a third of users, revenue doubled, tenfold, thousands of rows", {}).length, 4, "fraction and multiplier words");
  eq(model.loose("half", { a: 0.3 }), ["half"], "half is 0.5 exactly");
  eq(model.loose("Total cash is $19,280.", { t: 19280 }), [], "US grouping still reads");
});

Deno.test("124a review 3 D4: markup is not content; numbers match as numbers", async () => {
  const xlsx = zipSync({
    "[Content_Types].xml": enc(`<?xml version="1.0" encoding="UTF-8"?><Types/>`),
    "xl/workbook.xml": enc(`<workbook><sheets><sheet name="Metrics" sheetId="1"/></sheets></workbook>`),
    "xl/styles.xml": enc(`<styleSheet><fonts><font><sz val="12"/></font></fonts><sheetFormatPr baseColWidth="10"/></styleSheet>`),
    "xl/worksheets/sheet1.xml": enc(`<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData><pageMargins left="0.7" top="0.75" header="0.3"/></worksheet>`),
    "docProps/core.xml": enc(`<cp:coreProperties><dcterms:created>2026-11-15T12:00:00Z</dcterms:created></cp:coreProperties>`),
  });
  for (const v of ["100%", "0%", "30%", "70%", "75%", "$1", "$12", "$10", "$0.30"]) eq((await revoke.scan({ "b.xlsx": xlsx }, [v])).length, 0, `a clean file does not hold ${v}`);
  const one = async (t: string, v: string | number) => (await revoke.scan({ "a.txt": enc(t) }, [v])).length;
  for (const [t, v] of [["<v>0.30000000000000004</v>", "30%"], ["<v>0.17499999999999999</v>", "17.5%"], ["<v>1.728E4</v>", 17280], ["<v>4E-1</v>", "40%"],
    ["ratio .4", "40%"], ["٤٠٪", "40%"], ["O’Brien", "O'Brien"], ["cost $5 now", "$5"]] as [string, string | number][]) eq(await one(t, v), 1, `${t} holds ${v}`);
  eq(await one("score 5 of 9", "$5"), 0, "a bare small number is not a revoked $5");
});
