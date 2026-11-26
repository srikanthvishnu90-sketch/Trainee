// The career chat's per-turn model wrapper (launch readiness X7, 2026-10-26; per-person cap REMOVED by D-046, 2026-11-09).
//
// Every model call a chat turn makes (the staged brain, drafts, the search judge, the resume rewrite, outreach and
// networking drafts, the mock-interview judge) goes through the one wrapper this module builds, before it reaches the
// gateway's callModel.
//
// D-046 (owner, 2026-11-09: "don't put a per person cap ... Remove all caps as of now that wouldn't destroy the product"):
// there is NO per-person daily AI ceiling. The wrapper never reads a person's spend and never refuses a call on its own.
// CAREER_MODEL_DAILY_USD and CAREER_MODEL_DAILY_CALLS may still be set as production secrets (agents never touch
// production env), so the code IGNORES them, whatever their value, and says so once per boot on the error log.
//
// What stays (it is what keeps runaway spend from destroying the product): the GLOBAL budget in the gateway's callModel
// (_shared/model_budget.ts: the $93 total of D-038a, the reservation before every send, the hard stop and the pause). When
// it refuses a call, this wrapper remembers why, so the reply says so in plain words (note()) and the turn's meta records it
// (refused()). No request was made for a refused call.
import { ModelUnavailableError } from "./model_calls.ts";
import { type BudgetBlock, budgetBlockOfType, budgetReply } from "./model_budget.ts";

type Env = { get(name: string): string | undefined };

// The retired per-person settings: read only to say, once, that they are ignored.
export const IGNORED_PERSON_CAP_ENV: readonly string[] = ["CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS"];
const seen = new Set<string>();
export function warnIgnoredPersonCap(env: Env, log: (line: string) => void = (l) => console.error(l)): string[] {
  const set = IGNORED_PERSON_CAP_ENV.filter((k) => (env.get(k) ?? "").trim() !== "");
  for (const k of set) {
    if (seen.has(k)) continue;
    seen.add(k);
    log(`[model] ${k} is set and ignored: there is no per-person AI cap (D-046); the global model budget still applies`);
  }
  return set;
}
export const resetIgnoredPersonCapWarnings = () => seen.clear();

type Call = typeof import("./model_gateway.ts").callModel;
export type GlobalRefusal = "global" | "global_paused" | "global_unavailable";
export interface SpendCap {
  call: Call;
  // Why the product-wide budget refused a call this turn, or null when none was refused.
  refused(): GlobalRefusal | null;
  // The sentence the reply carries when the global budget refused a call, or null.
  note(): string | null;
}

// One per turn. Calls pass straight through to `call` (the gateway's callModel, which reserves against the global budget
// first). Any other field a caller still passes (the old `read` and `limits`) is ignored: there is no per-person limit.
export function spendCap(o: { call: Call; env?: Env } & Record<string, unknown>): SpendCap {
  if (o.env) warnIgnoredPersonCap(o.env);
  let refused: GlobalRefusal | null = null;
  let globalBlock: BudgetBlock | null = null;
  const call: Call = async (cfg, payload, opts = {}) => {
    try { return await o.call(cfg, payload, opts); }
    catch (e) {
      // The product-wide budget said no (or could not be checked): no request was made; the reply says so in plain words.
      const block = e instanceof ModelUnavailableError ? budgetBlockOfType(e.type) : null;
      if (block) { globalBlock = globalBlock ?? block; refused = refused ?? (block === "limit" ? "global" : block === "paused" ? "global_paused" : "global_unavailable"); }
      throw e;
    }
  };
  return { call, refused: () => refused, note: () => globalBlock ? budgetReply(globalBlock) : null };
}
