// WO-124d tenth review (2026-11-15), under D-088's structural bar: the text that is checked is the text that is printed; a removal
// cannot join surrogate halves into a character that hides a number word, a scale word, a percent or a sign. Earlier test files
// unchanged. Fixtures are invented.
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "a", value: 19280 }, { id: "b", value: 280 }];
const bad = ["Margin rose for\uDB40\u0085\uDC01ty percent.", "Margin rose for\uDB40​\uDC01ty percent.", "Revenue {{ref:a}} \uDB40\u0085\uDC01bn this year.",
  "Growth {{ref:b}} \uDB40\u0085\uDC01% this year.", "Net -\uDB40\u0085\uDC01({{ref:a}}) this year.", "Net −\uDB40​\uDC01 {{ref:a}}", "Units {{ref:a}}.\uDB40\u0085\uDC01'{{ref:b}} sold."];

Deno.test("124d review 10: cleanText is idempotent", () => {
  for (const t of [...bad, "plain", "😀 ok"]) eq(docs.cleanText(docs.cleanText(t)), docs.cleanText(t), JSON.stringify(t));
});

Deno.test("124d review 10: a joined surrogate never hides a loose figure in DOCX, PPTX bullets or chart text", () => {
  for (const t of bad) {
    throwsNamed(() => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text: t }] }), "LooseNumber", `docx ${JSON.stringify(t)}`);
    throwsNamed(() => docs.writePptx({ title: "D", cells, slides: [{ title: "S", bullets: [t] }] }), "LooseNumber", `pptx ${JSON.stringify(t)}`);
    throwsNamed(() => docs.writePptx({ title: "D", cells, slides: [{ title: t, chart: { kind: "bar", series: [{ name: "s", refs: ["a"], labels: ["x"] }] } }] }), "LooseNumber", `chart ${JSON.stringify(t)}`);
  }
});
