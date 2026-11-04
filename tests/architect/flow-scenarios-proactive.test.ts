// Proactive briefs and job alerts end to end on Postgres (2026-10-29): 100 people through career-proactive's real handler
// (handleProactive, wired as its index.ts wires it: supabaseAlertStore, supabasePostingsDb, the finished-applications reader
// with each person's zone and quiet hours, career_quiet_users, the watch records, the brief and digest stores, the run
// recorded in career_proactive_runs) and trainee-deliver's real handler (supabaseChannelStore), on a real Postgres 16 with
// every migration (tests/flow/pg.ts), the PostgREST double at the Supabase hop (tests/flow/postgrest.ts) and a fake
// texting provider at the HTTP boundary (a.loopmessage.com). No model, no network, a fixed clock.
// The people: awake in many zones, paused, opted out by STOP, with no texting channel yet (the dashboard's feed), with a
// zone the runtime does not know, inside their quiet hours; some with a finished application, some with a weekly digest due.
// The runs: one that dies after queueing for some people, two at once, then STOP lifted (START), a pause lifted, a texting
// channel connected three days later. Read back from the database:
//   - every alert names a posting in career_postings, open, matching the watch, in its own words and link; at most the
//     person's cap in the day, each posting once, whatever crashed or overlapped; nobody's unknown zone stops anyone;
//   - paused and stopped people: nothing queued on any rail; after START at most a day's cap and one report; after the
//     pause lifts, the receipt they missed;
//   - quiet hours: queued for their end, not delivered before; a receipt waits too;
//   - delivery reaches each person's own contact only; a channel connected later gets no flood of stale alerts;
//   - the digest says how many alerts were delivered, not how many were queued.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-proactive.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { supabasePostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { supabaseDigestStore, supabaseInterviewStore } from "../../supabase/functions/_shared/career_brief_store.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { supabaseConfirmStore } from "../../supabase/functions/_shared/career_apply_confirm.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
// Tuesday 3 November 2026, 15:00 UTC: 10:00 in New York, the first minutes of an hour (the digest is checked).
const T0 = Date.parse("2026-11-03T15:00:00Z"), MIN = 60000, HOUR = 3600000, DAY = 86400000;
const P_SECRET = "p".repeat(40), D_SECRET = "d".repeat(40);
const uid = (n: number) => `00000000-0000-4000-8000-0000000f${String(n).padStart(4, "0")}`;
const contactOf = (n: number) => `+1555019${String(n).padStart(4, "0")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const ZONES = ["America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Sydney", "America/St_Johns"];
const clockOf = (at: number, tz: string) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
};
const quietOn = (at: number, tz: string, qs: number, qe: number) => { const h = clockOf(at, tz).hour; return qs === qe ? false : qs > qe ? h >= qs || h < qe : h >= qs && h < qe; };

type Kind = "awake" | "paused" | "stopped" | "web_only" | "unknown_zone" | "quiet_now" | "crashes";
interface Person { n: number; id: string; kind: Kind; tz: string; zone: string; cap: number; qs: number; qe: number; receipt: boolean; digest: boolean; report: boolean }
const KINDS: Kind[] = ["paused", "stopped", "web_only", "unknown_zone", "quiet_now", "awake", "crashes", "awake", "awake", "awake"];
const PEOPLE: Person[] = Array.from({ length: 100 }, (_, i) => {
  const n = i + 1, kind = KINDS[n % 10], tz = kind === "unknown_zone" ? "Pacific Time" : ZONES[n % ZONES.length];
  const zone = kind === "unknown_zone" ? "America/New_York" : tz, h = clockOf(T0, zone).hour;
  // Quiet from an hour before the first run to two hours after it, on the person's clock; everyone else 22 to 7.
  const [qs, qe] = kind === "quiet_now" ? [(h + 23) % 24, (h + 2) % 24] : [22, 7];
  return { n, id: uid(n), kind, tz, zone, cap: (n % 3) + 1, qs, qe, receipt: n % 4 === 0 || n % 3 === 0 || kind === "paused", digest: n % 3 === 0, report: n % 7 === 0 };
});

Deno.test({ name: "proactive end to end on Postgres: 100 people, crashes, overlaps, STOP and START, pauses, quiet hours, unknown zones, stale alerts, the digest", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const started = Date.now();
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin: any = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });

    // ---------------------------------------------------------------------------------------- the world
    const sqls: string[] = [];
    for (const p of PEOPLE) {
      const l = clockOf(T0, p.zone);
      const prefs = { on: true, keywords: ["data analyst"], locations: [], remote_ok: true, report_hour: 8, quiet_start: p.qs, quiet_end: p.qe, max_instant_per_day: p.cap };
      sqls.push(`insert into auth.users(id, email) values (${q(p.id)}, ${q(`pr${p.n}@example.test`)});
        insert into public.profiles(id) values (${q(p.id)});
        insert into public.career_watch_kv(user_id, key, value) values (${q(p.id)}, 'career:account', ${q(JSON.stringify({ epoch: 0, version: 0, paused: p.kind === "paused" }))});
        insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at, instant_sent_today, sent_on, last_report_on, held)
          values (${q(p.id)}, ${q(p.tz)}, ${q(JSON.stringify(prefs))}::jsonb, ${q(iso(T0 - 2 * HOUR))}, 0, null, ${p.report ? "null" : q(l.date)}, '{}');
        ${p.kind === "web_only" ? "" : `insert into public.channel_contacts(contact, user_id, opted_out, opted_out_at) values (${q(contactOf(p.n))}, ${q(p.id)}, ${p.kind === "stopped"}, ${p.kind === "stopped" ? q(iso(T0 - DAY)) : "null"});`}
        ${p.digest ? `insert into public.career_digest_prefs(user_id, enabled, day, hour, tz) values (${q(p.id)}, true, ${l.weekday}, ${Math.max(0, l.hour - 1)}, ${q(p.tz)});` : ""}
        ${p.receipt ? `insert into public.career_apply_jobs(user_id, job_id, company, url, payload, payload_hash, approval_hash, state, confirmation_id, updated_at)
          values (${q(p.id)}, ${q(`greenhouse:done:${p.n}`)}, 'Northwind', ${q(`https://boards.greenhouse.io/northwind/jobs/${p.n}`)}, '{}'::jsonb, ${q("a".repeat(64))}, ${q("a".repeat(64))}, 'submitted_unconfirmed', ${q(`NW-${p.n}`)}, ${q(iso(T0 - HOUR))});` : ""}`);
    }
    await db.sql.query(sqls.join("\n"));
    // The boards: postings that match ("Data Analyst" and its kin), ones that do not, one closed since, one a backlog.
    const posts: { id: string; title: string; company: string; location: string; url: string; open: boolean; backlog: boolean }[] = [];
    const TITLES = ["Data Analyst", "Senior Data Analyst", "Data Analyst II", "Analyst, Data Platform", "Metadata Analyst", "Data Engineer"];
    const CITIES = ["New York, NY", "Chicago, IL", "Remote", "London, UK", "Austin, TX"];
    for (let i = 1; i <= 36; i++) {
      const p = { id: `greenhouse:pr:${i}`, title: TITLES[i % TITLES.length], company: `Firm ${String.fromCharCode(64 + (i % 26) + 1)}${i}`, location: CITIES[i % CITIES.length], url: `https://boards.greenhouse.io/pr${i}/jobs/${i}`, open: i % 11 !== 0, backlog: i % 13 === 0 };
      posts.push(p);
      const seen = T0 - (90 - i * 2) * MIN;
      await db.sql.query(`insert into public.career_postings(job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at, closed_at)
        values (${q(p.id)}, 'greenhouse', 'pr', ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, 'Build dashboards in SQL.', ${q(iso(p.backlog ? seen - 10 * DAY : seen - HOUR))}, ${q(iso(seen))}, ${q(iso(seen))}, ${p.open ? "null" : q(iso(T0 - 10 * MIN))})`);
    }
    const matching = (title: string) => /\bdata\b/i.test(title) && /\banalyst\b/i.test(title) && !/metadata/i.test(title);

    // ---------------------------------------------------------------------------------------- the handlers
    let lastId = 0;
    // The outbox's created_at is the database's own clock; the runs are on the test's, so each run's rows are stamped with it.
    const stamp = async (at: number) => {
      await db.sql.query(`update public.career_outbox set created_at = ${q(iso(at))} where id > ${lastId}`);
      lastId = Number((await rows<{ m: number }>(db, `select coalesce(max(id), 0) as m from public.career_outbox`))[0].m);
    };
    const proactive = async (at: number, o: { crash?: (userId: string) => boolean } = {}) => {
      const postings = supabasePostingsDb(admin);
      let recorded: any = null;
      const store = () => {
        const s = supabaseAlertStore(admin);
        return o.crash ? { ...s, saveCounters: async (id: string, c: any) => { if (o.crash!(id)) throw new Error("the function died"); return s.saveCounters!(id, c); } } : s;
      };
      const env: Record<string, string> = { CAREER_PROACTIVE_SECRET: P_SECRET, CAREER_BRIEF_DIGEST: "on" };
      const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": P_SECRET } }), {
        env: { get: (k: string) => env[k] }, now: () => at, store,
        recentPostings: (since) => postings.newSince(since), postingsById: (ids) => postings.getMany(ids),
        // index.ts's reader: the finished applications, each with the person's zone and quiet hours.
        finishedApplications: async (since) => {
          const { data, error } = await admin.from("career_apply_jobs").select("id,user_id,company,url,state,reason,confirmation_id,email_confirmed_at,evidence,source")
            .in("state", ["confirmed", "submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"]).gte("updated_at", since)
            .or("source.is.null,source.neq.email").limit(2000);
          if (error) throw new Error(`read finished applications: ${error.message}`);
          const users = [...new Set((data ?? []).map((r: any) => r.user_id))];
          if (!users.length) return [];
          const prefs = await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", users);
          if (prefs.error) throw new Error(`read quiet hours: ${prefs.error.message}`);
          const of = new Map((prefs.data ?? []).map((p: any) => [p.user_id, p]));
          return (data ?? []).map((r: any) => { const p: any = of.get(r.user_id); return { ...r, tz: p?.tz ?? null, quiet_start: p?.prefs?.quiet_start, quiet_end: p?.prefs?.quiet_end }; });
        },
        briefs: { interviews: () => supabaseInterviewStore(admin), drafts: () => supabaseMailStore(admin), digest: () => supabaseDigestStore(admin) },
        asks: () => supabaseConfirmStore(admin),
        quiet: async (ids) => {
          const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids });
          if (error) throw new Error(`read who is paused: ${error.message}`);
          return new Set<string>((data ?? []).map((r: any) => String(r?.user_id ?? r))); // index.ts: bare ids or {user_id}
        },
        watches: async (ids) => {
          const out = new Map<string, unknown>();
          const { data, error } = await admin.from("career_watch_kv").select("user_id,value").in("user_id", ids).in("key", ids.map((u) => `career:watch-profile:${u}`));
          if (error) throw new Error(`read watch records: ${error.message}`);
          for (const r of data ?? []) out.set(String(r.user_id), r.value);
          return out;
        },
        recordRun: async (r) => {
          recorded = r;
          const { error } = await admin.from("career_proactive_runs").insert({ run_at: r.at, users: r.users, alerts: r.alerts, held: r.held, reports: r.reports, duplicates: r.duplicates, postings: r.postings,
            receipts: r.receipts ?? 0, cards: r.cards ?? 0, statuses: r.statuses ?? 0, followups: r.followups ?? 0, questions: r.questions ?? 0, confirmations: r.confirmations ?? 0, asks: r.asks ?? 0,
            ms: r.ms, error: r.error, briefs: r.briefs ?? 0, brief_ms_max: r.brief_ms_max ?? null, digests: r.digests ?? 0, ...(r.errors ? { errors: r.errors } : {}) });
          if (error) throw new Error(`record run: ${error.message}`);
        },
      });
      const body = await res.json();
      await stamp(at);
      return { status: res.status, body, recorded };
    };
    const got: { contact: string; text: string; bubbles: string[] }[] = [];
    const deliver = async (at: number) => {
      const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: D_SECRET, LOOPMESSAGE_API_KEY: "fake-loop-key" };
      for (let i = 0; i < 12; i++) {
        const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": D_SECRET } }), {
          env: { get: (k: string) => env[k] }, now: () => at, store: () => supabaseChannelStore(admin),
          send: () => async (contact, bubbles) => { got.push({ contact, text: bubbles.join("\n"), bubbles }); return { ok: true, id: `loop-${got.length}` }; },
          adapters: () => ({}),
          recordRun: async () => {},
        });
        const body = await res.json();
        eq(res.status, 200, `trainee-deliver: ${JSON.stringify(body)}`);
        const left = await rows(db, `select id from public.career_outbox o where o.deliver_at <= ${q(iso(at))} and (o.status = 'queued' or o.status = 'sending')
          and exists (select 1 from public.channel_contacts c where c.user_id = o.user_id)`);
        if (!left.length) return;
      }
    };
    const outbox = async (p: Person) => await rows<{ key: string; kind: string; status: string; text: string; deliver_at: string; error: string | null }>(db,
      `select key, kind, status, text, deliver_at, error from public.career_outbox where user_id = ${q(p.id)} order by id`);
    const byKind = (k: Kind) => PEOPLE.filter((p) => p.kind === k);
    const awakeKinds: Kind[] = ["awake", "unknown_zone", "quiet_now", "crashes", "web_only"];

    await t.step("a run that dies after queueing for some people, then two runs at once: every rail runs, nothing doubles, no cap is passed", async () => {
      const crashed = new Set(byKind("crashes").map((p) => p.id));
      const a = await proactive(T0, { crash: (id) => crashed.has(id) });
      ok(a.body.errors?.alerts && Object.keys(a.body.errors).length === 1, `only the alerts rail reports the crash: ${JSON.stringify(a.body.errors)}`);
      // More matches between the runs, for the two at once to plan.
      for (let i = 37; i <= 44; i++) {
        const p = { id: `greenhouse:pr:${i}`, title: "Data Analyst", company: `Late Firm ${i}`, location: "New York, NY", url: `https://boards.greenhouse.io/pr${i}/jobs/${i}`, open: true, backlog: false };
        posts.push(p);
        await db.sql.query(`insert into public.career_postings(job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at)
          values (${q(p.id)}, 'greenhouse', 'pr', ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, 'Build dashboards in SQL.', ${q(iso(T0 + i * 1000))}, ${q(iso(T0 + 2 * MIN + i * 1000))}, ${q(iso(T0 + 2 * MIN + i * 1000))})`);
      }
      const [b, c] = await Promise.all([proactive(T0 + 5 * MIN), proactive(T0 + 5 * MIN)]);
      for (const r of [b, c]) eq([r.status, r.body.errors ?? null], [200, null], `the runs after the crash are clean, unknown zones and all: ${JSON.stringify(r.body)}`);
    });

    await t.step("alerts: only postings on the boards, open, matching, in their own words; each once; never over the person's cap", async () => {
      const all = await rows<{ user_id: string; key: string; text: string }>(db, `select user_id, key, text from public.career_outbox where kind = 'alert'`);
      ok(all.length >= 100, `about a hundred alerts: ${all.length}`);
      const byPost = new Map(posts.map((p) => [`alert:${p.id}`, p]));
      for (const a of all) {
        const p = byPost.get(a.key);
        ok(p, `the alert names a posting on the boards: ${a.key}`);
        ok(p!.open && !p!.backlog && matching(p!.title), `the posting is open news that matches: ${a.key} ${p!.title}`);
        ok(a.text.startsWith(`New match: ${p!.title} at ${p!.company} (${p!.location}), first seen `) && a.text.endsWith(`\n${p!.url}`), `the posting's own words: ${a.text}`);
      }
      for (const p of PEOPLE) {
        const mine = all.filter((a) => a.user_id === p.id);
        eq(new Set(mine.map((a) => a.key)).size, mine.length, `${p.kind} ${p.n}: each posting once`);
        ok(mine.length <= p.cap, `${p.kind} ${p.n}: ${mine.length} alerts, cap ${p.cap}`);
        if (awakeKinds.includes(p.kind)) eq(mine.length, p.cap, `${p.kind} ${p.n}: a full day's alerts (the boards have more matches than any cap)`);
      }
    });

    await t.step("paused and stopped people: nothing queued on any rail", async () => {
      for (const p of [...byKind("paused"), ...byKind("stopped")]) eq(await outbox(p), [], `${p.kind} ${p.n}`);
    });

    await t.step("quiet hours: alerts and receipts wait for their end on the person's clock", async () => {
      for (const p of PEOPLE.filter((x) => x.kind !== "paused" && x.kind !== "stopped")) {
        for (const o of await outbox(p)) ok(!quietOn(Date.parse(o.deliver_at), p.zone, p.qs, p.qe), `${p.kind} ${p.n}: ${o.key} at ${o.deliver_at} is outside quiet ${p.qs}-${p.qe} on ${p.zone}`);
      }
      for (const p of byKind("quiet_now")) {
        const o = await outbox(p);
        ok(o.length && o.every((x) => Date.parse(x.deliver_at) > T0), `${p.n}: everything waits: ${JSON.stringify(o.map((x) => [x.key, x.deliver_at]))}`);
        if (p.receipt) ok(o.some((x) => x.kind === "receipt"), `${p.n}: the receipt is queued, for later`);
      }
    });

    await t.step("delivery: each person's own contact; quiet hours not broken; web-only people get nothing texted", async () => {
      await deliver(T0 + 10 * MIN);
      ok(got.length >= 60, `texts delivered: ${got.length}`);
      for (const g of got) {
        const p = PEOPLE.find((x) => contactOf(x.n) === g.contact)!;
        ok(p && p.kind !== "web_only" && p.kind !== "paused" && p.kind !== "stopped", `delivered to an awake person's contact: ${g.contact}`);
        const theirs = (await outbox(p)).filter((o) => o.status === "delivered").map((o) => o.text);
        // The texting channel renders a row into bubbles (a list's dashes, a link on its own); the words are the row's own.
        const words = (x: string) => (x.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
        ok(theirs.some((t) => words(t) === words(g.bubbles.join(" "))), `the text is that person's own row: ${g.text.slice(0, 80)}`);
      }
      for (const p of byKind("quiet_now")) eq(got.filter((g) => g.contact === contactOf(p.n)).length, 0, `${p.n}: nothing inside quiet hours`);
    });

    await t.step("the digest says how many alerts went out, not how many were queued", async () => {
      const dg = supabaseDigestStore(admin);
      for (const p of PEOPLE.filter((x) => x.digest && x.kind !== "paused" && x.kind !== "stopped")) {
        const digest = (await outbox(p)).find((o) => o.kind === "digest");
        ok(digest, `${p.kind} ${p.n}: the weekly digest is queued`);
        // Built in the same run, after the alerts were queued and before any was delivered.
        ok(digest!.text.includes("\nJob alerts sent: 0.\n"), `${p.kind} ${p.n}: no alert had gone out when the digest was written: ${digest!.text}`);
        const delivered = (await outbox(p)).filter((o) => o.kind === "alert" && o.status === "delivered").length;
        eq((await dg.rows(p.id, iso(T0 - 7 * DAY))).alerts.length, delivered, `${p.kind} ${p.n}: the digest's count is the delivered alerts`);
      }
    });

    await t.step("START after STOP: at most a day's cap and one report, no backlog; a lifted pause brings the receipt it held back", async () => {
      for (const p of byKind("stopped")) await admin.rpc("channel_set_opt_out", { p_contact: contactOf(p.n), p_out: false, p_at: iso(T0 + 15 * MIN) });
      for (const p of byKind("paused")) await db.sql.query(`update public.career_watch_kv set value = jsonb_set(value, '{paused}', 'false') where user_id = ${q(p.id)} and key = 'career:account'`);
      const r = await proactive(T0 + 20 * MIN);
      eq([r.status, r.body.errors ?? null], [200, null], JSON.stringify(r.body));
      for (const p of [...byKind("stopped"), ...byKind("paused")]) {
        const o = await outbox(p);
        const n = (k: string) => o.filter((x) => x.kind === k).length;
        ok(n("alert") <= p.cap && n("report") <= 1 && n("digest") <= 1, `${p.kind} ${p.n}: ${n("alert")} alerts, ${n("report")} reports, ${n("digest")} digests`);
        if (p.receipt) eq(n("receipt"), 1, `${p.kind} ${p.n}: the receipt of the application that finished while they were away`);
      }
    });

    await t.step("a texting channel connected three days later gets no flood of stale alerts; today's still go", async () => {
      const later = T0 + 3 * DAY;
      for (const p of byKind("web_only")) await db.sql.query(`insert into public.channel_contacts(contact, user_id) values (${q(contactOf(p.n))}, ${q(p.id)})`);
      const before = got.length;
      await deliver(later);
      for (const p of byKind("web_only")) {
        eq(got.slice(before).filter((g) => g.contact === contactOf(p.n) && /^(New match|Your daily job report)/.test(g.text)).length, 0, `${p.n}: no alert or report three days late`);
        const old = (await outbox(p)).filter((o) => o.kind === "alert" || o.kind === "report");
        ok(old.length && old.every((o) => o.status === "skipped_opt_out" && /no longer news/.test(o.error ?? "")), `${p.n}: said why: ${JSON.stringify(old)}`);
        ok((await outbox(p)).filter((o) => o.kind === "receipt" || o.kind === "digest").every((o) => o.status === "delivered"), `${p.n}: the receipt and digest still go`);
      }
    });

    await t.step("honest records: every run recorded; nothing stuck sending", async () => {
      const runs = await rows<{ error: string | null }>(db, `select error from public.career_proactive_runs order by id`);
      eq(runs.length, 4, "four runs recorded");
      ok(runs[0].error && /alerts failed/.test(runs[0].error), `the crash is recorded: ${runs[0].error}`);
      eq(runs.slice(1).map((r) => r.error), [null, null, null], "the rest clean");
      eq(await rows(db, `select key from public.career_outbox where status = 'sending'`), [], "nothing stuck sending");
      console.log(`[proactive flow] ${PEOPLE.length} people, ${got.length} texts, ${Date.now() - started} ms`);
    });
  } finally {
    await db.stop();
  }
} });
