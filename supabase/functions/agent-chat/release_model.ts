// RELEASE MODEL (D-038): the model every career reply call uses is part of the deployed SHA, not a hand-set secret, in the
// same pattern as release_config.ts (D-035/D-036). This file is reply code (supabase/functions/agent-chat/), so changing the
// model needs a fresh reply-quality measurement before it can deploy (D-034 S3).
//
//   CAREER_MODEL_DEFAULT   the committed model: the brain, the reply writer, drafts, outreach, the search judge.
//
// Claude-only (owner, 2026-11-02 18:38 CT): the default is claude-haiku-5-5; claude-sonnet-5-5 stays an allowed rollback.
// The one environment override is the EMERGENCY ROLLBACK, on its own key (CAREER_MODEL is the background readers' key):
//
//   supabase secrets set CAREER_REPLY_MODEL=<allowlisted model> --project-ref <ref>    that model at once, no deploy
//   supabase secrets unset CAREER_REPLY_MODEL --project-ref <ref>                      back to CAREER_MODEL_DEFAULT
//
// It is honoured only for a model on ROLLBACK_MODELS (each priced in _shared/model_gateway.ts PRICES, so the global daily
// budget caps it) and ANTHROPIC_API_KEY is configured; anything else (a typo, an unknown id, a non-Claude id, no key) serves
// the default. Every model here is a Claude model (providerFor refuses any other id).
// The rollback is temporary; the lasting change is a reviewed commit to CAREER_MODEL_DEFAULT that passes the deploy standard.
import { type ModelConfig, modelConfigFor, PRICES } from "../_shared/model_gateway.ts";

type Env = { get(k: string): string | undefined };

// The model this commit serves. Read as text by tests: keep it one line, quoted.
export const CAREER_MODEL_DEFAULT = "claude-haiku-5-5";
export const CAREER_MODEL_ENV = "CAREER_REPLY_MODEL";
// The models a rollback may name (D-038): the current default and Sonnet 5.5.
export const ROLLBACK_MODELS: readonly string[] = ["claude-haiku-5-5", "claude-sonnet-5-5"];

const keyed = (env: Env, model: string) => !!modelConfigFor(env, model).apiKey.trim(); // the gateway reads the key; nothing here does

// The career reply model for this environment: the default unless the rollback names a listed, priced, keyed model.
export function careerModel(env: Env): string {
  const v = (env.get(CAREER_MODEL_ENV) ?? "").trim();
  if (v && ROLLBACK_MODELS.includes(v) && PRICES[v] && keyed(env, v)) return v;
  return CAREER_MODEL_DEFAULT;
}

// The full config (provider, key, effort) for the career reply model. Every career call site reads this one function.
export function careerModelConfig(env: Env): ModelConfig {
  return modelConfigFor(env, careerModel(env));
}
