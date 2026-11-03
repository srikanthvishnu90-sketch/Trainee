// Outcome funnel and owner monitoring, with fake clocks and fake rows. No network, no model, no database.
import { buildFunnel, renderFunnel, type FunnelSource, STAGES } from "../../supabase/functions/_shared/ops_funnel.ts";
import { dispatch, evaluate, readSnapshot, readSpend, type Snapshot } from "../../supabase/functions/_shared/ops_monitor.ts";
import { handleOps } from "../../supabase/functions/ops-monitor/handler.ts";
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
const H = 3600000, NOW = Date.parse("2026-10-29T14:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// A tiny in-memory PostgREST stand-in: select/eq/like/gte/lt/not/order/limit/maybeSingle/insert on arrays.
function fakeDb(tables: Record<string, any[] | Error>) {
  const inserted: Record<string, any[]> = {};
  return { inserted, from(t: string) {
    const src = tables[t];
    let rows: any[] = [], err: any = null, count = false;
    if (src === undefined || src instanceof Error) err = { message: src instanceof Error ? src.message : `relation ${t} does not exist` }; else rows = [...src];
    const q: any = {
      select(_c?: string, o?: any) { count = !!o?.count; return q; },
      eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return q; },
      like(c: string, p: string) { const re = new RegExp("^" + p.replace(/%/g, ".*") + "$"); rows = rows.filter((r) => re.test(r[c])); return q; },
      gte(c: string, v: any) { rows = rows.filter((r) => r[c] >= v); return q; },
      lt(c: string, v: any) { rows = rows.filter((r) => r[c] < v); return q; },
      is(c: string, v: any) { rows = rows.filter((r) => (r[c] ?? null) === v); return q; },
      not(c: string, _op: string, _v: any) { rows = rows.filter((r) => r[c] != null); return q; },
      order(c: string, o?: any) { const d = o?.ascending === false ? -1 : 1; rows.sort((a, b) => (a[c] < b[c] ? -d : a[c] > b[c] ? d : 0)); return q; },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: err }); },
      insert(r: any) { (inserted[t] ??= []).push(r); if (Array.isArray(tables[t])) (tables[t] as any[]).push({ created_at: iso(NOW), ...r }); return Promise.resolve({ error: null }); },
      then(res: any, rej: any) { return Promise.resolve(err ? { data: null, error: err, count: null } : { data: rows, error: null, count: count ? rows.length : null }).then(res, rej); },
    };
    return q;
  } };
}
const envOf = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] });
const baseSnap = (over: Partial<Snapshot> = {}): Snapshot => ({ now: NOW, ingest: { lastRunAt: iso(NOW - 10 * 60000) }, delivery: { runs: [{ run_at: iso(NOW - 60000), delivered: 5, failed: 0, error: null }] },
  worker: { oldestQueuedAt: null, lastClaimAt: iso(NOW - 60000), stuckDriving: 0 }, refusals: [], spend: null, http5xx: [], ...over });

Deno.test("funnel: counts per day and user come only from rows; unwired and failing stages are 'not measured', never zero", async () => {
  const U1 = "11111111-aaaa", U2 = "22222222-bbbb";
  const rows = (...r: [string, string][]) => async () => ({ rows: r.map(([user_id, at]) => ({ user_id, at })) });
  const src: FunnelSource = {
    searches: rows([U1, "2026-10-28T10:00:00Z"], [U1, "2026-10-28T11:00:00Z"], [U2, "2026-10-29T01:00:00Z"]),
    queued: rows([U1, "2026-10-28T12:00:00Z"]),
    prepared: rows([U1, "2026-10-28T09:00:00Z"], [U2, "2026-10-28T09:30:00Z"]),
    submitted: rows([U1, "2026-10-28T12:05:00Z"]),
    confirmed: async () => { throw new Error("permission denied for table career_apply_jobs"); },
    // approved, replies, interviews, postings_shown not wired
  };
  const f = await buildFunnel(src, "2026-10-28T00:00:00Z", "2026-10-30T00:00:00Z");
  const d28 = f.days.find((d) => d.day === "2026-10-28")!;
  assert(d28.totals.searches === 2 && d28.totals.queued === 1 && d28.totals.prepared === 2 && d28.totals.submitted === 1, JSON.stringify(d28.totals));
  assert(d28.users.find((u) => u.user_id === U2)!.counts.queued === 0, "a measured stage with no event for a user is 0");
  assert(f.days.find((d) => d.day === "2026-10-29")!.totals.searches === 1);
  for (const s of ["postings_shown", "approved", "confirmed", "replies", "interviews"] as const) { assert(f.totals[s] === null && f.notMeasured[s], s); assert(d28.totals[s] === null, s); }
  assert(String(f.notMeasured.confirmed).startsWith("read failed"));
  const text = renderFunnel(f);
  assert(text.includes("postings shown not measured") && text.includes("confirmed by employer not measured"), text);
  assert(!/interviews 0/.test(text), "unmeasured never prints 0");
  assert(STAGES.length === 9);
});

Deno.test("funnel: events outside the window are ignored and a stage that hit the row bound is flagged truncated", async () => {
  const f = await buildFunnel({ searches: async () => ({ rows: [{ user_id: "u", at: "2026-10-27T23:59:59Z" }, { user_id: "u", at: "2026-10-28T00:00:00Z" }], truncated: true }) }, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert(f.totals.searches === 1 && f.truncated.includes("searches") && renderFunnel(f).includes("lower bounds"));
});

Deno.test("alerts: ingest stalled over 2 hours, never fires inside 2 hours, fires when never run", () => {
  assert(evaluate(baseSnap({ ingest: { lastRunAt: iso(NOW - 119 * 60000) } })).length === 0);
  const a = evaluate(baseSnap({ ingest: { lastRunAt: iso(NOW - 3 * H) } }));
  assert(a.length === 1 && a[0].kind === "ingest_stalled" && a[0].text.includes("3.0 hours"), JSON.stringify(a));
  assert(evaluate(baseSnap({ ingest: { lastRunAt: null } }))[0].text.includes("never"));
  assert(evaluate(baseSnap({ ingest: null })).length === 0, "unreadable source raises nothing about itself");
});

Deno.test("alerts: deliveries failing, runs erroring, and a silent runner", () => {
  const run = (m: number, delivered: number, failed: number, error: string | null = null) => ({ run_at: iso(NOW - m * 60000), delivered, failed, error });
  assert(evaluate(baseSnap({ delivery: { runs: [run(1, 9, 2)] } })).length === 0);
  assert(evaluate(baseSnap({ delivery: { runs: [run(1, 0, 2), run(2, 1, 2)] } }))[0].kind === "delivery_failing");
  assert(evaluate(baseSnap({ delivery: { runs: [run(1, 5, 0, "telegram 500"), run(2, 5, 0, "telegram 500")] } }))[0].text.includes("telegram 500"));
  assert(evaluate(baseSnap({ delivery: { runs: [run(1, 0, 4), run(40, 9, 0)] } })).some((a) => a.kind === "delivery_failing"), "old runs outside 30 minutes do not count");
  const silent = evaluate(baseSnap({ delivery: { runs: [run(25, 3, 0)] } }));
  assert(silent.length === 1 && silent[0].kind === "delivery_silent" && silent[0].text.includes("25 minutes"), JSON.stringify(silent));
});

Deno.test("alerts: apply worker down needs an old queued job AND no recent claim; stuck driving is separate", () => {
  const w = (q: number | null, c: number | null, stuck = 0) => baseSnap({ worker: { oldestQueuedAt: q == null ? null : iso(NOW - q * 60000), lastClaimAt: c == null ? null : iso(NOW - c * 60000), stuckDriving: stuck } });
  assert(evaluate(w(null, null)).length === 0, "empty queue is not down");
  assert(evaluate(w(30, 5)).length === 0, "worker is claiming");
  assert(evaluate(w(10, 90)).length === 0, "queue not old enough");
  assert(evaluate(w(30, 90))[0].kind === "apply_worker_down");
  assert(evaluate(w(30, null))[0].kind === "apply_worker_down");
  assert(evaluate(w(null, 5, 2))[0].kind === "apply_worker_stuck");
});

Deno.test("alerts: model budget refusals relay once each; spend thresholds 50/80/100 pick the highest crossed", () => {
  const r = evaluate(baseSnap({ refusals: [{ id: "7", kind: "model_budget_exhausted", created_at: iso(NOW), detail: { day: "2026-10-29", limit_micros: 20000000, spent_micros: 19900000 } }] }));
  assert(r.length === 1 && r[0].key === "7" && r[0].text.includes("$20.00") && r[0].text.includes("exhausted"), JSON.stringify(r));
  const sp = (spent: number, reserved = 0) => evaluate(baseSnap({ spend: { source: "model_budget", day: "2026-10-29", spentMicros: spent, reservedMicros: reserved, limitMicros: 20000000 } }));
  assert(sp(9999999).length === 0);
  assert(sp(10000000)[0].key === "2026-10-29:50");
  assert(sp(12000000, 4000000)[0].key === "2026-10-29:80", "reserved counts toward the cap");
  assert(sp(20000000)[0].key === "2026-10-29:100" && sp(25000000).length === 1);
});

Deno.test("alerts: 5xx spike by function, only at or over the threshold", () => {
  const a = evaluate(baseSnap({ http5xx: [{ fn: "telegram-inbound", count: 12 }, { fn: "agent-chat", count: 9 }] }));
  assert(a.length === 1 && a[0].key === "http_5xx_spike:telegram-inbound");
});

Deno.test("spend: reads model_budget_days by Chicago date; degrades to the turn ledger with an owner cap; else not measured", async () => {
  const at = Date.parse("2026-10-29T03:00:00Z"); // 22:00 on 10-28 in Chicago
  const withBudget = fakeDb({ model_budget_days: [{ day: "2026-10-28", limit_micros: 15000000, spent_micros: 1, reserved_micros: 2 }] });
  const s = await readSpend(withBudget, at, envOf());
  assert(s && s.source === "model_budget" && s.day === "2026-10-28" && s.limitMicros === 15000000, JSON.stringify(s));
  const noTable = fakeDb({ agent_turn_costs: [{ usd_micros: 3000000, created_at: "2026-10-29T01:00:00Z" }, { usd_micros: 1000000, created_at: "2026-10-28T23:00:00Z" }] });
  assert(await readSpend(noTable, at, envOf()) === null, "no budget table and no cap configured: not measured");
  const t = await readSpend(noTable, at, envOf({ OPS_DAILY_CAP_USD: "10" }));
  assert(t && t.source === "turn_costs" && t.spentMicros === 3000000 && t.limitMicros === 10000000, JSON.stringify(t));
});

Deno.test("snapshot: every unreadable table becomes null, nothing throws", async () => {
  const db = fakeDb({ career_ingest_state: new Error("boom") });
  const s = await readSnapshot(db, envOf(), NOW);
  assert(s.ingest === null && s.delivery === null && s.worker === null && s.refusals === null && s.spend === null && s.http5xx === null);
  assert(evaluate(s).length === 0);
});

Deno.test("dispatch: messages the owner once, records ops_* in founder_alerts, repeats only after the cooldown", async () => {
  const db = fakeDb({ founder_alerts: [] });
  const sent: any[] = [];
  const request = (async (u: string, init: any) => { sent.push({ u, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }) as any;
  const env = envOf({ TELEGRAM_BOT_TOKEN: "TOKEN123", OWNER_TELEGRAM_CHAT_ID: "42" });
  const alert = { kind: "ingest_stalled", key: "ingest_stalled", cooldownMs: 6 * H, text: "Job ingest stalled" };
  assert((await dispatch(db, env, [alert], NOW, request)).length === 1);
  assert(sent.length === 1 && sent[0].body.chat_id === "42" && sent[0].body.text.includes("Job ingest stalled") && sent[0].u.includes("botTOKEN123"));
  assert(!sent[0].body.text.includes("TOKEN123"), "the token never reaches the message");
  assert((await dispatch(db, env, [alert], NOW + H, request)).length === 0 && sent.length === 1, "deduped inside the cooldown");
  assert((await dispatch(db, env, [alert], NOW + 7 * H, request)).length === 1 && sent.length === 2, "repeats after the cooldown");
  assert(db.inserted.founder_alerts[0].kind === "ops_ingest_stalled" && db.inserted.founder_alerts[0].detail.telegram === "sent");
});

Deno.test("dispatch: Telegram not configured still records the alert once; a failed send is retried next run", async () => {
  const db = fakeDb({ founder_alerts: [] });
  const alert = { kind: "delivery_failing", key: "delivery_failing", cooldownMs: 2 * H, text: "x" };
  const r = await dispatch(db, envOf(), [alert], NOW);
  assert(r[0].telegram === "not_configured" && (await dispatch(db, envOf(), [alert], NOW + 60000)).length === 0);
  const db2 = fakeDb({ founder_alerts: [] });
  const env = envOf({ TELEGRAM_BOT_TOKEN: "T", OWNER_TELEGRAM_CHAT_ID: "1" });
  let ok = false; const request = (async () => new Response("{}", { status: ok ? 200 : 502 })) as any;
  assert((await dispatch(db2, env, [alert], NOW, request))[0].telegram === "failed:502");
  ok = true;
  assert((await dispatch(db2, env, [alert], NOW + H + 60000, request))[0].telegram === "sent", "retried (after the one-hour backoff) because the owner was never told");
});

Deno.test("handler: token required; check reports what is not measured; digest sends funnel and spend once a day", async () => {
  const TOKEN = "ops-token-0123456789abcdef";
  const db = fakeDb({ career_ingest_state: [{ id: 1, last_run_at: iso(NOW - 5 * H) }], founder_alerts: [], model_budget_days: [{ day: "2026-10-29", limit_micros: 20000000, spent_micros: 11000000, reserved_micros: 0 }] });
  const sent: string[] = [];
  const request = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body).text); return new Response("{}", { status: 200 }); }) as any;
  const env = envOf({ OPS_MONITOR_TOKEN: TOKEN, TELEGRAM_BOT_TOKEN: "T", OWNER_TELEGRAM_CHAT_ID: "1" });
  const src: FunnelSource = { searches: async () => ({ rows: [{ user_id: "abcdef0123", at: "2026-10-28T10:00:00Z" }] }) };
  const d = { env, admin: db, source: src, now: () => NOW, request };
  // The token is a header (x-ops-token or Authorization: Bearer); a ?token= in the URL is refused (tests below).
  const call = (q: string, headers: Record<string, string> = { "x-ops-token": TOKEN }) => handleOps(new Request(`https://x.supabase.co/functions/v1/ops-monitor${q}`, { headers }), d);
  assert((await call("?mode=check", {})).status === 401 && (await call("?mode=check", { "x-ops-token": "nope" })).status === 401);
  const c = await (await call("?mode=check")).json();
  assert(c.sent.map((s: any) => s.kind).sort().join() === "ingest_stalled,spend_threshold", JSON.stringify(c));
  assert(c.not_measured.includes("delivery") && c.not_measured.includes("http_5xx"));
  sent.length = 0;
  const dg = await (await call("?mode=digest")).json();
  assert(dg.telegram === "sent" && sent.length === 1 && sent[0].includes("searches 1") && sent[0].includes("postings shown not measured") && sent[0].includes("$11.00 of $20.00 cap (55%)") && sent[0].includes("Spend yesterday: not measured"), sent[0]);
  assert((await (await call("?mode=digest")).json()).skipped, "second digest the same day is skipped");
  const rep = await (await call("?mode=report&days=3")).text();
  assert(rep.includes("abcdef01") && !rep.includes("abcdef0123"), "users are shown by 8-character prefix");
});

Deno.test("alerts: a failed deploy smoke is reported once for a day; a clean, stale or unmeasured one is silent", () => {
  const sm = (over: any = {}) => ({ id: "9", created_at: iso(NOW - 2 * H), sha: "0768a16abcdef", fail: 2, notRun: 5, ...over });
  const a = evaluate(baseSnap({ deploySmoke: sm() }));
  assert(a.length === 1 && a[0].kind === "deploy_smoke_failed" && a[0].key === "9" && a[0].text.includes("0768a16") && a[0].text.includes("2 failing") && a[0].text.includes("5 not run"), JSON.stringify(a));
  assert(evaluate(baseSnap({ deploySmoke: sm({ fail: 0 }) })).length === 0, "not-run alone is not a failed deploy");
  assert(evaluate(baseSnap({ deploySmoke: sm({ created_at: iso(NOW - 25 * H) }) })).length === 0, "older than a day is stale");
  assert(evaluate(baseSnap({ deploySmoke: null })).length === 0 && evaluate(baseSnap()).length === 0);
});

Deno.test("alerts: a stuck outbox needs past-due undelivered texts older than 30 minutes", () => {
  const ob = (ageMin: number, pending = 4) => evaluate(baseSnap({ outbox: { oldestPendingAt: iso(NOW - ageMin * 60000), pending } }));
  assert(ob(31)[0].kind === "outbox_stuck" && ob(31)[0].text.includes("4 queued") && ob(31)[0].text.includes("31 minutes"));
  assert(ob(29).length === 0 && ob(60, 0).length === 0);
  assert(evaluate(baseSnap({ outbox: { oldestPendingAt: null, pending: 0 } })).length === 0);
});

Deno.test("alerts: the four owner conditions together (smoke, budget over 80%, 5xx spike, stuck queue) each fire once and name no secret", () => {
  const a = evaluate(baseSnap({ deploySmoke: { id: "1", created_at: iso(NOW - H), sha: "", fail: 1, notRun: 0 }, http5xx: [{ fn: "trainee-file", count: 40 }],
    outbox: { oldestPendingAt: iso(NOW - 2 * H), pending: 9 }, spend: { source: "model_budget", day: "2026-10-29", spentMicros: 17000000, reservedMicros: 0, limitMicros: 20000000 } }));
  assert(a.map((x) => x.kind).sort().join() === "deploy_smoke_failed,http_5xx_spike,outbox_stuck,spend_threshold", JSON.stringify(a.map((x) => x.kind)));
  assert(a.find((x) => x.kind === "spend_threshold")!.key.endsWith(":80"));
});

Deno.test("snapshot: reads the newest deploy_smoke row and the undelivered queue; an absent smoke row means no alert", async () => {
  const db = fakeDb({ founder_alerts: [{ id: "a", kind: "deploy_smoke", created_at: iso(NOW - 3 * H), detail: { sha: "0768a16", fail: 0, not_run: 5 } }, { id: "b", kind: "deploy_smoke", created_at: iso(NOW - H), detail: { sha: "e10c22d", fail: 3, not_run: 1 } }],
    career_outbox: [{ deliver_at: iso(NOW - 2 * H), delivered_at: null }, { deliver_at: iso(NOW - 3 * H), delivered_at: null }] });
  const s = await readSnapshot(db, envOf(), NOW);
  assert(s.deploySmoke!.id === "b" && s.deploySmoke!.fail === 3 && s.deploySmoke!.sha === "e10c22d", JSON.stringify(s.deploySmoke));
  assert(s.outbox!.pending === 2 && s.outbox!.oldestPendingAt === iso(NOW - 3 * H), JSON.stringify(s.outbox));
  assert(evaluate(s).map((x) => x.kind).sort().join() === "deploy_smoke_failed,outbox_stuck");
  const empty = await readSnapshot(fakeDb({ founder_alerts: [] }), envOf(), NOW);
  assert(empty.deploySmoke!.fail === 0 && evaluate(empty).filter((x) => x.kind === "deploy_smoke_failed").length === 0);
});

Deno.test("approval rate: a kind under 95% with 20+ shown alerts once; under 20 shown, on the line, or not measured raises nothing", async () => {
  const kinds = (a: { kind: string; shown: number; approvedUnchanged: number }[] | null | undefined) => evaluate(baseSnap({ approval: a })).filter((x) => x.kind === "approval_below_target");
  const low = kinds([{ kind: "outreach_draft", shown: 21, approvedUnchanged: 19 }]); // 90.5%
  assert(low.length === 1 && low[0].key === "approval_below_target:outreach_draft" && /90\.5%/.test(low[0].text) && /19 approved unchanged of 21 shown/.test(low[0].text), JSON.stringify(low));
  assert(kinds([{ kind: "outreach_draft", shown: 20, approvedUnchanged: 19 }]).length === 0, "19 of 20 is exactly 95%: no alert");
  assert(kinds([{ kind: "application_packet", shown: 19, approvedUnchanged: 0 }]).length === 0, "under the sample floor: no alert, however low");
  assert(kinds([{ kind: "advice_answer", shown: 0, approvedUnchanged: 0 }]).length === 0, "no feedback source: nothing to alert");
  assert(kinds(null).length === 0 && kinds(undefined).length === 0, "not measured raises no alert about itself");
  assert(kinds([{ kind: "outreach_draft", shown: 40, approvedUnchanged: 40 }, { kind: "application_packet", shown: 25, approvedUnchanged: 20 }]).map((x) => x.key).join() === "approval_below_target:application_packet", "only the kind under the line");
  // Through the reads and the dispatcher: approval_rate_v is read, the alert is stored once and not repeated inside its cooldown.
  const db = fakeDb({ approval_rate_v: [{ kind: "outreach_draft", shown: 30, approved_unchanged: 24, rate_pct: 80, status: "below target" }], founder_alerts: [] });
  const snap = await readSnapshot(db, envOf(), NOW);
  assert(snap.approval?.[0].shown === 30 && snap.approval[0].approvedUnchanged === 24, JSON.stringify(snap.approval));
  const alerts = evaluate({ ...snap, ingest: null, delivery: null, worker: null, refusals: null, spend: null, http5xx: null });
  const env = envOf({ TELEGRAM_BOT_TOKEN: "123456:test-token-aaaaaaaaaaaaaaaaaaaa", OWNER_TELEGRAM_CHAT_ID: "1" });
  const sentTo: string[] = [];
  const req = (async (u: any) => { sentTo.push(String(u)); return new Response("{}", { status: 200 }); }) as typeof fetch;
  const first = await dispatch(db, env, alerts, NOW, req), again = await dispatch(db, env, alerts, NOW + 3 * H, req);
  assert(first.length === 1 && first[0].kind === "approval_below_target" && again.length === 0, JSON.stringify([first, again]));
  // A table that is not there yet is "not measured", not zero.
  const none = await readSnapshot(fakeDb({}), envOf(), NOW);
  assert(none.approval === null, "approval_rate_v missing: not measured");
});
