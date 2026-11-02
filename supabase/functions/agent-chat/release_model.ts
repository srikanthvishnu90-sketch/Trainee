// RELEASE MODEL (D-038): the model every career reply call uses is part of the deployed SHA, not a hand-set secret, in the
// same pattern as release_config.ts (D-035/D-036). This file is reply code (supabase/functions/agent-chat/), so changing the
// model needs a fresh reply-quality measurement before it can deploy (D-034 S3).
//
//   CAREER_MODEL_DEFAULT   the committed model: the brain, the reply writer, drafts, outreach, the search judge.
//
// The one environment override is the EMERGENCY ROLLBACK:
//
//   supabase secrets set CAREER_MODEL=<priced model> --project-ref <ref>    that model at once, no deploy
//   supabase secrets unset CAREER_MODEL --project-ref <ref>                 back to CAREER_MODEL_DEFAULT
//
// The override is honoured only for a model with a price row in _shared/model_gateway.ts PRICES (an unpriced call cannot be
// capped by the global daily budget) that is not a voice model; anything else (a typo, an unknown id) serves the default.
// The provider follows the model name (modelConfigFor): a claude- id uses ANTHROPIC_API_KEY, any other id OPENAI_API_KEY.
// The rollback is temporary; the lasting change is a reviewed commit to CAREER_MODEL_DEFAULT that passes the deploy standard.
import { type ModelConfig, modelConfigFor, PRICES, VOICE_MODEL } from "../_shared/model_gateway.ts";

type Env = { get(k: string): string | undefined };

// The model this commit serves. Read as text by tests: keep it one line, quoted.
export const CAREER_MODEL_DEFAULT = "gpt-5-mini";
export const CAREER_MODEL_ENV = "CAREER_MODEL";

// The career reply model for this environment: the default unless the rollback names a priced, non-voice model.
export function careerModel(env: Env): string {
  const v = (env.get(CAREER_MODEL_ENV) ?? "").trim();
  if (v && PRICES[v] && !VOICE_MODEL.test(v)) return v;
  return CAREER_MODEL_DEFAULT;
}

// The full config (provider, key, effort) for the career reply model. Every career call site reads this one function.
export function careerModelConfig(env: Env): ModelConfig {
  return modelConfigFor(env, careerModel(env));
}
