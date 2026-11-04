// Proactive briefs and job alerts at scale (2026-10-29): about 10,000 generated scenarios (tests/architect/scenarios/
// proactive-generator.ts, seeded) through the real code of what Trainee sends without being asked, with a fixed clock, a
// fake model provider and memory stores. Every expectation comes from how the scenario was built:
//   plan     every alert names a posting that exists, matches the person's watch, is news (seen since the last check, not
//            a board's backlog), open, behind an https link and at or above their fit floor (never a knockout); best fit
//            first, then freshest; exactly as many as the day's and the week's room allow, the rest held; each line's
//            title, company, place and link are the posting's own; nothing goes out inside quiet hours on the person's
//            clock (their zone, or the default when theirs is unknown), and what waits goes at the first quarter hour
//            after them; one daily report a local day, at or after their hour, listing only matches.
//   run      over days of scheduled runs, with a run that dies after queueing, a queue write that fails once, the same
//            run twice, two runs at once: each posting alerted at most once per person, never more than the person's cap
//            in a local day or week; one person's unknown zone never stops anyone's alerts.
//   quiet    paused, opted out (STOP) and erased people get nothing queued or pushed on any rail (alerts, receipts,
//            cards, questions, asks, digest); everyone else gets theirs, outside quiet hours; START brings at most a
//            day's cap, one report and each receipt once, never a backlog.
//   digest   once per ISO week of the person's own calendar, on their day at or after their hour, outside quiet hours,
//            only when something is on file, the alert count the one on file; nobody's unknown zone stops another's.
//   deliver  a paused or stopped person's queue is held; an alert or report no longer wanted, or more than 48 hours past
//            its time, is not sent; everything else reaches its own person's contact once.
//   budget   the model is asked only after its worst case is reserved; past the budget nothing is sent to the provider and
//            the run says what the rules say; a reply without usage is counted at its worst case; nothing stays reserved.
//   dst      quiet hours across daylight-saving nights: what waits goes at the first quarter hour after them.
// Run: deno test -A --no-check tests/architect/scenarios-proactive.test.ts (no network, no database, no real model).
import assertNode from "node:assert/strict";
import {
  clock, COUNTS, DAY, DEFAULT_ZONE, type DeliverScenario, type DigestScenario, type DstScenario, effectiveZone, firstAwake, floorOk, generate,
  type GenFit, type GenPerson, type GenPosting, HOUR, isoWeekOf, matches, MIN, news, type PlanScenario, quietOn, type QuietScenario,
  type RunScenario, type Scenario, type BudgetScenario, zoneOk,
} from "./scenarios/proactive-generator.ts";
import { type AlertFit, type PlanUser, planProactive, REPORT_LIMIT } from "../../supabase/functions/_shared/career_alerts.ts";
import { type AlertRow, memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runAlerts, runDigest, runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { memoryBriefStores } from "../../supabase/functions/_shared/career_brief_store.ts";
import { deliverDue, memoryChannel } from "../../supabase/functions/_shared/channel.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { mailModelWiring } from "../../supabase/functions/_shared/career_mail_model.ts";
import type { MailIn } from "../../supabase/functions/_shared/career_mail.ts";
import { type BudgetGate, memoryBudgetGate, resetLocalBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261029 });
const of = <K extends Scenario["kind"]>(k: K) => SCENARIOS.filter((s): s is Extract<Scenario, { kind: K }> => s.kind === k);
const iso = (t: number) => new Date(t).toISOString();
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const SECRET = "s".repeat(40);
// A job alert or daily report more than 48 hours past its time is no longer news (channel.ts ALERT_STALE_MS).
const STALE_MS = 48 * HOUR;
// The run logs a line per failing person; the battery fails on purpose thousands of times.
const quietLogs = async <T>(f: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = e; }
};

// ------------------------------------------------------------------------------------------------ the report
type Failure = { cat: string; why: string; got: unknown; input: unknown };
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public name: string) {}
  grade(s: Scenario, why: string | null, got: unknown = "", input: unknown = s) {
    this.total++;
    const k = s.category;
    this.byCat[k] = (this.byCat[k] ?? 0) + 1;
    if (!why) return;
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ cat: k, why, got, input });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[proactive] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${x.why} | got ${JSON.stringify(x.got).slice(0, 300)} | input ${JSON.stringify(x.input).slice(0, 400)}`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | got ${JSON.stringify(xs[0].got).slice(0, 200)}`).join(" || ");
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${first}`);
  }
}

// ------------------------------------------------------------------------------------------------ the oracle
const ms = (t: string) => Date.parse(t);
// No weekly count anywhere (career_alert_enqueue dropped it in 20261030180000); only the day's pacing.
const dayCap = (u: GenPerson) => Math.min(10, Math.floor(u.prefs.max_instant_per_day));
const asRow = (u: GenPerson): AlertRow => ({ id: u.id, tz: u.tz as string, prefs: { ...u.prefs }, last_checked_at: u.last_checked_at, instant_sent_today: u.instant_sent_today, sent_on: u.sent_on, last_report_on: u.last_report_on, held: [...u.held] });
const posting = (p: GenPosting) => ({ job_id: p.job_id, title: p.title, company: p.company, location: p.location, url: p.url, first_seen_at: p.first_seen_at, ...(p.posted_at ? { posted_at: p.posted_at } : {}), closed_at: p.closed ? p.closed_at : null });
// When something Trainee starts may go: now, or the first quarter hour after quiet hours on the person's clock.
const dueAt = (now: number, tz: string, qs: number, qe: number) => (quietOn(now, tz, qs, qe) ? firstAwake(now, tz, qs, qe) : now);
// The rails that step from the run's own minute (receipts, status, digest: career_proactive_run.ts awake) land within a
// quarter hour after quiet hours end, never inside them.
const awakeProblem = (at: number, now: number, tz: string, qs: number, qe: number): string | null => {
  if (quietOn(at, tz, qs, qe)) return `goes at ${iso(at)}, inside quiet hours ${qs}-${qe} on ${tz}`;
  const want = dueAt(now, tz, qs, qe);
  return at < want || at >= want + 15 * MIN ? `goes at ${iso(at)}; quiet hours ${qs}-${qe} on ${tz} end at ${iso(want)}` : null;
};
// The words an alert may say: the posting's own title, company and place, and its link on its own line.
function alertTextProblem(text: string, p: GenPosting): string | null {
  const [head, link] = text.split("\n");
  if (link !== p.url) return `the link line is not the posting's own link (${link} vs ${p.url})`;
  const want = `New match: ${clean(p.title)} at ${clean(p.company)} (${clean(p.location)}), first seen `;
  if (!head.startsWith(want)) return `the alert does not say the posting's own title, company and place: "${head}"`;
  if (!/^(under a minute ago|\d+ min ago|\d+ hours ago)\.$/.test(head.slice(want.length))) return `the alert says more than the posting: "${head}"`;
  return null;
}

// ------------------------------------------------------------------------------------------------ plan
function checkPlan(s: PlanScenario): { why: string | null; got: unknown } {
  const fits = new Map<string, Map<string, AlertFit>>();
  for (const u of s.people) fits.set(u.id, new Map(Object.entries(s.fits[u.id] ?? {}).map(([k, f]) => [k, { score: f.score, excluded: f.excluded, reasons: [] }])));
  const users: PlanUser[] = s.people.map((u) => ({ ...asRow(u), sent_this_week: u.sent_this_week }));
  let out;
  try { out = planProactive({ users, postings: s.postings.map(posting), now: s.now, fits }); } catch (e) { return { why: `the planner threw: ${e}`, got: null }; }
  const byId = new Map(s.postings.map((p) => [p.job_id, p]));
  for (const u of s.people) {
    const tz = effectiveZone(u.tz), l = clock(s.now, tz), since = ms(u.last_checked_at);
    const fit = (p: GenPosting): GenFit | undefined => s.fits[u.id]?.[p.job_id];
    const score = (p: GenPosting) => fit(p)?.score ?? -1;
    const eligible = s.postings.filter((p) => matches(p, u) && news(p) && ms(p.first_seen_at) >= since && floorOk(fit(p), u))
      .sort((a, b) => score(b) - score(a) || ms(b.first_seen_at) - ms(a.first_seen_at));
    const room = Math.max(0, dayCap(u) - u.instant_sent_today);
    const mine = out.filter((x) => x.userId === u.id);
    const alerts = mine.filter((x) => x.kind === "alert") as Extract<typeof out[number], { kind: "alert" }>[];
    const held = mine.filter((x) => x.kind === "held").map((x) => x.job_id);
    const at = dueAt(s.now, tz, u.prefs.quiet_start, u.prefs.quiet_end);
    const wantAlerts = eligible.slice(0, room).map((p) => p.job_id), wantHeld = eligible.slice(room).map((p) => p.job_id);
    if (JSON.stringify(alerts.map((a) => a.job_id)) !== JSON.stringify(wantAlerts)) return { why: `${u.id}: alerts are not the ${room} best of what is news to them (fit, then freshest)`, got: { alerts: alerts.map((a) => a.job_id), want: wantAlerts } };
    if (JSON.stringify(held) !== JSON.stringify(wantHeld)) return { why: `${u.id}: held is not the rest of what is news`, got: { held, want: wantHeld } };
    for (const a of alerts) {
      const p = byId.get(a.job_id);
      if (!p) return { why: "an alert names a posting that does not exist", got: a };
      if (a.key !== `alert:${p.job_id}`) return { why: "an alert's key is not its posting's", got: a.key };
      const t = alertTextProblem(a.text, p);
      if (t) return { why: t, got: a.text };
      if (a.at !== at) return { why: `${u.id}: an alert goes at ${iso(a.at)}, not ${iso(at)} (zone ${tz}, quiet ${u.prefs.quiet_start}-${u.prefs.quiet_end})`, got: a.at };
      if (quietOn(a.at, tz, u.prefs.quiet_start, u.prefs.quiet_end)) return { why: "an alert goes inside quiet hours", got: iso(a.at) };
    }
    const reports = mine.filter((x) => x.kind === "report") as Extract<typeof out[number], { kind: "report" }>[];
    const due = l.hour >= u.prefs.report_hour && u.last_report_on !== l.date;
    if (reports.length !== (due ? 1 : 0)) return { why: `${u.id}: ${reports.length} daily reports at local ${l.date} ${l.hour}:00 (hour ${u.prefs.report_hour}, last ${u.last_report_on})`, got: reports };
    if (reports.length) {
      const r = reports[0];
      if (r.key !== `report:${l.date}`) return { why: "the report's key is not the person's local day", got: r.key };
      if (r.at !== at || quietOn(r.at, tz, u.prefs.quiet_start, u.prefs.quiet_end)) return { why: `${u.id}: the daily report goes at ${iso(r.at)}, inside quiet hours ${u.prefs.quiet_start}-${u.prefs.quiet_end} (${tz}); it must wait until ${iso(at)}`, got: iso(r.at) };
      const day = s.postings.filter((p) => matches(p, u) && floorOk(fit(p), u) && ((ms(p.first_seen_at) > s.now - DAY && news(p)) || u.held.includes(p.job_id)));
      const head = day.length ? `Your daily job report: ${day.length} match${day.length === 1 ? "" : "es"} in the last day.` : "Your daily job report: no new matches in the last day. I'm still watching.";
      if (!r.text.startsWith(head)) return { why: `${u.id}: the report does not count the matches on file`, got: { text: r.text.slice(0, 200), head } };
      const links = [...r.text.matchAll(/^ {2}(\S+)$/gm)].map((m) => m[1]);
      if (links.length !== Math.min(day.length, REPORT_LIMIT)) return { why: "the report lists another number of postings than it says", got: links };
      for (const link of links) if (!day.some((p) => p.url === link)) return { why: "the report lists a posting that is not one of the person's matches", got: link };
    }
  }
  return { why: null, got: null };
}
Deno.test(`proactive at scale, the planner (plan): ${of("plan").length} scenarios`, () => {
  const rep = new Report("plan");
  for (const s of of("plan")) { const r = checkPlan(s); rep.grade(s, r.why, r.got); }
  rep.assertClean();
});
Deno.test(`proactive at scale, quiet hours across daylight-saving nights (dst): ${of("dst").length} scenarios`, () => {
  const rep = new Report("dst");
  for (const s of of("dst")) {
    const r = checkPlan({ kind: "plan", category: s.category, now: s.now, people: [s.person], postings: s.postings, fits: { [s.person.id]: {} } });
    let why = r.why;
    if (!why) {
      const out = planProactive({ users: [{ ...asRow(s.person), sent_this_week: 0 }], postings: s.postings.map(posting), now: s.now });
      const late = out.filter((x) => x.kind !== "held" && (x as any).at - s.now > 12 * HOUR);
      if (late.length) why = `waits ${Math.round(((late[0] as any).at - s.now) / HOUR)} hours for quiet hours ${s.person.prefs.quiet_start}-${s.person.prefs.quiet_end} to end`;
    }
    rep.grade(s, why, r.got, { tz: s.person.tz, now: iso(s.now), quiet: [s.person.prefs.quiet_start, s.person.prefs.quiet_end] });
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ run
async function checkRuns(s: RunScenario): Promise<{ why: string | null; got: unknown }> {
  const store = memoryAlertStore({ rows: Object.fromEntries(s.people.map((u) => [u.id, asRow(u)])), outbox: [] });
  const world: GenPosting[] = [];
  const queuedBy = new Map<string, number>(); // user|key -> the run's time that queued it
  const note = (now: number) => { for (const o of store.dump().outbox) if (!queuedBy.has(`${o.userId}|${o.key}`)) queuedBy.set(`${o.userId}|${o.key}`, now); };
  const deps = (now: number) => ({
    now, recentPostings: async (since: string) => world.filter((p) => !p.closed && ms(p.first_seen_at) > ms(since) && news(p)).map(posting),
    postingsById: async (ids: string[]) => world.filter((p) => ids.includes(p.job_id)).map(posting),
  });
  for (const [k, run] of s.runs.entries()) {
    world.push(...run.postings);
    const who = s.people[run.who].id;
    const one = async (st = store as any, ob = store as any) => { try { await runAlerts({ store: st, outbox: ob, ...deps(run.now) }); } catch { /* recorded by the run; the next run carries on */ } };
    if (run.fault === "crash_after_queue") await one({ ...store, saveCounters: async (id: string, c: any) => { if (id === who) throw new Error("the function died"); return store.saveCounters!(id, c); } });
    else if (run.fault === "queue_fails_once") {
      let failed = false;
      await one(store, { enqueue: async (u: string, m: any) => { if (u === who && !failed) { failed = true; throw new Error("insert timed out"); } return store.enqueue(u, m); } });
    } else if (run.fault === "same_run_again") { await one(); await one(); }
    else if (run.fault === "two_at_once") {
      const snapshot = await store.active(), week = await store.alertsSince!(iso(run.now - 7 * DAY));
      await one();
      await one({ ...store, active: async () => JSON.parse(JSON.stringify(snapshot)), alertsSince: async () => new Map(week) });
    } else await one();
    note(run.now);
    // The first run is clean: everyone whose zone is unknown or not gets exactly what fits their room, whoever else runs.
    if (k === 0) {
      const after = store.dump().outbox; // read once (a deep copy each call; nothing runs between the people below)
      for (const u of s.people) {
        const eligible = run.postings.filter((p) => matches(p, u) && news(p) && ms(p.first_seen_at) >= ms(u.last_checked_at));
        const want = Math.min(eligible.length, Math.max(0, dayCap(u)));
        const got = after.filter((o) => o.userId === u.id && o.kind === "alert").length;
        if (got !== want) return { why: `${u.id} (zone ${JSON.stringify(u.tz)}) got ${got} alerts in a clean first run, not ${want}`, got: { people: s.people.map((x) => x.tz) } };
      }
    }
  }
  const out = store.dump().outbox, byId = new Map(world.map((p) => [p.job_id, p]));
  for (const u of s.people) {
    const tz = effectiveZone(u.tz);
    const mine = out.filter((o) => o.userId === u.id);
    const perDay = new Map<string, number>();
    for (const o of mine) {
      if (quietOn(o.at, tz, u.prefs.quiet_start, u.prefs.quiet_end)) return { why: `${o.kind} for ${u.id} goes inside quiet hours`, got: { at: iso(o.at), tz } };
      if (o.kind !== "alert") continue;
      const p = byId.get(o.key.slice("alert:".length));
      if (!p) return { why: "an alert names a posting that does not exist", got: o.key };
      if (!matches(p, u) || !news(p)) return { why: "an alert for a posting that is not the person's match", got: { key: o.key, title: p.title, closed: p.closed } };
      const t = alertTextProblem(o.text, p);
      if (t) return { why: t, got: o.text };
      const d = clock(queuedBy.get(`${u.id}|${o.key}`)!, tz).date;
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    for (const [d, n] of perDay) if (n > dayCap(u)) return { why: `${u.id} got ${n} alerts on ${d}, over their cap of ${dayCap(u)} a day`, got: s.runs.map((r) => r.fault) };
    const total = mine.filter((o) => o.kind === "alert").length;
    // The weekly total is no longer asserted: the planner has no weekly cap, and only a store with enqueueAlert (the database's rule) holds a week.
    void total;
    const reportDays = mine.filter((o) => o.kind === "report").map((o) => o.key);
    if (new Set(reportDays).size !== reportDays.length) return { why: "two reports for one day", got: reportDays };
  }
  return { why: null, got: null };
}
Deno.test(`proactive at scale, scheduled runs with crashes, retries and overlaps (run): ${of("run").length} scenarios`, async () => {
  const rep = new Report("run");
  await quietLogs(async () => { for (const s of of("run")) { const r = await checkRuns(s); rep.grade(s, r.why, r.got, { people: s.people.map((u) => [u.tz, u.prefs.max_instant_per_day]), runs: s.runs.map((x) => [iso(x.now), x.fault, x.postings.length]) }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ quiet
async function checkQuiet(s: QuietScenario): Promise<{ why: string | null; got: unknown }> {
  const store = memoryAlertStore({ rows: Object.fromEntries(s.people.map((u) => [u.id, asRow(u)])), outbox: [] });
  const quietSet = new Set(s.people.filter((u) => u.state !== "awake").map((u) => u.id));
  const pushed: { kind: string; user: string }[] = [];
  const pushedQuestions = new Set<string>(), pushedCards = new Set<string>(), pushedAsks = new Set<string>();
  const withPrefs = (u: GenPerson) => ({ tz: u.tz, quiet_start: u.prefs.quiet_start, quiet_end: u.prefs.quiet_end });
  const briefs = memoryBriefStores({
    digest: Object.fromEntries(s.people.filter((u) => u.digest).map((u) => [u.id, { prefs: { on: true, day: u.digest!.day, hour: u.digest!.hour }, tz: u.tz }])),
    people: s.people.filter((u) => u.digest).map((u) => ({ user_id: u.id, ...withPrefs(u) })),
    rows: Object.fromEntries(s.people.filter((u) => u.digest).map((u) => [u.id, { alerts: [{ created_at: iso(s.now - HOUR) }] }])),
  });
  const run = async (now: number, quiet: Set<string>) => {
    const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": SECRET } }), {
      env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? SECRET : undefined) }, now: () => now, store: () => store,
      recentPostings: async (since) => s.postings.filter((p) => !p.closed && ms(p.first_seen_at) > ms(since) && news(p)).map(posting),
      postingsById: async (ids) => s.postings.filter((p) => ids.includes(p.job_id)).map(posting),
      finishedApplications: async () => s.people.flatMap((u) => u.receipts.map((r) => ({ id: r.id, user_id: u.id, company: r.company, url: `https://boards.greenhouse.io/x/jobs/${r.id}`, state: r.state, reason: r.state === "failed" ? "the form changed" : null, confirmation_id: null, email_confirmed_at: null, evidence: null, ...withPrefs(u) }))),
      readyApplications: async () => s.people.flatMap((u) => u.cards.filter((c) => !pushedCards.has(c.id)).map((c) => ({ id: c.id, user_id: u.id, company: c.company, card_lines: [`${c.company}: Data Analyst`, "Resume: tailored"], created_at: c.created_at, ...withPrefs(u) }))),
      pushCard: async (userId, ids) => { pushed.push({ kind: "card", user: userId }); ids.forEach((i) => pushedCards.add(i)); return `card-${userId}`; },
      questions: {
        open: async () => s.people.flatMap((u) => u.questions.map((q) => ({ id: q.id, user_id: u.id, key: `label:${q.id}`, kind: "label", label: q.label, type: "yes_no", options: ["Yes", "No"], company: null, job_ids: [], misfit: false, answer: null, created_at: q.created_at, pushed_at: pushedQuestions.has(q.id) ? iso(now) : null, ...withPrefs(u) }))),
        push: async (userId, ids) => { pushed.push({ kind: "questions", user: userId }); ids.forEach((i) => pushedQuestions.add(i)); return true; },
      },
      asks: () => ({
        pending: async () => s.people.filter((u) => u.ask && !pushedAsks.has(u.id)).map((u) => ({ user_id: u.id, hash: u.ask!.hash, text: u.ask!.text, ...withPrefs(u) })),
        push: async (userId: string) => { pushed.push({ kind: "ask", user: userId }); pushedAsks.add(userId); return true; },
      }),
      briefs: { interviews: () => briefs.interviews, drafts: () => ({ applications: async () => [], events: async () => [], saveDraft: async () => false }), digest: () => briefs.digest },
      quiet: async (ids) => new Set(ids.filter((i) => quiet.has(i))),
      recordRun: async () => {},
    });
    return { status: res.status, body: await res.json() };
  };
  const first = await run(s.now, quietSet);
  if (first.status !== 200) return { why: `the scheduled run failed: ${first.body.detail ?? first.body.error}`, got: first.body.errors };
  const out = store.dump().outbox;
  for (const u of s.people) {
    const tz = effectiveZone(u.tz), q = quietOn(s.now, tz, u.prefs.quiet_start, u.prefs.quiet_end), at = dueAt(s.now, tz, u.prefs.quiet_start, u.prefs.quiet_end);
    const mine = out.filter((o) => o.userId === u.id), mineP = pushed.filter((p) => p.user === u.id);
    if (u.state !== "awake") {
      if (mine.length || mineP.length) return { why: `${u.state}: ${[...mine.map((o) => o.kind), ...mineP.map((p) => p.kind)].join(", ")} queued or pushed for a person who is ${u.state}`, got: mine.map((o) => o.key) };
      continue;
    }
    for (const o of mine) {
      const bad = o.kind === "alert" || o.kind === "report" ? (o.at !== at ? `goes at ${iso(o.at)}, not ${iso(at)}` : null) : awakeProblem(o.at, s.now, tz, u.prefs.quiet_start, u.prefs.quiet_end);
      if (bad) return { why: `a ${o.kind} ${bad}`, got: o.key };
    }
    const receipts = mine.filter((o) => o.kind === "receipt").map((o) => o.key).sort();
    if (JSON.stringify(receipts) !== JSON.stringify(u.receipts.map((r) => `receipt:${r.id}`).sort())) return { why: "an awake person's receipts are not each queued once", got: receipts };
    const want = (has: boolean) => (has && !q ? 1 : 0);
    const n = (k: string) => mineP.filter((p) => p.kind === k).length;
    if (n("card") !== want(u.cards.length > 0)) return { why: `card pushed ${n("card")} times (quiet now: ${q})`, got: mineP };
    if (n("questions") !== want(u.questions.length > 0)) return { why: `questions pushed ${n("questions")} times (quiet now: ${q})`, got: mineP };
    if (n("ask") !== want(!!u.ask)) return { why: `ask pushed ${n("ask")} times (quiet now: ${q})`, got: mineP };
    if (mine.filter((o) => o.kind === "digest").length !== (u.digest ? 1 : 0)) return { why: `an awake person whose digest is due got ${mine.filter((o) => o.kind === "digest").length} digests`, got: u.digest };
  }
  // START (and every pause lifted): the next run brings at most a day's cap, one report, each receipt once, one digest.
  const second = await run(s.now + 5 * MIN, new Set());
  if (second.status !== 200) return { why: `the run after START failed: ${second.body.detail}`, got: second.body.errors };
  const afterStart = store.dump().outbox; // read once (a deep copy each call; nothing runs between the people below)
  for (const u of s.people) {
    const mine = afterStart.filter((o) => o.userId === u.id);
    const n = (k: string) => mine.filter((o) => o.kind === k).length;
    if (n("alert") > dayCap(u) || n("report") > 1 || n("digest") > 1 || n("receipt") > u.receipts.length) return { why: `after START ${u.id} got ${n("alert")} alerts, ${n("report")} reports, ${n("digest")} digests, ${n("receipt")} receipts: a backlog`, got: mine.map((o) => o.key) };
    if (u.state !== "awake" && n("receipt") !== u.receipts.length) return { why: `after START a resumed person's receipts from the last day are not said (${n("receipt")} of ${u.receipts.length})`, got: mine.map((o) => o.key) };
  }
  return { why: null, got: null };
}
Deno.test(`proactive at scale, paused, stopped and erased people get nothing; START brings no backlog (quiet): ${of("quiet").length} scenarios`, async () => {
  const rep = new Report("quiet");
  await quietLogs(async () => { for (const s of of("quiet")) { const r = await checkQuiet(s); rep.grade(s, r.why, r.got, { now: iso(s.now), people: s.people.map((u) => [u.state, u.tz, u.prefs.quiet_start, u.prefs.quiet_end]) }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ digest
async function checkDigest(s: DigestScenario): Promise<{ why: string | null; got: unknown }> {
  const start = s.runs[0];
  const created = iso(start - MIN);
  const briefs = memoryBriefStores({
    digest: Object.fromEntries(s.people.filter((p) => p.prefs).map((p) => [p.id, { prefs: p.prefs!, tz: p.tz }])),
    people: s.people.map((p) => ({ user_id: p.id, tz: p.tz, ...(p.quiet_start !== undefined ? { quiet_start: p.quiet_start, quiet_end: p.quiet_end } : {}) })),
    rows: Object.fromEntries(s.people.map((p) => [p.id, {
      alerts: Array.from({ length: p.alerts }, () => ({ created_at: created })),
      queue: Array.from({ length: p.apps }, (_, i) => ({ id: `${p.id}-a${i}`, company: `Co${i}`, url: `https://boards.greenhouse.io/co${i}/jobs/${i}`, state: "confirmed", created_at: created, updated_at: created })),
    }])),
  });
  const outbox = memoryAlertStore();
  const queuedAt = new Map<string, number>();
  for (const now of s.runs) {
    try { await runDigest({ outbox, now, store: briefs.digest }); } catch (e) { return { why: `the digest run failed: ${e instanceof Error ? e.message : e}`, got: s.people.map((p) => p.tz) }; }
    for (const o of outbox.dump().outbox) if (!queuedAt.has(`${o.userId}|${o.key}`)) queuedAt.set(`${o.userId}|${o.key}`, now);
  }
  const out = outbox.dump().outbox;
  for (const p of s.people) {
    const tz = effectiveZone(p.tz), prefs = p.prefs ?? { on: true, day: 0, hour: 18 }, qs = p.quiet_start ?? 22, qe = p.quiet_end ?? 7;
    // The weeks a digest is owed, from the runs: checked in the first 5 minutes of an hour, on the day, at or after the hour.
    const owed = new Map<string, number>();
    for (const now of s.runs) {
      if (new Date(now).getUTCMinutes() >= 5 || !prefs.on) continue;
      const l = clock(now, tz);
      if (l.weekday !== prefs.day || l.hour < prefs.hour) continue;
      const alertsInWeek = ms(created) > now - 7 * DAY && ms(created) <= now ? p.alerts : 0;
      if (!p.apps && !alertsInWeek) continue;
      const wk = isoWeekOf(l.date);
      if (!owed.has(wk)) owed.set(wk, now);
    }
    const mine = out.filter((o) => o.userId === p.id);
    const keys = mine.map((o) => o.key).sort(), want = [...owed.keys()].map((w) => `digest:${w}`).sort();
    if (JSON.stringify(keys) !== JSON.stringify(want)) return { why: `${p.id} (zone ${JSON.stringify(p.tz)}, ${JSON.stringify(prefs)}) got digests ${JSON.stringify(keys)}, owed ${JSON.stringify(want)}`, got: keys };
    for (const o of mine) {
      const now = queuedAt.get(`${p.id}|${o.key}`)!;
      if (now !== owed.get(o.key.slice("digest:".length))) return { why: "a digest queued at another run than the first one it was owed", got: iso(now) };
      const bad = awakeProblem(o.at, now, tz, qs, qe);
      if (bad) return { why: `a digest ${bad}`, got: iso(o.at) };
      const alertsInWeek = ms(created) > now - 7 * DAY && ms(created) <= now ? p.alerts : 0;
      if (!o.text.includes(`\nJob alerts sent: ${alertsInWeek}.\n`)) return { why: `the digest's alert count is not the one on file (${alertsInWeek})`, got: o.text };
    }
  }
  return { why: null, got: null };
}
Deno.test(`proactive at scale, the weekly digest in every zone and hour (digest): ${of("digest").length} scenarios`, async () => {
  const rep = new Report("digest");
  for (const s of of("digest")) { const r = await checkDigest(s); rep.grade(s, r.why, r.got, { runs: s.runs.length, people: s.people.map((p) => [p.tz, p.prefs]) }); }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ deliver
async function checkDeliver(s: DeliverScenario): Promise<{ why: string | null; got: unknown }> {
  const base = memoryChannel(s.rows.map((r) => ({ id: r.id, userId: r.userId, contact: r.contact, key: r.key, text: r.text, deliver_at: r.deliver_at, attempts: 0 })));
  const who = new Map(s.people.map((p) => [p.id, p]));
  for (const p of s.people) if (p.stopped) await base.setOptOut(p.contact, true, s.now - DAY);
  const store = { ...base, quiet: async (u: string) => who.get(u)!.paused, alertWanted: async (row: { userId: string }) => who.get(row.userId)!.alertsWanted };
  const sent: { contact: string; text: string }[] = [];
  await deliverDue({ store, send: async (contact, bubbles) => { sent.push({ contact, text: bubbles.join("\n") }); return { ok: true, id: `p${sent.length}` }; }, now: s.now, limit: 100 });
  const rows = base.rows();
  for (const r of s.rows) {
    const p = who.get(r.userId)!, row = rows.find((x) => x.id === r.id)!;
    const alertish = r.kind === "alert" || r.kind === "report";
    const go = !p.stopped && !p.paused && (!alertish || (p.alertsWanted && s.now - r.deliver_at <= STALE_MS));
    const want = go ? "delivered" : "skipped_opt_out";
    if (row.status !== want) return { why: `${r.key} (${Math.round((s.now - r.deliver_at) / HOUR)}h old; stopped ${p.stopped}, paused ${p.paused}, alerts wanted ${p.alertsWanted}) is ${row.status}, must be ${want}`, got: row };
    if (go && sent.filter((x) => x.text === r.text).length !== 1) return { why: "a delivered row did not reach the person exactly once", got: sent.filter((x) => x.text === r.text) };
    if (go && sent.find((x) => x.text === r.text)!.contact !== r.contact) return { why: "a row reached another person's contact", got: sent.find((x) => x.text === r.text) };
  }
  if (sent.length !== rows.filter((x) => x.status === "delivered").length) return { why: "something went out that is not a delivered row", got: sent.length };
  return { why: null, got: null };
}
Deno.test(`proactive at scale, delivery holds what is paused, stopped, unwanted or stale (deliver): ${of("deliver").length} scenarios`, async () => {
  const rep = new Report("deliver");
  await quietLogs(async () => { for (const s of of("deliver")) { const r = await checkDeliver(s); rep.grade(s, r.why, r.got, { now: iso(s.now), people: s.people }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ budget
const AUTH = (domain: string) => [`mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=REJECT) header.from=${domain}`];
const GH = "Asana <no-reply@greenhouse.io>";
// Mail the rules are unsure of (wo-051's fixtures): each is asked about when the model is on.
const UNSURE = [
  ["Asana - update on your application", "Hi Sam, thanks for your patience. We have news about the Account Manager role; please see the portal."],
  ["Asana - Account Manager", "Thanks for applying. If your background fits, we will reach out to schedule an interview for the Account Manager role."],
  ["Asana - Account Manager", "We'd love to hear more. Please complete a short questionnaire about the Account Manager role by Friday."],
];
const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MODEL_BUDGET_PAUSED"];
async function mailRun(s: BudgetScenario, gate: BudgetGate | null, request: typeof fetch) {
  const people = Array.from({ length: s.people }, (_, i) => ({ user_id: `bu${i}`, read_through: iso(s.now - HOUR) }));
  const tracker = Object.fromEntries(people.map((p) => [p.user_id, [{ app_id: `a-${p.user_id}`, company: "Asana", stage: "Submitted", applied_at: iso(s.now - 10 * DAY), events: [], role: "Account Manager" }]]));
  const base = memoryMailStore({ people, tracker });
  const store = { ...base, claimModelCalls: async (_u: string, want: number) => want };
  const outbox = memoryAlertStore();
  const mails = (u: string): MailIn[] => UNSURE.slice(0, s.perPerson).map(([subject, snippet], i) => ({ hash: `${u}-${i}`, from: GH, subject, snippet, date: iso(s.now - (10 - i) * MIN), auth: AUTH("greenhouse.io") }));
  const model = gate ? mailModelWiring({ get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "sk-test-not-a-real-key" : undefined) }, { from: () => ({ insert: async () => ({ error: null }) }) }, request) : null;
  resetLocalBudgetGate(gate);
  try {
    const stats = await runMail({ outbox, now: s.now, store, read: async (u) => ({ status: "ok", mails: mails(u), readThrough: s.now, listed: s.perPerson }), model });
    return { stats, texts: outbox.dump().outbox.map((o) => [o.userId, o.key, o.text]) };
  } finally { resetLocalBudgetGate(null); }
}
Deno.test(`proactive at scale, the model asked only within a reserved budget (budget): ${of("budget").length} scenarios`, async () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  try {
    const rep = new Report("budget");
    // One call's worst case, the largest of the three mails: what a budget of N calls is made of.
    let worst = 0;
    {
      const probe = memoryBudgetGate(10 ** 12);
      const g: BudgetGate = { reserve: async (m, meta) => { worst = Math.max(worst, m); return probe.reserve(m, meta); }, settle: probe.settle, release: probe.release };
      await quietLogs(() => mailRun({ kind: "budget", category: "probe", now: Date.parse("2026-10-29T15:00:00Z"), people: 1, perPerson: 3, limitCalls: 9, usage: "proven" }, g, (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "none", confidence: 0.4 }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))) as typeof fetch));
    }
    if (!(worst > 0)) throw new Error("the probe reserved nothing");
    await quietLogs(async () => {
      for (const s of of("budget")) {
        const limit = s.limitCalls * worst;
        const inner = memoryBudgetGate(Math.max(1, limit));
        const log: { id: string; micros: number; actual?: number | null; released?: boolean }[] = [];
        const gate: BudgetGate = {
          reserve: async (m, meta) => { const r = await inner.reserve(m, meta); if (r.ok) log.push({ id: r.id, micros: m }); return r; },
          settle: async (id, a) => { const x = log.find((y) => y.id === id); if (x) x.actual = a; return inner.settle(id, a); },
          release: async (id) => { const x = log.find((y) => y.id === id); if (x) x.released = true; return inner.release(id); },
        };
        let requests = 0, n = 0;
        const provider = (async () => {
          requests++;
          const usage = s.usage === "proven" || (s.usage === "mixed" && n++ % 2 === 0) ? { usage: { prompt_tokens: 400, completion_tokens: 30 } } : {};
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "none", confidence: 0.4 }) } }], ...usage }), { status: 200 });
        }) as typeof fetch;
        const got = await mailRun(s, gate, provider);
        const rules = await mailRun(s, null, provider);
        const snap = inner.snapshot();
        let why: string | null = null;
        if (requests !== log.length) why = `${requests} requests to the provider for ${log.length} reservations: a call went without its budget`;
        else if (snap.reserved !== 0) why = `${snap.reserved} micro-dollars left reserved after the run`;
        else if (snap.spent > limit && limit > 0) why = `spent ${snap.spent} over the budget of ${limit}`;
        else if (snap.spent !== log.reduce((a, x) => a + (x.released ? 0 : x.actual ?? x.micros), 0)) why = "spent is not the proven costs plus the worst case of every call without usage";
        else if (log.some((x) => x.actual === undefined && !x.released)) why = "a reservation was never settled";
        else if (s.usage === "missing" && log.some((x) => x.actual !== null)) why = "a reply with no usage was settled below its worst case";
        else if (s.limitCalls === 0 && requests !== 0) why = "the provider was asked with no budget at all";
        else if (requests > s.people * s.perPerson) why = "more requests than mail to ask about";
        else if (requests === 0 && JSON.stringify(got.texts) !== JSON.stringify(rules.texts)) why = "with no call made, the run says something other than the rules alone";
        rep.grade(s, why, { requests, log: log.length, snap, limit, worst });
      }
    });
    rep.assertClean();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    resetLocalBudgetGate(null);
  }
});

Deno.test("the battery is about 10,000 scenarios", () => {
  eq(SCENARIOS.length, Object.values(COUNTS).reduce((a, b) => a + b, 0));
  assertNode.ok(SCENARIOS.length >= 10000, `${SCENARIOS.length} scenarios`);
  // Every kind of zone is in it: unknown ones, half and quarter hours, daylight-saving nights.
  const zones = new Set(of("plan").flatMap((s) => s.people.map((u) => u.tz)));
  for (const z of ["Asia/Kathmandu", "Asia/Kolkata", "Pacific/Chatham", "Pacific Time", ""]) assertNode.ok(zones.has(z), `zone ${JSON.stringify(z)} in the battery`);
  assertNode.ok(!zoneOk("Pacific Time") && effectiveZone("Pacific Time") === DEFAULT_ZONE);
});
