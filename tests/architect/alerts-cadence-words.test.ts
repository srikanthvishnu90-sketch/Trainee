// JOB ALERTS AS A REAL OUTCOME, review of PR #365. Pure: no database. Each case fails under the mutation named beside it.
//   zone       a zone word is a zone only right after a time ("at 6am PT") or when it can only be a zone ("eastern time",
//              "PST"): "central London" is not Chicago, "PT roles" is part-time (mutation: the old any-word zone match)
//   hour       an hour only in a time's form (am/pm, :mm, o'clock, "at N" + a time-of-day word or a zone): "at 3
//              companies" is not 3 o'clock (mutation: the old "at N" match)
//   scope      "less like 2" reads the person's OWN last message: A's never reads B's, and never changes B's rules
//              (mutation: the user_id filter dropped from lastSent)
//   any turn   a cadence is changed only on the turn that set the watch or one about their alerts: "I go to the gym every
//              evening" changes nothing (mutation: the cadence read on every turn)
//   deno test -A --no-check tests/architect/alerts-cadence-words.test.ts
import { ALERT_SAVE_FAILED_REPLY, alertWriteFailed, cadenceFrom, previewWatchAlerts, scheduleLine, supabaseTellAfterTurn, syncWatchAlerts, WATCH_PROFILE_KEY } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import { reportDue } from "../../supabase/functions/_shared/career_alerts.ts";
import { alertFeedbackTurn, supabaseFeedbackReads } from "../../supabase/functions/_shared/career_alert_feedback.ts";
import { memoryAlertStore, startWatching, validPrefs } from "../../supabase/functions/_shared/career_alert_store.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const CHI = "America/Chicago", LA = "America/Los_Angeles", NY = "America/New_York";

Deno.test("zone: only right after a time, or a word that can only be a zone", () => {
  const z = (said: string) => { const c = cadenceFrom(said); return [c?.report_hour, c?.report_minute, c?.tz ?? null]; };
  eq(z("send me analyst roles in central London every morning"), [8, 0, null], "central London is a place");
  eq(z("PT roles in Austin every morning please"), [8, 0, null], "PT before roles is part-time");
  eq(z("send me part time PT jobs every morning at 9am"), [9, 0, null], "PT not after the time");
  eq(z("Pacific Northwest roles every morning"), [8, 0, null], "a region, not a zone");
  eq(z("every morning at 6am PT"), [6, 0, LA], "PT right after a time");
  eq(z("data analyst roles in Chicago every morning at 6am central"), [6, 0, CHI], "central after a time");
  eq(z("every morning at 6 central"), [6, 0, CHI], "at N + zone");
  eq(z("every evening at 7:30 et"), [19, 30, NY], ":mm + zone");
  eq(z("every morning, eastern time"), [8, 0, NY], "eastern time");
  eq(z("every morning on Chicago time"), [8, 0, CHI], "Chicago time");
  eq(z("every morning, I'm on PST"), [8, 0, LA], "PST can only be a zone");
});

Deno.test("hour: a stated hour is honored; a bare number that runs on into other words is never an hour", () => {
  const at = (said: string) => { const c = cadenceFrom(said); return c && [c.report_hour ?? null, c.report_minute ?? null]; };
  // honored, re-review of PR #365
  eq(at("send me pm jobs every evening at 7"), [19, 0], "evening at 7 -> 7 PM");
  eq(at("every night at 9"), [21, 0], "night at 9 -> 9 PM");
  eq(at("send me roles every morning at 7"), [7, 0], "morning at 7 -> 7 AM");
  eq(at("every evening at 7:30"), [19, 30], "evening at 7:30 -> 7:30 PM, minutes kept");
  eq(at("send them at 7 every evening"), [19, 0], "at 7 every evening");
  eq(at("every day at noon"), [12, 0], "noon");
  eq(at("send them every night, at noon instead"), [12, 0], "noon is noon whatever the cadence's part of day");
  eq(at("every day at 9"), [9, 0], "a day at 9 -> 9 AM");
  eq(at("every day at 5"), [17, 0], "a day at 5 -> 5 PM");
  eq(at("every evening at 7, please"), [19, 0], "then punctuation");
  eq(at("every morning at 6 central"), [6, 0], "then a zone");
  eq(at("send me pm jobs every evening at 7pm"), [19, 0], "7pm");
  eq(at("send me jobs every day at 7 in the evening"), [19, 0], "at 7 in the evening");
  eq(at("send me jobs every evening at 6 in the morning"), [6, 0], "the time's own part of day");
  eq(at("every morning at 9 o'clock"), [9, 0], "o'clock");
  eq(at("every day at 7 o'clock pm"), [19, 0], "o'clock pm");
  eq(at("every evening at 7 o'clock am"), [7, 0], "o'clock am wins over the evening");
  eq(at("every day at 9 o'clock a.m."), [9, 0], "o'clock a.m.");
  eq(at("every day at 5 a.m."), [5, 0], "a.m.");
  eq(at("every night"), [21, 0], "night with no time: 9 PM");
  eq(at("nightly"), [21, 0], "nightly");
  // never an hour
  eq(at("every morning send me jobs at 3 companies"), [8, 0], "at 3 companies");
  eq(at("every evening send me roles at 2 startups in Denver"), [18, 0], "at 2 startups");
  eq(at("every morning at 3 companies in Austin"), [8, 0], "at 3 companies right after the cadence");
});

Deno.test("midnight is asked about, never set; weekdays are kept", () => {
  eq(cadenceFrom("every night at midnight"), { digest: true, ask: "midnight" }, "midnight");
  eq(cadenceFrom("every night at 12"), { digest: true, ask: "midnight" }, "night at 12");
  eq(cadenceFrom("every day at 12am"), { digest: true, ask: "midnight" }, "12am");
  eq(cadenceFrom("every weekday at 8am"), { digest: true, weekdays: true, report_hour: 8, report_minute: 0 }, "every weekday");
  eq(cadenceFrom("send me jobs every morning, weekdays only"), { digest: true, weekdays: true, report_hour: 8, report_minute: 0 }, "weekdays only");
  eq(cadenceFrom("send me jobs every morning"), { digest: true, report_hour: 8, report_minute: 0 }, "every day: no weekday flag");
  // Only a request for the ALERTS on weekdays switches it (re-review of PR #365).
  for (const said of ["I'm free on weekdays, send roles every morning", "I work weekdays; send me jobs every evening at 7", "I'm in class Monday to Friday, so text me roles every night"]) {
    eq(cadenceFrom(said)?.weekdays ?? false, false, said);
  }
  eq(cadenceFrom("I'm free on weekdays"), null, "no cadence at all: nothing changed");
  for (const said of ["every weekday morning at 8am", "send me roles every morning, weekdays only", "on weekdays send me data roles every morning", "text me roles every morning Mon-Fri", "send me jobs every evening, only on weekdays"]) {
    eq(cadenceFrom(said)?.weekdays, true, said);
  }
});

Deno.test("the alerts run: the minute and weekdays are honored on the person's clock", () => {
  const p = { report_hour: 19, report_minute: 30 };
  eq([reportDue({ date: "2026-11-04", hour: 19, minute: 29 }, p), reportDue({ date: "2026-11-04", hour: 19, minute: 30 }, p)], [false, true], "7:29 not yet, 7:30 due");
  const wk = { report_hour: 8, weekdays_only: true };
  eq(["2026-11-07", "2026-11-08", "2026-11-09"].map((date) => reportDue({ date, hour: 9, minute: 0 }, wk)), [false, false, true], "Sat, Sun no; Mon yes");
  eq(reportDue({ date: "2026-11-07", hour: 9, minute: 0 }, { report_hour: 8 }), true, "every day: Saturday too");
});

Deno.test("the reply states the exact schedule saved, quiet hours' move, and asks about midnight", async () => {
  const U = "00000000-0000-4000-8000-0000000000d1", now = Date.parse("2026-11-01T14:00:00Z");
  const W = { [WATCH_PROFILE_KEY(U)]: { type: "career_watch_profile", interests: [{ role: { terms: ["data analyst"], blockers: [] }, filters: { places: ["Chicago"] } }] } };
  const store = memoryAlertStore();
  const pre = await previewWatchAlerts({ userId: U, before: null, after: W, store, now, message: "send me new data analyst roles in Chicago every morning at 6am central" });
  eq(await store.get(U), null, "the preview writes nothing");
  eq(scheduleLine(pre), "Your job matches will come once a day, every day at 6:00 AM America/Chicago time, with no alerts in between. 6:00 AM is inside your quiet hours (10:00 PM to 7:00 AM), so it will arrive at 7:00 AM instead.", "hour, zone, quiet hours");
  const r = await syncWatchAlerts({ userId: U, before: null, after: W, store, now, message: "send me new data analyst roles in Chicago every morning at 6am central" });
  eq(r, pre, "the save writes exactly what the reply said");
  eq([(await store.get(U))?.tz, (await store.get(U))?.prefs.report_hour], [CHI, 6], "saved");
  const ev = await syncWatchAlerts({ userId: U, before: W, after: W, store, now, message: "send them every weekday evening at 7:30 instead" });
  eq(scheduleLine(ev), "Your job matches will come once a day, every weekday (Monday to Friday) at 7:30 PM America/Chicago time, with no alerts in between.", "minutes and weekdays");
  eq([(await store.get(U))?.prefs.report_hour, (await store.get(U))?.prefs.report_minute, (await store.get(U))?.prefs.weekdays_only], [19, 30, true], "saved with the minute");
  const mid = await syncWatchAlerts({ userId: U, before: W, after: W, store, now, message: "actually send them every night at midnight" });
  assert(/You asked for midnight/.test(scheduleLine(mid) ?? "") && /What time/.test(scheduleLine(mid) ?? ""), `asked: ${scheduleLine(mid)}`);
  eq((await store.get(U))?.prefs.report_hour, 19, "midnight changed nothing");
  eq(scheduleLine(await syncWatchAlerts({ userId: U, before: W, after: W, store, now, message: "I go to the gym every evening" })), null, "no schedule said: no line");
  // Midnight for someone still on instant alerts: asked, and nothing about how alerts arrive changes.
  const V = "00000000-0000-4000-8000-0000000000d2", WV = { [WATCH_PROFILE_KEY(V)]: W[WATCH_PROFILE_KEY(U)] };
  await syncWatchAlerts({ userId: V, before: null, after: WV, store, now, message: "watch for data analyst roles in Chicago" });
  const instant = (await store.get(V))?.prefs;
  eq([instant?.digest ?? false, instant?.max_instant_per_day], [false, 3], "instant alerts");
  const askV = await syncWatchAlerts({ userId: V, before: WV, after: WV, store, now, message: "send them every night at midnight" });
  assert(/You asked for midnight/.test(scheduleLine(askV) ?? ""), `asked: ${scheduleLine(askV)}`);
  eq([(await store.get(V))?.prefs.digest ?? false, (await store.get(V))?.prefs.max_instant_per_day, (await store.get(V))?.prefs.report_hour], [false, 3, instant?.report_hour], "still instant alerts: no daily message set at any hour");
});

// A service client over in-memory tables, filtering as PostgREST does (eq, in, not is null, order, limit).
function fakeAdmin(tables: Record<string, any[]>) {
  return {
    from(t: string) {
      let rows = [...(tables[t] ?? [])];
      const orders: [string, boolean][] = [];
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
        not: (c: string, op: string, v: unknown) => { if (op === "is" && v === null) rows = rows.filter((r) => r[c] != null); return q; },
        order: (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return q; },
        limit: (n: number) => { q._n = n; return q; },
        then: (res: any, rej: any) => {
          const out = [...rows].sort((a, b) => { for (const [c, asc] of orders) { if (a[c] !== b[c]) return (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1); } return 0; });
          return Promise.resolve({ data: out.slice(0, q._n ?? out.length), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

Deno.test("scope: A's \"less like 2\" reads A's own last message and never changes B's rules", async () => {
  const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b", now = Date.parse("2026-11-01T14:00:00Z");
  const v = validPrefs({ keywords: ["frontend"] });
  assert(v.ok, "prefs");
  const store = memoryAlertStore();
  for (const u of [A, B]) await store.save(startWatching(null, { userId: u, prefs: v.prefs, tz: NY, now }));
  const post = (id: string, company: string, title: string) => ({ job_id: id, company, title, location: "Chicago, IL", url: `https://boards.greenhouse.io/x/jobs/${id}` });
  const P = [post("a1", "Acme", "Frontend Intern"), post("a2", "Brite", "Frontend Intern - Angular"), post("b1", "Globex", "Frontend Intern"), post("b2", "Hooli", "Frontend Intern - Vue")];
  const msg = (ps: any[]) => ps.map((p, i) => `${i + 1}. ${p.title} at ${p.company}\n   ${p.url}`).join("\n");
  const admin = fakeAdmin({
    career_postings: P,
    career_outbox: [
      { id: 1, user_id: A, key: "report:2026-11-01", kind: "report", text: msg([P[0], P[1]]), delivered_at: "2026-11-01T13:04:00Z" },
      // B's message is the newest anyone was sent.
      { id: 2, user_id: B, key: "report:2026-11-01", kind: "report", text: msg([P[2], P[3]]), delivered_at: "2026-11-01T13:09:00Z" },
    ],
  });
  const deps = { store, ...supabaseFeedbackReads(admin) };
  const bBefore = JSON.stringify((await store.get(B))?.prefs);
  const r = await alertFeedbackTurn({ message: "less like 2", userId: A, deps });
  assert(r && r.status === "saved", JSON.stringify(r));
  assert(/Brite/.test(r.reply) && !/Hooli|Globex/.test(r.reply), `A's own message: ${r.reply}`);
  eq((await store.get(A))?.prefs.feedback?.less?.map((s) => s.company), ["Brite"], "A's rule is from A's posting 2");
  eq(JSON.stringify((await store.get(B))?.prefs), bBefore, "B's rules are untouched");
  const rb = await alertFeedbackTurn({ message: "more like 1", userId: B, deps });
  assert(rb && /Globex/.test(rb.reply), `B's own message: ${rb?.reply}`);
  eq((await store.get(A))?.prefs.feedback?.more ?? [], [], "and B's never changes A's");
});

Deno.test("any turn: the cadence changes only on the watch's own turn or a turn about their alerts", async () => {
  const U = "00000000-0000-4000-8000-0000000000c1", now = Date.parse("2026-11-01T14:00:00Z");
  const W = { [WATCH_PROFILE_KEY(U)]: { type: "career_watch_profile", interests: [{ role: { terms: ["frontend"], blockers: [] }, filters: { places: ["Chicago"] } }] } };
  const store = memoryAlertStore();
  eq((await syncWatchAlerts({ userId: U, before: null, after: W, store, now, message: "send me new frontend roles in Chicago every morning" })).action, "saved", "the watch's turn");
  eq([(await store.get(U))?.prefs.digest, (await store.get(U))?.prefs.report_hour], [true, 8], "every morning");
  for (const said of ["I go to the gym every evening", "I study every day at 7pm"]) {
    eq((await syncWatchAlerts({ userId: U, before: W, after: W, store, now, message: said })).action, "unchanged", said);
    eq((await store.get(U))?.prefs.report_hour, 8, `${said}: not about their alerts`);
  }
  eq((await syncWatchAlerts({ userId: U, before: W, after: W, store, now, message: "send them every evening instead" })).action, "saved", "about their alerts");
  eq((await store.get(U))?.prefs.report_hour, 18, "every evening");
});

Deno.test("a write that fails after the commit is told at once, in the same place, and logged; a turn that wrote nothing tells nothing", async () => {
  const U = "00000000-0000-4000-8000-0000000000e1", now = Date.parse("2026-11-01T14:00:00Z");
  const W = { [WATCH_PROFILE_KEY(U)]: { type: "career_watch_profile", interests: [{ role: { terms: ["data analyst"], blockers: [] }, filters: { places: ["Chicago"] } }] } };
  const good = memoryAlertStore();
  const failing = { ...good, save: async () => { throw new Error("db down"); } } as typeof good;
  const msg = "send me new data analyst roles in Chicago every evening at 7";
  // The handler's order: preview (before the reply), commit, then the write, whose failure goes to alertWriteFailed.
  const preview = await previewWatchAlerts({ userId: U, before: null, after: W, store: failing, now, message: msg });
  assert(/at 7:00 PM/.test(scheduleLine(preview) ?? ""), `the reply stated the schedule: ${scheduleLine(preview)}`);
  const told: string[] = [], logs: string[] = [];
  const run = (pv: typeof preview | null, store = failing) => syncWatchAlerts({ userId: U, before: null, after: W, store, now, message: msg })
    .then(() => false).catch((e) => alertWriteFailed({ error: e, preview: pv, tell: async (t) => { told.push(t); }, log: (l) => logs.push(l) }));
  eq(await run(preview), true, "told");
  eq(told, [ALERT_SAVE_FAILED_REPLY], "one follow-up, the exact words");
  assert(logs.some((l) => /db down/.test(l)), `logged: ${logs}`);
  eq(await good.get(U), null, "nothing was saved, as the follow-up says");
  // A turn that meant no write (unchanged, or no preview) is not told; a write that succeeds is not told.
  eq(await alertWriteFailed({ error: new Error("x"), preview: { action: "unchanged" }, tell: async (t) => { told.push(t); }, log: () => {} }), false, "unchanged");
  eq(await alertWriteFailed({ error: new Error("x"), preview: null, tell: async (t) => { told.push(t); }, log: () => {} }), false, "no preview");
  eq(await run(preview, good), false, "the write succeeded");
  eq(told.length, 1, "still one");
  // A follow-up that cannot be sent either is logged, never thrown into the saved turn.
  const l2: string[] = [];
  eq(await alertWriteFailed({ error: new Error("db down"), preview, tell: async () => { throw new Error("outbox down"); }, log: (l) => l2.push(l) }), false);
  assert(l2.some((l) => /outbox down/.test(l)), `logged: ${l2}`);
});

Deno.test("the follow-up goes where the turn came from: the web thread, or that channel's outbox, due now", async () => {
  const rows: Record<string, any[]> = { agent_messages: [], career_outbox: [] };
  const admin = { from: (t: string) => ({ insert: async (r: any) => { rows[t].push(r); return { error: null }; } }) };
  const now = () => Date.parse("2026-11-01T14:00:00Z");
  await supabaseTellAfterTurn(admin, { userId: "u", threadId: "t1", channel: "web", key: "alert-save-failed:k1", now })(ALERT_SAVE_FAILED_REPLY);
  await supabaseTellAfterTurn(admin, { userId: "u", threadId: "t1", channel: "telegram", key: "alert-save-failed:k2", now })(ALERT_SAVE_FAILED_REPLY);
  await supabaseTellAfterTurn(admin, { userId: "u", threadId: "t1", channel: "sms", key: "alert-save-failed:k3", now })(ALERT_SAVE_FAILED_REPLY);
  eq(rows.agent_messages.map((r) => [r.thread_id, r.role, r.content]), [["t1", "assistant", ALERT_SAVE_FAILED_REPLY]], "web: the thread");
  eq(rows.career_outbox.map((r) => [r.key, r.kind, r.channel, r.deliver_at, r.text]), [
    ["status:alert-save-failed:k2", "status", "telegram", "2026-11-01T14:00:00.000Z", ALERT_SAVE_FAILED_REPLY],
    ["status:alert-save-failed:k3", "status", null, "2026-11-01T14:00:00.000Z", ALERT_SAVE_FAILED_REPLY]], "a channel: its outbox, now");
});
