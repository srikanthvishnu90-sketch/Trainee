// Model cost visibility (2026-10-28): every career turn leaves one agent_turn_costs row, so a missing row can never be read
// as zero spend. Three kinds of row, never confused:
//   zero        meter_state 'metered', calls 0   the turn made no model call
//   metered     meter_state 'metered', calls n   the turn's calls
//   unrecorded  meter_state 'unrecorded', calls NULL   the sink was missing or refused the write: the count is unknown
// Fakes only: the provider is an in-process fake of OpenAI's URL (no key, no network, no spend), the database is a throwaway
// local Postgres, and the sink doubles are plain objects. Part 1 is the ledger (_shared/model_gateway.ts turnLedger) with
// fake sinks, and each guard is mutated to prove the test notices. Part 2 is the real handler (handleChat) on real Postgres.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/turn-cost-always-recorded.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { newMeter, meterAdd, modelConfig, turnLedger } from "../../supabase/functions/_shared/model_gateway.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const GATEWAY_PATH = new URL("../../supabase/functions/_shared/model_gateway.ts", import.meta.url);

// ---- Part 1: the ledger with fake sinks ------------------------------------------------------------------------------
type Row = Record<string, unknown>;
// A fake admin client that records inserts. refuse(row) returning a message makes that write fail like a refused insert.
function fakeSink(refuse: (r: Row) => string | null = () => null, opts: { throws?: boolean } = {}) {
  const rows: Row[] = [];
  return { rows, from(table: string) {
    assert(table === "agent_turn_costs", `only the cost table is written, not ${table}`);
    return { insert: async (r: Row) => {
      if (opts.throws) throw new Error("network down");
      const why = refuse(r); if (why) return { error: { message: why } };
      rows.push(r); return { error: null };
    } };
  } };
}
const cfg = { ...modelConfig({ get: () => undefined }, "chat"), model: "gpt-5-mini" };
const oneCall = () => { const m = newMeter(); meterAdd(m, cfg, { input_tokens: 100, output_tokens: 40 }); return m; };
const U = "00000000-0000-0000-0000-00000000aaaa", T = "00000000-0000-0000-0000-00000000bbbb";
const refuseCounted = (r: Row) => r.calls === null ? null : "permission denied";

// Every behavior the guard must keep, run against the real module and against each mutant.
async function ledgerScenarios(mod: { turnLedger: typeof turnLedger }) {
  // 1. A turn with no model call: one row, metered, calls 0 (not absent, not null).
  { const s = fakeSink(), l = mod.turnLedger(s, U, T); l.track(newMeter());
    eq(await l.finish(), "zero"); eq(s.rows.length, 1, "zero-call turn: exactly one row");
    eq([s.rows[0].meter_state, s.rows[0].calls, s.rows[0].user_id, s.rows[0].thread_id], ["metered", 0, U, T]); }
  // 2. A turn with one call: one row with the call, its tokens and cost; no extra zero row beside it.
  { const s = fakeSink(), l = mod.turnLedger(s, U, T); const m = l.track(oneCall()); await l.record(m);
    eq(await l.finish(), "metered"); eq(s.rows.length, 1, "one-call turn: exactly one row");
    eq([s.rows[0].meter_state, s.rows[0].calls, s.rows[0].input_tokens, s.rows[0].output_tokens, s.rows[0].provider], ["metered", 1, 100, 40, "openai"]);
    assert(Number(s.rows[0].usd_micros) > 0, "priced"); }
  // 3. A call whose turn never got to record it (the turn threw): finish() still records it.
  { const s = fakeSink(), l = mod.turnLedger(s, U, T); l.track(oneCall());
    eq(await l.finish(), "metered"); eq(s.rows.map((r) => r.calls), [1], "a meter left unrecorded is recorded at the end of the turn"); }
  // 4. The sink refuses the cost row: the turn is 'unrecorded' with calls NULL, never 0 and never absent.
  { const s = fakeSink(refuseCounted), l = mod.turnLedger(s, U, T); const m = l.track(oneCall()); await l.record(m);
    eq(await l.finish(), "unrecorded"); eq(s.rows.length, 1);
    eq([s.rows[0].meter_state, s.rows[0].calls], ["unrecorded", null], "a refused sink is unrecorded, not zero"); }
  // 5. Same when the zero row is the one refused.
  { const s = fakeSink(refuseCounted), l = mod.turnLedger(s, U, T); l.track(newMeter());
    eq(await l.finish(), "unrecorded"); eq([s.rows[0].meter_state, s.rows[0].calls], ["unrecorded", null]); }
  // 6. The sink is not wired at all: unrecorded, and nothing throws into the reply.
  for (const none of [null, undefined, {}]) { const l = mod.turnLedger(none, U, T); l.track(newMeter()); eq(await l.finish(), "unrecorded", "no sink is unrecorded, not zero"); }
  // 7. The sink throws (network): unrecorded, no throw.
  { const s = fakeSink(() => null, { throws: true }), l = mod.turnLedger(s, U, T); l.track(oneCall()); eq(await l.finish(), "unrecorded"); }
  // 8. A replayed turn adds no second row.
  { const s = fakeSink(), l = mod.turnLedger(s, U, T); l.skip(); eq(await l.finish(), "skipped"); eq(s.rows.length, 0); }
  // 9. The same meter recorded twice is one row.
  { const s = fakeSink(), l = mod.turnLedger(s, U, T); const m = l.track(oneCall()); await l.record(m); await l.record(m); await l.finish(); eq(s.rows.length, 1); }
}

Deno.test("ledger: zero-call, one-call and sink-failure turns each leave the right row (fake sinks)", async () => {
  await ledgerScenarios({ turnLedger });
});

// Mutation check: break each guard in a copy of the module and show the same scenarios fail. A guard no test notices is not a guard.
const MUTANTS: { name: string; from: string; to: string }[] = [
  { name: "no zero row for a turn without calls", from: `const err = await put({ meter_state: "metered", calls: 0 });\n        if (!err) return "zero";`, to: `return "zero";` },
  { name: "a refused sink is reported as zero spend", from: `const err = await put({ meter_state: "unrecorded", calls: null });`, to: `const err = await put({ meter_state: "metered", calls: 0 });` },
  { name: "unrecorded carries a count of 0 instead of NULL", from: `put({ meter_state: "unrecorded", calls: null })`, to: `put({ meter_state: "unrecorded", calls: 0 })` },
  { name: "a failed write is not marked unrecorded", from: `if (!failed && wrote > 0) return "metered";`, to: `if (wrote > 0 || failed) return "metered";` },
  { name: "a missing sink counts as written", from: `if (!admin || typeof admin.from !== "function") return "no cost sink is wired";`, to: `if (!admin || typeof admin.from !== "function") return null;` },
  { name: "meters left unrecorded are dropped at the end of the turn", from: `for (const m of tracked) await record(m);`, to: `` },
  { name: "a metered turn also writes a zero row", from: `if (!failed && wrote > 0) return "metered";`, to: `if (!failed && wrote > 0) { await put({ meter_state: "metered", calls: 0 }); return "metered"; }` },
  { name: "a replayed turn writes a row", from: `if (skipped) return "skipped";`, to: `` },
];
Deno.test("ledger: every guard is mutation-checked (the scenarios fail on each broken copy)", async () => {
  const src = await Deno.readTextFile(GATEWAY_PATH);
  const dir = await Deno.makeTempDir({ prefix: "ledger-mutant-" });
  try {
    // The mutant loads from a temp dir, so its one relative import becomes an absolute URL.
    const calls = new URL("../../supabase/functions/_shared/model_calls.ts", import.meta.url).href;
    const budget = new URL("../../supabase/functions/_shared/model_budget.ts", import.meta.url).href;
    const base = src.replace(`from "./model_calls.ts"`, `from "${calls}"`).replace(`from "./model_budget.ts"`, `from "${budget}"`);
    assert(base !== src && !base.includes(`from "./`), "the imports were rewritten");
    // The unmutated copy passes: the harness itself is sound.
    await Deno.writeTextFile(`${dir}/ok.ts`, base);
    await ledgerScenarios(await import(`file://${dir}/ok.ts`));
    let n = 0;
    for (const mu of MUTANTS) {
      assert(base.includes(mu.from), `mutation target present: ${mu.name}`);
      const file = `${dir}/mutant${n++}.ts`;
      await Deno.writeTextFile(file, base.replace(mu.from, mu.to));
      let failed = false;
      try { await ledgerScenarios(await import(`file://${file}`)); } catch (_) { failed = true; }
      assert(failed, `MUTANT SURVIVED: ${mu.name}`);
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("handler source: the sink is the ledger, finished in finally, and no turn path writes cost rows around it", async () => {
  const H = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  assert(/const ledger = turnLedger\(admin, user\.id, tid\);/.test(H), "one ledger per turn");
  assert(/finally \{\s*await ledger\.finish\(\)/.test(H), "finished in finally, so every path (replay aside) is recorded");
  assert(!H.includes('from("agent_turn_costs")'), "no code path writes cost rows around the ledger");
  assert(!H.includes("recordTurnCost"), "the old per-branch writer is gone");
  for (const meter of ["draftMeter", "outreachMeter", "netMeter", "meter", "f5Meter", "rwMeter"]) assert(new RegExp(`${meter} = ledger\\.track\\(newMeter\\(\\)\\)`).test(H), `${meter} is tracked`);
});

// ---- Part 2: the real handler on real Postgres, fake provider ----------------------------------------------------------
const ids = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-00000${String(2610280 + n).padStart(7, "0")}`;
const PEOPLE: Record<string, string> = {};
for (let n = 1; n <= 6; n++) PEOPLE[`tok-tc${n}`] = ids(n);
const P = (n: number) => PEOPLE[`tok-tc${n}`];
const ADVICE = "how should I follow up after an interview?";
const ANSWER = "Send a short thank-you note within a day that names one thing you discussed.";
let modelRequests = 0;
const fakeOpenAI = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  if (new URL(req.url).hostname !== "api.openai.com") return new Response("not reachable in this test", { status: 404 });
  const body = await req.json(); modelRequests++;
  return new Response(JSON.stringify({ id: "fake", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }), { status: 200, headers: { "content-type": "application/json" } });
};

Deno.test({ name: "real handler: zero-call, one-call and sink-failure turns leave persisted rows", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const keys = ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "OPENAI_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = Deno.env.get(k);
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const pid of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${pid}', '${pid}@example.test'); insert into public.profiles (id) values ('${pid}');
        insert into public.career_watch_kv (user_id, key, value) values ('${pid}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    Deno.env.set("OPENAI_API_KEY", "sk-fake-tc-not-a-key"); Deno.env.delete("MODEL_PROVIDER"); Deno.env.set("CAREER_MODEL", "gpt-5-mini");
    Deno.env.delete("CAREER_MODEL_DAILY_USD"); Deno.env.delete("CAREER_MODEL_DAILY_CALLS"); Deno.env.delete("CAREER_BRAIN_ROUTER_INTENTS");
    globalThis.fetch = fakeOpenAI as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    const say = async (c: Chat, message: string, extra: Record<string, unknown> = {}) => { const r = await c.say(message, extra); eq(r.status, 200, r.reply); return r; };
    // [meter_state, calls, models] per row, oldest first; calls is null for unrecorded.
    const rows = async (pid: string) => JSON.parse((await pg.sql(`select coalesce(json_agg(json_build_array(meter_state, calls, models) order by id), '[]'::json) from public.agent_turn_costs where user_id = '${pid}'`)) || "[]");

    await t.step("a zero-call turn (the router answers, no model asked) leaves one row that says 0 calls", async () => {
      Deno.env.set("CAREER_BRAIN", "router"); // D-035: unset now serves the release brain (staged); the router path is the rollback
      const n = modelRequests;
      await say(handler!.chat("tok-tc1"), "hi");
      eq(modelRequests - n, 0, "no model request was made");
      eq(await rows(P(1)), [["metered", 0, []]], "one row: metered, calls 0");
      // Two more zero-call turns: a row each, so the count of turns is the count of rows.
      const c = handler!.chat("tok-tc1"); await say(c, "hello"); await say(c, "hi there");
      eq((await rows(P(1))).map((r: any[]) => r[1]), [0, 0, 0]);
    });

    await t.step("a one-call turn (the brain answers) leaves exactly one row with the call and its cost", async () => {
      Deno.env.set("CAREER_BRAIN", "staged");
      const n = modelRequests;
      const r = await say(handler!.chat("tok-tc2"), ADVICE);
      assert(r.reply.includes(ANSWER), r.reply);
      eq(modelRequests - n, 1, "one model request");
      eq(await rows(P(2)), [["metered", 1, ["gpt-5-mini"]]], "one row, no extra zero row beside it");
      const usd = Number(await pg.sql(`select usd_micros from public.agent_turn_costs where user_id = '${P(2)}'`));
      assert(usd > 0, `priced (${usd})`);
    });

    await t.step("the same turn key sent twice is one turn: one row", async () => {
      Deno.env.set("CAREER_BRAIN", "router"); // D-035: unset now serves the release brain (staged); the router path is the rollback
      const c = handler!.chat("tok-tc3");
      await say(c, "hi", { turn_key: "tc-replay-1" });
      await say(c, "hi", { turn_key: "tc-replay-1" });
      eq((await rows(P(3))).length, 1, "the replay is the first run's answer, not a second turn");
    });

    await t.step("sink failure: the cost row is refused, the reply still goes out, and the turn is recorded 'unrecorded' (not 0)", async () => {
      // Test fixture: refuse any cost row that carries a count, for these people only (as a revoked grant or a full disk would).
      await pg.sql(`create function public.tc_refuse_counted() returns trigger language plpgsql as $f$ begin
          if new.calls is not null then raise exception 'cost sink refused (test fixture)'; end if; return new; end $f$;
        create trigger tc_refuse before insert on public.agent_turn_costs for each row
          when (new.user_id in ('${P(4)}', '${P(5)}')) execute function public.tc_refuse_counted();`);
      // A model turn: the call is made, its cost row is refused.
      Deno.env.set("CAREER_BRAIN", "staged");
      const n = modelRequests;
      const r = await say(handler!.chat("tok-tc4"), ADVICE);
      assert(r.reply.includes(ANSWER), "the reply is not lost to the cost write");
      eq(modelRequests - n, 1, "the model was called");
      eq(await rows(P(4)), [["unrecorded", null, []]], "unrecorded, calls NULL: the spend of this turn is unknown, not zero");
      // A zero-call turn whose zero row is refused is unrecorded too.
      Deno.env.set("CAREER_BRAIN", "router"); // D-035: unset now serves the release brain (staged); the router path is the rollback
      await say(handler!.chat("tok-tc5"), "hi");
      eq(await rows(P(5)), [["unrecorded", null, []]]);
      // Another person's zero-call turn is unaffected.
      await say(handler!.chat("tok-tc6"), "hi");
      eq(await rows(P(6)), [["metered", 0, []]]);
    });

    await t.step("the daily view counts unrecorded turns apart from the known calls", async () => {
      const v = JSON.parse(await pg.sql(`select row_to_json(v) from (select turns, model_calls, unrecorded_turns from public.agent_daily_costs where user_id = '${P(4)}') v`));
      eq([Number(v.turns), Number(v.model_calls ?? 0), Number(v.unrecorded_turns)], [1, 0, 1], "one turn, no known calls, one unrecorded: a lower bound, not a zero");
    });
  } finally {
    for (const k of keys) { if (saved[k] === undefined) Deno.env.delete(k); else Deno.env.set(k, saved[k]!); }
    handler?.restore();
    await pg.stop();
  }
} });
