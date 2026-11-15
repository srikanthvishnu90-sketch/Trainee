// WO-124d sixth review (2026-11-15, D-088 structural bar): scale and percent after closing punctuation, invisible and
// blank-looking characters, the whole dash class as signs, and a date joined to a slot through quotes or brackets.
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "a", value: 280 }, { id: "g", value: 12 }, { id: "b", value: 5 }];
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text }] });

Deno.test("124d review 6: a scale or percent after closing punctuation is refused", () => {
  for (const t of ["({{ref:g}})%", "[{{ref:a}}]%", "{{ref:a}}.%", "{{ref:a}})k", "{{ref:a}}'k", "{{ref:a}}) bn", "\"{{ref:a}}\"%", "{{ref:a}}?x"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("It was {{ref:a}}, then {{ref:b}}.");
});

Deno.test("124d review 6: invisible or blank-looking characters cannot hide a sign, a scale word or a date join", () => {
  for (const t of ["-️({{ref:a}})", "-️ {{ref:a}}", "-ㅤ {{ref:a}}", "{{ref:a}} ️k", "{{ref:a}} ㅤk", "June 5, 2019️ {{ref:a}}", "May 2019️ {{ref:a}}"]) {
    throwsNamed(() => doc(t), "LooseNumber", JSON.stringify(t));
  }
});

Deno.test("124d review 6: every dash and minus form is a sign; a date joined through a quote or bracket is refused", () => {
  for (const t of ["﹣({{ref:a}})", "⁻({{ref:a}})", "‐ {{ref:a}}", "‑ {{ref:a}}", "June 5, 2019'{{ref:a}}", "May 2019'{{ref:a}}", "2026-11-14'{{ref:a}}", "May 2019 ({{ref:a}})"]) {
    throwsNamed(() => doc(t), "LooseNumber", JSON.stringify(t));
  }
  doc("Cash is ${{ref:a}}.");
});
