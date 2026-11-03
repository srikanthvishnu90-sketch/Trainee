// The shared TOTAL model budget with two thresholds (owner, 2026-11-02 18:38 and 18:52 CT): a spend TARGET (MODEL_BUDGET_TARGET_USD,
// default 70) and a HARD max (MODEL_BUDGET_HARD_USD, default 70: the same $70 total), one ledger for production and evals.
//   target: 80% warns; 100% raises a loud flag, production keeps serving, eval/test runners refuse to start a run.
//   hard:   a reservation counts before its call; at 100% every call is refused and the database sets the paused switch.
// Fakes only: the provider is an in-process fake; the database is a throwaway local Postgres 16 (skipped locally without PGBIN).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import * as Gateway from "../../supabase/functions/_shared/model_gateway.ts";
import * as Budget from "../../supabase/functions/_shared/model_budget.ts";
import { ModelBudgetBlockedError } from "../../supabase/functions/_shared/model_calls.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const env = (o: Record<string, string>) => (k: string) => o[k];
const M = 1_000_000;
const cfg: Gateway.ModelConfig = { provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-test-not-real", reasoningEffort: "low" };
const body = (usage: unknown = { input_tokens: 100, output_tokens: 20 }) => JSON.stringify({ id: "x", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage });
const fakeProvider = () => { const sent: unknown[] = []; return { sent, request: (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(body(), { status: 200 }); }) as unknown as typeof fetch }; };
const payload = { max_tokens: 100, messages: [{ role: "user", content: "hello" }] };

Deno.test("limits: unset is one $70 total (target and hard both 70); set values are honoured; a malformed value or a hard max below the target is refused", () => {
  eq(Budget.budgetLimits(env({})), { target: 70 * M, hard: 70 * M });
  eq(Budget.budgetLimits(env({ MODEL_BUDGET_TARGET_USD: "50", MODEL_BUDGET_HARD_USD: "75.5" })), { target: 50 * M, hard: 75_500_000 });
  eq(Budget.budgetLimits(env({ MODEL_BUDGET_TARGET_USD: " ", MODEL_BUDGET_HARD_USD: "" })), { target: 70 * M, hard: 70 * M }, "blank is unset");
  for (const bad of [{ MODEL_BUDGET_TARGET_USD: "seventy" }, { MODEL_BUDGET_HARD_USD: "-1" }, { MODEL_BUDGET_HARD_USD: "0" }, { MODEL_BUDGET_TARGET_USD: "1e9" }, { MODEL_BUDGET_TARGET_USD: "80", MODEL_BUDGET_HARD_USD: "60" }])
    eq(Budget.budgetLimits(env(bad)), null, `refused: ${JSON.stringify(bad)}`);
  eq(Budget.resolveBudgetGate(undefined, env({ MODEL_BUDGET_HARD_USD: "oops" })), null, "a malformed limit refuses to spend (no gate)");
  assert(Budget.resolveBudgetGate(undefined, env({})) !== null, "no project, no variables: the local twin");
});

Deno.test("target 80%: the reserve answers warn, once past it; target 100%: overTarget, and production still reserves", async () => {
  const g = Budget.memoryBudgetGate(100 * M, 70 * M);
  const r1 = await g.reserve(55 * M, { model: "m", role: "r" }); assert(r1.ok && !r1.warn && !r1.overTarget, "55 of 70: nothing yet");
  const r2 = await g.reserve(M, { model: "m", role: "r" }); assert(r2.ok && r2.warn === true && !r2.overTarget, "56 = 80% of 70: warn");
  assert(r1.ok && r2.ok); await g.settle(r1.id, 55 * M); await g.settle(r2.id, M);
  eq((await g.status!()).state, "warning");
  const r3 = await g.reserve(14 * M, { model: "m", role: "r" }); assert(r3.ok && r3.warn === true && r3.overTarget === true, "70 = 100% of target: the loud flag");
  const r4 = await g.reserve(20 * M, { model: "m", role: "r" }); assert(r4.ok && r4.overTarget === true, "production keeps being served past the target (90 of 100)");
  eq((await g.status!()).state, "over_target");
});

Deno.test("hard max: a reservation counts before its call and one that does not fit is refused; at 100% the state is stopped", async () => {
  const g = Budget.memoryBudgetGate(100 * M, 70 * M);
  const a = await g.reserve(99 * M, { model: "m", role: "r" }); assert(a.ok);
  const over = await g.reserve(2 * M, { model: "m", role: "r" }); assert(!over.ok && over.reason === "limit", "99 reserved + 2 > 100: refused before any call");
  const exact = await g.reserve(M, { model: "m", role: "r" }); assert(exact.ok, "the exact fit is allowed");
  eq((await g.status!()).state, "stopped"); eq(g.snapshot().spent + g.snapshot().reserved, 100 * M);
  const none = await g.reserve(1, { model: "m", role: "r" }); assert(!none.ok && none.reason === "limit", "nothing more at 100%");
});

Deno.test("callModel: past the target production still calls the provider; at the hard max no request is made", async () => {
  const p = fakeProvider();
  const logs: string[] = [], orig = console.error; console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const big = Budget.memoryBudgetGate(50 * M, 10 * M); const pre2 = await big.reserve(10 * M, { model: "m", role: "r" }); assert(pre2.ok); await big.settle(pre2.id, 10 * M);
    const out = await Gateway.callModel(cfg, payload, { request: p.request, budget: big });
    assert(out.content[0].text === "hi", "served at 100% of the target");
    assert(logs.some((l) => /BUDGET TARGET EXCEEDED/.test(l)), "and the loud flag is raised: " + logs.join("|"));
    const stop = Budget.memoryBudgetGate(50 * M, 10 * M); const pre3 = await stop.reserve(50 * M, { model: "m", role: "r" }); assert(pre3.ok); await stop.settle(pre3.id, 50 * M);
    const before = p.sent.length; let err: unknown = null;
    try { await Gateway.callModel(cfg, payload, { request: p.request, budget: stop }); } catch (e) { err = e; }
    assert(err instanceof ModelBudgetBlockedError && err.block === "limit" && p.sent.length === before, "at the hard max: refused, nothing sent");
  } finally { console.error = orig; }
  const warnOnly = Budget.memoryBudgetGate(50 * M, 10 * M); const w = await warnOnly.reserve(8 * M, { model: "m", role: "r" }); assert(w.ok); await warnOnly.settle(w.id, 8 * M);
  const logs2: string[] = []; console.error = (...a: unknown[]) => { logs2.push(a.join(" ")); };
  try { await Gateway.callModel(cfg, payload, { request: fakeProvider().request, budget: warnOnly }); } finally { console.error = orig; }
  assert(logs2.some((l) => /budget warning: 80%/.test(l)) && !logs2.some((l) => /EXCEEDED/.test(l)), "80% of the target warns without the loud flag");
});

Deno.test("runners: assertRunMayStart passes below the target and refuses at or over it, at the hard stop, or when the ledger cannot be read", async () => {
  const g = Budget.memoryBudgetGate(100 * M, 70 * M);
  eq((await Budget.assertRunMayStart(g)).state, "ok");
  const a = await g.reserve(60 * M, { model: "m", role: "r" }); assert(a.ok); await g.settle(a.id, 60 * M);
  eq((await Budget.assertRunMayStart(g)).state, "warning", "80% warns but a run may still start");
  const b = await g.reserve(10 * M, { model: "m", role: "r" }); assert(b.ok); await g.settle(b.id, 10 * M);
  for (const gate of [g, Budget.memoryBudgetGate(100 * M, 1)]) {
    if (gate !== g) { const x = await gate.reserve(100 * M, { model: "m", role: "r" }); assert(x.ok); await gate.settle(x.id, 100 * M); }
    let err: unknown = null; try { await Budget.assertRunMayStart(gate); } catch (e) { err = e; }
    assert(err instanceof ModelBudgetBlockedError && /no new run starts/.test(err.detail), "refused at/over target and at the hard stop");
  }
  for (const gate of [null, { reserve: g.reserve, settle: g.settle, release: g.release }, Budget.rpcBudgetGate(async () => ({ data: null, error: { message: "down" } }))]) {
    let err: unknown = null; try { await Budget.assertRunMayStart(gate as any); } catch (e) { err = e; }
    assert(err instanceof ModelBudgetBlockedError && err.block === "unavailable", "an unreadable ledger refuses (fail closed)");
  }
});

Deno.test("rpc gate: sends both limits, reads warn and over_target, and reads the status", async () => {
  const calls: { name: string; args: any }[] = [];
  const id = crypto.randomUUID();
  const gate = Budget.rpcBudgetGate(async (name, args) => { calls.push({ name, args }); return name === "model_budget_total_status" ? { data: { state: "warning", spent: 1, reserved: 2, total: 3 }, error: null } : { data: { ok: true, id, warn: true, over_target: true }, error: null }; }, { target: 7 * M, hard: 9 * M });
  const r = await gate.reserve(5, { model: "claude-haiku-5-5", role: "chat" });
  eq(r, { ok: true, id, warn: true, overTarget: true });
  eq(calls[0], { name: "model_budget_reserve", args: { p_micros: 5, p_model: "claude-haiku-5-5", p_role: "chat", p_target_limit_micros: 7 * M, p_hard_limit_micros: 9 * M } });
  eq(await gate.status!(), { state: "warning", spent: 1, reserved: 2, total: 3, target: 7 * M, hard: 9 * M });
  eq(calls[1], { name: "model_budget_total_status", args: { p_target_limit_micros: 7 * M, p_hard_limit_micros: 9 * M } });
  const paused = Budget.rpcBudgetGate(async () => ({ data: { ok: false, state: "paused" }, error: null }));
  eq(await paused.reserve(5, { model: "m", role: "r" }), { ok: false, reason: "paused" }, "the database's pause is a refusal");
  const viaEnv = Budget.resolveBudgetGate(undefined, env({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", MODEL_BUDGET_TARGET_USD: "40", MODEL_BUDGET_HARD_USD: "60" }),
    (async (_u: string, init: any) => { calls.push({ name: "http", args: JSON.parse(init.body) }); return Response.json({ ok: true, id }); }) as unknown as typeof fetch);
  await viaEnv!.reserve(1, { model: "m", role: "r" });
  eq(calls.at(-1)!.args.p_target_limit_micros, 40 * M); eq(calls.at(-1)!.args.p_hard_limit_micros, 60 * M);
});

// ---- the database, on real Postgres -----------------------------------------------------------------------------------------
const N = (s: string) => Number(s.trim());
async function withPg(fn: (pg: Pg) => Promise<void>) {
  if (!pgBinDir()) { if (CI) throw Error("Postgres 16 is required in CI"); console.log("SKIP: no Postgres 16 (PGBIN)"); return; }
  const prev = Deno.env.get("PG_MAX_CONNECTIONS"); Deno.env.set("PG_MAX_CONNECTIONS", "400");
  const pg = await startPg({ migrationBudget: true });
  try { await fn(pg); } finally { await pg.stop(); if (prev === undefined) Deno.env.delete("PG_MAX_CONNECTIONS"); else Deno.env.set("PG_MAX_CONNECTIONS", prev); }
}
const TARGET = 7 * M, HARD = 10 * M;
async function reset(pg: Pg) {
  await pg.sql(`delete from public.model_budget_reservations; delete from public.model_budget_days; delete from public.founder_alerts where kind like 'model_budget%';
    insert into public.model_budget_settings(key,value) values ('paused','false') on conflict (key) do update set value = 'false';`);
}
const total = async (pg: Pg) => N(await pg.sql(`select coalesce(sum(spent_micros + reserved_micros), 0) from public.model_budget_days`));
Deno.test({ name: "database: total mode sums every day, warns at 80% of the target, flags the target, stops and pauses at the hard max", sanitizeResources: false, sanitizeOps: false,
  fn: () => withPg(async (pg) => {
    const svc = pg.asService();
    const reserve = (micros: number, extra: Record<string, unknown> = {}) => svc.rpc("model_budget_reserve", { p_micros: micros, p_model: "claude-haiku-5-5", p_role: "chat", p_target_limit_micros: TARGET, p_hard_limit_micros: HARD, ...extra });
    const alerts = async (kind: string) => N(await pg.sql(`select count(*) from public.founder_alerts where kind = '${kind}'`));
    const status = async () => (await svc.rpc("model_budget_total_status", { p_target_limit_micros: TARGET, p_hard_limit_micros: HARD })).data;
    await reset(pg); await reserve(1); await reset(pg); // warm
    // 1. Below 80% of the target: nothing raised, and no day row, window or per-day limit stops it (any date works).
    for (let i = 0; i < 5; i++) { const r = await reserve(M); eq([r.data.ok, r.data.warn, r.data.over_target], [true, false, false], `reservation ${i + 1}`); }
    eq((await status()).state, "ok"); eq(await alerts("model_budget_target_warning"), 0);
    // 2. 80% of 7 = 5.6: the sixth reservation (6.0) warns, once.
    { const r = await reserve(M); eq([r.data.ok, r.data.warn, r.data.over_target], [true, true, false]); }
    { const r = await reserve(0 + 1); eq(r.data.warn, true); }
    eq(await alerts("model_budget_target_warning"), 1, "one warning row, however many calls follow"); eq((await status()).state, "warning");
    // 3. The target (7.0): flagged loudly, still served; one alert.
    { const r = await reserve(M - 1); eq([r.data.ok, r.data.warn, r.data.over_target], [true, true, true], "7.0 of 7: over target, still ok"); }
    eq(await alerts("model_budget_target_exceeded"), 1); eq((await status()).state, "over_target"); eq(N(await pg.sql(`select count(*) from public.model_budget_settings where key='paused' and value='true'`)), 0, "production keeps serving: not paused");
    { const r = await reserve(2 * M); eq([r.data.ok, r.data.over_target], [true, true], "9.0 of 10: production still served"); }
    // 4. The hard max: a reservation that would pass it is refused (counted before the call), not paused while room remains.
    { const r = await reserve(2 * M); eq([r.data.ok, r.data.state], [false, "limit"], "9.0 + 2.0 > 10"); }
    eq(await alerts("model_budget_hard_stop"), 1); eq(N(await pg.sql(`select count(*) from public.model_budget_settings where key='paused' and value='true'`)), 0, "room remains: not paused yet");
    eq(await total(pg), 9 * M, "the refused reservation counted nothing");
    // 5. Reaching the hard max exactly sets the paused switch; every later call is refused.
    { const r = await reserve(M); eq([r.data.ok, r.data.over_target], [true, true]); }
    eq(N(await pg.sql(`select count(*) from public.model_budget_settings where key='paused' and value='true'`)), 1, "100% of the hard max sets paused");
    eq((await status()).state, "stopped"); eq((await reserve(1)).data.state, "paused", "every call is refused");
    eq(await total(pg), HARD, "never over the hard max");
    // 6. The owner re-arms: raise the hard max and clear the switch.
    await pg.sql(`update public.model_budget_settings set value = 'false' where key = 'paused'`);
    eq((await svc.rpc("model_budget_reserve", { p_micros: M, p_target_limit_micros: TARGET, p_hard_limit_micros: 12 * M })).data.ok, true, "a raised hard max serves again");
    // 7. Settle keeps its semantics: a proven lower cost frees budget, null keeps the worst case, release returns it.
    await reset(pg);
    { const a = (await reserve(3 * M)).data.id, b = (await reserve(3 * M)).data.id, c = (await reserve(2 * M)).data.id;
      await svc.rpc("model_budget_settle", { p_id: a, p_actual_micros: M }); await svc.rpc("model_budget_settle", { p_id: b }); await svc.rpc("model_budget_release", { p_id: c });
      eq(await total(pg), 4 * M, "1M proven + 3M kept at the worst case + 0 released"); }
    // 8. Spend on any earlier day counts: the old per-day rows are history inside the same total.
    await reset(pg);
    await pg.sql(`insert into public.model_budget_days(day, limit_micros, spent_micros) values ('2026-10-28', 15000000, 6000000), ('2026-10-29', 20000000, 3000000)`);
    eq((await status()).total, 9 * M); eq((await reserve(2 * M)).data.state, "limit", "9 already spent on earlier days: 2 more would pass 10");
    eq((await reserve(M)).data.ok, true, "and exactly 1 fits");
    // 9. 200 concurrent reservations against a $10 hard max: exactly the affordable number succeed, never more.
    await reset(pg);
    { const rs = await Promise.all(Array.from({ length: 200 }, () => reserve(100_000)));
      eq([rs.filter((r) => r.data?.ok === true).length, rs.filter((r) => r.error).length], [100, 0], "exactly 100 x $0.10 fit in $10, none error");
      assert((await total(pg)) <= HARD, "never over the hard max"); eq(N(await pg.sql(`select count(*) from public.model_budget_settings where key='paused' and value='true'`)), 1, "the last dollar paused it"); }
    // 10. Bad limits raise (the caller then makes no call); the per-day mode (no limits) is unchanged.
    await reset(pg);
    assert((await svc.rpc("model_budget_reserve", { p_micros: 1, p_target_limit_micros: 0, p_hard_limit_micros: 5 })).error, "a zero target errors");
    assert((await svc.rpc("model_budget_reserve", { p_micros: 1, p_target_limit_micros: 9, p_hard_limit_micros: 5 })).error, "a hard max below the target errors");
    assert((await svc.rpc("model_budget_reserve", { p_micros: 1, p_hard_limit_micros: 5 })).error, "a missing target errors");
    assert((await svc.rpc("model_budget_total_status", { p_target_limit_micros: 9, p_hard_limit_micros: 5 })).error, "status refuses bad limits too");
    eq((await svc.rpc("model_budget_reserve", { p_micros: 1, p_now: "2026-12-01T12:00:00Z" })).data.state, "after_window", "without limits: the 2026-10-28 per-day mode, window and all");
    // 11. Only the server's role may call them.
    { const u = pg.asPerson("00000000-0000-0000-0000-0000000000f1");
      assert((await u.rpc("model_budget_reserve", { p_micros: 1, p_target_limit_micros: TARGET, p_hard_limit_micros: HARD })).error, "reserve refused to a signed-in person");
      assert((await u.rpc("model_budget_total_status", { p_target_limit_micros: TARGET, p_hard_limit_micros: HARD })).error, "status refused to a signed-in person"); }
    await reset(pg);
  }) });

Deno.test({ name: "end to end: 200 concurrent callModel calls on the real total budget stop at the hard max and then stay stopped", sanitizeResources: false, sanitizeOps: false,
  fn: () => withPg(async (pg) => {
    await reset(pg);
    const gate = Budget.rpcBudgetGate((name, args) => pg.asService().rpc(name, args), { target: TARGET, hard: HARD });
    const big = { max_tokens: 100_000, messages: [{ role: "user", content: "hello" }] }, sonnet = { ...cfg, model: "claude-sonnet-5-5" };
    const sent: unknown[] = [];
    const noUsage = (async (_u: string, init: any) => { sent.push(init.body); return new Response(JSON.stringify({ id: "x", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }), { status: 200 }); }) as unknown as typeof fetch;
    const logs: string[] = [], orig = console.error; console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
    let rs: PromiseSettledResult<unknown>[] = [];
    try { rs = await Promise.allSettled(Array.from({ length: 200 }, () => Gateway.callModel(sonnet, big, { request: noUsage, budget: gate }))); } finally { console.error = orig; }
    const ok = rs.filter((r) => r.status === "fulfilled").length;
    assert(ok > 0 && ok < 200 && sent.length === ok, `only the affordable calls reached the provider (${ok})`);
    assert((await total(pg)) <= HARD, "never over the hard max");
    const refused = rs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
    assert(refused.every((e) => e instanceof ModelBudgetBlockedError), "the rest were refused by the budget");
    // No usage record: each call stays spent at its worst case. Past the target the loud flag was raised on the way.
    assert(logs.some((l) => /BUDGET TARGET EXCEEDED/.test(l)), "the target flag was raised while production kept serving");
    const before = sent.length; await Gateway.callModel(sonnet, big, { request: noUsage, budget: gate }).catch(() => {});
    eq(sent.length, before, "stopped: nothing more is sent");
    let err: unknown = null; try { await Budget.assertRunMayStart(gate); } catch (e) { err = e; }
    assert(err instanceof ModelBudgetBlockedError, "and no eval or test run may start");
  }) });

Deno.test("owner 2026-11-02 22:02: the default gate is ONE $70 total: warns at $56, refuses what does not fit, and stops at $70", async () => {
  const g = Budget.memoryBudgetGate();
  eq([g.snapshot().limit, g.snapshot().target], [70 * M, 70 * M]);
  const a = await g.reserve(55 * M, { model: "m", role: "r" }); assert(a.ok && !a.warn, "$55 is under 80%");
  const b = await g.reserve(1 * M, { model: "m", role: "r" }); assert(b.ok && b.warn === true, "$56 is 80%: warns");
  const c = await g.reserve(15 * M, { model: "m", role: "r" }); assert(!c.ok && c.reason === "limit", "$71 does not fit: refused before any call");
  const d = await g.reserve(14 * M, { model: "m", role: "r" }); assert(d.ok && d.overTarget === true, "exactly $70");
  eq((await g.status!()).state, "stopped");
  const none = await g.reserve(1, { model: "m", role: "r" }); assert(!none.ok && none.reason === "limit", "nothing at $70");
  await assertNode.rejects(() => Budget.assertRunMayStart(g), "an eval run does not start at $70");
});
