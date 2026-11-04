// Proactive job alerts, daily reports and briefs end to end on Postgres, round 3 (2026-11-01): 40 people through
// career-proactive's real handler (handleProactive with the Supabase alert store and the postings reader) and
// trainee-deliver's real handler (supabaseChannelStore, a fake LoopMessage and a fake Telegram at the HTTP boundary), on
// Postgres 16 with every migration (tests/flow/pg.ts) and the PostgREST double at the Supabase hop. No model, no network, a
// fixed clock. The sampled end of scenarios-proactive-r3.test.ts's battery, eight groups of five:
//   dst       the night the US clocks go back (1 November 2026, 1:30 the first time in New York): alerts wait for the
//             first quarter hour after quiet hours on each person's own clock
//   changed   postings that changed between the plan and the delivery three hours later: the alert says the posting as
//             it is then and its age then; one that stopped fitting or closed is not sent, with the reason
//   twins     the same job through an aggregator ("Acme 2, Inc.", the employer's link) in a later run, or 30 hours on:
//             one alert; another job at the same firm is still news
//   search    the person changes their search after an alert and a report were queued: nothing of the old search goes;
//             the report keeps the lines that fit and says how many
//   channels  iMessage and Telegram: everything on the home channel only; STOP on the other holds everything, with why
//   brief     an interview cancelled or moved after its brief was queued: the brief is not sent, with why
//   unicode   emoji and very long names: whole characters, a cut said with "…", through Postgres and back
//   people    paused, deleted: nothing Trainee starts goes
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-proactive-r3.test.ts
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
import { clock, firstAwake, quietOn } from "./scenarios/proactive-generator.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
// Monday 2 November 2026, 15:00 UTC: 10:00 in New York, standard time.
const T0 = Date.parse("2026-11-02T15:00:00Z"), MIN = 60000, HOUR = 3600000;
// Sunday 1 November 2026, 05:30 UTC: 1:30 in New York for the first time (the clocks go back at 06:00 UTC).
const TD = Date.parse("2026-11-01T05:30:00Z");
const P_SECRET = "p".repeat(40), D_SECRET = "d".repeat(40);
const uid = (n: number) => `00000000-0000-4000-8000-0000000f${String(n).padStart(4, "0")}`;
const phone = (n: number) => `+1555037${String(n).padStart(4, "0")}`;
const tg = (n: number) => `tg:${9100000 + n}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const age = (mins: number) => (mins < 1 ? "under a minute ago" : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} hours ago`);

type Group = "dst" | "changed" | "twins" | "search" | "channels" | "brief" | "unicode" | "people";
const GROUPS: Group[] = ["dst", "changed", "twins", "search", "channels", "brief", "unicode", "people"];
interface Person { n: number; id: string; group: Group; k: number }
const PEOPLE: Person[] = GROUPS.flatMap((g, gi) => Array.from({ length: 5 }, (_, k) => ({ n: gi * 5 + k + 1, id: uid(gi * 5 + k + 1), group: g, k })));
const of = (g: Group) => PEOPLE.filter((p) => p.group === g);
const DST: { tz: string; qs: number; qe: number }[] = [
  { tz: "America/New_York", qs: 22, qe: 7 }, { tz: "America/Chicago", qs: 22, qe: 7 }, { tz: "America/Los_Angeles", qs: 21, qe: 2 },
  { tz: "America/New_York", qs: 1, qe: 2 }, { tz: "America/Phoenix", qs: 22, qe: 6 }];

Deno.test({ name: "proactive round 3 end to end on Postgres: 40 people, the night the clocks go back, postings that change, aggregators, a changed search, two channels, cancelled interviews, emoji", sanitizeResources: false, sanitizeOps: false, async fn(t) {
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
      const z = p.group === "dst" ? DST[p.k] : { tz: "America/New_York", qs: 0, qe: 0 };
      const keyword = p.group === "twins" ? "ux designer" : p.group === "unicode" ? "data scientist" : p.group === "dst" ? "line cook" : "data analyst";
      const search = p.group === "search";
      const prefs = { on: true, keywords: [`${keyword} desk${p.n}`], locations: [], remote_ok: true, report_hour: search ? 0 : 23, quiet_start: z.qs, quiet_end: z.qe, max_instant_per_day: search ? 1 : 10 };
      const checked = p.group === "dst" ? TD - HOUR : T0 - 2 * HOUR;
      sqls.push(`insert into auth.users(id, email) values (${q(p.id)}, ${q(`r3-${p.n}@example.test`)});
        insert into public.profiles(id) values (${q(p.id)});
        insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at, instant_sent_today, sent_on, last_report_on, held)
          values (${q(p.id)}, ${q(z.tz)}, ${q(JSON.stringify(prefs))}::jsonb, ${q(iso(checked))}, 0, null, ${search ? q("2026-11-01") : q("2026-11-02")}, '{}');
        insert into public.channel_contacts(contact, user_id, home) values (${q(phone(p.n))}, ${q(p.id)}, ${p.group === "channels" ? (p.k % 2 === 0 ? "true" : "false") : "true"});
        ${p.group === "channels" ? `insert into public.channel_contacts(contact, user_id, home) values (${q(tg(p.n))}, ${q(p.id)}, ${p.k % 2 === 1 ? "true" : "false"});` : ""}`);
    }
    await db.sql.query(sqls.join("\n"));
    const addPost = async (p: { id: string; title: string; company: string; location: string; url: string; seen: number }) =>
      await db.sql.query(`insert into public.career_postings(job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        values (${q(p.id)}, ${q(p.id.split(":")[0])}, ${q(p.id.split(":")[1])}, ${q(p.company)}, ${q(p.title)}, ${q(p.location)}, ${q(p.url)}, 'The role.', ${q(iso(p.seen))}, ${q(iso(p.seen))})`);

    // ---------------------------------------------------------------------------------------- the handlers
    const postingsDb = supabasePostingsDb(admin);
    const proactive = async (at: number) => {
      const env: Record<string, string> = { CAREER_PROACTIVE_SECRET: P_SECRET };
      const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": P_SECRET } }), {
        env: { get: (k: string) => env[k] }, now: () => at, store: () => supabaseAlertStore(admin),
        recentPostings: (since) => postingsDb.newSince(since), postingsById: (ids) => postingsDb.getMany(ids),
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
    const sent: { channel: string; to: string; text: string; at: number }[] = [];
    const deliverOnce = async (at: number) => {
      const env: Record<string, string> = { TRAINEE_DELIVER_SECRET: D_SECRET, LOOPMESSAGE_API_KEY: "fake-loop-key" };
      const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": D_SECRET } }), {
        env: { get: (k: string) => env[k] }, now: () => at, store: () => supabaseChannelStore(admin),
        send: () => async (contact, bubbles) => { sent.push({ channel: "imessage", to: contact, text: bubbles.join("\n"), at }); return { ok: true, id: `loop-${sent.length}` }; },
        adapters: () => ({ telegram: { channel: "telegram", limits: {}, render: (x: string) => [x],
          send: async (address: string, bubbles: string[]) => { sent.push({ channel: "telegram", to: `tg:${address}`, text: bubbles.join("\n"), at }); return { ok: true, id: `tg-${sent.length}` }; } } }),
        recordRun: async () => {},
      });
      const body = await res.json();
      eq(res.status, 200, `trainee-deliver: ${JSON.stringify(body)}`);
      return body;
    };
    const deliver = async (at: number) => { for (let i = 0; i < 15; i++) { const b = await deliverOnce(at); if (!b.delivered && !b.skipped_opt_out && !b.held) return; } };
    const outbox = async (p: Person) => await rows<{ id: number; key: string; kind: string; status: string; text: string; deliver_at: string; error: string | null; contact: string | null }>(db,
      `select id, key, kind, status, text, deliver_at, error, contact from public.career_outbox where user_id = ${q(p.id)} order by id`);
    const to = (p: Person) => sent.filter((s) => s.to === phone(p.n) || s.to === tg(p.n));

    await t.step("dst: 1:30 the first time in New York, the clocks going back: each alert waits for the end of quiet hours on its person's clock", async () => {
      for (const p of of("dst")) await addPost({ id: `greenhouse:r3d:${p.n}`, title: `Line Cook Desk${p.n}`, company: `Diner ${p.n}`, location: "Remote", url: `https://boards.greenhouse.io/r3d/jobs/${p.n}`, seen: TD - 10 * MIN });
      await proactive(TD);
      for (const p of of("dst")) {
        const { tz, qs, qe } = DST[p.k];
        const a = (await outbox(p)).find((o) => o.kind === "alert");
        ok(a, `dst ${p.n}: the alert was queued`);
        const at = Date.parse(a!.deliver_at), want = quietOn(TD, tz, qs, qe) ? firstAwake(TD, tz, qs, qe) : TD;
        eq(iso(at), iso(want), `dst ${p.n} (${tz}, quiet ${qs}-${qe}): due ${clock(at, tz).hour}:${String(clock(at, tz).minute).padStart(2, "0")} on their clock`);
        ok(!quietOn(at, tz, qs, qe), `dst ${p.n}: not inside quiet hours`);
      }
      // Delivery the moment each is due, and not a minute before (soonest first).
      const due = new Map<number, number>();
      for (const p of of("dst")) due.set(p.n, Date.parse((await outbox(p)).find((o) => o.kind === "alert")!.deliver_at));
      for (const at of [...new Set(due.values())].sort((x, y) => x - y)) {
        if (at > TD) { await deliver(at - MIN); for (const p of of("dst").filter((x) => due.get(x.n)! >= at)) ok(!to(p).length, `dst ${p.n}: nothing a minute early`); }
        await deliver(at);
        for (const p of of("dst").filter((x) => due.get(x.n) === at)) {
          eq(to(p).length, 1, `dst ${p.n}: the alert went once at ${iso(at)}`);
          ok(!quietOn(to(p)[0].at, DST[p.k].tz, DST[p.k].qs, DST[p.k].qe), `dst ${p.n}: sent outside quiet hours`);
        }
      }
    });

    await t.step("one run at 10:00: changed, twins, search, unicode, people", async () => {
      for (const p of of("changed")) await addPost({ id: `greenhouse:r3c:${p.n}`, title: `Data Analyst Desk${p.n}`, company: `Firm ${p.n}`, location: "New York, NY", url: `https://boards.greenhouse.io/r3c/jobs/${p.n}`, seen: T0 - 10 * MIN });
      for (const p of of("twins")) {
        await addPost({ id: `greenhouse:acme${p.n}:1`, title: `UX Designer Desk${p.n}`, company: `Acme ${p.n}`, location: "Austin, TX", url: `https://boards.greenhouse.io/acme${p.n}/jobs/1`, seen: T0 - 10 * MIN });
      }
      // search: three data analyst postings (New York, Remote, Chicago), one alert a day, a report of all three
      for (const p of of("search")) for (const [i, loc] of ["New York, NY", "Remote", "Chicago, IL"].entries())
        await addPost({ id: `greenhouse:r3s${p.n}:${i}`, title: `Data Analyst Desk${p.n}`, company: `Search ${p.n}-${i}`, location: loc, url: `https://boards.greenhouse.io/r3s${p.n}/jobs/${i}`, seen: T0 - (20 + i) * MIN });
      const longCo = (n: number) => `${"🦄".repeat(30)} ${"Ångström Holdings 株式会社 ".repeat(3)}${n}`;
      for (const p of of("unicode")) await addPost({ id: `greenhouse:r3u:${p.n}`, title: `Data Scientist Desk${p.n} ${"👩🏽‍💻".repeat(p.k + 1)} ${"x".repeat(100 + p.k)}`, company: longCo(p.n), location: "Remote 🌍", url: `https://boards.greenhouse.io/r3u/jobs/${p.n}`, seen: T0 - 5 * MIN });
      for (const p of of("people")) await addPost({ id: `greenhouse:r3p:${p.n}`, title: `Data Analyst Desk${p.n}`, company: `People ${p.n}`, location: "Remote", url: `https://boards.greenhouse.io/r3p/jobs/${p.n}`, seen: T0 - 5 * MIN });
      await proactive(T0);
      for (const p of [...of("changed"), ...of("twins"), ...of("unicode"), ...of("people")]) eq((await outbox(p)).filter((o) => o.kind === "alert").length, 1, `${p.group} ${p.n}: one alert queued`);
      for (const p of of("search")) {
        const o = await outbox(p);
        eq([o.filter((x) => x.kind === "alert").length, o.filter((x) => x.kind === "report").length], [1, 1], `search ${p.n}: one alert (one a day) and the report`);
      }
      for (const p of of("unicode")) for (const o of await outbox(p)) ok(!LONE.test(o.text) && o.text.includes("…"), `unicode ${p.n}: whole characters, the cut said: ${JSON.stringify(o.text.slice(0, 200))}`);
    });

    await t.step("changes before delivery, three hours on: the posting as it is then, the search as it is then; a cancelled interview's brief", async () => {
      // changed: k0 unchanged; k1 a new title and company name; k2 now remote; k3 no longer a data analyst job; k4 closed
      const c = of("changed");
      await db.sql.query([
        `update public.career_postings set title = ${q(`Senior Data Analyst Desk${c[1].n}`)}, company = ${q(`Firm ${c[1].n} Labs`)} where job_id = ${q(`greenhouse:r3c:${c[1].n}`)}`,
        `update public.career_postings set location = 'Remote' where job_id = ${q(`greenhouse:r3c:${c[2].n}`)}`,
        `update public.career_postings set title = ${q(`Data Engineer Desk${c[3].n}`)} where job_id = ${q(`greenhouse:r3c:${c[3].n}`)}`,
        `update public.career_postings set closed_at = ${q(iso(T0 + HOUR))} where job_id = ${q(`greenhouse:r3c:${c[4].n}`)}`].join(";\n"));
      // search: k0 unchanged; k1 another title; k2 remote off; k3 Chicago only; k4 alerts off
      const s = of("search");
      const change = [null, `prefs = jsonb_set(prefs, '{keywords}', '["product manager"]')`, `prefs = jsonb_set(prefs, '{remote_ok}', 'false')`,
        `prefs = jsonb_set(prefs, '{locations}', '["chicago"]')`, `prefs = jsonb_set(prefs, '{on}', 'false')`];
      for (const p of s) if (change[p.k]) await db.sql.query(`update public.career_alert_prefs set ${change[p.k]} where user_id = ${q(p.id)}`);
      // channels: rows of each kind for the home channel; k4 says STOP on its other channel
      for (const p of of("channels")) {
        await db.sql.query(["receipt", "status", "digest"].map((kind, j) => `insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(p.id)}, ${q(`${kind}:r3-${p.n}-${j}`)}, ${q(kind)}, ${q(`${kind} ${j} for person ${p.n}`)}, ${q(iso(T0))})`).join(";\n"));
        if (p.k === 4) await admin.rpc("channel_set_opt_out", { p_contact: p.k % 2 === 1 ? phone(p.n) : tg(p.n), p_out: true, p_at: iso(T0) });
      }
      // brief: k0 on; k1 cancelled; k2 moved; k3 the new time's brief of an interview that is on; k4 no interview on file
      for (const p of of("brief")) {
        const key = hex(`r3-invite-${p.n}`);
        if (p.k < 4) await db.sql.query(`insert into public.career_interviews(user_id, invite_key, source, company, role, interview_date, seen_at, brief_at, moved_at, cancelled_at)
          values (${q(p.id)}, ${q(key)}, 'mail', ${q(`Brief ${p.n}`)}, 'Data Analyst', '2026-11-10', ${q(iso(T0 - HOUR))}, ${q(iso(T0 - HOUR))}, ${p.k === 2 ? q(iso(T0 + HOUR)) : "null"}, ${p.k === 1 ? q(iso(T0 + HOUR)) : "null"})`);
        await db.sql.query((p.k === 3 ? [`brief:${key}:moved`] : [`brief:${key}:1`, `brief:${key}:2`]).map((k, j) => `insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(p.id)}, ${q(k)}, 'brief', ${q(`Interview brief ${j + 1} for Brief ${p.n}: Tuesday, November 10.`)}, ${q(iso(T0))})`).join(";\n"));
      }
      // people: k0 paused; k1 account deleted; the rest as they were
      const pp = of("people");
      await db.sql.query(`insert into public.career_watch_kv(user_id, key, value) values (${q(pp[0].id)}, 'career:account', '{"epoch": 0, "version": 0, "paused": true}')`);
      await db.sql.query(`delete from auth.users where id = ${q(pp[1].id)}`);
      await deliver(T0 + 3 * HOUR);
    });

    await t.step("what went, and why the rest did not", async () => {
      const at = T0 + 3 * HOUR;
      const c = of("changed");
      const want: (string | null)[] = [
        `New match: Data Analyst Desk${c[0].n} at Firm ${c[0].n} (New York, NY), first seen ${age(190)}.\nhttps://boards.greenhouse.io/r3c/jobs/${c[0].n}`,
        `New match: Senior Data Analyst Desk${c[1].n} at Firm ${c[1].n} Labs (New York, NY), first seen ${age(190)}.\nhttps://boards.greenhouse.io/r3c/jobs/${c[1].n}`,
        `New match: Data Analyst Desk${c[2].n} at Firm ${c[2].n} (Remote), first seen ${age(190)}.\nhttps://boards.greenhouse.io/r3c/jobs/${c[2].n}`, null, null];
      for (const p of c) {
        const o = (await outbox(p)).find((x) => x.kind === "alert")!;
        if (want[p.k]) { eq(to(p).map((s) => s.text), [want[p.k]], `changed ${p.n}: the posting as it is when it goes (${o.status} ${o.error})`); eq(to(p)[0].at, at, "sent then"); eq(o.text, want[p.k], `changed ${p.n}: the row keeps the words that went`); }
        else { eq(to(p).length, 0, `changed ${p.n}: not sent`); ok(o.status === "skipped_opt_out" && o.error, `changed ${p.n}: why it was not sent: ${o.error}`); }
      }
      for (const p of of("search")) {
        const o = await outbox(p), report = sent.find((x) => x.text.startsWith("Your daily job report") && (x.to === phone(p.n)));
        const alert = o.find((x) => x.kind === "alert")!;
        const fits = [["New York, NY", "Remote", "Chicago, IL"], [], ["New York, NY", "Chicago, IL"], ["Remote", "Chicago, IL"], []][p.k];
        const alertLoc = /\(([^)]*)\), first seen/.exec(alert.text)?.[1] ?? "";
        eq(alert.status === "delivered", fits.includes(alertLoc), `search ${p.n}: the alert for ${alertLoc} (${alert.status} ${alert.error})`);
        if (!fits.length) { ok(!report, `search ${p.n}: no report of the old search: ${report?.text}`); ok(o.every((x) => x.status !== "delivered" && x.error), `search ${p.n}: each row says why: ${JSON.stringify(o.map((x) => x.error))}`); continue; }
        ok(report, `search ${p.n}: the report went`);
        for (const loc of ["New York, NY", "Remote", "Chicago, IL"]) eq(report!.text.includes(`(${loc})`), fits.includes(loc), `search ${p.n}: ${loc} in the report: ${report!.text}`);
        const n = Number(/^Your daily job report: (\d+) match/.exec(report!.text)?.[1]);
        eq(n, fits.length, `search ${p.n}: the count said is the lines: ${report!.text}`);
      }
      for (const p of of("channels")) {
        const home = p.k % 2 === 1 ? tg(p.n) : phone(p.n);
        if (p.k === 4) { eq(to(p).length, 0, `channels ${p.n}: STOP on the other channel holds everything`); ok((await outbox(p)).every((o) => o.status === "skipped_opt_out" && o.error), `channels ${p.n}: each with why`); continue; }
        eq(to(p).length, 3, `channels ${p.n}: each row once`);
        ok(to(p).every((s) => s.to === home), `channels ${p.n}: on the home channel ${home} only: ${to(p).map((s) => s.to)}`);
      }
      for (const p of of("brief")) {
        const o = await outbox(p);
        if (p.k === 1 || p.k === 2) { eq(to(p).length, 0, `brief ${p.n}: the interview was ${p.k === 1 ? "cancelled" : "moved"}: no brief`); ok(o.every((x) => x.status === "skipped_opt_out" && /cancelled or moved/.test(x.error ?? "")), `brief ${p.n}: why: ${o.map((x) => x.error)}`); }
        else eq(to(p).length, o.length, `brief ${p.n}: the brief went (${o.map((x) => `${x.status} ${x.error}`)})`);
      }
      for (const p of of("unicode")) {
        eq(to(p).length, 1, `unicode ${p.n}: the alert went`);
        ok(!LONE.test(to(p)[0].text) && to(p)[0].text.includes("…") && to(p)[0].text.includes("🦄"), `unicode ${p.n}: whole characters: ${JSON.stringify(to(p)[0].text.slice(0, 200))}`);
      }
      const pp = of("people");
      eq(to(pp[0]).length, 0, "people: paused, nothing sent");
      ok((await outbox(pp[0])).every((o) => o.status === "skipped_opt_out" && o.error), "people: paused, each with why");
      eq(to(pp[1]).length, 0, "people: deleted, nothing sent");
      eq(await outbox(pp[1]), [], "people: deleted, nothing kept");
      for (const p of pp.slice(2)) eq(to(p).length, 1, `people ${p.n}: the alert went`);
      eq(await rows(db, `select key from public.career_outbox where status = 'sending'`), [], "nothing stuck sending");
      const silent = await rows<{ key: string }>(db, `select key from public.career_outbox where status in ('skipped_opt_out', 'failed') and error is null`);
      eq(silent, [], "every row not sent says why");
      console.log(`[proactive r3 flow] ${PEOPLE.length} people, ${sent.length} texts, ${Date.now() - started} ms`);
    });
    await t.step("twins: the same job through an aggregator four hours later, and 33 hours later; another job at the firm", async () => {
      for (const p of of("twins")) {
        const v = [
          { company: `Acme ${p.n}, Inc.`, location: "Austin, TX", url: `https://adzuna.example/jobs/${p.n}`, seen: T0 + 4 * HOUR },
          { company: `Acme ${p.n} Careers`, location: "Hybrid", url: `https://boards.greenhouse.io/acme${p.n}/jobs/1?utm_source=adzuna`, seen: T0 + 4 * HOUR },
          { company: `ACME ${p.n} CORP`, location: "Austin, TX", url: `https://adzuna.example/jobs/${p.n}`, seen: T0 + 4 * HOUR },
          { company: `Acme ${p.n} LLC`, location: "Austin, TX", url: `https://adzuna.example/jobs/${p.n}`, seen: T0 + 33 * HOUR },
          { company: `Acme ${p.n}`, location: "Austin, TX", url: `https://boards.greenhouse.io/acme${p.n}/jobs/2`, seen: T0 + 4 * HOUR, title: `Senior UX Designer Desk${p.n}`, id: `greenhouse:acme${p.n}:2` },
        ][p.k] as any;
        await addPost({ id: v.id ?? `lever:aggregator:acme${p.n}`, title: v.title ?? `UX Designer Desk${p.n}`, company: v.company, location: v.location, url: v.url, seen: v.seen });
      }
      await proactive(T0 + 4 * HOUR + 5 * MIN);
      await proactive(T0 + 33 * HOUR + 5 * MIN);
      for (const p of of("twins")) {
        const alerts = (await outbox(p)).filter((o) => o.kind === "alert");
        eq(alerts.length, p.k === 4 ? 2 : 1, `twins ${p.n}: ${alerts.map((a) => a.key).join(", ")}`);
      }
    });

  } finally {
    await db.stop();
  }
} });
