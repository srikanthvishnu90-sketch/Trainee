// SEARCH COVERAGE: what a job-search sentence means, and which postings should never be offered. Pure (no I/O, no imports),
// so the ingest, the stores and the ranking share it.
//   "software engineering internship Chicago summer 2027"
//     -> role words [software, engineering], level intern, place Chicago, term summer 2027.
// Before this, every word had to appear literally in a posting's title/company/place/description: "internship" missed
// "Software Engineer Intern", "summer 2027" missed every posting that does not repeat it, and a place was a free word.
// Level and place are HARD filters (a senior role or another city is not what was asked). A term is a filter only against
// a posting that states a different term; a posting that states none stays, ranked after the ones that state it.
// Also here: closed / expired / scam signals read from a posting's own words, and the duplicate key.

export type Level = "intern" | "new_grad";
export interface Place { key: string; label: string; re: RegExp }
export interface Term { season: string | null; year: number | null }
export interface ParsedQuery { words: string[]; roleWords: string[]; level: Level | null; places: Place[]; term: Term | null; remote: boolean }

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'");

// ------------------------------------------------------------------------------------------------ level
export const INTERN_RE = /\b(?:interns?|internships?|co-?ops?|co op)\b/;
const NEWGRAD_RE = /\b(?:new[- ]?grads?|new graduates?|recent graduates?|entry[- ]level|early[- ]career|university graduates?|graduate (?:program|scheme|engineer|developer|analyst)|campus hires?|junior|associate)\b/;
// Review 2026-11-05: "staff" is a level only in the engineering ladder ("Staff Software Engineer"); "Staff Accountant",
// "Staff Nurse" and "Staff Writer" are entry roles. "Fellow" alone is no level (fellowships are often early-career).
const STAFF_LADDER = /\bstaff (?:[a-z/&+-]+ ){0,3}(?:engineer|engineering|scientist|developer|designer|architect|sre|swe|researcher|product manager|data analyst|analyst)\b/;
const SENIOR_RE = /\b(?:senior|sr\.?|principal|lead|director|vp|vice president|head of|chief|distinguished)\b/;
const isSenior = (t: string) => SENIOR_RE.test(t) || STAFF_LADDER.test(t);
// A posting that says in its own description that it IS an internship or co-op ("This is a 12-week summer internship",
// "Our internship program"), not one that mentions interns ("mentor our interns").
const INTERN_SAYS = /\b(?:this|the) (?:role|position|job|opportunity|posting) is an? (?:[a-z0-9-]+ ){0,3}(?:internship|co-?op)\b|\b(?:this|our|the) (?:[a-z0-9-]+ ){0,3}(?:internship|co-?op)(?: program(?:me)?)? (?:is|runs|lasts|will run|offers|starts|begins)\b|\b(?:\d{1,2}|eight|ten|twelve)[- ]week (?:[a-z-]+ ){0,2}(?:internship|co-?op)\b|\bthis is an? (?:[a-z0-9-]+ ){0,3}(?:internship|co-?op)\b|\bpaid (?:summer |fall |spring |winter )?(?:internship|co-?op)\b/;
const LEVEL_QUERY: [Level, RegExp][] = [["intern", /\b(?:interns?|internships?|co-?ops?|co op)\b/], ["new_grad", /\b(?:new[- ]?grads?|new graduates?|recent graduates?|entry[- ]level|early[- ]career|graduate roles?|campus)\b/]];
// The level a posting is: its own seniority band when the store set one, else read from its title.
export function postingLevel(p: { title?: string; seniority_band?: string | null }): Level | "senior" | "other" {
  const t = norm(p.title), band = norm(p.seniority_band);
  if (INTERN_RE.test(t) || /\b(?:summer|winter)\s+(?:business\s+)?(?:analyst|associate)\b/.test(t) && !/manager|director/.test(t)) return "intern";
  if (isSenior(t) && !/\bintern/.test(t)) return "senior";
  if (band === "intern") return "intern";
  if (NEWGRAD_RE.test(t) || band === "new_grad" || band === "junior") return "new_grad";
  if (band === "senior" || band === "staff" || band === "director") return "senior";
  return "other";
}
// The intern filter's answer: an intern title or band, or a non-senior posting whose own description says it is an
// internship (review 2026-11-05: the title alone hid "Software Engineering, Summer 2027" whose text says "internship").
export function isInternPosting(p: { title?: string; seniority_band?: string | null; description?: string }): boolean {
  const lv = postingLevel(p);
  if (lv === "intern") return true;
  if (lv === "senior") return false;
  return INTERN_SAYS.test(norm(String(p.description ?? "").slice(0, 3000)));
}

// ------------------------------------------------------------------------------------------------ place
const P = (key: string, label: string, re: RegExp): Place => ({ key, label, re });
// A city (and its everyday aliases / boroughs) read from a posting's place text. State codes are not matched alone
// (", IL" is Springfield too); a city name is.
export const PLACES: Place[] = [
  P("chicago", "Chicago", /\bchicago(?:land)?\b/), P("new york", "New York", /\bnew york(?: city)?\b|\bnyc\b|\bmanhattan\b|\bbrooklyn\b|\bqueens\b/),
  P("san francisco", "San Francisco", /\bsan francisco\b|\bsf\b|\bsouth san francisco\b/), P("bay area", "Bay Area", /\bbay area\b|\bsan francisco\b|\bsan jose\b|\bpalo alto\b|\bmountain view\b|\bsunnyvale\b|\bmenlo park\b|\bredwood city\b|\bsanta clara\b|\boakland\b|\bcupertino\b|\bsan mateo\b/),
  P("los angeles", "Los Angeles", /\blos angeles\b|\bla, ?ca\b|\bsanta monica\b|\bculver city\b|\bpasadena\b|\bel segundo\b/), P("seattle", "Seattle", /\bseattle\b|\bbellevue\b|\bredmond\b/),
  P("boston", "Boston", /\bboston\b|\bcambridge, ma\b|\bwaltham\b/), P("austin", "Austin", /\baustin\b/), P("dallas", "Dallas", /\bdallas\b|\bplano\b|\birving\b|\bfrisco\b/),
  P("houston", "Houston", /\bhouston\b/), P("atlanta", "Atlanta", /\batlanta\b/), P("denver", "Denver", /\bdenver\b|\bboulder\b/), P("washington dc", "Washington, DC", /\bwashington,? d\.?c\b|\barlington, va\b|\breston\b|\bmclean\b/),
  P("philadelphia", "Philadelphia", /\bphiladelphia\b|\bphilly\b/), P("miami", "Miami", /\bmiami\b/), P("san diego", "San Diego", /\bsan diego\b/), P("minneapolis", "Minneapolis", /\bminneapolis\b|\bst\.? paul\b/),
  P("detroit", "Detroit", /\bdetroit\b|\bann arbor\b/), P("pittsburgh", "Pittsburgh", /\bpittsburgh\b/), P("raleigh", "Raleigh", /\braleigh\b|\bdurham\b|\bcary\b|\bchapel hill\b/), P("phoenix", "Phoenix", /\bphoenix\b|\btempe\b|\bscottsdale\b/),
  P("salt lake city", "Salt Lake City", /\bsalt lake\b|\blehi\b|\bsandy, ut\b/), P("portland maine", "Portland, Maine", /\bportland,? (?:me|maine)\b/), P("portland", "Portland, Oregon", /\bportland\b(?!,? (?:me|maine)\b)/), P("nashville", "Nashville", /\bnashville\b/), P("charlotte", "Charlotte", /\bcharlotte\b/),
  P("toronto", "Toronto", /\btoronto\b/), P("london", "London", /\blondon\b/),
];
// The words that ask for a city. A bare "la" or "dc" is not one (Spanish article, Louisiana); "portland" is Oregon unless Maine is said.
const PLACE_ASK: Record<string, string> = { "new york": "|\\bnyc\\b", "san francisco": "|\\bsf\\b", "philadelphia": "|\\bphilly\\b", "washington dc": "|\\bwashington,? d\\.?c\\b", "portland maine": "|\\bportland,? (?:me|maine)\\b" };
const PLACE_QUERY: [Place, RegExp][] = PLACES.map((pl) => [pl, new RegExp(pl.key === "portland maine" ? PLACE_ASK[pl.key].slice(1) : `\\b${pl.key.replace(/ /g, "[ ]")}\\b${pl.key === "portland" ? "(?!,? (?:me|maine)\\b)" : ""}${PLACE_ASK[pl.key] ?? ""}`)]);
// No usable place on the posting: it is not placed anywhere, so a place filter cannot say it is elsewhere.
const UNPLACED = /^(?:|n\/?a|tbd|multiple(?: locations?)?|various(?: locations?)?|several locations|nationwide|anywhere|united states(?: of america)?|usa|us|u\.s\.a?\.?|north america|global|worldwide)$/;
export function placeFit(location: unknown, places: Place[], remoteOk: boolean): "yes" | "unplaced" | "no" {
  if (!places.length) return "yes";
  const loc = norm(location).replace(/\s+/g, " ").trim();
  if (places.some((pl) => pl.re.test(loc))) return "yes";
  if (UNPLACED.test(loc.replace(/[()]/g, "").trim())) return "unplaced";
  if (remoteOk && /\bremote\b/.test(loc)) return "yes";
  return "no";
}

// ------------------------------------------------------------------------------------------------ term
const SEASONS = ["spring", "summer", "fall", "autumn", "winter"];
// A season and a year, and (review 2026-11-05) any further years joined to it: "Summer 2026 & 2027", "Summer 2026/2027",
// "Summer 2026 or '27" are two terms, so a posting is past only when every one of them is.
const YEAR = "(?:'\\d{2}|20\\d{2})";
const TERM_RE = new RegExp(`\\b(spring|summer|fall|autumn|winter)\\s*(?:of\\s*|,?\\s*)?(${YEAR}(?:\\s*(?:&|and|\\/|-|–|or|,)\\s*${YEAR})*)\\b`, "g");
const yearOf = (y: string) => (y.startsWith("'") ? 2000 + Number(y.slice(1)) : Number(y));
export function termsIn(text: unknown): Term[] {
  const t = norm(text), out: Term[] = [];
  for (const m of t.matchAll(TERM_RE)) {
    const season = m[1] === "autumn" ? "fall" : m[1];
    for (const y of m[2].match(new RegExp(YEAR, "g")) ?? []) out.push({ season, year: yearOf(y) });
  }
  return out;
}
// The term a posting states for ITSELF (review 2026-11-05): its title's, else a description sentence that names the
// internship's own period ("The internship runs Summer 2027"). A sentence about the applicant ("graduating in Spring 2028",
// "enrolled through Fall 2027", "class of 2028") is never the posting's term. `sure` is false for a description-read term:
// it may rank a posting, never hide it.
const PERIOD_SENT = /\b(?:internships?|co-?ops?|program(?:me)?|cohort|placement|start(?:s|ing)?|runs?|dates?|period|session|term)\b/;
const ABOUT_APPLICANT = /\b(?:graduat\w*|grads?|eligib\w*|enrolled|enrollment|pursuing|degree|class of|expected|student|students|returning|remaining|completed?|candidates?|applicants?|you)\b/;
export function postingTerms(p: { title?: string; description?: string }): { terms: Term[]; sure: boolean } {
  const own = termsIn(p.title);
  if (own.length) return { terms: own, sure: true };
  const sents = norm(String(p.description ?? "").slice(0, 3000)).split(/(?<=[.!?\n;])\s+/);
  const terms = sents.filter((s) => PERIOD_SENT.test(s) && !ABOUT_APPLICANT.test(s)).flatMap((s) => termsIn(s));
  return { terms, sure: false };
}
const SEASON_END_MONTH: Record<string, number> = { spring: 5, summer: 8, fall: 11, winter: 2 }; // 0-based month the season ends (winter: Feb of the year after its label)
// A term wholly in the past is not a posting anyone can still join ("Summer 2025 Internship" in October 2026).
export function termExpired(t: Term, now: number): boolean {
  if (t.year === null) return false;
  const d = new Date(now), y = d.getUTCFullYear();
  const endYear = t.year + (t.season === "winter" ? 1 : 0);
  if (endYear < y) return true;
  if (endYear > y) return false;
  // Winter 2026 runs into early 2027, so a winter term is over in Feb of the next year; a year alone, in December.
  const end = t.season ? SEASON_END_MONTH[t.season] : 11;
  return end !== undefined && d.getUTCMonth() > end;
}

// ------------------------------------------------------------------------------------------------ the query
const STOP = new Set(["job", "jobs", "role", "roles", "position", "positions", "opening", "openings", "opportunity", "opportunities", "work", "any", "some", "find", "me", "my", "near", "in", "at", "for", "the", "a", "an", "and", "or", "of", "to", "with", "on", "hiring", "open", "program", "programs", "class", "from", "around", "based"]);
const ROLE_SYN: Record<string, string[]> = { swe: ["software", "engineer"], sde: ["software", "engineer"], sdet: ["software", "engineer"], mle: ["machine", "learning"] };
export function parseSearchQuery(query: unknown): ParsedQuery {
  let q = norm(query).replace(/[^a-z0-9+#'.,\- ]+/g, " ");
  let level: Level | null = null;
  for (const [l, re] of LEVEL_QUERY) if (re.test(q)) { level = level ?? l; q = q.replace(new RegExp(re.source, "g"), " "); }
  const places: Place[] = [];
  for (const [pl, re] of PLACE_QUERY) if (re.test(q)) { places.push(pl); q = q.replace(new RegExp(re.source, "g"), " "); }
  let term: Term | null = null;
  const ts = termsIn(q);
  if (ts.length) { term = ts[0]; q = q.replace(TERM_RE, " "); }
  const loose = /\b(spring|summer|fall|autumn|winter)\b/.exec(q);
  if (!term && loose) term = { season: loose[1] === "autumn" ? "fall" : loose[1], year: null };
  q = q.replace(/\b(spring|summer|fall|autumn|winter)\b/g, " ");
  const yr = /\b(20\d{2})\b/.exec(q);
  if (yr) { term = { season: term?.season ?? null, year: Number(yr[1]) }; q = q.replace(/\b20\d{2}\b/g, " "); }
  const remote = /\bremote\b/.test(q);
  const words = q.split(/[^a-z0-9+#]+/).filter((w) => w.length > 1 && !STOP.has(w)).flatMap((w) => ROLE_SYN[w] ?? [w]);
  // "remote" stays a word to match unless a city was asked: "Chicago or remote" widens the place, it is no word to find.
  const roleWords = [...new Set(places.length ? words.filter((w) => w !== "remote") : words)];
  return { words, roleWords, level, places, term, remote };
}

// ------------------------------------------------------------------------------------------------ closed / expired / scam
// A posting is closed when it SAYS so as a status: a whole sentence that is only that statement. A partial scope ("no longer
// available in Germany"), a date or condition ("closed on Friday", "on hold for approvals"), a question or an aside is not
// the posting's status: it stays open, and the looser wording is flagged (never dropped) so a person or a later read can look.
const NOUN = "(?:position|role|job|posting|opportunity|vacancy|requisition|listing)";
const STATUS = new RegExp(`^(?:note:? |update:? |notice:? )?(?:(?:this|the) ${NOUN} (?:has been|is now|is|was) (?:now )?(?:filled|closed|cancel+ed|withdrawn|expired)` +
  `|(?:this|the) ${NOUN} is no longer (?:available|active|open|accepting applications)` +
  `|${NOUN} (?:closed|filled)` +
  `|(?:we are|we're|we have|we've) (?:no longer|stopped) (?:accepting|taking|reviewing) (?:any )?(?:more |new )?applications?(?: for this ${NOUN})?` +
  `|(?:we are|we're) not (?:currently )?accepting (?:any )?(?:more |new )?applications? (?:for this ${NOUN})?` +
  `|(?:applications?|applicants?) (?:for this ${NOUN} )?(?:are|is|have been|has been) (?:now )?closed` +
  `|no longer accepting (?:any )?(?:more |new )?applications?(?: for this ${NOUN})?)$`);
const LOOSE = /\b(?:no longer (?:accepting|taking|open|available|active)|(?:position|role|job|posting|requisition|vacancy) (?:has been|is|was)? ?(?:now )?(?:filled|closed|cancel+ed|withdrawn|expired|on hold)|applications? (?:are |is |have )?(?:now |been )?closed|not accepting)\b/;
// Review 2026-11-05: these are SEARCH-TIME hides (searchPostings) and ingest FLAGS only (career_ingest.ts counts them,
// stores the row, closes nothing and ends no queued application) until their false-positive rate is measured.
export type Status = { open: true; flags?: string[] } | { open: false; reason: "closed_text" | "expired_term" | "scam" };
const sentences = (t: string) => t.split(/(?<=[.!?\n])\s+/).map((x) => x.trim()).filter(Boolean);
const clauses = (sent: string) => sent.replace(/[.!\s]+$/, "").split(/\s+(?:and|&)\s+|;\s*/);
function closedStatus(text: string): "closed" | "unclear" | null {
  let unclear = false;
  for (const sent of sentences(text)) {
    if (!LOOSE.test(sent)) continue;
    const cs = clauses(sent);
    if (!/[?]/.test(sent) && cs.every((c) => STATUS.test(c.trim())) && cs.some((c) => STATUS.test(c.trim()))) return "closed";
    unclear = true;
  }
  return unclear ? "unclear" : null;
}
export function postingStatus(p: { title?: string; description?: string; posted_at?: string | null; apply_email?: string | null }, now: number): Status {
  const head = norm(`${p.title ?? ""}. ${String(p.description ?? "").slice(0, 1500)}`);
  const c = closedStatus(head);
  if (c === "closed") return { open: false, reason: "closed_text" };
  const own = termsIn(p.title);
  if (own.length && own.every((t) => termExpired(t, now))) return { open: false, reason: "expired_term" };
  const sig = scamSignals(p);
  if (sig.length >= 2) return { open: false, reason: "scam" };
  const flags = [...(c === "unclear" ? ["closed_wording_unclear"] : []), ...(sig.length ? ["possible_scam"] : [])];
  return flags.length ? { open: true, flags } : { open: true };
}
// A real employer's posting never asks the applicant to pay, to cash a cheque, or to move to a chat app to be hired. But an
// employer's own warning says exactly those words ("never pay a fee, never buy gift cards"): sentences that warn or negate
// are not read. Review 2026-11-05: a posting is hidden as a scam only on TWO independent signals; one is a flag. And money
// is an ask only when the APPLICANT pays (an imperative "Pay a $150 fee", "you must pay / send", "pay us"), never when the
// employer pays ("We pay a $2,000 housing deposit for every intern", "we cover the background check fee").
const WARNS = /\b(?:never|do not|don'?t|does not|doesn'?t|will not|won'?t|not ask|no fee|free of charge|beware|warning|scam|scammers?|fraud(?:ulent)?|phishing|impersonat\w*|be aware|stay safe|report (?:any|suspicious)|if (?:anyone|someone|you are asked|you're asked)|legitimate)\b/;
const EMPLOYER_PAYS = /\b(?:we|company|employer|our team|the firm) (?:will |also |fully )?(?:pay|cover|reimburse|provide|offer|fund)\b|\b(?:pays|covers|reimburses|provides|offers|funds)\b|\breimburs\w*|\bat (?:our|no) (?:own )?(?:expense|cost)\b|\bpaid (?:for )?by (?:us|the company)\b/;
const APPLICANT_PAYS = /(?:^|[:;,]\s*)(?:please )?(?:pay|send|wire|deposit|transfer)\b|\b(?:you|applicants?|candidates?|interns?|new hires?|hires?) (?:must|will need to|need to|have to|are required to|will be required to|should|are expected to) (?:first )?(?:pay|send|wire|deposit|transfer)\b|\bpay us\b/;
const MONEY_WORD = /\b(?:fees?|deposits?|costs?|charges?|payments?|\$\s?\d)/;
const applicantPays = (sent: string) => APPLICANT_PAYS.test(sent) && MONEY_WORD.test(sent) && !EMPLOYER_PAYS.test(sent);
const SCAM_SIGNALS: [string, RegExp | ((sent: string) => boolean)][] = [
  ["asks for money", applicantPays],
  ["cheque or gift cards", /\b(?:(?:buy|purchase|send)\b[^.]{0,30}\bgift cards?|western union|moneygram|cashier'?s? che(?:que|ck)|(?:we|company) will (?:send|mail|deposit) (?:you )?a che(?:que|ck)|purchase (?:your )?own equipment)\b/],
  ["chat-app hiring", /\b(?:contact|message|reach|text|add) (?:us|our (?:hr|recruiter|manager|agent)|the (?:hr|recruiter|manager))[^.]{0,40}\b(?:on |via |through |at )?(?:whatsapp|telegram|signal|wechat|line app)\b|\b(?:interview|hiring) (?:is |will be )?(?:conducted |held )?(?:on|via|through) (?:whatsapp|telegram|signal|google hangouts?)\b/],
  ["guaranteed income", /\b(?:earn|make) \$?\d[\d,]{2,}(?:\s?(?:-|to)\s?\$?\d[\d,]{2,})? (?:per|a|\/) ?(?:day|week)\b[^.]{0,60}\b(?:no experience|work from home|immediately)\b|\bno (?:experience|interview) (?:needed|required|necessary)[^.]{0,60}\b(?:hired|start) (?:immediately|today|same day)\b/],
];
const unwarnedSentences = (p: { title?: string; description?: string }) => norm(`${p.title ?? ""}. ${p.description ?? ""}`).split(/(?<=[.!?\n])\s+/).map((x) => x.trim()).filter((x) => x && !WARNS.test(x));
export function scamSignals(p: { title?: string; description?: string; apply_email?: string | null }): string[] {
  const sents = unwarnedSentences(p), t = sents.join(" ");
  const out = SCAM_SIGNALS.filter(([, m]) => sents.some((s) => (typeof m === "function" ? m(s) : m.test(s)))).map(([n]) => n);
  if (/@(?:gmail|yahoo|outlook|hotmail|aol|proton(?:mail)?)\.[a-z.]+$/.test(norm(p.apply_email)) && /\b(?:payment processing|reship|package forwarding|data entry from home|personal assistant to the ceo)\b/.test(t)) out.push("free-mail recruiter on a payments job");
  return out;
}
export function isScam(p: { title?: string; description?: string; apply_email?: string | null }): boolean {
  return scamSignals(p).length >= 2;
}

// ------------------------------------------------------------------------------------------------ duplicates
export function canonicalUrl(u: unknown): string {
  try { const x = new URL(String(u)); x.hash = ""; for (const k of [...x.searchParams.keys()]) if (/^(?:utm_|gh_src|lever-source|source|src|ref|refid|trk|campaign)/i.test(k)) x.searchParams.delete(k); return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`; }
  catch { return norm(u).trim(); }
}
// Review 2026-11-05: two rows are the same job only on a stable identity: the same posting id, or the same link when the
// link carries an id (a long number or a uuid; a shared careers-page link is not one job). Company + title + place is NOT
// an identity: "Software Engineer (Backend)" and "(Frontend)" are two jobs, and so are two requisitions with one title.
export function dupKeys(p: { job_id?: string; company?: string; title?: string; location?: string; url?: string }): string[] {
  const keys: string[] = [];
  if (p.job_id) keys.push(`id:${p.job_id}`);
  if (p.url && /\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(canonicalUrl(p.url))) keys.push(`u:${canonicalUrl(p.url)}`);
  return keys;
}
