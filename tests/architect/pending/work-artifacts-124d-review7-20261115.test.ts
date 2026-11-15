// WO-124d seventh review (2026-11-15, D-088 structural bar): a percent or scale glued to a date, a scale token inside
// brackets after a slot, and narrow spaces that could join two slots. Earlier tests unchanged.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "a", value: 19 }, { id: "b", value: 280 }];
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text }] });

Deno.test("124d review 7: a percent, multiplier or scale glued to a date is refused", () => {
  for (const t of ["Launched May 2019%", "May 1, 2019%", "on 2026-11-14%", "over 2024-2026%", "at 9:30%", "May 2019％", "May 2019×", "May 2019‰", "2024-2026 %"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("Signed on 2026-11-14.");
});

Deno.test("124d review 7: a scale token inside brackets or quotes after a slot is refused; a sign look-alike before one too", () => {
  for (const t of ["Revenue {{ref:a}} (bn)", "{{ref:a}} (k)", "{{ref:a}} ($m)", "{{ref:a}} [mn]", "{{ref:a}} 'bn'", "{{ref:a}} (lakh)", "{{ref:a}} (%)", "∓ {{ref:a}}", "➖ {{ref:a}}"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("We had {{ref:a}} users (up from last year).");
});

Deno.test("124d review 7: every space prints as an ordinary space, so a hair space cannot join two slots", () => {
  const xml = strFromU8(unzipSync(doc("{{ref:a}}, {{ref:b}} and {{ref:a}}, {{ref:b}}"))["word/document.xml"]);
  assert(!/[   ]/.test(xml) && /19, 280/.test(xml), "narrow spaces print as U+0020");
});
