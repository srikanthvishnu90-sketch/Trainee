// Model health (live finding 2026-10-11: every model call failed for hours and nothing noticed). An uptime monitor calls
// model-health with a token; a dead provider answers 503 within one probe, with the provider's cause, and leaves one
// founder alert per hour. The provider and the database are stubs here.
import { handleHealth, tokenOk } from "../../supabase/functions/_shared/model_health.ts";
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
const TOKEN = "health-token-0123456789abcdef";
const KEY = "sk-ant-TESTKEY-should-never-appear-anywhere-0000";
const env = (o: Record<string, string> = {}) => ({ get: (k: string) => ({ HEALTH_CHECK_TOKEN: TOKEN, ANTHROPIC_API_KEY: KEY, ...o } as Record<string, string>)[k] });
function db(verdict: any, alertsInLastHour = 0) {
  const events: any[] = [], alerts: any[] = [];
  return { events, alerts, budgetCalls: [] as any[], budget: { state: "warning", total: 60_000_000, target: 70_000_000, hard: 100_000_000 } as any,
    async rpc(name: string, args?: any) { if (name === "model_budget_total_status") { this.budgetCalls.push(args); return { data: this.budget, error: null }; } assert(name === "model_health"); return { data: verdict, error: null }; },
    from(t: string) {
      if (t === "agent_provider_events") return { async insert(r: any) { events.push(r); return { error: null }; } };
      const q: any = { select() { return q; }, eq() { return q; }, gte() { return Promise.resolve({ count: alertsInLastHour, error: null }); }, async insert(r: any) { alerts.push(r); return { error: null }; } };
      return q;
    } };
}
const ok = async () => Response.json({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 2 } });
const dead = async () => Response.json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${KEY.slice(0, 10)}****0000.` } }, { status: 401 });
const get = (q: string) => new Request(`https://x.supabase.co/functions/v1/model-health${q}`);

Deno.test("no token or a wrong token: 401, nothing probed, nothing read", async () => {
  let sent = 0; const d = db({ status: "ok" });
  for (const q of ["?probe=1", "?probe=1&token=wrong", `?probe=1&token=${TOKEN}x`]) {
    const r = await handleHealth(get(q), { env: env(), admin: d, request: (async () => { sent++; return ok(); }) as any });
    assert(r.status === 401, q);
  }
  assert(sent === 0 && d.events.length === 0);
  assert(!tokenOk(TOKEN, "short"), "a short configured token never authorizes");
});

Deno.test("a working provider: the probe answers, the call is recorded, 200 ok with the provider and model named", async () => {
  const d = db({ status: "ok", calls: 5, errors: 0 });
  const r = await handleHealth(get(`?probe=1&token=${TOKEN}`), { env: env(), admin: d, request: ok as any });
  const b = await r.json();
  assert(r.status === 200 && b.status === "ok" && b.provider === "Anthropic" && b.model === "claude-sonnet-5-5" && b.probe.ok && b.probe.reply === "OK", JSON.stringify(b));
  assert(d.events.length === 1 && d.events[0].role === "probe" && d.events[0].ok === true, JSON.stringify(d.events));
  assert(d.alerts.length === 0);
});

Deno.test("a dead key: 503 down on the first probe, the provider's cause without the key, one founder alert per hour", async () => {
  const d = db({ status: "idle", calls: 0, errors: 0 });
  const r = await handleHealth(get(`?probe=1&token=${TOKEN}`), { env: env(), admin: d, request: dead as any });
  const b = await r.json(); const text = JSON.stringify(b) + JSON.stringify(d.events) + JSON.stringify(d.alerts);
  assert(r.status === 503 && b.status === "down", JSON.stringify(b));
  assert(/HTTP 401 authentication_error: invalid x-api-key: \[key\]/.test(b.probe.error), b.probe.error);
  assert(!text.includes("sk-ant"), "no key fragment anywhere");
  assert(d.alerts.length === 1 && d.alerts[0].kind === "model_down", JSON.stringify(d.alerts));
  const again = db({ status: "down" }, 1);
  const r2 = await handleHealth(get(`?probe=1&token=${TOKEN}`), { env: env(), admin: again, request: dead as any });
  assert(r2.status === 503 && again.alerts.length === 0, "the alert is not repeated within the hour");
});

Deno.test("without a probe, real traffic decides: degraded and down page (503), idle and ok do not", async () => {
  for (const [status, code] of [["down", 503], ["degraded", 503], ["idle", 200], ["ok", 200]] as const) {
    const r = await handleHealth(get(`?token=${TOKEN}`), { env: env(), admin: db({ status }), request: (async () => { throw new Error("no probe was asked for"); }) as any });
    assert(r.status === code, `${status} -> ${r.status}`);
  }
});

Deno.test("the total budget is reported with its target and hard limits (informational: it never changes the verdict)", async () => {
  const d = db({ status: "ok", calls: 5, errors: 0 });
  const r = await handleHealth(get(`?token=${TOKEN}`), { env: env({ MODEL_BUDGET_TARGET_USD: "50", MODEL_BUDGET_HARD_USD: "80" }), admin: d });
  const b = await r.json();
  assert(r.status === 200 && b.status === "ok" && b.budget.state === "warning", JSON.stringify(b));
  assert(JSON.stringify(d.budgetCalls) === JSON.stringify([{ p_target_limit_micros: 50_000_000, p_hard_limit_micros: 80_000_000 }]), JSON.stringify(d.budgetCalls));
  const bad = db({ status: "ok" }); bad.budget = null;
  const r2 = await handleHealth(get(`?token=${TOKEN}`), { env: env({ MODEL_BUDGET_TARGET_USD: "oops" }), admin: bad });
  const b2 = await r2.json();
  assert(r2.status === 200 && b2.budget === null && bad.budgetCalls.length === 0, "a malformed limit reads no budget and does not change the verdict");
});
