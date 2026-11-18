// MASS APPLY CONVERSATIONS (2026-11-16, evals/career/mass-apply-conversations MA12): "show me exactly what you sent to Lumen"
// is the receipt ask (career_apply_receipt_read.ts): the receipt the database wrote, read by code. Before, "exactly" in front
// of "what" made it no ask at all, and the brain answered from the queue rows without the answers sent.
import assertNode from "node:assert/strict";
import { receiptAsk } from "../../../supabase/functions/_shared/career_apply_receipt_read.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
Deno.test("'exactly' before or after 'what' is still the receipt ask", () => {
  for (const m of ["show me exactly what you sent to Lumen", "exactly what did you send Lumen?", "what exactly did you send to Lumen", "show me what you sent to Lumen exactly"]) eq(receiptAsk(m), { company: "Lumen" }, m);
  for (const m of ["show me exactly what you can do", "exactly what did you do today"]) eq(receiptAsk(m), null, m);
});
