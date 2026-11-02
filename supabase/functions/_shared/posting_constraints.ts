// The parameters a person states in a job search, read from their own words, and the rule that a posting which states
// otherwise is left out (2026-10-28, search-parameter eval, evals/career/search-params.ts). Before this the search kept only
// a role, one place and "remote": "internship", "new grad", "senior", "$50/hr", "at Stripe", "summer 2027" and "I need
// sponsorship" were dropped silently, so a person who asked for a paid summer 2027 internship was shown a 2026 unpaid one.
//
// Nothing here guesses: a parameter is set only when the message states it; a posting is dropped only when its own text
// states the opposite (pay below the floor, another season, "unable to sponsor"). A posting that says nothing on a
// parameter stays and is counted ("pay not listed") so the reply can say so.
import { CareerJobs } from "./router_core.career.js";
import { ABROAD, US_CITIES } from "./posting_place.ts";
import { payFrom } from "./posting_pay.ts";

export type BandName = "intern" | "new_grad" | "junior" | "mid" | "senior" | "staff" | "manager" | "director";
export interface Limits {
  bands: BandName[] | null;           // levels asked for; a posting whose level is another is left out
  pay: { amount: number; period: "hour" | "year" } | null; // the floor, as stated
  company: string | null;
  term: string | null;                // "summer 2027"
  needsSponsor: boolean;              // "I need visa sponsorship"
}
export interface SearchText { role: string; place: string | null; remote: boolean; limits: Limits }
export const NO_LIMITS: Limits = { bands: null, pay: null, company: null, term: null, needsSponsor: false };
const HOURS_PER_YEAR = 2080;
const SEASON = "spring|summer|fall|autumn|winter";
const lc = (s: unknown) => String(s ?? "").toLowerCase();

// ------------------------------------------------------------------------------------------------ reading the message
function payOf(t: string): Limits["pay"] {
  // "$30+/hr", "at least $100k", "over $40 an hour", "$25/hr or more", "paying $140,000 or more", "$50 an hour"
  // Without a dollar sign only "150k+" / "paying 120k" / "120k or more" count: a bare number is not read as pay.
  const m = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k)?\b\s*(\+)?\s*(?:(?:\/|per\s+|an?\s+)(hr|hour|yr|year|annum)\b)?/i.exec(t)
    ?? /(?:\b(?:paying|pays?|at least|over|above|minimum|min|make|earn)\s+|\b)(\d{2,3}(?:,\d{3})?)\s?(k)\b\s*(\+|or more|and up)?()/i.exec(t);
  if (!m) return null;
  let amount = Number(m[1].replace(/,/g, ""));
  if (!(amount > 0)) return null;
  if (m[2]) amount *= 1000;
  const unit = m[4]?.toLowerCase();
  const period = unit ? (/^h/.test(unit) ? "hour" : "year") : amount >= 1000 ? "year" : null;
  return period ? { amount, period } : null; // "$40" with no period: not guessed
}
function sponsorOf(t: string): boolean {
  if (/\b(no|not|n't|without|don'?t|do not|doesn'?t|never)\b[^.,;]{0,25}\b(sponsor\w*|visa)\b[^.,;]{0,12}\b(needed|necessary|required|need)\b|\bno\s+(?:visa\s+)?sponsorship\b|\b(?:don'?t|do not|won'?t|will not)\s+need\b[^.,;]{0,15}\b(?:sponsor\w*|visa)\b|\bauthori[sz]ed to work\b|\bcitizen\b|\bgreen card\b/.test(t)) return false;
  return /\b(?:need|needs|require|requires|will need|would need|must have|looking for)\b[^.,;]{0,25}\b(?:visa|sponsor\w*|h-?1b|opt|stem opt|work permit)\b|\bsponsorship\s+(?:is\s+)?(?:required|needed|a must)\b|\bvisa\s+sponsor\w*/.test(t);
}
function bandsOf(t: string): BandName[] | null {
  const out = new Set<BandName>();
  if (/\b(intern|interns|internship|internships|co-?op|summer analyst)\b/.test(t)) out.add("intern");
  if (/\b(new[- ]?grad(?:uate)?s?|recent grad(?:uate)?s?|entry[- ]level|early career|graduate (?:role|program))\b/.test(t)) { out.add("new_grad"); out.add("junior"); }
  if (/\b(junior|jr)\b/.test(t)) { out.add("junior"); out.add("new_grad"); }
  if (/\b(senior|sr)\b/.test(t) && !/\b(?:not|no|non)[- ]senior\b/.test(t)) out.add("senior");
  return out.size ? [...out] : null;
}
const termOf = (t: string) => { const m = new RegExp(`\\b(${SEASON})\\s*(?:of\\s+)?(20\\d\\d)\\b`).exec(t); return m ? `${m[1] === "autumn" ? "fall" : m[1]} ${m[2]}` : null; };
const COMPANY_STOP = /^(summer|fall|spring|winter|autumn|january|february|march|april|may|june|july|august|september|october|november|december|least|home|remote|the|a|an)$/i;
function companyOf(message: string): string | null {
  const m = /\b(?:at|for|with)\s+([A-Z][A-Za-z0-9&.]*(?:\s+[A-Z][A-Za-z0-9&.]*){0,2})/.exec(message);
  if (!m) return null;
  const words = m[1].split(/\s+/).filter((w, i) => !(i > 0 && COMPANY_STOP.test(w)));
  if (!words.length || COMPANY_STOP.test(words[0])) return null;
  const name = words.join(" ");
  return US_CITIES.has(lc(name)) || new RegExp(`^(?:${ABROAD.source})$`, "i").test(name) ? null : name; // "for Chicago" is a place
}
const ALIAS: Record<string, string> = { nyc: "new york", sf: "san francisco", "new york city": "new york", "bay area": "san francisco" };
function placeOf(t: string): string | null {
  const m = /\b(?:in|near|around|based in|located in)\s+([a-z][a-z .'-]{1,30}?)(?=\s+(?:for|with|paying|that|who|where|at|over|under|above|or|and|starting|summer|fall|spring|winter|autumn|sponsorship|please)\b|[,.;?!]|$)/.exec(t);
  const cand = m ? m[1].trim() : "";
  const known = (x: string) => US_CITIES.has(x) || new RegExp(`^(?:${ABROAD.source})$`, "i").test(x);
  if (cand && !/^(the|a|an|my|your|this|that|person|general|case)\b/.test(cand) && cand.split(" ").length <= 3 && (known(cand) || !/\b(remote|intern|engineer|analyst)\b/.test(cand))) return ALIAS[cand] ?? cand;
  // No "in": a city or country named anywhere ("SWE internship Chicago summer 2027"), longest name first.
  let best = "";
  for (const c of US_CITIES) if (c.length > best.length && new RegExp(`(^|[^a-z])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`).test(t)) best = c;
  const ab = new RegExp(ABROAD.source, "i").exec(t.replace(/\bremote\b/g, ""));
  if (ab && ab[0].length > best.length) best = ab[0].toLowerCase();
  return best ? ALIAS[best] ?? best : null;
}
const CUE = /^(?:(?:please|hey|hi|ok|okay|so|and|also|can you|could you|can u|would you)\s+)*(?:(?:find|show|get|give|search(?: for)?|look(?:ing)? for|help me find|pull up|list)(?:\s+me)?|i(?:'m| am)? ?(?:looking for|searching for|seeking|want|need|would like|'d like)|i(?:'d| would) like|my goal is|any|are there any|do you have)\s*/i;
const EXPAND: Record<string, string> = { swe: "software engineer", sde: "software engineer", pm: "product manager", ml: "machine learning", ds: "data science" };
const BRIEF_NOISE = new Set(["ok", "okay", "fine", "real", "actual", "postings", "posting", "listings", "links", "link"]);
const ROLE_NOISE = new Set(["me", "some", "any", "a", "an", "the", "jobs", "job", "roles", "role", "positions", "position", "openings", "opening", "opportunities", "opportunity", "work", "to", "i", "im", "am", "my", "of", "for", "paying", "pay", "pays", "salary", "make", "making", "earn", "at", "least", "over", "above", "under", "minimum", "min", "more", "or", "and", "in", "near", "around", "with", "no", "not", "non", "need", "needed", "visa", "sponsorship", "sponsor", "remote", "please", "per", "an", "hr", "hour", "hourly", "year", "yearly", "starting", "start", "season", "that", "are", "is", "will", "be", "who", "which", "interested", "good", "fit", "fits", "career", "new", "level", "grad", "graduate", "recent", "entry", "early", "junior", "jr", "senior", "sr", "intern", "interns", "internship", "internships", "coop", "co-op", "wage", "hiring"]);

// What a search message states: the role (level, pay, place, term and sponsorship words taken out), the place, remote,
// and the limits. The role is empty when the message names none ("find me something remote").
export function searchTextOf(message: string): SearchText {
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  let t = lc(raw);
  const limits: Limits = { bands: bandsOf(t), pay: payOf(raw.replace(/,(?=\d{3})/g, ",")), company: companyOf(raw), term: termOf(t), needsSponsor: sponsorOf(t) };
  const place = placeOf(t);
  const remote = /\bremote(?:ly)?\b|\bwork from home\b|\bwfh\b/.test(t);
  // The role: what is left when everything that is a parameter is taken out.
  t = t.replace(CUE, "").replace(CUE, "");
  // KNOWN GAPS (2026-10-30, #317): the ask to apply is not part of the role. "apply to jobs for me" was searched as the role
  // "apply", and "apply to data analyst jobs" as "apply data analyst". ("applied scientist" is a role: only the verb goes.)
  t = t.replace(/\b(?:and\s+)?(?:please\s+)?(?:apply|applying|submit(?:ting)? (?:my )?applications?)(?:\s+me)?(?:\s+(?:to|for|on|at))?(?:\s+(?:them|these|those|it|all of them|each))?\b/g, " ");
  t = t.replace(/\b\d{2,3}k\b\+?(?:\s*(?:or more|and up))?/g, " ").replace(/\$\s?\d[\d,]*(?:\.\d+)?\s?k?\+?(?:\s*(?:\/|per\s+|an?\s+)(?:hr|hour|yr|year|annum))?(?:\s*(?:or more|and up|and above|plus|minimum))?/g, " ")
    .replace(new RegExp(`\\b(?:for\\s+)?(?:${SEASON})\\s*(?:of\\s+)?20\\d\\d\\b`, "g"), " ")
    .replace(/\b(?:i(?:'ll| will| would)?|we)\s+(?:need|require)\b[^,.;]*/g, " ").replace(/\b(?:no|without|don'?t need|do not need)\b[^,.;]*?(?:sponsorship|visa)\b[^,.;]*?(?:needed|necessary|required)?/g, " ")
    .replace(/\b(?:at|for|with)\s+[a-z0-9&.]+(?:\s+[a-z0-9&.]+){0,2}?(?=\s+in\b|[,.;?]|$)/g, (m) => limits.company && m.toLowerCase().includes(limits.company.toLowerCase()) ? " " : m);
  if (place) t = t.replace(new RegExp(`\\b(?:in|near|around|based in|located in)\\s+${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ").replace(new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  for (const [k, v] of Object.entries(ALIAS)) if (v === place) t = t.replace(new RegExp(`\\b${k}\\b`, "g"), " ");
  // TELEGRAM BRIEF: "remote ok", "$30/hr+" and "real job postings ... with the links" leave no role words behind ("ok", a bare
  // "+", "postings", "links" were searched as the role).
  const words = t.split(/[^a-z0-9+#-]+/).filter((w) => w && !ROLE_NOISE.has(w) && !BRIEF_NOISE.has(w) && !/^\d+$/.test(w) && !/^[+#-]+$/.test(w)).map((w) => EXPAND[w] ?? w);
  return { role: [...new Set(words.join(" ").split(" "))].join(" ").trim(), place, remote, limits };
}

export function limitsLine(l: Limits): string {
  const bits: string[] = [];
  if (l.bands) bits.push(l.bands.includes("intern") ? "internships" : l.bands.includes("senior") ? "senior level" : "entry level");
  if (l.term) bits.push(l.term);
  if (l.pay) bits.push(`$${l.pay.amount.toLocaleString("en-US")}+/${l.pay.period === "hour" ? "hr" : "yr"}`);
  if (l.company) bits.push(`at ${l.company}`);
  if (l.needsSponsor) bits.push("sponsorship available");
  return bits.join(", ");
}
export const hasLimits = (l: Limits) => !!(l.bands || l.pay || l.company || l.term || l.needsSponsor);

// ------------------------------------------------------------------------------------------------ reading a posting
const SPONSOR_NO = /\b(?:unable|not able|cannot|can'?t|won'?t|will not|do(?:es)? not|don'?t|not (?:currently )?(?:able|willing|eligible|offering|providing))\b[^.]{0,40}\bsponsor|\bno\s+(?:visa\s+)?sponsorship\b|\bsponsorship\s+(?:is\s+)?(?:not|unavailable)\b|\bwithout (?:the need for )?(?:visa |employer )?sponsorship\b|\bnot (?:eligible|available) for (?:visa )?sponsorship\b/i;
export const refusesSponsorship = (text: unknown) => SPONSOR_NO.test(String(text ?? ""));

// The pay a posting states, as per-hour and per-year ceilings in dollars; null when it states none, or not in dollars.
export function statedPay(p: { pay?: string | null; description?: string | null }): { hourMax?: number; yearMax?: number } | null {
  const s = p.pay ?? payFrom(p.description);
  if (!s || /[€£]|\b(?:EUR|GBP|CAD|AUD)\b/i.test(s)) return null;
  const nums = [...s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(k)?/gi)].map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter((n) => n > 0);
  if (!nums.length) return null;
  const top = Math.max(...nums);
  return /hour|hr|\/\s*h/i.test(s) ? { hourMax: top } : { yearMax: top };
}
const termsIn = (text: string) => [...text.toLowerCase().matchAll(new RegExp(`\\b(${SEASON})\\s*(?:of\\s+)?(20\\d\\d)\\b`, "g"))].map((m) => `${m[1] === "autumn" ? "fall" : m[1]} ${m[2]}`);

// The level a posting STATES. seniorityBand answers "mid" both for a posting with no level signal and for one that says
// mid-level / 2+ years; here the first is "unstated" (kept under any level search) and only an explicit signal is "mid".
const MID_SIGNAL = /\bmid[\s-]*(?:level|career)\b|\bintermediate\b|\b(?:[2-9]|1\d)\s*\+\s*(?:years?|yrs?)\b|\b(?:[2-9]|1\d)\s*(?:-|to)\s*\d+\s*(?:years?|yrs?)\b|\b(?:at least|minimum(?: of)?)\s+(?:[2-9]|1\d)\s*(?:years?|yrs?)\b|\b(?:[2-9]|1\d)\s*(?:years?|yrs?)(?: of)?(?:\s+\w+){0,3}\s+experience\b/i;
export function statedBand(title: string, text: string): BandName | "unstated" {
  const band = CareerJobs.seniorityBand(title, text) as BandName;
  if (band !== "mid") return band;
  return MID_SIGNAL.test(`${title} ${text}`) ? "mid" : "unstated";
}

export type Reason = "level" | "pay" | "company" | "term" | "sponsor";
// Why a posting is outside the limits, or null. Only what the posting itself states can rule it out.
export function outsideLimits(p: { title?: string; company?: string; location?: string; description?: string | null; pay?: string | null }, l: Limits): Reason | null {
  const title = String(p.title ?? ""), text = String(p.description ?? "");
  if (l.company && !lc(p.company).includes(lc(l.company))) return "company";
  if (l.bands) {
    const band = statedBand(title, text);
    if (band !== "unstated" && !l.bands.includes(band)) return "level";
  }
  if (l.term) {
    const stated = [...new Set(termsIn(`${title} ${text.slice(0, 800)}`))];
    if (stated.length && !stated.includes(l.term)) return "term";
  }
  if (l.pay) {
    const pay = statedPay(p);
    if (pay) {
      const floorHr = l.pay.period === "hour" ? l.pay.amount : l.pay.amount / HOURS_PER_YEAR, floorYr = l.pay.period === "year" ? l.pay.amount : l.pay.amount * HOURS_PER_YEAR;
      if ((pay.hourMax != null && pay.hourMax < floorHr) || (pay.yearMax != null && pay.yearMax < floorYr)) return "pay";
    }
  }
  if (l.needsSponsor && refusesSponsorship(`${title} ${text}`)) return "sponsor";
  return null;
}
export const REASON_WORDS: Record<Reason, string> = { level: "at another level", pay: "paying below the floor you named", company: "at another employer", term: "for another season", sponsor: "saying they do not sponsor visas" };
