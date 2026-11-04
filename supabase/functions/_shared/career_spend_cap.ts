// Launch readiness X7 / M2 (2026-10-26): a per-person daily ceiling on the career chat's model calls.
//
// Every model call a chat turn makes (the staged brain, drafts, the search judge, the resume rewrite, outreach and
// networking drafts, the mock-interview judge) goes through the one wrapper this module builds, before it reaches the
// gateway's callModel. The ceiling is in US dollars a UTC day, read from the person's recorded spend
// (agent_daily_costs, which sums agent_turn_costs, the table every metered call is written to), plus what this turn has
// already spent. A model call counts against it as a call too, so a model with no price still stops.
//
//   CAREER_MODEL_DAILY_USD    dollars a person may spend a UTC day (default 0.05; "0" turns every call off)
//   CAREER_MODEL_DAILY_CALLS  model calls a person may make a UTC day (default 100)
//
// The defaults: the launch-readiness audit (docs/architect/LAUNCH-READINESS-2026-10-26.md §4) reports brain-eval run
// 40371458562 at $0.075 to $0.114 a pass of 38 items, so one staged-brain turn costs about $0.0020 to $0.0030, so $0.05 is about 16 to 25 brain turns a day; D-002 budgets $1 a
// person a month. A turn makes 1 to 4 model calls, so 100 calls stays above what $0.05 buys.
//
// Over the ceiling the wrapper throws ModelUnavailableError("daily_limit") before any request is made: every caller
// already treats a model failure as "answer without the model" (the router, the draft refusal, the unjudged list), and
// the handler adds LIMIT_NOTE to the reply so the person knows why. When the spend cannot be read, no call is made
// either (a cap that cannot be checked is not a cap), and SPEND_UNREAD_NOTE says that instead.
import { ModelUnavailableError } from "./model_calls.ts";
import type { TurnMeter } from "./model_gateway.ts";
import { type BudgetBlock, budgetBlockOfType, budgetReply } from "./model_budget.ts";

type Env = { get(name: string): string | undefined };
export interface DailySpend { usd_micros: number; calls: number }
export interface SpendLimits { usdMicros: number; calls: number }

export const DEFAULT_DAILY_USD = 0.05;
export const DEFAULT_DAILY_CALLS = 100;
export const LIMIT_NOTE = "You've reached today's limit on AI-written answers, so this reply comes from Trainee's built-in steps without the AI. The limit resets at midnight UTC.";
export const SPEND_UNREAD_NOTE = "I couldn't check today's AI usage, so this reply comes from Trainee's built-in steps without the AI.";

const num = (v: string | undefined, d: number) => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
export function spendLimitsFromEnv(env: Env): SpendLimits {
  return { usdMicros: Math.round(num(env.get("CAREER_MODEL_DAILY_USD"), DEFAULT_DAILY_USD) * 1_000_000), calls: Math.floor(num(env.get("CAREER_MODEL_DAILY_CALLS"), DEFAULT_DAILY_CALLS)) };
}

// The person's spend so far today (UTC), from the view over agent_turn_costs. No row: nothing spent yet.
export function supabaseDailySpend(admin: any, userId: string, now: () => number = Date.now): () => Promise<DailySpend> {
  return async () => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const r = await admin.from("agent_daily_costs").select("usd_micros,model_calls").eq("user_id", userId).eq("day", day).maybeSingle();
    if (r.error) throw new Error(`read today's model spend: ${r.error.message}`);
    return { usd_micros: Number(r.data?.usd_micros) || 0, calls: Number(r.data?.model_calls) || 0 };
  };
}

type Call = typeof import("./model_gateway.ts").callModel;
export interface SpendCap {
  call: Call;
  // Why a call was refused this turn ("limit" or "unread" for the person's ceiling; "global" or "global_paused" or
  // "global_unavailable" for the whole product's daily budget, model_budget.ts), or null when none was.
  refused(): "limit" | "unread" | "global" | "global_paused" | "global_unavailable" | null;
  // The sentence the reply carries when a call was refused, or null.
  note(): string | null;
}

// One per turn. read: the spend recorded before this turn (read once, at the first model call). The meters this turn's
// calls use are summed on top, so a turn that crosses the ceiling stops at its next call.
export function spendCap(o: { read: () => Promise<DailySpend>; limits: SpendLimits; call: Call }): SpendCap {
  let base: Promise<DailySpend | null> | null = null;
  const meters = new Set<TurnMeter>();
  let refused: ReturnType<SpendCap["refused"]> = null;
  let globalBlock: BudgetBlock | null = null;
  const call: Call = async (cfg, payload, opts = {}) => {
    base ??= o.read().catch((e) => { console.error("career spend cap:", (e as Error)?.message ?? e); return null; });
    const b = await base;
    if (!b) { refused = "unread"; throw new ModelUnavailableError(0, "spend_unread", "today's model spend could not be read"); }
    let usd = b.usd_micros, calls = b.calls;
    for (const m of meters) { usd += m.usd_micros; calls += m.calls; }
    if (usd >= o.limits.usdMicros || calls >= o.limits.calls) {
      refused = refused ?? "limit";
      throw new ModelUnavailableError(429, "daily_limit", "the person's daily model limit is reached");
    }
    if (opts.meter) meters.add(opts.meter);
    try { return await o.call(cfg, payload, opts); }
    catch (e) {
      // The product-wide daily budget said no (or could not be checked): no request was made; the reply says so in plain words.
      const block = e instanceof ModelUnavailableError ? budgetBlockOfType(e.type) : null;
      if (block) { globalBlock = globalBlock ?? block; refused = refused ?? (block === "limit" ? "global" : block === "paused" ? "global_paused" : "global_unavailable"); }
      throw e;
    }
  };
  return {
    call,
    refused: () => refused,
    note: () => globalBlock ? budgetReply(globalBlock) : refused === "limit" ? LIMIT_NOTE : refused === "unread" ? SPEND_UNREAD_NOTE : null,
  };
}
