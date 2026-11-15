// WO-124a seventh review (2026-11-15, D-088 structural bar), and the 124e review's throw-on-bad-values finding.
// Earlier tests unchanged. Fixtures are invented.
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as model from "../../../supabase/functions/_shared/work/model.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}`); }
  throw new Error(`${m}: did not throw`);
}
const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("124a review 7 D4: one row is ended once per round; values are bounded strings", () => {
  const c = kase.newCase({ owner: "SYN", practice: true, title: "t", now: 1 });
  kase.addRound(c, { round: 1, text: "", constraints: [{ id: "a", kind: "hard", text: "x", values: ["40%"] }] });
  throwsNamed(() => kase.addRound(c, { round: 2, text: "", constraints: [{ id: "b", kind: "permission", text: "r", revokes: "a" }, { id: "c", kind: "hard", text: "s", supersedes: "a", values: ["35%"] }] }), "LedgerError", "revoke and supersede of one row");
  for (const v of [[null], [{}], [true], ["x".repeat(201)], [""]]) {
    const d = kase.newCase({ owner: "SYN", practice: true, title: "t", now: 1 });
    throwsNamed(() => kase.addRound(d, { round: 1, text: "", constraints: [{ id: "a", kind: "hard", text: "x", values: v as unknown as string[] }] }), "LedgerError", JSON.stringify(v).slice(0, 30));
  }
});

Deno.test("124a review 7 D4: a revoked number with a unit is found as the number alone; grouped numbers read whole", async () => {
  for (const [t, v] of [["Base pay is $150,000 a year.", "150000 USD"], ["We reached 17,280 people.", "17,280 users"], ["<w:t>17,280 people</w:t>", "17280 users"]]) {
    eq((await revoke.scan({ "a.xml": enc(t) }, [v])).length, 1, `${t} holds ${v}`);
  }
});

Deno.test("124a review 7 D4: a PDF with a filter the scan cannot read, a Type3 font or encryption is unreadable", async () => {
  for (const pdf of ["%PDF-1.4\n<< /Filter /LZWDecode /DecodeParms << /EarlyChange 0 >> /Length 3 >>\nstream\nabc\nendstream",
    "%PDF-1.4\n<< /Filter 5 0 R /Length 3 >>\nstream\nabc\nendstream", "%PDF-1.4\n<< /Subtype /Type3 >>", "%PDF-1.4\ntrailer << /Encrypt 9 0 R >>"]) {
    eq((await revoke.scan({ "m.pdf": enc(pdf) }, [17280])).map((h) => h.category), ["unreadable container"], pdf.slice(9, 40));
  }
});

Deno.test("124a review 7: the honest-miss rule reads claim patterns; the second loose loop masks only whole figures", () => {
  const rep = proof.report([{ name: "pages rendered, clipping checked", ran: true, ok: false }, { name: "word count computed", ran: true, ok: false }], []);
  for (const t of ["The untested layout fits on one page.", "Not yet tested yet it fits on one page.", "Untested: under 300 words."]) eq(proof.boundClaims(t, rep).ok, false, t);
  eq(model.loose("Revenue 2026-11-14.000,50", {}).length > 0, true, "digits glued after a date");
  eq(model.loose("Meet at 9:30.000,5", {}).length > 0, true, "digits glued after a time");
});
