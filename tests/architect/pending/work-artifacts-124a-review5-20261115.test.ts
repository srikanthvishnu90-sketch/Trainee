// WO-124a fifth review (2026-11-15, D-088 structural bar): markup-looking text, PDF string encodings, unreadable
// containers, revokes with no values, whole-work claims after "and", and case ids. Earlier tests unchanged.
import { zipSync } from "npm:fflate@0.8.2";
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}`); }
  throw new Error(`${m}: did not throw`);
}
const enc = (s: string) => new TextEncoder().encode(s);
const hits = async (files: Record<string, Uint8Array>, v: string | number) => (await revoke.scan(files, [v])).length;

Deno.test("124a review 5 D4: text between < and > in code, HTML, CDATA and comments is read", async () => {
  eq(await hits({ "a.py": enc("if a<b and total == 17280 or c>3:") }, 17280), 1, "python comparison");
  eq(await hits({ "p.html": enc("<script>for(i=0;i<n;i++){fee=17280}</script>") }, 17280), 1, "offline HTML script");
  eq(await hits({ "word/document.xml": enc("<w:t><![CDATA[Fee 17280]]></w:t>") }, 17280), 1, "CDATA");
  eq(await hits({ "x.xml": enc("<!-- fee 17280 -->") }, 17280), 1, "an XML comment");
  eq(await hits({ "customXml/item1.xml": enc("<root><Notes>fee 17280</Notes></root>") }, 17280), 1, "a Notes element outside app.xml");
});

Deno.test("124a review 5 D4: PDF octal, hex and UTF-16 strings are decoded", async () => {
  eq(await hits({ "m.pdf": enc("%PDF-1.4\n(Caf\\351 Ltd) Tj") }, "Café Ltd"), 1, "octal escape (Trainee's own writer)");
  eq(await hits({ "m.pdf": enc("%PDF-1.4\n(\\061\\067280) Tj") }, 17280), 1, "octal digits");
  eq(await hits({ "m.pdf": enc("%PDF-1.4\n<466565203137323830> Tj") }, 17280), 1, "hex string");
  eq(await hits({ "m.pdf": enc("%PDF-1.4\n<< /Title <FEFF00310037003200380030> >>") }, 17280), 1, "UTF-16 hex title");
});

Deno.test("124a review 5 D4: a container the scan cannot open is a hit, never a clean part", async () => {
  let f: Record<string, Uint8Array> = { "a.txt": enc("fee 17280") };
  for (let i = 0; i < 8; i++) f = { [`l${i}.zip`]: zipSync(f) };
  eq(await hits(f, 17280), 1, "nested past the depth limit");
  const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const r = await revoke.scan({ "bad.zip": broken }, [17280]);
  eq(r.map((h) => h.category), ["unreadable container"], "a corrupt zip");
});

Deno.test("124a review 5 D4: a revoke must name what it takes back; case ids are unique", () => {
  const c = kase.newCase({ owner: "SYN", practice: true, title: "t", now: 1 });
  kase.addRound(c, { round: 1, text: "", constraints: [{ id: "a", kind: "hard", text: "fee 30%" }] });
  throwsNamed(() => kase.addRound(c, { round: 2, text: "", constraints: [{ id: "b", kind: "permission", text: "revoke", revokes: "a" }] }), "LedgerError", "a revoke with no values");
  const a = kase.newCase({ owner: "SYN", practice: true, title: "cohorts", now: 5 }), b = kase.newCase({ owner: "SYN", practice: true, title: "cohorts", now: 5 });
  eq(a.id === b.id, false, "same turn, same title: different ids");
});

Deno.test("124a review 5 D8: a whole-work claim after 'and' does not borrow the previous clause's subject", () => {
  const rep = proof.report([{ name: "pages rendered, clipping checked", ran: true, ok: true }, { name: "tests run in sandbox", ran: true, ok: false }, { name: "formulas recomputed independently", ran: false }], []);
  for (const t of ["The pages fit and all checks passed.", "Nothing is clipped and the rest checks out."]) eq(proof.boundClaims(t, rep).ok, false, t);
  eq(proof.boundClaims("The pages fit.", rep).ok, true, "the passing subject alone is fine");
});
