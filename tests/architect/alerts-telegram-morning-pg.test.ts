// JOB ALERTS AS A REAL OUTCOME (2026-10-31): "send me new frontend internships in Chicago every morning", said on
// Telegram, to the morning message on that person's Telegram chat, on a real Postgres 16 with the career schema. Nothing is
// faked but the job board's rows and Telegram's send (a DeliveryAdapter that records each call):
//   chat       the person's words through handleChat (agent-chat/handler-career.ts) with channel "telegram", as the
//              Telegram webhook passes them; the router's watch; the bridge (career_watch_alerts.ts syncWatchAlerts) keeps
//              the cadence they asked for: one morning message, no instant alerts (Q326, Q336);
//   planner    career-proactive's handleProactive, wired as its index.ts wires it (supabaseAlertStore, supabasePostingsDb,
//              the watch records, career_quiet_users), run on the cron's 5-minute ticks through the day and night;
//   outbox     career_outbox: exactly one row per morning with matches, none on an empty morning, never a posting twice;
//   delivery   trainee-deliver's handleDeliver over supabaseChannelStore with a Telegram adapter: the exact chat, the
//              exact count, nothing inside quiet hours, the person's own zone;
//   feedback   "less like 1" / "more like 2" on the delivered morning message change the next morning's (Q498);
//              "stop" stops the next one (Q330).
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/alerts-telegram-morning-pg.test.ts
// (needs Postgres 16 binaries; in CI it must run).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { supabasePostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import type { DeliveryAdapter } from "../../supabase/functions/_shared/channel_adapters.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const MIN = 60000, HOUR = 60 * MIN, P_SECRET = "p".repeat(40), D_SECRET = "d".repeat(40);
const clock = (at: number, tz: string) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  return { hour: Number(p.find((x) => x.type === "hour")!.value) % 24, minute: Number(p.find((x) => x.type === "minute")!.value) };
};
// The first cron tick (minute 4, 9, 14, ... as schedule-career-proactive.sql) at or after `from` whose local time is h:mm.
const tickAt = (from: number, tz: string, hour: number, minute = 4) => {
  let t = Math.ceil(from / MIN) * MIN;
  for (let i = 0; i < 3 * 24 * 60; i++, t += MIN) { const c = clock(t, tz); if (c.hour === hour && c.minute === minute) return t; }
  throw new Error(`no ${hour}:${minute} in ${tz} after ${new Date(from).toISOString()}`);
};
const NY = "America/New_York", CHI = "America/Chicago";
// Fixed dates, never today's (review of PR #365): each run deliberately crosses a US clock change between the ask and the
// mornings, so "8 on the person's clock" is held across a 25-hour and a 23-hour day.
//   fall-back:     ask Sat 2026-10-31 11:00 New York (EDT); clocks go back Sun 2026-11-01 02:00; mornings Nov 1, 2, 3 (EST)
//   spring-forward: ask Sat 2027-03-13 11:00 New York (EST); clocks go forward Sun 2027-03-14 02:00; mornings Mar 14, 15, 16 (EDT)
const offsetMin = (at: number, tz: string) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(at)).find((x) => x.type === "timeZoneName")!.value;
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(p);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};
const RUNS: { name: string; T0: number; offsets: [number, number] }[] = [
  { name: "across the fall-back (Nov 1 2026)", T0: tickAt(Date.UTC(2026, 9, 31, 12), NY, 11, 0), offsets: [-240, -300] },
  { name: "across the spring-forward (Mar 14 2027)", T0: tickAt(Date.UTC(2027, 2, 13, 12), NY, 11, 0), offsets: [-300, -240] },
];
const PEOPLE: Record<string, string> = { "tok-1": "00000000-0000-4000-8000-000000000a01", "tok-2": "00000000-0000-4000-8000-000000000a02", "tok-3": "00000000-0000-4000-8000-000000000a03", "tok-4": "00000000-0000-4000-8000-000000000a04" };
const CHAT: Record<string, string> = { "tok-1": "tg:7100000001", "tok-2": "tg:7100000002", "tok-3": "tg:7100000003", "tok-4": "tg:7100000004" };

let jobs = 0;
const q = (s: string) => s.replace(/'/g, "''");
async function board(pg: Pg, o: { title: string; company: string; location: string; seen: number }) {
  const n = ++jobs, id = `greenhouse:mo:${n}`, at = new Date(o.seen).toISOString();
  await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at)
    values ('${id}', 'greenhouse', 'mo', '${q(o.company)}', '${q(o.title)}', '${q(o.location)}', 'https://boards.greenhouse.io/mo/jobs/${n}', 'Build the web app in React and TypeScript.', '${at}', '${at}', '${at}')`);
  return { id, url: `https://boards.greenhouse.io/mo/jobs/${n}` };
}

async function proactive(admin: any, at: number) {
  const postings = supabasePostingsDb(admin);
  let recorded: any = null;
  const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": P_SECRET } }), {
    env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? P_SECRET : undefined) }, now: () => at,
    store: () => supabaseAlertStore(admin),
    recentPostings: (since) => postings.newSince(since), postingsById: (ids) => postings.getMany(ids),
    quiet: async (ids) => {
      const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids });
      if (error) throw new Error(error.message);
      return new Set((data ?? []).map((r: any) => String(r.user_id ?? r))); // either shape, as index.ts reads it
    },
    watches: async (ids) => {
      const out = new Map<string, unknown>();
      const { data, error } = await admin.from("career_watch_kv").select("user_id,value").in("user_id", ids).in("key", ids.map((u) => `career:watch-profile:${u}`));
      if (error) throw new Error(error.message);
      for (const r of data ?? []) out.set(String(r.user_id), r.value);
      return out;
    },
    recordRun: async (r) => { recorded = r; },
  });
  assert(res.status === 200, `career-proactive answered ${res.status}: ${await res.text()}`);
  assert(!recorded?.error, `career-proactive run error: ${JSON.stringify(recorded)}`);
  return recorded;
}
// trainee-deliver with Telegram as the one wired channel; the adapter's send is the one fake.
const wire: { address: string; text: string; at: number }[] = [];
async function deliver(admin: any, at: number) {
  const before = wire.length;
  const telegram: DeliveryAdapter = { channel: "telegram", limits: {}, render: (t) => [t], send: async (address, bubbles) => { wire.push({ address, text: bubbles.join("\n"), at }); return { ok: true, id: `tg-${wire.length}` } as any; } };
  const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: D_SECRET, TELEGRAM_BOT_TOKEN: "fake" };
  const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": D_SECRET } }), {
    env: { get: (k: string) => env[k] }, now: () => at, store: () => supabaseChannelStore(admin),
    send: () => async () => { throw new Error("iMessage is not this person's channel"); },
    adapters: () => ({ telegram }),
    recordRun: async () => {},
  });
  const body = await res.json();
  assert(res.status === 200, `trainee-deliver answered ${res.status}: ${JSON.stringify(body)}`);
  return wire.slice(before);
}
const outbox = async (pg: Pg, id: string) => JSON.parse((await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('key', key, 'kind', kind, 'status', status, 'at', deliver_at, 'text', text) order by id), '[]') from public.career_outbox where user_id = '${id}'`)) || "[]");
const prefsOf = async (pg: Pg, id: string) => JSON.parse((await pg.sql(`select coalesce((select to_jsonb(a) from public.career_alert_prefs a where user_id = '${id}')::text, 'null')`)) || "null");
// The numbered items of a morning message, in order: [n, url].
const items = (text: string) => [...text.matchAll(/^(\d+)\. [^\n]*\n\s*(https:\/\/\S+)/gm)].map((m) => [Number(m[1]), m[2]] as const);

for (const { name: run, T0, offsets } of RUNS) Deno.test({
  name: `job alerts on Telegram, ${run}: said once -> one morning message a day on the person's chat, live postings only, quiet hours and zone, never twice, feedback and stop obeyed`,
  sanitizeResources: false, sanitizeOps: false,
  async fn(t) {
    // The dates really do cross the change: New York's offset at the ask differs from its offset at the first morning.
    eq([offsetMin(T0, NY), offsetMin(tickAt(T0, NY, 8), NY)], offsets, `${run}: the ask and the first morning are on either side of the change`);
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg();
    let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realNow = Date.now;
    try {
      await supabaseParity(pg);
      for (const [tok, id] of Object.entries(PEOPLE)) {
        await pg.sql(`insert into auth.users (id, email) values ('${id}', '${tok}@example.test'); insert into public.profiles (id) values ('${id}');
          insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          insert into public.channel_contacts (contact, user_id, home) values ('${CHAT[tok]}', '${id}', true);`);
      }
      handler = await careerHandler(pg, PEOPLE);
      const admin: any = createClient(SUPABASE_URL, SERVICE_KEY);
      const sayer = (tok: string) => {
        const chat: Chat = handler!.chat(tok);
        return async (text: string, at: number) => {
          Date.now = () => at;
          try { const r = await chat.say(text, { channel: "telegram" }); assert(r.status === 200, `${r.status} ${r.reply}`); return r; } finally { Date.now = realNow; }
        };
      };
      const A = PEOPLE["tok-1"], B = PEOPLE["tok-2"], C = PEOPLE["tok-3"];
      const sayA = sayer("tok-1"), sayB = sayer("tok-2"), sayC = sayer("tok-3");
      // Every cron tick between two instants (the schedule's 5-minute cadence), each followed by a delivery run.
      const ticks = async (from: number, to: number) => {
        const sent: typeof wire = [];
        for (let at = from; at <= to; at += 5 * MIN) { await proactive(admin, at); sent.push(...(await deliver(admin, at))); }
        return sent;
      };
      const to = (who: string, s: typeof wire) => s.filter((w) => w.address.includes(CHAT[who].slice(3)));

      // An open posting already on the boards before the ask is never news.
      const before = await board(pg, { title: "Frontend Engineer Intern", company: "Oldco", location: "Chicago, IL", seen: T0 - 2 * HOUR });
      let day1: { acme: { id: string; url: string }; globex: { id: string; url: string } } | null = null;
      let morning1 = 0;

      await t.step("the ask on Telegram is saved per person as a morning message with no instant alerts", async () => {
        const w = await sayA("send me new frontend internships in Chicago every morning", T0);
        eq([w.intent, w.resultStatus], ["career_watch_create", "prepared"], `the router's watch: ${w.reply}`);
        const r = await prefsOf(pg, A);
        assert(r?.prefs?.on === true && r.prefs.interests?.length === 1, `the bridge saved the person's settings: ${JSON.stringify(r)}`);
        eq([r.prefs.digest, r.prefs.max_instant_per_day, r.prefs.report_hour], [true, 0, 8], "every morning: one message at 8, no instant alerts");
        eq(r.tz, NY, "no zone said: the default zone");
        assert(w.reply.includes("once a day, every day at 8:00 AM America/New_York time"), `the reply states the schedule saved: ${w.reply}`);
        eq(await prefsOf(pg, B), null, "nobody else's settings were written");
      });

      await t.step("through the day and night: nothing queued or sent; at 8:04 one message on the person's Telegram with only the new, live, matching postings, numbered with links", async () => {
        const acme = await board(pg, { title: "Frontend Engineer Intern - Angular", company: "Acme", location: "Chicago, IL", seen: T0 + HOUR });
        const globex = await board(pg, { title: "Front-End Developer Intern (React)", company: "Globex", location: "Chicago, IL", seen: T0 + 2 * HOUR });
        const closed = await board(pg, { title: "Frontend Engineering Intern", company: "Initech", location: "Chicago, IL", seen: T0 + 3 * HOUR });
        const senior = await board(pg, { title: "Senior Frontend Engineer", company: "Hooli", location: "Chicago, IL", seen: T0 + 3 * HOUR });
        const elsewhere = await board(pg, { title: "Frontend Intern", company: "Umbrella", location: "New York, NY", seen: T0 + 3 * HOUR });
        const backend = await board(pg, { title: "Backend Engineer Intern", company: "Stark", location: "Chicago, IL", seen: T0 + 3 * HOUR });
        day1 = { acme, globex };
        morning1 = tickAt(T0, NY, 8);
        // The day, the evening and the night, every tick: no instant alert, nothing in quiet hours.
        const night = await ticks(T0 + 5 * MIN, morning1 - HOUR);
        eq(night.length, 0, `nothing sent before the morning: ${JSON.stringify(night)}`);
        eq((await outbox(pg, A)).length, 0, "nothing queued before the morning");
        // The Initech posting closes (its link is dead) before the morning.
        await pg.sql(`update public.career_postings set closed_at = '${new Date(morning1 - 2 * HOUR).toISOString()}' where job_id = '${closed.id}'`);
        const sent = await ticks(morning1 - 55 * MIN, morning1 + 30 * MIN);
        eq(to("tok-1", sent).length, 1, `exactly one message to the person: ${JSON.stringify(sent)}`);
        eq(sent.length, 1, "and to nobody else");
        const msg = sent[0];
        assert(msg.at >= morning1 && clock(msg.at, NY).hour === 8, `sent at the morning tick on their clock: ${new Date(msg.at).toISOString()}`);
        const listed = items(msg.text).map(([, u]) => u);
        eq(listed.slice().sort(), [acme.url, globex.url].sort(), `only the new, live, matching postings: ${msg.text}`);
        eq(items(msg.text).map(([n]) => n), [1, 2], "numbered for one-word replies");
        for (const x of [before, closed, senior, elsewhere, backend]) assert(!msg.text.includes(x.url), `never ${x.url}: ${msg.text}`);
        const ob = await outbox(pg, A);
        eq(ob.map((o: any) => [o.kind, o.status]), [["report", "delivered"]], "one row, delivered");
      });

      await t.step("never twice: later ticks that morning add nothing; an empty next morning sends nothing", async () => {
        const later = await ticks(morning1 + 35 * MIN, morning1 + 3 * HOUR);
        eq(later.length, 0, "no second message that morning");
        const morning2 = tickAt(morning1 + 12 * HOUR, NY, 8);
        const empty = await ticks(morning2 - 10 * MIN, morning2 + 20 * MIN);
        eq(empty.length, 0, `an empty morning sends nothing: ${JSON.stringify(empty)}`);
        eq((await outbox(pg, A)).length, 1, "and queues nothing");
        morning1 = morning2;
      });

      await t.step("feedback: \"less like 1\" and \"more like 2\" on the delivered message are standing rules for the next morning", async () => {
        const delivered = (await outbox(pg, A))[0].text as string;
        const n = Object.fromEntries(items(delivered).map(([i, u]) => [u, i]));
        const lessN = n[day1!.acme.url], moreN = n[day1!.globex.url];
        // A posting first seen after the last run and before the person's next chat turn: their turn must not skip it.
        const between = await board(pg, { title: "Frontend Intern", company: "Initrode", location: "Chicago, IL", seen: morning1 + 30 * MIN });
        const ask = await sayA("less like this", morning1 + HOUR);
        assert(/\b1\b/.test(ask.reply) && /\b2\b/.test(ask.reply), `two were listed: which one is asked: ${ask.reply}`);
        eq((await prefsOf(pg, A)).prefs.feedback ?? null, null, "nothing saved on an ambiguous \"this\"");
        const less = await sayA(`less like ${lessN}`, morning1 + HOUR + MIN);
        assert(/Acme/.test(less.reply), `the reply names what it will hold back: ${less.reply}`);
        const more = await sayA(`more like ${moreN}`, morning1 + HOUR + 2 * MIN);
        assert(/Globex/.test(more.reply), `the reply names what it will put first: ${more.reply}`);
        const fb = (await prefsOf(pg, A)).prefs.feedback;
        assert(fb?.less?.length === 1 && fb?.more?.length === 1, `saved on the person's settings: ${JSON.stringify(fb)}`);
        // The next day's postings: like the held-back one (its company; its distinct term), like the wanted one, and neutral.
        const sameCo = await board(pg, { title: "Frontend Intern", company: "Acme", location: "Chicago, IL", seen: morning1 + 2 * HOUR });
        const sameTerm = await board(pg, { title: "Angular Frontend Intern", company: "Wayne", location: "Chicago, IL", seen: morning1 + 3 * HOUR });
        const liked = await board(pg, { title: "React Frontend Intern", company: "Pied Piper", location: "Chicago, IL", seen: morning1 + 4 * HOUR });
        const neutral = await board(pg, { title: "Frontend Developer Intern", company: "Vandelay", location: "Chicago, IL", seen: morning1 + 5 * HOUR });
        const morning3 = tickAt(morning1 + 12 * HOUR, NY, 8);
        const sent = await ticks(morning1 + 2 * HOUR + 5 * MIN, morning3 + 10 * MIN);
        eq(to("tok-1", sent).length, 1, `one message: ${JSON.stringify(sent)}`);
        eq([clock(sent[0].at, NY).hour, sent[0].at >= morning3], [8, true], "on the next morning, not the afternoon a match was found (an empty morning still closes the day)");
        const urls = items(sent[0].text).map(([, u]) => u);
        eq(urls, [liked.url, neutral.url, between.url], `the liked kind first, then freshest; the held-back kinds gone; nothing from yesterday; nothing skipped by a chat turn: ${sent[0].text}`);
        void sameCo; void sameTerm;
        morning1 = morning3;
      });

      await t.step("stop: after \"stop\" the next morning queues and sends nothing", async () => {
        const s = await sayA("stop", morning1 + HOUR);
        eq(s.intent, "career_paused", `"stop" pauses the person's career work, alerts with it: ${s.reply}`);
        await board(pg, { title: "Frontend Intern", company: "Soylent", location: "Chicago, IL", seen: morning1 + 2 * HOUR });
        const morning4 = tickAt(morning1 + 12 * HOUR, NY, 8);
        const n = (await outbox(pg, A)).length;
        const sent = await ticks(morning4 - 10 * MIN, morning4 + 20 * MIN);
        eq(to("tok-1", sent).length, 0, `nothing sent after stop: ${JSON.stringify(sent)}`);
        eq((await outbox(pg, A)).length, n, "nothing queued after stop");
      });

      await t.step("the person's zone and quiet hours: \"every morning at 6 central\" is 6 in Chicago, held to 7 by quiet hours, to that person only", async () => {
        const at = T0 + 10 * MIN;
        const w = await sayB("send me new data analyst roles in Chicago every morning at 6am central", at);
        eq(w.intent, "career_watch_create", w.reply);
        const r = await prefsOf(pg, B);
        eq([r.tz, r.prefs.report_hour, r.prefs.digest, r.prefs.max_instant_per_day], [CHI, 6, true, 0], `the zone and hour said: ${JSON.stringify(r)}`);
        assert(w.reply.includes("at 6:00 AM America/Chicago time") && w.reply.includes("so it will arrive at 7:00 AM instead"), `the reply states the hour, zone and quiet hours' move: ${w.reply}`);
        // Someone who asked for nothing in particular keeps instant alerts.
        const c = await sayC("watch for data analyst roles in Chicago", at);
        eq(c.intent, "career_watch_create", c.reply);
        assert(!/once a day/.test(c.reply), `no schedule said: none stated: ${c.reply}`);
        eq([(await prefsOf(pg, C)).prefs.digest ?? false, (await prefsOf(pg, C)).prefs.max_instant_per_day], [false, 3], "no cadence said: instant alerts as before");
        // Rewind: B's own morning, from a fresh posting after the ask.
        await pg.sql(`delete from public.career_outbox where user_id in ('${B}', '${C}')`);
        const hit = await board(pg, { title: "Data Analyst", company: "Contoso", location: "Chicago, IL", seen: at + HOUR });
        const six = tickAt(at + 2 * HOUR, CHI, 6), seven = tickAt(six, CHI, 7, 0);
        await proactive(admin, six);
        const ob = (await outbox(pg, B)).filter((o: any) => o.kind === "report");
        eq(ob.length, 1, "queued at 6 Chicago");
        eq([clock(Date.parse(ob[0].at), CHI).hour, clock(Date.parse(ob[0].at), CHI).minute], [7, 0], `for the end of quiet hours on the person's clock: ${ob[0].at}`);
        const early = await deliver(admin, six + 30 * MIN);
        eq(to("tok-2", early).length, 0, "nothing inside quiet hours");
        const late = await deliver(admin, seven + MIN);
        eq(late.map((x) => x.address.includes(CHAT["tok-2"].slice(3))), [true], `sent once, to this person's chat only: ${JSON.stringify(late)}`);
        assert(late[0].text.includes(hit.url), late[0].text);
      });

      await t.step("the write after the commit fails: the reply stated the schedule, so one follow-up says it was not saved, on the person's Telegram, at once", async () => {
        const D = PEOPLE["tok-4"], at = T0 + 20 * MIN;
        // The alert settings write fails for this person only (the turn itself commits).
        await pg.sql(`create or replace function public.fx_fail_prefs() returns trigger language plpgsql as $$ begin
            if new.user_id = '${D}' then raise exception 'test: the alert settings write fails'; end if; return new; end $$;
          create trigger fx_fail_prefs before insert or update on public.career_alert_prefs for each row execute function public.fx_fail_prefs();`);
        try {
          const w = await sayer("tok-4")("send me new frontend internships in Chicago every evening at 7", at);
          eq(w.intent, "career_watch_create", w.reply);
          assert(w.reply.includes("every day at 7:00 PM"), `the reply stated the schedule: ${w.reply}`);
          eq(await prefsOf(pg, D), null, "nothing saved");
          const ob = await outbox(pg, D);
          eq(ob.map((o: any) => [o.kind, o.text]), [["status", ALERT_SAVE_FAILED_REPLY]], "one follow-up, the exact words");
          const sent = await deliver(admin, at + MIN);
          eq(to("tok-4", sent).map((x) => x.text), [ALERT_SAVE_FAILED_REPLY], `sent on the person's own Telegram: ${JSON.stringify(sent)}`);
        } finally {
          await pg.sql(`drop trigger if exists fx_fail_prefs on public.career_alert_prefs; drop function if exists public.fx_fail_prefs();`);
        }
      });
    } finally {
      Date.now = realNow;
      handler?.restore();
      await pg.stop();
    }
  },
});

// The words themselves, without a database: what is read as a cadence or as feedback, and what is not.
import { ALERT_SAVE_FAILED_REPLY, cadenceFrom } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import { parseFeedback } from "../../supabase/functions/_shared/career_alert_feedback.ts";
Deno.test("cadence and feedback are read only from what the person said", () => {
  eq(cadenceFrom("send me new frontend internships in Chicago every morning"), { digest: true, report_hour: 8, report_minute: 0 }, "every morning");
  eq(cadenceFrom("data analyst roles in Chicago every morning at 6am central"), { digest: true, report_hour: 6, report_minute: 0, tz: CHI }, "hour and zone");
  eq(cadenceFrom("send me pm jobs every evening at 7pm"), { digest: true, report_hour: 19, report_minute: 0 }, "evening hour");
  eq(cadenceFrom("send me pm jobs every evening at 7"), { digest: true, report_hour: 19, report_minute: 0 }, "a stated hour is honored: evening at 7 is 7 PM");
  eq(cadenceFrom("tell me right away when a data analyst role opens"), { digest: false }, "instant");
  eq(cadenceFrom("watch for data analyst roles in Chicago"), null, "nothing said, nothing changed");
  eq(cadenceFrom("what did I do this morning"), null, "a morning that is not a cadence");
  eq(parseFeedback("less like this"), { kind: "less", n: null }, "this");
  eq(parseFeedback("More like 2!"), { kind: "more", n: 2 }, "a number");
  eq(parseFeedback("fewer like #3"), { kind: "less", n: 3 }, "fewer, #3");
  for (const no of ["I'd like more like this job at Google, can you apply?", "stop", "more", "less like the ones in Boston", "apply to 2"]) eq(parseFeedback(no), null, no);
});
