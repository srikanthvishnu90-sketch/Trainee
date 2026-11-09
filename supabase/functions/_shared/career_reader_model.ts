// The model of the background readers (mail second pass, essay drafts, mock-prep judge, outreach replies): Claude, through
// the gateway's callModel (owner directive 2026-11-02 18:38 CT: Trainee is Claude-only, no OpenAI calls anywhere). One place
// names the default, so the readers never pick a provider, a URL or a key themselves; the provider key is Anthropic's
// (modelConfigFor). Sonnet only (D-046): CAREER_MODEL naming anything but claude-sonnet-5-5 (a Haiku id, a gpt id left in a
// secret) is ignored with one log line, so a stale secret can never move a reader off Sonnet 5.5.
//
import { assertProductModel, callModel, type ModelConfig, modelConfigFor, readerModel, TRAINEE_MODEL } from "./model_gateway.ts";
export { readerModel };

type Env = { get(k: string): string | undefined };

export const READER_MODEL_DEFAULT = TRAINEE_MODEL;

// Provider "anthropic", ANTHROPIC_API_KEY, effort per ANTHROPIC_EFFORT: a complete config for callModel.
export function readerModelConfig(env: Env): ModelConfig {
  return assertProductModel(modelConfigFor(env, readerModel(env))); // D-046 guard: Sonnet 5.5 or nothing
}

// A reader's model call: the gateway's callModel (budget reserved first, metered, timed out) on the reader config. `request`
// is only for tests (a fake Anthropic Messages wire); production passes nothing and the gateway uses fetch.
export const readerCall = (env: Env, request?: typeof fetch) => (payload: any): Promise<any> =>
  callModel(assertProductModel(readerModelConfig(env)), payload, { role: "chat", ...(request ? { request } : {}) });
