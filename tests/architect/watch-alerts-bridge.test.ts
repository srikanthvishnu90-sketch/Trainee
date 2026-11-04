// A job watch set by text reaches the scheduled alerts run (career-proactive), with what the person said and no more.
//
// The chat router keeps a watch in its own record (152's watch profile in the account's watch state,
// career_watch_kv). The scheduled run reads only career_alert_prefs, which only the held agent brain's tools wrote
// (AGENT_BRAIN_RELEASED=false). syncWatchAlerts (career_watch_alerts.ts) is the bridge the handler calls after a saved
// turn: the watch the turn left becomes the person's alert settings. Each case runs the real router turn, the bridge and
// the real alerts run (runAlerts) with a fake board, and reads the outbox:
//   1 a watch set by text alerts a new matching posting, and nothing else (the role's blockers, the city, remote)
//   2 two watches keep their own cities: never one watch's role in the other's city
//   3 a watch for one firm alerts that firm only; an internship watch never alerts a title of another level
//   4 pause stops every alert, resume brings them back; stop watching the last role turns alerts off
//   5 a turn that changes no watch writes nothing; settings the person set elsewhere are not overwritten
//   6 forget my career profile removes the alert settings, not only the alerts
//   7 a change starts watching from now: postings already on the boards are never alerted; the day's counters stay
//   8 the handler calls the bridge after the turn is saved, for every turn, not inside the held brain branch
// Run: deno test -A --no-check tests/architect/watch-alerts-bridge.test.ts
import { createRequire } from "node:module";
import { syncWatchAlerts } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import { memoryAlertStore, type AlertRow } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runAlerts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { alertStillWanted } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import { ALERTS_OFF_NOTE, deliverDue, memoryChannel } from "../../supabase/functions/_shared/channel.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";

const require = createRequire(import.meta.url);
const D = (n: string) => require(`../../packages/domain/${n}`);
const { CareerHost } = require("../../supabase/functions/_shared/career_host.js");
const host = CareerHost.createCareerHost({
  CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"),
  CareerDoorstep: D("141-career-doorstep.js"), CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
});
const HANDLER = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const USER = "11111111-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-10-24T15:00:00Z"), HOUR = 3600000;
const PROFILE = { basics: { name: "Alex Testcase", location: "Chicago, IL" }, facts: [], constraints: {}, preferences: { locations: ["Chicago"], starredCompanies: [] } };

// One person's conversation: each say() is one saved turn (the account's watch state is committed, as career_host_commit
// does), then the handler's bridge call, whose failure is caught as the handler catches it.
function person(store: any = memoryAlertStore(), now = T0) {
  let snapshot: any = null, account: any = {};
  return {
    store,
    async say(text: string, at = now) {
      const before = account;
      const ctx = host.createTurnCtx({ userId: USER, threadId: "thread-1", now: at, snapshot, profile: PROFILE, watchState: before });
      const out = host.runTurn(text, ctx);
      snapshot = host.extractSnapshot(ctx);
      account = JSON.parse(JSON.stringify(ctx.alertWatchState ?? {}));
      const r: any = await syncWatchAlerts({ userId: USER, before, after: account, erased: ctx._hostPatch?.erase === true, store, now: at })
        .catch((e) => ({ action: "threw", error: String(e?.message ?? e) }));
      return { out, r };
    },
    // The committed watch records (career_watch_kv), as career-proactive's `watches` reads them.
    watches: async (ids: string[]) => new Map(ids.filter((id) => account[`career:watch-profile:${id}`]).map((id) => [id, account[`career:watch-profile:${id}`]])),
  };
}
// An alert store whose writes fail while `failing` is set.
function flaky() {
  const inner = memoryAlertStore(), sw = { failing: false };
  const fail = () => { if (sw.failing) throw new Error("synthetic write failure"); };
  return { sw, store: { ...inner, save: async (r: AlertRow) => { fail(); return inner.save(r); }, remove: async (id: string) => { fail(); return inner.remove!(id); } } };
}
const posting = (id: string, title: string, company: string, location: string, seen: number) =>
  ({ job_id: id, title, company, location, url: `https://boards.example.test/${id}`, first_seen_at: new Date(seen).toISOString(), posted_at: new Date(seen).toISOString() });
// The scheduled run at `at` over a board holding `postings`, reading the person's watch records; returns the job ids alerted.
async function run(p: { store: any; watches?: (ids: string[]) => Promise<Map<string, unknown>> }, postings: any[], at: number, watches = p.watches): Promise<string[]> {
  const store = p.store, n = store.dump().outbox.length;
  await runAlerts({ store, outbox: store, now: at, recentPostings: async () => postings, postingsById: async () => [], watches });
  return store.dump().outbox.slice(n).filter((o: any) => o.kind === "alert").map((o: any) => o.key.replace(/^alert:/, ""));
}

Deno.test("1 a watch set by text alerts a new matching posting, and nothing else", async () => {
  const p = person();
  const { out } = await p.say("Watch for data analyst roles in New York");
  assert(out.intent === "career_watch_create", out.reply);
  const row = await p.store.get(USER);
  assert(row && row.prefs.on, `the watch is the person's alert settings: ${JSON.stringify(row)}`);
  const seen = T0 + HOUR;
  const got = await run(p, [
    posting("nyc", "Data Analyst", "Acme", "New York, NY", seen),
    posting("remote", "Data Analyst", "Acme", "Remote", seen),
    posting("senior", "Senior Data Analyst", "Acme", "New York, NY", seen),
    posting("boston", "Data Analyst", "Acme", "Boston, MA", seen),
    posting("other", "Marketing Coordinator", "Acme", "New York, NY", seen),
  ], T0 + 2 * HOUR);
  eq(got.sort(), ["nyc", "remote"], "the city and remote, never a blocked title, another city or another role");
});

Deno.test("2 two watches keep their own cities: never one watch's role in the other's city", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  await p.say("Watch for investment banking analyst roles in Chicago");
  const seen = T0 + HOUR;
  const got = await run(p, [
    posting("da-nyc", "Data Analyst", "Acme", "New York, NY", seen),
    posting("ib-chi", "Investment Banking Analyst", "Acme", "Chicago, IL", seen),
    posting("da-chi", "Data Analyst", "Acme", "Chicago, IL", seen),
    posting("ib-nyc", "Investment Banking Analyst", "Acme", "New York, NY", seen),
  ], T0 + 2 * HOUR);
  eq(got.sort(), ["da-nyc", "ib-chi"], "each role in its own city only");
});

Deno.test("3 a watch for one firm alerts that firm only; an internship watch never alerts a title of another level", async () => {
  const p = person();
  await p.say("Watch for investment banking analyst roles at Goldman Sachs in Chicago");
  await p.say("Watch for data analyst internships in New York");
  const seen = T0 + HOUR;
  const got = await run(p, [
    posting("gs", "Investment Banking Analyst", "Goldman Sachs", "Chicago, IL", seen),
    posting("ms", "Investment Banking Analyst", "Morgan Stanley", "Chicago, IL", seen),
    posting("intern", "Data Analyst Intern", "Acme", "New York, NY", seen),
    posting("lead", "Lead Data Analyst", "Acme", "New York, NY", seen),
    posting("junior", "Junior Data Analyst", "Acme", "New York, NY", seen),
  ], T0 + 2 * HOUR);
  eq(got.sort(), ["gs", "intern"], "the named firm, and the internship, only: never another level's title");
});

Deno.test("4 pause stops every alert, resume brings them back; stop watching the last role turns alerts off", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  await p.say("pause my job alerts", T0 + HOUR);
  assert((await p.store.get(USER))?.prefs.on === false, "paused: off");
  eq(await run(p, [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + 2 * HOUR)], T0 + 3 * HOUR), [], "paused: nothing");
  await p.say("resume my job alerts", T0 + 4 * HOUR);
  eq(await run(p, [posting("b", "Data Analyst", "Acme", "New York, NY", T0 + 5 * HOUR)], T0 + 6 * HOUR), ["b"], "resumed");
  await p.say("stop watching data analyst roles", T0 + 7 * HOUR);
  const row = await p.store.get(USER);
  assert(row && row.prefs.on === false, `no watch left: off, ${JSON.stringify(row?.prefs)}`);
  eq(await run(p, [posting("c", "Data Analyst", "Acme", "New York, NY", T0 + 8 * HOUR)], T0 + 9 * HOUR), [], "no watch: nothing");
});

Deno.test("5 a turn that changes no watch writes nothing; settings the person set elsewhere are not overwritten", async () => {
  const store = memoryAlertStore();
  let saves = 0;
  const counted = { ...store, save: async (r: AlertRow) => { saves++; return store.save(r); } };
  // Alerts the person set elsewhere (the brain's tools): their own keywords and report hour.
  await store.save({ id: USER, tz: "America/Chicago", prefs: { on: true, keywords: ["product manager"], locations: ["austin"], remote_ok: false, report_hour: 9, quiet_start: 22, quiet_end: 7, max_instant_per_day: 3 },
    last_checked_at: new Date(T0).toISOString(), instant_sent_today: 0, sent_on: null, last_report_on: null, held: [] });
  const p = person(counted as any);
  await p.say("What am I watching?");
  await p.say("Tell me about investment banking");
  eq(saves, 0, "no watch changed: no write");
  eq((await store.get(USER))?.prefs.keywords, ["product manager"], "the person's own settings stand");
  // A watch the person sets by text is their latest word: it is saved, keeping their zone and report hour.
  await p.say("Watch for data analyst roles in New York");
  const row = await store.get(USER);
  assert(row && row.tz === "America/Chicago" && row.prefs.report_hour === 9, `zone and report hour kept: ${JSON.stringify(row)}`);
});

Deno.test("6 forget my career profile removes the alert settings, not only the alerts", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  assert(await p.store.get(USER), "set");
  const { out, r } = await p.say("forget my career profile", T0 + HOUR);
  assert(out.intent === "career_profile_erased", out.reply);
  eq(r.action, "removed", "the bridge removed the settings");
  eq(await p.store.get(USER), null, "the row, with the person's keywords, is gone");
});

Deno.test("7 a change starts watching from now: postings already on the boards are never alerted; the day's counters stay", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  const before = await p.store.get(USER);
  await p.store.saveCounters!(USER, { last_checked_at: before!.last_checked_at, instant_sent_today: 2, sent_on: before!.sent_on, held: ["held-1"], last_report_on: before!.last_report_on });
  await p.say("Watch for investment banking analyst roles in Chicago", T0 + 3 * HOUR);
  const row = await p.store.get(USER);
  assert(row && row.instant_sent_today === 2 && row.held?.includes("held-1"), `today's count and held kept: ${JSON.stringify(row)}`);
  eq(await run(p, [posting("old", "Data Analyst", "Acme", "New York, NY", T0 + 2 * HOUR)], T0 + 4 * HOUR), [], "seen before the change: never news");
});

Deno.test("8 the handler calls the bridge after the turn is saved, for every turn, not inside the held brain branch", () => {
  // The save is the evidenced commit (commitTurn wraps persistence.commit since #318); the first await of it is the save.
  const commit = HANDLER.indexOf("saved = await commitTurn(");
  const call = HANDLER.indexOf("syncWatchAlerts(");
  assert(commit > 0 && call > commit, "syncWatchAlerts runs after persistence.commit (a refused save writes no alert settings)");
  assert(call < HANDLER.indexOf("return json(cors, saved.response, 200)"), "and before the saved reply is returned");
  const brain = HANDLER.indexOf('AGENT_BRAIN_RELEASED && chooseBrain(Deno.env) === "agent"');
  const brainEnd = HANDLER.indexOf("persistence.commit(");
  assert(!(call > brain && call < brainEnd), "not inside the brain branch");
  assert(/syncWatchAlerts\(\{[^}]*before: loaded\.watchState/.test(HANDLER), "from the watch state the turn loaded");
  assert(/syncWatchAlerts\(\{[^}]*after: ctx\.alertWatchState/.test(HANDLER), "to the one it left");
  const statement = HANDLER.slice(call, HANDLER.indexOf("flowCtx.note = null", call));
  assert(statement.includes(".catch("), "a failed alert write never fails the saved turn");
});

// Fail-open, coordinator 2026-10-24 (Z1-Z3): a write that fails must never leave alerts on after the person paused, stopped
// or erased them. The scheduled run checks each watch row against the committed watch record; the next turn repairs the row.
Deno.test("Z1 pause while the alert write fails: the scheduled run sends nothing (it reads the paused watch record)", async () => {
  const { sw, store } = flaky(), p = person(store);
  await p.say("Watch for data analyst roles in New York");
  sw.failing = true;
  const { out, r } = await p.say("pause my job alerts", T0 + HOUR);
  assert(/paused/i.test(out.reply) && r.action === "threw", `the turn said paused, the write failed: ${r.action}`);
  assert((await store.get(USER))?.prefs.on === true, "the row is still on (the failure is real)");
  eq(await run(p, [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + 2 * HOUR)], T0 + 3 * HOUR), [], "nothing sent");
});

Deno.test("Z2 erase while the remove fails: nothing is sent, and the run removes the stale copy once it can", async () => {
  const { sw, store } = flaky(), p = person(store);
  await p.say("Watch for data analyst roles in New York");
  sw.failing = true;
  const { out, r } = await p.say("forget my career profile", T0 + HOUR);
  assert(out.intent === "career_profile_erased" && r.action === "threw", `erased, the remove failed: ${r.action}`);
  assert(await store.get(USER), "the row stayed (the failure is real)");
  eq(await run(p, [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + 2 * HOUR)], T0 + 3 * HOUR), [], "nothing sent after the erase");
  sw.failing = false;
  eq(await run(p, [posting("b", "Data Analyst", "Acme", "New York, NY", T0 + 4 * HOUR)], T0 + 5 * HOUR), [], "still nothing");
  eq(await store.get(USER), null, "the run removed the copy whose watch record is gone");
});

Deno.test("Z3 a later unrelated turn repairs a missed write: a missed pause turns off, a missed watch is added", async () => {
  const { sw, store } = flaky(), p = person(store);
  await p.say("Watch for data analyst roles in New York");
  sw.failing = true;
  await p.say("pause my job alerts", T0 + HOUR);
  sw.failing = false;
  const { r } = await p.say("What am I watching?", T0 + 2 * HOUR);
  eq(r.action, "off", "repaired by the next turn");
  assert((await store.get(USER))?.prefs.on === false, "off");
  await p.say("resume my job alerts", T0 + 3 * HOUR);
  sw.failing = true;
  await p.say("Watch for investment banking analyst roles in Chicago", T0 + 4 * HOUR);
  sw.failing = false;
  await p.say("Tell me about investment banking", T0 + 5 * HOUR);
  eq((await store.get(USER))?.prefs.interests?.length, 2, "the missed second watch is in the row");
});

Deno.test("Z4 no watch reader, or one that fails: no watch row sends; settings made elsewhere still do", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  const board = [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + HOUR)];
  eq(await run(p, board, T0 + 2 * HOUR, null as any), [], "no reader: nothing");
  eq(await run(p, board, T0 + 2 * HOUR, async () => { throw new Error("unreadable"); }), [], "a failed read: nothing");
  // Settings made elsewhere (no interests) are not the watch record's to verify.
  const other = memoryAlertStore();
  await other.save({ id: USER, tz: "America/New_York", prefs: { on: true, keywords: ["data analyst"], locations: ["new york"], remote_ok: true, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 3 },
    last_checked_at: new Date(T0).toISOString(), instant_sent_today: 0, sent_on: null, last_report_on: null, held: [] });
  eq(await run({ store: other }, board, T0 + 2 * HOUR, async () => { throw new Error("unreadable"); }), ["a"], "set elsewhere: sent as before");
});

Deno.test("Z5 career-proactive gives the run the committed watch records", () => {
  const handler = Deno.readTextFileSync(new URL("../../supabase/functions/career-proactive/handler.ts", import.meta.url));
  const index = Deno.readTextFileSync(new URL("../../supabase/functions/career-proactive/index.ts", import.meta.url));
  assert(/runAlerts\(\{[^}]*watches: d\.watches/.test(handler), "the handler passes watches to runAlerts");
  assert(/watches: async \(ids\)/.test(index) && index.includes('from("career_watch_kv")') && index.includes("career:watch-profile:"), "index reads career_watch_kv watch profiles");
});

Deno.test("Z6 a missed stop of one watch: the run matches the watch record's watches, not the stale copy's", async () => {
  const { sw, store } = flaky(), p = person(store);
  await p.say("Watch for data analyst roles in New York");
  await p.say("Watch for investment banking analyst roles in Chicago");
  sw.failing = true;
  await p.say("stop watching data analyst roles", T0 + HOUR);
  eq((await store.get(USER))?.prefs.interests?.length, 2, "the copy still has both (the failure is real)");
  const seen = T0 + 2 * HOUR;
  eq((await run(p, [posting("da", "Data Analyst", "Acme", "New York, NY", seen), posting("ib", "Investment Banking Analyst", "Acme", "Chicago, IL", seen)], T0 + 3 * HOUR)).sort(), ["ib"], "only the watch still on record");
});

// Delivery boundary, coordinator 2026-10-24 14:13: an alert queued before "pause my job alerts" or "stop watching ..."
// changes only the watch, not the account pause (career_user_quiet), so delivery checks the job alerts again itself.
// What the run queued goes to the texting channel, which asks at delivery whether each alert is still wanted.
async function deliver(p: any, board: any[], at: number, wanted?: (m: any) => Promise<boolean>) {
  const queued = p.store.dump().outbox.map((o: any, i: number) => ({ id: String(i + 1), userId: o.userId, contact: "+15555550100", key: o.key, text: o.text, deliver_at: o.at, attempts: 0 }));
  const ch: any = memoryChannel(queued);
  ch.alertWanted = wanted ?? (async (m: any) => alertStillWanted(m.key, { row: await p.store.get(m.userId), record: (await p.watches([m.userId])).get(m.userId), posting: board.find((x) => `alert:${x.job_id}` === m.key) }));
  const sent: string[] = [];
  const r = await deliverDue({ store: ch, now: at, send: async (_c, b) => { sent.push(b.join(" ")); return { ok: true, id: "p" }; } });
  const rows = ch.rows();
  return { r, sent, delivered: rows.filter((x: any) => x.status === "delivered").map((x: any) => x.key).sort(), off: rows.filter((x: any) => x.error === ALERTS_OFF_NOTE).map((x: any) => x.key).sort(), queuedLeft: rows.filter((x: any) => x.status === "queued").map((x: any) => x.key) };
}

Deno.test("D1 an alert queued before \"pause my job alerts\" is not delivered", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  const board = [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + HOUR)];
  eq(await run(p, board, T0 + 2 * HOUR), ["a"], "queued");
  await p.say("pause my job alerts", T0 + 2 * HOUR + 60000);
  const d = await deliver(p, board, T0 + 3 * HOUR);
  eq(d.delivered, [], "nothing delivered");
  eq(d.off, ["alert:a"], "marked: the job alerts no longer ask for it");
});

Deno.test("D2 \"stop watching\" one of two watches after both alerts were queued: only the other is delivered", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  await p.say("Watch for investment banking analyst roles in Chicago");
  const seen = T0 + HOUR, board = [posting("da", "Data Analyst", "Acme", "New York, NY", seen), posting("ib", "Investment Banking Analyst", "Acme", "Chicago, IL", seen)];
  eq((await run(p, board, T0 + 2 * HOUR)).sort(), ["da", "ib"], "both queued");
  await p.say("stop watching data analyst roles", T0 + 2 * HOUR + 60000);
  const d = await deliver(p, board, T0 + 3 * HOUR);
  eq(d.delivered, ["alert:ib"], "the watch still on");
  eq(d.off, ["alert:da"], "the stopped watch's alert is not sent");
});

Deno.test("D3 erased after the alert was queued; or the posting closed since: not delivered", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  const board = [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + HOUR), posting("b", "Data Analyst", "Acme", "Remote", T0 + HOUR)];
  eq((await run(p, board, T0 + 2 * HOUR)).sort(), ["a", "b"], "queued");
  (board[1] as any).closed_at = new Date(T0 + 2 * HOUR + 1000).toISOString();
  const closed = await deliver(p, board, T0 + 3 * HOUR);
  eq([closed.delivered, closed.off], [["alert:a"], ["alert:b"]], "the closed posting's alert is not sent");
  const q = person();
  await q.say("Watch for data analyst roles in New York");
  eq(await run(q, [board[0]], T0 + 2 * HOUR), ["a"], "queued");
  await q.say("forget my career profile", T0 + 2 * HOUR + 60000);
  eq((await deliver(q, [board[0]], T0 + 3 * HOUR)).delivered, [], "erased: nothing");
});

Deno.test("D4 a check that cannot be read: the alert waits for the next run, never sent", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  const board = [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + HOUR)];
  await run(p, board, T0 + 2 * HOUR);
  const d = await deliver(p, board, T0 + 3 * HOUR, async () => { throw new Error("unreadable"); });
  eq([d.delivered, d.r.deferred, d.queuedLeft], [[], 1, ["alert:a"]], "deferred, still queued");
  eq((await deliver(p, board, T0 + 3 * HOUR)).delivered, ["alert:a"], "still wanted, readable: delivered");
});

// The production store's check, over a fake client that answers the three reads it makes.
function fakeAdmin(t: { prefs?: any; record?: any; posting?: any; fail?: string }) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      const q: any = { filters: {} as Record<string, unknown> };
      q.select = () => q;
      q.eq = (k: string, v: unknown) => { q.filters[k] = v; return q; };
      q.maybeSingle = async () => {
        reads.push(`${table}:${JSON.stringify(q.filters)}`);
        if (t.fail === table) return { data: null, error: { message: "synthetic read failure" } };
        const data = table === "career_alert_prefs" ? (t.prefs ? { prefs: t.prefs } : null)
          : table === "career_watch_kv" ? (t.record ? { value: t.record } : null)
          : table === "career_postings" ? (t.posting ?? null) : null;
        return { data, error: null };
      };
      return q;
    },
  };
}
Deno.test("D5 the production channel store reads the alert settings, the watch record and the posting, and fails closed", async () => {
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  const prefs = (await p.store.get(USER))!.prefs, record = (await p.watches([USER])).get(USER);
  const row = { id: "1", userId: USER, contact: "+15555550100", key: "alert:a", text: "x", deliver_at: 0, attempts: 0 };
  const yes = posting("a", "Data Analyst", "Acme", "New York, NY", T0);
  const admin = fakeAdmin({ prefs, record, posting: yes });
  eq(await supabaseChannelStore(admin).alertWanted!(row), true, "wanted");
  eq(admin.reads, [`career_alert_prefs:{"user_id":"${USER}"}`, `career_watch_kv:{"user_id":"${USER}","key":"career:watch-profile:${USER}"}`, `career_postings:{"job_id":"a"}`], "the three reads");
  eq(await supabaseChannelStore(fakeAdmin({ prefs, record: { ...(record as any), opt_out: { global: true, companies: [] } }, posting: yes })).alertWanted!(row), false, "paused watch");
  eq(await supabaseChannelStore(fakeAdmin({ prefs, record: null, posting: yes })).alertWanted!(row), false, "watch record gone");
  eq(await supabaseChannelStore(fakeAdmin({ prefs: null, record, posting: yes })).alertWanted!(row), false, "no alert settings");
  eq(await supabaseChannelStore(fakeAdmin({ prefs, record, posting: null })).alertWanted!(row), false, "posting gone");
  for (const fail of ["career_alert_prefs", "career_watch_kv", "career_postings"]) {
    let threw = false;
    try { await supabaseChannelStore(fakeAdmin({ prefs, record, posting: yes, fail })).alertWanted!(row); } catch { threw = true; }
    assert(threw, `${fail} unreadable: throws (delivery defers)`);
  }
});

Deno.test("D6 a stop whose write failed: delivery matches the watch record, not the stale copy", async () => {
  const { sw, store } = flaky(), p = person(store);
  await p.say("Watch for data analyst roles in New York");
  await p.say("Watch for investment banking analyst roles in Chicago");
  const seen = T0 + HOUR, board = [posting("da", "Data Analyst", "Acme", "New York, NY", seen), posting("ib", "Investment Banking Analyst", "Acme", "Chicago, IL", seen)];
  eq((await run(p, board, T0 + 2 * HOUR)).sort(), ["da", "ib"], "both queued");
  sw.failing = true;
  await p.say("stop watching data analyst roles", T0 + 2 * HOUR + 60000);
  eq((await store.get(USER))?.prefs.interests?.length, 2, "the copy still has both (the failure is real)");
  eq((await deliver(p, board, T0 + 3 * HOUR)).delivered, ["alert:ib"], "only the watch on record");
});

Deno.test("D7 settings made elsewhere, turned off after the alert was queued: not delivered", async () => {
  const store = memoryAlertStore(), p: any = { store, watches: async () => new Map() };
  await store.save({ id: USER, tz: "America/New_York", prefs: { on: true, keywords: ["data analyst"], locations: ["new york"], remote_ok: true, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 3 },
    last_checked_at: new Date(T0).toISOString(), instant_sent_today: 0, sent_on: null, last_report_on: null, held: [] });
  const board = [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + HOUR)];
  eq(await run(p, board, T0 + 2 * HOUR), ["a"], "queued");
  const row = (await store.get(USER))!;
  await store.save({ ...row, prefs: { ...row.prefs, on: false } });
  eq((await deliver(p, board, T0 + 3 * HOUR)).delivered, [], "off: nothing");
});

// What a resume does to a row that is still due: resumed before delivery reaches it, the row goes out (the person
// wants alerts again and the posting still fits); delivery that ran during the pause marked it not sent, and that is
// final: a resume never sends it later, and the next run does not queue it again (watching restarts from the resume).
Deno.test("D8 resume: before delivery, the queued alert goes out; after delivery skipped it, it never goes out", async () => {
  const board = [posting("a", "Data Analyst", "Acme", "New York, NY", T0 + HOUR)];
  const p = person();
  await p.say("Watch for data analyst roles in New York");
  eq(await run(p, board, T0 + 2 * HOUR), ["a"], "queued");
  await p.say("pause my job alerts", T0 + 2 * HOUR + 60000);
  await p.say("resume my job alerts", T0 + 2 * HOUR + 120000);
  eq((await deliver(p, board, T0 + 3 * HOUR)).delivered, ["alert:a"], "resumed before delivery: delivered");

  const q = person();
  await q.say("Watch for data analyst roles in New York");
  eq(await run(q, board, T0 + 2 * HOUR), ["a"], "queued");
  await q.say("pause my job alerts", T0 + 2 * HOUR + 60000);
  const queued = q.store.dump().outbox.map((o: any, i: number) => ({ id: String(i + 1), userId: o.userId, contact: "+15555550100", key: o.key, text: o.text, deliver_at: o.at, attempts: 0 }));
  const ch: any = memoryChannel(queued);
  ch.alertWanted = async (m: any) => alertStillWanted(m.key, { row: await q.store.get(m.userId), record: (await q.watches([m.userId])).get(m.userId), posting: board.find((x) => `alert:${x.job_id}` === m.key) });
  const sent: string[] = [], send = async (_c: string, b: string[]) => { sent.push(b.join(" ")); return { ok: true as const, id: "p" }; };
  await deliverDue({ store: ch, now: T0 + 3 * HOUR, send });
  await q.say("resume my job alerts", T0 + 4 * HOUR);
  await deliverDue({ store: ch, now: T0 + 5 * HOUR, send });
  eq([sent, ch.rows().map((x: any) => x.status)], [[], ["skipped_opt_out"]], "skipped during the pause: final, not sent after the resume");
  eq(await run(q, board, T0 + 6 * HOUR), [], "and the next run does not queue it again");
});
