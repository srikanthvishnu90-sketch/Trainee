// The shared TOTAL model budget (owner, 2026-11-02 22:02 CT: Claude-only; the release+test cycle has ONE total of $70, and
// MODEL_BUDGET_TARGET_USD and MODEL_BUDGET_HARD_USD both default to it). ONE ledger covers production AND evals: when a Supabase project is
// configured every caller reserves in the same database ledger (supabase/migrations/20261102160000_model_budget_total_cap.sql, which
// sums spend over all days); where there is no project the process-local twin applies the same arithmetic. Replaces the per-day
// windows of 2026-10-28 (the old daily rows stay as history; the total sums them, so nothing already spent is forgotten).
//
//   MODEL_BUDGET_TARGET_USD (default 70)   at 80% of it ($56): a warning flag (reserve answers warn; the gateway logs it; one
//                                          founder_alerts row). Eval and test runners refuse to start a run at or over it
//                                          (assertRunMayStart below).
//   MODEL_BUDGET_HARD_USD   (default 70)   the same $70 total, as the stop. A reservation counts toward it BEFORE its call; one that does not fit
//                                          makes NO request (ModelBudgetBlockedError "limit"). When spent + reserved reaches it the
//                                          database sets the 'paused' setting (the MODEL_BUDGET_PAUSED switch's twin) and every model
//                                          call is refused until the owner raises the hard max and clears it.
//   reserve the worst-case cost BEFORE the request  ->  settle to the proven actual cost AFTER it
//   - anything unproven (usage missing or unparseable, unpriced model, timeout, network error, a 5xx, the settle RPC failing)
//     keeps the full worst case as spent. Missing records never free budget;
//   - release (give the reservation back) only for a proven no-call: the request was never sent, or the provider refused it
//     with a 4xx/429 before generating anything;
//   - the budget cannot be reached or answers badly, or either variable is malformed (or the hard max is below the target): FAIL
//     CLOSED, no request.
// MODEL_BUDGET_PAUSED is the kill switch (an environment secret): while it is true no paid call is made.
// Where there is no Supabase project at all (a developer's machine running evals, a unit test with a fake provider) the
// gate is a process-local twin with the same arithmetic and the same two limits; with a project URL but no service key, or
// a failing database, the call is refused.
import { ModelBudgetBlockedError } from "./model_calls.ts";

export const DEFAULT_TARGET_USD = 70;
export const DEFAULT_HARD_USD = 70;
export const DEFAULT_TARGET_MICROS = DEFAULT_TARGET_USD * 1_000_000;
export const DEFAULT_HARD_MICROS = DEFAULT_HARD_USD * 1_000_000;
// The warning flag rises at this share of the TARGET (spent + reserved).
export const BUDGET_WARN_FRACTION = 0.8;
export const BUDGET_TIME_ZONE = "America/Chicago";

// before / after: the budget window is not open (nothing is spent early; nothing is spent after it until the owner approves a new budget).
export type ReserveResult = { ok: true; id: string; warn?: boolean; overTarget?: boolean } | { ok: false; reason: "limit" | "paused" | "unavailable" | "before" | "after"; detail?: string };
export interface BudgetMeta { model: string; role: string }
export interface BudgetGate {
  reserve(micros: number, meta: BudgetMeta): Promise<ReserveResult>;
  // actualMicros null = not proven: the full reservation is kept as spent. Returns whether the settle was recorded.
  settle(id: string, actualMicros: number | null): Promise<boolean>;
  // Only for a proven no-call.
  release(id: string): Promise<boolean>;
  // Where the total stands (what a runner reads before starting a run). null = could not be read.
  status?(): Promise<BudgetStatus | null>;
}
export type BudgetState = "ok" | "warning" | "over_target" | "stopped";
export interface BudgetStatus { state: BudgetState; spent: number; reserved: number; total: number; target: number; hard: number }
export interface BudgetLimits { target: number; hard: number }

export const GLOBAL_LIMIT_REPLY = "Trainee has used up its AI budget, so I didn't use the AI for this reply.";
export const BUDGET_BEFORE_REPLY = "Trainee's AI budget hasn't opened yet, so I didn't use the AI for this reply.";
export const BUDGET_AFTER_REPLY = "Trainee's AI budget has ended and needs the owner's approval before it can be used again, so I didn't use the AI for this reply.";
export const BUDGET_PAUSED_REPLY = "Trainee's AI is switched off for a short while, so I didn't use it for this reply. Please try again later.";
export const BUDGET_UNAVAILABLE_REPLY = "I couldn't check today's AI budget, so I didn't use the AI for this reply. Please try again in a few minutes.";
export type BudgetBlock = "limit" | "paused" | "unavailable" | "before" | "after";
export const BUDGET_ERROR_TYPE: Record<BudgetBlock, string> = { limit: "global_daily_limit", paused: "budget_paused", unavailable: "budget_unavailable", before: "budget_not_open", after: "budget_ended" };
export const budgetReply = (b: BudgetBlock) => b === "limit" ? GLOBAL_LIMIT_REPLY : b === "paused" ? BUDGET_PAUSED_REPLY : b === "before" ? BUDGET_BEFORE_REPLY : b === "after" ? BUDGET_AFTER_REPLY : BUDGET_UNAVAILABLE_REPLY;
export const budgetBlockOfType = (t: string | null | undefined): BudgetBlock | null =>
  (Object.keys(BUDGET_ERROR_TYPE) as BudgetBlock[]).find((k) => BUDGET_ERROR_TYPE[k] === t) ?? null;

// The Chicago calendar date of an instant (the SQL twin is model_budget_day). DST days have 23 or 25 hours, one date each.
export function chicagoDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUDGET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// MODEL_BUDGET_TARGET_USD and MODEL_BUDGET_HARD_USD as whole micro-dollars. Unset or blank = the default ($70 total for both). Anything
// else must be a positive number of dollars, and the hard max must not be below the target; otherwise null and the caller refuses
// to spend (a typo must never lift or hide a limit).
const usdMicros = (raw: string, dflt: number): number | null => {
  const r = raw.trim();
  if (!r) return dflt;
  if (!/^[0-9]{1,6}(\.[0-9]{1,6})?$/.test(r)) return null;
  const micros = Math.round(Number(r) * 1_000_000);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
};
export function budgetLimits(get: ((k: string) => string | undefined) | null): BudgetLimits | null {
  const target = usdMicros(String(get?.("MODEL_BUDGET_TARGET_USD") ?? ""), DEFAULT_TARGET_MICROS);
  const hard = usdMicros(String(get?.("MODEL_BUDGET_HARD_USD") ?? ""), DEFAULT_HARD_MICROS);
  return target === null || hard === null || hard < target ? null : { target, hard };
}
export const warnAt = (targetMicros: number) => Math.ceil(targetMicros * BUDGET_WARN_FRACTION);
export function stateOf(total: number, l: BudgetLimits, paused = false): BudgetState {
  return total >= l.hard || paused ? "stopped" : total >= l.target ? "over_target" : total >= warnAt(l.target) ? "warning" : "ok";
}

export const budgetPausedByEnv = (get: (k: string) => string | undefined): boolean => ["1", "true", "yes", "on"].includes(String(get("MODEL_BUDGET_PAUSED") ?? "").trim().toLowerCase());

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const wholeMicros = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

// ---- the database gate -----------------------------------------------------------------------------------------------
type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
export function rpcBudgetGate(rpc: Rpc, limits: BudgetLimits = { target: DEFAULT_TARGET_MICROS, hard: DEFAULT_HARD_MICROS }): BudgetGate {
  return {
    async reserve(micros, meta) {
      if (!wholeMicros(micros)) return { ok: false, reason: "unavailable", detail: "worst-case cost is not a positive whole number" };
      try {
        const r = await rpc("model_budget_reserve", { p_micros: micros, p_model: meta.model, p_role: meta.role, p_target_limit_micros: limits.target, p_hard_limit_micros: limits.hard });
        if (r.error) return { ok: false, reason: "unavailable", detail: String(r.error.message ?? r.error).slice(0, 200) };
        const d = r.data;
        if (d && d.ok === true && isUuid(d.id)) return { ok: true, id: d.id, ...(d.warn === true ? { warn: true } : {}), ...(d.over_target === true ? { overTarget: true } : {}) };
        if (d && d.ok === false && d.state === "limit") return { ok: false, reason: "limit" };
        if (d && d.ok === false && d.state === "paused") return { ok: false, reason: "paused" };
        if (d && d.ok === false && d.state === "before_window") return { ok: false, reason: "before" };
        if (d && d.ok === false && (d.state === "after_window" || d.state === "no_budget")) return { ok: false, reason: "after" };
        return { ok: false, reason: "unavailable", detail: "the budget function answered in a shape that is not understood" };
      } catch (e) { return { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message.slice(0, 200) : "budget call failed" }; }
    },
    async settle(id, actual) {
      try {
        const r = await rpc("model_budget_settle", { p_id: id, p_actual_micros: actual === null ? null : Math.max(0, Math.ceil(actual)) });
        return !r.error && r.data?.ok === true;
      } catch (_) { return false; } // the reservation stays open; the TTL converts it to spent at its worst case
    },
    async release(id) {
      try { const r = await rpc("model_budget_release", { p_id: id }); return !r.error && r.data?.ok === true; } catch (_) { return false; }
    },
    async status() {
      try {
        const r = await rpc("model_budget_total_status", { p_target_limit_micros: limits.target, p_hard_limit_micros: limits.hard });
        const d = r.data, n = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
        if (r.error || !d || !["ok", "warning", "over_target", "stopped"].includes(d.state) || n(d.total) === null) return null;
        return { state: d.state, spent: n(d.spent) ?? 0, reserved: n(d.reserved) ?? 0, total: d.total, target: limits.target, hard: limits.hard };
      } catch (_) { return null; }
    },
  };
}

// PostgREST over plain fetch, with the service key: the gateway has no Supabase client to borrow.
export function restBudgetGate(url: string, serviceKey: string, request: typeof fetch = (...a) => fetch(...a), timeoutMs = 5000, limits: BudgetLimits = { target: DEFAULT_TARGET_MICROS, hard: DEFAULT_HARD_MICROS }): BudgetGate {
  const base = url.replace(/\/+$/, "");
  return rpcBudgetGate(async (name, args) => {
    const res = await request(`${base}/rest/v1/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json", apikey: serviceKey, authorization: `Bearer ${serviceKey}` }, body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch (_) { /* below */ }
    if (!res.ok) return { data: null, error: { message: `HTTP ${res.status}` } };
    return { data, error: null };
  }, limits);
}

// ---- the process-local twin ------------------------------------------------------------------------------------------
// Same arithmetic, in one JS process (every step is synchronous, so it cannot interleave): one total for the life of the
// process, no calendar. For machines without a project.
// limitMicros is the HARD max; the target defaults to $70 or the hard max, whichever is lower.
export function memoryBudgetGate(limitMicros = DEFAULT_HARD_MICROS, targetMicros = Math.min(DEFAULT_TARGET_MICROS, limitMicros)): BudgetGate & { status(): Promise<BudgetStatus>; snapshot(): { spent: number; reserved: number; limit: number; target: number; warn: boolean; overTarget: boolean } } {
  const t = { spent: 0, reserved: 0 };
  const open = new Map<string, number>();
  const lim = { target: targetMicros, hard: limitMicros };
  const status = (): BudgetStatus => ({ state: stateOf(t.spent + t.reserved, lim), spent: t.spent, reserved: t.reserved, total: t.spent + t.reserved, target: targetMicros, hard: limitMicros });
  return {
    async reserve(micros) {
      if (!wholeMicros(micros)) return { ok: false, reason: "unavailable", detail: "worst-case cost is not a positive whole number" };
      if (t.spent + t.reserved + micros > limitMicros) return { ok: false, reason: "limit" };
      t.reserved += micros; const id = crypto.randomUUID(); open.set(id, micros);
      const total = t.spent + t.reserved;
      return { ok: true, id, ...(total >= warnAt(targetMicros) ? { warn: true } : {}), ...(total >= targetMicros ? { overTarget: true } : {}) };
    },
    async settle(id, actual) {
      const m = open.get(id); if (m === undefined) return false; open.delete(id);
      t.reserved -= m; t.spent += actual === null ? m : Math.max(0, Math.ceil(actual)); return true;
    },
    async release(id) { const m = open.get(id); if (m === undefined) return false; open.delete(id); t.reserved -= m; return true; },
    async status() { return status(); },
    snapshot() { const total = t.spent + t.reserved; return { spent: t.spent, reserved: t.reserved, limit: limitMicros, target: targetMicros, warn: total >= warnAt(targetMicros), overTarget: total >= targetMicros }; },
  };
}
let localGate: BudgetGate | null = null;

type EnvGet = (k: string) => string | undefined;
export function denoEnvGet(): EnvGet | null {
  try { const e = (globalThis as any).Deno?.env; return e ? (k: string) => e.get(k) : null; } catch (_) { return null; }
}

// The gate for a call: the caller's own (tests, a handler with an admin client), else the project's shared ledger, else the local twin.
// null = refuse (a project URL with no service key).
export function resolveBudgetGate(explicit: BudgetGate | undefined, get: EnvGet | null = denoEnvGet(), request?: typeof fetch): BudgetGate | null {
  if (explicit) return explicit;
  const cap = budgetLimits(get);
  if (cap === null) return null; // MODEL_BUDGET_TARGET_USD / MODEL_BUDGET_HARD_USD is malformed: refuse rather than guess a limit
  const url = get?.("SUPABASE_URL") ?? "", key = get?.("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (url && key) return restBudgetGate(url, key, request, 5000, cap);
  if (url || key) return null;
  return localGate ??= memoryBudgetGate(cap.hard, cap.target);
}
export function resetLocalBudgetGate(g: BudgetGate | null = null) { localGate = g; }

// ---- worst-case cost -------------------------------------------------------------------------------------------------
// call_fee: a per-call charge in micro-USD (a hosted tool call, for example); absent = none. The gateway sends only function tools
// (web search is dark), so every row's fee is 0 today; the arithmetic still includes it.
export interface PriceRow { input: number; cached: number; cache_write: number; output: number; call_fee?: number; long_context?: { over_tokens: number; multiplier: number } }
// Highest per-token rates in the table: what a model with no price is charged at.
export function highestPrice(prices: Record<string, PriceRow>): { input: number; output: number; call_fee: number } {
  let input = 0, output = 0, call_fee = 0;
  for (const p of Object.values(prices)) { input = Math.max(input, p.input, p.cached, p.cache_write); output = Math.max(output, p.output); call_fee = Math.max(call_fee, p.call_fee ?? 0); }
  return { input, output, call_fee };
}
// Tokens an image can cost when it is sent as a link (its bytes say nothing).
export const IMAGE_TOKENS_UPPER = 3000;
// Upper bound for one request, in micro-USD (rates are USD per million tokens, so one rate unit is one micro-USD a token).
//   input  <= the request body's UTF-8 bytes (a token is at least one byte) + a flat allowance per image block;
//   output <= the request's output cap (max_tokens).
// Unknown model => the table's highest rates. Rounded up. At least 1.
export function worstCaseMicros(model: string, prices: Record<string, PriceRow>, body: { bytes: number; images: number; maxOutputTokens: number }): number {
  const known = prices[model];
  const rate = known ? { input: Math.max(known.input, known.cached, known.cache_write), output: known.output, call_fee: known.call_fee ?? 0 } : highestPrice(prices);
  const tokensIn = Math.max(0, body.bytes) + Math.max(0, body.images) * IMAGE_TOKENS_UPPER;
  // D-038: a long-context surcharge is reserved whenever the request could pass its threshold (bytes over-count tokens).
  const x = known?.long_context && tokensIn > known.long_context.over_tokens ? known.long_context.multiplier : 1;
  return Math.max(1, Math.ceil(x * (tokensIn * rate.input + Math.max(0, body.maxOutputTokens) * rate.output) + rate.call_fee));
}
// A usage block counts as proven only when it carries real, finite, non-negative token counts for the input and the output.
// (A reply with no usage must never be read as zero tokens.)
// Only Anthropic's usage shape is ever proven; any other provider name is never proven (the worst case stays spent).
export function usageProven(provider: string, raw: any): boolean {
  if (provider !== "anthropic") return false;
  const u = raw && typeof raw === "object" ? raw.usage : null;
  if (!u || typeof u !== "object") return false;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return ok(u.input_tokens) && ok(u.output_tokens);
}

// An eval or test runner calls this BEFORE starting any new run (owner, 2026-11-02): at or over the $70 total the run does not
// start; and when the run's quoted worst case is given (micros) the ledger must be able to take it right now (it is reserved,
// then released: a proven no-call). Production serving does not call it (its own per-person daily gate stays); every
// reservation still counts in the ledger. An unreadable ledger also refuses (fail closed). Throws ModelBudgetBlockedError
// (message "NOT RUN: ..."); returns the status when the run may start.
const notRun = (block: "limit" | "unavailable", detail: string) => { const e = new ModelBudgetBlockedError(block, detail); e.message = `NOT RUN: ${e.message}`; return e; };
export async function assertRunMayStart(gate: BudgetGate | null = resolveBudgetGate(undefined), quoteMicros?: number, meta: BudgetMeta = { model: "eval", role: "eval" }): Promise<BudgetStatus> {
  if (!gate || !gate.status) throw notRun("unavailable", "the budget cannot be read, so no new run starts");
  const st = await gate.status();
  if (!st) throw notRun("unavailable", "the budget could not be read, so no new run starts");
  if (st.state === "over_target" || st.state === "stopped") throw notRun("limit", `the release+test spend total is reached ($${(st.total / 1e6).toFixed(2)} of $${(st.target / 1e6).toFixed(2)}); no new run starts`);
  if (quoteMicros !== undefined) {
    const r = await gate.reserve(Math.max(1, Math.ceil(quoteMicros)), meta);
    if (!r.ok) throw notRun(r.reason === "limit" ? "limit" : "unavailable", `${budgetReply(r.reason)}${r.detail ? ` (${r.detail})` : ""}; no new run starts`);
    await gate.release(r.id);
  }
  return st;
}

// A provider answer that is a refusal before generation: nothing was produced, so nothing is billed.
export const REFUSED_BEFORE_GENERATION = new Set([400, 401, 403, 404, 422, 429]);
