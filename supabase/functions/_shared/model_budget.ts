// The hard global ONE-DAY budget for every paid model call (owner, 2026-10-28, corrected the same day): $20 across all testers
// for 2026-10-29 America/Chicago only, never exceeded, concurrent calls and missing cost records included. It is not a recurring
// daily allowance: before the window and after it every paid call is refused, and the budget is only ever renewed by the owner
// approving a new one (an owner-run statement adds its row and moves the window settings; no code creates a budget). The database side is
// supabase/migrations/20261028070000_global_daily_model_budget.sql (read its header first); this is the caller side.
//
//   reserve the worst-case cost BEFORE the request  ->  settle to the proven actual cost AFTER it
//   - a reservation that does not fit means NO request: the caller throws ModelBudgetBlockedError;
//   - anything unproven (usage missing or unparseable, unpriced model, timeout, network error, a 5xx, the settle RPC failing)
//     keeps the full worst case as spent. Missing records never free budget;
//   - release (give the reservation back) only for a proven no-call: the request was never sent, or the provider refused it
//     with a 4xx/429 before generating anything;
//   - the budget cannot be reached or answers badly: FAIL CLOSED, no request.
//
// The limits and the window are not configurable from here: each approved Chicago day is a model_budget_days row with its own
// limit (2026-10-28 $15, 2026-10-29 $20), and the window is the model_budget_settings rows window_start / window_end
// (2026-10-28T00:00 to 2026-10-30T00:00 America/Chicago).
// MODEL_BUDGET_PAUSED is the kill switch (an environment secret): while it is true no paid call is made.
// Where there is no Supabase project at all (a developer's machine running evals, a unit test with a fake provider) the
// gate is a process-local twin with the same arithmetic: one $20 total for the life of the process, no calendar; with a project URL but no service key, or
// a failing database, the call is refused.
export const DEFAULT_DAILY_LIMIT_MICROS = 20_000_000;
export const BUDGET_TIME_ZONE = "America/Chicago";

// before / after: the budget window is not open (nothing is spent early; nothing is spent after it until the owner approves a new budget).
export type ReserveResult = { ok: true; id: string } | { ok: false; reason: "limit" | "paused" | "unavailable" | "before" | "after"; detail?: string };
export interface BudgetMeta { model: string; role: string }
export interface BudgetGate {
  reserve(micros: number, meta: BudgetMeta): Promise<ReserveResult>;
  // actualMicros null = not proven: the full reservation is kept as spent. Returns whether the settle was recorded.
  settle(id: string, actualMicros: number | null): Promise<boolean>;
  // Only for a proven no-call.
  release(id: string): Promise<boolean>;
}

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

export const budgetPausedByEnv = (get: (k: string) => string | undefined): boolean => ["1", "true", "yes", "on"].includes(String(get("MODEL_BUDGET_PAUSED") ?? "").trim().toLowerCase());

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const wholeMicros = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

// ---- the database gate -----------------------------------------------------------------------------------------------
type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
export function rpcBudgetGate(rpc: Rpc): BudgetGate {
  return {
    async reserve(micros, meta) {
      if (!wholeMicros(micros)) return { ok: false, reason: "unavailable", detail: "worst-case cost is not a positive whole number" };
      try {
        const r = await rpc("model_budget_reserve", { p_micros: micros, p_model: meta.model, p_role: meta.role });
        if (r.error) return { ok: false, reason: "unavailable", detail: String(r.error.message ?? r.error).slice(0, 200) };
        const d = r.data;
        if (d && d.ok === true && isUuid(d.id)) return { ok: true, id: d.id };
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
  };
}

// PostgREST over plain fetch, with the service key: the gateway has no Supabase client to borrow.
export function restBudgetGate(url: string, serviceKey: string, request: typeof fetch = (...a) => fetch(...a), timeoutMs = 5000): BudgetGate {
  const base = url.replace(/\/+$/, "");
  return rpcBudgetGate(async (name, args) => {
    const res = await request(`${base}/rest/v1/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json", apikey: serviceKey, authorization: `Bearer ${serviceKey}` }, body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch (_) { /* below */ }
    if (!res.ok) return { data: null, error: { message: `HTTP ${res.status}` } };
    return { data, error: null };
  });
}

// ---- the process-local twin ------------------------------------------------------------------------------------------
// Same arithmetic, in one JS process (every step is synchronous, so it cannot interleave): one total for the life of the
// process, no calendar. For machines without a project.
export function memoryBudgetGate(limitMicros = DEFAULT_DAILY_LIMIT_MICROS): BudgetGate & { snapshot(): { spent: number; reserved: number; limit: number } } {
  const t = { spent: 0, reserved: 0 };
  const open = new Map<string, number>();
  return {
    async reserve(micros) {
      if (!wholeMicros(micros)) return { ok: false, reason: "unavailable", detail: "worst-case cost is not a positive whole number" };
      if (t.spent + t.reserved + micros > limitMicros) return { ok: false, reason: "limit" };
      t.reserved += micros; const id = crypto.randomUUID(); open.set(id, micros);
      return { ok: true, id };
    },
    async settle(id, actual) {
      const m = open.get(id); if (m === undefined) return false; open.delete(id);
      t.reserved -= m; t.spent += actual === null ? m : Math.max(0, Math.ceil(actual)); return true;
    },
    async release(id) { const m = open.get(id); if (m === undefined) return false; open.delete(id); t.reserved -= m; return true; },
    snapshot() { return { spent: t.spent, reserved: t.reserved, limit: limitMicros }; },
  };
}
let localGate: BudgetGate | null = null;

type EnvGet = (k: string) => string | undefined;
export function denoEnvGet(): EnvGet | null {
  try { const e = (globalThis as any).Deno?.env; return e ? (k: string) => e.get(k) : null; } catch (_) { return null; }
}

// The gate for a call: the caller's own (tests, a handler with an admin client), else the project's, else the local twin.
// null = refuse (a project URL with no service key).
export function resolveBudgetGate(explicit: BudgetGate | undefined, get: EnvGet | null = denoEnvGet(), request?: typeof fetch): BudgetGate | null {
  if (explicit) return explicit;
  const url = get?.("SUPABASE_URL") ?? "", key = get?.("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (url && key) return restBudgetGate(url, key, request);
  if (url || key) return null;
  return localGate ??= memoryBudgetGate();
}
export function resetLocalBudgetGate(g: BudgetGate | null = null) { localGate = g; }

// ---- worst-case cost -------------------------------------------------------------------------------------------------
// call_fee: a per-call charge in micro-USD (a hosted tool call, for example); absent = none. The gateway sends only function tools
// (no web search, no file search) and calls no embeddings endpoint, so every row's fee is 0 today; the arithmetic still includes it.
export interface PriceRow { input: number; cached: number; cache_write: number; output: number; call_fee?: number }
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
//   output <= the request's output cap (max_completion_tokens covers reasoning tokens too; max_tokens for Anthropic).
// Unknown model => the table's highest rates. Rounded up. At least 1.
export function worstCaseMicros(model: string, prices: Record<string, PriceRow>, body: { bytes: number; images: number; maxOutputTokens: number }): number {
  const known = prices[model];
  const rate = known ? { input: Math.max(known.input, known.cached, known.cache_write), output: known.output, call_fee: known.call_fee ?? 0 } : highestPrice(prices);
  const tokensIn = Math.max(0, body.bytes) + Math.max(0, body.images) * IMAGE_TOKENS_UPPER;
  return Math.max(1, Math.ceil(tokensIn * rate.input + Math.max(0, body.maxOutputTokens) * rate.output + rate.call_fee));
}
// A usage block counts as proven only when it carries real, finite, non-negative token counts for the input and the output.
// (A reply with no usage must never be read as zero tokens.)
export function usageProven(provider: "openai" | "anthropic", raw: any): boolean {
  const u = raw && typeof raw === "object" ? raw.usage : null;
  if (!u || typeof u !== "object") return false;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return provider === "openai" ? ok(u.prompt_tokens) && ok(u.completion_tokens) : ok(u.input_tokens) && ok(u.output_tokens);
}

// A provider answer that is a refusal before generation: nothing was produced, so nothing is billed.
export const REFUSED_BEFORE_GENERATION = new Set([400, 401, 403, 404, 422, 429]);
