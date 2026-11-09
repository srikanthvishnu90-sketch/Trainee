// RELEASE 10: the recruiter-rubric judge for the fifteen templates (rubric.md). Each item is one corpus resume
// (tests/helpers/resume_corpus.ts) rendered in one template; the judge reads the PDF itself, as a recruiter sees it, and
// grades only the format. Results go to evals/career/resume-judge/results/<label>.json, with the spend.
//
//   deno run -A evals/career/resume-judge/run.ts --label <label>                         fake judge: $0, deterministic, wiring only
//   deno run -A evals/career/resume-judge/run.ts --label <label> --model claude --budget-usd 4 [--sample 90] [--templates T01,T05]
//
// --model claude is PAID (ANTHROPIC_API_KEY, Claude only, D-038a's $70 cycle). It is never run by a builder: the architect runs
// it within budget. Before the first call the run is quoted (pages x tokens x price) and refused when the quote is over
// --budget-usd; the spend is read from each response's usage and the run stops before the next item at the budget.
// The fake judge scores from the checker's measurements (career_resume_pixel.ts): it proves the harness, never a template.
// deno-lint-ignore-file no-explicit-any
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerRender } from "../../../supabase/functions/_shared/router_core.career.js";
import { type LibraryId, renderTemplate, TEMPLATE_IDS, TEMPLATES } from "../../../supabase/functions/_shared/career_resume_templates.ts";
import { checkTemplatePdf } from "../../../supabase/functions/_shared/career_resume_pixel.ts";
import { PRICES } from "../../../supabase/functions/_shared/model_gateway.ts";
import { judgeModelProblem } from "../judges.ts";
import { corpus } from "../../../tests/helpers/resume_corpus.ts";

export const JUDGE_MODEL = "claude-sonnet-5-5";
export const CRITERIA = ["scan", "hierarchy", "alignment", "density", "fit", "trust"] as const;
// Measured on Anthropic's PDF support: a text page costs roughly 1,500-3,000 input tokens (text plus the page image); the
// quote takes the top of that range, plus the rubric, and 400 output tokens.
export const EST = { page_in_tokens: 3000, rubric_in_tokens: 700, out_tokens: 400 };
const HERE = new URL("./", import.meta.url);
const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });

export interface Item { id: string; template: LibraryId; resume: string; role: string; level: string; pdf: Uint8Array; pages: number; geometry: any }
export function items(o: { sample?: number; templates?: LibraryId[]; seed?: number } = {}): Item[] {
  const all: Item[] = [];
  for (const c of corpus()) for (const t of o.templates ?? TEMPLATE_IDS) {
    const r = renderTemplate(R, c.doc, { template: t });
    if (!r.ok) continue;
    const role = c.doc.sections.find((s: any) => s.heading === "Experience")?.lines.find((l: any) => l.type === "entry")?.text.split(",")[0] ?? "entry-level role";
    all.push({ id: `${c.id}-${t}`, template: t, resume: c.id, role, level: c.shape, pdf: r.pdf, pages: r.fit.pages, geometry: r.set.geometry });
  }
  if (!o.sample || o.sample >= all.length) return all;
  // Stratified by template: the same number from each, picked by a seeded shuffle.
  let s = (o.seed ?? 20261108) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const per = Math.max(1, Math.floor(o.sample / (o.templates ?? TEMPLATE_IDS).length));
  return (o.templates ?? TEMPLATE_IDS).flatMap((t) => all.filter((i) => i.template === t).map((i) => ({ i, k: rand() })).sort((a, b) => a.k - b.k).slice(0, per).map((x) => x.i));
}
export function quote(list: Item[], model = JUDGE_MODEL): { usd: number; basis: string } {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  const inTok = list.reduce((n, i) => n + i.pages * EST.page_in_tokens + EST.rubric_in_tokens, 0), outTok = list.length * EST.out_tokens;
  const usd = (inTok * p.input + outTok * p.output) / 1e6;
  return { usd: Math.round(usd * 1000) / 1000, basis: `${list.length} files, ${inTok} input and ${outTok} output tokens at ${model} ($${p.input}/$${p.output} per MTok)` };
}
export function prompt(i: Item, rubric: string): string {
  return `${rubric}\n\nThe role: ${i.role}. The person's stage: ${i.level.replace(/_/g, " ")}. Grade the attached resume's format.`;
}
export function passes(v: any): boolean {
  return !!v && v.would_read_further === true && CRITERIA.every((c) => Number(v.scores?.[c]) >= 4);
}
async function fakeJudge(i: Item): Promise<any> {
  const k = await checkTemplatePdf(i.geometry, i.pdf);
  const s = k.pass ? 5 : 3;
  return { scores: Object.fromEntries(CRITERIA.map((c) => [c, s])), evidence: {}, would_read_further: k.pass, one_fix: k.pass ? "" : k.failures[0]?.detail ?? "" };
}
async function claudeJudge(i: Item, rubric: string, key: string): Promise<{ verdict: any; usd: number }> {
  const body = {
    model: JUDGE_MODEL, max_tokens: 700, system: "You are an experienced recruiter grading resume formats. Output JSON only.",
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(i.pdf).toString("base64") } },
      { type: "text", text: prompt(i, rubric) },
    ] }],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`judge call failed (${res.status}): ${JSON.stringify(j).slice(0, 300)}`);
  const p = PRICES[JUDGE_MODEL], u = j.usage ?? {};
  const usd = ((u.input_tokens ?? 0) * p.input + (u.cache_read_input_tokens ?? 0) * p.cached + (u.output_tokens ?? 0) * p.output) / 1e6;
  const text = (j.content ?? []).map((c: any) => c.text ?? "").join("");
  let verdict: any = null;
  try { verdict = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { verdict = { error: "unparsable", raw: text.slice(0, 300) }; }
  return { verdict, usd };
}

if (import.meta.main) {
  const arg = (k: string) => { const i = Deno.args.indexOf(k); return i >= 0 ? Deno.args[i + 1] : undefined; };
  const label = arg("--label");
  if (!label) throw new Error("--label is required");
  const model = arg("--model") ?? "fake";
  const list = items({ sample: arg("--sample") ? Number(arg("--sample")) : undefined, templates: arg("--templates")?.split(",") as LibraryId[] | undefined });
  const rubric = await Deno.readTextFile(new URL("rubric.md", HERE));
  const q = quote(list);
  let key = "";
  if (model === "claude") {
    const problem = judgeModelProblem(JUDGE_MODEL, Deno.env);
    if (problem) throw new Error(problem);
    const budget = Number(arg("--budget-usd"));
    if (!(budget > 0)) throw new Error("--model claude needs --budget-usd (the quote must fit under it)");
    if (q.usd > budget) throw new Error(`refused: the quote is $${q.usd} (${q.basis}), over --budget-usd ${budget}`);
    key = Deno.env.get("ANTHROPIC_API_KEY")!;
    console.log(`quote $${q.usd}: ${q.basis}`);
  } else if (model !== "fake") throw new Error("--model is fake or claude");
  const budget = Number(arg("--budget-usd") ?? 0);
  let spent = 0, stopped = false;
  const rows: any[] = [];
  for (const i of list) {
    if (model === "claude" && spent >= budget) { stopped = true; break; }
    const r = model === "claude" ? await claudeJudge(i, rubric, key) : { verdict: await fakeJudge(i), usd: 0 };
    spent += r.usd;
    rows.push({ id: i.id, template: i.template, resume: i.resume, pages: i.pages, verdict: r.verdict, pass: passes(r.verdict), usd: Math.round(r.usd * 10000) / 10000 });
  }
  const byTemplate = Object.fromEntries((arg("--templates")?.split(",") ?? TEMPLATE_IDS).map((t) => {
    const xs = rows.filter((r) => r.template === t), n = xs.length, p = xs.filter((r) => r.pass).length;
    const mean = (c: string) => n ? Math.round(xs.reduce((s, r) => s + (Number(r.verdict?.scores?.[c]) || 0), 0) / n * 100) / 100 : null;
    return [t, { name: TEMPLATES[t as LibraryId].name, files: n, pass: p, pass_rate: n ? Math.round(p / n * 1000) / 10 : null, template_pass: n ? p / n >= 0.9 : null, mean: Object.fromEntries(CRITERIA.map((c) => [c, mean(c)])) }];
  }));
  const out = { label, model: model === "claude" ? JUDGE_MODEL : "fake", judge_model: model === "claude" ? JUDGE_MODEL : null, at: new Date().toISOString(), quote: q, cost_usd: Math.round(spent * 10000) / 10000, stopped_at_budget: stopped, files: rows.length, by_template: byTemplate, rows,
    note: model === "fake" ? "FAKE JUDGE: scores come from the pixel checker; this proves the harness and is not a score of any template" : null };
  await Deno.mkdir(new URL("results/", HERE), { recursive: true });
  await Deno.writeTextFile(new URL(`results/${label}.json`, HERE), JSON.stringify(out, null, 1));
  console.log(`${rows.length} files judged (${out.model}), $${out.cost_usd}${stopped ? " (stopped at the budget: not a score)" : ""}`);
  for (const [t, v] of Object.entries(byTemplate)) console.log(`${t} ${(v as any).name}: ${(v as any).pass}/${(v as any).files} pass`);
}
