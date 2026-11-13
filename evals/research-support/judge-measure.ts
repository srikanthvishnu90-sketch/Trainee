// The real support judge, measured on every case of the reviews (cases.ts). $0 by default:
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/research-support/judge-measure.ts
// prints the case count and an estimated cost and exits; nothing is sent. Live, only with the owner's written approval of the spend
// (a DECISIONS.md line) and the key; the CI workflow .github/workflows/research-support-live.yml runs it, after reserving the cap at
// the shared $80 ledger, and settles the ledger to `spent_usd` after:
//   SUPPORT_JUDGE_SPEND_APPROVED=D-0xx ANTHROPIC_API_KEY=... deno run -A --no-check --import-map=tests/flow/supabase-npm.json \
//     evals/research-support/judge-measure.ts --live --budget-usd 0.5 --out <dir>
// It sends each case that layer A (code) lets through to the product's model through the gateway (callModel), in batches as a turn
// would, under an in-process hard cap of --budget-usd (at most $1; a call that does not fit is refused before it is sent), and
// prints the confusion table against the hand labels, the latency, and `spent_usd=` from the meter; <dir>/result.json keeps it.
// deno-lint-ignore-file no-explicit-any
import { CASES, FALSE_101, LAYER_A, SPLIT_CLAIM, SPLIT_PAGES, TRUE_40 } from "./cases.ts";
import { echoes, findSupport, indexPages, JUDGE_MAX_CLAIMS, judgeAll, modelSupportJudge, quoteClaim, type SupportClaim, supportJudgePayload } from "../../supabase/functions/_shared/agent/research/support.ts";
import { abbreviated } from "../../supabase/functions/_shared/agent/research/market.ts";
import { callModel, modelConfig, newMeter, PRICES, TRAINEE_MODEL } from "../../supabase/functions/_shared/model_gateway.ts";
import { memoryBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";

const BATCH = JUDGE_MAX_CLAIMS; // as a turn batches them (support.ts)
// What layer A sends on: the claim beside the passage of the one page unit that holds its hard parts (round 3: the unit with its
// title, heading and the units around it). The rest never reach the judge. A claim that is the unit itself is asked as a quote.
const sent: { id: string; want: "yes" | "no"; c: SupportClaim }[] = [];
const stopped: Record<string, number> = {};
function add(set: string, id: string, want: "yes" | "no", pages: { text: string; title: string }[], claim: string) {
  const idx = indexPages(pages, abbreviated, ["Citadel"], { ask: "what does citadel pay interns" }), f = findSupport(claim, idx, [0]);
  if (!f) { stopped[set] = (stopped[set] ?? 0) + 1; return; }
  sent.push({ id: `${set}: ${id}`, want, c: { claim: echoes(claim, f.sentence) ? quoteClaim(f.sentence, idx, f.unit.lent) : claim, source: f.unit.passage } });
}
for (const c of CASES) add(c.good ? "true 28" : "hostile 94", c.id, c.good && c.judge === "yes" ? "yes" : "no", [{ text: c.page, title: c.title ?? "Citadel compensation notes" }, ...(c.page2 ? [{ text: c.page2, title: "Other notes" }] : [])], c.claim);
for (const [cls, page, claim] of LAYER_A) add("layer-A 78", `${cls}: ${claim}`, "no", [{ text: page, title: "Notes" }], claim);
for (const [cls, page, claim] of FALSE_101) add("false 101", `${cls}: ${claim}`, "no", [{ text: page, title: "Citadel notes" }], claim);
for (const [title, page, claim] of TRUE_40) add("true 40", claim, "yes", [{ text: page, title }], claim);
for (const page of SPLIT_PAGES) add("split 12", page.slice(0, 40), "no", [{ text: page, title: "Citadel notes" }], SPLIT_CLAIM);
console.log(`Stopped by layer A before the judge: ${JSON.stringify(stopped)}. The could-not-confirm smuggles and the solicitations never reach the judge.`);
const batches: typeof sent[] = [];
for (let k = 0; k < sent.length; k += BATCH) batches.push(sent.slice(k, k + BATCH));
const price = PRICES[TRAINEE_MODEL];
// About 4 characters a token; the output is the array plus the model's own thinking, which the gateway allows 1,024 tokens a call.
const inTok = batches.reduce((n, b) => n + Math.ceil(JSON.stringify(supportJudgePayload(b.map((x) => x.c))).length / 4), 0);
const estLow = (inTok * price.input + batches.length * 60 * price.output) / 1e6, estHigh = (inTok * price.input + batches.length * (1024 + 100) * price.output) / 1e6;
console.log(`${CASES.length + LAYER_A.length + FALSE_101.length + TRUE_40.length + SPLIT_PAGES.length} cases; ${sent.length} go to the judge in ${batches.length} calls of up to ${BATCH}; passages ${sent.reduce((n, x) => n + x.c.source.length, 0)} bytes in all, ${Math.round(sent.reduce((n, x) => n + x.c.source.length, 0) / Math.max(1, sent.length))} a claim.`);
console.log(`Model ${TRAINEE_MODEL}. Estimated input ${inTok} tokens; estimated cost $${estLow.toFixed(3)} to $${estHigh.toFixed(3)} (output without and with the full thinking allowance).`);
if (!Deno.args.includes("--live")) { console.log("Not run: pass --live to send these to the real judge (owner-approved spend only)."); Deno.exit(0); }

const opt = (k: string) => { const i = Deno.args.indexOf(k); return i >= 0 ? Deno.args[i + 1] : undefined; };
const budget = Number(opt("--budget-usd") ?? 0), out = opt("--out");
if (!(budget > 0 && budget <= 1) || !out) { console.log("refused: --live needs --budget-usd (above 0, at most 1) and --out <dir>"); Deno.exit(3); }
if (!/^D-\d{3}[a-z]?$/.test(Deno.env.get("SUPPORT_JUDGE_SPEND_APPROVED") ?? "")) { console.log("refused: --live needs SUPPORT_JUDGE_SPEND_APPROVED=<the DECISIONS.md line>"); Deno.exit(3); }
if (!Deno.env.get("ANTHROPIC_API_KEY")) { console.log("refused: --live needs ANTHROPIC_API_KEY"); Deno.exit(3); }
const gate = memoryBudgetGate(Math.round(budget * 1e6));
const cfg = modelConfig(Deno.env), meter = newMeter();
const judge = modelSupportJudge(async (p) => { const r = await callModel(cfg, { system: p.system, messages: p.messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] })), max_tokens: p.max_tokens, temperature: p.temperature }, { meter, role: "chat", budget: gate, timeoutMs: 8000 }); return (r.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""); });
const table = { yes_yes: 0, yes_no: 0, no_yes: 0, no_no: 0 }, wrong: string[] = [], ms: number[] = [];
for (const b of batches) {
  const t0 = Date.now(), got = await judgeAll(judge, b.map((x) => x.c));
  ms.push(Date.now() - t0);
  b.forEach((x, k) => { const g = got[k] ? "yes" : "no"; (table as any)[`${x.want}_${g}`]++; if (g !== x.want) wrong.push(`${x.id}: labelled ${x.want}, judge said ${g}`); });
}
console.log(`label yes / judge yes: ${table.yes_yes}   label yes / judge no: ${table.yes_no} (a true line shown as a quote)`);
console.log(`label no  / judge yes: ${table.no_yes} (a hostile claim THROUGH)   label no / judge no: ${table.no_no}`);
for (const w of wrong) console.log(`  ${w}`);
console.log(`Calls ${meter.calls} (failed ${meter.failed}); cost $${(meter.usd_micros / 1e6).toFixed(4)} by the meter; latency per call ms: median ${[...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]}, max ${Math.max(...ms)}.`);
const spent = meter.usd_micros / 1e6;
await Deno.mkdir(out, { recursive: true });
await Deno.writeTextFile(`${out}/result.json`, JSON.stringify({ kind: "research-support-judge", approval: Deno.env.get("SUPPORT_JUDGE_SPEND_APPROVED"), model: cfg.model, run_id: Deno.env.get("GITHUB_RUN_ID") ?? null, sha: Deno.env.get("GITHUB_SHA") ?? null, at: new Date().toISOString(), budget_usd: budget, calls: meter.calls, failed: meter.failed, table, wrong, latency_ms: ms, spent_usd: Number(spent.toFixed(6)) }, null, 1));
console.log(`spent_usd=${spent.toFixed(6)}`);
