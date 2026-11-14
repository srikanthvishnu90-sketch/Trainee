// Eval spend control for a Claude-only campaign (owner, 2026-11-02: ONE total of $85 for the cycle; target and hard max are both $85).
//
// Three layers, outermost first (the first two live in supabase/functions/_shared/model_budget.ts, owned by the
// feat/claude-only-gateway PR; this file only reads and obeys them):
//   1. every model call reserves against a BudgetGate before it is sent (callModel). With SUPABASE_URL and
//      SUPABASE_SERVICE_ROLE_KEY set that is the shared database ledger (restBudgetGate); without them, a process-local twin.
//   2. env MODEL_BUDGET_TARGET_USD (85) and MODEL_BUDGET_HARD_USD (85) name the ledger's target and hard stop.
//   3. THIS FILE: a per-run preflight quote (token estimate x price) that refuses to start a run that would cross 80% of what
//      remains under the target, and a spend line written to the run summary. Parallel passes (five processes, each seeing only
//      the spend recorded before it started) are quoted together via EVAL_PARALLEL / --parallel.
// Dependency (not in this PR): if the gateway PR exports a ledger status reader, pass it as `status` to preflight().
import type { PriceRow } from "../../supabase/functions/_shared/model_budget.ts";

export const DEFAULT_TARGET_USD = 85;
export const DEFAULT_HARD_USD = 85;
export const PREFLIGHT_SHARE = 1;

export function budgetTargets(get: (k: string) => string | undefined): { target: number; hard: number } {
  const t = get("MODEL_BUDGET_TARGET_USD"), h = get("MODEL_BUDGET_HARD_USD");
  const target = t === undefined || t === "" ? DEFAULT_TARGET_USD : Number(t), hard = h === undefined || h === "" ? DEFAULT_HARD_USD : Number(h);
  if (!(target > 0) || !(hard >= target)) throw new Error(`MODEL_BUDGET_TARGET_USD (${t}) and MODEL_BUDGET_HARD_USD (${h}) must be numbers with 0 < target <= hard`);
  return { target, hard };
}

// Spend already recorded on disk that counts against the Anthropic campaign: result files of a run that used a Claude model
// (brain or judge): brain + judge cost. OpenAI-era files are history, not part of the $85 (owner to confirm).
export function claudeSpentUsd(results: { label?: string; model?: string | null; judge_model?: string | null; judge_model_2?: string | null; cost?: unknown; cost_usd?: { brain?: number; judge?: number } | number }[], exceptLabel = ""): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const r of results) {
    if (r.label === exceptLabel || (r.label && seen.has(r.label))) continue;
    if (![r.model, r.judge_model, r.judge_model_2].some((m) => /^claude-/i.test(String(m ?? "")))) continue;
    if (r.label) seen.add(r.label);
    const c = r.cost_usd;
    sum += typeof c === "number" ? c : (Number(c?.brain) || 0) + (Number(c?.judge) || 0);
  }
  return sum;
}

// Token estimates, measured or estimated in the plan (claude-only-eval-plan.md section 3.1; [M] = measured, [E] = estimated).
export const EST = {
  request_in_tokens: { staged: 10_500, agent: 11_000 }, // [M] first brain request, local probe; no prompt caching yet
  steps_per_item: { staged: 34 / 38, agent: 99 / 38 },    // [M] stored traces, dev pass; x1.25 below for Claude
  claude_step_factor: 1.25,                                // [E]
  out_tokens_per_step: { haiku: 150, sonnet: 400 },        // [E]
  judge_in_tokens: 850, judge_b_extra_in: 250,            // [E] larger {stores, account} state; B adds the checklist
  judge_out_tokens: { a: 250, b: 450 },                    // [E] B quotes evidence
  retry_factor: 1.05,                                      // [E]
};
const perMTok = (tokens: number, usdPerM: number) => tokens * usdPerM / 1e6;
const outRate = (model: string) => /sonnet|opus/i.test(model) ? EST.out_tokens_per_step.sonnet : EST.out_tokens_per_step.haiku;

export interface Quote { brain_usd: number; judge_usd: number; total_usd: number; basis: string }
// Worst-plausible cost of one pass: items x steps x (input + output tokens at the model's price), plus both judges per item.
export function quoteRun(o: { items: number; brain: "router" | "staged" | "agent"; brainModel: string | null; judgeA: string | null; judgeB: string | null; prices: Record<string, PriceRow> }): Quote {
  const price = (m: string) => { const p = o.prices[m]; if (!p) throw new Error(`no price for ${m}: an unpriced call cannot be quoted or capped`); return p; };
  let brain = 0;
  if (o.brain !== "router") {
    if (!o.brainModel) throw new Error(`the ${o.brain} brain needs a model to be quoted`);
    const p = price(o.brainModel), steps = o.items * EST.steps_per_item[o.brain] * EST.claude_step_factor;
    brain = steps * (perMTok(EST.request_in_tokens[o.brain], p.input) + perMTok(outRate(o.brainModel), p.output));
  }
  let judge = 0;
  if (o.judgeA) { const p = price(o.judgeA); judge += o.items * (perMTok(EST.judge_in_tokens, p.input) + perMTok(EST.judge_out_tokens.a, p.output)); }
  if (o.judgeB) { const p = price(o.judgeB); judge += o.items * (perMTok(EST.judge_in_tokens + EST.judge_b_extra_in, p.input) + perMTok(EST.judge_out_tokens.b, p.output)); }
  judge *= EST.retry_factor;
  return { brain_usd: brain, judge_usd: judge, total_usd: brain + judge,
    basis: `${o.items} items, ${o.brain} brain${o.brainModel ? ` ${o.brainModel}` : ""}, judges ${[o.judgeA, o.judgeB].filter(Boolean).join(" + ") || "none"}; token estimates x PRICES (estimate, not a measurement)` };
}

export interface Preflight { ok: boolean; reason: string | null; line: string; quote_usd: number; parallel: number; remaining_usd: number }
// Refuse when the quote (times the passes that run at once) exceeds what remains of the $85 total (remaining = total minus recorded spend); the line prints the remaining allowance.
export function preflight(o: { quote: Quote; parallel?: number; spent_usd: number; target_usd: number; hard_usd: number; ledger: "shared" | "process-local" }): Preflight {
  const parallel = Math.max(1, o.parallel ?? 1), q = o.quote.total_usd * parallel, remaining = Math.max(0, o.target_usd - o.spent_usd);
  let reason: string | null = null;
  if (o.spent_usd + q > o.hard_usd) reason = `the quote $${q.toFixed(3)} on top of $${o.spent_usd.toFixed(3)} spent would pass the hard max $${o.hard_usd.toFixed(2)}`;
  else if (q > PREFLIGHT_SHARE * remaining) reason = `the quote $${q.toFixed(3)} (${parallel} parallel) is more than the remaining allowance $${remaining.toFixed(3)} of the $${o.target_usd.toFixed(2)} total`;
  return { ok: reason === null, reason, quote_usd: q, parallel, remaining_usd: remaining,
    line: `preflight quote $${q.toFixed(3)} (brain $${(o.quote.brain_usd * parallel).toFixed(3)} + judges $${(o.quote.judge_usd * parallel).toFixed(3)}, ${parallel} parallel) · spent $${o.spent_usd.toFixed(3)} · remaining allowance $${remaining.toFixed(3)} of $${o.target_usd.toFixed(2)} total · ledger ${o.ledger}${reason ? ` · REFUSED: ${reason}` : ""}` };
}

// The spend line written to the run summary and the result file.
export function spendLine(o: { label: string; quote_usd: number; brain_usd: number; judge_usd: number; spent_before_usd: number; target_usd: number; hard_usd: number }): string {
  const actual = o.brain_usd + o.judge_usd, after = o.spent_before_usd + actual;
  return `spend ${o.label}: $${actual.toFixed(3)} (brain $${o.brain_usd.toFixed(3)}, judges $${o.judge_usd.toFixed(3)}; quoted $${o.quote_usd.toFixed(3)}) · campaign total $${after.toFixed(3)} of $${o.target_usd.toFixed(2)} total (${(after / o.target_usd * 100).toFixed(1)}%)`;
}

// The gate every model call of an eval process reserves against: the shared database ledger when SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are set (model_budget.ts restBudgetGate, the same RPCs production uses), else a process-local twin
// holding this process's share (1/parallel) of what remains under the target. `bud` is the model_budget.ts module.
export function openGate(bud: { resolveBudgetGate: (explicit: undefined, get: (k: string) => string | undefined) => unknown; memoryBudgetGate: (limitMicros: number) => unknown },
  get: (k: string) => string | undefined, spentUsd: number, targetUsd: number, parallel: number): { gate: any; shared: boolean } | { error: string } {
  const shared = !!(get("SUPABASE_URL") && get("SUPABASE_SERVICE_ROLE_KEY"));
  const asked = String(get("EVAL_LEDGER") ?? "").trim().toLowerCase() === "shared";
  if (asked && !shared) {
    const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !get(k));
    return { error: `EVAL_LEDGER=shared needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the shared budget ledger; missing: ${missing.join(", ")}); a process-local twin would not count the other processes` };
  }
  const gate = shared ? bud.resolveBudgetGate(undefined, get) : bud.memoryBudgetGate(Math.floor(Math.max(0, targetUsd - spentUsd) * 1e6 / Math.max(1, parallel)));
  if (!gate) return { error: "SUPABASE_URL is set without SUPABASE_SERVICE_ROLE_KEY, so the budget ledger cannot be reached; a call that cannot be metered is not made" };
  return { gate, shared };
}

// Total recorded spend (settled + reserved) in the shared ledger, in USD: what ALL runs have used of the one $85. null = unreadable
// (the caller refuses to start).
export async function ledgerSpentUsd(gate: { status?: () => Promise<{ total: number } | null> } | null): Promise<number | null> {
  if (!gate?.status) return null;
  const st = await gate.status();
  return st ? st.total / 1e6 : null;
}

// ---- live runners outside run.ts (real-sets research/people, mirror run-trainee, mirror held-out live) ------------------------
// Each one, when --live, goes through the SAME shared ledger as run.ts (model_budget.ts resolveBudgetGate with EVAL_LEDGER=shared,
// so never the process-local twin): the run's whole cap is reserved before the first model call and settled to the metered cost
// at the end (also on error; an unknown cost settles as the whole cap). Refused (no model call): a cap above LIVE_RUN_MAX_USD, an
// approval that is not a row of docs/architect/DECISIONS.md, a missing or unreachable ledger, a refused reservation. In GitHub
// Actions too the runner reserves and settles its own cap (the workflow gives the run step the ledger secrets): a reservation id
// handed in from outside is never trusted, since the ledger has no narrow read of one reservation to check it against.
export const LIVE_RUN_MAX_USD = 10;
const DECISIONS_URL = new URL("../../docs/architect/DECISIONS.md", import.meta.url);
export function approvalRowExists(approval: string, decisions: string): boolean {
  if (!/^D-\d{3}[a-z]?$/.test(approval)) return false;
  return decisions.split("\n").some((l) => l.startsWith(`| ${approval} |`));
}
export interface LiveLedger { id: string; settle(spentUsd: number | null): Promise<boolean> }
type LedgerGate = { reserve: (m: number, meta?: any) => Promise<{ ok: boolean; id?: string; reason?: string; detail?: string }>; settle: (id: string, actual: number | null) => Promise<boolean>; status?: () => Promise<{ total: number } | null> };
export async function openLiveRunLedger(o: { budgetUsd: number; approval: string; get: (k: string) => string | undefined;
  bud: { resolveBudgetGate: (explicit: undefined, get: (k: string) => string | undefined) => unknown }; decisions?: string; model?: string }): Promise<LiveLedger | { error: string }> {
  if (!(o.budgetUsd > 0 && o.budgetUsd <= LIVE_RUN_MAX_USD)) return { error: `--budget-usd must be above 0 and at most ${LIVE_RUN_MAX_USD} (the per-run maximum)` };
  let decisions = o.decisions;
  if (decisions === undefined) { try { decisions = await Deno.readTextFile(DECISIONS_URL); } catch (_) { decisions = ""; } }
  if (!approvalRowExists(o.approval, decisions)) return { error: `the approval "${o.approval}" is not a row of docs/architect/DECISIONS.md` };
  const shared = (k: string) => k === "EVAL_LEDGER" ? "shared" : o.get(k);
  const gate = o.bud.resolveBudgetGate(undefined, shared) as LedgerGate | null;
  if (!gate) {
    const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !String(o.get(k) ?? "").trim());
    return { error: `the shared budget ledger cannot be opened (${missing.length ? `missing: ${missing.join(", ")}` : "MODEL_BUDGET_* is malformed"}); a run that is not counted in the one total does not start` };
  }
  const st = gate.status ? await gate.status() : null;
  if (!st) return { error: "the shared budget ledger is unreachable or unreadable; no model call is made" };
  const r = await gate.reserve(Math.ceil(o.budgetUsd * 1e6), { model: o.model ?? "claude-sonnet-5-5", role: "eval" });
  if (!r.ok || !r.id) return { error: `the shared ledger refused the cap $${o.budgetUsd} (recorded $${(st.total / 1e6).toFixed(4)}): ${r.reason ?? "refused"}${r.detail ? ` (${r.detail})` : ""}` };
  const id = r.id;
  let done = false;
  return { id, settle: async (spentUsd) => {
    if (done) return true;
    done = true;
    return await gate.settle(id, spentUsd === null || !Number.isFinite(spentUsd) ? null : Math.ceil(Math.max(0, spentUsd) * 1e6));
  } };
}
