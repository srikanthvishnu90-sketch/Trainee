// COMPETITIVE-BAR G1 / B6 (owner 2026-10-27): the posting screen that runs before a posting enters a batch. Every volume
// tool fails here (JobCopilot applies abroad and to scam or filled roles, Massive weeks late, Sonara to irrelevant jobs).
//
// screenPosting(userId, posting, facts) says one of three things, and only from what the posting says and what the person
// CONFIRMED (D-007; an unconfirmed fact is no fact):
//   include     with a one-line "why this fits" built only from confirmed facts, and the fact keys it used (basis)
//   exclude     with a plain reason: already applied to this exact posting, closed, stale, scam signals, location,
//               sponsorship or citizenship, years, degree
//   needs_fact  the posting has a knock-out the person has not confirmed a fact for: the fact and one plain question.
//               screenBatch asks each fact once for the whole batch, however many postings wait on it.
//
// There is no volume cap anywhere here (D-MS-2): a batch of any size is screened in one pass (facts read once, one
// canonical key per posting, set lookups), and every posting that passes is included.
//
// Nothing here sends, stores or calls a model. The wiring into the batch builder is the mass-submit session's
// (see the PR body): it calls screenBatch on the candidate postings and puts only `include` items on the card, with `why`.
import { formUrlFor, postingKey } from "./posting_key.ts";
import { type PlacePart, postingAtHome, postingCountry, postingPlaces } from "./posting_place.ts";
import { isRemotePosting, postingScope, regionsOf } from "./posting_region.ts";

// ------------------------------------------------------------------------------------------------ inputs
export interface ScreenPosting {
  job_id?: string | null;
  url?: string | null; // the posting's own link (an aggregator's or the ATS's)
  apply_url?: string | null; // the form's link, when known
  company?: string | null;
  title?: string | null;
  location?: string | null;
  remote?: string | null; // "remote" | "hybrid" | "onsite"
  description?: string | null;
  posted_at?: string | null;
  first_seen_at?: string | null;
  closed_at?: string | null;
}
// One fact as the person confirmed it. `confirmed` must be true for the screen to use it; anything else is unknown.
export interface ScreenFact { value: unknown; confirmed?: boolean; id?: string }
// Keyed by fact_schema.ts names: location, country, relocation, sponsorship, work_authorization, citizenship,
// years_experience, education_level, and `skills` (the confirmed skill names, a list).
export type ScreenFacts = Record<string, ScreenFact | undefined>;
export interface ScreenContext {
  now?: number;
  maxAgeDays?: number; // a posting older than this is stale (default 45)
  applied?: Iterable<string>; // canonical keys (postingCanon) of the person's own applications, any state that reached an employer or is queued
  alreadyAsked?: Iterable<string>; // facts asked before and still unanswered: never asked again in this batch's asks
}

export type ExcludeReason =
  | "already_applied" | "duplicate_in_batch" | "closed" | "stale" | "scam"
  | "location" | "sponsorship" | "citizenship" | "years" | "degree";
export type ScreenFactKey = "location" | "relocation" | "sponsorship" | "citizenship" | "years_experience" | "education_level";
export type Screen =
  | { verdict: "include"; key: string; why: string; basis: string[] }
  | { verdict: "exclude"; key: string; reason: ExcludeReason; why: string }
  | { verdict: "needs_fact"; key: string; facts: ScreenFactKey[]; question: string };

export const DEFAULT_MAX_AGE_DAYS = 45;
const DAY = 86400000;

export const FACT_QUESTIONS: Record<ScreenFactKey, string> = {
  location: "What city and country do you live in?",
  relocation: "Would you move for an in-office job? If only to some cities, which ones?",
  sponsorship: "Will you need visa sponsorship to work for these employers, now or later?",
  citizenship: "Are you a US citizen? Some of these jobs are open only to US citizens.",
  years_experience: "How many years of professional experience do you have?",
  education_level: "What's the highest degree you've finished (or are finishing)?",
};

// ------------------------------------------------------------------------------------------------ the posting's one key
// The same posting reached by two links (an aggregator's page and the ATS form, the board page and the apply step) has
// one key: the ATS's family:tenant:id when either link or the id names it, else the job id, else the link without its
// query and fragment.
export function postingCanon(p: ScreenPosting): string {
  for (const href of [p.apply_url, p.url, p.job_id ? formUrlFor(String(p.job_id)) : null]) {
    if (!href) continue;
    try {
      const k = postingKey(String(href));
      if (k) return k;
    } catch { /* not a link */ }
  }
  if (p.job_id) return `id:${String(p.job_id).trim().toLowerCase()}`;
  const u = String(p.url ?? p.apply_url ?? "").trim();
  if (u) {
    try {
      const x = new URL(u);
      return `url:${x.hostname.toLowerCase()}${x.pathname.replace(/\/+$/, "").toLowerCase()}`;
    } catch { return `url:${u.toLowerCase()}`; }
  }
  return `text:${norm(p.company)}|${norm(p.title)}|${norm(p.location)}`;
}

// ------------------------------------------------------------------------------------------------ facts, read once
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const conf = (f: ScreenFact | undefined) => (f && f.confirmed === true && f.value !== null && f.value !== undefined && String(f.value).trim() !== "" ? f : null);

type Tri = true | false | null; // confirmed yes, confirmed no, unknown
const YES = /^(y|yes|yeah|yep|true|1|needs?|required?|will need|i (?:will |do )?need(?: it)?|open|willing|anywhere|sure|ok(?:ay)?)$/;
const NO = /^(n|no|nope|false|0|not[_ ]needed|none|never|not willing|i (?:do not|don't|won't|will not) need(?: it)?|no need|don'?t need)$/;
function tri(f: ScreenFact | undefined): Tri {
  const c = conf(f);
  if (!c) return null;
  if (typeof c.value === "boolean") return c.value;
  const v = norm(c.value).replace(/[.!]+$/, "");
  if (YES.test(v)) return true;
  if (NO.test(v)) return false;
  return null;
}

const EDU_RANK: Record<string, number> = { high_school: 1, some_college: 1.5, associate: 2, bachelor: 3, master: 4, doctorate: 5 };
const EDU_WORDS: Record<string, string> = { high_school: "high school diploma", some_college: "some college", associate: "associate degree", bachelor: "bachelor's", master: "master's", doctorate: "doctorate" };

interface Home { city: string; state: string; regions: string[]; label: string }
export interface ReadFacts {
  home: Home | null;
  relocate: { any: boolean; places: string[] } | false | null; // null unknown, false confirmed no
  needsSponsorship: Tri;
  usCitizen: Tri;
  years: number | null;
  edu: { level: string; rank: number } | null;
  skills: string[];
}
export function readFacts(facts: ScreenFacts): ReadFacts {
  const f = facts ?? {};
  // Home: the confirmed "City, ST" (or city, country) and, when separate, the confirmed country.
  let home: Home | null = null;
  const loc = conf(f.location), country = conf(f.country);
  if (loc || country) {
    const text = [loc ? String(loc.value) : "", country ? String(country.value) : ""].filter(Boolean).join(", ");
    const parts = postingPlaces(text);
    const p = parts[0] ?? { city: "", state: "", country: "", remote: false } as PlacePart;
    const regions = new Set(regionsOf(text));
    if (p.country === "us" || p.state) regions.add("us");
    if (regions.size || p.city) home = { city: p.city, state: p.state, regions: [...regions], label: loc ? String(loc.value).trim() : String(country!.value).trim() };
  }
  // Relocation: yes / no / a list of places.
  let relocate: ReadFacts["relocate"] = null;
  const rel = conf(f.relocation);
  if (rel) {
    const t = tri(rel);
    if (t === true) relocate = { any: true, places: [] };
    else if (t === false) relocate = false;
    else {
      const v = norm(rel.value);
      if (/\b(no|not|won'?t|never)\b/.test(v) && !/\b(yes|open|willing|would)\b/.test(v)) relocate = false;
      else {
        const places = postingPlaces(v.replace(/^(yes|open|willing|i would|would)\b[^a-z]*(?:to |for )?(?:move |relocate )?(?:to )?/, "")).map((x) => x.city || x.state).filter(Boolean);
        relocate = places.length ? { any: false, places } : /\b(yes|open|willing|anywhere)\b/.test(v) ? { any: true, places: [] } : null;
      }
    }
  }
  // Sponsorship: "Yes"/"needs" means the person needs it.
  let needsSponsorship = tri(f.sponsorship);
  if (needsSponsorship === null) {
    const s = conf(f.sponsorship);
    if (s) {
      const v = norm(s.value);
      if (/\b(do not|don'?t|won'?t|will not|no longer|never)\b[^.]*\bneed\b|\bnot needed\b/.test(v)) needsSponsorship = false;
      else if (/\b(need|needs|require|will need)\b/.test(v)) needsSponsorship = true;
    }
  }
  // Citizenship: a yes/no, or a country's name ("US", "India").
  let usCitizen = tri(f.citizenship);
  if (usCitizen === null) {
    const c = conf(f.citizenship);
    if (c) {
      const r = regionsOf(String(c.value));
      if (r.includes("us")) usCitizen = true;
      else if (r.length) usCitizen = false;
    }
  }
  const yrs = conf(f.years_experience);
  const yn = yrs ? Number(String(yrs.value).match(/\d+(?:\.\d+)?/)?.[0]) : NaN;
  const years = Number.isFinite(yn) ? yn : null;
  const e = conf(f.education_level);
  const level = e ? String(e.value).toLowerCase().replace(/[^a-z_]/g, "") : "";
  const edu = EDU_RANK[level] ? { level, rank: EDU_RANK[level] } : null;
  const sk = conf(f.skills);
  const skills = sk ? (Array.isArray(sk.value) ? sk.value : String(sk.value).split(/\s*,\s*/)).map((x) => String(x).trim()).filter((x) => x.length >= 1 && x.length <= 40) : [];
  return { home, relocate, needsSponsorship, usCitizen, years, edu, skills };
}

// ------------------------------------------------------------------------------------------------ what the posting says
const sentencesOf = (t: string) => t.split(/(?<=[.!?;\n•])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const SOFT = /\b(prefer(?:red|ably)?|nice to have|bonus|a plus|is a plus|ideally|desired|desirable|advantage|helpful|not required)\b/i;

// No sponsorship: the employer's words, never inferred from a place.
const NO_SPONSOR = [
  /\b(?:not|unable to|cannot|can ?not|can't|won'?t|will not|does not|do not|doesn'?t|don'?t|is not able to|are not able to)\s+(?:currently\s+)?(?:be\s+)?(?:able to\s+)?(?:provide|offer|support|sponsor)(?:ing)?\s+(?:any\s+)?(?:(?:employment|work|immigration|h-?1b|visa)\s+)*(?:visa\s+)?sponsor/i,
  /\b(?:not|unable to|cannot|can't|won'?t|will not|does not|do not)\s+sponsor\b/i,
  /\bwithout\s+(?:the\s+)?(?:need\s+(?:for|of)\s+)?(?:(?:current|future|now|or|and|in|the)\s+)*(?:employer\s+|visa\s+|employment\s+)?sponsorship\b/i,
  /\bsponsorship\s+(?:is\s+|will\s+)?(?:not|un)\s*(?:be\s+)?(?:available|provided|offered|possible)\b/i,
  /\bno\s+(?:visa\s+|h-?1b\s+|employment\s+)?sponsorship\b/i,
];
const CITIZENS_ONLY = /\b(?:u\.?s\.?|united states|american)\s+citizens?(?:hip)?\s+(?:is\s+)?(?:only|required)\b|\bmust\s+(?:be|hold)\s+(?:a\s+)?(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b|\b(?:active|current)\s+(?:secret|top secret|ts\/sci|ts)\s+(?:security\s+)?clearance\s+(?:is\s+)?required\b|\brequires?\s+(?:an?\s+)?(?:active\s+)?(?:secret|top secret|ts\/sci)\s+clearance\b/i;

export interface PostingReq { noSponsor: boolean; citizensOnly: boolean; years: number | null; degree: { level: string; rank: number } | null }
export function readPosting(desc: string): PostingReq {
  const t = String(desc ?? "");
  const noSponsor = NO_SPONSOR.some((re) => re.test(t));
  const citizensOnly = CITIZENS_ONLY.test(t);
  let years: number | null = null, degree: PostingReq["degree"] = null;
  for (const s of sentencesOf(t)) {
    if (SOFT.test(s)) continue;
    // "5+ years of experience", "3-5 years' professional experience", "minimum of 7 years in sales", "at least two years".
    const ys = s.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)\b/g, (w) => String({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 }[w]));
    for (const m of ys.matchAll(/(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)['’]?\s+(?:of\s+)?(?:[a-z/&,-]+\s+){0,5}?(?:experience|exp\b|work(?:ing)?\b|in\b)/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 20 && (years === null || n > years)) years = n;
    }
    // A degree knock-out: "required"/"must"/"minimum" in the sentence; "or equivalent experience" and "pursuing" are not knock-outs.
    if (/\b(required|requires?|must|minimum|need(?:ed)?)\b/i.test(s) && !/\bequivalent\b|\bor (?:related |relevant |comparable )?(?:work |practical |professional )?experience\b|\bpursuing\b|\benrolled\b|\bworking towards?\b|\bcurrent(?:ly)? (?:a )?student\b/i.test(s)) {
      const lvl = /\b(ph\.?\s?d|doctorate|doctoral)\b/i.test(s) ? "doctorate"
        : /\b(master'?s|m\.?s\.?c?|mba|m\.?eng)\b(?:\s+degree)?/i.test(s) && /\b(degree|master)/i.test(s) ? "master"
        : /\b(bachelor'?s|b\.?s\.?c?|b\.?a\.?|undergraduate degree|four-year degree|4-year degree)\b/i.test(s) && /\b(degree|bachelor)/i.test(s) ? "bachelor"
        : null;
      if (lvl && (!degree || EDU_RANK[lvl] < degree.rank)) degree = { level: lvl, rank: EDU_RANK[lvl] };
    }
  }
  return { noSponsor, citizensOnly, years, degree };
}

// Scam signals. One strong signal, or two weak ones, excludes.
const SCAM_STRONG = [
  /\b(?:pay|purchase|buy)\b[^.]{0,40}\b(?:fee|training|starter kit|equipment|software|certification|background check)\b/i,
  /\b(?:registration|application|processing|onboarding|training)\s+fee\b/i,
  /\bgift\s*cards?\b/i, /\bwire\s+transfer\b/i, /\b(?:deposit|cash)\s+(?:a|the)\s+(?:cheque|check)\b/i,
  /\b(?:western union|moneygram|cash ?app|zelle|bitcoin|crypto(?:currency)?)\b[^.]{0,40}\b(?:pay|payment|send|deposit)\b/i,
  /\b(?:interview|contact|reach|message)\b[^.]{0,40}\b(?:on|via|through|by)\s+(?:telegram|whatsapp|signal|google hangouts|wickr)\b/i,
  /\b(?:reshipping|re-?shipping|package forwarding|parcel forwarding|mystery shopper|payment processing agent)\b/i,
  /\bsend\s+(?:us\s+)?(?:your\s+)?(?:bank account|ssn|social security number)\b/i,
];
const SCAM_WEAK = [
  /\bno experience (?:needed|required|necessary)\b/i,
  /\$\s?\d{3,}[^.]{0,15}\b(?:per|a|\/)\s*(?:day|week)\b/i,
  /\b(?:immediate start|start today|hired today|guaranteed (?:income|job))\b/i,
  /\b[a-z0-9._%+-]+@(?:gmail|yahoo|hotmail|outlook|aol|proton(?:mail)?)\.(?:com|me)\b/i,
  /\btext\b[^.]{0,30}\bto apply\b/i,
];
export function scamSignals(p: ScreenPosting): string[] {
  const t = `${p.title ?? ""}\n${p.description ?? ""}`;
  const strong = SCAM_STRONG.filter((re) => re.test(t)).map((re) => re.exec(t)![0]);
  if (strong.length) return strong;
  const weak = SCAM_WEAK.filter((re) => re.test(t)).map((re) => re.exec(t)![0]);
  if (!String(p.company ?? "").trim()) weak.push("no employer named");
  return weak.length >= 2 ? weak : [];
}

// ------------------------------------------------------------------------------------------------ the screen
const say = (ks: string[]) => ks.map((k) => k === "us" ? "the US" : k === "uk" ? "the UK" : k === "eu" ? "the EU" : k.replace(/\b\w/g, (c) => c.toUpperCase())).join(" or ");
const placeSay = (p: ScreenPosting) => String(p.location ?? "").replace(/\s+/g, " ").trim() || "its office";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Compiled { facts: ReadFacts; skillRes: { name: string; re: RegExp }[]; now: number; maxAge: number; applied: Set<string> }
function compile(facts: ScreenFacts, ctx: ScreenContext = {}): Compiled {
  const rf = readFacts(facts);
  return {
    facts: rf,
    skillRes: rf.skills.map((name) => ({ name, re: new RegExp(`(?:^|[^a-z0-9+#])${escapeRe(name.toLowerCase())}(?![a-z0-9+#])`) })),
    now: ctx.now ?? Date.now(),
    maxAge: (ctx.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * DAY,
    applied: new Set(ctx.applied ?? []),
  };
}

function screenOne(c: Compiled, p: ScreenPosting, key: string): Screen {
  const F = c.facts;
  // 1. Never the same posting twice.
  if (c.applied.has(key)) return { verdict: "exclude", key, reason: "already_applied", why: "You already applied to this exact posting." };
  // 2. Open and fresh.
  if (p.closed_at) return { verdict: "exclude", key, reason: "closed", why: "The employer closed this posting." };
  const posted = Date.parse(String(p.posted_at ?? p.first_seen_at ?? ""));
  if (Number.isFinite(posted) && c.now - posted > c.maxAge) {
    const days = Math.floor((c.now - posted) / DAY);
    return { verdict: "exclude", key, reason: "stale", why: `Posted ${days} days ago; a posting that old is usually filled.` };
  }
  // 3. Scam signals.
  const scam = scamSignals(p);
  if (scam.length) return { verdict: "exclude", key, reason: "scam", why: `It looks like a scam ("${scam[0].trim().slice(0, 60)}").` };

  const req = readPosting(String(p.description ?? ""));
  const missing: ScreenFactKey[] = [];
  const basis: string[] = [], fits: string[] = [];

  // 4. Location.
  const remote = isRemotePosting(p) || /\bremote\b/i.test(String(p.remote ?? ""));
  const scope = postingScope(p);
  if (remote) {
    if (scope.length) {
      if (!F.home) missing.push("location");
      else if (!F.home.regions.some((h) => scope.includes(h) || (h === "us" && scope.includes("us")))) {
        return { verdict: "exclude", key, reason: "location", why: `It's remote for people in ${say(scope)} only, and you live in ${F.home.label}.` };
      } else { basis.push("location"); fits.push(`remote in ${say(scope)}, where you live`); }
    }
  } else {
    const parts = postingPlaces(String(p.location ?? ""));
    if (parts.length && (parts.some((x) => x.city) || postingCountry(parts))) {
      if (!F.home) missing.push("location");
      else if (F.home.city && postingAtHome(parts, { city: F.home.city, state: F.home.state })) {
        basis.push("location"); fits.push(`in ${F.home.label}, where you live`);
      } else if (F.relocate === false) {
        return { verdict: "exclude", key, reason: "location", why: `It's in person in ${placeSay(p)}, and you said you won't move.` };
      } else if (F.relocate === null) missing.push("relocation");
      else if (F.relocate.any || parts.some((x) => F.relocate && (F.relocate as { places: string[] }).places.some((pl) => pl === x.city || pl === x.state))) {
        basis.push("relocation"); fits.push(`you'd move to ${placeSay(p)}`);
      } else {
        return { verdict: "exclude", key, reason: "location", why: `It's in person in ${placeSay(p)}, which isn't a place you said you'd move to.` };
      }
    }
  }
  // 5. Sponsorship and citizenship.
  if (req.noSponsor) {
    if (F.needsSponsorship === true) return { verdict: "exclude", key, reason: "sponsorship", why: "They don't sponsor visas, and you need sponsorship." };
    if (F.needsSponsorship === null) missing.push("sponsorship");
    else { basis.push("sponsorship"); fits.push("you don't need the sponsorship they won't give"); }
  }
  if (req.citizensOnly) {
    if (F.usCitizen === false) return { verdict: "exclude", key, reason: "citizenship", why: "It's open only to US citizens (or needs a US security clearance)." };
    if (F.usCitizen === null) missing.push("citizenship");
    else basis.push("citizenship");
  }
  // 6. Years: more than one year short is a knock-out.
  if (req.years !== null) {
    if (F.years === null) missing.push("years_experience");
    else if (F.years + 1 < req.years) return { verdict: "exclude", key, reason: "years", why: `It asks for ${req.years}+ years of experience; you have ${plural(F.years, "year")}.` };
    else { basis.push("years_experience"); fits.push(`your ${plural(F.years, "year")} of experience meets their ${req.years}+`); }
  }
  // 7. Degree.
  if (req.degree) {
    if (!F.edu) missing.push("education_level");
    else if (F.edu.rank < req.degree.rank) return { verdict: "exclude", key, reason: "degree", why: `It requires a ${EDU_WORDS[req.degree.level]} degree; you have ${/^[aeiou]/.test(EDU_WORDS[F.edu.level]) ? "an" : "a"} ${EDU_WORDS[F.edu.level]}.`.replace("degree degree", "degree") };
    else { basis.push("education_level"); fits.push(`your ${EDU_WORDS[F.edu.level]} meets their degree requirement`); }
  }
  if (missing.length) {
    const facts = [...new Set(missing)];
    return { verdict: "needs_fact", key, facts, question: FACT_QUESTIONS[facts[0]] };
  }
  // 8. Why it fits: the person's own confirmed skills the posting names, then the knock-outs passed.
  const text = ` ${String(p.title ?? "")} ${String(p.description ?? "")} `.toLowerCase();
  const named = c.skillRes.filter((s) => s.re.test(text)).map((s) => s.name).slice(0, 3);
  if (named.length) { basis.unshift("skills"); fits.unshift(`it asks for ${named.length > 1 ? named.slice(0, -1).join(", ") + " and " + named.at(-1) : named[0]}, which you know`); }
  const line = fits.slice(0, 2).join("; ");
  return { verdict: "include", key, why: line ? `Fits: ${line}.` : "Fits: it's open, recent, and nothing in it rules you out.", basis };
}

// One posting.
export function screenPosting(userId: string, posting: ScreenPosting, facts: ScreenFacts, ctx: ScreenContext = {}): Screen & { user_id: string } {
  const c = compile(facts, ctx);
  return { user_id: userId, ...screenOne(c, posting, postingCanon(posting)) };
}

export interface BatchScreen {
  user_id: string;
  include: (ScreenPosting & { key: string; why: string; basis: string[] })[];
  exclude: (ScreenPosting & { key: string; reason: ExcludeReason; why: string })[];
  needs_fact: (ScreenPosting & { key: string; facts: ScreenFactKey[] })[];
  // Each missing fact once, with every posting waiting on it (the person answers once; the postings are screened again).
  asks: { fact: ScreenFactKey; question: string; keys: string[] }[];
  counts: { total: number; include: number; exclude: number; needs_fact: number; by_reason: Partial<Record<ExcludeReason, number>> };
}

// A whole batch in one pass, any size. The same posting twice in the batch (two links, two boards) is screened once.
export function screenBatch(userId: string, postings: ScreenPosting[], facts: ScreenFacts, ctx: ScreenContext = {}): BatchScreen {
  const c = compile(facts, ctx);
  const asked = new Set(ctx.alreadyAsked ?? []);
  const seen = new Set<string>();
  const out: BatchScreen = { user_id: userId, include: [], exclude: [], needs_fact: [], asks: [], counts: { total: postings.length, include: 0, exclude: 0, needs_fact: 0, by_reason: {} } };
  const asks = new Map<ScreenFactKey, string[]>();
  for (const p of postings) {
    const key = postingCanon(p);
    let s: Screen;
    if (seen.has(key)) s = { verdict: "exclude", key, reason: "duplicate_in_batch", why: "The same posting is already in this batch (another link to it)." };
    else { seen.add(key); s = screenOne(c, p, key); }
    if (s.verdict === "include") out.include.push({ ...p, key, why: s.why, basis: s.basis });
    else if (s.verdict === "exclude") {
      out.exclude.push({ ...p, key, reason: s.reason, why: s.why });
      out.counts.by_reason[s.reason] = (out.counts.by_reason[s.reason] ?? 0) + 1;
    } else {
      out.needs_fact.push({ ...p, key, facts: s.facts });
      for (const f of s.facts) (asks.get(f) ?? asks.set(f, []).get(f)!).push(key);
    }
  }
  for (const [fact, keys] of asks) if (!asked.has(fact)) out.asks.push({ fact, question: FACT_QUESTIONS[fact], keys });
  out.counts.include = out.include.length;
  out.counts.exclude = out.exclude.length;
  out.counts.needs_fact = out.needs_fact.length;
  return out;
}
