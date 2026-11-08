// R9 OUTREACH (2026-11-08, after #607): the e2e outreach misses that were not approval wording.
//   - "apply to the <role> role at <Co> and email <Name> there about it" with a chat lead ("hey can u ..."): the apply half
//     kept the lead, so the apply turn did not read it and the router answered "paste the posting".
//   - the same ask in Spanish ("aplica al rol de <role> en <Co> y escríbele a <Name> sobre eso") and in Hindi, Latin script
//     ("<Co> ke <role> mein apply karo aur <Name> ko email bhi karo"): no split at all, so neither half ran.
//   - "find the hiirng manager at X and reacch out": a typo in "reach" left the ask to the job search.
// Each half still goes to the turn that owns it, with its own approval of the exact payload (career_compound_ask.ts).
// Run: deno test -A --no-check tests/architect/r9-outreach-nonapproval.test.ts
import nodeAssert from "node:assert/strict";
import { applyAndReachOf } from "../../supabase/functions/_shared/career_compound_ask.ts";
import { parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";

const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);

Deno.test("R9 outreach: apply-and-email with a chat lead, in Spanish and in Hindi splits into the same two halves", () => {
  const want = (role: string, co: string, name: string) => ({ apply: `apply to the ${role} role at ${co}`, outreach: `email ${name} at ${co} about the ${role} role`, company: co, role });
  eq(applyAndReachOf("hey can u apply to the UI Engineer role at Vantage Freight and email Zoe there about it"), want("UI Engineer", "Vantage Freight", "Zoe"));
  eq(applyAndReachOf("apply to the Data Scientist role at Truecourse Media and email Yuki there about it"), want("Data Scientist", "Truecourse Media", "Yuki"));
  eq(applyAndReachOf("aplica al rol de Data Analyst Intern en Delta Bay Systems y escríbele a Vikram sobre eso"), want("Data Analyst Intern", "Delta Bay Systems", "Vikram"));
  eq(applyAndReachOf("Onyx Bank ke FP&A Analyst mein apply karo aur Zain ko email bhi karo"), want("FP&A Analyst", "Onyx Bank", "Zain"));
  // Not this ask: a question, a negation, or no email half.
  for (const m of ["can you apply to the UI Engineer role at Vantage Freight and email Zoe there about it?", "apply to the UI Engineer role at Vantage Freight but don't email Zoe there about it",
    "Onyx Bank ke FP&A Analyst mein apply karo", "aplica al rol de Data Analyst Intern en Delta Bay Systems"]) eq(applyAndReachOf(m), null, m);
});

Deno.test("R9 outreach: a typo in 'reach out' and in the role still drafts to the role at that firm", () => {
  for (const m of ["find the hiirng manager at Delta Bay Media and reacch out", "find the hirinng manager at Delta Bay Media and reahc out"]) {
    const a = parseNetworkingAsk(m);
    eq(a?.kind === "draft" ? [a.target.by, (a.target as any).firm] : null, ["group", "Delta Bay Media"], m);
  }
  // "reach" spelt right, or a word near it not before "out", is left as it is.
  eq(parseNetworkingAsk("find the hiring manager at Delta Bay Media and reach out")?.kind, "draft");
  eq(parseNetworkingAsk("what's the reah of Delta Bay Media"), null);
});
