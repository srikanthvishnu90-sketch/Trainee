// WO-124d acceptance tests: DOCX, PPTX and PDF built from the typed model (spec WORK-ARTIFACTS.md, D1, D2 and D4).
// Written before the code. Fixtures are invented; there is no provider and no network.
import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const allText = (bytes: Uint8Array) => Object.entries(unzipSync(bytes)).filter(([n]) => /\.xml$|\.rels$/.test(n)).map(([, b]) => strFromU8(b)).join("\n");

const memo = {
  title: "Invented Co offer comparison",
  cells: [{ id: "stipend", value: 17280 }, { id: "bonus", value: 2000 }, { id: "total", formula: "stipend+bonus" }],
  blocks: [
    { kind: "heading", text: "Cash" },
    { kind: "para", text: "Total first-year cash is ${{ref:total}}, from a ${{ref:stipend}} stipend and a ${{ref:bonus}} bonus." },
    { kind: "table", rows: [["Item", "Amount"], ["Stipend", "{{ref:stipend}}"], ["Bonus", "{{ref:bonus}}"], ["Total", "{{ref:total}}"]] },
  ],
  formats: { stipend: "#,##0", bonus: "#,##0", total: "#,##0" },
};

Deno.test("D1: a DOCX memo prints every number from the model; no slot or typed number survives", () => {
  const bytes = docs.writeDocx(memo);
  const t = allText(bytes);
  assert(t.includes("19,280") && t.includes("17,280"), "rendered values present");
  assert(!t.includes("{{ref:"), "no unrendered slot");
  assert(/<dc:title>Invented Co offer comparison<\/dc:title>/.test(t), "core properties carry the title");
  const bad = { ...memo, blocks: [{ kind: "para", text: "Total cash is $19,200." }] };
  let threw = false; try { docs.writeDocx(bad); } catch (e) { threw = (e as Error).name === "LooseNumber"; }
  assert(threw, "a typed number that matches no cell is refused before any bytes are written");
});

Deno.test("D2: a PPTX deck has one notes part per slide and a chart whose cached values are the model's", () => {
  const deck = {
    title: "Invented checkout test",
    cells: [{ id: "a", value: 0.112 }, { id: "b", value: 0.124 }],
    slides: [
      { title: "Result", bullets: ["B converts at {{ref:b|0.0%}} against {{ref:a|0.0%}}."], notes: "Lead with the decision, then the caveat." },
      { title: "Chart", chart: { kind: "bar", series: [{ name: "Conversion", refs: ["a", "b"], labels: ["A", "B"] }] }, notes: "Association, not cause." },
    ],
  };
  const parts = unzipSync(docs.writePptx(deck));
  const names = Object.keys(parts);
  eq(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 2, "two slides");
  eq(names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length, 2, "one notes part per slide");
  const chart = strFromU8(parts[names.find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))!]);
  assert(/<c:v>0\.112<\/c:v>/.test(chart) && /<c:v>0\.124<\/c:v>/.test(chart), "the chart's cached values are the model's cells");
  assert(strFromU8(parts["ppt/slides/slide1.xml"]).includes("12.4%"), "the slide text is rendered from the cell");
});

Deno.test("D2: the PDF page check reports pages and flags text that would be clipped", () => {
  const fits = docs.pages(docs.writePdf({ ...memo, page: { size: "letter", margin: 54 } }));
  eq(fits.count, 1, "the memo fits on one page");
  eq(fits.clipped, [], "nothing clipped");
  const long = { ...memo, blocks: [{ kind: "table", rows: [["A very long column header that cannot wrap ".repeat(6), "x"]] }] };
  const r = docs.pages(docs.writePdf({ ...long, page: { size: "letter", margin: 54 }, wrapTables: false }));
  assert(r.clipped.length > 0, "a cell wider than the page is reported as clipped, not silently cut");
});

Deno.test("D2: counts come from code: words, characters and speaking time at a stated rate", () => {
  const answer = "I found the duplicate rows, removed forty-five, and kept three that were real.";
  eq(docs.counts(answer), { words: 13, chars: answer.length, seconds_at_150wpm: 5.2 }, "counted, not claimed");
});
