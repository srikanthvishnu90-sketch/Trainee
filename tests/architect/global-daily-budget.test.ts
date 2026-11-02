// The hard global per-day model budget (owner, 2026-10-28, in writing: "Today's testing limit is $15 total; tomorrow, October 29
// Chicago time, is $20 total"; each day its own row, nothing rolls over). Earlier wording: "a fresh $20 total budget across all testers for
// the Chicago calendar day. Make sure paid calls can't exceed that total, including concurrent calls and missing cost records."
// Correction: the $20 is the budget for 2026-10-29 America/Chicago only. Before the window and after it every paid call is refused,
// and only the owner approving a new budget (an owner-run statement) ever opens another; no code creates a budget row.
// Fakes only: the provider is an in-process fake (no key, no network, no spend); the database is a throwaway local Postgres 16.
//   Part 1  pure arithmetic and the gateway's order of operations, with fake gates and a fake provider
//   Part 2  every paid-call path is covered (static scan: no provider URL or key outside the gateway, voice reserves)
//   Part 3  the database function, on real Postgres: 200 concurrent reservations, settle/release/expiry, Chicago midnight and DST
//   Part 4  callModel end to end on that database, 200 concurrent calls
//   Part 5  mutation checks: every guard is broken in a copy and the same scenarios must fail
//   PGBIN=/usr/lib/postgresql/16/bin deno test -A --no-check tests/architect/global-daily-budget.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import * as Gateway from "../../supabase/functions/_shared/model_gateway.ts";
import * as Budget from "../../supabase/functions/_shared/model_budget.ts";
import { ModelBudgetBlockedError, ModelUnavailableError } from "../../supabase/functions/_shared/model_calls.ts";
import { spendCap } from "../../supabase/functions/_shared/career_spend_cap.ts";
import { handleVoice, voiceWorstCaseMicros } from "../../supabase/functions/_shared/career_voice.ts";
import { signToken } from "../../supabase/functions/_shared/career_voice_link.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const SHARED = new URL("../../supabase/functions/_shared/", import.meta.url);
const MIGRATION = new URL("../../supabase/migrations/20261028070000_global_daily_model_budget.sql", import.meta.url);
const LIMIT = 20_000_000;

// ---- fakes -------------------------------------------------------------------------------------------------------------
const cfg: Gateway.ModelConfig = { provider: "openai", model: "gpt-5-mini", apiKey: "sk-test-not-real", reasoningEffort: "minimal" };
const payload = { max_tokens: 200, messages: [{ role: "user", content: "hello" }] };
const OMIT = Symbol("no usage field");
const okBody = (usage: unknown = { prompt_tokens: 100, completion_tokens: 20 }) => ({ id: "x", model: "gpt-5-mini", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], ...(usage === OMIT ? {} : { usage }) });
type Ev = string;
// A gate that records what happened, in order, around an inner gate. The fake provider logs "request" to the same list.
function spy(inner: Budget.BudgetGate = Budget.memoryBudgetGate()) {
  const ev: Ev[] = [], settles: (number | null)[] = [];
  const gate: Budget.BudgetGate = {
    async reserve(m, meta) { const r = await inner.reserve(m, meta); ev.push(r.ok ? `reserve:${m}` : `refused:${r.reason}`); return r; },
    async settle(id, a) { ev.push(a === null ? "settle:kept" : `settle:${a}`); settles.push(a); return inner.settle(id, a); },
    async release(id) { ev.push("release"); return inner.release(id); },
  };
  return { gate, ev, settles, inner };
}
function provider(ev: Ev[], how: { status?: number; body?: unknown; raw?: string; throws?: Error } = {}) {
  const sent: any[] = [];
  const request = (async (url: string, init: any) => {
    ev.push("request"); sent.push({ url, body: JSON.parse(init.body) });
    if (how.throws) throw how.throws;
    const text = how.raw ?? JSON.stringify(how.body ?? okBody());
    return new Response(text, { status: how.status ?? 200 });
  }) as unknown as typeof fetch;
  return { request, sent };
}
const blockedOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as ModelUnavailableError; } };

// ---- Part 1: arithmetic and order of operations -------------------------------------------------------------------------
Deno.test("worst case: output cap x price + request bytes x input price; unknown model costs the highest price", () => {
  const P = Gateway.PRICES;
  const mini = Budget.worstCaseMicros("gpt-5-mini", P, { bytes: 1000, images: 0, maxOutputTokens: 712 });
  eq(mini, Math.ceil(1000 * 0.25 + 712 * 2.0));
  const unknown = Budget.worstCaseMicros("gpt-9-imaginary", P, { bytes: 1000, images: 0, maxOutputTokens: 712 });
  const high = Budget.highestPrice(P);
  eq(unknown, Math.ceil(1000 * high.input + 712 * high.output));
  for (const m of Object.keys(P)) assert(unknown >= Budget.worstCaseMicros(m, P, { bytes: 1000, images: 0, maxOutputTokens: 712 }), `unknown model is never cheaper than ${m}`);
  assert(Budget.worstCaseMicros("gpt-5-mini", P, { bytes: 0, images: 2, maxOutputTokens: 0 }) >= 2 * Budget.IMAGE_TOKENS_UPPER * 0.25, "images carry a flat allowance");
  eq(Budget.worstCaseMicros("gpt-5-nano", P, { bytes: 0, images: 0, maxOutputTokens: 0 }), 1, "never zero");
  // Anthropic's cache write rate counts as an input rate (it is the dearest input).
  assert(Budget.worstCaseMicros("claude-haiku-4-5-20251001", P, { bytes: 1000, images: 0, maxOutputTokens: 0 }) >= 1250);
});

Deno.test("the price table says where every price came from, and a per-call fee is part of the worst case", () => {
  for (const [m, p] of Object.entries(Gateway.PRICES)) {
    assert(p.source && /^(verified|third_party|unverified)$/.test(p.checked) && /^2026-10-\d\d$/.test(p.checked_on), `${m} names its source, check state and date`);
    assert(p.input > 0 && p.output > 0 && p.cached >= 0, `${m} has real rates`);
  }
  const withFee = { x: { input: 1, cached: 0, cache_write: 0, output: 1, call_fee: 5000 } };
  eq(Budget.worstCaseMicros("x", withFee, { bytes: 10, images: 0, maxOutputTokens: 10 }), 5020, "known model: tokens plus the call fee");
  eq(Budget.worstCaseMicros("other", withFee, { bytes: 10, images: 0, maxOutputTokens: 10 }), 5020, "unknown model: the highest rates and the highest fee");
});

Deno.test("usage is proven only by a real usage block (a missing one is never read as zero)", () => {
  assert(Budget.usageProven("openai", { usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  for (const bad of [{}, { usage: null }, { usage: {} }, { usage: { prompt_tokens: 1 } }, { usage: { prompt_tokens: "1", completion_tokens: 2 } }, { usage: { prompt_tokens: -1, completion_tokens: 2 } }, { usage: { prompt_tokens: NaN, completion_tokens: 2 } }, null, "x"])
    assert(!Budget.usageProven("openai", bad), `not proven: ${JSON.stringify(bad)}`);
  assert(Budget.usageProven("anthropic", { usage: { input_tokens: 1, output_tokens: 2 } }));
  assert(!Budget.usageProven("anthropic", { usage: { prompt_tokens: 1, completion_tokens: 2 } }));
});

// Every behavior the gateway must keep, run against the real module and against each broken copy.
async function gatewayScenarios(mod: { callModel: typeof Gateway.callModel; chatReply: typeof Gateway.chatReply }, B: { memoryBudgetGate: typeof Budget.memoryBudgetGate; rpcBudgetGate: typeof Budget.rpcBudgetGate; resolveBudgetGate: typeof Budget.resolveBudgetGate }) {
  const worstOf = (ev: Ev[]) => Number(ev.find((e) => e.startsWith("reserve:"))!.split(":")[1]);
  // 1. Reserve BEFORE the request; a proven cost settles to the actual cost (100 in x .25 + 20 out x 2 = 65).
  { const s = spy(B.memoryBudgetGate()), p = provider(s.ev); await mod.callModel(cfg, payload, { request: p.request, budget: s.gate });
    eq(s.ev.map((e) => e.split(":")[0]), ["reserve", "request", "settle"], "reserve, then request, then settle");
    eq(s.settles, [65], "settled to the actual cost"); assert(worstOf(s.ev) > 65, "the reservation is a worst case, larger than the actual"); }
  // 2. The day is used up: NO request, a typed error, and the plain-words reply.
  { const inner = B.memoryBudgetGate(10), s = spy(inner), p = provider(s.ev);
    const e = await blockedOf(mod.callModel(cfg, payload, { request: p.request, budget: s.gate }));
    assert(e instanceof ModelUnavailableError && e.type === "global_daily_limit", "limit error"); eq(p.sent.length, 0, "no request was made");
    const r = await mod.chatReply(cfg, payload, { request: p.request, budget: s.gate });
    assert(!r.ok && r.reply === "Trainee has used up its AI budget, so I didn't use the AI for this reply.", "plain words"); eq(p.sent.length, 0); }
  // 2b. The window is not open: before it, and after it (or no budget row): NO request, plain words, never a recurring allowance.
  for (const [state, type, words] of [["before_window", "budget_not_open", /hasn't opened yet/], ["after_window", "budget_ended", /owner's approval/], ["no_budget", "budget_ended", /owner's approval/]] as const) {
    const s = spy(B.rpcBudgetGate((async () => ({ data: { ok: false, state }, error: null })) as any)), p = provider(s.ev);
    const e = await blockedOf(mod.callModel(cfg, payload, { request: p.request, budget: s.gate }));
    assert(e instanceof ModelUnavailableError && e.type === type, `${state}: ${type}`); eq(p.sent.length, 0, `${state}: no request`);
    const r = await mod.chatReply(cfg, payload, { request: p.request, budget: s.gate }); assert(!r.ok && words.test(r.reply), `${state}: plain words`); eq(p.sent.length, 0); }
  // 3. The budget cannot be checked (DB error, thrown error, nonsense answer): fail CLOSED, no request, no throw out of the gate.
  for (const rpc of [async () => ({ data: null, error: { message: "connection refused" } }), async () => { throw new Error("boom"); }, async () => ({ data: { ok: "yes" }, error: null }), async () => ({ data: null, error: null })]) {
    const s = spy(B.rpcBudgetGate(rpc as any)), p = provider(s.ev);
    const e = await blockedOf(mod.callModel(cfg, payload, { request: p.request, budget: s.gate }));
    assert(e instanceof ModelUnavailableError && e.type === "budget_unavailable", "unavailable error"); eq(p.sent.length, 0, "fails closed: no request");
    const r = await mod.chatReply(cfg, payload, { request: p.request, budget: s.gate }); assert(!r.ok && /couldn't check today's AI budget/.test(r.reply), "plain words"); }
  // 3b. A reservation that is not a positive whole number never reaches the database.
  { let hit = 0; const g = B.rpcBudgetGate(async () => { hit++; return { data: null, error: null }; });
    for (const bad of [0, -5, 1.5, NaN, Infinity]) { const r = await g.reserve(bad, { model: "m", role: "r" }); assert(!r.ok, `size ${bad} refused`); }
    eq(hit, 0, "no RPC for an invalid size"); }
  // 4. Missing / partial / unparseable usage keeps the FULL worst case as spent.
  for (const usage of [OMIT, null, {}, { prompt_tokens: 5 }, { prompt_tokens: "x", completion_tokens: 1 }]) {
    const s = spy(B.memoryBudgetGate()), p = provider(s.ev, { body: okBody(usage) }); await mod.callModel(cfg, payload, { request: p.request, budget: s.gate });
    eq(s.settles, [null], `usage ${usage === OMIT ? "absent" : JSON.stringify(usage)} keeps the worst case`);
    eq((s.inner as any).snapshot().spent, worstOf(s.ev), "spent equals the whole reservation"); }
  // 5. A model with no price keeps the worst case too (it was reserved at the highest price).
  { const s = spy(B.memoryBudgetGate()), p = provider(s.ev, { body: { ...okBody(), model: "gpt-9-imaginary" } });
    await mod.callModel({ ...cfg, model: "gpt-9-imaginary" }, payload, { request: p.request, budget: s.gate }); eq(s.settles, [null], "unpriced model: worst case kept");
    assert(worstOf(s.ev) > 2000, "reserved at the highest price in the table (200 tokens x 10 plus the request)"); eq((s.inner as any).snapshot().spent, worstOf(s.ev)); }
  // 6. Anything unproven after sending keeps the worst case: network error, timeout, 5xx, unreadable JSON, too large.
  for (const how of [{ throws: new Error("reset") }, { status: 500, body: { error: { message: "x" } } }, { status: 502, raw: "<html>" }, { raw: "not json" }, { raw: "x".repeat(200001) }]) {
    const s = spy(B.memoryBudgetGate()), p = provider(s.ev, how as any); await blockedOf(mod.callModel(cfg, payload, { request: p.request, budget: s.gate }));
    eq(p.sent.length, 1); eq(s.settles, [null], `kept: ${JSON.stringify(how).slice(0, 40)}`); assert(!s.ev.includes("release"), "no release after a request was sent"); }
  // 7. The provider refused before generating (4xx / 429): a proven no-call, the reservation is given back.
  for (const status of [400, 401, 403, 404, 422, 429]) {
    const s = spy(B.memoryBudgetGate()), p = provider(s.ev, { status, body: { error: { message: "no" } } }); await blockedOf(mod.callModel(cfg, payload, { request: p.request, budget: s.gate }));
    eq(s.ev.at(-1), "release", `HTTP ${status} releases`); eq((s.inner as any).snapshot(), { ...(s.inner as any).snapshot(), spent: 0, reserved: 0 }); }
  // 8. No API key: nothing reserved, nothing sent.
  { const s = spy(), p = provider(s.ev); await blockedOf(mod.callModel({ ...cfg, apiKey: "" }, payload, { request: p.request, budget: s.gate })); eq(s.ev, [], "no key: no reservation"); }
  // 9. A settle that fails never breaks the answer; the reservation stays open (the database expires it to its worst case).
  { const inner = B.memoryBudgetGate(); const gate: Budget.BudgetGate = { reserve: (m, x) => inner.reserve(m, x), settle: async () => { throw new Error("db down"); }, release: (i) => inner.release(i) };
    const p = provider([]); const out = await mod.callModel(cfg, payload, { request: p.request, budget: gate }); assert(out.content[0].text === "hi");
    assert((inner as any).snapshot().reserved > 0 && (inner as any).snapshot().spent === 0, "still reserved: it still counts against the day"); }
  // 10. The kill switch: no reservation, no request.
  { Deno.env.set("MODEL_BUDGET_PAUSED", "true");
    try { const s = spy(), p = provider(s.ev); const e = await blockedOf(mod.callModel(cfg, payload, { request: p.request, budget: s.gate }));
      assert(e instanceof ModelUnavailableError && e.type === "budget_paused", "paused error"); eq(p.sent.length, 0); eq(s.ev, []);
      const r = await mod.chatReply(cfg, payload, { request: p.request, budget: s.gate }); assert(!r.ok && /switched off/.test(r.reply)); }
    finally { Deno.env.delete("MODEL_BUDGET_PAUSED"); } }
  // 11. Concurrent calls against a tiny day: exactly the affordable number reach the provider.
  { const s = spy(B.memoryBudgetGate()); const p0 = provider(s.ev); await mod.callModel(cfg, payload, { request: p0.request, budget: s.gate });
    const w = worstOf(s.ev), inner = B.memoryBudgetGate(w * 7 + 3), s2 = spy(inner), p = provider(s2.ev, { body: okBody(OMIT) });
    const rs = await Promise.allSettled(Array.from({ length: 50 }, () => mod.callModel(cfg, payload, { request: p.request, budget: s2.gate })));
    eq(p.sent.length, 7, "exactly 7 affordable calls were sent"); eq(rs.filter((r) => r.status === "fulfilled").length, 7);
    assert((inner as any).snapshot().spent + (inner as any).snapshot().reserved <= w * 7 + 3); }
  // 12. A URL with no key is refused (the budget service cannot be reached); no URL at all is a developer's machine.
  { const get = (k: string) => ({ SUPABASE_URL: "https://x.supabase.co" } as Record<string, string>)[k]; eq(B.resolveBudgetGate(undefined, get), null, "URL without a key: refuse"); }
}
Deno.test("gateway: reserve first, settle to proven cost, keep unproven cost, release only a proven no-call, fail closed", async () => {
  await gatewayScenarios({ callModel: Gateway.callModel, chatReply: Gateway.chatReply }, Budget);
});

Deno.test("the career turn's note says the global limit in plain words, whoever hit it", async () => {
  const gate = spy(Budget.memoryBudgetGate(10)).gate;
  const cap = spendCap({ read: async () => ({ usd_micros: 0, calls: 0 }), limits: { usdMicros: 1e9, calls: 1e9 }, call: (c, p, o) => Gateway.callModel(c, p, { ...o, budget: gate, request: provider([]).request }) });
  const e = await blockedOf(cap.call(cfg, payload, {})); assert(e instanceof ModelUnavailableError && e.type === "global_daily_limit");
  eq(cap.refused(), "global"); eq(cap.note(), "Trainee has used up its AI budget, so I didn't use the AI for this reply.");
});

Deno.test("voice: the call's worst case is reserved before a key is minted, kept once minted, returned if nothing was minted", async () => {
  const key = "service-role-secret-for-the-test-0123456789";
  const now = Date.UTC(2026, 9, 28, 15, 0, 0);
  const token = await signToken({ s: "11111111-1111-4111-8111-111111111111", u: "22222222-2222-4222-8222-222222222222", k: "start", exp: now + 600_000 }, key);
  const run = async (gate: Budget.BudgetGate, mintOk = true) => {
    let minted = 0, started = 0;
    const sessions: any = { read: async () => ({ state: { minutes: 20, questions: [], role: "x" }, started_at: null }), start: async () => { started++; return { questions: [], role: "x" }; } };
    const mint = () => async () => { minted++; return mintOk ? { ok: true, value: "ek_test", expires_at: 1 } : { ok: false, status: 500 }; };
    const res = await handleVoice(new Request("https://x/", { method: "POST", body: JSON.stringify({ action: "start", token }) }),
      { env: (k) => ({ SUPABASE_SERVICE_ROLE_KEY: key, OPENAI_API_KEY: "sk-fake", CAREER_VOICE: "on", CAREER_VOICE_ENABLED: "on" } as Record<string, string>)[k], now: () => now, cors: {}, sessions, mint: mint as any, budget: gate });
    return { body: await res.json(), status: res.status, minted, started };
  };
  { const inner = Budget.memoryBudgetGate(), s = spy(inner); const r = await run(s.gate); eq(r.body.status, "OK");
    eq(s.ev, [`reserve:${voiceWorstCaseMicros("gpt-realtime-mini", 20)}`, "settle:kept"], "reserve the whole call's worst case, then keep it");
    eq((inner as any).snapshot().spent, 3_000_000, "a minted key's worst case is spent"); }
  { const s = spy(Budget.memoryBudgetGate(1000)); const r = await run(s.gate); eq(r.status, 429); eq(r.minted, 0, "no key minted"); eq(r.started, 0, "the link is not used up");
    eq(r.body.message, "Trainee has used up its AI budget, so I didn't use the AI for this reply."); }
  { const inner = Budget.memoryBudgetGate(), s = spy(inner); const r = await run(s.gate, false); eq(r.status, 502); assert(s.ev.includes("release")); eq((inner as any).snapshot().reserved, 0, "nothing minted: returned"); }
});

// ---- Part 2: every paid-call path is covered ---------------------------------------------------------------------------
// A scan, not a promise: production code (supabase/, packages/, src/) may name a paid provider's URL or read its key only in
// the files listed here, and the listed files must reserve first. Comments are ignored.
const ALLOWED: Record<string, string> = {
  "supabase/functions/_shared/model_gateway.ts": "the gateway: callModel reserves before it sends (checked below)",
  "supabase/functions/_shared/career_voice.ts": "the realtime voice key: handleVoice reserves before it mints (checked below)",
  "supabase/functions/_shared/career_voice_link.ts": "reads whether the key exists to say NOT_WIRED; never calls the provider",
};
const PROVIDER = /api\.openai\.com|api\.anthropic\.com|openai\.com\/v1|(?:Deno\.)?env\.get\(\s*["'](?:OPENAI|ANTHROPIC)_API_KEY["']|\bnew OpenAI\(|\bnew Anthropic\(|from ["'](?:npm:)?(?:openai|@anthropic-ai\/sdk)/;
export function scanForDirectProviderUse(files: Record<string, string>, allowed = ALLOWED): string[] {
  const bad: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (allowed[path]) continue;
    text.split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/\s\/\/ .*$/, "");
      if (PROVIDER.test(code)) bad.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return bad;
}
async function productionSources(): Promise<Record<string, string>> {
  const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    let entries: Deno.DirEntry[] = []; try { entries = [...Deno.readDirSync(`${root}/${dir}`)]; } catch (_) { return; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory) { if (!["node_modules", ".git"].includes(e.name)) await walk(rel); }
      else if (/\.(ts|tsx|js|cjs|mjs)$/.test(e.name)) out[rel] = await Deno.readTextFile(`${root}/${rel}`);
    }
  };
  for (const d of ["supabase", "packages", "src"]) await walk(d);
  return out;
}
Deno.test("every paid call goes through the gateway: no direct provider URL, key read or SDK outside the allow-list", async () => {
  const files = await productionSources();
  assert(Object.keys(files).length > 100, "the scan really read the production tree");
  eq(scanForDirectProviderUse(files), [], "a production file calls a paid provider around the gateway");
  for (const p of Object.keys(ALLOWED)) assert(files[p], `allow-listed file exists: ${p}`);
  // The scan itself notices: a synthetic offender is caught in each shape, and the allow-listed file is not.
  for (const bad of ['await fetch("https://api.openai.com/v1/chat/completions", {})', "const k = Deno.env.get('OPENAI_API_KEY');", 'fetch(`https://api.anthropic.com/v1/messages`)', 'import OpenAI from "npm:openai@4";', "const c = new OpenAI({apiKey});"])
    assert(scanForDirectProviderUse({ "supabase/functions/x/index.ts": bad }).length === 1, `caught: ${bad}`);
  eq(scanForDirectProviderUse({ "supabase/functions/x/index.ts": "// api.openai.com is only named in a comment\n * OPENAI_API_KEY" }), [], "comments are ignored");
  eq(scanForDirectProviderUse({ "supabase/functions/_shared/model_gateway.ts": 'fetch("https://api.openai.com/x")' }), [], "the gateway is allowed");
});

Deno.test("gateway source: the only sends are in callModel and responsesCall, each after its reservation, and the kill switch and fail-closed checks come first", async () => {
  const g = await Deno.readTextFile(new URL("model_gateway.ts", SHARED));
  const sends = [...g.matchAll(/await (?:request|send)\(/g)].map((m) => m.index!);
  eq(sends.length, 4, "exactly four sends: OpenAI and Anthropic in callModel, OpenAI's web search in responsesCall, and the free moderation door");
  const fn = g.indexOf("export async function callModel"), ws = g.indexOf("export async function responsesCall"), mod = g.indexOf("export async function moderate"), end = g.length;
  assert(fn > 0 && ws > fn && mod > ws, "callModel, then responsesCall, then moderate");
  // #354 (architect's written OK, 2026-11-01): moderate's one send is the only unreserved send, and it reaches /v1/moderations only.
  const modSends = sends.filter((i) => i > mod);
  eq(modSends.length, 1, "moderate sends once");
  assert(/^await send\(MODERATIONS_URL,/.test(g.slice(modSends[0])) && /const MODERATIONS_URL = "https:\/\/api\.openai\.com\/v1\/moderations";/.test(g), "the unreserved send targets /v1/moderations only");
  // Each door, in its own text: pause check, reserve, refusal check, then its sends.
  for (const [name, from, to] of [["callModel", fn, g.indexOf("// What a person reads when the provider is down", fn)], ["responsesCall", ws, mod]] as const) {
    const body = g.slice(from, to), mine = sends.filter((i) => i > from && i < to).map((i) => i - from);
    assert(mine.length >= 1, `${name} sends`);
    const paused = body.indexOf("budgetPausedByEnv("), reserve = body.indexOf("await gate.reserve("), closed = body.indexOf("if (!got.ok)");
    if (name === "responsesCall") assert(body.indexOf("refuseVoiceModel(") >= 0 && body.indexOf("refuseVoiceModel(") < paused, "voice models are refused before anything else");
    assert(paused > 0 && paused < reserve && reserve < closed && closed < Math.min(...mine), `${name}: pause check, reserve, refusal check, then the first send`);
  }
  assert(sends.every((i) => i > fn && i < end), "every send is inside one of the two doors");
  const other = g.replace(g.slice(fn, end), "");
  assert(!/\bfetch\(/.test(other.replace(/\/\/.*$/gm, "")), "no other fetch in the gateway");
  // Every production caller of the model goes through callModel (directly or via chatReply/plannerModel).
  const files = await productionSources();
  const callers = Object.entries(files).filter(([p, t]) => /\bcallModel\(|\bchatReply\(|\bplannerModel\(/.test(t) && !p.endsWith("model_gateway.ts")).map(([p]) => p);
  assert(callers.length >= 6, `callers found: ${callers.join(", ")}`);
  for (const p of callers) assert(!/\bfrom ["'][^"']*model_budget\.ts["']/.test(files[p]) || /career_voice|financial_planner|career_spend_cap/.test(p), `${p} does not hand-roll a gate`);
});

// ---- Part 3: the database, on real Postgres ------------------------------------------------------------------------------
const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const N = (s: string) => Number(s.trim());
const IN_WINDOW = "2026-10-29T15:00:00Z"; // 10:00 Chicago on the budget day
// The migration's own starting state: the two owner-approved rows (10-28 $15, 10-29 $20), the window settings, nothing else.
const TODAY_LIMIT = 15_000_000;
async function resetBudget(pg: Pg) {
  await pg.sql(`delete from public.model_budget_reservations; delete from public.model_budget_days; delete from public.founder_alerts where kind like 'model_budget%';
    insert into public.model_budget_days(day, limit_micros) values ('2026-10-28', 15000000), ('2026-10-29', 20000000);
    insert into public.model_budget_settings(key,value) values ('paused','false'),('reservation_ttl_seconds','900'),
      ('window_start','2026-10-28T00:00:00-05:00'),('window_end','2026-10-30T00:00:00-05:00')
    on conflict (key) do update set value = excluded.value;`);
}
// The books always balance: each day's totals equal what its reservation rows say, and an open reservation is never spent.
async function books(pg: Pg, label: string) {
  const bad = await pg.sql(`select d.day::text || ' reserved ' || d.reserved_micros || '/' || coalesce(o.s,0) || ' spent ' || d.spent_micros || '/' || coalesce(c.s,0)
    from public.model_budget_days d
    left join (select day, sum(micros) s from public.model_budget_reservations where status='reserved' group by day) o using (day)
    left join (select day, sum(actual_micros) s from public.model_budget_reservations where status in ('settled','expired') group by day) c using (day)
    where d.reserved_micros <> coalesce(o.s,0) or d.spent_micros <> coalesce(c.s,0)`);
  eq(bad, "", `${label}: books balance`);
}
const day = async (pg: Pg, d: string) => {
  const r = await pg.sql(`select spent_micros || '|' || reserved_micros || '|' || limit_micros from public.model_budget_days where day = '${d}'`);
  const [spent, reserved, limit] = r.split("|").map(Number); return { spent, reserved, limit };
};
const reserve = (pg: Pg, micros: number, now?: string) => pg.asService().rpc("model_budget_reserve", { p_micros: micros, p_model: "gpt-5-mini", p_role: "chat", p_now: now ?? IN_WINDOW });

async function sqlScenarios(pg: Pg) {
  const svc = pg.asService();
  const today = "2026-10-29";
  // 0. The migration itself leaves exactly the owner-approved budget: 10-28 $15 and 10-29 $20, each its own row, the window
  //    10-28 00:00 to 10-30 00:00 Chicago in the settings, and no global limit setting (each day's row is its limit).
  eq(await pg.sql(`select string_agg(value, ',' order by key) from public.model_budget_settings where key in ('window_start','window_end')`), "2026-10-30T00:00:00-05:00,2026-10-28T00:00:00-05:00");
  eq(await pg.sql(`select string_agg(day::text || '=' || limit_micros, ',' order by day) from public.model_budget_days`), "2026-10-28=15000000,2026-10-29=20000000");
  eq(await pg.sql(`select count(*) from public.model_budget_settings where key = 'budget_limit_micros'`), "0", "no global limit knob: a day's row is its limit");
  // 1. The reset is the migration's state.
  await resetBudget(pg);
  eq(await pg.sql(`select string_agg(day::text || '=' || limit_micros, ',' order by day) from public.model_budget_days`), "2026-10-28=15000000,2026-10-29=20000000");
  // 2. 200 concurrent reservations of $0.15 against $20: exactly floor(20 / 0.15) = 133 succeed, never more.
  await resetBudget(pg); await reserve(pg, 1); await resetBudget(pg); // warm the RPC signature cache
  { const rs = await Promise.all(Array.from({ length: 200 }, () => reserve(pg, 150_000)));
    const ok = rs.filter((r) => r.data?.ok === true).length, limited = rs.filter((r) => r.data?.state === "limit").length;
    eq([ok, limited, rs.filter((r) => r.error).length], [133, 67, 0], "exactly the affordable number succeed, the rest are refused, none error");
    const d = await day(pg, today); eq([d.spent, d.reserved], [0, 133 * 150_000]); assert(d.spent + d.reserved <= LIMIT, "never over the limit");
    eq(N(await pg.sql(`select count(*) from public.model_budget_reservations`)), 133); await books(pg, "uniform burst"); }
  // 3. The boundary is inclusive: 200 x $0.10 fills the day exactly, the 201st is refused.
  await resetBudget(pg);
  { const rs = await Promise.all(Array.from({ length: 201 }, () => reserve(pg, 100_000)));
    eq(rs.filter((r) => r.data?.ok === true).length, 200, "an exact fit is allowed"); eq(rs.filter((r) => r.data?.state === "limit").length, 1);
    eq((await day(pg, today)).reserved, LIMIT); await books(pg, "exact fit"); }
  // 4. Mixed sizes, 200 at once: never over, the books equal what was accepted, and no refusal was needless (each refused size
  //    exceeds what is left, because reservations only grow here).
  await resetBudget(pg);
  { const rnd = lcg(42), sizes = Array.from({ length: 200 }, () => 1 + Math.floor(rnd() * rnd() * 3_000_000));
    const rs = await Promise.all(sizes.map((s) => reserve(pg, s)));
    const accepted = sizes.filter((_, i) => rs[i].data?.ok === true), sum = accepted.reduce((a, b) => a + b, 0);
    assert(sum <= LIMIT, `accepted ${sum} <= ${LIMIT}`); eq((await day(pg, today)).reserved, sum);
    const left = LIMIT - sum; sizes.forEach((s, i) => { if (rs[i].data?.ok !== true) assert(s > left, `refused ${s} but ${left} was left`); });
    assert(sizes.reduce((a, b) => a + b, 0) > LIMIT, "the burst really was oversubscribed"); await books(pg, "mixed burst"); }
  // 5. Settle moves a reservation to its actual cost; null keeps the whole worst case; a second settle changes nothing.
  await resetBudget(pg);
  { const a = (await reserve(pg, 1_000_000)).data.id, b = (await reserve(pg, 1_000_000)).data.id, c = (await reserve(pg, 1_000_000)).data.id;
    eq((await svc.rpc("model_budget_settle", { p_id: a, p_actual_micros: 400_000 })).data.ok, true);
    eq((await svc.rpc("model_budget_settle", { p_id: b })).data.ok, true);
    eq(await day(pg, today), { spent: 1_400_000, reserved: 1_000_000, limit: LIMIT }, "400k proven + 1M kept; c still open");
    eq((await svc.rpc("model_budget_settle", { p_id: a, p_actual_micros: 1 })).data.state, "not_open", "a second settle is a no-op");
    eq((await svc.rpc("model_budget_settle", { p_id: b, p_actual_micros: 0 })).data.state, "not_open", "a kept reservation cannot be settled down later");
    eq((await svc.rpc("model_budget_release", { p_id: a })).data.state, "not_open", "a settled reservation cannot be released");
    eq((await svc.rpc("model_budget_release", { p_id: b })).data.state, "not_open");
    eq((await day(pg, today)).spent, 1_400_000); await books(pg, "settle"); void c; }
  // 5b. Spent counts against the limit, not only reserved: after $15 is spent, a $6 reservation does not fit and $5 does.
  await resetBudget(pg);
  { const a = (await reserve(pg, 15_000_000)).data.id; await svc.rpc("model_budget_settle", { p_id: a });
    eq((await reserve(pg, 5_000_001)).data.state, "limit", "spent counts"); eq((await reserve(pg, 5_000_000)).data.ok, true, "the rest fits"); await books(pg, "spent counts"); }
  // 6. Release returns the reservation once, and only while it is open.
  await resetBudget(pg);
  { const a = (await reserve(pg, 2_000_000)).data.id; eq((await svc.rpc("model_budget_release", { p_id: a })).data.ok, true);
    eq((await day(pg, today)).reserved, 0); eq((await svc.rpc("model_budget_release", { p_id: a })).data.state, "not_open");
    eq((await svc.rpc("model_budget_settle", { p_id: a })).data.state, "not_open", "a released reservation cannot be settled"); await books(pg, "release"); }
  // 7. A reservation stuck past the TTL (900 s) becomes spent at its worst case. Never a refund, and nothing frees it later.
  await resetBudget(pg);
  { const t0 = "2026-10-29T15:00:00Z", id = (await reserve(pg, 3_000_000, t0)).data.id;
    await reserve(pg, 10, "2026-10-29T15:14:00Z"); eq((await day(pg, "2026-10-29")).reserved, 3_000_010, "still open inside the TTL");
    await reserve(pg, 10, "2026-10-29T15:15:30Z");
    eq(await day(pg, "2026-10-29"), { spent: 3_000_000, reserved: 20, limit: LIMIT }, "expired: spent at the worst case, not refunded");
    eq((await svc.rpc("model_budget_settle", { p_id: id, p_actual_micros: 5 })).data.state, "not_open", "a late settle cannot lower it");
    eq((await svc.rpc("model_budget_release", { p_id: id })).data.state, "not_open", "nor can a release");
    eq(await pg.sql(`select status || '|' || actual_micros from public.model_budget_reservations where id = '${id}'`), "expired|3000000");
    eq((await svc.rpc("model_budget_expire", { p_now: "2026-10-29T15:15:30Z" })).data, 0, "expiring again moves nothing"); await books(pg, "expiry"); }
  // 8. Chicago midnight, with the DST edges. 2026-11-01 (fall back) is 25 hours long and one date; 2026-03-08 (spring forward) is 23.
  { const at = async (iso: string) => (await pg.sql(`select public.model_budget_day('${iso}')`)).trim();
    const cases: [string, string][] = [
      ["2026-10-29T04:59:59Z", "2026-10-28"], ["2026-10-29T05:00:00Z", "2026-10-29"],         // CDT: midnight Chicago is 05:00Z
      ["2026-11-01T04:59:59Z", "2026-10-31"], ["2026-11-01T05:00:00Z", "2026-11-01"],         // the day fall-back starts, still CDT
      ["2026-11-01T06:30:00Z", "2026-11-01"], ["2026-11-01T07:30:00Z", "2026-11-01"],         // 1:30 CDT and 1:30 CST: the same date
      ["2026-11-02T05:59:59Z", "2026-11-01"], ["2026-11-02T06:00:00Z", "2026-11-02"],         // CST: midnight Chicago is 06:00Z, a 25-hour day
      ["2026-03-08T05:59:59Z", "2026-03-07"], ["2026-03-08T06:00:00Z", "2026-03-08"],         // spring-forward day starts (CST)
      ["2026-03-09T04:59:59Z", "2026-03-08"], ["2026-03-09T05:00:00Z", "2026-03-09"],         // a 23-hour day
      ["2026-12-31T05:59:59Z", "2026-12-30"], ["2027-01-01T06:00:00Z", "2027-01-01"],
    ];
    for (const [iso, want] of cases) { eq(await at(iso), want, `Chicago date of ${iso}`); eq(Budget.chicagoDay(Date.parse(iso)), want, `TypeScript twin agrees for ${iso}`); }
    // ---- the window: 10-28 ($15) and 10-29 ($20) America/Chicago, each day its own budget ----
    await resetBudget(pg);
    const rsv = (iso: string, micros = 1) => reserve(pg, micros, iso);
    eq((await rsv("2026-10-28T04:59:59Z")).data.state, "before_window", "10-27 23:59:59 Chicago: refused");
    eq((await rsv("2026-10-27T12:00:00Z")).data.state, "before_window", "the day before: refused");
    eq((await rsv("2026-10-01T12:00:00Z")).data.state, "before_window", "weeks before: refused");
    eq(N(await pg.sql(`select count(*) from public.model_budget_reservations`)), 0, "nothing from before the window was reserved, so nothing can be spent early");
    // 10-28: its own $15.
    eq((await rsv("2026-10-28T05:00:00Z", TODAY_LIMIT + 1)).data.state, "limit", "10-28 00:00:00 Chicago: one micro-dollar over $15 is refused");
    eq((await rsv("2026-10-28T05:00:00Z", TODAY_LIMIT - 1)).data.ok, true, "10-28 00:00:00 Chicago: allowed up to $15");
    eq((await rsv("2026-10-29T04:59:59Z")).data.ok, true, "10-28 23:59:59 Chicago: the last micro-dollar of the $15 day");
    eq((await rsv("2026-10-29T04:59:59Z")).data.state, "limit", "and refused once the $15 is gone");
    { const d28 = await day(pg, "2026-10-28"); eq(d28.spent + d28.reserved, TODAY_LIMIT, "10-28 holds exactly $15 (spent once its reservations passed the TTL)"); }
    // 10-29: its own $20, untouched by 10-28 (no carry-over either way).
    eq((await rsv("2026-10-29T05:00:00Z", LIMIT - 1)).data.ok, true, "10-29 00:00:00 Chicago: a fresh $20, not what 10-28 left");
    const last = await rsv("2026-10-30T04:59:59Z"); eq(last.data.ok, true, "10-29 23:59:59 Chicago: allowed while the $20 lasts");
    eq((await rsv("2026-10-30T04:59:59Z")).data.state, "limit", "and refused once it is gone");
    // A settle that lands after the window closed is still accounted for on its row (inside the TTL, so not yet expired).
    eq((await svc.rpc("model_budget_settle", { p_id: last.data.id, p_actual_micros: 1, p_now: "2026-10-30T05:00:30Z" })).data.ok, true, "settled after the window, counted");
    eq((await rsv("2026-10-30T05:00:00Z")).data.state, "after_window", "10-30 00:00:00 Chicago: refused");
    for (const iso of ["2026-10-30T05:00:01Z", "2026-10-31T12:00:00Z", "2026-11-01T12:00:00Z", "2026-11-02T12:00:00Z", "2027-01-01T12:00:00Z"])
      eq((await rsv(iso)).data.state, "after_window", `after the window (${iso}): refused, no rollover`);
    eq(N(await pg.sql(`select count(*) from public.model_budget_days`)), 2, "no code created another budget row");
    eq(await pg.sql(`select spent_micros + reserved_micros from public.model_budget_days where day = '2026-10-29'`), String(LIMIT), "the one day holds the whole $20 (reservations past the TTL became spent), never more");
    eq(N(await pg.sql(`select count(*) from public.founder_alerts where kind = 'model_budget_closed'`)) >= 1, true, "a closed refusal wrote an alert");
    // A window with no approved row spends nothing: moving the settings alone does not create a budget.
    await pg.sql(`update public.model_budget_settings set value='2026-11-02T00:00:00-06:00' where key='window_start'; update public.model_budget_settings set value='2026-11-03T00:00:00-06:00' where key='window_end';`);
    eq((await rsv("2026-11-02T12:00:00Z")).data.state, "no_budget", "settings without an owner-approved row: refused");
    eq(N(await pg.sql(`select count(*) from public.model_budget_days`)), 2, "still no row made by code");
    // The owner approves a new budget (an owner-run statement): only then is it spendable. 2026-11-01 is the 25-hour fall-back day.
    await resetBudget(pg);
    await pg.sql(`insert into public.model_budget_days(day, limit_micros) values ('2026-11-01', 20000000);
      update public.model_budget_settings set value='2026-11-01T00:00:00-05:00' where key='window_start'; update public.model_budget_settings set value='2026-11-02T00:00:00-06:00' where key='window_end';`);
    eq((await rsv("2026-10-29T15:00:00Z")).data.state, "before_window", "the old day is now before the new window");
    eq((await rsv("2026-11-01T04:59:59Z")).data.state, "before_window");
    eq((await rsv("2026-11-01T05:00:00Z", 12_000_000)).data.ok, true, "11-01 00:00 CDT: allowed");
    eq((await rsv("2026-11-01T06:30:00Z", 8_000_000)).data.ok, true, "1:30 CDT");
    eq((await rsv("2026-11-01T07:30:00Z")).data.state, "limit", "1:30 CST shares 1:30 CDT's budget; the repeated hour is not a second $20");
    eq((await rsv("2026-11-02T05:59:59Z")).data.state, "limit", "the last second of the 25-hour day is still that budget");
    eq((await rsv("2026-11-02T06:00:00Z")).data.state, "after_window", "11-02 00:00 CST: refused");
    // The settings must be well formed, or nothing is spent.
    for (const bad of ["tomorrow", "2026-11-01", "2026-11-01 00:00:00", "2026-11-01T00:00:00"]) {
      await pg.sql(`update public.model_budget_settings set value='${bad}' where key='window_start'`); assert((await rsv("2026-11-01T12:00:00Z")).error, `a malformed window_start (${bad}) errors, so the caller makes no call`); }
    await resetBudget(pg);
    await books(pg, "window"); }
  // 9. Each day's limit is its own row (only an owner-run statement changes it); the pause is a server-side setting row; a
  //    malformed one fails closed.
  await resetBudget(pg);
  { await pg.sql(`update public.model_budget_days set limit_micros = 1000000 where day = '2026-10-29'`);
    eq((await reserve(pg, 1_500_000)).data.state, "limit", "the day's row is the limit"); eq((await reserve(pg, 1_000_000)).data.ok, true);
    await pg.sql(`update public.model_budget_days set limit_micros = 30000000 where day = '2026-10-29'`); eq((await reserve(pg, 25_000_000)).data.ok, true, "raised by the row");
    eq((await day(pg, "2026-10-28")).limit, TODAY_LIMIT, "another day's limit is untouched");
    await resetBudget(pg); await pg.sql(`update public.model_budget_settings set value='true' where key='paused'`);
    eq((await reserve(pg, 1)).data.state, "paused", "paused: nothing is reserved"); eq(N(await pg.sql(`select count(*) from public.model_budget_reservations`)), 0);
    eq(N(await pg.sql(`select count(*) from public.founder_alerts where kind='model_budget_paused'`)), 1);
    await pg.sql(`update public.model_budget_settings set value='maybe' where key='paused'`); assert((await reserve(pg, 1)).error, "a malformed pause errors (fail closed)");
    await pg.sql(`update public.model_budget_settings set value='false' where key='paused'`); eq((await reserve(pg, 1)).data.ok, true); }
  // 10. The first refusal of a day writes ONE founder alert, however many are refused at once.
  await resetBudget(pg);
  { await reserve(pg, LIMIT); await Promise.all(Array.from({ length: 60 }, () => reserve(pg, 1)));
    eq(N(await pg.sql(`select count(*) from public.founder_alerts where kind='model_budget_exhausted'`)), 1, "one alert for 60 refusals");
    eq(await pg.sql(`select detail->>'day' from public.founder_alerts where kind='model_budget_exhausted'`), today); }
  // 11. A cost above what was reserved is recorded in full (the truth), and the day then refuses more.
  await resetBudget(pg);
  { const id = (await reserve(pg, 1_000_000)).data.id; await svc.rpc("model_budget_settle", { p_id: id, p_actual_micros: 19_500_000 });
    eq((await day(pg, today)).spent, 19_500_000); eq((await reserve(pg, 600_000)).data.state, "limit");
    eq(N(await pg.sql(`select count(*) from public.founder_alerts where kind='model_budget_overrun'`)), 1); await books(pg, "overrun"); }
  // 12. Bad amounts raise (the caller then makes no call).
  for (const bad of [0, -1]) assert((await reserve(pg, bad)).error, `a reservation of ${bad} errors`);
  assert((await svc.rpc("model_budget_reserve", { p_micros: null })).error, "null errors");
  assert((await svc.rpc("model_budget_settle", { p_id: crypto.randomUUID(), p_actual_micros: -1 })).error, "a negative actual errors");
  // 13. Only the server's role may touch it: a signed-in person cannot reserve, settle, read or write the tables.
  { const u = pg.asPerson("00000000-0000-0000-0000-0000000000f1");
    for (const [fn, args] of [["model_budget_reserve", { p_micros: 1 }], ["model_budget_settle", { p_id: crypto.randomUUID() }], ["model_budget_release", { p_id: crypto.randomUUID() }], ["model_budget_expire", {}]] as const)
      assert((await u.rpc(fn, args)).error, `${fn} is refused to a signed-in person`);
    for (const stmt of ["select * from public.model_budget_days", "update public.model_budget_settings set value='999999999999'", "insert into public.model_budget_days(day,limit_micros) values (current_date,1)"]) {
      let refused = false; try { await pg.sql(`begin; set local role authenticated; ${stmt}; commit;`); } catch (_) { refused = true; } assert(refused, `authenticated may not: ${stmt}`);
      refused = false; try { await pg.sql(`begin; set local role anon; ${stmt}; commit;`); } catch (_) { refused = true; } assert(refused, `anon may not: ${stmt}`); } }
  await resetBudget(pg);
}

async function withPg(fn: (pg: Pg) => Promise<void>) {
  if (!pgBinDir()) { if (CI) throw Error("Postgres 16 is required in CI"); console.log("SKIP: no Postgres 16 (PGBIN)"); return; }
  const prev = Deno.env.get("PG_MAX_CONNECTIONS"); Deno.env.set("PG_MAX_CONNECTIONS", "400");
  const pg = await startPg({ migrationBudget: true });
  try { await fn(pg); } finally { await pg.stop(); if (prev === undefined) Deno.env.delete("PG_MAX_CONNECTIONS"); else Deno.env.set("PG_MAX_CONNECTIONS", prev); }
}
Deno.test({ name: "database: 200 concurrent reservations never exceed $20; settle, release, expiry, Chicago midnight and DST, settings, alerts, grants", sanitizeResources: false, sanitizeOps: false,
  fn: () => withPg(sqlScenarios) });

// ---- Part 4: callModel end to end on the database ---------------------------------------------------------------------------
Deno.test({ name: "end to end: 200 concurrent callModel calls on the real budget; only the affordable ones reach the provider, even with no usage records", sanitizeResources: false, sanitizeOps: false,
  fn: () => withPg(async (pg) => {
    await resetBudget(pg);
    const gate = Budget.rpcBudgetGate((name, args) => pg.asService().rpc(name, name === "model_budget_reserve" ? { ...args, p_now: IN_WINDOW } : args));
    await gate.reserve(1, { model: "m", role: "r" }).then((r) => r.ok && gate.release(r.id)); // warm
    await resetBudget(pg);
    // gpt-5 with a 100k output cap: about $1.00 worst case a call, so about 19 fit in $20.
    const big = { max_tokens: 100_000, messages: [{ role: "user", content: "hello" }] }, c5 = { ...cfg, model: "gpt-5" };
    const ev: Ev[] = [], p = provider(ev, { body: okBody(OMIT) }); // the provider "answers" and sends no usage at all
    const rs = await Promise.allSettled(Array.from({ length: 200 }, () => Gateway.callModel(c5, big, { request: p.request, budget: gate })));
    const sent = p.sent.length, d = await day(pg, "2026-10-29");
    const worst = Budget.worstCaseMicros("gpt-5", Gateway.PRICES, { bytes: new TextEncoder().encode(JSON.stringify(p.sent[0].body)).length, images: 0, maxOutputTokens: 100_512 });
    eq(sent, Math.floor(LIMIT / worst), "exactly the affordable number of calls were sent"); eq(rs.filter((r) => r.status === "fulfilled").length, sent);
    eq(d.reserved, 0, "all settled"); eq(d.spent, sent * worst, "no usage record: every call stays spent at its worst case");
    assert(d.spent <= LIMIT, "never over $20");
    const refused = rs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
    assert(refused.length === 200 - sent && refused.every((e) => e instanceof ModelBudgetBlockedError && e.type === "global_daily_limit"));
    await books(pg, "end to end");
    // A database that errors: the call is not made.
    const down = Budget.rpcBudgetGate(async () => ({ data: null, error: { message: "db down" } })); const ev2: Ev[] = [], p2 = provider(ev2);
    const e = await blockedOf(Gateway.callModel(cfg, payload, { request: p2.request, budget: down })); assert(e instanceof ModelUnavailableError && e.type === "budget_unavailable"); eq(p2.sent.length, 0);
  }) });

// ---- Part 5: mutation checks ------------------------------------------------------------------------------------------------
// SQL guards: each mutant replaces the function text in the live database, the same scenarios must fail, then the real text is put back.
const SQL_MUTANTS: { name: string; from: string; to: string }[] = [
  { name: "read-then-write: the total is read from the statement's snapshot, not the locked row", from: `where day = d and spent_micros + reserved_micros + p_micros <= limit_micros`, to: `where day = d and (select spent_micros + reserved_micros from public.model_budget_days where day = d) + p_micros <= limit_micros` },
  { name: "the exact fit is refused (<= became <)", from: `spent_micros + reserved_micros + p_micros <= limit_micros`, to: `spent_micros + reserved_micros + p_micros < limit_micros` },
  { name: "spent money is ignored by the limit", from: `spent_micros + reserved_micros + p_micros <= limit_micros`, to: `reserved_micros + p_micros <= limit_micros` },
  { name: "a missing usage record frees the budget (settle null counts zero)", from: `actual_micros = coalesce(p_actual_micros, micros), closed_at = p_now\n    where id = p_id and status = 'reserved' returning day, micros, actual_micros`, to: `actual_micros = coalesce(p_actual_micros, 0), closed_at = p_now\n    where id = p_id and status = 'reserved' returning day, micros, actual_micros` },
  { name: "an expired reservation is refunded instead of kept as spent", from: `spent_micros = d.spent_micros + p.m, updated_at = p_now`, to: `spent_micros = d.spent_micros, updated_at = p_now` },
  { name: "the day follows UTC, not Chicago", from: `select (p_at at time zone 'America/Chicago')::date`, to: `select (p_at at time zone 'UTC')::date` },
  { name: "a settled reservation can be released afterwards", from: `closed_at = p_now\n    where id = p_id and status = 'reserved' returning day, micros into r;`, to: `closed_at = p_now\n    where id = p_id and status in ('reserved','settled') returning day, micros into r;` },
  { name: "every refusal writes its own alert", from: `jsonb_build_object('day', d::text, 'limit_micros'`, to: `jsonb_build_object('day', clock_timestamp()::text, 'limit_micros'` },
  { name: "a call before the window is allowed (spent early)", from: `if p_now < ws then return public.model_budget_closed('before_window', p_now); end if;`, to: `` },
  { name: "a call after the window is allowed (rollover)", from: `if p_now >= we then return public.model_budget_closed('after_window', p_now); end if;`, to: `` },
  { name: "the window end is inclusive", from: `if p_now >= we then`, to: `if p_now > we then` },
  { name: "code creates the budget row itself", from: `perform 1 from public.model_budget_days where day = d;`, to: `insert into public.model_budget_days (day, limit_micros) values (d, 20000000) on conflict (day) do nothing; perform 1 from public.model_budget_days where day = d;` },
  { name: "the pause setting is ignored", from: `if paused in ('true', '1', 'yes', 'on') then`, to: `if false then` },
  { name: "stuck reservations never expire", from: `perform public.model_budget_expire(p_now);`, to: `` },
  { name: "every day is charged to the window's first day (one shared budget)", from: `d := public.model_budget_day(p_now);`, to: `d := public.model_budget_day(ws);` },
];
Deno.test({ name: "mutation: each database guard is broken in turn and the scenarios catch it", sanitizeResources: false, sanitizeOps: false,
  fn: () => withPg(async (pg) => {
    const original = await Deno.readTextFile(MIGRATION);
    const apply = async (sql: string) => { const f = await Deno.makeTempFile({ suffix: ".sql" }); await Deno.writeTextFile(f, sql); await pg.sql(await Deno.readTextFile(f)); await Deno.remove(f); };
    await sqlScenarios(pg); // the unmutated database passes
    for (const m of SQL_MUTANTS) {
      assert(original.includes(m.from), `mutation target present: ${m.name}`);
      await apply(original.replace(m.from, m.to)); await resetBudget(pg); // a clean start, so a mutant is caught by its own behavior and not by a leftover
      let caught = "";
      try { await sqlScenarios(pg); } catch (e) { caught = (e as Error).message.split("\n")[0].slice(0, 110); }
      await apply(original); await resetBudget(pg);
      assert(caught, `MUTANT SURVIVED: ${m.name}`);
      console.log(`  caught: ${m.name} -> ${caught}`);
    }
    await sqlScenarios(pg); // restored
  }) });

// TypeScript guards: the same, on copies of the gateway and the budget module.
type Mut = { name: string; file: "gateway" | "budget"; from: string; to: string };
const TS_MUTANTS: Mut[] = [
  { name: "no reservation is made before the request", file: "gateway", from: `const got = await gate.reserve(worst, { model: cfg.model, role });`, to: `const got = { ok: true as const, id: "00000000-0000-0000-0000-000000000000" };` },
  { name: "a refused reservation does not stop the call", file: "gateway", from: `if (!got.ok) {`, to: `if (false as boolean && !got.ok) {` },
  { name: "an unreadable budget fails open", file: "gateway", from: `  if (!got.ok) {`, to: `  if (!got.ok && got.reason === "limit") {` },
  { name: "missing usage is read as zero cost", file: "gateway", from: `usageProven(cfg.provider, parsed) ? costMicros(cfg.model, out.usage) : null`, to: `costMicros(cfg.model, out.usage)` },
  { name: "an unpriced model settles at zero", file: "gateway", from: `if (actual !== null && Number.isFinite(actual)) close = { kind: "actual", micros: Math.max(1, actual) };`, to: `close = { kind: "actual", micros: actual ?? 0 };` },
  { name: "a network error releases the reservation", file: "gateway", from: `const e = new ModelUnavailableError(0, err && (err as any).name === "TimeoutError" ? "timeout" : "network"`, to: `close = { kind: "release" }; const e = new ModelUnavailableError(0, err && (err as any).name === "TimeoutError" ? "timeout" : "network"` },
  { name: "a 5xx releases the reservation", file: "gateway", from: `if (REFUSED_BEFORE_GENERATION.has(res.status)) close`, to: `if (true) close` },
  { name: "a provider refusal is never given back", file: "gateway", from: `if (REFUSED_BEFORE_GENERATION.has(res.status)) close = { kind: "release" };`, to: `` },
  { name: "the kill switch is ignored", file: "gateway", from: `if (budgetPausedByEnv(env || (() => undefined))) throw`, to: `if (false as boolean) throw` },
  { name: "a failed settle breaks the answer", file: "gateway", from: `} catch (e) { console.error("[model] budget settle failed;`, to: `} catch (e) { throw e; console.error("[model] budget settle failed;` },
  { name: "the plain-words reply is replaced by the outage sentence", file: "gateway", from: `reply: block ? budgetReply(block) : OUTAGE_REPLY`, to: `reply: OUTAGE_REPLY` },
  { name: "a URL with no key falls back to the local gate", file: "budget", from: `if (url || key) return null;`, to: `` },
  { name: "an unknown model is priced at zero", file: "budget", from: `: highestPrice(prices);`, to: `: { input: 0, output: 0 };` },
  { name: "the output cap is left out of the worst case", file: "budget", from: `Math.max(0, body.maxOutputTokens) * rate.output`, to: `0 * rate.output` },
  { name: "a missing usage field counts as proven", file: "budget", from: `const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;`, to: `const ok = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);` },
  { name: "an invalid reservation size is sent on", file: "budget", from: `if (!wholeMicros(micros)) return { ok: false, reason: "unavailable", detail: "worst-case cost is not a positive whole number" };\n      try {`, to: `try {` },
  { name: "an unrecognized budget answer counts as ok", file: "budget", from: `return { ok: false, reason: "unavailable", detail: "the budget function answered in a shape that is not understood" };`, to: `return { ok: true, id: "00000000-0000-0000-0000-000000000000" };` },
  { name: "the memory twin ignores the limit", file: "budget", from: `if (t.spent + t.reserved + micros > limitMicros) return { ok: false, reason: "limit" };`, to: `` },
  { name: "a closed window is reported as an outage", file: "budget", from: `if (d && d.ok === false && d.state === "before_window") return { ok: false, reason: "before" };`, to: `` },
  { name: "no approved budget row is treated as spendable", file: "budget", from: `(d.state === "after_window" || d.state === "no_budget")`, to: `(d.state === "after_window")` },
];
Deno.test("mutation: each gateway and budget guard is broken in turn and the scenarios catch it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "budget-mutant-" });
  try {
    const src = { gateway: await Deno.readTextFile(new URL("model_gateway.ts", SHARED)), budget: await Deno.readTextFile(new URL("model_budget.ts", SHARED)) };
    const calls = new URL("model_calls.ts", SHARED).href;
    let n = 0;
    const load = async (m?: Mut) => {
      const id = n++, bFile = `${dir}/budget${id}.ts`, gFile = `${dir}/gateway${id}.ts`;
      let g = src.gateway.replace(`from "./model_calls.ts"`, `from "${calls}"`).replace(`from "./model_budget.ts"`, `from "file://${bFile}"`);
      let b = src.budget;
      if (m) {
        const cur = m.file === "gateway" ? g : b; assert(cur.includes(m.from), `mutation target present: ${m.name}`);
        if (m.file === "gateway") g = g.replace(m.from, m.to); else b = b.replace(m.from, m.to);
      }
      await Deno.writeTextFile(bFile, b); await Deno.writeTextFile(gFile, g);
      const G = await import(`file://${gFile}`), B = await import(`file://${bFile}`);
      return { G, B };
    };
    const ok = await load(); await gatewayScenarios(ok.G, ok.B); // the unmutated copy passes
    for (const m of TS_MUTANTS) {
      const { G, B } = await load(m); let caught = false;
      // The budget module the scenarios build their gates from is the mutant's own, so budget mutants are in play too.
      try { await gatewayScenarios(G, B); } catch (_) { caught = true; }
      assert(caught, `MUTANT SURVIVED: ${m.name}`);
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
});
