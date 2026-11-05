// Proactive job alerts, daily reports, digests and interview briefs, round 4 (2026-11-05): about 10,000 generated
// scenarios (seed 20261105, scenarios/proactive-r4-generator.ts) through the real code of what Trainee sends without being
// asked: the scheduled alerts run (career_proactive_run.ts runAlerts over the memory alert store, with the alert settings
// tool's startWatching for a zone change), the weekly digest (runDigest), mail tracking's interview briefs (runMail) with
// and without the model's second pass, and the scheduled run's handler (career-proactive/handler.ts handleProactive). A
// fixed clock, no network, no model (a scripted fake that refuses as the budget does). Rounds 1 to 3 are
// scenarios-proactive*.test.ts; these are the categories they did not try (see the generator). Every expectation comes
// from how the scenario was built, never from the product's code. The invariants:
//   - at most one daily report for a local date, and never one for a date earlier than one already sent (a move west);
//   - never more alerts than the person's daily number for a day already counted (a move west keeps the count); never
//     more than two days' worth in any 24 hours unless the person moved east;
//   - nothing planned inside quiet hours on the person's clock as it is when planned;
//   - no alert and no report line for a job the person applied to (or its copy on another board), or one that closed;
//     every other new job is still news, up to their number;
//   - after an outage, one daily report and one weekly digest at most in what goes out together, the newest one, and
//     each one set aside says why;
//   - no interview brief for an interview already over; one still to come is briefed once (both texts), with the
//     invite's company and the time on the person's own clock;
//   - a refused model budget changes nothing that is queued (exactly the rules' texts), half-builds nothing, says nothing
//     about the model, and asks no more calls than were granted;
//   - no rail that reads a person as paused, stopped or erased starts anything for them; others still get everything.
// Run: deno test -A --no-check tests/architect/scenarios-proactive-r4.test.ts
import { runAlerts, runDigest, runInterviewDrafts, runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { memoryAlertStore, startWatching, type AlertRow } from "../../supabase/functions/_shared/career_alert_store.ts";
import { DEFAULT_PREFS } from "../../supabase/functions/_shared/career_alerts.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryBriefStores } from "../../supabase/functions/_shared/career_brief_store.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { ModelBudgetBlockedError } from "../../supabase/functions/_shared/model_calls.ts";
import { ALERT_STALE_MS } from "../../supabase/functions/_shared/channel.ts";
import { isoWeekOf } from "./scenarios/proactive-generator.ts";
import { localTime } from "./scenarios/proactive-r2-generator.ts";
import {
  type AppliedScenario, type BriefScenario, type BudgetScenario, type CatchupScenario, clock, COUNTS, DAY, generate, HOUR, MIN, offsetMin,
  type PauseScenario, type Posting, quietOn, type R4Scenario, SEED, type ZoneScenario,
} from "./scenarios/proactive-r4-generator.ts";

const ALL = generate({ seed: SEED, only: ["zones", "applied", "pause"] }); // catchup, briefs, budget: scenarios-proactive-r4-catchup.test.ts
const of = <K extends R4Scenario["kind"]>(k: K) => ALL.filter((s) => s.kind === k) as Extract<R4Scenario, { kind: K }>[];
const iso = (t: number) => new Date(t).toISOString();
const ms = (t: unknown) => Date.parse(String(t ?? ""));
const AUTH = (d: string) => [`mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass smtp.mailfrom=${d}; dmarc=pass (p=REJECT) header.from=${d}`];
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);

interface Failure { why: string; input: unknown }
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>(); notes: Record<string, number> = {};
  constructor(public name: string) {}
  grade(cat: string, why: string | null, input: unknown = "") {
    this.total++;
    this.byCat[cat] = (this.byCat[cat] ?? 0) + 1;
    if (!why) return;
    if (!this.failures.has(cat)) this.failures.set(cat, []);
    this.failures.get(cat)!.push({ why, input });
  }
  note(k: string, n = 1) { this.notes[k] = (this.notes[k] ?? 0) + n; }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[proactive r4] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures${Object.keys(this.notes).length ? `; ${Object.entries(this.notes).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${x.why} | input ${JSON.stringify(x.input).slice(0, Number(Deno.env.get("R4_INPUT") ?? 400))}`);
    }
    console.log(lines.join("\n"));
    if (failed) throw new Error(lines.join("\n"));
  }
}
// The product logs every rail's failure (and the scenarios make some on purpose); the report says what matters.
async function quietLogs<T>(f: () => Promise<T>): Promise<T> {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await f(); } finally { console.error = e; console.warn = w; }
}
const prefsOf = (p: { cap: number; report_hour: number; quiet_start: number; quiet_end: number }) =>
  ({ ...DEFAULT_PREFS, keywords: ["data analyst"], report_hour: p.report_hour, quiet_start: p.quiet_start, quiet_end: p.quiet_end, max_instant_per_day: p.cap });
const seenBy = (ps: Posting[], t: number) => ps.filter((p) => ms(p.first_seen_at) <= t);

// ------------------------------------------------------------------------------------------------ zones
interface Queued { key: string; kind: string; text: string; at: number; t: number; tz: string }
async function checkZones(s: ZoneScenario): Promise<{ why: string | null; got: unknown }> {
  const u = "z-user", store = memoryAlertStore(), pf = prefsOf(s.prefs);
  await store.save(startWatching(null, { userId: u, prefs: pf, tz: s.tzFrom, now: s.start - HOUR }));
  let tz = s.tzFrom, now = 0, moved = false;
  const log: Queued[] = [];
  const outbox = { async enqueue(id: string, m: any) { const ok = await store.enqueue(id, m); if (ok) log.push({ key: m.key, kind: m.kind, text: m.text, at: m.at, t: now, tz }); return ok; }, enqueueAlert: store.enqueueAlert };
  for (const t of s.runs) {
    if (s.moveAt !== null && !moved && t >= s.moveAt) {
      const prev = (await store.get(u))!;
      await store.save(startWatching(prev, { userId: u, prefs: prev.prefs, tz: s.tzTo, now: s.moveAt }));
      tz = s.tzTo; moved = true;
    }
    now = t;
    await runAlerts({ store, outbox, now: t, recentPostings: async (since) => seenBy(s.postings, t).filter((p) => ms(p.first_seen_at) >= ms(since)),
      postingsById: async (ids) => seenBy(s.postings, t).filter((p) => ids.includes(p.job_id)) });
  }
  const reports = log.filter((x) => x.kind === "report"), alerts = log.filter((x) => x.kind === "alert");
  for (let i = 1; i < reports.length; i++) if (reports[i].key.slice(7) <= reports[i - 1].key.slice(7)) return { why: `a daily report for ${reports[i].key.slice(7)} after the one for ${reports[i - 1].key.slice(7)} (${reports[i - 1].tz} -> ${reports[i].tz})`, got: reports.map((r) => [r.key, iso(r.t), r.tz]) };
  for (const r of reports) {
    const c = clock(r.t, r.tz);
    if (r.key !== `report:${c.date}` || c.hour < s.prefs.report_hour) return { why: `a report keyed ${r.key} at ${c.date} ${c.hour}:00 on the person's clock (${r.tz}), report hour ${s.prefs.report_hour}`, got: [r.key, iso(r.t)] };
  }
  for (const x of log) {
    if (x.at < x.t) return { why: "a text due before it was planned", got: [x.key, iso(x.at), iso(x.t)] };
    if (quietOn(x.at, x.tz, s.prefs.quiet_start, s.prefs.quiet_end)) return { why: `planned inside quiet hours ${s.prefs.quiet_start}-${s.prefs.quiet_end} on the person's clock (${x.tz}, ${clock(x.at, x.tz).hour}:${clock(x.at, x.tz).minute})`, got: [x.key, iso(x.at)] };
  }
  const perDay = new Map<string, number>();
  for (const a of alerts) { const k = `${a.tz}|${clock(a.t, a.tz).date}`; perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  for (const [k, n] of perDay) if (n > s.prefs.cap) return { why: `${n} alerts on ${k}, the person asked for ${s.prefs.cap} a day`, got: alerts.map((a) => [a.key, iso(a.t), a.tz]) };
  // A move west goes back a date: the day already counted on the old clock is the day still being lived on the new one.
  if (s.moveAt !== null) {
    const D = clock(s.moveAt, s.tzFrom).date;
    if (clock(s.moveAt, s.tzTo).date < D) {
      const n = alerts.filter((a) => (a.t < s.moveAt! ? a.tz === s.tzFrom && clock(a.t, s.tzFrom).date === D : clock(a.t, s.tzTo).date <= D)).length;
      if (n > s.prefs.cap) return { why: `moved west (${s.tzFrom} -> ${s.tzTo}) on ${D}: ${n} alerts counted against that day, the person asked for ${s.prefs.cap} a day`, got: alerts.map((a) => [a.key, iso(a.t), a.tz]) };
    }
    if (offsetMin(s.moveAt, s.tzTo) <= offsetMin(s.moveAt, s.tzFrom)) {
      for (const a of alerts) { const n = alerts.filter((b) => b.t >= a.t && b.t < a.t + DAY).length; if (n > 2 * s.prefs.cap) return { why: `${n} alerts within 24 hours of ${iso(a.t)} (${s.tzFrom} -> ${s.tzTo}), the person asked for ${s.prefs.cap} a day`, got: alerts.map((x) => [x.key, iso(x.t), x.tz]) }; }
    }
  }
  // Liveness: the person is not silenced by a move.
  // The last three local dates (on the clock in force, after any move) on which a run reached the report hour: one of them
  // has its report (a move west may take the first of them, a date already reported on the old clock).
  const reached = [...new Set(s.runs.filter((t) => s.moveAt === null || t > s.moveAt).map((t) => clock(t, tz)).filter((c) => c.hour >= s.prefs.report_hour).map((c) => c.date))].slice(-3);
  if (reached.length === 3 && !reports.some((r) => reached.includes(r.key.slice(7)))) return { why: `no daily report for ${reached.join(", ")} (${tz}, report hour ${s.prefs.report_hour})`, got: reports.map((r) => [r.key, iso(r.t), r.tz]) };
  if (s.moveAt === null) {
    // One report every local day the report hour was reached by a run, except the day alerts were turned on after it.
    const on = clock(s.start - HOUR, s.tzFrom), want = new Set<string>();
    for (const t of s.runs) { const c = clock(t, s.tzFrom); if (c.hour >= s.prefs.report_hour && !(c.date === on.date && on.hour >= s.prefs.report_hour)) want.add(c.date); }
    const got = new Set(reports.map((r) => r.key.slice(7)));
    for (const d of want) if (!got.has(d)) return { why: `no daily report on ${d} (${s.tzFrom}, report hour ${s.prefs.report_hour})`, got: [...got] };
  }
  if (!alerts.length && s.postings.length > 5) return { why: "four days of matching postings and no alert", got: s.postings.length };
  return { why: null, got: null };
}
Deno.test({ name: `proactive round 4 (zones): a person who moves zones, across the date line, half hours and daylight-saving nights: ${COUNTS.zones} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("zones");
  await quietLogs(async () => { for (const s of of("zones")) { const r = await checkZones(s); rep.grade(s.category, r.why, { from: s.tzFrom, to: s.tzTo, start: iso(s.start), move: s.moveAt && iso(s.moveAt), prefs: s.prefs, got: r.got }); } });
  rep.assertClean();
} });

// ------------------------------------------------------------------------------------------------ applied
async function checkApplied(s: AppliedScenario): Promise<{ why: string | null; got: unknown }> {
  const u = "a-user", base = memoryAlertStore();
  const today = clock(s.now, s.tz).date;
  const row: AlertRow = { id: u, tz: s.tz, prefs: prefsOf(s.prefs), last_checked_at: iso(s.now - 2 * HOUR), instant_sent_today: 0, sent_on: today, last_report_on: s.reportDue ? null : today, held: s.held };
  await base.save(row);
  const store = { ...base, appliedJobs: async () => { if (s.category === "read_fails") throw new Error("read the applications sent: timeout"); return new Map([[u, new Set(s.applied)]]); } };
  let threw = false;
  try {
    await runAlerts({ store, outbox: store, now: s.now, recentPostings: async (since) => s.postings.filter((p) => ms(p.first_seen_at) >= ms(since) && ms(p.first_seen_at) <= s.now),
      postingsById: async (ids) => s.postings.filter((p) => ids.includes(p.job_id)) });
  } catch { threw = true; }
  const out = base.dump().outbox;
  if (s.category === "read_fails") return threw && !out.some((x) => x.kind === "alert") ? { why: null, got: null } : { why: "the applications sent could not be read and alerts went out anyway (a guess that the person had not applied)", got: out.map((x) => x.key) };
  if (threw) return { why: "the alerts run failed", got: null };
  const byId = new Map(s.postings.map((p) => [p.job_id, p]));
  const forbidden = s.jobs.filter((j) => j.applied || !j.open), allowed = s.jobs.filter((j) => !j.applied && j.open);
  const badIds = new Set(forbidden.flatMap((j) => j.ids)), badUrls = new Set(forbidden.flatMap((j) => j.ids.map((id) => byId.get(id)!.url)));
  const alerts = out.filter((x) => x.kind === "alert");
  for (const a of alerts) if (badIds.has(a.key.slice(6))) { const j = forbidden.find((x) => x.ids.includes(a.key.slice(6)))!; return { why: `an alert for a job the person ${j.applied ? "already applied to" : "saw close"}${j.ids[0] !== a.key.slice(6) ? " (its copy on another board)" : ""}`, got: a.key }; }
  const jobOf = (id: string) => s.jobs.find((j) => j.ids.includes(id))!;
  const alertedJobs = alerts.map((a) => jobOf(a.key.slice(6)).name);
  if (new Set(alertedJobs).size !== alertedJobs.length) return { why: "one job alerted twice", got: alertedJobs };
  const want = Math.min(s.prefs.cap, allowed.filter((j) => j.fresh).length);
  if (alerts.length !== want) return { why: `${alerts.length} alerts; ${allowed.filter((j) => j.fresh).length} new jobs the person has not applied to, ${s.prefs.cap} a day`, got: alerts.map((a) => a.key) };
  const report = out.find((x) => x.kind === "report");
  if (s.reportDue !== !!report) return { why: s.reportDue ? "no daily report on a day it was due" : "a daily report before its hour", got: out.map((x) => x.key) };
  if (report) {
    const urls = [...report.text.matchAll(/^ {2}(https:\/\/\S+)$/gm)].map((m) => m[1]);
    for (const url of urls) if (badUrls.has(url) && !allowed.some((j) => j.ids.some((id) => byId.get(id)!.url === url))) return { why: "the daily report lists a job the person applied to, or one that closed", got: url };
    if (urls.length !== allowed.length) return { why: `the daily report lists ${urls.length} jobs; ${allowed.length} open jobs of the day the person has not applied to`, got: report.text };
    const n = /^Your daily job report: (\d+) match/.exec(report.text)?.[1];
    if (allowed.length ? Number(n) !== allowed.length : !/no new matches/.test(report.text)) return { why: "the report's count is not what it lists", got: report.text.split("\n")[0] };
  }
  return { why: null, got: null };
}
Deno.test({ name: `proactive round 4 (applied): jobs the person already applied to, their copies, closed and held postings: ${COUNTS.applied} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("applied");
  await quietLogs(async () => { for (const s of of("applied")) { const r = await checkApplied(s); rep.grade(s.category, r.why, { cap: s.prefs.cap, applied: s.applied, jobs: s.jobs, got: r.got }); } });
  rep.assertClean();
} });

// ------------------------------------------------------------------------------------------------ pause
async function checkPause(s: PauseScenario): Promise<{ why: string | null; got: unknown }> {
  const A = "p-a", B = "p-b", ids = [A, B], c = clock(s.now, s.tz);
  const store = memoryAlertStore();
  const pf = { ...DEFAULT_PREFS, keywords: ["data analyst"], quiet_start: 0, quiet_end: 0, report_hour: 23, max_instant_per_day: 5 };
  for (const u of ids) await store.save({ id: u, tz: s.tz, prefs: pf, last_checked_at: iso(s.now - HOUR), instant_sent_today: 0, sent_on: c.date, last_report_on: c.date, held: [] });
  const postings = [posting0(`greenhouse:pz:1`, "Pause Co", s.now - 10 * MIN)];
  const ivStart = s.now - 3 * HOUR;
  const iv = (u: string) => ({ key: hex(`iv-${u}`), source: "mail", ref: `track:t-${u}`, company: "Thanks Co", role: "Data Analyst", when_said: [], date: clock(ivStart, s.tz).date, time: null, zone: s.tz, starts_at: iso(ivStart),
    format: null, interviewers: [], mail_at: iso(s.now - 3 * DAY), seen_at: iso(s.now - 3 * DAY), brief_at: iso(s.now - 3 * DAY), brief_ms: 1 });
  const briefs = memoryBriefStores({ people: ids.map((u) => ({ user_id: u, tz: s.tz })), interviews: Object.fromEntries(ids.map((u) => [u, [iv(u)]])) as any,
    digest: Object.fromEntries(ids.map((u) => [u, { prefs: { on: true, day: c.weekday, hour: c.hour }, tz: s.tz }])) as any,
    rows: Object.fromEntries(ids.map((u) => [u, { alerts: [{ created_at: iso(s.now - DAY) }] }])) as any });
  const drafts = memoryMailStore({ tracker: Object.fromEntries(ids.map((u) => [u, [{ app_id: `t-${u}`, company: "Thanks Co", stage: "Interview rounds", applied_at: iso(s.now - 20 * DAY), events: [], role: "Data Analyst" }]])) });
  let calls = 0, aQuiet = false;
  const log: { u: string; key: string; aQuiet: boolean }[] = [];
  const outbox = { async enqueue(u: string, m: any) { const ok = await store.enqueue(u, m); if (ok) log.push({ u, key: m.key, aQuiet }); return ok; }, enqueueAlert: store.enqueueAlert };
  const env: Record<string, string> = { CAREER_PROACTIVE_SECRET: ["s", "e", "c"].join("").repeat(12) };
  await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": env.CAREER_PROACTIVE_SECRET } }), {
    env: { get: (k: string) => env[k] }, now: () => s.now, store: () => ({ ...store, ...outbox }),
    recentPostings: async () => postings, postingsById: async (xs) => postings.filter((p) => xs.includes(p.job_id)),
    finishedApplications: async () => ids.map((u) => ({ id: `job-${u}`, user_id: u, company: "Receipt Co", url: "https://boards.greenhouse.io/receipt/jobs/1", state: "confirmed", reason: null, confirmation_id: "C-1", email_confirmed_at: null, evidence: null, source: null, tz: s.tz, quiet_start: 0, quiet_end: 0 }) as any),
    briefs: { interviews: () => briefs.interviews, drafts: () => drafts, digest: () => briefs.digest },
    quiet: async (xs) => { calls++; aQuiet = calls > s.flipAt && (s.backAt === null || calls <= s.backAt); return new Set(aQuiet ? xs.filter((x) => x === A) : []); },
    recordRun: async () => {},
  });
  for (const x of log) if (x.u === A && x.aQuiet) return { why: `${x.key} was queued for a person the run had just read as ${s.category}`, got: log };
  const kinds = (u: string) => new Set(log.filter((x) => x.u === u).map((x) => x.key.split(":")[0] + (x.key.startsWith("followup:thank_you") ? ":thank_you" : "")));
  for (const k of ["alert", "receipt", "digest", "followup:thank_you"]) if (!kinds(B).has(k)) return { why: `someone who never paused got no ${k} in the same run`, got: log };
  // the rails that read the person as awake (the first flipAt of them) still started their texts
  if (s.flipAt >= 1 && !kinds(A).has("alert")) return { why: "the alerts rail read the person as awake and queued nothing for them", got: log };
  return { why: null, got: null };
}
const posting0 = (id: string, company: string, seen: number) => ({ job_id: id, company, title: "Data Analyst", location: "Remote", url: `https://boards.greenhouse.io/pz/jobs/${id.split(":")[2]}`, first_seen_at: iso(seen), posted_at: iso(seen), closed_at: null });
Deno.test({ name: `proactive round 4 (pause): paused, STOP or erased part way through a run: ${COUNTS.pause} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("pause");
  await quietLogs(async () => { for (const s of of("pause")) { const r = await checkPause(s); rep.grade(s.category, r.why, { flipAt: s.flipAt, backAt: s.backAt, now: iso(s.now), tz: s.tz, got: r.got }); } });
  rep.assertClean();
} });

// ------------------------------------------------------------------------------------------------ the bugs, one by one
const eqv = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
Deno.test("round 4 regression: Tokyo to Los Angeles keeps the day's alerts counted and sends no second report for the day before", async () => {
  const u = "tokyo", store = memoryAlertStore(), pf = prefsOf({ cap: 3, report_hour: 8, quiet_start: 0, quiet_end: 0 });
  const t0 = Date.parse("2026-11-04T23:05:00Z"); // 08:05 on 5 November in Tokyo
  await store.save({ ...startWatching(null, { userId: u, prefs: pf, tz: "Asia/Tokyo", now: t0 - 2 * HOUR }), last_report_on: null });
  const ps = Array.from({ length: 12 }, (_, i) => posting0(`greenhouse:tk:${i}`, `Tokyo Co ${i}`, t0 - 30 * MIN + i * 3 * HOUR));
  const run = (t: number) => runAlerts({ store, outbox: store, now: t, recentPostings: async (since) => seenBy(ps as any, t).filter((p) => ms(p.first_seen_at) >= ms(since)), postingsById: async (ids) => ps.filter((p) => ids.includes(p.job_id)) });
  await run(t0);
  await run(t0 + 3 * HOUR); await run(t0 + 6 * HOUR);
  eqv(store.dump().outbox.map((x) => x.key.split(":")[0]).sort(), ["alert", "alert", "alert", "report"], "Tokyo, 5 November: three alerts and the report");
  // 16:30 on 4 November in Los Angeles: the move.
  const tm = Date.parse("2026-11-05T00:30:00Z");
  await store.save(startWatching((await store.get(u))!, { userId: u, prefs: pf, tz: "America/Los_Angeles", now: tm }));
  for (let t = tm + 5 * MIN; t < Date.parse("2026-11-06T08:00:00Z"); t += 2 * HOUR) await run(t); // to midnight of 5 November in Los Angeles
  const out = store.dump().outbox;
  eqv(out.filter((x) => x.kind === "alert").length, 3, "no new day's allowance while it is still 4 or 5 November in Los Angeles");
  eqv(out.filter((x) => x.kind === "report").map((x) => x.key), ["report:2026-11-05"], "no report for 4 November after the one for 5 November");
  await run(Date.parse("2026-11-06T17:05:00Z")); // 09:05 on 6 November in Los Angeles
  eqv(store.dump().outbox.filter((x) => x.kind === "report").map((x) => x.key), ["report:2026-11-05", "report:2026-11-06"], "6 November in Los Angeles: its report");
});
Deno.test("round 4 regression: a job the person applied to, and its copy on another board, is not news; another job still is", async () => {
  const u = "applied", store = memoryAlertStore(), now = Date.parse("2026-11-05T15:05:00Z");
  await store.save({ id: u, tz: "America/New_York", prefs: prefsOf({ cap: 5, report_hour: 8, quiet_start: 0, quiet_end: 0 }), last_checked_at: iso(now - HOUR), instant_sent_today: 0, sent_on: null, last_report_on: null, held: [] });
  const mine = posting0("greenhouse:acme:1", "Acme", now - 30 * MIN), copy = { ...posting0("lever:agg:9", "Acme, Inc.", now - 10 * MIN), url: mine.url }, other = posting0("greenhouse:globex:2", "Globex", now - 20 * MIN);
  const ps = [mine, copy, other];
  await runAlerts({ store: { ...store, appliedJobs: async () => new Map([[u, new Set([mine.job_id])]]) }, outbox: store, now, recentPostings: async () => ps, postingsById: async (ids) => ps.filter((p) => ids.includes(p.job_id)) });
  const out = store.dump().outbox;
  eqv(out.filter((x) => x.kind === "alert").map((x) => x.key), ["alert:greenhouse:globex:2"], "only the job not applied to");
  const report = out.find((x) => x.kind === "report")!.text;
  if (report.includes(mine.url) || !report.includes(other.url) || !/^Your daily job report: 1 match /.test(report)) throw new Error(`the report: ${report}`);
});
Deno.test("the round 4 battery is about 10,000 scenarios", () => {
  const n = Object.values(COUNTS).reduce((a, b) => a + b, 0);
  const rest = generate({ seed: SEED, only: ["catchup", "briefs", "budget"] }).length;
  if (n < 9500 || ALL.length + rest !== n) throw new Error(`${ALL.length} + ${rest} scenarios generated, ${n} counted`);
});
// The thank-you rail in the pause scenarios is runInterviewDrafts through the handler; referenced so a rename breaks here.
void runInterviewDrafts;
