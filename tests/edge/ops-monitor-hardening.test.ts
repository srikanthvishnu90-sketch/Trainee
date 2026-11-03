// ops-monitor review fixes: header-only token, free-text errors sanitized before they reach an alert, a down Telegram is retried
// once an hour (not every run), and one approval is one approval in the funnel. Added beside ops-monitor.test.ts, which is kept.
import { dispatch, evaluate, RETRY_AFTER_MS, sanitizeError, type Snapshot } from "../../supabase/functions/_shared/ops_monitor.ts";
import { supabaseFunnelSource } from "../../supabase/functions/_shared/ops_funnel.ts";
import { handleOps } from "../../supabase/functions/ops-monitor/handler.ts";

function assert(c: unknown, m = "assertion failed"): asserts c { if (!c) throw new Error(m); }
const H = 3600000, NOW = Date.parse("2026-10-29T12:00:00Z"), iso = (ms: number) => new Date(ms).toISOString();
const envOf = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] });

// In-memory PostgREST stand-in with eq / in / gte / lt / like / select / limit / insert.
function fakeDb(tables: Record<string, any[]>) {
  const inserted: Record<string, any[]> = {};
  const self: any = { inserted, clock: NOW, from(t: string) {
    let rows = [...(tables[t] ?? [])];
    const q: any = {
      select() { return q; }, order() { return q; }, not() { return q; },
      eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return q; },
      in(c: string, v: any[]) { rows = rows.filter((r) => v.includes(r[c])); return q; },
      like(c: string, p: string) { const re = new RegExp("^" + p.replace(/%/g, ".*") + "$"); rows = rows.filter((r) => re.test(r[c])); return q; },
      gte(c: string, v: any) { rows = rows.filter((r) => r[c] >= v); return q; },
      lt(c: string, v: any) { rows = rows.filter((r) => r[c] < v); return q; },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      insert(r: any) { (inserted[t] ??= []).push(r); (tables[t] ??= []).push({ created_at: iso(self.clock), ...r }); return Promise.resolve({ error: null }); },
      then(res: any, rej: any) { return Promise.resolve({ data: rows, error: null, count: rows.length }).then(res, rej); },
    };
    return q;
  } };
  return self;
}

Deno.test("auth: the token is accepted in x-ops-token or Authorization: Bearer, and never from the URL", async () => {
  const TOKEN = "ops-token-0123456789abcdef";
  const d = { env: envOf({ OPS_MONITOR_TOKEN: TOKEN }), admin: fakeDb({}), source: {}, now: () => NOW, request: (async () => new Response("{}")) as any };
  const at = (path: string, headers: Record<string, string> = {}) => handleOps(new Request(`https://x.supabase.co/functions/v1/ops-monitor${path}`, { headers }), d);
  assert((await at("?mode=report", { "x-ops-token": TOKEN })).status === 200, "x-ops-token works");
  assert((await at("?mode=report", { authorization: `Bearer ${TOKEN}` })).status === 200, "Authorization: Bearer works");
  assert((await at("?mode=report", { authorization: `Bearer nope-nope-nope-nope-nope` })).status === 401);
  const viaUrl = await at(`?mode=report&token=${TOKEN}`);
  assert(viaUrl.status === 401, "a valid token in the URL is refused");
  const body = await viaUrl.text();
  assert(!body.includes(TOKEN), "the refusal never echoes the token");
  assert((await at(`?mode=report&token=${TOKEN}`, { "x-ops-token": TOKEN })).status === 401, "even with the header, a token in the URL is refused (it is already in the logs)");
  assert((await at("?mode=report")).status === 401);
});

Deno.test("the schedule script sends the token in the header only", async () => {
  const sql = await Deno.readTextFile(new URL("../../scripts/launch/schedule-ops-monitor.sql", import.meta.url));
  assert(!/[?&]token=/.test(sql.replace(/^--.*$/gm, "")), "no token in a URL in the executable SQL");
  assert((sql.match(/'x-ops-token'/g) ?? []).length === 2, "both jobs send x-ops-token");
});

Deno.test("sanitizeError: urls, addresses, phone numbers, keys and tokens never reach an alert", () => {
  const raw = "POST https://api.telegram.org/bot123456:ABCdefGhIJKlmNoPQRstuVWXyz0123456789/sendMessage failed for jane.doe@example.com +1 (512) 555-0142 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abc api_key=sk_live_51Habcdefghijklmnop secret=hunter2\nnewline";
  const out = sanitizeError(raw, 400);
  for (const leak of ["api.telegram.org", "ABCdef", "jane.doe", "example.com", "555-0142", "eyJhbGci", "sk_live", "hunter2", "\n"]) assert(!out.includes(leak), `leaked ${leak}: ${out}`);
  assert(out.includes("[url]") && out.includes("[email]") && out.includes("[number]"), out);
  assert(sanitizeError("x".repeat(500)).length <= 100 && sanitizeError("duplicate key value violates unique constraint") === "duplicate key value violates unique constraint");
  assert(sanitizeError(null) === "" && sanitizeError("   ") === "");
});

Deno.test("alerts: a delivery error is sanitized and short in the alert text", () => {
  const snap: Snapshot = { now: NOW, ingest: null, worker: null, refusals: null, spend: null, http5xx: null,
    delivery: { runs: [{ run_at: iso(NOW - 60000), delivered: 0, failed: 0, error: "fetch https://hooks.example.com/T0001/B0002/XXXXXXXXXXXXXXXXXXXXXXXX failed for +15125550142" }, { run_at: iso(NOW - 120000), delivered: 0, failed: 0, error: "boom" }] } };
  const a = evaluate(snap).find((x) => x.kind === "delivery_failing");
  assert(a, "raised");
  assert(!/hooks\.example|XXXXXXXX|15125550142/.test(a.text), a.text);
  assert(a.text.includes("[url]"), a.text);
});

Deno.test("dispatch: a failed Telegram send is attempted once an hour during an outage, not on every 5-minute run", async () => {
  const db = fakeDb({ founder_alerts: [] });
  const env = envOf({ TELEGRAM_BOT_TOKEN: "T", OWNER_TELEGRAM_CHAT_ID: "1" });
  let calls = 0, up = false;
  const request = (async () => { calls++; return new Response("{}", { status: up ? 200 : 502 }); }) as any;
  const alert = { kind: "apply_worker_down", key: "apply_worker_down", cooldownMs: 2 * H, text: "down" };
  let t = NOW;
  for (let i = 0; i < 12; i++, t += 5 * 60000) { db.clock = t; await dispatch(db, env, [alert], t, request); } // one hour of 5-minute runs, Telegram down
  assert(calls === 1, `one attempt in the first hour, got ${calls}`);
  assert(db.inserted.founder_alerts.length === 1 && db.inserted.founder_alerts[0].detail.telegram === "failed:502");
  db.clock = NOW + RETRY_AFTER_MS + 60000;
  const later = await dispatch(db, env, [alert], NOW + RETRY_AFTER_MS + 60000, request);
  assert(calls === 2 && later[0].telegram === "failed:502", "retried after the hour");
  up = true;
  db.clock = NOW + 2 * RETRY_AFTER_MS + 120000;
  const ok = await dispatch(db, env, [alert], NOW + 2 * RETRY_AFTER_MS + 120000, request);
  assert(ok[0].telegram === "sent" && calls === 3, "delivered when Telegram is back");
  db.clock = NOW + 2 * RETRY_AFTER_MS + 180000;
  assert((await dispatch(db, env, [alert], NOW + 2 * RETRY_AFTER_MS + 180000, request)).length === 0 && calls === 3, "then deduped by the cooldown");
});

Deno.test("funnel: one approval recorded in both tables is counted once, on the day of the earliest record", async () => {
  const U1 = "11111111-aaaa", U2 = "22222222-bbbb";
  const db = fakeDb({
    career_apply_prepared: [
      { user_id: U1, job_id: "greenhouse:acme:1", state: "approved", updated_at: "2026-10-28T10:00:00Z" },
      { user_id: U1, job_id: "greenhouse:acme:2", state: "approved", updated_at: "2026-10-28T11:00:00Z" },
      { user_id: U1, job_id: "greenhouse:acme:3", state: "ready", updated_at: "2026-10-28T11:30:00Z" },
      { user_id: U2, job_id: "greenhouse:acme:1", state: "approved", updated_at: "2026-10-28T09:00:00Z" },
    ],
    career_apply_batch_approvals: [
      { user_id: U1, job_id: "greenhouse:acme:1", approved_at: "2026-10-28T10:00:01Z" }, // the same approval as the prepared row
      { user_id: U1, job_id: "greenhouse:acme:2", approved_at: "2026-10-29T01:00:00Z" }, // the same approval, recorded the next UTC day
      { user_id: U1, job_id: "greenhouse:acme:4", approved_at: "2026-10-28T12:00:00Z" }, // batch only
    ],
  });
  const src = supabaseFunnelSource(db);
  const day28 = await src.approved!("2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z");
  assert(day28.rows.length === 4, `U1: jobs 1, 2, 4 and U2: job 1 = 4 approvals, got ${day28.rows.length}: ${JSON.stringify(day28.rows)}`);
  const day29 = await src.approved!("2026-10-29T00:00:00Z", "2026-10-30T00:00:00Z");
  assert(day29.rows.length === 0, `the next-day record of job 2 was already counted on the 28th, got ${JSON.stringify(day29.rows)}`);
  const all = await src.approved!("2026-10-28T00:00:00Z", "2026-10-30T00:00:00Z");
  assert(all.rows.length === 4);
});
