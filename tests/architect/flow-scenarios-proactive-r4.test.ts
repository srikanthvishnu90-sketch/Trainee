// Proactive round 4 end to end on Postgres (2026-11-05): the sampled end of scenarios-proactive-r4*.test.ts's battery, through
// career-proactive's real handler (handleProactive with the Supabase alert store, the postings reader and career_quiet_users)
// and delivery's real head-start deliverer (channel_runtime.ts deliverer over supabaseChannelStore, Telegram's adapter
// against a fake Bot API at the HTTP boundary, its pacing on tests/flow/virtual-clock.ts), on Postgres 16 with every
// migration (tests/flow/pg.ts) and the PostgREST double at the Supabase hop. No model, no network, a fixed clock. Asserted
// against the database:
//   west     three people who move west across the date line (Tokyo to Los Angeles, Auckland to Honolulu, Kiritimati to
//            Pago Pago) after their day's alerts: career_alert_enqueue (20261105170000) keeps the day counted, sent_on never
//            goes back, no report for the day before; the next local date starts over
//   applied  a job the person applied to (career_apply_jobs) and its copy on an aggregator: no alert, no report line;
//            another job still is news
//   outage   delivery down for a day: yesterday's daily report is set aside (skipped_opt_out, with why) when today's is
//            queued, and only today's goes out on Telegram
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-proactive-r4.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { fakeBot } from "./scenarios/telegram-bot-api.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { startWatching, SUPERSEDED_NOTE, supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { supabasePostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import { clock } from "./scenarios/proactive-generator.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const P_SECRET = ["proactive", "flow", "r4", "not", "a", "real", "secret"].join("-").padEnd(40, "x");
const uid = (n: number) => `00000000-0000-4000-8000-0000004f${String(n).padStart(4, "0")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const CHAT = (n: number) => 7400000 + n;

const WEST = [{ n: 1, from: "Asia/Tokyo", to: "America/Los_Angeles" }, { n: 2, from: "Pacific/Auckland", to: "Pacific/Honolulu" }, { n: 3, from: "Pacific/Kiritimati", to: "Pacific/Pago_Pago" }];
const APPLIED = [4, 5], OUTAGE = [6, 7];
// 23:30 UTC on 5 November: 08:30 on 6 November in Tokyo, 12:30 in Auckland, 13:30 in Kiritimati (past the report hour, 8).
const TA = Date.parse("2026-11-05T23:30:00Z"), TM = TA + HOUR; // the move: 16:30, 14:30 and 13:30 on 5 November in the new zones

Deno.test({ name: "proactive round 4 end to end on Postgres: moves west across the date line, jobs already applied to, a day of delivery down", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  const realFetch = globalThis.fetch;
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin: any = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const sql: string[] = [];
    const person = (n: number, tz: string, prefs: Record<string, unknown>, checked: number) => sql.push(`insert into auth.users(id, email) values (${q(uid(n))}, ${q(`r4-${n}@example.test`)});
      insert into public.profiles(id) values (${q(uid(n))});
      insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at, instant_sent_today, sent_on, last_report_on, held)
        values (${q(uid(n))}, ${q(tz)}, ${q(JSON.stringify({ on: true, keywords: [`data analyst desk${n}`], locations: [], remote_ok: true, report_hour: 8, quiet_start: 0, quiet_end: 0, max_instant_per_day: 2, ...prefs }))}::jsonb, ${q(iso(checked))}, 0, null, null, '{}');
      insert into public.channel_contacts(contact, user_id, home) values (${q(`tg:${CHAT(n)}`)}, ${q(uid(n))}, true);`);
    // Each group joins when its part begins (so the runs before it plan nothing for them).
    const join = async () => { await db.sql.query(sql.join("\n")); sql.length = 0; };
    for (const w of WEST) person(w.n, w.from, {}, TA - HOUR);
    await join();
    let posts = 0;
    const addPost = async (n: number, seen: number, o: { id?: string; company?: string; url?: string } = {}) => {
      const k = ++posts, id = o.id ?? `greenhouse:r4w${n}:${k}`, url = o.url ?? `https://boards.greenhouse.io/r4w${n}/jobs/${k}`;
      await db.sql.query(`insert into public.career_postings(job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        values (${q(id)}, ${q(id.split(":")[0])}, ${q(id.split(":")[1])}, ${q(o.company ?? `Firm ${k}`)}, ${q(`Data Analyst Desk${n}`)}, 'Remote', ${q(url)}, 'The role.', ${q(iso(seen))}, ${q(iso(seen))})`);
      return { id, url };
    };
    const postingsDb = supabasePostingsDb(admin);
    const proactive = async (at: number) => {
      const env: Record<string, string> = { CAREER_PROACTIVE_SECRET: P_SECRET };
      const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": P_SECRET } }), {
        env: { get: (k: string) => env[k] }, now: () => at, store: () => supabaseAlertStore(admin),
        recentPostings: (since) => postingsDb.newSince(since).then((ps) => ps.filter((p: any) => Date.parse(p.first_seen_at) <= at)), postingsById: (ids) => postingsDb.getMany(ids),
        quiet: async (ids) => {
          const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids });
          if (error) throw new Error(`read who is paused: ${error.message}`);
          return new Set<string>((data ?? []).map((r: any) => String(r?.user_id ?? r)));
        },
        watches: async () => new Map(), recordRun: async () => {},
      });
      const body = await res.json();
      eq([res.status, body.errors ?? null], [200, null], `career-proactive: ${JSON.stringify(body).slice(0, 400)}`);
      return body;
    };
    const outbox = async (n: number) => await rows<{ key: string; kind: string; status: string; text: string; error: string | null }>(db,
      `select key, kind, status, text, error from public.career_outbox where user_id = ${q(uid(n))} order by id`);
    const prefsRow = async (n: number) => (await rows<{ sent_on: string | null; instant_sent_today: number; last_report_on: string | null; tz: string }>(db,
      `select sent_on::text, instant_sent_today, last_report_on::text, tz from public.career_alert_prefs where user_id = ${q(uid(n))}`))[0];

    await t.step("west: a move across the date line keeps the day's alerts counted and sends no report for the day before", async () => {
      for (const w of WEST) for (let i = 0; i < 3; i++) await addPost(w.n, TA - 10 * MIN);
      await proactive(TA);
      for (const w of WEST) {
        const o = await outbox(w.n);
        eq(o.filter((x) => x.kind === "alert").length, 2, `west ${w.n}: two alerts on 6 November in ${w.from}`);
        eq(o.filter((x) => x.kind === "report").map((x) => x.key), ["report:2026-11-06"], `west ${w.n}: the report for 6 November`);
        eq((await prefsRow(w.n)).sent_on, "2026-11-06");
      }
      // The move, the way the alerts tool saves it (startWatching through the Supabase alert store).
      const store = supabaseAlertStore(admin);
      for (const w of WEST) {
        const prev = (await store.get(uid(w.n)))!;
        await store.save(startWatching(prev, { userId: uid(w.n), prefs: prev.prefs, tz: w.to, now: TM }));
        const r = await prefsRow(w.n);
        eq([r.tz, r.sent_on, r.instant_sent_today, r.last_report_on], [w.to, "2026-11-06", 2, "2026-11-06"], `west ${w.n}: the move keeps the day counted (${clock(TM, w.to).date} ${clock(TM, w.to).hour}:30 in ${w.to})`);
      }
      // Every four hours until the evening of 7 November in Pago Pago, new postings before each run.
      const counts = new Map<number, { t: number; date: string; alerts: number; reports: string[]; sent_on: string | null }[]>();
      for (let at = TM + 5 * MIN; at <= Date.parse("2026-11-07T21:00:00Z"); at += 4 * HOUR) {
        for (const w of WEST) await addPost(w.n, at - 15 * MIN);
        await proactive(at);
        for (const w of WEST) {
          const o = await outbox(w.n), r = await prefsRow(w.n);
          counts.set(w.n, [...(counts.get(w.n) ?? []), { t: at, date: clock(at, w.to).date, alerts: o.filter((x) => x.kind === "alert").length, reports: o.filter((x) => x.kind === "report").map((x) => x.key), sent_on: r.sent_on }]);
        }
      }
      for (const w of WEST) {
        const seen = counts.get(w.n)!;
        for (const c of seen.filter((x) => x.date <= "2026-11-06")) {
          eq(c.alerts, 2, `west ${w.n}: at ${iso(c.t)} (${c.date} in ${w.to}) no new day's allowance on top of 6 November's`);
          ok(c.sent_on === "2026-11-06", `west ${w.n}: sent_on never goes back (${c.sent_on} at ${iso(c.t)})`);
        }
        ok(!seen.some((c) => c.reports.includes("report:2026-11-05")), `west ${w.n}: no report for 5 November after the one for 6 November`);
        const last = seen[seen.length - 1];
        eq([last.date, last.reports], ["2026-11-07", ["report:2026-11-06", "report:2026-11-07"]], `west ${w.n}: 7 November in ${w.to} has its report`);
        ok(last.alerts > 2 && last.alerts <= 4, `west ${w.n}: 7 November starts over (${last.alerts} alerts in all)`);
        eq(last.sent_on, "2026-11-07");
      }
    });

    await t.step("applied: a job the person applied to and its aggregator copy are not news; another job is", async () => {
      const TB = Date.parse("2026-11-08T15:05:00Z");
      for (const n of APPLIED) person(n, "America/New_York", { max_instant_per_day: 5 }, TB - HOUR);
      await join();
      const ids: Record<number, { mine: string; copy: string; other: string; url: string; otherUrl: string }> = {};
      for (const n of APPLIED) {
        const mine = await addPost(n, TB - 40 * MIN, { company: `Acme ${n}` });
        const copy = await addPost(n, TB - 20 * MIN, { id: `lever:agg${n}:9`, company: `Acme ${n}, Inc.`, url: mine.url });
        const other = await addPost(n, TB - 30 * MIN, { company: `Globex ${n}` });
        ids[n] = { mine: mine.id, copy: copy.id, other: other.id, url: mine.url, otherUrl: other.url };
        await db.sql.query(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at)
          values (${q(uid(n))}, ${q(mine.id)}, ${q(`Acme ${n}`)}, ${q(mine.url)}, '{}', repeat('b', 64), repeat('b', 64), 'submitted_unconfirmed', ${q(iso(TB - 30 * MIN))})`);
      }
      await proactive(TB);
      for (const n of APPLIED) {
        const o = await outbox(n);
        eq(o.filter((x) => x.kind === "alert").map((x) => x.key), [`alert:${ids[n].other}`], `applied ${n}: only the job not applied to`);
        const report = o.find((x) => x.kind === "report")!.text;
        ok(!report.includes(ids[n].url) && report.includes(ids[n].otherUrl) && /^Your daily job report: 1 match /.test(report), `applied ${n}: the report: ${report}`);
      }
    });

    await t.step("outage: yesterday's unsent report is set aside by today's, and only today's goes out", async () => {
      const T1 = Date.parse("2026-11-09T14:05:00Z"), T2 = T1 + DAY; // 9:05 in New York, two days running; delivery down on the first
      for (const n of OUTAGE) person(n, "America/New_York", {}, T1 - HOUR);
      await join();
      await proactive(T1);
      for (const n of OUTAGE) eq((await outbox(n)).map((x) => [x.key, x.status]), [["report:2026-11-09", "queued"]], `outage ${n}: the first day's report waits`);
      await proactive(T2);
      for (const n of OUTAGE) eq((await outbox(n)).map((x) => [x.key, x.status, x.error]), [["report:2026-11-09", "skipped_opt_out", SUPERSEDED_NOTE.report], ["report:2026-11-10", "queued", null]], `outage ${n}: set aside, with why`);
      const pace = virtualClock(), TOKEN = [String(7_000_001), "r4", "fake", "bot", "token"].join("-");
      const bot = fakeBot({ token: TOKEN, now: pace.clock });
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.host === "api.telegram.org") return await bot.fetch(input as any, init);
        throw new TypeError(`network refused in the test: ${u.host}`);
      }) as typeof fetch;
      const deliver = deliverer(admin, { get: (k: string) => ({ TELEGRAM_BOT_TOKEN: TOKEN } as Record<string, string>)[k] }, pace);
      for (const n of OUTAGE) await deliver({ userId: uid(n), now: T2 + 5 * MIN, wholeUser: true });
      globalThis.fetch = realFetch;
      eq(bot.violations, [], "the Bot API saw nothing it would refuse");
      for (const n of OUTAGE) {
        const got = bot.to(CHAT(n));
        eq(got.length, 1, `outage ${n}: one message on Telegram`);
        ok(/^Your daily job report/.test(got[0].text), `outage ${n}: today's report: ${got[0].text}`);
        eq((await outbox(n)).map((x) => [x.key, x.status]), [["report:2026-11-09", "skipped_opt_out"], ["report:2026-11-10", "delivered"]], `outage ${n}: in the database`);
      }
    });
  } finally {
    globalThis.fetch = realFetch;
    await db.stop();
  }
} });
