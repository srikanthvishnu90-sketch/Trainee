// Claude-only evals (owner directive, 2026-11-02): the judges are Claude (A claude-sonnet-5-5, B claude-haiku-5-5), a claude- id
// goes to Anthropic with ANTHROPIC_API_KEY and never to OpenAI, the run quotes its cost first and refuses past 80% of what
// remains under the $70 target, failures are attributed to the code router or the model, and stored transcripts can be
// re-judged with no model call but the judges. Everything here uses fake fetches: no network, no spend.
// (The tree-wide "no OpenAI anywhere" scan is claude-only-no-openai.test.ts; not repeated here.)
import { makeJudge, type EvalItem } from "../../evals/career/run.ts";
import { checklistOf, judgeBPrompt, judgeFingerprint, judgeModelProblem, JUDGE_A_MODEL, JUDGE_B_MODEL, parseJudgeB } from "../../evals/career/judges.ts";
import { outcomeOf } from "../../evals/career/harness.ts";
import { attribute, routeOf } from "../../evals/career/attribution.ts";
import { budgetTargets, claudeSpentUsd, openGate, preflight, quoteRun, spendLine } from "../../evals/career/eval_budget.ts";
import { guardFetch, rejudgeRun, setFileOf, STORED } from "../../evals/career/rejudge.ts";
import { scoreLogRow } from "../../evals/career/score-log.ts";
import { modelConfigFor, callModel, PRICES } from "../../supabase/functions/_shared/model_gateway.ts";
import { memoryBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";
import { judgePair, parseScoreLog } from "../../scripts/launch/deploy-standard.ts";
import { fakeAnthropic, setOracle, clearOracle } from "../../evals/career/tasks/fake_model.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
const item: EvalItem = { id: "E1", persona: "a new grad", turns: ["find me roles"], must: ["asks one question"], must_not: ["invents a company"], state: "nothing queued" };
const reply = "Happy to help. What city do you want to work in?";
const ok = (text: string) => new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 800, output_tokens: 120 } }), { status: 200 });

// A fake Anthropic: answers judge A (sonnet) with the original JSON shape and judge B (haiku) with checks that quote the reply.
function fakeJudges(log: { url: string; model: string; key: string | null }[], over: { aPass?: boolean; bQuote?: string } = {}) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    log.push({ url: String(url), model: body.model, key: (init?.headers as any)?.["x-api-key"] ?? null });
    if (body.model === JUDGE_A_MODEL) return ok(JSON.stringify({ pass: over.aPass ?? true, failed: over.aPass === false ? ["asks one question"] : [], score: 4, note: "a" }));
    return ok(JSON.stringify({ checks: [{ n: 1, met: true, quote: over.bQuote ?? "What city do you want to work in?" }, { n: 2, met: true, quote: "" }, { n: 3, met: true, quote: "\"stores\":{}" }], score: 5, note: "b" }));
  }) as typeof fetch;
}

Deno.test("CO/1 a claude- judge id goes to api.anthropic.com with ANTHROPIC_API_KEY, never to OpenAI; judge B must quote real evidence", async () => {
  const e = env({ ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_KEY_NOT_USED: "x" });
  const log: { url: string; model: string; key: string | null }[] = [];
  const request = fakeJudges(log);
  const gate = memoryBudgetGate(50_000_000);
  const cfgA = modelConfigFor(e, JUDGE_A_MODEL), cfgB = modelConfigFor(e, JUDGE_B_MODEL);
  const judge = makeJudge({ cfgA, cfgB, call: (cfg, payload) => callModel(cfg, payload, { request, budget: gate }) });
  const v: any = await judge(item, reply, { stores: {}, account: {} });
  assert(v.pass && v.judges.length === 2 && v.disagree === false, JSON.stringify(v));
  assert(log.length === 2 && log.every((l) => l.url === "https://api.anthropic.com/v1/messages" && l.key === "sk-ant-test"), JSON.stringify(log));
  assert(new Set(log.map((l) => l.model)).size === 2 && log.every((l) => /^claude-/.test(l.model)));
  // a quote that is not in the reply fails the item even though the model said "met"
  const log2: any[] = [];
  const bad: any = await makeJudge({ cfgA, cfgB, call: (cfg, payload) => callModel(cfg, payload, { request: fakeJudges(log2, { bQuote: "I will queue Acme for you" }), budget: gate }) })(item, reply, { stores: {}, account: {} });
  assert(!bad.pass && bad.disagree === true && /quote not found/.test(bad.judges[1].note + JSON.stringify(bad.failed)), JSON.stringify(bad));
});

Deno.test("CO/2 a judge that is not a claude- id, or has no key, is refused before any call", () => {
  assert(/not a claude-/.test(judgeModelProblem("gpt-5-mini", env({ ANTHROPIC_API_KEY: "k" })) ?? ""));
  assert(/ANTHROPIC_API_KEY/.test(judgeModelProblem(JUDGE_B_MODEL, env({})) ?? ""));
  assert(judgeModelProblem(JUDGE_A_MODEL, env({ ANTHROPIC_API_KEY: "k" })) === null);
});

Deno.test("CO/3 judge B parses by code: unmet, missing and unquoted lines fail; the model's own pass is ignored", () => {
  const n = checklistOf(item).length;
  assert(n === 3);
  const t = (checks: unknown[]) => JSON.stringify({ pass: true, checks, score: 5, note: "" });
  // an unmet must_not line fails only with a quote of the offending text that is in the reply (owner decision 2026-11-07)
  assert(!parseJudgeB(t([{ n: 1, met: true, quote: "What city do you want" }, { n: 2, met: false, quote: "Happy to help" }, { n: 3, met: true, quote: "nothing queued" }]), item, reply, { s: "nothing queued" }).pass, "a quoted violation fails");
  assert(parseJudgeB(t([{ n: 1, met: true, quote: "What city do you want" }, { n: 2, met: false, quote: "" }, { n: 3, met: true, quote: "nothing queued" }]), item, reply, "nothing queued").pass, "an unquoted violation is not one");
  assert(parseJudgeB(t([{ n: 1, met: true, quote: "What city do you want" }, { n: 2, met: false, quote: "Acme" }, { n: 3, met: true, quote: "nothing queued" }]), item, reply, "nothing queued").pass, "a violation quoting text not in the reply is not one");
  assert(!parseJudgeB(t([{ n: 1, met: false, quote: "" }, { n: 2, met: true, quote: "" }, { n: 3, met: true, quote: "nothing queued" }]), item, reply, "nothing queued").pass, "an unmet must line still fails");
  assert(parseJudgeB(t([{ n: 1, met: true, quote: "what CITY do you   want" }, { n: 2, met: true, quote: "" }, { n: 3, met: true, quote: "nothing queued" }]), item, reply, "nothing queued").pass, "case and spacing are ignored");
  assert(parseJudgeB(t([{ n: 1, met: true, quote: "" }, { n: 2, met: true, quote: "" }, { n: 3, met: true, quote: "nothing queued" }]), item, reply, "nothing queued").failed[0].includes("without a quote"));
  assert(parseJudgeB(t([{ n: 1, met: true, quote: "What city" }]), item, reply, "nothing queued").failed.length === 2, "missing lines fail");
  assert(judgeBPrompt(item, reply, null, outcomeOf).includes("[must_not] invents a company"));
});

Deno.test("CO/4 the judge set has a fingerprint that changes with either prompt or model", async () => {
  const a = await judgeFingerprint("prompt A"), b = await judgeFingerprint("prompt A2"), c = await judgeFingerprint("prompt A", { a: "claude-sonnet-5-5", b: "claude-sonnet-5-5" });
  assert(a.length === 16 && a !== b && a !== c);
  const doc = await Deno.readTextFile("evals/career/JUDGES.md");
  const { JUDGE_PROMPT } = await import("../../evals/career/run.ts");
  assert(doc.includes(await judgeFingerprint(JUDGE_PROMPT)), "JUDGES.md does not carry the current fingerprint; update it with the judges");
});

Deno.test("CO/5 preflight: the quote is refused when it exceeds what remains of the $70 total, counts parallel passes, and prints the remaining allowance", () => {
  const q = quoteRun({ items: 162, brain: "staged", brainModel: "claude-haiku-5-5", judgeA: JUDGE_A_MODEL, judgeB: JUDGE_B_MODEL, prices: PRICES });
  assert(q.total_usd > 0.5 && q.total_usd < 2.5, `a 162-item staged Haiku pass quotes about a dollar: ${q.total_usd}`);
  assert(preflight({ quote: q, spent_usd: 0, target_usd: 70, hard_usd: 70, ledger: "shared" }).ok);
  const five = preflight({ quote: q, parallel: 5, spent_usd: 0, target_usd: 70, hard_usd: 70, ledger: "process-local" });
  assert(five.ok && five.quote_usd > 4.9 * q.total_usd && /process-local/.test(five.line));
  const near = preflight({ quote: q, spent_usd: 69.95, target_usd: 70, hard_usd: 70, ledger: "shared" });
  assert(!near.ok && /remaining/i.test(near.line) && /REFUSED/.test(near.line));
  assert(Math.abs(near.remaining_usd - 0.05) < 1e-9 && /remaining allowance \$0\.050/.test(near.line), "prints the remaining allowance: " + near.line);
  assert(preflight({ quote: q, spent_usd: 70 - q.total_usd - 0.01, target_usd: 70, hard_usd: 70, ledger: "shared" }).ok, "fits exactly what remains");
  assert(!preflight({ quote: q, spent_usd: 69.5, target_usd: 200, hard_usd: 70, ledger: "shared" }).ok, "hard max");
  const sonnet = quoteRun({ items: 162, brain: "staged", brainModel: "claude-sonnet-5-5", judgeA: JUDGE_A_MODEL, judgeB: JUDGE_B_MODEL, prices: PRICES });
  assert(sonnet.brain_usd > 10 * q.brain_usd, "Sonnet costs far more than Haiku");
  let threw = false; try { quoteRun({ items: 1, brain: "staged", brainModel: "no-such-model", judgeA: null, judgeB: null, prices: PRICES }); } catch { threw = true; }
  assert(threw, "an unpriced model cannot be quoted");
  assert(/campaign total/.test(spendLine({ label: "x", quote_usd: 1, brain_usd: 0.5, judge_usd: 0.2, spent_before_usd: 3, target_usd: 70, hard_usd: 70 })));
});

Deno.test("CO/6 targets both default to 70, read MODEL_BUDGET_*, and refuse nonsense; only Claude-era results count", () => {
  assert(JSON.stringify(budgetTargets(() => undefined)) === JSON.stringify({ target: 70, hard: 70 }));
  assert(budgetTargets((k) => ({ MODEL_BUDGET_TARGET_USD: "50", MODEL_BUDGET_HARD_USD: "60" } as any)[k]).hard === 60);
  let threw = false; try { budgetTargets((k) => ({ MODEL_BUDGET_TARGET_USD: "80", MODEL_BUDGET_HARD_USD: "60" } as any)[k]); } catch { threw = true; }
  assert(threw);
  const spent = claudeSpentUsd([{ label: "old", model: "gpt-5-mini", judge_model: "gpt-5-mini", cost_usd: { brain: 9, judge: 9 } },
    { label: "a", model: "claude-haiku-5-5", judge_model: "claude-sonnet-5-5", cost_usd: { brain: 1, judge: 0.5 } }, { label: "a", judge_model: "claude-sonnet-5-5", cost_usd: { brain: 1, judge: 0.5 } },
    { label: "t", model: "claude-haiku-5-5", cost_usd: 0.25 }, { label: "me", judge_model: "claude-sonnet-5-5", cost_usd: { brain: 5, judge: 5 } }], "me");
  assert(Math.abs(spent - 1.75) < 1e-9, String(spent));
  const g: any = openGate({ resolveBudgetGate: () => "shared", memoryBudgetGate: () => "local" }, (k) => ({ SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k" } as any)[k], 0, 70, 5);
  assert(g.shared && g.gate === "shared");
  assert("error" in openGate({ resolveBudgetGate: () => "x", memoryBudgetGate: () => "y" }, (k) => ({ EVAL_LEDGER: "shared" } as any)[k], 0, 70, 1), "EVAL_LEDGER=shared without a ledger must refuse");
});

Deno.test("CO/7 route attribution says whether code or the model answered each failure", () => {
  const items = [
    { id: "a", pass: false, trace: [{ route: "router" }] }, { id: "b", pass: false, trace: [{ route: "router_fallback" }] }, { id: "c", pass: false, trace: [{ route: "brain" }] },
    { id: "d", pass: true, trace: [{ route: "brain" }] }, { id: "e", pass: true, trace: [{ route: "router" }] }, { id: "f", pass: false },
  ];
  const a = attribute(items, "staged:claude-haiku-5-5");
  assert(a.failed === 4 && a.failed_ids.router[0] === "a" && a.failed_ids.router_fallback[0] === "b" && a.failed_ids.unknown[0] === "f", JSON.stringify(a));
  assert(a.failed_router_share === 0.5 && a.model_pass_rate === 0.5);
  assert(routeOf({ id: "x", pass: false }, "router") === "router" && routeOf({ id: "x", pass: false }, "agent") === "brain");
});

// ---------------------------------------------------------------------------------------------- re-judge
const dev = JSON.parse(await Deno.readTextFile("evals/career/heldout-live.json")).items as EvalItem[];
const stored = (n: number, over: any = {}) => ({ name: `dev-router-4123-p${n}.json`, text: JSON.stringify({ label: `dev-router-4123-p${n}`, harness: "parity 2026-10-26 test", set: "dev", brain: "router", model: null, judge_model: "gpt-5-mini", judge_model_2: "gpt-4.1-mini",
  commit: "abc1234", source_commit: "33f7d00", planned: 2, total: 2, passed: 1, items: [
    { id: dev[0].id, pass: true, replies: [reply], state: { stores: {}, account: {} }, trace: [{ stopped: "router", steps: 0, tools: [], route: "router" }] },
    { id: dev[1].id, pass: false, replies: ["no"], state: null, note: "" }], ...over }) });

Deno.test("CO/8 a dev-set file is re-judged against the dev items, not messages.json (the old mapping bug)", () => {
  assert(setFileOf("dev") === "./heldout-live.json" && setFileOf("heldout") === "./heldout-live.json" && setFileOf("official") === "./messages.json");
  let threw = false; try { setFileOf("sealed"); } catch { threw = true; }
  assert(threw, "a redacted sealed result cannot be re-judged");
  assert(STORED.exec("dev-staged:claude-haiku-5-5-4123-p2.json")?.groups?.brain === "staged:claude-haiku-5-5");
});

Deno.test("CO/9 rejudge replays stored transcripts, calls only the judges, and writes rows S3 accepts", async () => {
  const calls: string[] = [];
  const judge = makeJudge({ cfgA: { model: JUDGE_A_MODEL }, cfgB: { model: JUDGE_B_MODEL }, call: async (cfg: any) => { calls.push(cfg.model); return JSON.parse(await (await fakeJudges([], {})("u", { body: JSON.stringify({ model: cfg.model }) })).text()) as any; } });
  const outs = await rejudgeRun({ stored: [stored(2), stored(1), { name: "notes.md", text: "" }], itemsOf: async () => dev, judge, judgeModels: { a: JUDGE_A_MODEL, b: JUDGE_B_MODEL }, newRun: "9001", branch: "ci/brain-eval", now: () => new Date("2026-11-03T01:02:03Z") });
  assert(outs.length === 2 && outs[0].name === "dev-router-9001-p1.json", outs.map((o) => o.name).join());
  assert(calls.length === 8 && calls.every((m) => m === JUDGE_A_MODEL || m === JUDGE_B_MODEL), "four judge calls per pass (2 items x 2 judges) and nothing else");
  const r = outs[0].result;
  assert(r.judge === "claude" && r.cost_usd.brain === 0 && r.rejudge_of.run === "4123" && r.source_commit === "33f7d00" && r.harness === "parity 2026-10-26 test" && r.items[0].replies[0] === reply);
  const log = outs.map((o) => o.row).join("");
  const rows = parseScoreLog(log);
  assert(rows.length === 2 && rows[0].commit === "33f7d00" && rows[0].set === "dev" && rows[0].brain === "router" && rows[0].size === 2 && rows[0].stopped === "no" && rows[0].run === "9001", JSON.stringify(rows));
  assert(/judge=claude/.test(log) && !/Instinct/.test(log));
  assert(judgePair(log.split("|")[8]) === judgePair(outs[1].row.split("|")[8]), "the judge pair is one string whatever the counts");
  assert(scoreLogRow(r, "1").startsWith("| 2026-11-03 01:02:03 |"));
});

Deno.test("CO/10 the rejudge fetch guard allows only api.anthropic.com and only the two judge models", async () => {
  const seen: string[] = [];
  const real = (async (i: any) => { seen.push(String(i.url ?? i)); return ok("{}"); }) as typeof fetch;
  const g = guardFetch([JUDGE_A_MODEL, JUDGE_B_MODEL], real);
  const post = (url: string, model: string) => g(url, { method: "POST", body: JSON.stringify({ model }) });
  await post("https://api.anthropic.com/v1/messages", JUDGE_B_MODEL);
  for (const [u, m] of [["https://api.openai.com/v1/chat/completions", "gpt-5-mini"], ["https://api.anthropic.com/v1/messages", "claude-sonnet-5-5-other"], ["https://example.com/", JUDGE_A_MODEL]]) {
    let threw = false; try { await post(u, m); } catch { threw = true; }
    assert(threw, `${u} ${m} was allowed`);
  }
  assert(seen.length === 1);
});

// ---------------------------------------------------------------------------------------------- task eval fake
Deno.test("CO/11 the task eval's fake answers the Anthropic wire: a forced plan_task call, and a text reply", async () => {
  setOracle({ "find me data jobs": [{ capability: "jobs.search", text: "find me data jobs" }] });
  try {
    const req = (body: unknown) => new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(body) });
    const p = await (await fakeAnthropic(req({ model: "claude-haiku-5-5", tools: [{ name: "plan_task", input_schema: {} }], messages: [{ role: "user", content: "THE PERSON'S MESSAGE: Find me data jobs" }] }))).json();
    assert(p.stop_reason === "tool_use" && p.content[0].type === "tool_use" && p.content[0].input.kind === "task" && p.usage.input_tokens > 0, JSON.stringify(p));
    const t = await (await fakeAnthropic(req({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "what is a good cover letter" }] }))).json();
    assert(t.stop_reason === "end_turn" && t.content[0].type === "text", JSON.stringify(t));
  } finally { clearOracle(); }
});

// ---------------------------------------------------------------------------------------------- workflow
Deno.test("CO/12 brain-eval.yml: every run block parses in bash (the push's-apostrophe bug of run 41389452263), Claude only, ledger env, no OpenAI secret", async () => {
  const wf = await Deno.readTextFile(".github/workflows/brain-eval.yml");
  const lines = wf.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: \|\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length + 2, body: string[] = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].length - lines[j].trimStart().length >= indent); j++) body.push(lines[j].slice(indent));
    blocks.push(body.join("\n").replace(/\$\{\{[^}]*\}\}/g, "X"));
  }
  assert(blocks.length >= 8, `only ${blocks.length} run blocks found`);
  for (const b of blocks) {
    const p = await new Deno.Command("bash", { args: ["-n"], stdin: "piped", stderr: "piped" }).spawn();
    const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(b)); await w.close();
    const o = await p.output();
    assert(o.success, `bash -n failed: ${new TextDecoder().decode(o.stderr)}\n${b.slice(0, 200)}`);
    // the inline deno eval scripts must be valid JavaScript too
    for (const m of b.matchAll(/deno eval '([\s\S]*?)'\n/g)) { try { new Function("Deno", `return (async () => {${m[1]}})`); } catch (e) { throw new Error(`deno eval script does not parse: ${e}`); } }
  }
  const req = blocks.find((b) => b.includes("evals/career/eval-request.json"))!;
  assert(!/push's/.test(req), "the apostrophe that closed the shell quote is back");
  assert(!/openai|gpt-/i.test(wf.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")), "an OpenAI name is in the workflow");
  assert(/ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/.test(wf) && /EVAL_JUDGE_MODEL: claude-sonnet-5-5/.test(wf) && /EVAL_JUDGE_MODEL_2: claude-haiku-5-5/.test(wf));
  assert(/MODEL_BUDGET_TARGET_USD: "70"/.test(wf) && /MODEL_BUDGET_HARD_USD: "70"/.test(wf) && /ANTHROPIC_EVAL_BUDGET_USD/.test(wf) && !/\bEVAL_BUDGET_USD:/.test(wf));
  assert(/--model claude/.test(wf) && !/--model openai/.test(wf));
  assert(/rejudge\.ts --from-branch ci\/brain-eval --run/.test(wf), "no rejudge action");
});

Deno.test("assertRunMayStart: an eval run is refused before it spends when the ledger would not take its quote, and the probe reservation is released", async () => {
  const { assertRunMayStart, memoryBudgetGate } = await import("../../supabase/functions/_shared/model_budget.ts");
  const gate = memoryBudgetGate(1_000_000);
  await assertRunMayStart(gate, 400_000);
  if (gate.snapshot().reserved !== 0 || gate.snapshot().spent !== 0) throw new Error("the probe must leave nothing reserved or spent");
  let msg = ""; try { await assertRunMayStart(gate, 2_000_000); } catch (e) { msg = String((e as Error).message); }
  if (!/^NOT RUN: /.test(msg)) throw new Error(`a quote over the limit must be refused, got: ${msg}`);
  msg = ""; try { await assertRunMayStart(null, 1); } catch (e) { msg = String((e as Error).message); }
  if (!/^NOT RUN: /.test(msg)) throw new Error("no gate means no run");
});

Deno.test("CO/gate the workflow: Haiku is the only candidate reply model, a sealed request names its release brain, no Sonnet-if-Haiku-is-poor rule", async () => {
  const wf = await Deno.readTextFile(".github/workflows/brain-eval.yml");
  assert(/const MODELS = \["claude-haiku-5-5"\];/.test(wf), "the model allowlist is Haiku only (Sonnet is Judge A, never a candidate reply model)");
  assert(!/below 90|under 90|only if Haiku|if Haiku/i.test(wf), "no Sonnet fallback rule in the workflow");
  assert(/release_brain/.test(wf) && /NOT RUN: a sealed request names its release_brain/.test(wf), "a sealed request must name its release brain");
  assert(/--release-brain \$\{\{ steps\.req\.outputs\.release_brain \}\}/.test(wf), "verdict.ts reads the same release brain");
  const dec = await Deno.readTextFile("docs/architect/DECISIONS.md");
  assert(!/Sonnet only if Haiku/i.test(dec), "the decision log withdraws the Sonnet-if-Haiku-is-poor wording");
});
