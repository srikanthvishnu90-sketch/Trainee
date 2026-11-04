// Proactive briefs and job alerts at scale (2026-10-29): a deterministic, seeded generator of what Trainee sends without
// being asked, each with what must happen. The product code is never consulted here: every expectation (which postings are
// news to whom, how many fit in a day, when quiet hours end on the person's clock, which week a digest belongs to, who is
// paused) comes from how the scenario was built, with clock arithmetic of its own (Intl, minute by minute).
//
//   plan     the planner alone (career_alerts.ts planProactive): people in every kind of zone (half and quarter hours,
//            daylight-saving nights, a zone the runtime does not know, none), their watches, caps, quiet hours, report
//            hour and fit floor, against postings that match or almost match (a word short, another city, closed, an http
//            link, a board's backlog, seen before the last check), each with a fit (a score, none, a knockout).
//   run      the scheduled alerts run (career_proactive_run.ts runAlerts) over days, with faults: a run that queues and
//            then dies before saving its counters, a queue write that fails once, the same run again, two runs at once;
//            one person's unknown zone among everyone else's.
//   quiet    the whole scheduled handler (career-proactive handleProactive) with every rail wired (alerts, receipts,
//            cards, questions, asks, digest), for people awake, paused, opted out (STOP) and erased, then START.
//   digest   the weekly digest (runDigest) at every hour of a week, in every kind of zone, digest on or off.
//   deliver  the delivery of what was queued (channel.ts deliverDue): alerts, reports, briefs, digests and receipts of
//            every age, people paused or stopped, alerts no longer wanted.
//   budget   the mail second pass behind the global model budget (career_mail_model.ts through model_gateway.ts), with a
//            fake provider: budgets that fit no call, some, all; usage reported or missing.
//   dst      quiet hours across daylight-saving nights in every zone that has them.

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type R = ReturnType<typeof rng>;
export const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const chance = (r: R, p: number) => r() < p;
export const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export const MIN = 60000, HOUR = 3600000, DAY = 86400000;
export const NOW = Date.parse("2026-10-29T15:00:00Z");
export const DEFAULT_ZONE = "America/New_York";

// ------------------------------------------------------------------------------------------------ clocks (the oracle's own)
export const GOOD_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/St_Johns",
  "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Europe/Dublin", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Tokyo", "Australia/Sydney",
  "Australia/Lord_Howe", "Pacific/Chatham", "Pacific/Auckland", "UTC", "Africa/Lagos", "Asia/Tehran"] as const;
// What a table that checks only a length can hold: a typo, a person's words, nothing.
export const BAD_ZONES = ["Pacific Time", "Mars/Olympus_Mons", "", "New York", "GMT+25", "america/newyork"] as const;
// Nights the clocks change, in the zones that change them.
export const DST_NIGHTS: { tz: string; at: number }[] = [
  { tz: "America/New_York", at: Date.parse("2026-03-08T07:00:00Z") }, { tz: "America/New_York", at: Date.parse("2026-11-01T06:00:00Z") },
  { tz: "America/Chicago", at: Date.parse("2026-03-08T08:00:00Z") }, { tz: "America/Chicago", at: Date.parse("2026-11-01T07:00:00Z") },
  { tz: "America/Los_Angeles", at: Date.parse("2026-03-08T10:00:00Z") }, { tz: "America/Los_Angeles", at: Date.parse("2026-11-01T09:00:00Z") },
  { tz: "America/St_Johns", at: Date.parse("2026-03-08T05:30:00Z") }, { tz: "Europe/London", at: Date.parse("2026-03-29T01:00:00Z") },
  { tz: "Europe/London", at: Date.parse("2026-10-25T01:00:00Z") }, { tz: "Europe/Berlin", at: Date.parse("2026-03-29T01:00:00Z") },
  { tz: "Europe/Berlin", at: Date.parse("2026-10-25T01:00:00Z") }, { tz: "Australia/Sydney", at: Date.parse("2026-04-04T16:00:00Z") },
  { tz: "Australia/Sydney", at: Date.parse("2026-10-03T16:00:00Z") }, { tz: "Australia/Lord_Howe", at: Date.parse("2026-04-04T15:00:00Z") },
  { tz: "Pacific/Chatham", at: Date.parse("2026-04-04T14:00:00Z") }, { tz: "America/Sao_Paulo", at: Date.parse("2026-10-29T03:00:00Z") },
];
export function zoneOk(tz: unknown): boolean {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
// The zone a person's clock must be read in: their own, or the product's stated default when theirs is unknown.
export const effectiveZone = (tz: unknown) => (zoneOk(tz) ? String(tz) : DEFAULT_ZONE);
const fmt = new Map<string, Intl.DateTimeFormat>();
export function clock(at: number, tz: string): { date: string; hour: number; minute: number; weekday: number } {
  let f = fmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }); fmt.set(tz, f); }
  const p = f.formatToParts(new Date(at)), g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, minute: Number(g("minute")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
}
export const inQuiet = (hour: number, qs: number, qe: number) => qs === qe ? false : qs > qe ? hour >= qs || hour < qe : hour >= qs && hour < qe;
export const quietOn = (at: number, tz: string, qs: number, qe: number) => inQuiet(clock(at, tz).hour, qs, qe);
// The earliest quarter hour at or after `from` that is outside quiet hours on the person's clock: what "waits out quiet
// hours" means. Minute by minute would be the same answer for every zone on the 15-minute grid.
export function firstAwake(from: number, tz: string, qs: number, qe: number): number {
  for (let t = Math.ceil(from / (15 * MIN)) * 15 * MIN; t < from + 3 * DAY; t += 15 * MIN) if (!quietOn(t, tz, qs, qe)) return t;
  return Infinity;
}
export function isoWeekOf(date: string): string {
  const t = new Date(`${date}T00:00:00Z`), dow = (t.getUTCDay() + 6) % 7;
  const thu = new Date(t.getTime() + (3 - dow) * DAY), y = thu.getUTCFullYear();
  return `${y}-W${String(1 + Math.floor((thu.getTime() - Date.UTC(y, 0, 1)) / (7 * DAY))).padStart(2, "0")}`;
}

// ------------------------------------------------------------------------------------------------ people and postings
export const ROLES = [
  { kw: "data analyst", hit: ["Data Analyst", "Senior Data Analyst", "Data Analyst II", "Analyst, Data Platform", "Lead Data Analyst (SQL)"], miss: ["Metadata Analyst", "Data Engineer", "Business Analyst", "Analytics Manager"] },
  { kw: "product designer", hit: ["Product Designer", "Senior Product Designer", "Designer, Product (Growth)"], miss: ["Product Manager", "Graphic Designer", "Production Designer"] },
  { kw: "software engineer", hit: ["Software Engineer", "Software Engineer, Backend", "Senior Software Engineer II"], miss: ["Software Developer", "Sales Engineer", "Engineering Manager"] },
  { kw: "financial analyst", hit: ["Financial Analyst", "Senior Financial Analyst", "Analyst - Financial Planning"], miss: ["Finance Manager", "Financial Advisor", "Credit Analyst"] },
  { kw: "supply chain analyst", hit: ["Supply Chain Analyst", "Analyst, Supply Chain"], miss: ["Supply Chain Manager", "Supply Planner"] },
] as const;
export const COMPANIES = ["Acme", "Globex", "Initech", "Hooli", "Umbrella", "Vandelay Industries", "Wonka & Sons", "Cyberdyne", "Müller GmbH", "São Paulo Labs", "AT&T", "R&D Co"];
export const CITIES = [{ name: "New York, NY", watch: "new york" }, { name: "Austin, TX", watch: "austin" }, { name: "Chicago, IL", watch: "chicago" }, { name: "Remote", watch: null }];

export interface GenPosting {
  job_id: string; title: string; company: string; location: string; url: string; first_seen_at: string; posted_at?: string; closed_at?: string | null;
  // how it was built, for the oracle
  kw: string; titleHit: boolean; city: string; remote: boolean; https: boolean; closed: boolean; backlog: boolean;
}
export interface GenFit { score: number | null; excluded: boolean }
export interface GenPerson {
  id: string; tz: string | null; zoneKnown: boolean; role: (typeof ROLES)[number];
  prefs: { on: boolean; keywords: string[]; locations: string[]; remote_ok: boolean; report_hour: number; quiet_start: number; quiet_end: number; max_instant_per_day: number; max_per_week?: number; min_fit?: number };
  last_checked_at: string; instant_sent_today: number; sent_on: string | null; last_report_on: string | null; held: string[]; sent_this_week: number;
}

let serial = 0;
export function posting(r: R, role: (typeof ROLES)[number], o: { seen: number; id?: string } ): GenPosting {
  const id = o.id ?? `greenhouse:scen:${++serial}`;
  const titleHit = chance(r, 0.7), city = pick(r, CITIES), https = chance(r, 0.93), closed = chance(r, 0.07), backlog = chance(r, 0.07);
  const posted = backlog ? o.seen - int(r, 4, 30) * DAY : chance(r, 0.3) ? null : o.seen - int(r, 0, 48) * HOUR;
  const title = titleHit ? pick(r, role.hit) : pick(r, role.miss);
  return {
    job_id: id, title: chance(r, 0.05) ? `  ${title}\n` : title, company: pick(r, COMPANIES), location: city.name,
    url: https ? `https://boards.greenhouse.io/${id.split(":").pop()}/jobs/${serial}` : `http://jobs.example.com/${serial}`,
    first_seen_at: new Date(o.seen).toISOString(), ...(posted !== null ? { posted_at: new Date(posted).toISOString() } : {}), closed_at: closed ? new Date(o.seen + HOUR).toISOString() : null,
    kw: role.kw, titleHit, city: city.name, remote: city.watch === null, https, closed, backlog,
  };
}
export function person(r: R, n: number, now: number, o: { zone?: string | null; minFit?: boolean } = {}): GenPerson {
  const role = pick(r, ROLES);
  const tz = o.zone !== undefined ? o.zone : chance(r, 0.1) ? pick(r, BAD_ZONES) : chance(r, 0.03) ? null : pick(r, GOOD_ZONES);
  const qs = pick(r, [22, 22, 21, 23, 0, 20, 9, 13]), qe = pick(r, [7, 7, 6, 8, 2, 9, 9, 13]);
  const locations = chance(r, 0.5) ? [] : [pick(r, CITIES.filter((c) => c.watch)).watch!];
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, tz, zoneKnown: zoneOk(tz), role,
    prefs: { on: true, keywords: [role.kw], locations, remote_ok: chance(r, 0.8), report_hour: pick(r, [8, 8, 9, 7, 18, 23, 0, 6]), quiet_start: qs, quiet_end: qe,
      max_instant_per_day: pick(r, [3, 3, 1, 0, 5, 10]), ...(chance(r, 0.2) ? { max_per_week: pick(r, [0, 2, 5, 15, 25]) } : {}),
      ...(o.minFit !== false && chance(r, 0.35) ? { min_fit: pick(r, [0, 40, 60, 75, 90, 100]) } : {}) },
    last_checked_at: new Date(now - int(r, 5, 300) * MIN).toISOString(), instant_sent_today: 0, sent_on: null,
    last_report_on: chance(r, 0.5) ? clock(now, effectiveZone(tz)).date : null, held: [], sent_this_week: 0,
  };
}
// Whether a posting fits the person's watch, from how both were built: the keyword phrase in the title (hit titles only),
// the place (no places, or the watched city; remote when the watch takes remote), an https link, open.
export function matches(p: GenPosting, u: GenPerson): boolean {
  if (p.kw !== u.role.kw || !p.titleHit || !p.https || p.closed) return false;
  if (p.remote) return u.prefs.remote_ok;
  return !u.prefs.locations.length || u.prefs.locations.some((l) => p.city.toLowerCase().includes(l));
}
export const news = (p: GenPosting) => !p.backlog;
export function floorOk(fit: GenFit | undefined, u: GenPerson): boolean {
  if (fit?.excluded) return false;
  if (u.prefs.min_fit === undefined) return true;
  return !!fit && fit.score !== null && fit.score >= u.prefs.min_fit;
}

// ------------------------------------------------------------------------------------------------ the kinds
export interface PlanScenario { kind: "plan"; category: string; now: number; people: GenPerson[]; postings: GenPosting[]; fits: Record<string, Record<string, GenFit>> }
export type Fault = "none" | "crash_after_queue" | "queue_fails_once" | "same_run_again" | "two_at_once";
export interface RunScenario { kind: "run"; category: string; people: GenPerson[]; runs: { now: number; fault: Fault; who: number; postings: GenPosting[] }[] }
export type QuietState = "awake" | "paused" | "opted_out" | "erased";
export interface QuietScenario {
  kind: "quiet"; category: string; now: number;
  people: (GenPerson & { state: QuietState; receipts: { id: string; state: string; company: string }[]; cards: { id: string; company: string; created_at: string }[];
    questions: { id: string; label: string; created_at: string }[]; ask: { hash: string; text: string } | null; digest: { day: number; hour: number } | null })[];
  postings: GenPosting[];
}
export interface DigestScenario {
  kind: "digest"; category: string; runs: number[];
  people: { id: string; tz: string | null; prefs: { on: boolean; day: number; hour: number } | null; quiet_start?: number; quiet_end?: number; alerts: number; apps: number }[];
}
export interface DeliverRow { id: string; userId: string; contact: string; key: string; kind: string; text: string; deliver_at: number }
export interface DeliverScenario {
  kind: "deliver"; category: string; now: number; rows: DeliverRow[];
  people: { id: string; contact: string; stopped: boolean; paused: boolean; alertsWanted: boolean }[];
}
export interface BudgetScenario { kind: "budget"; category: string; now: number; people: number; perPerson: number; limitCalls: number; usage: "proven" | "missing" | "mixed" }
export interface DstScenario { kind: "dst"; category: string; now: number; person: GenPerson; postings: GenPosting[] }
export type Scenario = PlanScenario | RunScenario | QuietScenario | DigestScenario | DeliverScenario | BudgetScenario | DstScenario;

const fitFor = (r: R): GenFit => chance(r, 0.08) ? { score: int(r, 0, 100), excluded: true } : chance(r, 0.12) ? { score: null, excluded: false } : { score: int(r, 0, 100), excluded: false };

function planScenario(r: R, i: number): PlanScenario {
  const now = NOW + int(r, -10 * 24, 10 * 24) * HOUR + int(r, 0, 59) * MIN;
  const people = Array.from({ length: int(r, 1, 3) }, (_, k) => person(r, i * 10 + k, now));
  for (const u of people) { u.instant_sent_today = chance(r, 0.3) ? int(r, 0, 4) : 0; u.sent_this_week = chance(r, 0.3) ? int(r, 0, 20) : 0; }
  const postings: GenPosting[] = [];
  const fits: Record<string, Record<string, GenFit>> = {};
  for (const u of people) {
    fits[u.id] = {};
    const since = Date.parse(u.last_checked_at);
    for (let k = 0, n = int(r, 0, 9); k < n; k++) {
      // Seen after the last check (most), at its very instant, or before it (already planned once). Unique instants, so
      // freshest-first is one order.
      const when = pick(r, ["after", "after", "after", "at", "before", "long_before"]);
      const seen = when === "at" ? since : when === "before" ? since - int(r, 1, 60) * MIN : when === "long_before" ? now - int(r, 27, 60) * HOUR : since + Math.min(now - since, int(r, 0, Math.max(0, Math.floor((now - since) / MIN))) * MIN);
      const p = posting(r, u.role, { seen: seen + (postings.length % 59) * 1000 });
      postings.push(p);
      fits[u.id][p.job_id] = fitFor(r);
    }
    // A posting held back on an earlier day, still open or closed since.
    if (chance(r, 0.2)) { const p = posting(r, u.role, { seen: now - int(r, 30, 70) * HOUR }); postings.push(p); u.held = [p.job_id]; fits[u.id][p.job_id] = fitFor(r); }
  }
  return { kind: "plan", category: `plan/${people.some((u) => !u.zoneKnown) ? "unknown-zone" : "zones"}`, now, people, postings, fits };
}

function runScenario(r: R, i: number): RunScenario {
  const start = NOW + int(r, -5 * 24, 5 * 24) * HOUR;
  const people = Array.from({ length: int(r, 1, 4) }, (_, k) => {
    const u = person(r, 50000 + i * 10 + k, start, { minFit: false });
    u.last_checked_at = new Date(start - HOUR).toISOString();
    return u;
  });
  // A person whose zone is unknown among the rest, often.
  if (people.length > 1 && chance(r, 0.4)) { people[0].tz = pick(r, BAD_ZONES); people[0].zoneKnown = false; }
  const runs: RunScenario["runs"] = [];
  let at = start;
  for (let k = 0, n = int(r, 2, 6); k < n; k++) {
    at += pick(r, [5 * MIN, 5 * MIN, 30 * MIN, 3 * HOUR, 9 * HOUR, 20 * HOUR]);
    const fresh: GenPosting[] = [];
    for (const u of people) for (let j = 0, m = int(r, 0, 4); j < m; j++) fresh.push(posting(r, u.role, { seen: at - int(r, 1, 4) * MIN - j * 1000 }));
    runs.push({ now: at, fault: k === 0 ? "none" : pick(r, ["none", "none", "crash_after_queue", "queue_fails_once", "same_run_again", "two_at_once"] as Fault[]), who: int(r, 0, people.length - 1), postings: fresh });
  }
  return { kind: "run", category: `run/${runs.some((x) => x.fault !== "none") ? "faults" : "clean"}${people.some((u) => !u.zoneKnown) ? "+unknown-zone" : ""}`, people, runs };
}

const STATES: QuietState[] = ["awake", "awake", "paused", "opted_out", "erased"];
function quietScenario(r: R, i: number): QuietScenario {
  // The first minutes of an hour, so the digest is checked, at an hour that is daytime for most.
  const now = Date.parse("2026-11-01T00:00:00Z") + int(r, 0, 6) * DAY + int(r, 0, 23) * HOUR + int(r, 0, 4) * MIN;
  const postings: GenPosting[] = [];
  const people = Array.from({ length: int(r, 1, 4) }, (_, k) => {
    const u = person(r, 90000 + i * 10 + k, now, { minFit: false });
    u.last_checked_at = new Date(now - 2 * HOUR).toISOString();
    for (let j = 0, m = int(r, 0, 4); j < m; j++) postings.push(posting(r, u.role, { seen: now - int(r, 5, 100) * MIN - j * 1000 }));
    const local = clock(now, effectiveZone(u.tz));
    return {
      ...u, state: pick(r, STATES),
      receipts: Array.from({ length: int(r, 0, 2) }, (_, j) => ({ id: `app-${i}-${k}-${j}`, state: pick(r, ["confirmed", "submitted_unconfirmed", "failed", "needs_user"]), company: pick(r, COMPANIES) })),
      cards: chance(r, 0.5) ? [{ id: `prep-${i}-${k}`, company: pick(r, COMPANIES), created_at: new Date(now - 2 * HOUR).toISOString() }] : [],
      questions: chance(r, 0.4) ? [{ id: `q-${i}-${k}`, label: "Are you authorized to work in the United States?", created_at: new Date(now - 3 * HOUR).toISOString() }] : [],
      ask: chance(r, 0.3) ? { hash: `h${i}${k}`, text: `Which application does this email confirm? 1) ${pick(r, COMPANIES)} 2) ${pick(r, COMPANIES)}` } : null,
      digest: chance(r, 0.5) ? { day: local.weekday, hour: Math.max(0, local.hour - int(r, 0, 3)) } : null,
    };
  });
  return { kind: "quiet", category: `quiet/${[...new Set(people.map((p) => p.state))].sort().join("+")}`, now, people, postings };
}

function digestScenario(r: R, i: number): DigestScenario {
  const week = chance(r, 0.25);
  const start = Date.parse("2026-10-25T00:00:00Z") + int(r, 0, 20) * DAY;
  const runs = week ? Array.from({ length: 8 * 24 }, (_, h) => start + h * HOUR + int(r, 0, 4) * MIN) : Array.from({ length: int(r, 1, 3) }, () => start + int(r, 0, 7 * 24) * HOUR + pick(r, [0, 1, 4, 5, 30]) * MIN);
  const people = Array.from({ length: int(r, 1, 3) }, (_, k) => {
    const tz = chance(r, 0.12) ? pick(r, BAD_ZONES) : chance(r, 0.05) ? null : pick(r, GOOD_ZONES);
    return { id: `00000000-0000-4000-8000-${String(200000 + i * 10 + k).padStart(12, "0")}`, tz,
      prefs: chance(r, 0.3) ? null : { on: chance(r, 0.9), day: int(r, 0, 6), hour: pick(r, [18, 9, 0, 23, 7, 12]) },
      ...(chance(r, 0.6) ? { quiet_start: pick(r, [22, 21, 23, 17]), quiet_end: pick(r, [7, 8, 6]) } : {}),
      alerts: chance(r, 0.3) ? 0 : int(r, 1, 12), apps: chance(r, 0.5) ? 0 : int(r, 1, 5) };
  });
  return { kind: "digest", category: `digest/${week ? "week" : "spot"}${people.some((p) => !zoneOk(p.tz)) ? "+unknown-zone" : ""}`, runs, people };
}

function deliverScenario(r: R, i: number): DeliverScenario {
  const now = NOW + int(r, 0, 10) * DAY;
  const people = Array.from({ length: int(r, 1, 3) }, (_, k) => ({ id: `u${i}-${k}`, contact: `+1555${String(i).padStart(4, "0")}${k}`, stopped: chance(r, 0.15), paused: chance(r, 0.15), alertsWanted: chance(r, 0.85) }));
  const rows: DeliverRow[] = [];
  for (const p of people) {
    for (let j = 0, n = int(r, 1, 6); j < n; j++) {
      const kind = pick(r, ["alert", "alert", "report", "brief", "digest", "receipt", "status"]);
      const age = pick(r, [0, 5 * MIN, 3 * HOUR, 30 * HOUR, 47 * HOUR, 49 * HOUR, 4 * DAY, 20 * DAY]);
      const key = kind === "alert" ? `alert:greenhouse:d${i}:${j}` : kind === "report" ? `report:2026-10-${String(10 + j).padStart(2, "0")}` : `${kind}:d${i}-${j}`;
      rows.push({ id: `${i}-${p.id}-${j}`, userId: p.id, contact: p.contact, key, kind, text: `${p.id} ${kind} ${j}: an update.`, deliver_at: now - age });
    }
  }
  return { kind: "deliver", category: `deliver/${people.some((p) => p.stopped || p.paused) ? "held" : "open"}`, now, rows, people };
}

function budgetScenario(r: R, i: number): BudgetScenario {
  return { kind: "budget", category: `budget/${pick(r, ["none", "some", "all"])}`, now: NOW + i * MIN, people: int(r, 1, 3), perPerson: int(r, 1, 3), limitCalls: int(r, 0, 9), usage: pick(r, ["proven", "missing", "mixed"] as const) };
}

function dstScenario(r: R, i: number): DstScenario {
  const night = pick(r, DST_NIGHTS);
  const now = night.at + int(r, -6 * 4, 6 * 4) * 15 * MIN;
  const u = person(r, 300000 + i, now, { zone: night.tz, minFit: false });
  // Quiet hours that end in, before and after the changed hour.
  u.prefs.quiet_start = pick(r, [22, 23, 0, 1, 21]); u.prefs.quiet_end = pick(r, [1, 2, 3, 4, 7]);
  u.prefs.max_instant_per_day = 10; u.last_checked_at = new Date(now - HOUR).toISOString(); u.last_report_on = null; u.prefs.report_hour = pick(r, [0, 1, 2, 3, 8]);
  u.prefs.locations = []; u.prefs.remote_ok = true;
  const p = posting(r, u.role, { seen: now - 10 * MIN });
  Object.assign(p, { titleHit: true, https: true, closed: false, backlog: false, closed_at: null, title: u.role.hit[0], url: `https://boards.greenhouse.io/dst/jobs/${i}` });
  delete p.posted_at;
  return { kind: "dst", category: `dst/${night.tz}`, now, person: u, postings: [p] };
}

export const COUNTS = { plan: 3000, run: 2400, quiet: 1500, digest: 1500, deliver: 1100, budget: 300, dst: 700 } as const;
export function generate(o: { seed: number }): Scenario[] {
  const r = rng(o.seed);
  serial = 0;
  const out: Scenario[] = [];
  for (let i = 0; i < COUNTS.plan; i++) out.push(planScenario(r, i));
  for (let i = 0; i < COUNTS.run; i++) out.push(runScenario(r, i));
  for (let i = 0; i < COUNTS.quiet; i++) out.push(quietScenario(r, i));
  for (let i = 0; i < COUNTS.digest; i++) out.push(digestScenario(r, i));
  for (let i = 0; i < COUNTS.deliver; i++) out.push(deliverScenario(r, i));
  for (let i = 0; i < COUNTS.budget; i++) out.push(budgetScenario(r, i));
  for (let i = 0; i < COUNTS.dst; i++) out.push(dstScenario(r, i));
  return out;
}
