// Rubric-judge harness for the 135 advice seeds (advice-seeds.json) and the research briefs. Nothing here spends unless you pass --judge-live.
//
//   deno run -A evals/career/advice-seeds.ts                          validate the seed file (count, ids, fields); free
//   deno run -A evals/career/advice-seeds.ts --emit-judge out.json --replay records.json    write judge requests, send nothing
//   deno run -A evals/career/advice-seeds.ts --score judged.json --replay records.json      aggregate judge output + code gates
//   deno run -A evals/career/advice-seeds.ts --judge-live judged.json --replay records.json [--only S001]   Claude judge (needs ANTHROPIC_API_KEY; spend)
//
// records.json: { "S001": { "message": "...", "chat": "...", "brief": "...", "facts": [Fact], "person": ["confirmed fact", ...], "link": "https://..." } }
// (from a real transcript or the agent eval run). judged.json: { "S001": { "honest_read": { "score": 2, "why": "" }, ... } }.
// PASS = judge total >= 18 of 20 AND zero unsourced specifics (recomputed here by code) AND the chat paragraph lints clean.
import { lintChat } from "../../supabase/functions/_shared/agent/research/chat.ts";
import { unsourcedIn } from "../../supabase/functions/_shared/agent/research/guard.ts";
import { CRITERIA, PASS_TOTAL, type Criterion } from "./advice/score.ts";

export interface Seed { id: string; group: string; tags: string[]; situation: string; must: string; fail: string }
export interface Record_ { message: string; chat: string; brief: string; facts: any[]; person: string[]; link?: string | null }
export type Judged = Partial<Record<Criterion, { score: number; why?: string }>>;
const dir = new URL("./", import.meta.url);
export const loadSeeds = (): Seed[] => JSON.parse(Deno.readTextFileSync(new URL("advice-seeds.json", dir))).seeds;

export function validateSeeds(seeds: Seed[]): string[] {
  const bad: string[] = [];
  if (seeds.length !== 135) bad.push(`expected 135 seeds, found ${seeds.length}`);
  if (new Set(seeds.map((s) => s.id)).size !== seeds.length) bad.push("duplicate ids");
  for (const s of seeds) for (const k of ["id", "group", "situation", "must", "fail"] as const) if (!String(s[k] ?? "").trim()) bad.push(`${s.id}: empty ${k}`);
  return bad;
}
export function judgeRequest(s: Seed, r: Record_, template: string): { id: string; prompt: string } {
  const sources = (r.facts ?? []).map((f: any) => `- ${f.text} (${f.url})`).join("\n") || "- none retrieved";
  return { id: s.id, prompt: template.replace("{{PERSON}}", (r.person ?? []).map((p) => `- ${p}`).join("\n") || "- nothing on file").replace("{{MUST}}", s.must).replace("{{FAIL}}", s.fail).replace("{{MESSAGE}}", r.message).replace("{{SOURCES}}", sources).replace("{{CHAT}}", r.chat).replace("{{BRIEF}}", r.brief) };
}
export function gate(j: Judged, r: Record_) {
  const scores = Object.fromEntries(CRITERIA.map((c) => [c, Math.max(0, Math.min(2, Math.round(Number(j[c]?.score ?? 0))))])) as Record<Criterion, number>;
  const total = CRITERIA.reduce((a, c) => a + scores[c], 0);
  const unsourced = unsourcedIn(r.brief, { facts: r.facts ?? [], person: r.person ?? [], message: r.message });
  const chat = lintChat(r.chat, { link: r.link ?? null, facts: r.facts ?? [], person: r.person ?? [], message: r.message });
  return { scores, total, unsourced, chat, pass: total >= PASS_TOTAL && !unsourced.length && !chat.length };
}
export function summarize(rows: { id: string; g: ReturnType<typeof gate> }[]): string {
  const mean = (c: Criterion) => rows.reduce((a, x) => a + x.g.scores[c], 0) / Math.max(1, rows.length);
  const weakest = [...CRITERIA].sort((a, b) => mean(a) - mean(b));
  return [`${rows.filter((x) => x.g.pass).length}/${rows.length} pass (judge >= ${PASS_TOTAL}/20, zero unsourced, chat lint clean)`, ...CRITERIA.map((c) => `  ${c.padEnd(22)} ${mean(c).toFixed(2)}`), `weakest: ${weakest.slice(0, 3).join(", ")}`,
    ...rows.filter((x) => !x.g.pass).slice(0, 30).map((x) => `  ${x.id}: ${x.g.total}/20${x.g.unsourced.length ? ` unsourced [${x.g.unsourced.slice(0, 4).join(", ")}]` : ""}${x.g.chat.length ? ` chat [${x.g.chat.join("; ")}]` : ""}`)].join("\n");
}

async function main() {
  const args = Deno.args, arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const seeds = loadSeeds(), bad = validateSeeds(seeds);
  if (bad.length) { console.error(bad.join("\n")); Deno.exit(1); }
  const only = arg("--only")?.split(","), use = only ? seeds.filter((s) => only.includes(s.id)) : seeds;
  const replay = arg("--replay");
  if (!replay) { console.log(`${seeds.length} seeds valid across ${new Set(seeds.map((s) => s.group)).size} groups; pass --replay records.json with --emit-judge, --score or --judge-live`); return; }
  const recs: Record<string, Record_> = JSON.parse(Deno.readTextFileSync(replay));
  const template = Deno.readTextFileSync(new URL("advice-judge-prompt.md", dir));
  const have = use.filter((s) => recs[s.id]);
  if (arg("--emit-judge")) { Deno.writeTextFileSync(arg("--emit-judge")!, JSON.stringify(have.map((s) => judgeRequest(s, recs[s.id], template)), null, 1)); console.log(`wrote ${have.length} judge requests; nothing sent`); return; }
  let judged: Record<string, Judged> = {};
  const live = arg("--judge-live");
  if (live) {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) { console.error("NOT RUN: --judge-live needs ANTHROPIC_API_KEY (the judge is the spend). Nothing was faked."); Deno.exit(2); }
    const { callModel, modelConfigFor } = await import("../../supabase/functions/_shared/model_gateway.ts");
    const cfg = modelConfigFor(Deno.env, Deno.env.get("JUDGE_MODEL") || "claude-sonnet-5-5");
    const bud = await import("../../supabase/functions/_shared/model_budget.ts");
    const gate = bud.resolveBudgetGate(undefined, (k) => Deno.env.get(k)) ?? bud.memoryBudgetGate(5_000_000);
    try { const st = await bud.assertRunMayStart(gate, 1_000_000, { model: cfg.model, role: "eval" }); console.error(`ledger: $${(st.total / 1e6).toFixed(3)} recorded across all runs; remaining allowance $${Math.max(0, (st.target - st.total) / 1e6).toFixed(3)} of $${(st.target / 1e6).toFixed(2)}`); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); Deno.exit(2); }
    for (const s of have) {
      const res = await callModel(cfg, { system: "You are a strict grader. Answer with JSON only.", messages: [{ role: "user", content: [{ type: "text", text: judgeRequest(s, recs[s.id], template).prompt }] }], max_tokens: 1500 }, { role: "chat", budget: gate });
      const text = (res.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      try { judged[s.id] = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { judged[s.id] = {}; }
    }
    Deno.writeTextFileSync(live, JSON.stringify(judged, null, 1));
  } else if (arg("--score")) judged = JSON.parse(Deno.readTextFileSync(arg("--score")!));
  else { console.error("pass --emit-judge, --score or --judge-live"); Deno.exit(1); }
  const rows = have.map((s) => ({ id: s.id, g: gate(judged[s.id] ?? {}, recs[s.id]) }));
  console.log(summarize(rows));
  Deno.exit(rows.every((x) => x.g.pass) && have.length === use.length ? 0 : 1);
}
if (import.meta.main) await main();
