// Runs the open-question pipeline over the eleven fixture personas with the mocked search layer and prints the per-criterion
// scores. Free, offline, deterministic.   deno run -A evals/career/advice/run-fixtures.ts [--show ib-freshman]
import { researchCareerQuestion } from "../../../supabase/functions/_shared/agent/research/index.ts";
import { memoryGroundCache } from "../../../supabase/functions/_shared/agent/research/ground.ts";
import { LINK, mockSearch, PERSONAS, type Persona } from "./fixtures.ts";
import { scoreBrief, table } from "./score.ts";

export const NOW = Date.parse("2026-10-28T12:00:00Z");
export const profileOf = (p: Persona) => ({ facts: p.facts.map((f) => ({ ...f, status: "confirmed", needs_confirmation: false })) });
export async function runPersona(p: Persona, cache = memoryGroundCache(), calls = { n: 0 }) {
  const res = await researchCareerQuestion({ profile: profileOf(p), message: p.message, deps: { search: mockSearch(p, calls), cache, publish: async (_f) => ({ url: LINK }) }, now: NOW });
  if (res.status !== "ok") throw new Error(`${p.id}: ${res.status}`);
  return res;
}
export async function scorePersona(p: Persona, res: Awaited<ReturnType<typeof runPersona>>) {
  return scoreBrief({ brief: res.brief_markdown, chat: p.chat, link: LINK, facts: res.facts, person: res.person, message: p.message, must: p.must, foreign: p.foreign, poison: p.poison, ask: res.ask });
}
if (import.meta.main) {
  const rows = [];
  for (const p of PERSONAS) rows.push({ id: p.id, r: await scorePersona(p, await runPersona(p)) });
  console.log(table(rows));
  for (const x of rows) for (const n of [...x.r.notes, ...x.r.chat, ...x.r.unsourced.map((u) => `unsourced: ${u}`)]) console.log(`  ${x.id}: ${n}`);
  const show = Deno.args[Deno.args.indexOf("--show") + 1];
  if (Deno.args.includes("--show")) console.log("\n" + (await runPersona(PERSONAS.find((p) => p.id === show)!)).brief_markdown);
  Deno.mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
  Deno.writeTextFileSync(new URL("../results/advice-brief.fixtures.json", import.meta.url), JSON.stringify(rows, null, 1));
  Deno.exit(rows.every((x) => x.r.pass) ? 0 : 1);
}
