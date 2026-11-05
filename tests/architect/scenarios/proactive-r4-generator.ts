// The generator of scenarios-proactive-r4.test.ts (round 4, seed 20261105): what Trainee sends without being asked, in the
// categories rounds 1 to 3 did not try. Every scenario is data built here from a seeded generator; the expectations are
// worked out from how each was built (the person's clock, the jobs they applied to, the outage), never from the product.
//   zones    a person who moves zones (west across the date line, east, half and quarter hours, the US and European
//            daylight-saving nights) while alerts and daily reports run every hour for four days
//   applied  postings the person already applied to through Trainee (D-041: real submission is on), their copies on
//            other boards, postings that closed, and held ones, in alerts and the daily report
//   catchup  delivery down for up to four days (or the scheduled run down, then a run retried and two at once): what is
//            sent when it comes back collapses to one daily report and one weekly digest, never a burst
//   briefs   an interview invite read late (the first read, a run down for days): an interview already over is never
//            briefed; one still to come is briefed once, with the invite's facts and the person's own clock
//   budget   the model budget refuses the mail second pass (globally, from some call on, or for some people today): what is
//            queued is exactly what the rules alone queue, nothing half-built, nothing about the model said
//   pause    the person pauses, texts STOP or erases while a run is part way: no rail that reads them as quiet after that
//            starts anything for them; someone else in the same run still gets everything
import { chance, clock, DAY, HOUR, int, MIN, pick, quietOn, type R, rng } from "./proactive-generator.ts";

export { clock, DAY, HOUR, MIN, quietOn };
export const SEED = 20261105;
export const NOW = Date.parse("2026-11-05T15:00:00Z"); // Thursday; 10:00 in New York, 00:00 on 6 November in Tokyo

// Zones far apart and odd: across the date line (Kiritimati +14, Pago Pago -11), half and quarter hours, and zones with
// daylight saving on both hemispheres.
export const ZONES = ["Asia/Tokyo", "Pacific/Auckland", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Pacific/Honolulu", "America/Los_Angeles",
  "America/Denver", "America/Chicago", "America/New_York", "America/St_Johns", "America/Sao_Paulo", "Europe/London", "Europe/Berlin",
  "Asia/Kolkata", "Asia/Kathmandu", "Australia/Adelaide", "Australia/Lord_Howe", "Pacific/Chatham", "Asia/Dubai", "UTC"] as const;
// The nights the clocks change (UTC instants a little before): the US goes back 1 November 2026 and forward 8 March 2026;
// Europe goes back 25 October 2026; Lord Howe moves half an hour (5 April 2026); Auckland goes back 5 April 2026.
export const DST_STARTS: { tz: string; at: number }[] = [
  { tz: "America/New_York", at: Date.parse("2026-10-31T12:00:00Z") }, { tz: "America/Los_Angeles", at: Date.parse("2026-10-31T12:00:00Z") },
  { tz: "America/Chicago", at: Date.parse("2026-03-07T12:00:00Z") }, { tz: "America/New_York", at: Date.parse("2026-03-07T12:00:00Z") },
  { tz: "Europe/London", at: Date.parse("2026-10-24T12:00:00Z") }, { tz: "Europe/Berlin", at: Date.parse("2026-10-24T12:00:00Z") },
  { tz: "Australia/Lord_Howe", at: Date.parse("2026-04-04T00:00:00Z") }, { tz: "Pacific/Auckland", at: Date.parse("2026-04-04T00:00:00Z") },
];
const offsetMin = (at: number, tz: string) => { const c = clock(at, tz), u = clock(at, "UTC"); return Math.round((Date.UTC(+c.date.slice(0, 4), +c.date.slice(5, 7) - 1, +c.date.slice(8, 10), c.hour, c.minute) - Date.UTC(+u.date.slice(0, 4), +u.date.slice(5, 7) - 1, +u.date.slice(8, 10), u.hour, u.minute)) / MIN); };
export { offsetMin };

export interface Prefs { cap: number; report_hour: number; quiet_start: number; quiet_end: number }
function prefs(r: R): Prefs {
  const qs = pick(r, [21, 22, 23, 0, 22, 22]), qe = pick(r, [6, 7, 8, 7, 9]);
  return { cap: int(r, 1, 5), report_hour: pick(r, [7, 8, 8, 9, 12, 18, 23, 0, 2]), quiet_start: qs, quiet_end: qe };
}
export interface Posting { job_id: string; company: string; title: string; location: string; url: string; first_seen_at: string; posted_at: string; closed_at: string | null }
const iso = (t: number) => new Date(t).toISOString();
export function posting(id: string, company: string, seen: number, o: { title?: string; url?: string; closed?: number | null; location?: string } = {}): Posting {
  const [prov, board, n] = id.split(":");
  return { job_id: id, company, title: o.title ?? "Data Analyst", location: o.location ?? "Remote",
    url: o.url ?? (prov === "lever" ? `https://jobs.lever.co/${board}/${n}` : `https://boards.greenhouse.io/${board}/jobs/${n}`),
    first_seen_at: iso(seen), posted_at: iso(seen), closed_at: o.closed ? iso(o.closed) : null };
}

// ------------------------------------------------------------------------------------------------ zones
export type ZoneCase = "west" | "east" | "dateline_west" | "dateline_east" | "half_hour" | "dst_stay" | "dst_move" | "stay";
export interface ZoneScenario { kind: "zones"; category: ZoneCase; start: number; tzFrom: string; tzTo: string; moveAt: number | null; prefs: Prefs; postings: Posting[]; runs: number[] }
function zones(r: R, i: number): ZoneScenario {
  const c = pick(r, ["west", "west", "east", "dateline_west", "dateline_east", "half_hour", "dst_stay", "dst_move", "stay"] as ZoneCase[]);
  let start = NOW - int(r, 0, 23) * HOUR, tzFrom: string = pick(r, ZONES), tzTo: string = tzFrom;
  const west = (a: string, b: string, at: number) => offsetMin(at, a) > offsetMin(at, b);
  if (c === "dst_stay" || c === "dst_move") { const d = pick(r, DST_STARTS); start = d.at - int(r, 0, 12) * HOUR; tzFrom = d.tz; tzTo = c === "dst_move" ? pick(r, ZONES) : d.tz; }
  else if (c === "dateline_west") { tzFrom = pick(r, ["Pacific/Kiritimati", "Pacific/Auckland", "Pacific/Chatham", "Asia/Tokyo"]); tzTo = pick(r, ["Pacific/Pago_Pago", "Pacific/Honolulu", "America/Los_Angeles"]); }
  else if (c === "dateline_east") { tzFrom = pick(r, ["Pacific/Pago_Pago", "Pacific/Honolulu", "America/Los_Angeles"]); tzTo = pick(r, ["Pacific/Kiritimati", "Pacific/Auckland", "Asia/Tokyo"]); }
  else if (c === "half_hour") { tzFrom = pick(r, ["Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns", "Australia/Adelaide", "Pacific/Chatham"]); tzTo = pick(r, ZONES); }
  else if (c === "west" || c === "east") {
    for (let k = 0; k < 50; k++) { tzFrom = pick(r, ZONES); tzTo = pick(r, ZONES); if (tzFrom !== tzTo && west(tzFrom, tzTo, start) === (c === "west")) break; }
  }
  const moveAt = c === "stay" || c === "dst_stay" ? null : start + int(r, 4, 40) * HOUR + int(r, 0, 59) * MIN;
  // A posting or two an hour, each its own job (another firm), first seen on the hour's quarter.
  const postings: Posting[] = [];
  for (let h = -2; h < 96; h++) for (let k = 0, n = int(r, 0, 2); k < n; k++) postings.push(posting(`greenhouse:z${i}:${h * 10 + k + 100}`, `Firm ${i}-${h}-${k}`, start + h * HOUR + int(r, 0, 3) * 15 * MIN));
  const runs: number[] = [];
  // every two hours and five minutes: the hours drift an hour a day, so every hour of the clock is reached every other day
  for (let t = start + 5 * MIN; t < start + 96 * HOUR; t += 2 * HOUR + 5 * MIN) runs.push(t);
  if (moveAt) runs.push(moveAt + 5 * MIN);
  return { kind: "zones", category: c, start, tzFrom, tzTo, moveAt, prefs: prefs(r), postings, runs: runs.sort((a, b) => a - b) };
}

// ------------------------------------------------------------------------------------------------ applied
export type AppliedCase = "applied_exact" | "applied_twin" | "applied_held" | "applied_closed_mix" | "twin_not_applied" | "nothing_applied" | "read_fails";
export interface AppliedScenario {
  kind: "applied"; category: AppliedCase; now: number; tz: string; prefs: Prefs; reportDue: boolean;
  postings: Posting[]; held: string[]; applied: string[];
  // what the scenario built: every job by its id, its postings (ids), whether the person applied, whether it is open
  jobs: { name: string; ids: string[]; applied: boolean; open: boolean; fresh: boolean }[];
}
function applied(r: R, i: number): AppliedScenario {
  const c = pick(r, ["applied_exact", "applied_twin", "applied_held", "applied_closed_mix", "twin_not_applied", "nothing_applied", "read_fails"] as AppliedCase[]);
  const tz = pick(r, ZONES), now = NOW + int(r, 0, 47) * HOUR + 5 * MIN;
  const p = { ...prefs(r), quiet_start: 0, quiet_end: 0 };
  const h = clock(now, tz).hour;
  const reportDue = chance(r, 0.6);
  p.report_hour = reportDue ? int(r, 0, h) : (h + 1 <= 23 ? int(r, h + 1, 23) : h);
  const due = reportDue || p.report_hour <= h;
  const jobs: AppliedScenario["jobs"] = [], postings: Posting[] = [], held: string[] = [], appliedIds: string[] = [];
  const n = int(r, 2, 7);
  for (let k = 0; k < n; k++) {
    const co = `${pick(r, ["Acme", "Globex", "Initech", "Hooli", "Umbrella", "Stark"])} ${i}-${k}`, title = pick(r, ["Data Analyst", "Senior Data Analyst", "Data Analyst II"]);
    const isHeld = (c === "applied_held" && k === 0) || chance(r, 0.15);
    const seen = isHeld ? now - int(r, 20, 23) * HOUR : now - int(r, 5, 110) * MIN;
    const id = `greenhouse:a${i}b${k}:${1000 + k}`;
    const closed = (c === "applied_closed_mix" && chance(r, 0.4)) || chance(r, 0.05) ? now - int(r, 1, 4) * MIN : null;
    const ap = c === "applied_exact" || c === "applied_twin" || c === "applied_held" ? k === 0 || chance(r, 0.3) : c === "applied_closed_mix" ? chance(r, 0.4) : c === "read_fails" ? chance(r, 0.5) : false;
    const main = posting(id, co, seen, { title, closed });
    postings.push(main);
    const ids = [id];
    if (isHeld) held.push(id);
    if (ap) appliedIds.push(id);
    // the same job through an aggregator: another board, the employer's name with its legal form, the same title and place
    if ((c === "applied_twin" && (k === 0 || chance(r, 0.4))) || (c === "twin_not_applied" && chance(r, 0.6)) || chance(r, 0.1)) {
      const tid = `lever:agg${i}x${k}:${2000 + k}`;
      const twinSeen = isHeld ? seen + int(r, 1, 60) * MIN : now - int(r, 1, 100) * MIN;
      postings.push(posting(tid, `${co}, Inc.`, Math.min(twinSeen, now - MIN), { title, url: chance(r, 0.5) ? main.url : undefined, closed }));
      ids.push(tid);
    }
    jobs.push({ name: `${co}|${title}`, ids, applied: ap, open: !closed, fresh: !isHeld });
  }
  return { kind: "applied", category: c, now, tz, prefs: p, reportDue: due, postings, held, applied: appliedIds, jobs };
}

// ------------------------------------------------------------------------------------------------ catchup
export type CatchupCase = "delivery_down" | "delivery_down_long" | "runs_down_retry" | "runs_down_two_at_once" | "both_down";
export interface CatchupScenario {
  kind: "catchup"; category: CatchupCase; start: number; tz: string; prefs: Prefs; digest: { day: number; hour: number };
  postings: Posting[]; runs: number[][]; // each entry: runs started at the same instant (two at once when two)
  deliveryDown: [number, number]; deliveries: number[]; end: number;
}
function catchup(r: R, i: number): CatchupScenario {
  const c = pick(r, ["delivery_down", "delivery_down_long", "runs_down_retry", "runs_down_two_at_once", "both_down"] as CatchupCase[]);
  const tz = pick(r, ZONES), start = NOW - int(r, 0, 23) * HOUR;
  const p = prefs(r), days = c === "delivery_down_long" ? int(r, 3, 5) : int(r, 1, 3);
  const down: [number, number] = c.startsWith("runs_down") ? [start, start] : [start + int(r, 0, 12) * HOUR, start + (days * 24 + int(r, 0, 12)) * HOUR];
  const end = Math.max(down[1], start + days * DAY) + int(r, 2, 30) * HOUR;
  const runsDown: [number, number] = c.startsWith("runs_down") || c === "both_down" ? [start + int(r, 2, 10) * HOUR, start + (days * 24) * HOUR] : [0, 0];
  const runs: number[][] = [];
  for (let k = 0, t = start + 2 * MIN; t < end; k++, t = start + 2 * MIN + k * 2 * HOUR + (k % 2) * HOUR) {
    if (t >= runsDown[0] && t < runsDown[1]) continue;
    const same = t >= runsDown[1] && t < runsDown[1] + HOUR && runsDown[1] > 0;
    runs.push(same ? (c === "runs_down_two_at_once" ? [t, t] : [t, t + 2 * MIN]) : [t]);
  }
  const deliveries: number[] = [];
  for (let t = start + 10 * MIN; t < end + 2 * HOUR; t += 2 * HOUR) if (!(t >= down[0] && t < down[1])) deliveries.push(t);
  const postings: Posting[] = [];
  for (let h = -1; h < (end - start) / HOUR; h++) for (let k = 0, n = int(r, 0, 2); k < n; k++) postings.push(posting(`greenhouse:c${i}:${h * 10 + k + 100}`, `Co ${i}-${h}-${k}`, start + h * HOUR + int(r, 0, 50) * MIN));
  return { kind: "catchup", category: c, start, tz, prefs: p, digest: { day: int(r, 0, 6), hour: int(r, 0, 23) }, postings, runs, deliveryDown: down, deliveries, end };
}

// ------------------------------------------------------------------------------------------------ briefs
export type BriefCase = "over_stated" | "over_by_minutes" | "over_date_only" | "upcoming_stated" | "upcoming_soon" | "upcoming_date_only" | "today_date_only" | "retried" | "two_at_once";
export interface BriefScenario {
  kind: "briefs"; category: BriefCase; personTz: string; company: string; role: string;
  sent: number; read: number; firstRead: boolean; date: string; time: string | null; zone: string | null; zoneSaid: string | null;
  start: number | null; // the interview's stated instant (date, time and zone stated)
  runs: number[][];
  over: boolean; // built: the interview is over when the mail is first read
}
const ZONE_SAID: { said: string; tz: string }[] = [{ said: "ET", tz: "America/New_York" }, { said: "PT", tz: "America/Los_Angeles" }, { said: "CT", tz: "America/Chicago" }, { said: "UTC", tz: "UTC" }];
// The instant a wall-clock date and time names in a zone.
export function zonedInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - offsetMin(wall, tz) * MIN;
  return wall - offsetMin(first, tz) * MIN;
}
function briefs(r: R, i: number): BriefScenario {
  const c = pick(r, ["over_stated", "over_by_minutes", "over_date_only", "upcoming_stated", "upcoming_soon", "upcoming_date_only", "today_date_only", "retried", "two_at_once"] as BriefCase[]);
  const personTz = pick(r, ["America/New_York", "America/Los_Angeles", "America/Chicago", "Europe/London", "Asia/Kolkata", "Asia/Tokyo"]);
  const company = pick(r, ["Acme", "Globex", "Initech", "Hooli", "Stark", "Wayne"]), role = pick(r, ["Data Analyst", "Product Manager", "Software Engineer"]);
  const sent = NOW - int(r, 1, 6) * DAY - int(r, 0, 23) * HOUR;
  const z = pick(r, ZONE_SAID);
  const dateOnly = c === "over_date_only" || c === "upcoming_date_only" || c === "today_date_only";
  const day = (t: number, tz: string) => clock(t, tz).date;
  let read = 0, date = "", time: string | null = null, start: number | null = null, over = false;
  const hhmm = `${String(int(r, 9, 16)).padStart(2, "0")}:${pick(r, ["00", "30"])}`;
  if (dateOnly) {
    const ivDay = sent + int(r, 1, 4) * DAY;
    date = day(ivDay, personTz);
    const today = c === "today_date_only";
    // read on the interview's day (today), the day after or later (over), or days before (upcoming)
    read = today ? Date.parse(`${date}T12:00:00Z`) : c === "over_date_only" ? ivDay + int(r, 1, 3) * DAY : sent + int(r, 5, 60) * MIN;
    if (today) { while (day(read, personTz) !== date) read += day(read, personTz) < date ? HOUR : -HOUR; }
    over = day(read, personTz) > date;
    if (c === "upcoming_date_only" && over) read = sent + 10 * MIN;
    over = day(read, personTz) > date;
  } else {
    const ivDay = sent + int(r, 1, 4) * DAY;
    date = day(ivDay, z.tz); time = hhmm; start = zonedInstant(date, time, z.tz);
    if (start <= sent + HOUR) { date = day(sent + 2 * DAY, z.tz); start = zonedInstant(date, time, z.tz); }
    read = c === "over_stated" ? start + int(r, 1, 72) * HOUR : c === "over_by_minutes" ? start + int(r, 1, 59) * MIN : c === "upcoming_soon" ? start - int(r, 5, 90) * MIN : sent + int(r, 5, 120) * MIN;
    over = read >= start;
  }
  read = Math.max(read, sent + 5 * MIN);
  if (!dateOnly) over = read >= start!; else over = day(read, personTz) > date;
  const runs = c === "two_at_once" ? [[read, read]] : c === "retried" ? [[read], [read + 5 * MIN]] : [[read]];
  return { kind: "briefs", category: c, personTz, company, role, sent, read, firstRead: chance(r, 0.4), date, time, zone: dateOnly ? null : z.tz, zoneSaid: dateOnly ? null : z.said, start, runs, over };
}

// ------------------------------------------------------------------------------------------------ budget
export type BudgetCase = "refused_from_first" | "refused_mid_run" | "person_gate_zero" | "person_gate_some" | "paused_by_env";
export interface BudgetScenario { kind: "budget"; category: BudgetCase; now: number; people: { id: string; company: string; vague: number; invite: boolean; clear: boolean; gate: number }[]; refuseAfter: number }
function budget(r: R, i: number): BudgetScenario {
  const c = pick(r, ["refused_from_first", "refused_mid_run", "person_gate_zero", "person_gate_some", "paused_by_env"] as BudgetCase[]);
  const people = Array.from({ length: int(r, 1, 5) }, (_, k) => ({ id: `b${i}u${k}`, company: pick(r, ["Asana", "Globex", "Initech", "Hooli"]), vague: int(r, 0, 4), invite: chance(r, 0.5), clear: chance(r, 0.5),
    gate: c === "person_gate_zero" ? 0 : c === "person_gate_some" ? int(r, 0, 3) : 200 }));
  return { kind: "budget", category: c, now: NOW + int(r, 0, 10) * HOUR, people, refuseAfter: c === "refused_mid_run" ? int(r, 1, 5) : c === "person_gate_zero" || c === "person_gate_some" ? 1000 : 0 };
}

// ------------------------------------------------------------------------------------------------ pause
export type PauseCase = "paused" | "stop" | "erased" | "opted_out_then_back";
export interface PauseScenario { kind: "pause"; category: PauseCase; now: number; tz: string; flipAt: number; backAt: number | null }
function pause(r: R): PauseScenario {
  const c = pick(r, ["paused", "stop", "erased", "opted_out_then_back"] as PauseCase[]);
  const flipAt = int(r, 0, 6);
  return { kind: "pause", category: c, now: NOW + int(r, 0, 6) * DAY + int(r, 0, 23) * HOUR + 2 * MIN, tz: pick(r, ZONES), flipAt, backAt: c === "opted_out_then_back" ? flipAt + int(r, 1, 3) : null };
}

export type R4Scenario = ZoneScenario | AppliedScenario | CatchupScenario | BriefScenario | BudgetScenario | PauseScenario;
export const COUNTS = { zones: 1600, applied: 3000, catchup: 1000, briefs: 2200, budget: 800, pause: 1400 } as const;
export function generate(o: { seed: number; only?: (keyof typeof COUNTS)[] }): R4Scenario[] {
  const out: R4Scenario[] = [];
  for (const kind of Object.keys(COUNTS) as (keyof typeof COUNTS)[]) {
    const r = rng(o.seed + kind.length * 7919 + kind.charCodeAt(0));
    for (let i = 0; i < COUNTS[kind]; i++) {
      const s = kind === "zones" ? zones(r, i) : kind === "applied" ? applied(r, i) : kind === "catchup" ? catchup(r, i) : kind === "briefs" ? briefs(r, i) : kind === "budget" ? budget(r, i) : pause(r);
      if (!o.only || o.only.includes(kind)) out.push(s);
    }
  }
  return out;
}
