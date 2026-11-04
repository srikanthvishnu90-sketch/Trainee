// WO-036: who a firm actually hired, from People Data Labs' Person Search API (owner decision 2026-10-20: Pro plan,
// about $98 a month for 350 credits; the secret is PDL_API_KEY; without it this rail is NOT_WIRED).
//
// The question asked of PDL: people whose work history has an entry that STARTED at firm X, in a role family, in the
// last YEARS_BACK years. Endpoint, query shape and fields from PDL's docs (checked 2026-10-20 through a search index;
// the build environment could not open the pages):
//   POST https://api.peopledatalabs.com/v5/person/search, header X-Api-Key, body { query (Elasticsearch) | sql, size,
//   scroll_token } (docs.peopledatalabs.com/docs/reference-person-search-api, /docs/input-parameters-person-search-api);
//   size is 1 to 100; each record in `data` costs one credit (the reference page and support.peopledatalabs.com
//   "Pricing & credits");
//   experience.company.name, experience.start_date, experience.title.name, education.school.name, education.degrees,
//   education.majors (docs.peopledatalabs.com/docs/fields; degrees and majors are canonical enums).
// Whether PDL matches the clauses inside ONE experience entry was not confirmed in its docs, so every returned record
// is checked again here: it counts only if one experience entry is at the firm, started on or after the year and has
// the role in its title. A record that fails the check still cost a credit; the call log says so (kept vs returned).
//
// Aggregates only, never a named person. toSafeRecord is the boundary: it keeps company names, titles, dates, school
// names, degrees and majors, and nothing else, before anything is counted, cached or logged. Names, profile URLs,
// emails, phones, addresses and ids never pass it. A count under MIN_N is "too few to say".
//
// Hired-background frequencies are NOT a probability of being hired: they describe people who joined, drawn from PDL's
// coverage (not all hires, and skewed toward people with public profiles). Nothing here computes or implies odds; the
// answer says so in words.
export const PDL_SEARCH_URL = "https://api.peopledatalabs.com/v5/person/search";
export const PDL_DOCS = "https://docs.peopledatalabs.com/docs/reference-person-search-api";
export const MIN_N = 5;
export const YEARS_BACK = 3;
export const CACHE_MS = 30 * 86400_000;
export const DEFAULT_SIZE = 25; // records per call: 350 credits a month is 14 fresh questions
export const DEFAULT_MONTHLY_BUDGET = 300; // credits; leaves 50 of the 350 for the owner's own checks
export const NOT_WIRED_ASK = "Data on who was hired at a company isn't connected yet, so I can't look that up.";

// PDL's cleaned company names are lowercase; these phrases are matched as phrases, and a name containing an excluded
// word is a different company ("citadel securities" is not Citadel). Unverified against PDL's canonical names until
// the first live call; the check in verify() keeps only records that really match.
const PDL_COMPANY: Record<string, { phrase: string; exclude?: string[] }> = {
  "palantir": { phrase: "palantir" }, "goldman-sachs": { phrase: "goldman sachs" }, "jpmorgan": { phrase: "jpmorgan" },
  "mckinsey": { phrase: "mckinsey" }, "google": { phrase: "google" }, "jane-street": { phrase: "jane street" },
  "citadel": { phrase: "citadel", exclude: ["securities"] }, "citadel-securities": { phrase: "citadel securities" },
  "morgan-stanley": { phrase: "morgan stanley" }, "bcg": { phrase: "boston consulting group" }, "bain": { phrase: "bain & company" },
  "microsoft": { phrase: "microsoft" }, "amazon": { phrase: "amazon" }, "meta": { phrase: "meta" }, "stripe": { phrase: "stripe" },
  "blackstone": { phrase: "blackstone" }, "two-sigma": { phrase: "two sigma" }, "hudson-river-trading": { phrase: "hudson river trading" },
  "de-shaw": { phrase: "d. e. shaw" }, "evercore": { phrase: "evercore" }, "deloitte": { phrase: "deloitte" }, "point72": { phrase: "point72" },
};
export function pdlCompany(firm: { firm_id: string; name: string }): { phrase: string; exclude: string[] } {
  const c = PDL_COMPANY[firm.firm_id];
  return { phrase: (c?.phrase ?? firm.name).toLowerCase(), exclude: c?.exclude ?? [] };
}

// ---------- the boundary: what may leave a PDL record ----------
export interface SafeJob { company: string; title: string; start: string | null; end: string | null }
export interface SafeSchool { school: string; degrees: string[]; majors: string[]; end: string | null }
export interface SafeRecord { jobs: SafeJob[]; schools: SafeSchool[] }
const s = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const d = (v: unknown) => (typeof v === "string" && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v.trim()) ? v.trim() : null);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => String(x).toLowerCase()).slice(0, 5) : []);
export function toSafeRecord(raw: any): SafeRecord {
  const jobs = (Array.isArray(raw?.experience) ? raw.experience : []).slice(0, 40).map((e: any) => ({
    company: s(e?.company?.name), title: s(e?.title?.name), start: d(e?.start_date), end: d(e?.end_date),
  }));
  const schools = (Array.isArray(raw?.education) ? raw.education : []).slice(0, 10).map((e: any) => ({
    school: s(e?.school?.name), degrees: list(e?.degrees), majors: list(e?.majors), end: d(e?.end_date),
  }));
  return { jobs, schools };
}

// ---------- which records count ----------
const STOP = new Set(["summer", "intern", "internship", "new", "grad", "graduate", "full", "time", "entry", "level", "junior", "the", "a", "an", "as"]);
export function roleTokens(role: string): string[] {
  return String(role ?? "").toLowerCase().replace(/[^a-z0-9+# ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).slice(0, 4);
}
export function roleFamily(role: string): string { return roleTokens(role).join(" "); }
const year = (date: string | null) => (date ? Number(date.slice(0, 4)) : NaN);
function atFirm(name: string, co: { phrase: string; exclude: string[] }): boolean {
  return ` ${name} `.includes(` ${co.phrase} `) && !co.exclude.some((x) => name.includes(x));
}
// The experience entry that makes this record count: at the firm, started on or after `since`, with the role in its title.
export function joinOf(r: SafeRecord, co: { phrase: string; exclude: string[] }, since: number, tokens: string[]): SafeJob | null {
  return r.jobs.find((j) => atFirm(j.company, co) && year(j.start) >= since && tokens.every((t) => j.title.split(/\s+/).includes(t) || j.title.includes(t))) ?? null;
}

// ---------- aggregates ----------
export interface Bucket { value: string; count: number }
export interface HiredAggregate {
  source: "pdl"; firm_id: string; role_family: string; since_year: number; n: number;
  schools: Bucket[]; prior_employers: Bucket[]; degrees: Bucket[]; majors: Bucket[];
  median_years_school_to_join: number | null; years_n: number;
  fetched_at: string;
}
function top(values: string[], min: number): Bucket[] {
  const c = new Map<string, number>();
  for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([value, count]) => ({ value, count }));
}
const months = (date: string) => year(date) * 12 + (date.length >= 7 ? Number(date.slice(5, 7)) - 1 : 0);
export function aggregate(records: SafeRecord[], o: { firm: { firm_id: string; name: string }; role: string; since: number; now: number }): HiredAggregate {
  const co = pdlCompany(o.firm), tokens = roleTokens(o.role);
  const schools: string[] = [], prior: string[] = [], degrees: string[] = [], majors: string[] = [], years: number[] = [];
  let n = 0;
  for (const r of records) {
    const join = joinOf(r, co, o.since, tokens);
    if (!join || !join.start) continue;
    n++;
    // Each person counts once per value: two degrees from one school is one school.
    const before = r.schools.filter((e) => !e.end || e.end <= join.start!);
    for (const v of new Set(before.map((e) => e.school))) schools.push(v);
    for (const v of new Set(before.flatMap((e) => e.degrees))) degrees.push(v);
    for (const v of new Set(before.flatMap((e) => e.majors))) majors.push(v);
    const prev = r.jobs.filter((j) => j.start && j.start < join.start! && !atFirm(j.company, co) && j.company).sort((a, b) => b.start!.localeCompare(a.start!))[0];
    if (prev) prior.push(prev.company);
    const done = before.map((e) => e.end).filter((x): x is string => !!x).sort().pop();
    if (done) years.push(Math.max(0, (months(join.start) - months(done)) / 12));
  }
  years.sort((a, b) => a - b);
  const median = years.length >= MIN_N ? Math.round((years.length % 2 ? years[(years.length - 1) / 2] : (years[years.length / 2 - 1] + years[years.length / 2]) / 2) * 10) / 10 : null;
  return {
    source: "pdl", firm_id: o.firm.firm_id, role_family: tokens.join(" "), since_year: o.since, n,
    schools: n >= MIN_N ? top(schools, MIN_N) : [], prior_employers: n >= MIN_N ? top(prior, MIN_N) : [],
    degrees: n >= MIN_N ? top(degrees, MIN_N) : [], majors: n >= MIN_N ? top(majors, MIN_N) : [],
    median_years_school_to_join: n >= MIN_N ? median : null, years_n: years.length,
    fetched_at: new Date(o.now).toISOString(),
  };
}

// ---------- the store: 30-day cache and the credit log ----------
export interface PdlCall { firm_id: string; role_family: string; since_year: number; size_requested: number; records_returned: number; records_kept: number; credits: number; status: "ok" | "http_error" | "budget_refused"; http_status: number | null }
export interface HiredStore {
  cached(firm_id: string, role_family: string, since_year: number): Promise<{ aggregates: HiredAggregate; fetched_at: string } | null>;
  save(a: HiredAggregate): Promise<void>;
  creditsThisMonth(now: number): Promise<number>;
  logCall(c: PdlCall): Promise<void>;
}
export function supabaseHiredStore(admin: any): HiredStore {
  return {
    async cached(firm_id, role_family, since_year) {
      const { data, error } = await admin.from("career_hired_cache").select("aggregates,fetched_at").eq("firm_id", firm_id).eq("role_family", role_family).eq("since_year", since_year).maybeSingle();
      if (error) throw new Error(`hired cache: ${error.message}`);
      return data ? { aggregates: data.aggregates as HiredAggregate, fetched_at: String(data.fetched_at) } : null;
    },
    async save(a) {
      const { error } = await admin.from("career_hired_cache").upsert({ firm_id: a.firm_id, role_family: a.role_family, since_year: a.since_year, aggregates: a, fetched_at: a.fetched_at });
      if (error) throw new Error(`hired cache: ${error.message}`);
    },
    async creditsThisMonth(now) {
      const { data, error } = await admin.rpc("career_pdl_credits_month", { p_at: new Date(now).toISOString() });
      if (error) throw new Error(`pdl credits: ${error.message}`);
      return Number(data ?? 0);
    },
    async logCall(c) {
      const { error } = await admin.from("career_pdl_calls").insert(c);
      if (error) console.error("pdl call not logged:", error.message);
    },
  };
}

// ---------- the source ----------
export type HiredResult =
  | { status: "NOT_WIRED"; ask: string }
  | { status: "ok"; aggregates: HiredAggregate; cached: boolean }
  | { status: "unavailable"; reason: string };
export interface HiredSource { backgrounds(firm: { firm_id: string; name: string }, role: string, now: number): Promise<HiredResult> }

export function pdlQuery(firm: { firm_id: string; name: string }, role: string, since: number): Record<string, unknown> {
  const co = pdlCompany(firm), tokens = roleTokens(role);
  const must: unknown[] = [{ match_phrase: { "experience.company.name": co.phrase } }, { range: { "experience.start_date": { gte: `${since}-01-01` } } }];
  if (tokens.length) must.push({ match: { "experience.title.name": { query: tokens.join(" "), operator: "and" } } });
  return { bool: { must } };
}

export function pdlHiredSource(o: { key: string; store: HiredStore; fetch?: typeof fetch; size?: number; budget?: number }): HiredSource {
  const size = Math.max(1, Math.min(100, o.size ?? DEFAULT_SIZE)), budget = o.budget ?? DEFAULT_MONTHLY_BUDGET;
  const get = o.fetch ?? fetch;
  return {
    async backgrounds(firm, role, now) {
      const since = new Date(now).getUTCFullYear() - YEARS_BACK, family = roleFamily(role);
      const hit = await o.store.cached(firm.firm_id, family, since);
      if (hit && now - Date.parse(hit.fetched_at) < CACHE_MS) return { status: "ok", aggregates: hit.aggregates, cached: true };
      const used = await o.store.creditsThisMonth(now);
      const base = { firm_id: firm.firm_id, role_family: family, since_year: since };
      if (used + size > budget) {
        await o.store.logCall({ ...base, size_requested: 0, records_returned: 0, records_kept: 0, credits: 0, status: "budget_refused", http_status: null });
        return { status: "unavailable", reason: `this month's hired-data budget is used (${used} of ${budget} credits)` };
      }
      const res = await get(PDL_SEARCH_URL, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": o.key },
        body: JSON.stringify({ query: pdlQuery(firm, role, since), size }),
      });
      let body: any = null;
      try { body = await res.json(); } catch { body = null; }
      // PDL answers 404 when nothing matches; that is zero people, not an error.
      if (!res.ok && res.status !== 404) {
        await o.store.logCall({ ...base, size_requested: size, records_returned: 0, records_kept: 0, credits: 0, status: "http_error", http_status: res.status });
        return { status: "unavailable", reason: `People Data Labs answered ${res.status}` };
      }
      const raw: unknown[] = Array.isArray(body?.data) ? body.data : [];
      // The boundary: nothing but SafeRecord fields goes past this line.
      const safe = raw.map(toSafeRecord);
      const agg = aggregate(safe, { firm, role, since, now });
      await o.store.logCall({ ...base, size_requested: size, records_returned: raw.length, records_kept: agg.n, credits: raw.length, status: "ok", http_status: res.status });
      await o.store.save(agg);
      return { status: "ok", aggregates: agg, cached: false };
    },
  };
}

// The rail is live only with the owner's key; without it every answer keeps the honest one-line "no data yet".
export function hiredSourceFromEnv(env: { get(k: string): string | undefined }, admin: any): HiredSource {
  // Paid provider: off unless CAREER_PDL=on (2026-10-22, default OFF). A key alone never makes a request.
  const key = env.get("CAREER_PDL") === "on" ? env.get("PDL_API_KEY") : undefined;
  if (!key) return { backgrounds: async () => ({ status: "NOT_WIRED", ask: NOT_WIRED_ASK }) };
  const size = Number(env.get("PDL_SEARCH_SIZE") || DEFAULT_SIZE), budget = Number(env.get("PDL_MONTHLY_CREDITS") || DEFAULT_MONTHLY_BUDGET);
  return pdlHiredSource({ key, store: supabaseHiredStore(admin), size, budget });
}

// ---------- in words ----------
const titled = (v: string) => v.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Of|And|At|The|In|For)\b/g, (m) => m.toLowerCase());
const buckets = (b: Bucket[], what: string) => b.length ? `${what}: ${b.map((x) => `${titled(x.value)} (${x.count})`).join(", ")}.` : `${what}: too few to say.`;
export function hiredText(a: HiredAggregate, firmName: string, role: string): string {
  const who = `people who joined ${firmName}${role ? ` as ${role}` : ""} since ${a.since_year}`;
  if (a.n < MIN_N) return `People Data Labs has ${a.n} ${who}: too few to say who they hired.`;
  return [
    `Who they hired, from People Data Labs: ${a.n} ${who} (PDL's coverage, not all hires).`,
    buckets(a.schools, "Schools"), buckets(a.prior_employers, "Worked before at"), buckets(a.majors, "Majors"), buckets(a.degrees, "Degrees"),
    a.median_years_school_to_join != null ? `Median ${a.median_years_school_to_join} years from finishing school to joining (${a.years_n} with dates).` : "Years from school to joining: too few to say.",
    "These are backgrounds of people who joined, not your chance of getting in.",
  ].join(" ");
}
