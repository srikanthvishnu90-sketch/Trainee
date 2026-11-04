// F7 (2026-10-25): job alerts ranked by fit, with a fit floor, under the person's own caps and quiet hours.
// The planner (career_alerts.ts planProactive) spends the day's room on the best fits first (search's fitOf, 121 scoreFit
// over the person's confirmed facts, from the scoring profile on their watch record), never alerts a posting the person's
// confirmed facts are knocked out of, and honours a min_fit the person set; the run (career_proactive_run.ts runAlerts)
// reads the postings whole for the score and checks the floor again at the moment of queuing.
// Run: deno test -A --no-check tests/architect/f07-alert-fit.test.ts
import { type AlertFit, type AlertPrefs, fitFloorOk, planProactive, type PlanUser } from "../../supabase/functions/_shared/career_alerts.ts";
import { memoryAlertStore, validPrefs } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runAlerts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { interestsFromWatch } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import { alertFits } from "../../supabase/functions/_shared/career_alert_fit.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
// 2026-10-19 15:00 UTC = 11:00 in New York.
const NOW = Date.UTC(2026, 9, 19, 15);
const iso = (ms: number) => new Date(ms).toISOString();
const posting = (id: string, title: string, minsAgo: number, extra: Record<string, unknown> = {}) =>
  ({ job_id: `greenhouse:acme:${id}`, title, company: "Acme", location: "New York, NY", url: `https://boards.greenhouse.io/acme/jobs/${id}`, first_seen_at: iso(NOW - minsAgo * 60000), posted_at: iso(NOW - minsAgo * 60000), closed_at: null, ...extra });
const prefs = (p: Partial<AlertPrefs> = {}): AlertPrefs => ({ on: true, keywords: ["data analyst"], locations: ["new york"], remote_ok: true, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 2, ...p });
const user = (p: Partial<PlanUser> = {}): PlanUser => ({ id: "u1", tz: "America/New_York", prefs: prefs(), last_checked_at: iso(NOW - 60 * 60000), instant_sent_today: 0, last_report_on: "2026-10-19", sent_this_week: 0, ...p });
const fit = (score: number | null, excluded = false): AlertFit => ({ score, excluded, reasons: [] });
const alerts = (plan: ReturnType<typeof planProactive>) => plan.filter((p) => p.kind === "alert").map((p) => (p as any).job_id.split(":").pop());
const held = (plan: ReturnType<typeof planProactive>) => plan.filter((p) => p.kind === "held").map((p) => (p as any).job_id.split(":").pop());

Deno.test("F7/1 the day's room goes to the best fits first; the rest are held for the report; without fits, freshest first as before", () => {
  const ps = [posting("a", "Data Analyst", 5), posting("b", "Data Analyst II", 20), posting("c", "Data Analyst, Growth", 40)];
  const fits = new Map([["u1", new Map([["greenhouse:acme:a", fit(30)], ["greenhouse:acme:b", fit(80)], ["greenhouse:acme:c", fit(55)]])]]);
  const ranked = planProactive({ users: [user()], postings: ps, now: NOW, fits });
  eq(alerts(ranked), ["b", "c"], "best fit first, within the person's cap of 2");
  eq(held(ranked), ["a"], "the lowest fit is held, not dropped");
  const plain = planProactive({ users: [user()], postings: ps, now: NOW });
  eq(alerts(plain), ["a", "b"], "no fits: freshest first (unchanged)");
  // An unscored posting ranks after every scored one.
  const partial = new Map([["u1", new Map([["greenhouse:acme:c", fit(10)]])]]);
  eq(alerts(planProactive({ users: [user()], postings: ps, now: NOW, fits: partial })), ["c", "a"], "scored before unscored, then freshest");
});

Deno.test("F7/2 the fit floor: a knockout is never news, alert or report; min_fit holds back what is under it, and what has no fit to show", () => {
  const ps = [posting("a", "Data Analyst", 5), posting("b", "Data Analyst II", 20), posting("c", "Data Analyst, Growth", 40)];
  const fits = new Map([["u1", new Map([["greenhouse:acme:a", fit(null, true)], ["greenhouse:acme:b", fit(70)], ["greenhouse:acme:c", fit(40)]])]]);
  // Report hour reached and no report yet today: the report lists the day's matches, never the knockout.
  const plan = planProactive({ users: [user({ last_report_on: null, prefs: prefs({ max_instant_per_day: 3 }) })], postings: ps, now: NOW, fits });
  eq(alerts(plan), ["b", "c"], "the knockout is not alerted");
  const report = plan.find((p) => p.kind === "report") as any;
  assert(report && /2 matches/.test(report.text) && !/greenhouse\.io\/acme\/jobs\/a\b/.test(report.text), `the report leaves the knockout out: ${report?.text}`);
  const floored = planProactive({ users: [user({ prefs: prefs({ max_instant_per_day: 3, min_fit: 50 }) })], postings: ps, now: NOW, fits });
  eq(alerts(floored), ["b"], "min_fit 50: only the 70");
  eq(held(floored), [], "under the floor is not held for the report either");
  const unknown = planProactive({ users: [user({ prefs: prefs({ min_fit: 10 }) })], postings: ps, now: NOW });
  eq(alerts(unknown), [], "min_fit set and no fit to show: nothing is alerted on a guess");
  assert(fitFloorOk(undefined, {}) && fitFloorOk(fit(0), {}) && !fitFloorOk(fit(null, true), {}) && !fitFloorOk(fit(null), { min_fit: 0 }), "the floor's rule");
});

Deno.test("F7/3 caps and quiet hours still come from the person's own settings, with fit ranking on", () => {
  const ps = [posting("a", "Data Analyst", 5), posting("b", "Data Analyst II", 6)];
  const fits = new Map([["u1", new Map([["greenhouse:acme:a", fit(20)], ["greenhouse:acme:b", fit(90)]])]]);
  eq(alerts(planProactive({ users: [user({ prefs: prefs({ max_instant_per_day: 1 }) })], postings: ps, now: NOW, fits })), ["b"], "a cap of 1: the best fit");
  eq(alerts(planProactive({ users: [user({ instant_sent_today: 2 })], postings: ps, now: NOW, fits })), [], "today's room used up: held");
  eq(alerts(planProactive({ users: [user({ sent_this_week: 15 })], postings: ps, now: NOW, fits })), ["b", "a"], "no weekly cap: 15 already this week changes nothing");
  // 11:00 in New York is inside quiet hours 9 to 12: the alert waits for 12:00 New York (16:00Z).
  const quiet = planProactive({ users: [user({ prefs: prefs({ quiet_start: 9, quiet_end: 12 }) })], postings: ps, now: NOW, fits }).filter((p) => p.kind === "alert");
  eq(quiet.map((p) => (p as any).at), [Date.UTC(2026, 9, 19, 16), Date.UTC(2026, 9, 19, 16)], "moved to the end of the person's quiet hours");
});

Deno.test("F7/4 min_fit is checked like every other setting: whole numbers 0 to 100; null clears it; left out keeps it", () => {
  const ok = validPrefs({ keywords: ["data analyst"], min_fit: 60 });
  assert(ok.ok && ok.prefs.min_fit === 60, JSON.stringify(ok));
  for (const bad of [101, -1, 4.5, "x"]) assert(!validPrefs({ keywords: ["x"], min_fit: bad }).ok, `refused: ${bad}`);
  const kept = validPrefs({ keywords: ["sql"] }, prefs({ min_fit: 40 }));
  assert(kept.ok && kept.prefs.min_fit === 40, "kept");
  const cleared = validPrefs({ keywords: ["sql"], min_fit: null }, prefs({ min_fit: 40 }));
  assert(cleared.ok && !("min_fit" in cleared.prefs), "cleared");
});

// A person's watch record as 152 keeps it, with the scoring profile the router builds from their confirmed facts.
const RECORD = {
  type: "career_watch_profile", version: 1, user_id: "u1",
  interests: [{ interest_id: "int-data-analyst", role: { title: "data analyst", terms: ["data analyst"], blockers: ["senior"] }, filters: { locations: ["new york"], remote_ok: true, bands: [], firms_include: [], firms_exclude: [] } }],
  opt_out: { global: false, companies: [] },
  scoring_profile: {
    skills: [{ name: "SQL", proven: true }, { name: "Python", proven: true }, { name: "Tableau", proven: true }],
    degree: "BS Economics", level: "", experience_years: 2, experience_text: "data analyst sql python tableau dashboards reporting", summary: "",
    constraints: { work_authorization: "", needs_sponsorship: false, clearance: null, locations: [] },
    preferences: { role_families: [], roles: [], locations: [], starred_companies: [], excluded_companies: [] }, location: "New York, NY",
  },
};

Deno.test("F7/5 the run: scored from the watch record's confirmed facts over the whole posting; the best fit is queued; a clearance knockout never is", async () => {
  const store = memoryAlertStore();
  await store.save({ id: "u1", tz: "America/New_York", prefs: { ...prefs({ max_instant_per_day: 1 }), interests: interestsFromWatch(RECORD) }, last_checked_at: iso(NOW - 60 * 60000), instant_sent_today: 0, sent_on: "2026-10-19", last_report_on: "2026-10-19", held: [] });
  const whole: Record<string, any> = {
    "greenhouse:acme:1": posting("1", "Data Analyst", 5, { description: "Reporting in Excel." }),
    "greenhouse:acme:2": posting("2", "Data Analyst", 30, { description: "SQL, Python and Tableau dashboards for reporting." }),
    "greenhouse:acme:3": posting("3", "Data Analyst", 2, { description: "SQL and Python. Requires an active TS/SCI security clearance." }),
  };
  // The new-postings list carries no description (career_ingest.ts LIST_COLUMNS); the run reads the matching ones whole.
  const list = Object.values(whole).map(({ description: _d, ...p }) => p);
  const asked: string[][] = [];
  const stats = await runAlerts({
    store, outbox: store, now: NOW,
    recentPostings: async () => list,
    postingsById: async (ids) => { asked.push(ids); return ids.map((i) => whole[i]).filter(Boolean); },
    watches: async () => new Map([["u1", RECORD]]),
  });
  assert(asked.some((ids) => ids.includes("greenhouse:acme:2")), `the matching postings were read whole: ${JSON.stringify(asked)}`);
  eq(store.dump().outbox.map((o) => o.key), ["alert:greenhouse:acme:2"], `the SQL/Python/Tableau posting is the one alert (stats ${JSON.stringify(stats)})`);
  eq(store.dump().rows.u1.held, ["greenhouse:acme:1"], "the weaker fit is held for the report; the clearance knockout is not");
  assert((stats.fit_scored ?? 0) === 3, `three scored: ${stats.fit_scored}`);
  // The same run with no scoring profile on the record: freshest first, as before, and the knockout cannot be known.
  const store2 = memoryAlertStore({ rows: { u1: store.dump().rows.u1 }, outbox: [] });
  await store2.save({ ...store.dump().rows.u1, last_checked_at: iso(NOW - 60 * 60000), instant_sent_today: 0, held: [] });
  await runAlerts({ store: store2, outbox: store2, now: NOW, recentPostings: async () => list, postingsById: async (ids) => ids.map((i) => whole[i]),
    watches: async () => new Map([["u1", { ...RECORD, scoring_profile: null }]]) });
  eq(store2.dump().outbox.map((o) => o.key), ["alert:greenhouse:acme:3"], "no confirmed facts on record: freshest first");
});

Deno.test("F7/6 a read of whole postings that fails scores the list rows; nothing throws, the person's match still decides what can be sent", async () => {
  const p = posting("9", "Data Analyst", 5);
  const users = [{ id: "u1", prefs: { ...prefs(), interests: interestsFromWatch(RECORD) } }];
  const fits = await alertFits({ users, postings: [p], profiles: new Map([["u1", RECORD.scoring_profile]]), full: async () => { throw new Error("down"); } });
  const f = fits.get("u1")?.get(p.job_id);
  assert(f && f.excluded === false && typeof f.score === "number", JSON.stringify(f));
  const none = await alertFits({ users, postings: [p], profiles: new Map() });
  eq(none.size, 0, "no scoring profile: no fits");
});
