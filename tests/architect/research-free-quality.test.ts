// R9 free sources, the harness (split 4/4 of #615 on 2026-11-09): the $0 File quality rubric (evals/career/research-free/quality.ts)
// fails on each defect it names. The test body is #615's, unchanged.
import assertNode from "node:assert/strict";
import { browserChecks, dataChecks } from "../../evals/career/research-free/quality.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// ---------------------------------------------------------------- the quality rubric catches what it claims to
Deno.test("quality rubric (evals/career/research-free/quality.ts): each line fails on the defect it names", () => {
  const good = { scrollW: 390, innerW: 390, texts: [{ el: "span.rb-t", color: [20, 20, 20], ground: [255, 255, 255], link: false, size: 18, fact: true }], over: [], grounds: [], fills: [], taps: [{ el: "a", h: 44 }], heads: ["Summary", "What would have to be true", "Risks", "Sources"], empty: [], emptyLi: 0 };
  eq(browserChecks(good, 390), { r2: [], r3: [], r4: [], r5: [] });
  const bad = { ...good, scrollW: 420, texts: [{ el: "p.x", color: [0x5c, 0x27, 0x51], ground: [255, 255, 255], link: false, size: 12, fact: false }, { el: "span.rb-t", color: [150, 150, 150], ground: [255, 255, 255], link: false, size: 15, fact: true }],
    grounds: [{ el: "div.wash", c: [0x5c, 0x27, 0x51], mark: false }], taps: [{ el: "a", h: 30 }], heads: ["Risks", "Summary", "Sources"], empty: ["Risks"] };
  const c = browserChecks(bad, 390);
  ok(c.r2.length === 2 && c.r3.some((x) => /out of order/.test(x)) && c.r3.some((x) => /missing section: What would have to be true/.test(x)));
  ok(c.r4.some((x) => /sideways/.test(x)) && c.r4.some((x) => /empty section/.test(x)));
  ok(c.r5.some((x) => /fact text 15px/.test(x)) && c.r5.some((x) => /text 12px/.test(x)) && c.r5.some((x) => /under AA/.test(x)) && c.r5.some((x) => /tap target 30px/.test(x)));
  const d = dataChecks({ title: "Pay in 2026", thesis: "Pay is $90,000.", summary: [{ text: "a", cite: [] }], conditions: [{ text: "b", cite: [3] }], risks: [], sources: [{ url: "https://a.example/" }] }, { "https://a.example/": "pay in 2026 was 85,000" });
  ok(d.r1.some((x) => /summary\[0\]/.test(x)) && d.r1.some((x) => /conditions\[0\]/.test(x)) && d.r1.some((x) => /90,000/.test(x)) && !d.r1.some((x) => /2026/.test(x)));
});

