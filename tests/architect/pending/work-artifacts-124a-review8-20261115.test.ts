// WO-124a eighth review (2026-11-15, D-088 structural bar). Earlier tests unchanged. Fixtures are invented.
import { zlibSync } from "npm:fflate@0.8.2";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("124a review 8 D8: a reported miss next to 'checks out' or a whole-work claim is refused", () => {
  const a = proof.report([{ name: "tests run in sandbox", ran: true, ok: true }, { name: "formulas recomputed independently", ran: false }], []);
  const b = proof.report([{ name: "formulas recomputed independently", ran: true, ok: false }, { name: "pages rendered, clipping checked", ran: false }], []);
  for (const t of ["The recompute was not run yet the figures check out.", "Formulas were not checked yet everything checks out.", "Pages were not checked yet everything checks out.", "The page check failed yet the layout checks out."]) {
    eq([proof.boundClaims(t, a).ok, proof.boundClaims(t, b).ok], [false, false], t);
  }
  eq(proof.boundClaims("The recompute failed on two cells, so I have not sent it.", b).ok, true, "an honest miss stays");
});

Deno.test("124a review 8 D4: a revoked value written around a number is searched for by its number", async () => {
  for (const v of ["USD 150,000", "150000 USD per year", "$150,000/yr", "base 150000", "150k+", "$150K-$160K", "~150000"]) {
    eq((await revoke.scan({ "a.txt": enc("Base pay is $150,000 a year.") }, [v])).length, 1, v);
  }
  eq((await revoke.scan({ "a.txt": enc("Base pay is $150,000 a year.") }, ["1.5 million dollars"])).length, 0, "a different number is not a hit");
});

Deno.test("124a review 8 D4: a quoted '>' does not cut an attribute; a clean Flate PDF is readable", async () => {
  eq((await revoke.scan({ "word/document.xml": enc('<w:sdt><w:alias w:val="Salary 150000 > target"/><w:tag w:val="Acme Corp >"/></w:sdt>') }, [150000, "Acme Corp"])).length, 2, "both found");
  const st = zlibSync(enc("BT (hello) Tj ET"));
  const pdf = new Uint8Array([...enc(`%PDF-1.4\n1 0 obj\n<< /Length ${st.length} /Filter /FlateDecode >>\nstream\n`), ...st, ...enc("\nendstream\nendobj\n%%EOF\n")]);
  eq((await revoke.scan({ "m.pdf": pdf }, [17280])).map((h) => h.category), [], "an ordinary Flate PDF is not 'unreadable'");
  const st2 = zlibSync(enc("BT (Net 17280) Tj ET"));
  const pdf2 = new Uint8Array([...enc(`%PDF-1.4\n1 0 obj\n<< /Length ${st2.length} /Filter /FlateDecode >>\nstream\n`), ...st2, ...enc("\nendstream\nendobj\n%%EOF\n")]);
  eq((await revoke.scan({ "m.pdf": pdf2 }, [17280])).length, 1, "and its text is read");
});
