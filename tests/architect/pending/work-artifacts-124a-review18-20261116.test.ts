// WO-124a eighteenth review (2026-11-16).
//  B1: sourceText read only primitive strings and numbers; a BigInt or a Number/String wrapper (all survive
//      structuredClone) read as empty to the source check, while a writer printed it through template text. xlsx.ts
//      writes sheet widths into <col width="...">, a STRUCTURAL attribute the byte scan skips, so a revoked value in a
//      width was written and delivered. Now any leaf that is not a string, number, boolean, null or undefined, and any
//      object that is not an array or a plain object, is "model is not plain data".
// Fixtures are invented.
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as prov from "../../../supabase/functions/_shared/work/provenance.ts";
import { deliver } from "../../../supabase/functions/_shared/work/deliver.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function revokedCase(v: string) {
  const c = kase.newCase({ owner: "u1", practice: false, title: "t", now: 1 });
  kase.addRound(c, { round: 1, text: "r1", constraints: [{ id: "k1", kind: "hard", text: "value", values: [v] }] });
  kase.addRound(c, { round: 2, text: "r2", constraints: [{ id: "k2", kind: "hard", text: "no", revokes: "k1" }] });
  return c;
}
const model = (widths: unknown[]) => ({ sheets: [{ name: "M", cells: { A1: { v: "clean" } }, widths }], charts: [], expected: {} });

Deno.test("124a review 18 B1: a revoked value hidden in a non-plain leaf is refused, never written or delivered", async () => {
  const cases: [string, string, unknown][] = [
    ["BigInt", "85000", 85000n],
    ["Number wrapper", "85000", new Number(85000)],
    ["String wrapper", "Jordan Pike", new String("Jordan Pike")],
    ["Date", "2026", new Date(Date.UTC(2026, 0, 1))],
  ];
  for (const [label, revoked, leaf] of cases) {
    const c = revokedCase(revoked);
    const r = await prov.write(c, prov.WRITERS.xlsx, model([leaf]) as never);
    eq([r.ok, (r as { why?: string }).why], [false, "model is not plain data"], `${label}: refused at write`);
  }
});

Deno.test("124a review 18 B1 controls: plain revoked values are still refused at the source, clean plain models still deliver", async () => {
  const c = revokedCase("85000");
  const r = await prov.write(c, prov.WRITERS.xlsx, model([85000]) as never);
  eq([r.ok, (r as { why?: string }).why], [false, "source holds a revoked value"], "plain number refused at source");
  const clean = revokedCase("85000");
  const ok = await prov.write(clean, prov.WRITERS.xlsx, { ...model([12]), flag: true, none: null } as never);
  eq(ok.ok, true, "a clean model with booleans and null is written");
  let sent = 0;
  const io = { sendFile: () => (sent++, Promise.resolve({ ok: true })), sendText: () => Promise.resolve({ ok: true }) };
  const d = await deliver("whatsapp", (ok as { files: unknown[] }).files[0] as never, io as never, clean);
  eq([d.ok, sent], [true, 1], "and delivered once");
});
