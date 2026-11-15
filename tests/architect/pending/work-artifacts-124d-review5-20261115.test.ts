// WO-124d fifth review (2026-11-15, D-088 structural bar): compatibility symbols holding digits break a date; a slot
// straight after a date is refused. Earlier tests unchanged.
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "a", value: 280 }];
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text }] });

Deno.test("124d review 5: a character whose normal form holds digits never completes a date", () => {
  for (const t of ["2026-11-1㏩", "in 19㏾㏾", "Since May 19㏾5.", "May ㏩, 2026", "at ㍡:㍘㍘ pm"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("Signed on 2026-11-14.");
});

Deno.test("124d review 5: a slot straight after a date is refused", () => {
  for (const t of ["in 2019 {{ref:a}}.", "May 2026 {{ref:a}}"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("We had {{ref:a}} users (up from last year).");
});
