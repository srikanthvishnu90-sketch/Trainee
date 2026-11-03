// The model of the background readers (mail second pass, essay drafts, mock-prep judge, outreach replies): Claude, through
// the gateway's callModel (owner directive 2026-11-02 18:38 CT: Trainee is Claude-only, no OpenAI calls anywhere). One place
// names the default, so the readers never pick a provider, a URL or a key themselves; the provider key is Anthropic's
// (modelConfigFor). CAREER_MODEL is honoured only when it names a Claude model; anything else (a gpt id left in a secret)
// serves the default, so a stale secret can never move a reader off Claude.
//
// DEPENDENCY: the gateway work package (WP1) replaces openaiCareerModel with its own reader-model function and moves the
// career default to Claude. When that lands, readerModel below becomes a one-line call to it; the default stays haiku
// (D-038: Haiku first; Sonnet only if the measurement says so).
import { callModel, type ModelConfig, modelConfigFor, providerFor } from "./model_gateway.ts";

type Env = { get(k: string): string | undefined };

export const READER_MODEL_DEFAULT = "claude-haiku-5-5";

export function readerModel(env: Env): string {
  const v = (env.get("CAREER_MODEL") ?? "").trim();
  return v && providerFor(v) === "anthropic" ? v : READER_MODEL_DEFAULT;
}

// Provider "anthropic", ANTHROPIC_API_KEY, effort per ANTHROPIC_EFFORT: a complete config for callModel.
export function readerModelConfig(env: Env): ModelConfig {
  return modelConfigFor(env, readerModel(env));
}

// A reader's model call: the gateway's callModel (budget reserved first, metered, timed out) on the reader config. `request`
// is only for tests (a fake Anthropic Messages wire); production passes nothing and the gateway uses fetch.
export const readerCall = (env: Env, request?: typeof fetch) => (payload: any): Promise<any> =>
  callModel(readerModelConfig(env), payload, { role: "chat", ...(request ? { request } : {}) });
