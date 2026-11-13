// The real support judge, measured on the review's 94 hostile and 28 true cases (cases.ts). $0 by default:
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/research-support/judge-measure.ts
// prints the case count and an estimated cost and exits; nothing is sent. Only by hand, with the owner's yes to the spend (D-038a):
//   deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/research-support/judge-measure.ts --live
// sends each case that layer A (code) lets through to the product's model through the gateway and the budget ledger (callModel),
// in batches as a reply would, and prints the confusion table against the hand labels and the dollar cost the meter recorded.
// deno-lint-ignore-file no-explicit-any
import { CASES } from "./cases.ts";
import { findSupport, indexPages, judgeAll, modelSupportJudge, type SupportClaim, supportJudgePayload } from "../../supabase/functions/_shared/agent/research/support.ts";
import { abbreviated } from "../../supabase/functions/_shared/agent/research/market.ts";
import { callModel, modelConfig, newMeter, PRICES, TRAINEE_MODEL } from "../../supabase/functions/_shared/model_gateway.ts";
import { assertRunMayStart } from "../../supabase/functions/_shared/model_budget.ts";

const BATCH = 12;
// What layer A sends on: the claim beside the one page sentence that holds its hard parts. The rest never reach the judge.
const sent: { id: string; want: "yes" | "no"; c: SupportClaim }[] = [];
let byCode = 0;
for (const c of CASES) {
  const f = findSupport(c.claim, indexPages([{ text: c.page }, ...(c.page2 ? [{ text: c.page2 }] : [])], abbreviated), [0]);
  if (!f) { byCode++; continue; }
  sent.push({ id: c.id, want: c.good && c.judge === "yes" ? "yes" : "no", c: { claim: c.claim, source: f.sentence } });
}
const batches: typeof sent[] = [];
for (let k = 0; k < sent.length; k += BATCH) batches.push(sent.slice(k, k + BATCH));
const price = PRICES[TRAINEE_MODEL];
// About 4 characters a token; the output is the array plus the model's own thinking, which the gateway allows 1,024 tokens a call.
const inTok = batches.reduce((n, b) => n + Math.ceil(JSON.stringify(supportJudgePayload(b.map((x) => x.c))).length / 4), 0);
const estLow = (inTok * price.input + batches.length * 60 * price.output) / 1e6, estHigh = (inTok * price.input + batches.length * (1024 + 100) * price.output) / 1e6;
console.log(`${CASES.length} cases (${CASES.filter((c) => !c.good).length} hostile, ${CASES.filter((c) => c.good).length} true). Layer A stops ${byCode} before the judge; ${sent.length} go to the judge in ${batches.length} calls of up to ${BATCH}.`);
console.log(`Model ${TRAINEE_MODEL}. Estimated input ${inTok} tokens; estimated cost $${estLow.toFixed(3)} to $${estHigh.toFixed(3)} (output without and with the full thinking allowance).`);
if (!Deno.args.includes("--live")) { console.log("Not run: pass --live to send these to the real judge (owner-approved spend only)."); Deno.exit(0); }

await assertRunMayStart();
const cfg = modelConfig(Deno.env), meter = newMeter();
const judge = modelSupportJudge(async (p) => { const r = await callModel(cfg, { system: p.system, messages: p.messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] })), max_tokens: p.max_tokens, temperature: p.temperature }, { meter, role: "chat", timeoutMs: 15000 }); return (r.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""); });
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
