// The four live eval runners outside evals/career/run.ts (real-sets research and people, mirror run-trainee, mirror held-out live)
// go through the ONE shared $80 ledger when --live (eval_budget.ts openLiveRunLedger): the cap is reserved before the first model
// call and settled after; an unreachable ledger, a refused reservation, a cap above the per-run maximum or an approval that is not a
// DECISIONS.md row refuses the run before any model call. Fakes only: a fake PostgREST ledger and a fake HTTPS proxy on 127.0.0.1
// that records every CONNECT and forwards nothing, so no request leaves the machine and nothing is spent.
import assertNode from "node:assert/strict";
import { approvalRowExists, LIVE_RUN_MAX_USD, openLiveRunLedger } from "../../evals/career/eval_budget.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DECISIONS = await Deno.readTextFile(`${ROOT}/docs/architect/DECISIONS.md`);
const LEDGER_ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };

function fakeGate(o: { status?: boolean; grant?: boolean } = {}) {
  const ev: string[] = [];
  const gate = {
    status: async () => { ev.push("status"); return o.status === false ? null : { total: 0 }; },
    reserve: async (m: number) => { ev.push(`reserve:${m}`); return o.grant === false ? { ok: false, reason: "limit" } : { ok: true, id: "11111111-2222-3333-4444-555555555555" }; },
    settle: async (_id: string, a: number | null) => { ev.push(`settle:${a}`); return true; },
  };
  let asked: ((k: string) => string | undefined) | null = null;
  const bud = { resolveBudgetGate: (_e: undefined, get: (k: string) => string | undefined) => { asked = get; return get("SUPABASE_URL") && get("SUPABASE_SERVICE_ROLE_KEY") ? gate : null; } };
  return { ev, bud, asked: () => asked };
}
const open = (budgetUsd: number, env: Record<string, string>, f: ReturnType<typeof fakeGate>, approval = "D-068") =>
  openLiveRunLedger({ budgetUsd, approval, get: (k) => env[k], bud: f.bud, decisions: DECISIONS });

Deno.test("ERL/1 openLiveRunLedger: refusals before any reservation, the shared ledger only, reserve then settle", async () => {
  eq(LIVE_RUN_MAX_USD, 10);
  assert(approvalRowExists("D-068", DECISIONS) && approvalRowExists("D-057", DECISIONS) && !approvalRowExists("D-999", DECISIONS) && !approvalRowExists("D-06", DECISIONS));
  for (const b of [0, -1, NaN, 10.01, 50]) { const f = fakeGate(); const r = await open(b, LEDGER_ENV, f); assert("error" in r && /at most 10/.test(r.error), String(b)); eq(f.ev, []); }
  { const f = fakeGate(); const r = await open(1, LEDGER_ENV, f, "D-999"); assert("error" in r && /DECISIONS/.test(r.error)); eq(f.ev, []); }
  { const f = fakeGate(); const r = await open(1, {}, f); assert("error" in r && /missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/.test(r.error)); eq(f.ev, []);
    eq(f.asked()!("EVAL_LEDGER"), "shared", "the ledger is resolved with EVAL_LEDGER=shared: never the process-local twin"); }
  { const f = fakeGate({ status: false }); const r = await open(1, LEDGER_ENV, f); assert("error" in r && /unreachable/.test(r.error)); eq(f.ev, ["status"]); }
  { const f = fakeGate({ grant: false }); const r = await open(2, LEDGER_ENV, f); assert("error" in r && /refused the cap \$2/.test(r.error)); eq(f.ev, ["status", "reserve:2000000"]); }
  { const f = fakeGate(); const r = await open(2.5, LEDGER_ENV, f); assert(!("error" in r));
    if ("error" in r) throw new Error(r.error);
    eq(f.ev, ["status", "reserve:2500000"]);
    await r.settle(0.1234561); await r.settle(9); eq(f.ev, ["status", "reserve:2500000", "settle:123457"], "settled once, to the metered micros (rounded up)"); }
  { const f = fakeGate(); const r = await open(1, LEDGER_ENV, f); if ("error" in r) throw new Error(r.error); await r.settle(null); eq(f.ev.at(-1), "settle:null", "unknown cost: the whole cap stays spent"); }
  // Review round 2 (the bypass): a reservation id handed in from outside is never trusted, in CI or not. The ledger offers no
  // narrow read of one reservation, so the runner always reserves and settles its own cap.
  const id = "00000000-0000-0000-0000-000000000000";
  { const f = fakeGate(); const r = await open(5, { EVAL_LEDGER_RESERVATION_ID: id, GITHUB_ACTIONS: "true" }, f); assert("error" in r && /cannot be opened/.test(r.error), "no ledger: refused, whatever id is set"); eq(f.ev, []); }
  { const f = fakeGate(); const r = await open(5, { ...LEDGER_ENV, EVAL_LEDGER_RESERVATION_ID: id, GITHUB_ACTIONS: "true" }, f); if ("error" in r) throw new Error(r.error);
    assert(r.id !== id); eq(f.ev, ["status", "reserve:5000000"], "its own reservation, the outside id ignored"); }
});

// ---- the runners themselves, as subprocesses ------------------------------------------------------------------------------
type Call = { at: number; what: string };
function fakeLedgerServer(mode: "grant" | "refuse") {
  const calls: Call[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const name = new URL(req.url).pathname.split("/rpc/")[1] ?? "?", body = await req.json().catch(() => ({}));
    calls.push({ at: performance.now(), what: name });
    if (name === "model_budget_total_status") return Response.json({ state: "ok", spent: 0, reserved: 0, total: 0 });
    if (name === "model_budget_reserve") return Response.json(mode === "grant" ? { ok: true, id: crypto.randomUUID() } : { ok: false, state: "limit" });
    if (name === "model_budget_settle") { calls.push({ at: performance.now(), what: `settled:${body.p_actual_micros}` }); return Response.json({ ok: true }); }
    return Response.json({ ok: true });
  });
  return { calls, url: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}
// A proxy that forwards nothing: it records each CONNECT target and closes the connection.
function deadProxy() {
  const hits: Call[] = [], l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  (async () => { for await (const c of l) { (async () => { const b = new Uint8Array(2048); const n = await c.read(b).catch(() => null); if (n) hits.push({ at: performance.now(), what: new TextDecoder().decode(b.subarray(0, n)).split("\r\n")[0] }); try { c.close(); } catch (_) { /* closed */ } })(); } })().catch(() => {});
  return { hits, url: `http://127.0.0.1:${(l.addr as Deno.NetAddr).port}`, close: () => l.close() };
}
function closedPort(): number { const l = Deno.listen({ hostname: "127.0.0.1", port: 0 }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; }

const MAP = ["--import-map=tests/flow/supabase-npm.json"];
const RUNNERS: { name: string; flags: string[]; file: string; args: (b: number) => string[]; env: Record<string, string> }[] = [
  { name: "real-sets research", flags: [], file: "evals/real-sets/research/run.ts", args: (b) => ["--live", "--budget-usd", String(b)], env: { WEB_RESEARCH_SPEND_APPROVED: "D-068" } },
  { name: "real-sets people", flags: [], file: "evals/real-sets/people/run.ts", args: (b) => ["--live", "--budget-usd", String(b)], env: { PEOPLE_SEARCH_SPEND_APPROVED: "D-068" } },
  { name: "mirror run-trainee", flags: MAP, file: "evals/mirror/run-trainee.ts", args: (b) => ["--live", "--budget-usd", String(b), "--limit", "1"], env: { MIRROR_SPEND_APPROVED: "D-068" } },
  { name: "mirror held-out live", flags: MAP, file: "evals/mirror/heldout/live.ts", args: (b) => ["--sample", "1", "--budget-usd", String(b), "--label", "erl-test-not-written"], env: { MIRROR_SPEND_APPROVED: "D-068" } },
];
async function run(r: typeof RUNNERS[number], budget: number, ledgerUrl: string, proxy: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...r.env, ANTHROPIC_API_KEY: "sk-ant-test-not-real", SUPABASE_URL: ledgerUrl, SUPABASE_SERVICE_ROLE_KEY: "svc-test", HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", REAL_SET_OUT: await Deno.makeTempDir(), GITHUB_ACTIONS: "", EVAL_LEDGER_RESERVATION_ID: "", CI: "true", ...extra };
  const out = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", ...r.flags, r.file, ...r.args(budget)], cwd: ROOT, env, stdout: "piped", stderr: "piped" }).output();
  await Deno.remove(env.REAL_SET_OUT, { recursive: true }).catch(() => {});
  return { code: out.code, text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
}

for (const r of RUNNERS) {
  Deno.test(`ERL/2 ${r.name} --live: an unreachable ledger, a refused reservation or a cap over $${LIVE_RUN_MAX_USD} stops it before any model call`, async () => {
    const proxy = deadProxy(), refuse = fakeLedgerServer("refuse");
    try {
      const down = await run(r, 3, `http://127.0.0.1:${closedPort()}`, proxy.url);
      assert(down.code === 3 && /refused: the shared budget ledger is unreachable/.test(down.text), down.text.slice(-600));
      const no = await run(r, 3, refuse.url, proxy.url);
      assert(no.code === 3 && /refused: the shared ledger refused the cap \$3/.test(no.text), no.text.slice(-600));
      eq(refuse.calls.map((c) => c.what), ["model_budget_total_status", "model_budget_reserve"], "asked once, nothing settled, nothing more");
      if (r.name.startsWith("mirror")) {
        const over = await run(r, 11, refuse.url, proxy.url);
        assert(over.code === 3 && /at most 10/.test(over.text), over.text.slice(-600));
        eq(refuse.calls.length, 2, "a cap over the maximum never reaches the ledger");
      }
      const badRow = await run(r, 3, refuse.url, proxy.url, Object.fromEntries(Object.keys(r.env).map((k) => [k, "D-999"])));
      assert(badRow.code === 3 && /not a row of docs\/architect\/DECISIONS.md/.test(badRow.text), badRow.text.slice(-600));
      // The review's bypass: GITHUB_ACTIONS=true and a made-up reservation id, with no ledger and with an unreachable one.
      const fake = { GITHUB_ACTIONS: "true", EVAL_LEDGER_RESERVATION_ID: "00000000-0000-0000-0000-000000000000" };
      const byNone = await run(r, 3, "", proxy.url, { ...fake, SUPABASE_SERVICE_ROLE_KEY: "" });
      assert(byNone.code === 3 && /refused: the shared budget ledger cannot be opened/.test(byNone.text), byNone.text.slice(-600));
      const byDown = await run(r, 3, `http://127.0.0.1:${closedPort()}`, proxy.url, fake);
      assert(byDown.code === 3 && /refused: the shared budget ledger is unreachable/.test(byDown.text), byDown.text.slice(-600));
      eq(proxy.hits, [], "no request tried to leave the machine (no model call, no web)");
    } finally { await refuse.close(); proxy.close(); }
  });
}

Deno.test("ERL/3 real-sets people --live with a granting ledger: the cap is reserved before the first model request, settled after it", async () => {
  const proxy = deadProxy(), grant = fakeLedgerServer("grant");
  try {
    const out = await run(RUNNERS[1], 2, grant.url, proxy.url);
    const reserve = grant.calls.find((c) => c.what === "model_budget_reserve"), settle = grant.calls.find((c) => c.what.startsWith("settled:"));
    const firstModel = proxy.hits.find((h) => /api\.anthropic\.com/.test(h.what));
    assert(reserve && firstModel && reserve.at < firstModel.at, `reserve before the first model request: ${JSON.stringify({ calls: grant.calls, hits: proxy.hits.slice(0, 3) })} ${out.text.slice(-400)}`);
    assert(proxy.hits.every((h) => /api\.anthropic\.com/.test(h.what)), "only the model host was asked for, through the dead proxy");
    // A failed request cannot prove it was not billed, so the in-process meter counts its worst case; the ledger is settled to
    // exactly what the run reports as spent (never more than the reserved cap).
    const printed = Number(/REAL-SET PEOPLE LIVE spent_usd=([0-9.]+)/.exec(out.text)?.[1]), micros = Number(settle?.what.split(":")[1]);
    assert(settle && settle.at > firstModel.at && Math.abs(micros / 1e6 - printed) < 1e-4 && micros <= 2e6, `settled to the metered cost after the run: ${JSON.stringify(grant.calls)} ${out.text.slice(-300)}`);
    eq(grant.calls.filter((c) => c.what === "model_budget_reserve").length, 1, "one reservation for the run");
  } finally { await grant.close(); proxy.close(); }
});
