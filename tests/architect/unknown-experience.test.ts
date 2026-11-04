// UNKNOWN EXPERIENCE (2026-11-01): years of experience come only from dated experience entries. A person with none on file
// (nothing at all, or entries without dates) has UNKNOWN experience: no posting is filtered out for asking "2+ years". Dated
// entries still decide: someone whose record shows under a year is still told a 2+ years posting does not fit. Live path
// (evals/career/world.ts) over the in-flight world's postings (SYNTHETIC): Stripe and Ramp ask "2+ years".
import assertNode from "node:assert/strict";
import { openWorld, worldTurn } from "../../evals/career/world.ts";

const W = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const ASK = "find me data analyst jobs";

async function search(facts: any[] | null) {
  const w = await openWorld(facts ? { now: W.now, postings: W.postings, facts } : { now: W.now, postings: W.postings });
  return await worldTurn(w, { brain: "router", threadId: "A", message: ASK, now: w.now });
}
const shown = (reply: string) => ["Stripe", "Ramp"].filter((co) => new RegExp(`\\bat ${co}\\b|, ${co},`).test(reply));

Deno.test("nothing on file: experience is unknown, so 2+ years postings are shown, not screened out", async () => {
  const r = await search(null);
  assertNode.equal(r.handler, "router:career_discovery");
  assertNode.deepEqual(shown(r.reply), ["Stripe", "Ramp"], r.reply);
  assertNode.doesNotMatch(r.reply, /your profile shows about 0|0 years/i, r.reply);
});

Deno.test("experience stated without dates is still unknown in years: not screened", async () => {
  const r = await search([{ kind: "experience", text: "Data analyst with 2 years of SQL and Tableau" }, { kind: "location", text: "Based in Chicago" }]);
  assertNode.deepEqual(shown(r.reply), ["Stripe", "Ramp"], r.reply);
});

Deno.test("dated experience still decides: under a year on record keeps 2+ years postings out", async () => {
  const r = await search([{ kind: "experience", text: "Data Analyst Intern, Acme (TEST)", title: "Data Analyst Intern", start: "2026-06", end: "2026-08" }]);
  assertNode.equal(r.handler, "router:career_discovery");
  assertNode.deepEqual(shown(r.reply), [], r.reply);
});
