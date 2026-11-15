// WO-124d eighth review (2026-11-15, D-088 structural bar): the date reader sees the printed characters, and only ASCII
// digits complete a date. Earlier tests unchanged.
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells: [{ id: "a", value: 5 }], blocks: [{ kind: "para", text }] });

Deno.test("124d review 8: astral or superscript digits and spacing accents never complete a date", () => {
  for (const t of ["Jan \u{1D7CF}2019", "Since Jan \u{1D7D7}2026.", "Jan 1¸2019", "Jan 1´2019", "Jan 1¯2019", "Jan 1ͺ2019", "in 2⁰¹⁹", "in 20¹9"]) {
    throwsNamed(() => doc(t), "LooseNumber", JSON.stringify(t));
  }
  for (const t of ["In 2026… we grew.", "Signed on 2026-11-14.", "Starts Nov 16, 2026.", "Since 2019, we hired."]) doc(t);
});
