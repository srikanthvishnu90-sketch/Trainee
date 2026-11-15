// WO-124a sixth review (2026-11-15, D-088 structural bar) and the 124e review's folder-name finding. Earlier tests
// unchanged. Fixtures are invented.
import { zipSync } from "npm:fflate@0.8.2";
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as model from "../../../supabase/functions/_shared/work/model.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("124a review 6 D8: a whole-work claim needs a green report even when it names a subject; limits are never checks", () => {
  const rep = proof.report([{ name: "formulas recomputed independently, cell by cell", ran: true, ok: true }, { name: "revoke scan of every part, filename and metadata", ran: true, ok: true },
    { name: "invariant: mature baseline unchanged", ran: false }], ["native Excel not tested"]);
  for (const t of ["All checks passed on the workbook.", "Every check on this spreadsheet passed.", "The workbook is fully verified.", "Everything in the spreadsheet checks out."]) eq(proof.boundClaims(t, rep).ok, false, t);
  eq(proof.boundClaims("The formulas check out.", rep).ok, true, "a subject's own claim is judged on that subject");
  eq(proof.boundClaims("Tests passed.", proof.report([{ name: "pages rendered, clipping checked", ran: false }], ["ok: unit tests ran"])).ok, false, "a limit line is not a check");
});

Deno.test("124a review 6 D1: a figure is exempt only when all of it lies inside a date", () => {
  eq(model.loose("at 9:30000 users", { a: 1 }).length > 0, true, "digits after a time");
  eq(model.loose("2026-11-14,000 users", { a: 1 }).length > 0, true, "digits glued to a date");
  eq(model.loose("Signed on 2026-11-14 at 10:30.", {}), [], "real dates stay exempt");
});

Deno.test("124a review 6 D4: scale and percent words, unreadable PDF filters, folder names, a deep ledger copy", async () => {
  eq((await revoke.scan({ "a.txt": enc("raised 1,500,000") }, ["1.5 million"])).length, 1, "1.5 million");
  eq((await revoke.scan({ "a.xml": enc("<c><v>0.4</v></c>") }, ["40 percent"])).length, 1, "40 percent as a stored fraction");
  eq((await revoke.scan({ "m.pdf": enc("%PDF-1.4\n5 0 obj\n<< /Filter /ASCII85Decode /Length 9 >>\nstream\nabc\nendstream") }, [17280])).map((h) => h.category), ["unreadable container"], "a filter the scan cannot read");
  eq((await revoke.scan({ "b.zip": zipSync({ "Acme-Secret-Co/n.txt": enc("x") }) }, ["Acme Secret Co"])).length, 1, "a revoked value in a folder name");
  const c = kase.newCase({ owner: "SYN", practice: true, title: "t", now: 1 });
  kase.addRound(c, { round: 1, text: "", constraints: [{ id: "a", kind: "hard", text: "x", values: ["40%"] }] });
  kase.ledger(c)[0].values!.length = 0;
  eq(c.rows[0].values, ["40%"], "the ledger is a deep copy");
});
