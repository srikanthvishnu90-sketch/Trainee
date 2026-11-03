// D-038: the career reply model is one committed default (agent-chat/release_model.ts), read by every career call site;
// CAREER_REPLY_MODEL is the rollback only (CAREER_MODEL stays the OpenAI-only readers'); the provider follows the model name (claude- ids go to Anthropic with
// ANTHROPIC_API_KEY); every model the default or a rollback can name is priced, so the cost ledger and the global daily budget
// stay right. Nothing here reaches a real provider: the provider is a stub fetch.
import { CAREER_MODEL_DEFAULT, careerModel, careerModelConfig, ROLLBACK_MODELS } from "../../supabase/functions/agent-chat/release_model.ts";
import { mailModelConfig } from "../../supabase/functions/_shared/career_mail_model.ts";
import { essayModelConfig } from "../../supabase/functions/_shared/career_essay_card.ts";
import { ANTHROPIC_THINKING_HEADROOM, callModel, costMicros, fromAnthropic, modelConfig, modelConfigFor, newMeter, PRICES, providerFor, toAnthropic } from "../../supabase/functions/_shared/model_gateway.ts";
import { readerModel } from "../../supabase/functions/_shared/career_reader_model.ts";
import { memoryBudgetGate, worstCaseMicros } from "../../supabase/functions/_shared/model_budget.ts";

function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => assert(JSON.stringify(a) === JSON.stringify(b), `${m} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const root = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (s: string) => s.split("\n").map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/\s\/\/ .*$/, "")).join("\n");

Deno.test("D-038: the default is one quoted line, priced from the provider's own page, and not voice", () => {
  const src = read("supabase/functions/agent-chat/release_model.ts");
  const m = /^export const CAREER_MODEL_DEFAULT = "([^"]+)";$/m.exec(src);
  assert(m && m[1] === CAREER_MODEL_DEFAULT, "CAREER_MODEL_DEFAULT is one quoted line");
  const row = PRICES[CAREER_MODEL_DEFAULT];
  assert(row, `the default ${CAREER_MODEL_DEFAULT} has a price row`);
  assert(/^https:\/\//.test(row.source) && /^\d{4}-\d{2}-\d{2}$/.test(row.checked_on), "the row names its source URL and date");
  eq(careerModel(env({})), CAREER_MODEL_DEFAULT, "unset: the default");
});

Deno.test("D-038: every career call site reads the one default; no stray model id or CAREER_MODEL read on the chat path", () => {
  const h = code(read("supabase/functions/agent-chat/handler-career.ts"));
  assert((h.match(/careerModelConfig\(Deno\.env\)/g) ?? []).length >= 8, "the eight career call sites read careerModelConfig");
  const bad: string[] = [];
  for (const e of Deno.readDirSync(new URL("supabase/functions/agent-chat/", root))) {
    if (!e.isFile || !/\.(ts|js)$/.test(e.name) || e.name === "release_model.ts") continue;
    const text = code(read(`supabase/functions/agent-chat/${e.name}`));
    text.split("\n").forEach((l, i) => {
      if (/env\.get\(\s*["']CAREER_MODEL["']\s*\)/.test(l)) bad.push(`${e.name}:${i + 1} reads CAREER_MODEL itself`);
      if (/model:\s*["'](gpt-|o\d|claude-)/.test(l) || /\|\|\s*["'](gpt-|claude-)[\w.-]+["']/.test(l)) bad.push(`${e.name}:${i + 1} hard-codes a model: ${l.trim().slice(0, 100)}`);
    });
  }
  eq(bad, [], "no stray model ids on the chat path");
  for (const f of ["evals/career/run.ts", "evals/career/compare.ts", "evals/career/run-conversations.ts", "evals/career/slice.ts"]) {
    const t = code(read(f));
    assert(t.includes("careerModelConfig(Deno.env)") && !/CAREER_MODEL"\)\s*\|\|/.test(t), `${f} measures the committed model`);
  }
  const wf = read(".github/workflows/brain-eval.yml");
  eq((wf.match(/^\s*CAREER(_REPLY)?_MODEL:.*$/gm) ?? []).map((l) => l.trim()), ["CAREER_REPLY_MODEL: ${{ inputs.model }}"], "brain-eval never pins a model; only the dispatch input names one");
  assert(/ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/.test(wf) && /ANTHROPIC_EVAL_BUDGET_USD: "25"/.test(wf), "the Anthropic key and its own cap reach the run");
});

Deno.test("D-038: CAREER_REPLY_MODEL rolls back only to a listed, priced, keyed model; provider and key follow the name", () => {
  const both = { OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" };
  eq(careerModel(env({ ...both, CAREER_REPLY_MODEL: "claude-haiku-5-5" })), "claude-haiku-5-5", "a listed, keyed rollback is honoured");
  eq(careerModel(env({ ...both, CAREER_REPLY_MODEL: " claude-sonnet-5-5 " })), "claude-sonnet-5-5", "trimmed");
  eq(careerModel(env({ OPENAI_API_KEY: "o", CAREER_REPLY_MODEL: "claude-haiku-5-5" })), CAREER_MODEL_DEFAULT, "no Anthropic key: the default, never an unkeyed provider");
  eq(careerModel(env({ ...both, CAREER_REPLY_MODEL: "gpt-4.1-mini" })), CAREER_MODEL_DEFAULT, "priced but not listed: the default");
  eq(careerModel(env({ ...both, CAREER_REPLY_MODEL: "claude-haiku-5-6" })), CAREER_MODEL_DEFAULT, "a typo serves the default");
  eq(careerModel(env({ ...both, CAREER_MODEL: "claude-haiku-5-5" })), CAREER_MODEL_DEFAULT, "CAREER_MODEL (the OpenAI readers' key) never moves the reply model");
  for (const m of ROLLBACK_MODELS) assert(PRICES[m], `${m} on the rollback list is priced`);
  const a = careerModelConfig(env({ ...both, CAREER_REPLY_MODEL: "claude-haiku-5-5" }));
  eq([a.provider, a.model, a.apiKey], ["anthropic", "claude-haiku-5-5", "a"], "a claude id uses Anthropic's key");
  const o = careerModelConfig(env(both));
  eq([o.provider, o.apiKey], ["openai", "o"], "the default gpt id uses OpenAI's key");
  eq([providerFor("claude-sonnet-5-5"), providerFor("gpt-5-mini")], ["anthropic", "openai"]);
  // The OpenAI-only configs are unchanged: no secret switches their provider (Q3/SEC11).
  eq(modelConfig(env({ OPENAI_API_KEY: "o", MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", OPENAI_MODEL: "claude-haiku-5-5" })).provider, "openai");
});

Deno.test("owner directive 2026-11-02: the four background readers (mail, essay, mock judge, outreach replies) are Claude-only; CAREER_MODEL never sends a gpt id anywhere", () => {
  const claude = env({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", CAREER_MODEL: "claude-sonnet-5-5" });
  const gpt = env({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", CAREER_MODEL: "gpt-4.1-mini" });
  eq([readerModel(claude), readerModel(gpt), readerModel(env({}))], ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-5-5"]);
  for (const e of [claude, gpt, env({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" })]) {
    const mail = mailModelConfig(e), essay = essayModelConfig(e);
    eq([mail.provider, providerFor(mail.model), mail.apiKey], ["anthropic", "anthropic", "a"], "mail");
    eq([essay.provider, providerFor(essay.model), essay.apiKey], ["anthropic", "anthropic", "a"], "essay");
  }
  for (const f of ["supabase/functions/_shared/career_mock_prep.ts", "supabase/functions/career-proactive/index.ts", "supabase/functions/_shared/career_mail_model.ts", "supabase/functions/_shared/career_essay_card.ts"]) {
    const t = code(read(f));
    assert(!/env\.get\(\s*["']CAREER_MODEL["']\s*\)/.test(t) && !t.includes("openaiCareerModel") && /readerModelConfig\(|readerCall\(/.test(t), `${f} reads its model only through career_reader_model.ts`);
  }
});
