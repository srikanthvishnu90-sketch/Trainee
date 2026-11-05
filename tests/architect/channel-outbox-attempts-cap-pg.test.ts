// Outbox attempts cap on Postgres (2026-11-05): career_outbox's check (attempts between 0 and 10) against the real delivery
// path, channel_runtime.ts deliverer(admin, env, {clock, sleep, fetch}) over supabaseChannelStore and the Telegram adapter,
// with a fake Bot API that answers every sendMessage with a 429 (retry_after 120 s), its pacing on tests/flow/virtual-clock.ts,
// Postgres 16 with every migration (tests/flow/pg.ts) and the PostgREST double. Nothing leaves the machine.
//   - a row paced again and again ends failed with the 429 on its 10th attempt: no write refused, never left "sending", never
//     "delivery outcome unknown" (before: the write of attempt 11 was refused, the row stayed "sending", the run stopped);
//   - a row an older build left waiting for a retry at 10 attempts is recorded failed at 10, not refused;
//   - supersede (career_alert_store.ts) sets aside an older daily report waiting to go or waiting for a retry, but a report
//     that failed for good keeps its own reason (review of #505).
// Pure model: channel-outbox-attempts-cap.test.ts.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/channel-outbox-attempts-cap-pg.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { MAX_PACED_ATTEMPTS, OUTBOX_MAX_ATTEMPTS } from "../../supabase/functions/_shared/channel.ts";
import { UNKNOWN_OUTCOME } from "../../supabase/functions/_shared/channel_store.ts";
import { SUPERSEDED_NOTE, supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const MIN = 60000, HOUR = 3600000;
const uid = (n: number) => `00000000-0000-4000-8000-0000000ca9${String(n).padStart(2, "0")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();

Deno.test({ name: "outbox attempts cap on Postgres: Telegram 429s past ten, a row left at ten, supersede keeps a final failure's reason", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const refused: string[] = [];
    const watched = (async (input: Request | URL | string, init?: RequestInit) => {
      const res = await double.fetch(input as any, init);
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.includes("/rest/v1/career_outbox") && init?.method === "PATCH" && res.status >= 400) refused.push(`${res.status} ${await res.clone().text()}`);
      return res;
    }) as typeof fetch;
    const admin: any = createClient("http://supabase.test", "service-test-key", { global: { fetch: watched }, auth: { persistSession: false, autoRefreshToken: false } });
    const vc = virtualClock();
    const calls: { chat: string; t: number }[] = [];
    const bot = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.host !== "api.telegram.org") throw new TypeError(`network refused: ${u.host}`);
      if (!u.pathname.endsWith("/sendMessage")) return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      calls.push({ chat: String(JSON.parse(String(init?.body ?? "{}")).chat_id), t: vc.clock() });
      return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 120", parameters: { retry_after: 120 } }), { status: 429, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const env: Record<string, string> = { TELEGRAM_BOT_TOKEN: `7401:${"T".repeat(34)}`, CAREER_TEXTING_NATIVE: "on" };
    const head = deliverer(admin, { get: (k: string) => env[k] || undefined }, { clock: vc.clock, sleep: vc.sleep, fetch: bot });
    const person = (n: number) => db.sql.query(`insert into auth.users(id, email) values (${q(uid(n))}, ${q(`cap${n}@example.test`)});
      insert into public.profiles(id) values (${q(uid(n))});
      insert into public.career_watch_kv(user_id, key, value) values (${q(uid(n))}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
      insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at, home) values (${q(`tg:7499${n}`)}, ${q(uid(n))}, ${q(iso(vc.clock() - HOUR))}, ${q(iso(vc.clock() - 48 * HOUR))}, true);`);
    type R = { status: string; attempts: number; error: string | null; retry_at: string | null };
    const row = async (key: string) => (await rows<R>(db, `select status, attempts, error, retry_at::text from public.career_outbox where key = ${q(key)}`))[0];

    await t.step("a row Telegram paces again and again: failed with the 429 on its 10th attempt, nothing refused, never unknown", async () => {
      await person(1);
      const key = "status:cap1-1";
      await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(uid(1))}, ${q(key)}, 'status', 'your application was viewed', ${q(iso(vc.clock() - MIN))})`);
      const threw: string[] = [];
      for (let run = 0; run < 16; run++) {
        await head({ userId: uid(1), key, now: vc.clock() }).catch((e) => { threw.push(e instanceof Error ? e.message : String(e)); });
        const r = await row(key);
        ok(r.status !== "sending", `run ${run}: not left sending`);
        ok(r.attempts <= OUTBOX_MAX_ATTEMPTS, `run ${run}: attempts ${r.attempts}`);
        await vc.sleep(r.retry_at ? Math.max(0, Date.parse(r.retry_at) - vc.clock()) + 1000 : 10 * MIN);
      }
      eq(threw, [], "no run stops");
      eq(refused, [], "no write refused");
      const r = await row(key);
      eq([r.status, r.attempts, r.retry_at], ["failed", MAX_PACED_ATTEMPTS, null], "failed for good on its last paced attempt");
      ok(/^Telegram HTTP 429/.test(r.error ?? "") && r.error !== UNKNOWN_OUTCOME, `with the provider's reason: ${r.error}`);
      eq(calls.filter((c) => c.chat === "74991").length, MAX_PACED_ATTEMPTS, "one try per attempt");
    });

    await t.step("a row an older build left waiting at 10 attempts: recorded failed at 10, not refused", async () => {
      await person(2);
      const key = "status:cap2-1";
      await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at, status, attempts, error, retry_at)
        values (${q(uid(2))}, ${q(key)}, 'status', 'your application was viewed', ${q(iso(vc.clock() - HOUR))}, 'failed', 10, 'Telegram HTTP 429: Too Many Requests: retry after 120', ${q(iso(vc.clock() - MIN))})`);
      await head({ userId: uid(2), key, now: vc.clock() });
      eq(refused, [], "no write refused");
      const r = await row(key);
      eq([r.status, r.attempts, r.retry_at], ["failed", OUTBOX_MAX_ATTEMPTS, null]);
      ok(/^Telegram HTTP 429/.test(r.error ?? ""), `with the provider's reason: ${r.error}`);
    });

    await t.step("supersede: older reports waiting or waiting for a retry are set aside; a final failure keeps its reason", async () => {
      await person(3);
      const FINAL = "Telegram HTTP 400: Bad Request: chat not found";
      await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at, status, attempts, error, retry_at) values
        (${q(uid(3))}, 'report:2026-11-01', 'report', 'report one', ${q(iso(vc.clock() - 72 * HOUR))}, 'failed', 1, ${q(FINAL)}, null),
        (${q(uid(3))}, 'report:2026-11-02', 'report', 'report two', ${q(iso(vc.clock() - 48 * HOUR))}, 'failed', 1, 'Telegram HTTP 502', ${q(iso(vc.clock() + HOUR))}),
        (${q(uid(3))}, 'report:2026-11-03', 'report', 'report three', ${q(iso(vc.clock() - 24 * HOUR))}, 'queued', 0, null, null),
        (${q(uid(3))}, 'report:2026-11-04', 'report', 'report four', ${q(iso(vc.clock()))}, 'queued', 0, null, null)`);
      eq(await supabaseAlertStore(admin).supersede!(uid(3), "report", "report:2026-11-04"), 2, "two set aside");
      const got = await rows<{ key: string; status: string; error: string | null }>(db, `select key, status, error from public.career_outbox where user_id = ${q(uid(3))} order by key`);
      eq(got.map((x) => [x.key, x.status, x.error]), [
        ["report:2026-11-01", "failed", FINAL],
        ["report:2026-11-02", "skipped_opt_out", SUPERSEDED_NOTE.report],
        ["report:2026-11-03", "skipped_opt_out", SUPERSEDED_NOTE.report],
        ["report:2026-11-04", "queued", null],
      ]);
    });
  } finally {
    await db.stop();
  }
} });
