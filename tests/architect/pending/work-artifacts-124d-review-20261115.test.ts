// WO-124d adversarial review (2026-11-15): one test per blocking finding (B1-B7) and the guards for N3 and N7.
// The acceptance tests in work-artifacts-docs-20261114.test.ts are unchanged. Fixtures are invented.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "total", value: 19280 }, { id: "five", value: 5 }, { id: "zero", value: 0 }, { id: "lift", value: 0.4 }];
const memo = (text: string, extra: Record<string, unknown> = {}) => ({ title: "Invented memo", cells, blocks: [{ kind: "para" as const, text }], ...extra });
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

Deno.test("124d review B1: a {{...}} that is not a ref slot is refused", () => {
  for (const t of ["Total cash is {{19,200}}.", "{{ 30% }} higher", "vs {{$19,200}}", "a {{ref:total|0\"0\"}} figure", "half {{ref:total"]) {
    throwsNamed(() => docs.writeDocx(memo(t)), "LooseNumber", t);
  }
  docs.writeDocx(memo("Total cash is ${{ref:total}}.", { formats: { total: "#,##0" } }));
});

Deno.test("124d review B2: no typed number in any form reaches a document", () => {
  const bad = ["USD19,200", "Rs19200", "x30", ".5%", "a bonus of 2000", "the bonus rises to 2000 dollars", "by 2000 users", "cost-2000",
    "About 45 may leave the cohort.", "a student ratio of 1:25", "9999-99-99", "Offer\n45. percent of stipend", "٢٠٠٠", "१९२००",
    "a dozen", "half the team", "twice the pay", "Ⅻ", "½ of it", "H-1B", "Q3", "COVID-19", "call 555 0100"];
  for (const t of bad) {
    throwsNamed(() => docs.writeDocx(memo(t)), "LooseNumber", `docx: ${t}`);
    throwsNamed(() => docs.writePptx({ title: "Invented", cells, slides: [{ title: "S", bullets: [t] }] }), "LooseNumber", `pptx: ${t}`);
  }
  for (const t of ["Signed on 2026-11-14.", "Starts Nov 16, 2026.", "Since 2019, we hired."]) docs.writeDocx(memo(t));
});

Deno.test("124d review B3: a slot may not be glued into a figure that is no cell", () => {
  for (const t of ["{{ref:five}}{{ref:zero}}", "${{ref:total}}k", "{{ref:five}}.{{ref:zero}}x", "{{ref:total}}0", "1{{ref:five}}", "{{ref:lift}}%", "{{ref:five}} million"]) {
    throwsNamed(() => docs.writeDocx(memo(t)), "LooseNumber", t);
  }
  docs.writeDocx(memo("Latency fell {{ref:lift}}.", { formats: { lift: "0%" } }));
});

Deno.test("124d review B4: only the formats formatValue prints reach a chart", () => {
  const deck = (fmt: string) => ({ title: "Invented", cells, formats: { lift: fmt }, slides: [{ title: "S", chart: { kind: "bar" as const, series: [{ name: "Lift", refs: ["lift"], labels: ["A"] }] } }] });
  for (const f of ['"Up 30% vs 2025: "0.0%', '0"0"', "#,##0;[Red]-#,##0", "0.000000%"]) throwsNamed(() => docs.writePptx(deck(f)), "BadFormat", f);
  docs.writePptx(deck("0.0%"));
});

Deno.test("124d review B5: characters XML forbids never reach a part", () => {
  const ugly = "Pasted\u000Bline\u0001 and￾\u0007 end";
  const bytes = [docs.writeDocx({ title: `T\u0002`, cells, blocks: [{ kind: "para", text: ugly }] }),
    docs.writePptx({ title: "D\u0002", cells, slides: [{ title: "S", bullets: [ugly], notes: "note\u0007" }] })];
  for (const b of bytes) for (const [n, part] of Object.entries(unzipSync(b))) {
    if (/\.xml$|\.rels$/.test(n)) assert(!XML_BAD.test(strFromU8(part)), `${n} has a character XML 1.0 forbids`);
  }
});

Deno.test("124d review B6: a margin that pushes text off the page is refused; pages() checks the page edges", () => {
  for (const margin of [-200, 0, 10, 300, NaN]) throwsNamed(() => docs.writePdf(memo("Plain words.", { page: { margin } })), "RangeError", `margin ${margin}`);
  eq(docs.pages(docs.writePdf(memo("Plain words.", { page: { margin: 54 } }))).clipped, [], "a normal page fits");
});

Deno.test("124d review B7: a value printed in the PDF is found by the revoke scan", async () => {
  const pdf = docs.writePdf(memo("Total is ${{ref:total}}.", { formats: { total: "#,##0" } }));
  eq((await revoke.scan({ "memo.pdf": pdf }, [19280])).length, 1, "the PDF's printed figure is found");
});

Deno.test("124d review N3 and N7: degenerate charts and empty tables are refused, not written", () => {
  throwsNamed(() => docs.writeDocx({ title: "T", cells, blocks: [{ kind: "table", rows: [] }] }), "RangeError", "empty table");
  const chart = (series: { name: string; refs: string[]; labels: string[] }[]) => ({ title: "D", cells, slides: [{ title: "S", chart: { kind: "bar" as const, series } }] });
  throwsNamed(() => docs.writePptx(chart([])), "RangeError", "no series");
  throwsNamed(() => docs.writePptx(chart([{ name: "a", refs: ["five"], labels: ["x", "y"] }])), "RangeError", "labels past the values");
  throwsNamed(() => docs.writePptx(chart(Array.from({ length: 25 }, (_, i) => ({ name: `s${String.fromCharCode(97 + i)}`, refs: ["five"], labels: ["x"] })))), "RangeError", "25 series");
});
