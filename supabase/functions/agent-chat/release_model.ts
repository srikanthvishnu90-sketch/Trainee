// RELEASE MODEL (D-038): the model every career reply call uses is part of the deployed SHA, not a hand-set secret, in the
// same pattern as release_config.ts (D-035/D-036). This file is reply code (supabase/functions/agent-chat/), so changing the
// model needs a fresh reply-quality measurement before it can deploy (D-034 S3).
//
//   CAREER_MODEL_DEFAULT   the committed model: the brain, the reply writer, drafts, outreach, the search judge.
//
// SONNET ONLY (owner, 2026-11-09, D-046: "Make sure sonnet 5.5 is the only model used for trainee's output"): the default is
// claude-sonnet-5-5 and it is the only model on ROLLBACK_MODELS, so no setting can move a reply off Sonnet 5.5; there is no
// Haiku default, rollback or fallback. The environment key stays read (CAREER_MODEL is the background readers' key):
//
//   supabase secrets set CAREER_REPLY_MODEL=<allowlisted model> --project-ref <ref>    that model at once, no deploy
//   supabase secrets unset CAREER_REPLY_MODEL --project-ref <ref>                      back to CAREER_MODEL_DEFAULT
//
// It is honoured only for a model on ROLLBACK_MODELS (each priced in _shared/model_gateway.ts PRICES, so the global
// budget caps it) and ANTHROPIC_API_KEY is configured; anything else (a Haiku id, a typo, an unknown id, a non-Claude id, no
// key) is ignored with one log line and serves the default. Every model here is a Claude model (providerFor refuses any other id).
// The rollback is temporary; the lasting change is a reviewed commit to CAREER_MODEL_DEFAULT that passes the deploy standard.
import { assertProductModel, type ModelConfig, modelConfigFor, PRICES, PRODUCT_MODELS, warnIgnoredOnce } from "../_shared/model_gateway.ts";

type Env = { get(k: string): string | undefined };

// The model this commit serves. Read as text by tests: keep it one line, quoted.
export const CAREER_MODEL_DEFAULT = "claude-sonnet-5-5";
export const CAREER_MODEL_ENV = "CAREER_REPLY_MODEL";
// The models a rollback may name (D-038, narrowed by D-046): Sonnet 5.5 only, the product's one model.
export const ROLLBACK_MODELS: readonly string[] = PRODUCT_MODELS;

const keyed = (env: Env, model: string) => !!modelConfigFor(env, model).apiKey.trim(); // the gateway reads the key; nothing here does

// The career reply model for this environment: the default unless the rollback names a listed, priced, keyed model.
export function careerModel(env: Env): string {
  const v = (env.get(CAREER_MODEL_ENV) ?? "").trim();
  if (v && ROLLBACK_MODELS.includes(v) && PRICES[v] && keyed(env, v)) return v;
  if (v) warnIgnoredOnce(CAREER_MODEL_ENV, v, ROLLBACK_MODELS.includes(v) ? "no ANTHROPIC_API_KEY" : "Trainee serves claude-sonnet-5-5 only (D-046)");
  return CAREER_MODEL_DEFAULT;
}

// The full config (provider, key, effort) for the career reply model. Every career call site reads this one function.
export function careerModelConfig(env: Env): ModelConfig {
  return assertProductModel(modelConfigFor(env, careerModel(env))); // D-046 guard: Sonnet 5.5 or nothing
}
