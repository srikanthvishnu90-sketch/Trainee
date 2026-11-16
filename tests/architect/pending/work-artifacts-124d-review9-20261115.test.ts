// WO-124d ninth review (2026-11-15), under D-088's structural bar: symbols that carry digits, C1 controls, a Roman
// numeral letter in a month, a modifier-letter minus before a slot, and (ruled by the architect) a strict ISO time
// tail. Earlier tests unchanged. Fixtures are invented.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";
import * as docs from "../../../supabase/functions/_shared/work/docs.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}: ${(e as Error).message}`); }
  throw new Error(`${m}: did not throw`);
}
const cells = [{ id: "a", value: 19280 }];
const doc = (text: string) => docs.writeDocx({ title: "Invented", cells, blocks: [{ kind: "para", text }] });

Deno.test("124d review 9 B1: a symbol whose NFKC form has digits is a figure, beside a slot or alone", () => {
  for (const t of ["{{ref:a}},㏪", "{{ref:a}}.㋋", "Net {{ref:a}};㍘", "Due ㏪ in full", "㋋ revenue"]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("Net {{ref:a}}, then more.");
});

Deno.test("124d review 9 B2: an ISO time tail that is not a real time leaves figures", () => {
  for (const t of ["Sent 2026-11-14T99:99.", "Sent 2026-11-14T10:00+1928.", "Sent 2026-11-14T10:00:00.19280."]) throwsNamed(() => doc(t), "LooseNumber", t);
  doc("Sent 2026-11-14T10:00:00.123Z.");
});

Deno.test("124d review 9: C1 controls are not printed; a Roman numeral letter breaks a month; a modifier minus is a sign", () => {
  const xml = strFromU8(unzipSync(doc("Plain\u0085 words\u009B here."))["word/document.xml"]);
  assert(!/[\u0080-\u009F]/.test(xml), "C1 controls are not printed");
  throwsNamed(() => doc("Ⅿay 2019 was good."), "LooseNumber", "Ⅿay");
  throwsNamed(() => doc("Net: ˗{{ref:a}}"), "LooseNumber", "modifier-letter minus");
});
