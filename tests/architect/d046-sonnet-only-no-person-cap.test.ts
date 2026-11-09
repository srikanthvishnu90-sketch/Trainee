// D-046 (owner, 2026-11-09, in the architect's chat): "Make sure sonnet 5.5 is the only model used for trainee's output." and
// "don't put a per person cap ... Remove all caps as of now that wouldn't destroy the product."
//   Part 1  the resolvers: every way the product picks a model gives claude-sonnet-5-5; Haiku or any other value in a setting is
//           ignored with one log line, never a fallback.
//   Part 2  the registry: a walk of every product source file (supabase/functions, workers, packages) finds every model call
//           site, each is on the list below with the resolver it uses, and no product file names another model id.
//   Part 3  end to end on the gateway (fake provider, $0): each resolver's config sends model claude-sonnet-5-5, with Sonnet 5.5's
//           API constraints (no thinking disabled, no forced tool_choice).
//   Part 4  the per-person cap is gone: the wrapper never reads a person's spend and never refuses; CAREER_MODEL_DAILY_USD and
//           CAREER_MODEL_DAILY_CALLS are ignored with one log line; the GLOBAL budget still stops every call and the reply says so.
//   Part 5  pricing: Sonnet's row is priced, and the typical-turn estimate from the eval token profile.
// Fakes only: no key, no network, no spend.
import assertNode from "node:assert/strict";
import * as Gateway from "../../supabase/functions/_shared/model_gateway.ts";
import * as Budget from "../../supabase/functions/_shared/model_budget.ts";
import { ModelUnavailableError } from "../../supabase/functions/_shared/model_calls.ts";
import { IGNORED_PERSON_CAP_ENV, resetIgnoredPersonCapWarnings, spendCap, warnIgnoredPersonCap } from "../../supabase/functions/_shared/career_spend_cap.ts";
import { CAREER_MODEL_DEFAULT, careerModel, careerModelConfig, ROLLBACK_MODELS } from "../../supabase/functions/agent-chat/release_model.ts";
import { READER_MODEL_DEFAULT, readerModelConfig } from "../../supabase/functions/_shared/career_reader_model.ts";
import { EST } from "../../evals/career/eval_budget.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SONNET = "claude-sonnet-5-5";
const ROOT = new URL("../../", import.meta.url);
const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const KEY = { ANTHROPIC_API_KEY: "sk-ant-test-not-real" };

// Capture console.error lines while fn runs.
async function logs<T>(fn: () => T | Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [], orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { out: await fn(), lines }; } finally { console.error = orig; }
}

// ---- Part 1: the resolvers -----------------------------------------------------------------------------------------------
Deno.test("D-046 resolvers: every default and allowlist is claude-sonnet-5-5 only", () => {
  eq(Gateway.TRAINEE_MODEL, SONNET);
  eq(Gateway.CLAUDE_DEFAULT_MODEL, SONNET, "the gateway default (router, planner, probe, people provider)");
  eq([...Gateway.PRODUCT_MODELS], [SONNET]);
  eq(CAREER_MODEL_DEFAULT, SONNET, "the brain, reply writer, drafts, outreach, search judge, tailoring");
  eq([...ROLLBACK_MODELS], [SONNET], "no Haiku rollback");
  eq(READER_MODEL_DEFAULT, SONNET, "mail, essay, mock prep, outreach replies");
  const src = Deno.readTextFileSync(new URL("supabase/functions/agent-chat/release_model.ts", ROOT));
  assert(/^export const CAREER_MODEL_DEFAULT = "claude-sonnet-5-5";$/m.test(src), "CAREER_MODEL_DEFAULT stays one quoted line");
});

Deno.test("D-046 resolvers: a Haiku or other value in CAREER_REPLY_MODEL, CAREER_MODEL or MODEL_PROVIDER is ignored once, Sonnet is used", async () => {
  const bad = ["claude-haiku-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5", "gpt-5-mini", "claude-sonnet-5-6", " "];
  for (const v of bad) {
    Gateway.resetIgnoredWarnings();
    const r = await logs(() => [careerModel(env({ ...KEY, CAREER_REPLY_MODEL: v })), careerModel(env({ ...KEY, CAREER_REPLY_MODEL: v })),
      careerModelConfig(env({ ...KEY, CAREER_REPLY_MODEL: v })).model, Gateway.readerModel(env({ CAREER_MODEL: v })), Gateway.readerModel(env({ CAREER_MODEL: v })),
      readerModelConfig(env({ ...KEY, CAREER_MODEL: v })).model, Gateway.modelConfig(env({ ...KEY, MODEL_PROVIDER: "openai", CAREER_MODEL: v }), "router").model]);
    eq(r.out, Array(7).fill(SONNET), `value ${JSON.stringify(v)}: Sonnet everywhere`);
    if (v.trim()) {
      eq(r.lines.filter((l) => l.includes("CAREER_REPLY_MODEL")).length, 1, `one log line for CAREER_REPLY_MODEL=${v}: ${r.lines}`);
      eq(r.lines.filter((l) => l.includes("CAREER_MODEL=")).length, 1, `one log line for CAREER_MODEL=${v}: ${r.lines}`);
      assert(r.lines.every((l) => !/using claude-haiku/.test(l) && /claude-sonnet-5-5/.test(l)), `never "using Haiku": ${r.lines}`);
    }
  }
  Gateway.resetIgnoredWarnings();
  const ok = await logs(() => [careerModel(env({ ...KEY, CAREER_REPLY_MODEL: SONNET })), Gateway.readerModel(env({ CAREER_MODEL: SONNET }))]);
  eq(ok.out, [SONNET, SONNET]); eq(ok.lines, [], "Sonnet named explicitly is no warning");
  eq(careerModel(env({})), SONNET, "no key, no setting: Sonnet");
});

// ---- Part 2: the registry -------------------------------------------------------------------------------------------------
// Every product file that makes or configures a model call, and how it picks the model. A new call site fails this test until it
// is added here with a resolver that gives Sonnet (then Part 3 covers it).
const CALL_SITES: Record<string, string> = {
  "supabase/functions/_shared/model_gateway.ts": "the one door (callModel); modelConfig -> CLAUDE_DEFAULT_MODEL, readerModel -> TRAINEE_MODEL",
  "supabase/functions/agent-chat/release_model.ts": "careerModel / careerModelConfig (CAREER_MODEL_DEFAULT)",
  "supabase/functions/_shared/career_reader_model.ts": "readerModelConfig / readerCall (readerModel)",
  "supabase/functions/agent-chat/handler-career.ts": "careerModelConfig: brain, planner, drafts, outreach, reply writer, networking, search judge, tailoring rewrite",
  "supabase/functions/agent-chat/handler.ts": "modelConfig: router, planner, chat",
  "supabase/functions/_shared/model_health.ts": "modelConfig: the health probe",
  "supabase/functions/_shared/career_people_provider.ts": "modelConfig: the people reader",
  "supabase/functions/_shared/career_mail_model.ts": "readerModelConfig: the mail second pass",
  "supabase/functions/_shared/career_essay_card.ts": "readerModelConfig: essay drafts",
  "supabase/functions/_shared/career_mock_prep.ts": "readerModelConfig: the mock-prep judge",
  "supabase/functions/career-proactive/index.ts": "readerCall: outreach replies",
  "workers/career-browser/prepare-ahead.ts": "careerModelConfig: prepare-ahead tailoring",
};
const RESOLVER = /\b(modelConfig|modelConfigFor|careerModelConfig|readerModelConfig|readerCall|careerModel|readerModel)\s*\(|api\.anthropic\.com/;
// A Claude model id literal: claude-<family>-<n> (comments included: a doc line naming Haiku as the product model is wrong too).
const MODEL_ID = /\bclaude-(haiku|sonnet|opus|fable|mythos|instant)-[0-9][0-9a-z-]*/gi;
async function* walk(dir: URL, rel: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const r = `${rel}${e.name}`;
    if (e.isDirectory) yield* walk(new URL(`${e.name}/`, dir), `${r}/`);
    else if (/\.(ts|js|mjs|cjs|py)$/.test(e.name)) yield r;
  }
}
async function productFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const d of ["supabase/functions/", "workers/", "packages/"]) {
    try { for await (const f of walk(new URL(d, ROOT), d)) out.push(f); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  }
  return out.sort();
}

Deno.test("D-046 registry: every model call site in the product is listed, and no product file names a model other than Sonnet 5.5", async () => {
  const files = await productFiles();
  assert(files.length > 100, `the walk found the product (${files.length} files)`);
  const sites: string[] = [], others: string[] = [];
  for (const f of files) {
    const text = await Deno.readTextFile(new URL(f, ROOT));
    // the bundled router cores are built from packages/ (checked there); they make no model call of their own
    if (!/router_core[^/]*\.js$/.test(f) && RESOLVER.test(text.replace(/^\s*\/\/.*$/gm, ""))) sites.push(f);
    for (const m of text.matchAll(MODEL_ID)) {
      const id = m[0].toLowerCase();
      if (id === SONNET) continue;
      // The one allowed exception: the gateway's price table keeps Haiku 5.5 priced for the eval judges (Judge B), and its request
      // translation keeps Haiku's thinking rule for them; neither can make the product serve it (Parts 1 and 3).
      const line = text.slice(text.lastIndexOf("\n", m.index!) + 1, text.indexOf("\n", m.index!));
      if (f === "supabase/functions/_shared/model_gateway.ts" && (/^\s*"claude-haiku-5-5": \{ input:/.test(line) || /^\s*if \(\/\^claude-haiku-5\/i\.test\(cfg\.model\)\) body\.thinking = \{ type: "disabled" \};$/.test(line))) continue;
      others.push(`${f}: ${id} in "${line.trim().slice(0, 120)}"`);
    }
  }
  eq(others, [], "no product file names a non-Sonnet model id");
  eq(sites, Object.keys(CALL_SITES).sort(), "every model call site is registered (add a new one to CALL_SITES with its resolver)");
  // No product call site hand-picks a model: modelConfigFor is called only with a resolver's result.
  for (const f of sites) {
    const text = (await Deno.readTextFile(new URL(f, ROOT))).replace(/^\s*\/\/.*$/gm, "");
    const calls = [...text.matchAll(/(?<!function )modelConfigFor\(/g)].length;
    const good = [...text.matchAll(/(?<!function )modelConfigFor\(\s*\w+,\s*(careerModel\(env\)|readerModel\(env\)|CLAUDE_DEFAULT_MODEL|model)\s*\)/g)].length;
    eq(good, calls, `${f}: every modelConfigFor(...) takes a resolver's model, never a literal`);
    assert(!/model:\s*["'`]claude-/.test(text), `${f}: no literal model in a request`);
  }
});

// ---- Part 3: end to end on the gateway --------------------------------------------------------------------------------------
function fakeProvider() {
  const bodies: any[] = [];
  const request = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { request, bodies };
}

Deno.test("D-046 gateway: each resolver's config sends claude-sonnet-5-5, with Sonnet 5.5's thinking and tool_choice rules", async () => {
  const stale = env({ ...KEY, CAREER_MODEL: "claude-haiku-5-5", CAREER_REPLY_MODEL: "claude-haiku-5-5", MODEL_PROVIDER: "openai", ANTHROPIC_MODEL: "claude-haiku-5-5" });
  const configs = { career: careerModelConfig(stale), reader: readerModelConfig(stale), router: Gateway.modelConfig(stale, "router"), planner: Gateway.modelConfig(stale, "planner"), probe: Gateway.modelConfig(stale, "probe") };
  const forced = { system: "s", messages: [{ role: "user", content: "hi" }], max_tokens: 100, tools: [{ name: "route", input_schema: { type: "object" } }, { name: "other", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "route" } };
  for (const [name, cfg] of Object.entries(configs)) {
    const p = fakeProvider();
    await Gateway.callModel(cfg, forced, { request: p.request, budget: Budget.memoryBudgetGate() });
    eq(p.bodies.length, 1, name);
    const b = p.bodies[0];
    eq(b.model, SONNET, `${name}: the model sent`);
    eq(b.thinking, { type: "between_tools" }, `${name}: thinking is never "disabled" on Sonnet 5.5 (a 400)`);
    eq(b.tool_choice, { type: "auto" }, `${name}: a forced tool_choice is sent as auto (NO_FORCED_TOOL)`);
    eq(b.tools.map((t: any) => t.name), ["route"], `${name}: a forced single tool is sent alone`);
    eq(b.max_tokens, 100 + Gateway.ANTHROPIC_THINKING_HEADROOM, `${name}: thinking headroom`);
  }
});

// ---- Part 4: no per-person cap; the global budget stays -----------------------------------------------------------------------
const cfgS = (): Gateway.ModelConfig => ({ provider: "anthropic", model: SONNET, apiKey: "sk-ant-test-not-real", reasoningEffort: "low" });
const payload = { messages: [{ role: "user", content: "hi" }], max_tokens: 50 };

Deno.test("D-046 no per-person cap: 500 calls in one turn all go, whatever a person spent today or what the old settings say", async () => {
  let sent = 0, reads = 0;
  const cap = spendCap({
    call: (async () => { sent++; return { content: [] }; }) as any,
    // the retired fields, as an old caller would pass them: ignored
    read: async () => { reads++; return { usd_micros: 1e12, calls: 1e9 }; }, limits: { usdMicros: 0, calls: 0 },
    env: env({ CAREER_MODEL_DAILY_USD: "0", CAREER_MODEL_DAILY_CALLS: "1" }),
  });
  for (let k = 0; k < 500; k += 5) await Promise.all(Array.from({ length: 5 }, () => cap.call(cfgS(), payload, {})));
  eq(sent, 500, "every call reached the gateway"); eq(reads, 0, "no person's spend is read");
  eq(cap.refused(), null); eq(cap.note(), null, "no limit note");
  assert(!("exhausted" in cap), "there is no per-person allowance to ask about");
});

Deno.test("D-046 no per-person cap: CAREER_MODEL_DAILY_USD / CAREER_MODEL_DAILY_CALLS set in production are ignored with one log line each", () => {
  resetIgnoredPersonCapWarnings();
  const lines: string[] = [];
  const e = env({ CAREER_MODEL_DAILY_USD: "0.05", CAREER_MODEL_DAILY_CALLS: "100" });
  eq(warnIgnoredPersonCap(e, (l) => lines.push(l)), [...IGNORED_PERSON_CAP_ENV]);
  warnIgnoredPersonCap(e, (l) => lines.push(l));
  eq(lines.length, 2, `once per variable: ${lines}`);
  assert(lines.every((l) => /ignored/.test(l) && /global model budget still applies/.test(l)), lines.join("\n"));
  eq(warnIgnoredPersonCap(env({}), (l) => lines.push(l)), [], "unset: nothing said");
});

Deno.test("D-046 global budget stays: an exhausted $70 total refuses every call before any request, and the reply says so", async () => {
  const gate = Budget.memoryBudgetGate(10); // 10 micro-dollars: less than any Sonnet request's worst case
  const p = fakeProvider();
  const cap = spendCap({ call: (c, pl, o) => Gateway.callModel(c, pl, { ...o, budget: gate, request: p.request }) });
  for (let i = 0; i < 3; i++) {
    const err = await cap.call(cfgS(), payload, {}).then(() => null, (e) => e);
    assert(err instanceof ModelUnavailableError && err.type === "global_daily_limit", `call ${i}: refused by the global budget (${err})`);
  }
  eq(p.bodies.length, 0, "nothing was sent");
  eq(cap.refused(), "global");
  eq(cap.note(), Budget.GLOBAL_LIMIT_REPLY, "the reply says the AI budget stopped it, in plain words");
  eq(Budget.DEFAULT_HARD_USD, 70, "the $70 total (D-038a) is unchanged");
});

Deno.test("D-046 the per-person path is gone from replies and the handler", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, ROOT));
  const handler = await read("supabase/functions/agent-chat/handler-career.ts");
  for (const gone of ["spend.exhausted()", "spendLimitsFromEnv", "supabaseDailySpend", "capViewFor", "LIMIT_NOTE", "SPEND_UNREAD_NOTE", "capHeld"]) assert(!handler.includes(gone), `handler-career.ts no longer has ${gone}`);
  assert(/spendCap\(\{ call: callModelUncapped, env: Deno\.env \}\)/.test(handler), "the turn's calls still go through the one wrapper");
  const cap = await read("supabase/functions/_shared/career_spend_cap.ts");
  assert(!/today's limit on AI-written|DEFAULT_DAILY_USD|DEFAULT_DAILY_CALLS|agent_daily_costs/.test(cap), "no per-person limit text, default or spend read");
  const net = await read("supabase/functions/_shared/career_networking.ts");
  assert(!/today's limit on AI-written drafts/.test(net) && !/\/daily_limit\|/.test(net), "drafts are never said to hit a person's daily limit");
  for (const p of ["supabase/functions", "workers"]) {
    for await (const f of walk(new URL(`${p}/`, ROOT), `${p}/`)) {
      const t = await read(f);
      assert(!/today's limit on AI-written/.test(t), `${f}: no per-person "limit on AI-written answers" reply`);
    }
  }
});

// ---- Part 5: pricing ----------------------------------------------------------------------------------------------------------
Deno.test("D-046 pricing: Sonnet 5.5 is priced (Anthropic's page; re-read 2026-11-09, unchanged), so the $70 budget counts it; typical-turn estimate", () => {
  const p = Gateway.PRICES[SONNET];
  eq([p.input, p.cache_write, p.cached, p.output, p.long_context], [2, 2.5, 0.1, 10, undefined], "$2 in, $2.50 5m write, $0.10 hit, $10 out, no long-context surcharge");
  eq(p.checked, "verified");
  // a Sonnet request is reserved at its own price, never at zero
  const worst = Budget.worstCaseMicros(SONNET, Gateway.PRICES, { bytes: 4000, images: 0, maxOutputTokens: 1000 });
  assert(worst > 0, `worst case ${worst}`);
  // Typical turn, from the eval token profile (evals/career/eval_budget.ts EST: measured first-request input, Sonnet output per
  // step) and the measured steps per turn x the Claude step factor; no prompt caching assumed (an upper estimate).
  const step = Gateway.costMicros(SONNET, { input_tokens: EST.request_in_tokens.agent, output_tokens: EST.out_tokens_per_step.sonnet })!;
  const staged = step * EST.steps_per_item.staged * EST.claude_step_factor, agent = step * EST.steps_per_item.agent * EST.claude_step_factor;
  console.log(`[d046] Sonnet 5.5 per step $${(step / 1e6).toFixed(4)}; typical staged turn $${(staged / 1e6).toFixed(4)}; agent turn $${(agent / 1e6).toFixed(4)}`);
  eq(step, 26_000, "11,000 in x $2 + 400 out x $10 = $0.026 a step");
});

// ---- Part 6: the runtime guard at the product doors (architect, 2026-11-09, option b) ----------------------------------------
// The doors the product picks its model through refuse anything but Sonnet 5.5, with no exemption. The raw gateway stays the
// eval door; Part 2's registry is the CI catch for a product file that reaches it with a model of its own.
Deno.test("D-046 guard: assertProductModel passes Sonnet 5.5 and refuses every other model, with no exemption", () => {
  const cfg = (model: string): Gateway.ModelConfig => ({ provider: "anthropic", model, apiKey: "k", reasoningEffort: "low" });
  eq(Gateway.assertProductModel(cfg(SONNET)).model, SONNET);
  for (const m of ["claude-haiku-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5", "gpt-5-mini", "", "claude-sonnet-5-5 "]) {
    let err: any = null;
    try { Gateway.assertProductModel(cfg(m)); } catch (e) { err = e; }
    assert(err instanceof ModelUnavailableError && err.type === "not_product_model", `${JSON.stringify(m)} is refused`);
  }
});

Deno.test("D-046 guard: every product door runs the guard on the config it returns or sends", async () => {
  const code = async (p: string) => (await Deno.readTextFile(new URL(p, ROOT))).replace(/^\s*\/\/.*$/gm, "");
  const gw = await code("supabase/functions/_shared/model_gateway.ts");
  assert(/export function modelConfig\([^)]*\)[^{]*\{[\s\S]*?return assertProductModel\(modelConfigFor\(env, CLAUDE_DEFAULT_MODEL\)\);\s*\}/.test(gw), "modelConfig");
  const rm = await code("supabase/functions/agent-chat/release_model.ts");
  assert(/export function careerModelConfig\(env: Env\): ModelConfig \{\s*return assertProductModel\(modelConfigFor\(env, careerModel\(env\)\)\);/.test(rm), "careerModelConfig");
  const rd = await code("supabase/functions/_shared/career_reader_model.ts");
  assert(/export function readerModelConfig\(env: Env\): ModelConfig \{\s*return assertProductModel\(modelConfigFor\(env, readerModel\(env\)\)\);/.test(rd), "readerModelConfig");
  assert(/callModel\(assertProductModel\(readerModelConfig\(env\)\), payload,/.test(rd), "readerCall");
  // and the doors still give Sonnet under every stale setting (the guard never fires on a resolver's own result)
  const stale = env({ ...KEY, CAREER_MODEL: "claude-haiku-5-5", CAREER_REPLY_MODEL: "claude-haiku-5-5", MODEL_PROVIDER: "openai" });
  eq([careerModelConfig(stale).model, readerModelConfig(stale).model, Gateway.modelConfig(stale, "router").model], [SONNET, SONNET, SONNET]);
});
