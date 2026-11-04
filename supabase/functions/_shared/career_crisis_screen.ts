// Crisis screen, two layers (re-review of #354, 2026-11-01). Every inbound chat message is read by:
//   1. the deterministic list, CareerSafety.isDistress (packages/domain/139-career-safety.js, where its policy is
//      written), the same one the router's first check and 125's screen read; and
//   2. OpenAI's moderation endpoint (omni-moderation-latest, free; OpenAI only, owner rule), its self-harm,
//      self-harm/intent and self-harm/instructions categories, through model_gateway.ts moderate() (the one door to
//      OpenAI: the key, the kill switch and the only unreserved send live there; this module holds no URL or key).
// FAIL-SAFE: if either layer flags, the crisis reply wins. Moderation never blocks the conversation: it starts as soon as
// the message is known (beside the turn's own reads), and if it errors or has not answered within MODERATION_TIMEOUT_MS
// the list's verdict stands and the failure is logged (never the message text). A list hit answers at once.
//
// ARCHITECT DECISION (2026-11-02): moderation is the PRIMARY layer; a word list overfits to the phrasings it has seen
// (evals/crisis/: the sealed corpus measures both layers). It is ON BY DEFAULT from this committed release constant, not
// from a deploy script; the one environment override is the EMERGENCY DISABLE, CAREER_CRISIS_MODERATION=off. (This
// constant moves into agent-chat/release_config.ts once that file lands, #371.) With no OpenAI key the list answers
// alone and one loud error line says so per cold start.
import { CareerSafety } from "./router_core.career.js";
import { callModel, type ModelConfig, modelConfig, modelConfigFor, moderate, moderationConfigured, PRICES } from "./model_gateway.ts";

export const MODERATION_TIMEOUT_MS = 1500;
export const SELF_HARM_CATEGORIES = ["self-harm", "self-harm/intent", "self-harm/instructions"] as const;

export interface ModerationResult { flagged: boolean; categories: string[] }
// A moderation client: resolves the self-harm reading of one text, or rejects. It must honour the signal.
export type Moderate = (text: string, signal: AbortSignal) => Promise<ModerationResult>;
export type ModerationState = "flagged" | "clear" | "timeout" | "error" | "off" | "skipped";
export interface CrisisVerdict { distress: boolean; rules: boolean; moderation: ModerationState; categories: string[] }
type Env = { get(name: string): string | undefined };

export const rulesDistress = (message: string): boolean => (CareerSafety as { isDistress: (t: string) => boolean }).isDistress(message);

// A moderation response body (OpenAI's shape: results[0].categories) read for the three self-harm categories only; any
// other category is not this screen's business. Throws on a body with no result, so the caller falls back to the list.
export function readModeration(body: unknown): ModerationResult {
  const r = (body as { results?: { categories?: Record<string, unknown> }[] } | null)?.results?.[0];
  if (!r || typeof r.categories !== "object" || r.categories === null) throw new Error("moderation: no result");
  const categories = SELF_HARM_CATEGORIES.filter((c) => r.categories![c] === true);
  return { flagged: categories.length > 0, categories };
}

// The highest self-harm category score (0..1) in a moderation body, for the eval's threshold curve (evals/crisis/run.ts).
export function readModerationScore(body: unknown): number {
  const r = (body as { results?: { category_scores?: Record<string, unknown> }[] } | null)?.results?.[0];
  const s = r?.category_scores ?? {};
  return Math.max(0, ...SELF_HARM_CATEGORIES.map((c) => Number((s as Record<string, unknown>)[c]) || 0));
}

// The client: model_gateway.ts's moderation door (the one door to OpenAI; it reads the key and honours the kill switch).
export type ModerateDoor = (text: string, o: { signal?: AbortSignal; timeoutMs?: number }) => Promise<unknown>;
export function gatewayModeration(door: ModerateDoor = moderate): Moderate {
  return async (text, signal) => readModeration(await door(text, { signal, timeoutMs: MODERATION_TIMEOUT_MS }));
}

// The release: moderation on. Read as text by tests; keep it one quoted line.
export const PRODUCTION_CRISIS_MODERATION: "on" | "off" = "on";
export const CRISIS_MODERATION_DISABLE_ENV = "CAREER_CRISIS_MODERATION";
let warnedNoKey = false;
// THE ONE READ of the release flag. When the release-flags PR lands, this body becomes
//   return releaseFlagOn(env, "CAREER_CRISIS_MODERATION");   (import from ../agent-chat/release_config.ts)
// and this file goes into RELEASE_FLAG_PATHS in scripts/launch/reply-code.ts. Same meaning: on unless rolled back (=off).
export function moderationReleaseOn(env: Env, release: "on" | "off" = PRODUCTION_CRISIS_MODERATION): boolean {
  return release === "on" && (env.get(CRISIS_MODERATION_DISABLE_ENV) || "").trim().toLowerCase() !== "off";
}
// The client agent-chat uses, or null when the second layer is off: the release constant, unless the emergency disable is
// set (CAREER_CRISIS_MODERATION=off); without a key it is off and says so loudly, once per cold start.
export function moderationFromEnv(env: Env, door?: ModerateDoor, o: { release?: "on" | "off"; log?: (line: string) => void } = {}): Moderate | null {
  if (!moderationReleaseOn(env, o.release)) return null;
  if (!door && !moderationConfigured(env)) {
    if (!warnedNoKey) { warnedNoKey = true; (o.log ?? ((l: string) => console.error(l)))("CRISIS SCREEN DEGRADED: the moderation layer is OFF (Claude only, D-038a), so the word list and the Claude classifier screen for crisis messages."); }
    return null;
  }
  return gatewayModeration(door);
}

// ---- Layer 3: the crisis classifier (#354 re-review 2, architect decision; the owner said ship the best option) ----------
// A narrow yes/no question to a small model through callModel (the one door: key, kill switch, budget reservation). It reads
// indirect and contextual signals the list and moderation miss. Prompt TUNED ON evals/crisis/corpus.dev.json ONLY. The
// fixed marker lets test fakes recognise this call. Cost: the global daily budget reserves and settles every call; it is
// NOT yet in the per-turn agent_turn_costs row (a known gap with a follow-up: that needs a row kind, i.e. a migration).
export const CRISIS_SCREEN_MARKER = "TRAINEE_CRISIS_SCREEN";
export const PRODUCTION_CRISIS_CLASSIFIER: "on" | "off" = "on";
export const CRISIS_CLASSIFIER_DISABLE_ENV = "CAREER_CRISIS_CLASSIFIER";
export const CRISIS_MODEL_ENV = "CAREER_CRISIS_MODEL";
// null: the gateway's current default model (modelConfig). The chosen default is "claude-haiku-5-5" (architect 2026-11-02:
// output_config.effort "low", thinking disabled; $0.10 in / $0.50 out per 1M): a one-line swap here once the model agent's
// Anthropic support and price row land in model_gateway.ts. Its CI measurement waits for the owner's Anthropic secret.
export const CRISIS_CLASSIFIER_DEFAULT_MODEL: string | null = null;
export const CLASSIFIER_TIMEOUT_MS = 2500;
export const CLASSIFIER_PROMPT = `${CRISIS_SCREEN_MARKER}
You screen ONE chat message sent to a career assistant. Reply with exactly one word: YES or NO.
YES if the message suggests the writer may be at risk of suicide or self-harm, now or soon, said directly or indirectly, in any language, slang, typos or leetspeak. Signals: wanting to die, not exist or not wake up; feeling like a burden or that others are better off without them; a plan, a method or the means (pills, rope, a gun, a knife or razor, a bridge, a roof, the tracks, traffic, a car running in a garage); a time ("tonight", "this weekend"); goodbyes or a last message; a note or letters written; giving belongings away; saying they won't be around or won't need things; self-harm such as cutting or burning; asking how to die or how much of something is lethal.
NO for frustration or hyperbole about work, school or the job search ("this job is killing me", "kill it in the interview", "i'm going to burn myself out applying"), someone else's death, jobs in health care or crisis work, and idioms.
If you are unsure whether the writer is at risk, answer YES.`;
export type ModelCall = (cfg: ModelConfig, payload: unknown, o: { role?: "router"; timeoutMs?: number }) => Promise<any>;
export function classifierReleaseOn(env: Env, release: "on" | "off" = PRODUCTION_CRISIS_CLASSIFIER): boolean {
  return release === "on" && (env.get(CRISIS_CLASSIFIER_DISABLE_ENV) || "").trim().toLowerCase() !== "off";
}
let warnedClassifier = "";
export function classifierFromEnv(env: Env, call: ModelCall = callModel, o: { release?: "on" | "off"; log?: (line: string) => void } = {}): Moderate | null {
  if (!classifierReleaseOn(env, o.release)) return null;
  const model = (env.get(CRISIS_MODEL_ENV) || "").trim() || CRISIS_CLASSIFIER_DEFAULT_MODEL || modelConfig(env, "chat").model;
  const warn = (why: string) => { if (warnedClassifier !== why) { warnedClassifier = why; (o.log ?? ((l: string) => console.error(l)))(`CRISIS CLASSIFIER OFF: ${why}; the list and moderation screen alone.`); } };
  if (!PRICES[model]) { warn(`model ${model} has no price in model_gateway.ts PRICES, so it is refused`); return null; }
  let cfg: ModelConfig;
  try { cfg = modelConfigFor(env, model); } catch { warn(`model ${model} is not a Claude model (D-038a: Claude only)`); return null; }
  if (!cfg.apiKey) { warn("no model key"); return null; }
  return async (text) => {
    const r = await call(cfg, { system: CLASSIFIER_PROMPT, messages: [{ role: "user", content: String(text ?? "").slice(0, 2000) }], max_tokens: 4 }, { role: "router", timeoutMs: CLASSIFIER_TIMEOUT_MS });
    const said = (Array.isArray(r?.content) ? r.content : []).filter((b: any) => b && b.type === "text").map((b: any) => String(b.text)).join(" ").trim();
    if (/^\W*yes\b/i.test(said)) return { flagged: true, categories: ["classifier"] };
    if (/^\W*no\b/i.test(said)) return { flagged: false, categories: [] };
    throw new Error("classifier: no yes or no");
  };
}

// The screen's layers for one turn.
export interface ScreenLayers { moderation?: Moderate | null; classifier?: Moderate | null }
export type LayerState = ModerationState;
export interface ScreenVerdict extends CrisisVerdict { classifier: LayerState }

// Start the screen for one message. Every layer runs at once; the promise resolves as soon as ANY layer flags, or when
// every layer has answered, failed or timed out. It never rejects. A moderation failure is logged (never the text); a
// classifier failure is not logged (the architect's rule); neither ever suppresses another layer's yes.
export function crisisScreen(message: string, layers: Moderate | null | ScreenLayers, opts: { timeoutMs?: number; classifierTimeoutMs?: number; log?: (line: string) => void } = {}): Promise<ScreenVerdict> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const L: ScreenLayers = typeof layers === "function" || layers === null ? { moderation: layers } : layers;
  const rules = rulesDistress(message);
  const off = (c?: Moderate | null): LayerState => (c ? "skipped" : "off");
  if (rules) return Promise.resolve({ distress: true, rules, moderation: off(L.moderation), classifier: off(L.classifier), categories: [] });
  if (!String(message ?? "").trim()) return Promise.resolve({ distress: false, rules, moderation: "off", classifier: "off", categories: [] });
  const one = (client: Moderate | null | undefined, ms: number, name: string, logIt: boolean): Promise<{ state: LayerState; categories: string[] }> => {
    if (!client) return Promise.resolve({ state: "off", categories: [] });
    const ctl = new AbortController();
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: { state: LayerState; categories: string[] }) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => { if (logIt) log(`crisis screen: ${name} timed out after ${ms} ms; the other layers stand`); ctl.abort(); finish({ state: "timeout", categories: [] }); }, ms);
      let call: Promise<ModerationResult>;
      try { call = client(message, ctl.signal); } catch (e) { call = Promise.reject(e); }
      call.then((r) => finish({ state: r.flagged ? "flagged" : "clear", categories: r.categories ?? [] }),
        (e) => { if (!done && logIt) log(`crisis screen: ${name} failed (${e instanceof Error ? e.message : String(e)}); the other layers stand`); finish({ state: "error", categories: [] }); });
    });
  };
  return new Promise<ScreenVerdict>((resolve) => {
    const st: { moderation: LayerState; classifier: LayerState; categories: string[] } = { moderation: L.moderation ? "skipped" : "off", classifier: L.classifier ? "skipped" : "off", categories: [] };
    let pending = 0, settled = false;
    const verdict = (): ScreenVerdict => ({ distress: st.moderation === "flagged" || st.classifier === "flagged", rules, moderation: st.moderation, classifier: st.classifier, categories: st.categories });
    const check = () => { if (settled) return; const v = verdict(); if (v.distress || pending === 0) { settled = true; resolve(v); } };
    const run = (key: "moderation" | "classifier", p: Promise<{ state: LayerState; categories: string[] }>) => {
      pending++;
      p.then((r) => { st[key] = r.state; st.categories = [...st.categories, ...r.categories]; pending--; check(); });
    };
    if (L.moderation) run("moderation", one(L.moderation, opts.timeoutMs ?? MODERATION_TIMEOUT_MS, "moderation", true));
    if (L.classifier) run("classifier", one(L.classifier, opts.classifierTimeoutMs ?? CLASSIFIER_TIMEOUT_MS, "classifier", false));
    if (pending === 0) { settled = true; resolve({ distress: false, rules, moderation: "off", classifier: "off", categories: [] }); }
  });
}
