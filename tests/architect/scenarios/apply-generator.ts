// Generated scenarios for the apply flow and mass submission (tests/architect/scenarios-apply.test.ts, every scenario on
// the pure functions; tests/architect/flow-scenarios-apply.test.ts, a seeded sample on real Postgres). Seeded: a run is
// the same run every time, and a failure names its input. No network, no model.
//   postings   pairs of posting links (Greenhouse, Lever, Ashby, Workday shapes): the same posting in many forms (tracking
//              parameters, query, fragment, trailing slash, case, the form's own step, the same posting on another board
//              host or reached through its id), and different postings that must never be merged (another id at the same
//              company, a near id, another family at the same company)
//   history    an earlier application in each of the queue's states, its time around the 30-day mark (29d23h, 30d, 30d1m,
//              and far either side) written in several time zones; the candidate the same posting or another at the same
//              company or elsewhere
//   employers  the person's current-employer facts (exact, one name the leading words of the other, unrelated, past,
//              wished, unconfirmed) against a posting's employer
//   resumes    an approved payload's resume binding (none, malformed, another file, the file) for the worker's own check
//   retry      Retry-After values a host may send (seconds, HTTP dates in the three RFC 9110 forms, garbage)
//   hosts      a batch over several hosts, each with a behavior (ok, 429 with or without Retry-After, 503, a verification
//              check, a sign-in wall, 500, a timeout, a refusal mid-batch)
//   crashes    a batch and the point a worker dies at (before its journal start, after it before the engine, during the
//              engine, after the engine before the record, after the record before the journal is cleared)
//   back off   hosts that refuse for load 1-12 times (429 seconds, a date, garbage, none; 503) then clear, beside hosts that
//              answer, check, wall or time out, drained by 1-3 workers; workers killed around a requeue
//   unstarted  claimed and never started: a worker stopped mid-batch, out of its lease budget, its host held (the claim
//              handed back), killed during another job's engine and restarted past the budget, beside hosts that answer,
//              check (captcha), time out, or refuse for load (a 503 with no Retry-After)
import { rng, type R } from "../scenarios-fixture.ts";
export { rng };

export const NOW = Date.parse("2026-10-29T16:00:00Z");
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ------------------------------------------------------------------------------------------------ postings
export type Family = "greenhouse" | "lever" | "ashby" | "workday";
export interface Link { url: string; job_id?: string; company?: string; title?: string }
export interface PostingCase { family: Family; form: string; same: boolean; a: Link; b: Link; company: string }

const TENANTS = ["acme", "contoso", "northwind", "fabrikam", "tailspin", "wingtip", "adatum", "litware", "proseware", "ramp", "plaid", "figma", "stripe"];
const COMPANY: Record<string, string> = {
  acme: "Acme", contoso: "Contoso", northwind: "Northwind Traders", fabrikam: "Fabrikam", tailspin: "Tailspin Toys", wingtip: "Wingtip",
  adatum: "Adatum", litware: "Litware", proseware: "Proseware", ramp: "Ramp", plaid: "Plaid", figma: "Figma", stripe: "Stripe",
};
const TITLES = ["Data Analyst", "Software Engineer Intern", "Operations Analyst", "Product Designer", "Frontend Engineer", "Research Assistant"];
const hexs = (r: R, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[r.int(0, 15)]).join("");
const uuid = (r: R) => `${hexs(r, 8)}-${hexs(r, 4)}-4${hexs(r, 3)}-${"89ab"[r.int(0, 3)]}${hexs(r, 3)}-${hexs(r, 12)}`;
const digits = (r: R, n: number) => String(r.int(1, 9)) + Array.from({ length: n - 1 }, () => String(r.int(0, 9))).join("");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const flipHex = (s: string) => s.slice(0, -1) + (s.at(-1) === "0" ? "1" : "0");
const TRACK = ["utm_source=linkedin", "utm_medium=social&utm_campaign=fall", "gh_src=abc123", "ref=newsletter", "source=LinkedIn", "lever-source=Indeed", "utm_source=x&utm_content=y"];

interface Base { family: Family; tenant: string; id: string; site?: string; loc?: string; slug?: string; wd?: number }
function base(r: R, family: Family): Base {
  const tenant = r.pick(TENANTS);
  if (family === "greenhouse") return { family, tenant, id: digits(r, r.int(5, 10)) };
  if (family === "workday") {
    return { family, tenant, id: `R${digits(r, r.int(4, 7))}`, wd: r.int(1, 12), site: r.pick(["External", "Careers", "University"]),
      loc: r.pick(["Austin-TX", "Chicago-IL", "Remote-USA", "New-York-NY"]), slug: r.pick(TITLES).replace(/ /g, "-") };
  }
  return { family, tenant, id: uuid(r) };
}
function canonical(b: Base): string {
  switch (b.family) {
    case "greenhouse": return `https://job-boards.greenhouse.io/${b.tenant}/jobs/${b.id}`;
    case "lever": return `https://jobs.lever.co/${b.tenant}/${b.id}`;
    case "ashby": return `https://jobs.ashbyhq.com/${b.tenant}/${b.id}`;
    case "workday": return `https://${b.tenant}.wd${b.wd}.myworkdayjobs.com/${b.site}/job/${b.loc}/${b.slug}_${b.id}`;
  }
}
// Forms of the same posting, per family (each a function of the canonical link and the base).
const SAME: Record<Family, Record<string, (r: R, u: string, b: Base) => Link>> = {
  greenhouse: {
    tracking: (r, u) => ({ url: `${u}?${r.pick(TRACK)}` }),
    fragment: (_r, u) => ({ url: `${u}#app` }),
    trailing_slash: (_r, u) => ({ url: `${u}/` }),
    query_fragment_slash: (r, u) => ({ url: `${u}/?${r.pick(TRACK)}#apply` }),
    host_case: (_r, u) => ({ url: u.replace("job-boards.greenhouse.io", "Job-Boards.Greenhouse.IO") }),
    other_board_host: (_r, _u, b) => ({ url: `https://boards.greenhouse.io/${b.tenant}/jobs/${b.id}` }),
    embedded_form: (_r, _u, b) => ({ url: `https://boards.greenhouse.io/embed/job_app?for=${b.tenant}&token=${b.id}` }),
    tenant_case: (_r, _u, b) => ({ url: `https://job-boards.greenhouse.io/${cap(b.tenant)}/jobs/${b.id}` }),
    by_job_id: (_r, _u, b) => ({ url: `https://www.${b.tenant}.com/careers/job?gh_jid=${b.id}`, job_id: `greenhouse:${b.tenant}:${b.id}` }),
  },
  lever: {
    tracking: (r, u) => ({ url: `${u}?${r.pick(TRACK)}` }),
    fragment: (_r, u) => ({ url: `${u}#top` }),
    trailing_slash: (_r, u) => ({ url: `${u}/` }),
    apply_step: (_r, u) => ({ url: `${u}/apply` }),
    apply_step_tracking: (r, u) => ({ url: `${u}/apply?${r.pick(TRACK)}` }),
    id_case: (_r, _u, b) => ({ url: `https://jobs.lever.co/${b.tenant}/${b.id.toUpperCase()}` }),
    host_case: (_r, u) => ({ url: u.replace("jobs.lever.co", "JOBS.LEVER.CO") }),
    tenant_case: (_r, _u, b) => ({ url: `https://jobs.lever.co/${cap(b.tenant)}/${b.id}` }),
    other_board_host: (_r, _u, b) => ({ url: `https://jobs.eu.lever.co/${b.tenant}/${b.id}` }),
    by_job_id: (_r, _u, b) => ({ url: `https://${b.tenant}.com/careers/${b.id}`, job_id: `lever:${b.tenant}:${b.id}` }),
  },
  ashby: {
    tracking: (r, u) => ({ url: `${u}?${r.pick(TRACK)}` }),
    fragment: (_r, u) => ({ url: `${u}#overview` }),
    trailing_slash: (_r, u) => ({ url: `${u}/` }),
    application_step: (_r, u) => ({ url: `${u}/application` }),
    id_case: (_r, _u, b) => ({ url: `https://jobs.ashbyhq.com/${b.tenant}/${b.id.toUpperCase()}` }),
    tenant_case: (_r, _u, b) => ({ url: `https://jobs.ashbyhq.com/${cap(b.tenant)}/${b.id}` }),
    host_case: (_r, u) => ({ url: u.replace("jobs.ashbyhq.com", "Jobs.AshbyHQ.com") }),
    by_job_id: (_r, _u, b) => ({ url: `https://${b.tenant}.io/jobs/${b.id}`, job_id: `ashby:${b.tenant}:${b.id}` }),
  },
  workday: {
    tracking: (r, u) => ({ url: `${u}?${r.pick(TRACK)}` }),
    fragment: (_r, u) => ({ url: `${u}#details` }),
    trailing_slash: (_r, u) => ({ url: `${u}/` }),
    apply_step: (_r, u) => ({ url: `${u}/apply` }),
    apply_manually: (_r, u) => ({ url: `${u}/apply/applyManually` }),
    locale: (_r, _u, b) => ({ url: `https://${b.tenant}.wd${b.wd}.myworkdayjobs.com/en-US/${b.site}/job/${b.loc}/${b.slug}_${b.id}` }),
    host_case: (_r, _u, b) => ({ url: `https://${b.tenant.toUpperCase()}.WD${b.wd}.MyWorkdayJobs.com/${b.site}/job/${b.loc}/${b.slug}_${b.id}` }),
  },
};
// Different postings that share as much as possible with the first: never merged.
const DIFFERENT: Record<string, (r: R, b: Base) => Link | null> = {
  another_id: (r, b) => {
    const o: Base = { ...b, id: b.family === "greenhouse" ? digits(r, b.id.length) : b.family === "workday" ? `R${digits(r, 6)}` : uuid(r) };
    return o.id === b.id ? null : { url: canonical(o) };
  },
  near_id: (_r, b) => ({ url: canonical({ ...b, id: b.family === "greenhouse" ? String(BigInt(b.id) + 1n) : b.family === "workday" ? `R${Number(b.id.slice(1)) + 1}` : flipHex(b.id) }) }),
  id_prefix: (_r, b) => b.family === "greenhouse" ? { url: canonical({ ...b, id: b.id + "7" }) } : null,
  same_title_another_req: (r, b) => b.family === "workday" ? { url: canonical({ ...b, id: `R${digits(r, 7)}` }) } : null,
  another_family_same_company: (r, b) => {
    const fam = r.pick((["greenhouse", "lever", "ashby", "workday"] as Family[]).filter((f) => f !== b.family));
    return { url: canonical({ ...base(r, fam), tenant: b.tenant }) };
  },
  same_company_another_role: (r, b) => ({ url: canonical({ ...base(r, b.family), tenant: b.tenant, ...(b.family === "workday" ? { wd: b.wd, site: b.site } : {}) }) }),
};

export function postingCases(r: R, n: number): PostingCase[] {
  const out: PostingCase[] = [];
  const fams: Family[] = ["greenhouse", "lever", "ashby", "workday"];
  while (out.length < n) {
    const b = base(r, r.pick(fams)), u = canonical(b), company = COMPANY[b.tenant], title = r.pick(TITLES);
    if (r.next() < 0.6) {
      const forms = Object.keys(SAME[b.family]);
      const form = r.pick(forms);
      const v = SAME[b.family][form](r, u, b);
      // Either side may be the variant.
      const [a, bb] = r.next() < 0.5 ? [{ url: u }, v] : [v, { url: u }];
      out.push({ family: b.family, form, same: true, a: { ...a, company, title }, b: { ...bb, company, title }, company });
    } else {
      const form = r.pick(Object.keys(DIFFERENT));
      const v = DIFFERENT[form](r, b);
      if (!v || v.url === u) continue;
      out.push({ family: b.family, form, same: false, a: { url: u, company, title }, b: { ...v, company, title: r.pick(TITLES) }, company });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ history
// The queue's states and whether one of them blocks the same posting again (career_apply_counted_states()).
export const STATES = ["queued", "driving", "confirmed", "submitted_unconfirmed", "needs_user", "unknown_outcome", "not_submitted", "failed"] as const;
export const BLOCKING = new Set(["queued", "driving", "confirmed", "submitted_unconfirmed", "needs_user", "unknown_outcome"]);
export const AGES: Record<string, number> = {
  "1m": MIN, "6h": 6 * HOUR, "29d23h": 29 * DAY + 23 * HOUR, "29d23h59m": 30 * DAY - MIN, "30d": 30 * DAY, "30d1m": 30 * DAY + MIN,
  "31d": 31 * DAY, "400d": 400 * DAY,
};
const ZONES = ["Z", "+00:00", "-05:00", "-07:00", "+05:30", "+09:00", "-10:00"];
// An instant written in a zone's own local time (the same instant every way).
export function isoIn(at: number, zone: string): string {
  if (zone === "Z") return new Date(at).toISOString();
  const sign = zone[0] === "-" ? -1 : 1, [hh, mm] = zone.slice(1).split(":").map(Number), off = sign * (hh * 60 + mm) * MIN;
  return new Date(at + off).toISOString().replace("Z", zone);
}
export interface HistoryCase { prior: PostingCase; state: typeof STATES[number]; age: string; zone: string; candidate: "same" | "same_company" | "elsewhere"; b: Link; blocked: boolean; applied_at: string }
export function historyCases(r: R, n: number): HistoryCase[] {
  const out: HistoryCase[] = [];
  const sameOnes = () => { for (;;) { const c = postingCases(r, 1)[0]; if (c.same) return c; } };
  const diffOnes = () => { for (;;) { const c = postingCases(r, 1)[0]; if (!c.same && c.form !== "another_family_same_company") return c; } };
  while (out.length < n) {
    const candidate = r.pick(["same", "same", "same_company", "elsewhere"] as const);
    const age = r.pick(Object.keys(AGES)), zone = r.pick(ZONES), state = r.pick(STATES);
    const prior = candidate === "same" ? sameOnes() : diffOnes();
    let b = prior.b;
    if (candidate === "elsewhere") {
      const other = postingCases(r, 1)[0];
      if (other.company === prior.company) continue;
      b = other.a;
    }
    out.push({ prior, state, age, zone, candidate, b, blocked: candidate === "same" && BLOCKING.has(state), applied_at: isoIn(NOW - AGES[age], zone) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ employers
export type EmployerKind = "exact" | "exact_suffix" | "exact_case" | "fact_shorter" | "fact_longer" | "unrelated" | "unrelated_common_word" |
  "past" | "wish" | "unconfirmed" | "draft";
export interface EmployerCase { kind: EmployerKind; fact: any; company: string; expect: "refused" | "ask" | "pass"; goAhead: boolean }
const DISTINCT = ["Contoso", "Fabrikam", "Northwind", "Tailspin", "Wingtip", "Adatum", "Litware", "Proseware", "Woodgrove", "Lucerne", "Margie", "Trey"];
const SECOND = ["Analytics", "Robotics", "Logistics", "Biotech", "Dynamics", "Aerospace"];
const COMMON_FIRST = ["Global", "National", "United", "American", "Digital"];
export function employerCases(r: R, n: number): EmployerCase[] {
  const out: EmployerCase[] = [];
  const kinds: EmployerKind[] = ["exact", "exact_suffix", "exact_case", "fact_shorter", "fact_longer", "unrelated", "unrelated_common_word", "past", "wish", "unconfirmed", "draft"];
  const asFact = (name: string, style: "key" | "text_now" | "text_past" | "text_wish", extra: Record<string, unknown> = {}) => {
    const base = { id: `f-${out.length}`, status: "confirmed", needs_confirmation: false, ...extra };
    if (style === "key") return { ...base, key: "current_employer", kind: "current_employer", value: name };
    const text = style === "text_now" ? r.pick([`I currently work at ${name}`, `I work at ${name} now`, `Currently employed at ${name}`, `I'm working at ${name}`])
      : style === "text_past" ? r.pick([`I used to work at ${name}`, `I previously worked at ${name}`, `Former analyst at ${name}`, `I interned at ${name}`])
      : r.pick([`I want to work at ${name}`, `My dream is a role at ${name}`, `I'm interested in ${name}`]);
    return { ...base, kind: "experience", text };
  };
  while (out.length < n) {
    const kind = r.pick(kinds), d = r.pick(DISTINCT), s = r.pick(SECOND), goAhead = r.next() < 0.15;
    const style = r.pick(["key", "text_now"] as const);
    let fact: any, company: string, expect: EmployerCase["expect"];
    switch (kind) {
      case "exact": fact = asFact(d, style); company = d; expect = "refused"; break;
      case "exact_suffix": fact = asFact(`${d} ${s}`, style); company = `${d} ${s}${r.pick([", Inc.", " LLC", " Inc", " Corp"])}`; expect = "refused"; break;
      case "exact_case": fact = asFact(d, "key"); company = d.toUpperCase(); expect = "refused"; break;
      case "fact_shorter": fact = asFact(d, style); company = `${d} ${s}`; expect = "ask"; break;
      case "fact_longer": fact = asFact(`${d} ${s}`, style); company = d; expect = "ask"; break;
      case "unrelated": {
        const other = r.pick(DISTINCT.filter((x) => x !== d));
        fact = asFact(other, style); company = `${d} ${s}`; expect = "pass"; break;
      }
      case "unrelated_common_word": {
        const c = r.pick(COMMON_FIRST), s2 = r.pick(SECOND.filter((x) => x !== s));
        fact = asFact(`${c} ${s}`, style); company = `${c} ${s2}`; expect = "pass"; break;
      }
      case "past": fact = asFact(d, "text_past"); company = d; expect = "pass"; break;
      case "wish": fact = asFact(d, "text_wish"); company = d; expect = "pass"; break;
      case "unconfirmed": fact = asFact(d, style, { needs_confirmation: true }); company = d; expect = "pass"; break;
      case "draft": fact = asFact(d, style, { status: "draft" }); company = d; expect = "pass"; break;
    }
    out.push({ kind, fact, company, expect: goAhead && expect !== "pass" ? "pass" : expect, goAhead });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ resumes
export const RESUME_SHA = "a".repeat(8) + "0123456789abcdef".repeat(3) + "b".repeat(8);
export type ResumeKind = "none" | "empty" | "short" | "upper" | "not_hex" | "other_file" | "file_missing" | "the_file";
export interface ResumeCase { kind: ResumeKind; payloadSha: unknown; file: { path: string; sha256: string } | null; starts: boolean }
export function resumeCases(r: R, n: number): ResumeCase[] {
  const out: ResumeCase[] = [];
  const kinds: ResumeKind[] = ["none", "empty", "short", "upper", "not_hex", "other_file", "file_missing", "the_file", "the_file"];
  while (out.length < n) {
    const kind = r.pick(kinds), file = { path: "/tmp/resume.pdf", sha256: RESUME_SHA };
    const c: ResumeCase = kind === "none" ? { kind, payloadSha: undefined, file, starts: false }
      : kind === "empty" ? { kind, payloadSha: "", file, starts: false }
      : kind === "short" ? { kind, payloadSha: RESUME_SHA.slice(0, r.int(10, 63)), file, starts: false }
      : kind === "upper" ? { kind, payloadSha: RESUME_SHA.toUpperCase(), file: { ...file, sha256: RESUME_SHA.toUpperCase() }, starts: false }
      : kind === "not_hex" ? { kind, payloadSha: "z" + RESUME_SHA.slice(1), file: { ...file, sha256: "z" + RESUME_SHA.slice(1) }, starts: false }
      : kind === "other_file" ? { kind, payloadSha: RESUME_SHA, file: { ...file, sha256: flipHex(RESUME_SHA) }, starts: false }
      : kind === "file_missing" ? { kind, payloadSha: RESUME_SHA, file: null, starts: false }
      : { kind, payloadSha: RESUME_SHA, file, starts: true };
    out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Retry-After
export interface RetryCase { form: string; header: string; expect: number | null }
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
export function httpDate(at: number, form: "imf" | "rfc850" | "asctime"): string {
  const d = new Date(at), t = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  if (form === "imf") return `${DAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${t} GMT`;
  if (form === "rfc850") return `${LONG[d.getUTCDay()]}, ${p2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${p2(d.getUTCFullYear() % 100)} ${t} GMT`;
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${t} ${d.getUTCFullYear()}`;
}
const GARBAGE = ["1.5", "-1", "-30", "soon", "12/31", "Retry in 5", "1e3", "0x10", "120s", "3600.0", "Monday", "tomorrow", "2026-10-29", "+5", "5 5", "∞", "NaN", "null", "Wed, 99 Foo 2026 25:61:00 GMT"];
export function retryCases(r: R, n: number): RetryCase[] {
  const out: RetryCase[] = [];
  while (out.length < n) {
    const k = r.int(0, 9);
    if (k <= 2) {
      const s = r.pick([0, 1, 2, 5, 30, 59, 60, 120, 600, 3599, 3600, 86_399, 86_400, r.int(0, 100_000)]);
      const pad = r.pick(["", " ", "\t"]);
      out.push({ form: "seconds", header: `${pad}${s}${pad}`, expect: Math.min(s, 86_400) });
    } else if (k <= 5) {
      const ahead = r.pick([0, 1, 30, 120, 3600, 7200, 90_000, r.int(1, 50_000)]) * 1000, form = r.pick(["imf", "rfc850", "asctime"] as const);
      out.push({ form: `date_${form}`, header: httpDate(NOW + ahead, form), expect: Math.min(86_400, Math.round(ahead / 1000)) });
    } else if (k === 6) {
      const ago = r.pick([1, 60, 86_400]) * 1000, form = r.pick(["imf", "rfc850", "asctime"] as const);
      out.push({ form: `past_date_${form}`, header: httpDate(NOW - ago, form), expect: 0 });
    } else {
      out.push({ form: "garbage", header: r.pick(GARBAGE), expect: null });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ hosts
export type Behavior = "ok" | "rate_limited_seconds" | "rate_limited_date" | "rate_limited_garbage" | "rate_limited_none" | "busy_503" |
  "captcha" | "login_wall" | "server_error" | "timeout" | "refuses_mid_batch";
export const OUTSIDE_REFUSAL = new Set<Behavior>(["rate_limited_seconds", "rate_limited_date", "rate_limited_garbage", "rate_limited_none", "busy_503", "captcha"]);
export interface HostPlan { host: string; behavior: Behavior; header: string | null; refuseFrom?: number }
export interface SchedCase { id: number; hosts: HostPlan[]; jobs: { id: string; url: string }[]; slots: number }
const BEHAVIORS: Behavior[] = ["ok", "ok", "ok", "rate_limited_seconds", "rate_limited_date", "rate_limited_garbage", "rate_limited_none", "busy_503",
  "captcha", "login_wall", "server_error", "timeout", "refuses_mid_batch"];
export function schedCases(r: R, n: number): SchedCase[] {
  const out: SchedCase[] = [];
  for (let id = 0; id < n; id++) {
    const hosts: HostPlan[] = Array.from({ length: r.int(1, 5) }, (_, i) => {
      const behavior = r.pick(BEHAVIORS), host = `h${id}-${i}.example.test`;
      const header = behavior === "rate_limited_seconds" || behavior === "busy_503" || behavior === "refuses_mid_batch" ? String(r.int(0, 3600))
        : behavior === "rate_limited_date" ? httpDate(NOW + r.int(0, 7200) * 1000, r.pick(["imf", "rfc850", "asctime"] as const))
        : behavior === "rate_limited_garbage" ? r.pick(GARBAGE) : null;
      return { host, behavior, header, ...(behavior === "refuses_mid_batch" ? { refuseFrom: r.int(1, 3) } : {}) };
    });
    const jobs = Array.from({ length: r.int(2, 14) }, (_, j) => {
      const h = r.pick(hosts);
      return { id: `s${id}-j${j}`, url: `https://${h.host}/job/${j}` };
    });
    out.push({ id, hosts, jobs, slots: r.int(1, 6) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ crashes
export type CrashPoint = "before_journal_start" | "after_start_before_engine" | "during_engine" | "after_engine_before_record" | "after_record_before_clear";
export const CRASH_POINTS: CrashPoint[] = ["before_journal_start", "after_start_before_engine", "during_engine", "after_engine_before_record", "after_record_before_clear"];
export interface CrashCase { id: number; jobs: number; hosts: number; slots: number; at: number; point: CrashPoint; budgetLeft: boolean }
export function crashCases(r: R, n: number): CrashCase[] {
  return Array.from({ length: n }, (_, id) => {
    const jobs = r.int(1, 10);
    return { id, jobs, hosts: r.int(1, 3), slots: r.int(1, 4), at: r.int(0, jobs - 1), point: r.pick(CRASH_POINTS), budgetLeft: r.next() < 0.8 };
  });
}

// ------------------------------------------------------------------------------------------------ back off, then resume
// Hosts that refuse for load (429 with Retry-After seconds, an HTTP date, garbage or none; a 503 with seconds) the first
// `refuseTimes` attempts and then clear, beside hosts that answer, check (captcha), wall (sign-in) or time out; drained by
// 1-3 workers at once. Owner rule (2026-10-27): back off only when an outside system refuses, then RESUME; each approved
// application is submitted at most once. `refuseTimes` up to 12 with a 0-2 s Retry-After: no cap of Trainee's own.
// busy_503_none: a 503 with no Retry-After (a refusal for load all the same: the default doubling, then resume).
export type BackoffBehavior = "rl_seconds" | "rl_date" | "rl_garbage" | "rl_none" | "busy_503" | "busy_503_none" | "ok" | "captcha" | "login_wall" | "timeout";
export const BACKOFF_REFUSING = new Set<BackoffBehavior>(["rl_seconds", "rl_date", "rl_garbage", "rl_none", "busy_503", "busy_503_none"]);
export interface BackoffHost { host: string; behavior: BackoffBehavior; header: string | null; refuseTimes: number }
export interface BackoffCase { id: number; hosts: BackoffHost[]; jobs: { url: string }[]; slots: number; workers: number }
const BACKOFF_BEHAVIORS: BackoffBehavior[] = ["rl_seconds", "rl_seconds", "rl_date", "rl_garbage", "rl_none", "busy_503", "ok", "ok", "captcha", "login_wall", "timeout", "busy_503_none"];
export function backoffCases(r: R, n: number): BackoffCase[] {
  const out: BackoffCase[] = [];
  for (let id = 0; id < n; id++) {
    const many = id % 10 === 9; // no cap of ours: a host that refuses 8-12 times in a row (short Retry-After), then clears
    const hosts: BackoffHost[] = Array.from({ length: many ? 1 : r.int(1, 4) }, (_, i) => {
      const behavior: BackoffBehavior = many ? "rl_seconds" : r.pick(BACKOFF_BEHAVIORS), host = `b${id}-${i}.example.test`;
      const header = behavior === "rl_seconds" || behavior === "busy_503" ? String(many ? r.int(0, 2) : r.int(0, 90))
        : behavior === "rl_date" ? httpDate(NOW + r.int(0, 90) * 1000, r.pick(["imf", "rfc850", "asctime"] as const))
        : behavior === "rl_garbage" ? r.pick(GARBAGE) : null;
      return { host, behavior, header, refuseTimes: BACKOFF_REFUSING.has(behavior) ? (many ? r.int(8, 12) : r.int(1, 4)) : 0 };
    });
    const jobs = Array.from({ length: many ? r.int(1, 2) : r.int(2, 10) }, (_, j) => ({ url: `https://${r.pick(hosts).host}/job/${j}` }));
    out.push({ id, hosts, jobs, slots: r.int(1, 4), workers: r.int(1, 3) });
  }
  return out;
}
// A worker killed around a requeue: after the engine's 429 and before the requeue is written; right after it is written
// (before the journal line is cleared); during the engine of the job's second attempt.
export type RequeueCrashPoint = "after_refusal_before_requeue" | "after_requeue_before_clear" | "during_second_engine";
export const REQUEUE_CRASH_POINTS: RequeueCrashPoint[] = ["after_refusal_before_requeue", "after_requeue_before_clear", "during_second_engine"];
export interface RequeueCrashCase { id: number; jobs: number; slots: number; at: number; point: RequeueCrashPoint }
export function requeueCrashCases(r: R, n: number): RequeueCrashCase[] {
  return Array.from({ length: n }, (_, id) => {
    const jobs = r.int(1, 6);
    return { id, jobs, slots: r.int(1, 3), at: r.int(0, jobs - 1), point: REQUEUE_CRASH_POINTS[id % REQUEUE_CRASH_POINTS.length] };
  });
}

// ------------------------------------------------------------------------------------------------ claimed, never started
// Owner rule (2026-10-27): no limits of Trainee's own; each approved application submitted at most once. A batch claimed
// by a worker that lets some go before their engines start: it is stopped mid-batch ("stop": after `after` engine
// starts), its claims run out of their lease budget ("out_of_time": the budget shorter than one engine run, so all but
// the first of each claim wait too long), the claim is handed back for a host another instance's refusal holds ("held",
// the leased queue), or it is killed during an engine and started again after the budget ("kill": the journal's
// unstarted lines are past their time). Beside them hosts that answer, check (captcha), time out (unknown) or refuse for
// load with a 503 and no Retry-After. Every approved job ends exactly once; one whose engine started is never driven
// again unless its host refused before anything was sent.
export type UnstartedMode = "stop" | "out_of_time" | "held" | "kill";
export const UNSTARTED_MODES: UnstartedMode[] = ["stop", "out_of_time", "held", "kill"];
export type UnstartedBehavior = "ok" | "captcha" | "timeout" | "busy_503_none";
export interface UnstartedCase { id: number; mode: UnstartedMode; hosts: { host: string; behavior: UnstartedBehavior }[]; jobs: { url: string }[]; slots: number; after: number; at: number }
const UNSTARTED_BEHAVIORS: UnstartedBehavior[] = ["ok", "ok", "ok", "captcha", "timeout", "busy_503_none"];
export function unstartedCases(r: R, n: number): UnstartedCase[] {
  return Array.from({ length: n }, (_, id) => {
    const mode = UNSTARTED_MODES[id % UNSTARTED_MODES.length];
    const hosts = Array.from({ length: r.int(1, 3) }, (_, i) => ({ host: `u${id}-${i}.example.test`, behavior: i === 0 ? "ok" as const : r.pick(UNSTARTED_BEHAVIORS) }));
    const jobs = Array.from({ length: r.int(3, 10) }, (_, j) => ({ url: `https://${r.pick(hosts).host}/job/${j}` }));
    return { id, mode, hosts, jobs, slots: r.int(1, 3), after: r.int(0, 2), at: r.int(0, jobs.length - 1) };
  });
}

// A seeded sample of `k` from xs (the same every run).
export function sample<T>(r: R, xs: T[], k: number): T[] {
  const idx = xs.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, Math.min(k, xs.length)).sort((a, b) => a - b).map((i) => xs[i]);
}
