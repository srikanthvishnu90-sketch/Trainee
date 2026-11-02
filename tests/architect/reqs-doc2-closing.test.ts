// REQS DOC 2 (tasks and follow-through), closing dates: Q344 (one text the day before a role on the apply list closes, one
// line once it closed, no loop), Q322 (a closing date gets one more nudge the day before), Q348 (a deadline Trainee knows of
// is surfaced in time to act), Q355 (an unsent application says what it is waiting on, reminded once near its close).
// Outcome checks: career_outbox rows written by the scheduled run (career-proactive handleProactive, wired as its index.ts
// wires it, over real Postgres): who gets one, when, exactly once; nobody paused, nobody already applied, no stated date no
// text. The pure parts (the date reader, the plan) first.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/reqs-doc2-closing.test.ts
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { closingDateOf, closingExpired, type ClosingRow, planClosing, supabaseClosingRows } from "../../supabase/functions/_shared/career_closing.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { supabasePostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const HOUR = 3_600_000, DAY = 86_400_000;
// Tuesday 2026-11-03, 9:00 AM in Chicago (CST): the day before Wednesday Nov 4.
const T0 = Date.UTC(2026, 10, 3, 15, 0);
const SEEN = "2026-10-20T12:00:00.000Z";

Deno.test("CLOSING/1 the date reader: only a stated closing date, from the posting's own sentence", () => {
  const at = (t: string) => closingDateOf(t, SEEN);
  eq(at("We review on a rolling basis. Applications close on November 4, 2026. Apply soon."), { day: "2026-11-04", said: "Applications close on November 4, 2026." });
  eq(at("Apply by Nov. 4")?.day, "2026-11-04", "no year: the first Nov 4 on or after the day it was first seen");
  eq(at("Application deadline: 2026-11-04")?.day, "2026-11-04");
  eq(at("Applications are due 4 November 2026.")?.day, "2026-11-04");
  eq(at("This posting will close January 15")?.day, "2027-01-15", "a January date first seen in October is next year's");
  eq(at("We are accepting applications until December 1st, 2026.")?.day, "2026-12-01");
  for (const t of ["Deadline 11/04/2026", "Founded on November 4, 2010.", "Start date: November 4, 2026.", "Applications close Feb 30, 2027.", "", "Applications close November 4, 2029."])
    eq(at(t), null, t);
  // Review of #378: only an application cue makes a closing date; a bare "deadline" or "no later than" never does.
  for (const t of ["You thrive under deadlines, starting March 3, 2027.", "We thrive under deadlines. Starting March 3, 2027.", "You must be able to start no later than June 1, 2027.",
    "Deadline: November 4, 2026.", "Project deadline December 1, 2026 for the launch.", "Applications close soon, interviews on Nov 10."]) eq(at(t), null, t);
  // The date nearest after the cue, in its clause.
  eq(at("Applications close 4 November, interviews on Nov 10.")?.day, "2026-11-04");
  eq(at("Applications close on November 4, 2026, and interviews run through December 1, 2026.")?.day, "2026-11-04");
  eq(at("Interviews start Nov 20. Applications are due by the deadline of Nov 4.")?.day, "2026-11-04", "a date before the cue is never the cue's");
  eq(at("Submit your application no later than November 4, 2026.")?.day, "2026-11-04");
  eq(at("Applications are due Nov 4 and final interviews Nov 12.")?.day, "2026-11-04", "two dates in the clause: the nearest after the cue");
  eq(at("Applications close 4 November or 2026-11-20 for late ones.")?.day, "2026-11-04", "written two ways: still the nearest after the cue");
  eq(at("We will be accepting applications until Nov. 4")?.day, "2026-11-04");
});

const row = (o: Partial<ClosingRow> = {}): ClosingRow => ({ user_id: "U", posting_key: "greenhouse:acme:1", company: "Acme", title: "Data Analyst", url: "https://job-boards.greenhouse.io/acme/jobs/1",
  queued_at: SEEN, description: "Applications close on November 4, 2026.", first_seen_at: SEEN, closed_at: null, tz: "America/Chicago", report_hour: 8, quiet_start: 22, quiet_end: 7, open_questions: [], ...o });

Deno.test("CLOSING/2 the plan: the day before from the report hour, awake; closed once and only recent; nothing otherwise", () => {
  const p = planClosing([row({ open_questions: ["Are you authorized to work in the US?"] })], T0);
  eq(p.length, 1);
  eq([p[0].userId, p[0].key, p[0].at], ["U", "status:closing:2026-11-04:greenhouse:acme:1", T0]);
  eq(p[0].text, `Data Analyst at Acme closes Wed, Nov 4 (the posting says: "Applications close on November 4, 2026."). It's on your apply list and nothing has been sent. ` +
    `It's waiting on your answer to one question: "Are you authorized to work in the US?". Say "don't apply to Acme" to drop it. This is the only reminder about it.`);
  assert(/hasn't been prepared for your approval yet/.test(planClosing([row()], T0)[0].text));
  eq(planClosing([row()], T0 - 2 * HOUR), [], "7 AM is before the 8 AM report hour");
  eq(planClosing([row()], T0 + 14 * HOUR), [], "11 PM is quiet");
  eq(planClosing([row()], T0 - DAY), [], "two days before: nothing yet");
  eq(planClosing([row()], T0 + DAY), [], "the closing day itself: the day before has passed, no second text");
  eq(planClosing([row({ description: "Great team, rolling applications." })], T0), [], "no stated date: no text");
  const gone = planClosing([row({ closed_at: new Date(T0 - HOUR).toISOString() })], T0);
  eq(gone.map((g) => g.key), ["status:closed:greenhouse:acme:1"]);
  assert(/^Data Analyst at Acme is no longer posted: the employer took it down \(Trainee saw it gone on Nov 3\)\. Nothing was sent for it/.test(gone[0].text), gone[0].text);
  eq(planClosing([row({ closed_at: new Date(T0 - 8 * DAY).toISOString() })], T0), [], "closed more than a week ago is not news");
  eq(planClosing([row({ tz: "America/Los_Angeles" })], T0).length, 0, "7 AM in Los Angeles: before the report hour on their own clock");
  assert(!/tomorrow|today/.test(p[0].text), "no relative day in a text that may be held");
  // A closing text is never delivered from the start of its closing day (UTC); other keys are untouched.
  eq(closingExpired("status:closing:2026-11-04:greenhouse:acme:1", Date.UTC(2026, 10, 3, 23, 59)), false);
  eq(closingExpired("status:closing:2026-11-04:greenhouse:acme:1", Date.UTC(2026, 10, 4, 0, 0)), true);
  eq(closingExpired("status:closed:greenhouse:acme:1", Date.UTC(2027, 0, 1)), false);
  eq(closingExpired("alert:x", Date.UTC(2027, 0, 1)), false);
});

const PEOPLE: Record<string, string> = { "tok-c1": "7b0f8f8e-6a43-4a49-9d2c-0000000c1c01", "tok-c2": "7b0f8f8e-6a43-4a49-9d2c-0000000c1c02", "tok-c3": "7b0f8f8e-6a43-4a49-9d2c-0000000c1c03" };
const SECRET = "c".repeat(40);
const outbox = async (pg: Pg) => JSON.parse((await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('user', user_id, 'key', key, 'kind', kind, 'text', text, 'at', (extract(epoch from deliver_at) * 1000)::bigint) order by user_id, key), '[]') from public.career_outbox`)) || "[]");

Deno.test({ name: "CLOSING/3 the scheduled run on real Postgres: one text the day before, one closed line, once; none for paused, applied or undated", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const [tok, id] of Object.entries(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${tok}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":${tok === "tok-c2"}}');
        insert into public.career_alert_prefs (user_id, tz, prefs, last_checked_at) values ('${id}', 'America/Chicago', '{"on": false, "keywords": ["data analyst"], "locations": [], "remote_ok": true, "report_hour": 8, "quiet_start": 22, "quiet_end": 7, "max_instant_per_day": 3}', now());`);
    }
    const [C1, C2, C3] = [PEOPLE["tok-c1"], PEOPLE["tok-c2"], PEOPLE["tok-c3"]];
    const posting = (k: string, co: string, desc: string, closed: string | null) =>
      `('greenhouse:${k}:1', 'greenhouse', '${k}', '${co}', 'Data Analyst', 'Chicago, IL', 'https://job-boards.greenhouse.io/${k}/jobs/1', '${desc}', '${SEEN}', '${SEEN}', ${closed ? `'${closed}'` : "null"})`;
    await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at, closed_at) values
      ${posting("acme", "Acme", "SQL and dashboards. Applications close on November 4, 2026.", null)},
      ${posting("globex", "Globex", "SQL and dashboards.", new Date(T0 - DAY - 2 * HOUR).toISOString())},
      ${posting("initech", "Initech", "SQL and dashboards, rolling basis.", null)},
      ${posting("hooli", "Hooli", "Apply by November 4, 2026.", null)},
      ${posting("umbrella", "Umbrella", "Applications close on November 4, 2026.", null)};`);
    const want = (u: string, k: string, co: string) => `('${u}', 'greenhouse:${k}:1', 'https://job-boards.greenhouse.io/${k}/jobs/1', '${co}', 'Data Analyst', 'waiting', '${SEEN}')`;
    const job = "greenhouse:hooli:1", url = "https://job-boards.greenhouse.io/hooli/jobs/1";
    const payload = JSON.stringify({ version: "1", user_id: C3, job_id: job, company: "Hooli", url, fields: [], title: "Data Analyst" });
    await pg.sql(`insert into public.career_apply_wanted (user_id, posting_key, url, company, title, state, queued_at) values
        ${want(C1, "acme", "Acme")}, ${want(C1, "globex", "Globex")}, ${want(C1, "initech", "Initech")}, ${want(C2, "acme", "Acme")}, ${want(C3, "hooli", "Hooli")},
        ${want(C1, "umbrella", "Umbrella").replace("'waiting'", "'taken'")}, ${want(C1, "hooli", "Hooli")};
      insert into public.career_apply_questions (user_id, key, kind, label, type, job_ids, company) values ('${C1}', 'fact:work_authorization', 'fact', 'Are you authorized to work in the US?', 'select', array['greenhouse:acme:1'], 'Acme'),
        ('${C1}', 'fact:start_date', 'fact', 'When can you start?', 'text', array['greenhouse:globex:1'], 'Globex'),
        ('${C3}', 'fact:salary', 'fact', 'Another person asked: expected salary?', 'text', array['greenhouse:acme:1'], 'Acme');
      insert into public.channel_contacts (contact, user_id) values ('+15550310001', '${C1}');
      set session_replication_role = replica;
      insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at, updated_at) values
        ('${C3}', '${job}', 'Hooli', '${url}', '${payload}'::jsonb, '${"b".repeat(64)}', '${"b".repeat(64)}', 'submitted_unconfirmed', '${SEEN}', '${SEEN}');
      set session_replication_role = origin;`);
    handler = await careerHandler(pg, PEOPLE);
    const admin: any = createClient(SUPABASE_URL, SERVICE_KEY);
    const run = async (at: number, env: Record<string, string> = {}) => {
      const postings = supabasePostingsDb(admin);
      let recorded: any = null;
      const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": SECRET } }), {
        env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? SECRET : env[k]) }, now: () => at,
        store: () => supabaseAlertStore(admin), recentPostings: (since) => postings.newSince(since), postingsById: (ids) => postings.getMany(ids),
        closing: supabaseClosingRows(admin),
        quiet: async (ids) => {
          const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids });
          if (error) throw new Error(error.message);
          // As index.ts reads it: bare ids or {user_id}.
          return new Set((data ?? []).map((r: any) => String(r?.user_id ?? r)));
        },
        recordRun: async (r) => { recorded = r; },
      });
      eq(res.status, 200, await res.clone().text());
      assert(!recorded?.errors?.closing, JSON.stringify(recorded?.errors));
      return recorded;
    };

    await t.step("switched off: nothing queued", async () => {
      const r = await run(T0, { CAREER_CLOSING_NUDGE: "off" });
      eq(r.closing, undefined);
      eq(await outbox(pg), []);
    });

    await t.step("two days before: only the posting taken down gets its one line", async () => {
      const r = await run(T0 - DAY);
      eq(r.closing, 1);
      const box = await outbox(pg);
      eq(box.map((b: any) => [b.user, b.key, b.kind]), [[C1, "status:closed:greenhouse:globex:1", "status"]]);
      assert(/^Data Analyst at Globex is no longer posted: the employer took it down \(Trainee saw it gone on Nov 2\)\. Nothing was sent for it/.test(box[0].text), box[0].text);
    });

    await t.step("the day before at 9 AM: one text for Acme to the person whose list it is on, saying what it waits on", async () => {
      const r = await run(T0);
      eq(r.closing, 2);
      const box = await outbox(pg);
      eq(box.map((b: any) => [b.user, b.key]), [[C1, "status:closed:greenhouse:globex:1"], [C1, "status:closing:2026-11-04:greenhouse:acme:1"], [C1, "status:closing:2026-11-04:greenhouse:hooli:1"]].sort((a, b) => a[1] < b[1] ? -1 : 1));
      const acme = box.find((b: any) => b.key === "status:closing:2026-11-04:greenhouse:acme:1");
      eq(Number(acme.at), T0);
      assert(acme.text.startsWith(`Data Analyst at Acme closes Wed, Nov 4 (the posting says: "Applications close on November 4, 2026."). It's on your apply list and nothing has been sent.`), acme.text);
      assert(/waiting on your answer to one question: "Are you authorized to work in the US\?"/.test(acme.text), acme.text);
      assert(!box.some((b: any) => b.user === C2), "the paused person gets nothing");
      assert(!box.some((b: any) => b.user === C3), "the role already applied to gets nothing");
      assert(!box.some((b: any) => /initech/.test(b.key)), "no stated date: nothing");
      assert(!box.some((b: any) => /umbrella/.test(b.key)), "a role already taken off the list to apply: nothing");
      assert(!/When can you start/.test(acme.text), "only this posting's own questions");
      assert(!/Another person asked/.test(acme.text), "only this person's own questions");
      assert(box.some((b: any) => b.user === C1 && /hooli/.test(b.key)), "another person's application to Hooli does not count as this person's");
    });

    await t.step("again later that day and on the closing day: nothing more (once, no loop)", async () => {
      const before = await outbox(pg);
      eq((await run(T0 + HOUR)).closing, 0);
      eq((await run(T0 + DAY)).closing, 0);
      eq(await outbox(pg), before);
    });
    await t.step("delivery: a closing text still held when its closing day starts is dropped, never sent late; the closed line goes", async () => {
      const store: any = supabaseChannelStore(admin), sent: string[] = [];
      await deliverDue({ store, now: Date.UTC(2026, 10, 4, 0, 30), send: async (_c, bubbles) => { sent.push(bubbles.join("\n")); return { ok: true, id: `p${sent.length}` }; } });
      await store.release();
      eq(sent.length, 1, JSON.stringify(sent));
      assert(/^Data Analyst at Globex is no longer posted/.test(sent[0]), sent[0]);
      const st = JSON.parse(await pg.sql(`select jsonb_object_agg(key, status) from public.career_outbox where user_id = '${C1}'`));
      eq([st["status:closing:2026-11-04:greenhouse:acme:1"], st["status:closing:2026-11-04:greenhouse:hooli:1"], st["status:closed:greenhouse:globex:1"]], ["skipped_opt_out", "skipped_opt_out", "delivered"]);
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });
