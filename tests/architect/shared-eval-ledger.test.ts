// The ONE $70 across runs (owner, 2026-11-02/03). Eval and measure workflows must set EVAL_LEDGER=shared and pass SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY from secrets; the runners FAIL CLOSED when the shared ledger is missing or unreachable (no request to
// api.anthropic.com), and spend from separate runs adds up in the one ledger production also uses. Fakes only: no network, no spend.
import assertNode from "node:assert/strict";
import { parse as parseYaml } from "npm:yaml@2.9.1";
import { assertRunMayStart, evalLedgerShared, memoryBudgetGate, resolveBudgetGate, restBudgetGate, sharedLedgerProblem } from "../../supabase/functions/_shared/model_budget.ts";
import { callModel, type ModelConfig } from "../../supabase/functions/_shared/model_gateway.ts";
import { ModelBudgetBlockedError } from "../../supabase/functions/_shared/model_calls.ts";
import { ledgerSpentUsd, openGate, preflight, quoteRun } from "../../evals/career/eval_budget.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const M = 1_000_000;
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const env = (o: Record<string, string>) => (k: string) => o[k];
const cfg: ModelConfig = { provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-test-not-real", reasoningEffort: "low" };
const payload = { max_tokens: 100, messages: [{ role: "user", content: "hello" }] };
const okBody = JSON.stringify({ id: "x", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } });

// A fake Supabase ledger (the model_budget_* RPCs over PostgREST) plus a fake Anthropic, counting what reaches each.
function fakeWorld(opts: { ledgerDown?: boolean } = {}) {
  const w = { anthropic: 0, ledgerCalls: 0, spent: 0, reserved: 0, open: new Map<string, number>(), down: !!opts.ledgerDown, hard: 70 * M, target: 70 * M };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.anthropic.com/")) { w.anthropic++; return new Response(okBody, { status: 200 }); }
    w.ledgerCalls++;
    if (w.down) return new Response("down", { status: 503 });
    const name = u.split("/rpc/")[1], a = JSON.parse(String(init?.body ?? "{}"));
    const total = w.spent + w.reserved;
    const state = () => total >= w.hard ? "stopped" : total >= w.target ? "over_target" : total >= 0.8 * w.target ? "warning" : "ok";
    if (name === "model_budget_total_status") return Response.json({ state: state(), spent: w.spent, reserved: w.reserved, total });
    if (name === "model_budget_reserve") {
      if (total + a.p_micros > w.hard) return Response.json({ ok: false, state: "limit" });
      const id = crypto.randomUUID(); w.reserved += a.p_micros; w.open.set(id, a.p_micros); return Response.json({ ok: true, id });
    }
    if (name === "model_budget_settle") { const m = w.open.get(a.p_id)!; w.open.delete(a.p_id); w.reserved -= m; w.spent += a.p_actual_micros ?? m; return Response.json({ ok: true }); }
    if (name === "model_budget_release") { const m = w.open.get(a.p_id)!; w.open.delete(a.p_id); w.reserved -= m; return Response.json({ ok: true }); }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { w, fetchFn };
}
const SHARED = { EVAL_LEDGER: "shared", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };

Deno.test("SL/1 EVAL_LEDGER=shared with the URL or key missing: no gate, a run does not start, and the message names the missing piece", async () => {
  assert(evalLedgerShared(env({ EVAL_LEDGER: " Shared " })) && !evalLedgerShared(env({})));
  for (const [vars, piece] of [[{ EVAL_LEDGER: "shared" }, "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"], [{ EVAL_LEDGER: "shared", SUPABASE_URL: "https://x" }, "SUPABASE_SERVICE_ROLE_KEY"], [{ EVAL_LEDGER: "shared", SUPABASE_SERVICE_ROLE_KEY: "k" }, "SUPABASE_URL"]] as const) {
    assert((sharedLedgerProblem(env(vars)) ?? "").includes(piece), piece);
    eq(resolveBudgetGate(undefined, env(vars)), null, "never falls back to the process-local twin");
    let err: unknown = null; try { await assertRunMayStart(memoryBudgetGate(70 * M), 1, undefined, env(vars)); } catch (e) { err = e; }
    assert(err instanceof ModelBudgetBlockedError && /^NOT RUN:/.test(err.message) && err.message.includes(piece), String((err as Error)?.message));
    assert("error" in openGate({ resolveBudgetGate: () => "x", memoryBudgetGate: () => "y" }, env(vars), 0, 70, 1) && (openGate({ resolveBudgetGate: () => "x", memoryBudgetGate: () => "y" }, env(vars), 0, 70, 1) as any).error.includes("missing:"));
  }
  assert(resolveBudgetGate(undefined, env({})) !== null, "without EVAL_LEDGER nothing changes: a developer machine keeps the local twin");
});

Deno.test("SL/2 shared ledger unreachable: the run is refused and api.anthropic.com is never contacted", async () => {
  const { w, fetchFn } = fakeWorld({ ledgerDown: true });
  const gate = restBudgetGate("https://x.supabase.co", "svc", fetchFn);
  let err: unknown = null; try { await assertRunMayStart(gate, 1 * M, undefined, env(SHARED)); } catch (e) { err = e; }
  assert(err instanceof ModelBudgetBlockedError && err.block === "unavailable" && /shared budget ledger/.test(err.message) && /^NOT RUN:/.test(err.message), String((err as Error)?.message));
  eq(await ledgerSpentUsd(gate), null);
  let err2: unknown = null; try { await callModel(cfg, payload, { request: fetchFn, budget: gate }); } catch (e) { err2 = e; }
  assert(err2 instanceof ModelBudgetBlockedError, "a call cannot reserve, so it is not made");
  eq(w.anthropic, 0, "zero requests to api.anthropic.com");
});

Deno.test("SL/3 callModel with EVAL_LEDGER=shared and no SUPABASE env (no explicit gate) makes zero requests to api.anthropic.com", async () => {
  const { w, fetchFn } = fakeWorld();
  const saved = Object.fromEntries(["EVAL_LEDGER", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MODEL_BUDGET_PAUSED"].map((k) => [k, Deno.env.get(k)]));
  try {
    Deno.env.set("EVAL_LEDGER", "shared"); Deno.env.delete("SUPABASE_URL"); Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); Deno.env.delete("MODEL_BUDGET_PAUSED");
    let err: unknown = null; try { await callModel(cfg, payload, { request: fetchFn }); } catch (e) { err = e; }
    assert(err instanceof ModelBudgetBlockedError && err.block === "unavailable", String(err));
    eq(w.anthropic, 0); eq(w.ledgerCalls, 0);
  } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v); }
});

Deno.test("SL/4 two sequential runs share one ledger: the second sees the first's spend, prints the remaining allowance, and an over-quote is refused", async () => {
  const { w, fetchFn } = fakeWorld();
  const runGate = () => restBudgetGate("https://x.supabase.co", "svc", fetchFn); // a fresh process each time: no memory shared but the ledger
  // run 1 spends through callModel (reserve, call, settle to the proven cost)
  const g1 = runGate();
  const st1 = await assertRunMayStart(g1, 1 * M, undefined, env(SHARED));
  eq(st1.total, 0);
  await callModel(cfg, payload, { request: fetchFn, budget: g1 });
  eq(w.anthropic, 1);
  const spent1 = w.spent; assert(spent1 > 0 && w.reserved === 0, "run 1's actual cost is recorded");
  // production spends in the SAME ledger (no per-surface budget): the gate is the same RPCs
  await callModel(cfg, payload, { request: fetchFn, budget: runGate() });
  const spent2 = w.spent; assert(spent2 > spent1);
  // run 2 starts from what ALL runs recorded
  const g2 = runGate();
  const st2 = await assertRunMayStart(g2, 1 * M, undefined, env(SHARED));
  eq(st2.total, spent2, "run 2 sees run 1 + production");
  eq(await ledgerSpentUsd(g2), spent2 / M);
  const quote = quoteRun({ items: 10, brain: "router", brainModel: null, judgeA: "claude-sonnet-5-5", judgeB: "claude-haiku-5-5", prices: (await import("../../supabase/functions/_shared/model_gateway.ts")).PRICES });
  const pre = preflight({ quote, spent_usd: spent2 / M, target_usd: 70, hard_usd: 70, ledger: "shared" });
  assert(pre.line.includes(`remaining allowance $${(70 - spent2 / M).toFixed(3)} of $70.00`), pre.line);
  // the ledger is nearly used up: a run whose worst case does not fit the remaining allowance is refused, and nothing is left reserved
  w.spent = 69_500_000; const before = w.anthropic;
  let err: unknown = null; try { await assertRunMayStart(runGate(), 1 * M, undefined, env(SHARED)); } catch (e) { err = e; }
  assert(err instanceof ModelBudgetBlockedError && err.block === "limit" && /^NOT RUN:/.test(err.message), String((err as Error)?.message));
  eq(w.reserved, 0, "the probe reservation is released or never made");
  eq(w.anthropic, before, "no request was made");
  w.spent = 70 * M;
  let err3: unknown = null; try { await assertRunMayStart(runGate(), undefined, undefined, env(SHARED)); } catch (e) { err3 = e; }
  assert(err3 instanceof ModelBudgetBlockedError, "at $70 across all runs nothing starts");
});

Deno.test("SL/5 every workflow that can reach a model sets EVAL_LEDGER=shared and passes SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from secrets", () => {
  const dir = `${ROOT}/.github/workflows`;
  const MODEL_RUNNERS = /evals\/career\/(run|rejudge|compare|advice-seeds|mail-model-eval|tasks\/run|rewriters\/run)\.ts|model_gateway\.ts/;
  const checked: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (!/\.ya?ml$/.test(e.name)) continue;
    const text = Deno.readTextFileSync(`${dir}/${e.name}`);
    const wf: any = parseYaml(text);
    const reaches = MODEL_RUNNERS.test(text.replace(/^\s*#.*$/gm, "")) && Object.values(wf.jobs ?? {}).some((j: any) => JSON.stringify(j.steps ?? []).match(MODEL_RUNNERS));
    if (!reaches) continue;
    checked.push(e.name);
    for (const [jobName, job] of Object.entries<any>(wf.jobs ?? {})) {
      if (!JSON.stringify(job.steps ?? []).match(MODEL_RUNNERS)) continue;
      const jobEnv = job.env ?? {};
      eq(String(jobEnv.EVAL_LEDGER), "shared", `${e.name}/${jobName}: EVAL_LEDGER must be shared`);
      eq(String(jobEnv.SUPABASE_URL).replace(/\s/g, ""), "${{secrets.SUPABASE_URL}}", `${e.name}/${jobName}: SUPABASE_URL from secrets`);
      eq(String(jobEnv.SUPABASE_SERVICE_ROLE_KEY).replace(/\s/g, ""), "${{secrets.SUPABASE_SERVICE_ROLE_KEY}}", `${e.name}/${jobName}: SUPABASE_SERVICE_ROLE_KEY from secrets`);
      eq(String(jobEnv.MODEL_BUDGET_TARGET_USD), "80"); eq(String(jobEnv.MODEL_BUDGET_HARD_USD), "80"); // Architect amendment (D-074): the owner raised the one total to $80
    }
  }
  const be = Deno.readTextFileSync(`${dir}/brain-eval.yml`);
  assert(/repository secret \$k is not set/.test(be) && be.indexOf("The shared ledger secrets are present") < be.indexOf("What this run measures"), "brain-eval.yml refuses first, naming the missing secret");
  assert(checked.includes("brain-eval.yml"), `brain-eval.yml must be checked (saw ${checked})`);
});
