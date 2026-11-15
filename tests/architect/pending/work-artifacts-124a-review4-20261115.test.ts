// WO-124a fourth review (2026-11-15), under D-088's structural bar: the structural fail-open paths it found. Earlier
// tests are unchanged. Fixtures are invented.
import * as model from "../../../supabase/functions/_shared/work/model.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}`); }
  throw new Error(`${m}: did not throw`);
}
const enc = (s: string) => new TextEncoder().encode(s);
const hits = async (t: string, v: string | number, name = "x.xml") => (await revoke.scan({ [name]: enc(t) }, [v])).length;

Deno.test("124a review 4 D8: a reported miss does not hide a success claim in the same clause", () => {
  const rep = proof.report([{ name: "tests run in sandbox", ran: true, ok: false }, { name: "formulas recomputed independently", ran: true, ok: false },
    { name: "pages rendered, clipping checked", ran: false }], []);
  for (const c of ["Tests passed where earlier runs failed", "Tests passed while the page check was not run", "All tests passed except one that failed",
    "The figures are now right after the earlier recompute failed", "Everything is now correct though one check failed earlier"]) eq(proof.boundClaims(c, rep).ok, false, c);
  for (const c of ["Tests were not run here.", "The recompute failed on two cells, so I have not sent it."]) eq(proof.boundClaims(c, rep).ok, true, c);
});

Deno.test("124a review 4 D4: values in namespaced, single-quoted and relationship attributes, pivot caches and compact PDF Info are found", async () => {
  const present: [string, string | number][] = [
    [`<Relationship Target="mailto:jane@acme.test"/>`, "jane@acme.test"], [`<w:fldSimple w:instr="MERGEFIELD 17280"/>`, 17280],
    [`<w:alias w:val="Net 17280"/>`, 17280], [`<w:docVar w:name="x" w:val="17280"/>`, 17280], [`<w:comment w:author="Jane Doe"/>`, "Jane Doe"],
    [`<pic descr='17280 shown'/>`, 17280], [`<n v="17280"/>`, 17280], [`<table displayName="Net17280"/>`, 17280], [`<p:tag name="a" val="17280"/>`, 17280],
  ];
  for (const [t, v] of present) eq(await hits(t, v), 1, t);
  eq(await hits("%PDF-1.4\n1 0 obj\n<</Title(Net 17280)/Author(Jane Doe)>>\nendobj\n%%EOF", 17280, "m.pdf"), 1, "compact PDF Info dictionary");
  eq(await hits(`<w:rPr><w:sz w:val="12"/></w:rPr>`, "$12"), 0, "a font size is a setting, not content");
  eq(await hits(`<Properties><AppVersion>16.0000</AppVersion><Words>12</Words></Properties>`, "$16"), 0, "app.xml counters are not content");
});

Deno.test("124a review 4 D4: a bare small revoked number is found; a signed one is found in stored cells, not in prose", async () => {
  eq(await hits("We have 7 seats left", "7"), 1, "bare 7");
  eq(await hits("<c><v>5</v></c>", "$5"), 1, "a $5 stored as a cell value");
  eq(await hits("score 5 of 9", "$5"), 0, "a bare 5 in prose is not a revoked $5");
});

Deno.test("124a review 4 D1: more number words; a ref names only the model's own cells", () => {
  for (const t of ["a fifth of revenue", "a tenth", "triple the base", "quintupled", "a pair", "costs halved", "grew fivefold", "a threefold rise", "billions of users", "a trillion-dollar market", "nil"]) {
    eq(model.loose(t, {}).length > 0, true, t);
  }
  throwsNamed(() => model.render("{{ref:__proto__}}", {}), "UnknownRef", "__proto__ is no cell");
  throwsNamed(() => model.render("{{ref:toString}}", { a: 1 }), "UnknownRef", "toString is no cell");
});
