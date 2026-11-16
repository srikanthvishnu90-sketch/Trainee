// WO-124d eleventh review (2026-11-15, FIT; non-blocking item taken): after a date, the same scale words as after a slot.
// Earlier test files unchanged. Fixtures are invented.
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells: [{ id: "a", value: 5 }], blocks: [{ kind: "para", text }] });

Deno.test("124d review 11: a scale word straight after a date makes a figure of it", () => {
  for (const t of ["May 1, 2019 crore", "Jan 5, 2026 lakh in sales", "2026-11-14 cr", "at 9:30 grand", "at 9:30pm crores"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("On May 1, 2019 we started.");
});
