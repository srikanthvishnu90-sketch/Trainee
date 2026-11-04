// WO-020 part 2: a stated answer onto the employer's own options, by meaning. "Yes" finds "Yes, I am authorized"; a
// bachelor's degree finds "Bachelor's Degree" or "Undergraduate Degree"; 2 weeks' notice finds "1-2 weeks"; 6 years
// finds "4 – 7 years" or, of "1+ years ... 5+ years", the highest it reaches; "decline" finds "Prefer not to say". It only
// chooses among the options the form offers, and returns null when none fits or more than one fits equally: an unmatched
// answer is asked, never forced. Nothing here invents a value; the value is the person's own.
import { LANGUAGE_NAMES } from "./question_map.ts";
export interface Opt { label: string; value: string }

const low = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const only = (xs: Opt[]) => (xs.length === 1 ? xs[0].value : null);

const YES = /^(yes|yeah|yep|sí|si|ja|oui|はい|true|i am\b|i do\b|i have\b|i will\b|i can\b|i agree|i accept|i acknowledge|i understand|acknowledge|agree|accept|consent|confirm|read and understood|i consent)/;
const NO = /^(no\b|non\b|nee\b|いいえ|false|i am not|i'?m not|i do not|i don'?t|i have not|i haven'?t|i have never|i'?ve never|i will not|i won'?t|i cannot|i can'?t|i did not|not\b|never\b|none\b)/;
// The no-forms first: "I am not a U.S. person" and "I do not have an agreement" begin like a yes.
export function yesNoOf(v: unknown): "yes" | "no" | null {
  const t = low(v);
  return NO.test(t) ? "no" : YES.test(t) ? "yes" : null;
}
function byYesNo(want: "yes" | "no", options: Opt[]): string | null {
  const hit = options.filter((o) => yesNoOf(o.label) === want);
  if (hit.length === 1) return hit[0].value;
  // "Yes - Currently" and "Yes - Previously" are two different yeses: never pick one for the person. Plain "Yes" wins.
  const plain = hit.filter((o) => /^(yes|no|sí|si|ja|nee|oui|non|はい|いいえ)[.!]?$/i.test(o.label.trim()));
  return only(plain);
}

const DECLINE = /decline|prefer not|\bnot declared\b|rather not|do not wish|don'?t wish|not (to )?(answer|disclose|say|self-identify|specify)|choose not|i don'?t want to answer|do not want to answer|ne préfère pas/;

const EDUCATION: Record<string, RegExp> = {
  high_school: /high school|ged|secondary|diploma or equivalent/,
  some_college: /some college|some university|enrollment/,
  associate: /associate/,
  // "B.A." inside "M.B.A." is not a bachelor's (WO-042, Greenhouse's degree list).
  bachelor: /bachelor|undergraduate degree|(?<![a-z]\.)\bb\.?s\.?c?\b|(?<![a-z]\.)\bb\.?a\.?\b|\bbsc\b/,
  master: /master|\bm\.?s\.?c?\b|\bmba\b|graduate degree(?!.*under)/,
  doctorate: /ph\.?d|doctor|doctoral/,
};

const STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware",
  dc: "district of columbia", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
  ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon",
  pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah",
  vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};
const US = /^(us|u\.s\.?|usa|u\.s\.a\.?|united states( of america)?|america)$/;
// What to type into an employer's place search for a stated place: the city of "Chicago, IL", or the state's full name
// for a state given by its abbreviation ("IL" -> "Illinois"), since a place search lists places by name (WO-042).
export function placeQuery(value: unknown): string {
  const v = String(value ?? "").trim();
  const st = STATES[low(v)];
  if (st) return st.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return v.split(",")[0].trim();
}

// A span of time in one unit (weeks for notice, years for experience): "1-2 weeks", "4+ weeks", "Less than 4 years",
// "1 Month", "Immediately", "No experience". [min, max]; max Infinity for "N+".
function span(label: string, unit: "weeks" | "years"): [number, number] | null {
  const t = low(label).replace(/–|—/g, "-");
  if (/immediate|none\/immediate|no experience|^none$|^0$/.test(t)) return [0, 0];
  const per = (u: string) => (unit === "weeks" ? (/month/.test(u) ? 4.345 : /day/.test(u) ? 1 / 7 : /year/.test(u) ? 52 : 1) : (/month/.test(u) ? 1 / 12 : 1));
  const u = (/(day|week|month|year)/.exec(t) || [, unit === "weeks" ? "week" : "year"])[1]!;
  const k = per(u);
  let m = /less than (\d+(?:\.\d+)?)/.exec(t);
  if (m) return [0, Number(m[1]) * k - 1e-9];
  m = /(\d+(?:\.\d+)?)\s*(?:\+|or more|and above|plus)|more than (\d+(?:\.\d+)?)/.exec(t);
  // "More than 1 month" does not hold 1 month itself (round 2: a notice of exactly a month is "Within 1 month").
  if (m) return [Number(m[1] ?? m[2]) * k + (m[2] ? 1e-6 : 0), Infinity];
  m = /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/.exec(t);
  if (m) return [Number(m[1]) * k, Number(m[2]) * k];
  // "Within 2 weeks", "Up to 1 month": from now to that far (WO-048 round 2). A range ("Within 1-2 weeks") is read above.
  m = /^(?:within|up to|in)\s+(?:the next\s+)?(\d+(?:\.\d+)?)\b/.exec(t);
  if (m) return [0, Number(m[1]) * k];
  m = /^(\d+(?:\.\d+)?)\b/.exec(t);
  if (m) return [Number(m[1]) * k, Number(m[1]) * k];
  return null;
}
function amount(value: string, unit: "weeks" | "years"): number | null {
  const t = low(value);
  if (/immediate|now|right away|asap|^none$|^0$/.test(t)) return 0;
  const m = /(\d+(?:\.\d+)?)\s*(day|week|month|year)?/.exec(t);
  if (!m) return null;
  const n = Number(m[1]), u = m[2] ?? (unit === "weeks" ? "week" : "year");
  return unit === "weeks" ? n * (u === "month" ? 4.345 : u === "day" ? 1 / 7 : u === "year" ? 52 : 1) : n * (u === "month" ? 1 / 12 : 1);
}
function bySpan(value: string, options: Opt[], unit: "weeks" | "years"): string | null {
  const v = amount(value, unit);
  if (v === null) return null;
  const spans = options.map((o) => ({ o, s: span(o.label, unit) })).filter((x) => x.s);
  const inside = spans.filter((x) => v >= x.s![0] - 1e-9 && v <= x.s![1] + 1e-9);
  if (inside.length <= 1) return inside[0]?.o.value ?? null;
  // "Within 2 weeks", "Within 1 month": spans from now, one inside the next; the tightest that holds it is the true one.
  if (inside.every((x) => x.s![0] === 0 && x.s![1] !== Infinity)) {
    inside.sort((a, b) => a.s![1] - b.s![1]);
    return inside[0].s![1] === inside[1].s![1] ? null : inside[0].o.value;
  }
  // "1+ years ... 5+ years": several open spans contain it; the one with the highest floor is the true one. Two closed
  // spans sharing an edge ("1-3 years", "3-5 years" for 3) is a guess either way: asked.
  if (!inside.every((x) => x.s![1] === Infinity)) return null;
  inside.sort((a, b) => b.s![0] - a.s![0]);
  return inside[0].s![0] === inside[1].s![0] ? null : inside[0].o.value;
}

// WO-048: a stated pay amount onto a list of pay ranges ("$80,000 - $99,999", "$120,000+", "80k - 100k"): the one range it
// falls in. An amount on the edge of two ranges, a list that is not ranges, or an amount that is not a number: asked.
const money = (s: string): number | null => {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return m[2] ? n * 1000 : n;
};
function byPayRange(value: string, options: Opt[]): string | null {
  const v = money(String(value).replace(/\s*(usd|dollars|per year|a year|\/ ?(yr|year))\s*$/i, ""));
  if (v === null || v < 1000) return null;
  const ranges = options.map((o) => {
    const t = low(o.label).replace(/–|—/g, "-").replace(/\s*(usd|per year|annually|\/ ?(yr|year))\s*$/, "");
    let m = /^(.+?)\s*(?:-|to)\s*(.+)$/.exec(t);
    if (m && money(m[1]) !== null && money(m[2]) !== null) return { o, lo: money(m[1])!, hi: money(m[2])! };
    m = /^(.+?)\s*(?:\+|or more|and above)$/.exec(t);
    if (m && money(m[1]) !== null) return { o, lo: money(m[1])!, hi: Infinity };
    m = /^(?:less than|under|below)\s+(.+)$/.exec(t);
    if (m && money(m[1]) !== null) return { o, lo: 0, hi: money(m[1])! - 0.01 };
    return null;
  }).filter((x): x is { o: Opt; lo: number; hi: number } => !!x);
  return only(ranges.filter((r) => v >= r.lo && v <= r.hi).map((r) => r.o));
}

// WO-052: the option that says the person is a U.S. citizen ("A United States citizen or national", "U.S. citizen or
// national"), for a person whose stated citizenship is the U.S.; never an option that says they are not one.
export function usCitizenChoice(citizenship: string, options: Opt[]): string | null {
  if (!US.test(low(citizenship))) return null;
  return only(options.filter((o) => /\b(u\.?s\.?a?|united states( of america)?) citizen/.test(low(o.label)) && !/\bnot\b|\bnon-|^no\b/.test(low(o.label))));
}

// WO-052: the languages a question names. The person's languages are confirmed complete (fact_schema), so a language
// named that is not on their list is one they do not speak; how well they speak one that is on it is theirs to say.
const LANGUAGES: [string, RegExp][] = [
  ["english", /\benglish\b|\banglais\b|\bengels\b|英語/], ["spanish", /\bspanish\b|\bespañol\b|\bcastellano\b|\bspaans\b/],
  ["french", /\bfrench\b|\bfrançais\b|\bfrans\b/], ["german", /\bgerman\b|\bdeutsch\b|\bduits\b|\ballemand\b/],
  ["dutch", /\bdutch\b|\bnederlands\b|\bflemish\b/], ["portuguese", /\bportuguese\b|\bportuguês\b/], ["italian", /\bitalian\b|\bitaliano\b/],
  ["japanese", /\bjapanese\b|日本語/], ["chinese", /\bchinese\b|\bmandarin\b|\bcantonese\b|中文/], ["korean", /\bkorean\b|한국어/],
  ["arabic", /\barabic\b/], ["hindi", /\bhindi\b/], ["russian", /\brussian\b/], ["polish", /\bpolish\b/], ["turkish", /\bturkish\b/],
  ["swedish", /\bswedish\b/], ["danish", /\bdanish\b/], ["norwegian", /\bnorwegian\b/], ["finnish", /\bfinnish\b/], ["hebrew", /\bhebrew\b/],
  ["vietnamese", /\bvietnamese\b/], ["thai", /\bthai\b/], ["indonesian", /\bindonesian\b|\bbahasa\b/], ["greek", /\bgreek\b/],
  ["czech", /\bczech\b/], ["hungarian", /\bhungarian\b/], ["romanian", /\bromanian\b/], ["ukrainian", /\bukrainian\b/],
  ["basque", /\bbasque\b|\beuskara\b/], ["catalan", /\bcatalan\b/], ["tagalog", /\btagalog\b|\bfilipino\b/], ["persian", /\bpersian\b|\bfarsi\b/],
];
const languagesIn = (s: string) => new Set(LANGUAGES.filter(([, re]) => re.test(s)).map(([n]) => n));
// A language named as a market, a team or a law ("the German market") is not a language the question asks about.
const NOT_SPOKEN = /\b(english|spanish|french|german|dutch|portuguese|italian|japanese|chinese|korean|arabic|hindi|russian|polish|turkish|swedish|danish|norwegian|finnish|hebrew|vietnamese|thai|indonesian|greek|czech|hungarian|romanian|ukrainian|basque|catalan|persian)[- ](market|customers?|clients?|law|company|companies|team|office|region|citizens?|speaking (market|countr\w*|region))\b/;
function languageNo(question: string, value: string): "no" | null {
  const q = low(question);
  if (NOT_SPOKEN.test(q) || !/\b(speak|fluen\w*|proficien\w*|native|bilingual|language|spreek|vloeiend|parle|habla)/.test(q)) return null;
  const asked = languagesIn(q), have = languagesIn(low(value));
  if (!asked.size || !have.size) return null;
  const missing = [...asked].filter((x) => !have.has(x));
  // "English AND German": one missing is a no. "Spanish or Portuguese": a no only when none of them is theirs.
  if (/\bor\b|\//.test(q)) return missing.length === asked.size ? "no" : null;
  return missing.length ? "no" : null;
}

// WO-052: "Are you currently based in Miami, FL?" for a person in Chicago, IL. Only a no, and only when the person's
// state is not one the question names nor borders one (a metro area can cross a state line: Kansas City, the New York
// area, Portland and Vancouver, WA). Water borders count as borders. A question about moving, commuting or working
// there is not this one.
const BORDERS: Record<string, string> = {
  al: "fl ga ms tn", ak: "", az: "ca co nm nv ut", ar: "la mo ms ok tn tx", ca: "az nv or", co: "az ks ne nm ok ut wy",
  ct: "ma ny ri", de: "md nj pa", dc: "md va", fl: "al ga", ga: "al fl nc sc tn", hi: "", id: "mt nv or ut wa wy",
  il: "ia in ky mi mo wi", in: "il ky mi oh", ia: "il mn mo ne sd wi", ks: "co mo ne ok", ky: "il in mo oh tn va wv",
  la: "ar ms tx", me: "nh", md: "dc de pa va wv", ma: "ct nh ny ri vt", mi: "il in mn oh wi", mn: "ia mi nd sd wi",
  ms: "al ar la tn", mo: "ar ia il ks ky ne ok tn", mt: "id nd sd wy", ne: "co ia ks mo sd wy", nv: "az ca id or ut",
  nh: "ma me vt", nj: "de ny pa", nm: "az co ok tx ut", ny: "ct ma nj pa ri vt", nc: "ga sc tn va", nd: "mn mt sd",
  oh: "in ky mi pa wv", ok: "ar co ks mo nm tx", or: "ca id nv wa", pa: "de md nj ny oh wv", ri: "ct ma ny",
  sc: "ga nc", sd: "ia mn mt nd ne wy", tn: "al ar ga ky mo ms nc va", tx: "ar la nm ok", ut: "az co id nm nv wy",
  vt: "ma nh ny", va: "dc ky md nc tn wv", wa: "id or", wv: "ky md oh pa va", wi: "ia il mi mn", wy: "co id mt ne sd ut",
};
const near = (a: string, b: string) => a === b || (BORDERS[a] ?? "").split(" ").includes(b);
function locationNo(question: string, value: string): "no" | null {
  if (/relocat|willing|commut|open to|remote|hybrid|travel|authori|right to work|visa|sponsor|eligib|miles|within|office|on-?site|in-?person|work (in|from|at)/i.test(question)) return null;
  const home = String(value).split(",")[1]?.trim().toLowerCase();
  if (!home || !(home in STATES)) return null;
  const named = [...question.matchAll(/,\s*([A-Z]{2})\b/g)].map((m) => m[1].toLowerCase()).filter((x) => x in STATES);
  if (!named.length) return null;
  return named.some((x) => near(home, x)) ? null : "no";
}

// How the person heard, as their usual answer onto the employer's list: the careers page has many names.
// WO-048 round 2: the careers page by its own name first ("Litware Careers Website"); a plain website option only when none
// names it, and never "Other Website".
const HOW_HEARD: [RegExp, RegExp, RegExp?][] = [
  [/career|company (web)?site|website|direct/, /career(s)? (site|page|website)|careers at|company (careers page|website|site)|^corporate (careers? )?(web)?site$|^career page$|^careers? site$|direct to careers/, /^website$|web ?site/],
  [/linkedin/, /^linked ?in( jobs)?$|^linkedin$/],
  [/indeed/, /^indeed$/],
  [/glassdoor/, /^glassdoor$/],
];
// A how-heard answer that names a channel (a careers site, LinkedIn): one that can be true of every employer.
export const howHeardChannel = (value: string) => HOW_HEARD.some(([v]) => v.test(low(value)));
// A yes/no question whose answer follows from a stated fact: a citizenship or residence that names the country asked
// about, an education level at or above the one asked, a notice period or start shorter than the one asked.
export function yesNoFromFact(fact: string, value: string, question: string): "yes" | "no" | null {
  const q = low(question), v = low(value);
  if (fact === "languages") return languageNo(question, value);
  if (fact === "location") return locationNo(question, value);
  // WO-052 (sample C): "Are you under 18?" asks the opposite of the person's "over 18".
  if (fact === "over_18" && /\bunder (the age of )?18\b|\byounger than 18\b|\ba minor\b/.test(q)) {
    const yn = yesNoOf(v);
    return yn === "yes" ? "no" : yn === "no" ? "yes" : null;
  }
  const usAsked = /\bu\. ?s\.?a?\b|\bu\.?s\.?a?\b|united states|\bamerica\b/.test(q); // "U. S." too (Tenet3, WO-057)
  // "In Canada or the U.S.?", "a U.S. citizen or permanent resident?": a yes from the person's country is right; a no is not
  // known, since the other half may be true of them (WO-047).
  if ((fact === "citizenship" || fact === "country") && usAsked) return US.test(v) ? "yes" : v && !/\bor\b/.test(q) ? "no" : null;
  if (fact === "education_level") {
    const order = ["high_school", "some_college", "associate", "bachelor", "master", "doctorate"];
    const have = order.indexOf(v.replace(/'s|s$/g, "").replace(/ degree$/, ""));
    if (have < 0) return null;
    if (/high school|ged/.test(q)) return have >= 0 ? "yes" : "no";
    if (/higher education degree|college degree|university degree/.test(q)) return have >= 2 ? "yes" : "no";
    if (/bachelor/.test(q)) return have >= 3 ? "yes" : "no";
    return null;
  }
  if (fact === "notice_period" || fact === "start_date") {
    const m = /(less than|within|under) (\d+) (day|week|month)s?/.exec(q);
    const have = amount(value, "weeks");
    if (!m || have === null) return null;
    const limit = Number(m[2]) * (m[3] === "month" ? 4.345 : m[3] === "day" ? 1 / 7 : 1);
    return have <= limit ? "yes" : "no";
  }
  return null;
}

// A language level the person stated, onto a list of levels (WO-048 round 2): native (or bilingual, mother tongue, first
// language) onto the one option that says native, else the one that says fluent; fluent onto the one that says fluent.
// Any other level, or no level, or two options that could be it: null (asked).
export function levelOption(level: string, options: Opt[]): string | null {
  const lv = low(level);
  const not = (l: string) => /\bnot\b|\bnon-?(native|fluent)\b/.test(l);
  if (/^(native|bilingual|mother tongue|first language)$/.test(lv)) {
    const nat = options.filter((o) => /\bnative\b|\bbilingual\b|\bmother tongue\b|\bfirst language\b/.test(low(o.label)) && !not(low(o.label)));
    if (nat.length) return only(nat);
  }
  if (/^(native|bilingual|mother tongue|first language|fluent)$/.test(lv)) return only(options.filter((o) => /\bfluent\b/.test(low(o.label)) && !not(low(o.label))));
  return null;
}

// The two-class eligibility classification (ELIGIBILITY-SEPARATION-PROPOSAL.md, as corrected on the spent-s1
// regression), exported so EVERY path that classifies an option uses the same tests: chooseOption's
// work_authorization rule below, and the widget contract gate (apply_core's optionRule, which refuses what
// these classes mark when an option is offered to a single fact). Work authorization and sponsorship are
// separate facts, and one fact alone fills only an option that speaks to that fact alone:
// (1) assertsSponsorshipNeed — an option that POSITIVELY asserts a sponsorship need ("will require
// sponsorship", "require sponsorship", "need sponsorship", "sponsorship is required / necessary"). A need
// assertion belongs to the sponsorship fact alone; phrasings that negate the need are the
// authorized-without-sponsorship class, not this one ("without sponsorship", "will not / do not require
// sponsorship", "no sponsorship", "sponsorship not required"). The exclusion is never the bare substring
// "sponsor": the first landing's !/sponsor/ test dropped Workday's "Authorized to work in the U.S. without
// sponsorship" — the only fillable option on spent-s1 — and left the required dropdown empty.
// (2) assertsSeparateSponsorshipPosition — a COMBINED answer: an option phrased as a compound reply (a
// leading yes/no, or a coordinating conjunction) that takes its own sponsorship position in a predicated
// clause ("Yes, I am authorized and do not require sponsorship"). Picking it from one fact alone would
// assert a sponsorship position that fact does not carry; combined answers are answered from both facts by
// career_apply.ts (authorizedWithoutSponsorship). A status label whose sponsorship wording merely modifies
// the authorization status itself, with no predicated clause and no compound phrasing ("Authorized to
// work in the U.S. without sponsorship"), is not combined and stays fillable.
export function assertsSponsorshipNeed(label: string): boolean {
  const l = low(label);
  if (/\bwithout\b[^.]{0,40}\bsponsor/.test(l) || /\bnot\s+(require|requires|required|need|needs|needed|necessary)\b/.test(l) || /\bno\s+(visa\s+|employment\s+)?sponsorship\b/.test(l) || /n't\s+(require|need)\b/.test(l)) return false;
  return /\b(require|requires|required|need|needs|needing)\b[^.]{0,40}\bsponsor/.test(l) || /\bsponsorship\b[^.]{0,30}\b(is\s+)?(required|needed|necessary)\b/.test(l);
}
export function assertsSeparateSponsorshipPosition(label: string): boolean {
  const l = low(label);
  const clause = /\b(require|requires|required|need|needs|needed|needing)\b[^.]{0,40}\bsponsor/.test(l) || /\bsponsorship\b[^.]{0,30}\b(is\s+)?(required|needed|necessary)\b/.test(l);
  if (!clause) return false;
  return /^\s*(yes|no)\b/.test(l) || /\b(and|but)\b/.test(l);
}

// An option that asserts unrestricted authorization: for any employer, or without sponsorship, with no restriction
// and no future or present-employer qualification — the option chooseOption's work_authorization rule names for an
// affirmative authorization fact, stated once here so every reader tests the same predicate.
export function unrestrictedAuthorization(label: string): boolean {
  const t = low(label);
  return /any employer|without (visa |employment )?sponsorship|no restriction|do not (need|require)|not require|unrestricted/.test(t) &&
    !/will (need|require)|in the future|present employer|current employer/.test(t);
}

// One option tested against the person's stated degree level: the level's own wording, never a degree in progress —
// the per-option test of chooseOption's education rule, stated once here so every reader tests the same predicate.
export function degreeOptionFor(factValue: string, label: string): boolean {
  const v = low(factValue);
  const re = EDUCATION[v.replace(/'s|s$/g, "").replace(/ degree$/, "")] ?? EDUCATION[v];
  if (!re) return false;
  const t = low(label);
  return re.test(t) && !/in progress|pursuing|currently enrolled|incomplete|candidate|expected/.test(t);
}

export function chooseOption(fact: string, value: string, options: Opt[], question = ""): string | null {
  if (!options.length) return null;
  const v = low(value);
  const derived = question ? yesNoFromFact(fact, value, question) : null;
  // A question that asks the opposite of the person's stated yes or no ("Are you under 18?" for a yes to over 18): the
  // derived answer, never the person's word taken literally (WO-052, sample C).
  if (derived && yesNoOf(v) && derived !== yesNoOf(v)) return byYesNo(derived, options);
  // The person's own words, exactly as an option: always first.
  const exact = options.filter((o) => low(o.label) === v || low(o.value) === v);
  if (exact.length) return exact[0].value;
  // WO-058 (sealed-wd3 t2): a leaf under categories ("Mathematics & Statistics > Statistics", Workday's prompt) is the
  // person's own words when its leaf is; two leaves of that name under two categories: asked. How the person heard has its
  // own reading of a nested list below ("LinkedIn" beside "LinkedIn Jobs" is the person's to pick, WO-048).
  const leaf = fact === "how_heard" ? [] : options.filter((o) => / > /.test(o.label) && low(o.label).split(/\s+>\s+/).pop() === v);
  if (leaf.length === 1) return leaf[0].value;
  if (DECLINE.test(v) || v === "decline") return only(options.filter((o) => DECLINE.test(low(o.label))));
  // A derived yes or no lands only on a yes or no option; a list with no yes ("Master's | Bachelor's | ... | Not
  // applicable", "Canada | US | Other") is answered by the fact itself, below (WO-047).
  if (derived) {
    const yn = byYesNo(derived, options);
    if (yn || options.some((o) => yesNoOf(o.label) === "yes")) return yn;
  }
  switch (fact) {
    case "how_heard": {
      const rule = HOW_HEARD.find(([v2]) => v2.test(v));
      if (!rule) return null;
      // A nested list's option reads "Category > Leaf" (Workday's prompt): it matches by its leaf or by its whole path.
      // WO-052: "Ad on Website" is an advertisement, not the careers site (Accenture).
      const hit = (re: RegExp) => options.filter((o) => (re.test(low(o.label)) || re.test(low(o.label).split(/\s+>\s+/).pop()!)) && !/\bads?\b|advert|sponsored|banner/.test(low(o.label)) && !/universit|college|school|campus|student|handshake/.test(low(o.label)));
      const named = hit(rule[1]);
      if (named.length || !rule[2]) return only(named);
      return only(hit(rule[2]).filter((o) => !/\bother\b/.test(low(o.label))));
    }
    case "languages": {
      if (options.every((o) => yesNoOf(o.label))) break;
      // WO-052: a level list for a language the person does not speak (their list is complete): only the no-ability
      // option ("Limited / No Japanese language ability"), never a level (Woven).
      if (derived === "no") return only(options.filter((o) => /\b(no|none|not)\b.*\b(ability|knowledge|proficiency|skills?)\b|^none\b|^no\b/.test(low(o.label))));
      // WO-048 round 2: one language's level on a list ("How would you rate your English proficiency?"): only a level the
      // person stated as native or fluent for the one language the question names, onto the one option that says so. A
      // yes/no list is read as before; no level, another language, or two options that could be it: asked.
      const named = LANGUAGE_NAMES.filter((l) => new RegExp(`\\b${l}\\b`).test(low(question)));
      if (!named.length) break;
      if (named.length !== 1) return null;
      const level = String(value).split(/\s*[;,\n]\s*/).map((x) => /^([^()]+?)\s*(?:\(([^)]*)\))?$/.exec(x.trim()))
        .find((m) => m && low(m[1]) === named[0])?.[2];
      return levelOption(level ?? "", options);
    }
    case "graduation_date": {
      // WO-052: a list of years ("2040 ... 2001") takes the year of the stated date (Theodo).
      const y = /\b(19|20)\d{2}\b/.exec(v)?.[0];
      if (y && options.every((o) => /^\s*(19|20)\d{2}\s*$/.test(o.label))) return only(options.filter((o) => o.label.trim() === y));
      break;
    }
    case "work_authorization": {
      if (yesNoOf(v) !== "yes") break;
      // The two-class classification above, applied verbatim: this fact alone fills only an option that
      // speaks to authorization alone — never a positive sponsorship need, never a combined answer that
      // takes its own sponsorship position. Combined answers are answered from both facts by
      // career_apply.ts (authorizedWithoutSponsorship). Which class is correct comes from the profile's
      // work-authorization fact, never inferred from sponsorship.
      const free = options.filter((o) => !assertsSponsorshipNeed(o.label) && !assertsSeparateSponsorshipPosition(o.label) && unrestrictedAuthorization(o.label));
      if (free.length === 1) return free[0].value;
      // Consistency with the widget gate (apply_core's optionRule, same two classes): when this menu carries
      // a classified option and the QUESTION is a plain authorization question, the yes/no landing below the
      // switch must not reach it either — the generic fall-through knows nothing of the classes and would
      // land on a need assertion or a combined answer from this fact alone. The one sanctioned route to a
      // combined answer stays open: when the question itself asks the combined thing (career_apply's
      // WITHOUT_SPONSOR test on the label), byMeaning has already derived the value from BOTH facts before
      // this call, and the fall-through's landing is that derivation's, not this fact's alone.
      const classified = (o: Opt) => assertsSponsorshipNeed(o.label) || assertsSeparateSponsorshipPosition(o.label);
      if (options.some(classified) && !/\bwithout\b.{0,40}\bsponsor/i.test(question)) return byYesNo("yes", options.filter((o) => !classified(o)));
      break;
    }
    case "education_level": {
      const re = EDUCATION[v.replace(/'s|s$/g, "").replace(/ degree$/, "")] ?? EDUCATION[v];
      if (!re) return null;
      // A degree held is never one in progress. Two options that differ only in wording ("Bachelors" and "Bachelor's
      // Degree" on one live list, WO-042) are one answer: the person's own wording, else the one that says "degree", else
      // the first. "Bachelor of Arts" and "Bachelor of Science" differ in meaning, and the person is asked.
      // WO-052: "Bachelor's in a relevant engineering or science discipline" asks whether the field fits this job too.
      if (options.some((o) => /\brelevant\b|\brelated\b|\bdiscipline\b|\bfield\b/.test(low(o.label)))) return null;
      const hits = options.filter((o) => degreeOptionFor(value, o.label));
      const core = (l: string) => low(l).replace(/'s\b|\bdegree\b|[^a-z]/g, "").replace(/s$/, "");
      if (hits.length > 1 && hits.every((o) => core(o.label) === core(hits[0].label))) return (hits.find((o) => low(o.label) === v) ?? hits.find((o) => /\bdegree\b/.test(low(o.label))) ?? hits[0]).value;
      return only(hits);
    }
    case "state": {
      // A place list names the state with its country ("Illinois, United States", Ashby's search; WO-042).
      const full = STATES[v] ?? v;
      return only(options.filter((o) => {
        const l = low(o.label).replace(/\s*,\s*(united states( of america)?|usa|us)$/, "");
        return l === full || STATES[l] === full;
      }));
    }
    case "location":
    case "city": {
      // "Chicago, IL" onto a place list ("Chicago, Illinois, United States"): the same city, in the same state when one
      // is stated; "North Chicago" or "Chicago Heights" is another city. Only one such place, or nothing (WO-042).
      const [city, st] = v.split(/\s*,\s*/);
      if (!city) return null;
      const full = st ? STATES[st] ?? st : null;
      return only(options.filter((o) => {
        const parts = low(o.label).split(/\s*,\s*/);
        return parts[0] === city && (!full || parts[1] === full || STATES[parts[1]] === full);
      }));
    }
    case "country":
    case "citizenship":
      if (US.test(v)) {
        // A country list holds "United States" and "United States Minor Outlying Islands": the country itself, when it is
        // there exactly once, is the answer (WO-047, Canonical).
        const itself = options.filter((o) => US.test(low(o.label)));
        if (itself.length === 1) return itself[0].value;
        // WO-048: the same on a phone code list ("United States of America (+1)" beside "... Outlying Islands (+1)").
        const whole = options.filter((o) => US.test(low(o.label).replace(/\s*\(\+\d{1,4}\)$/, "")));
        if (whole.length === 1 && options.filter((o) => /^united states\b/.test(low(o.label))).length > 1) return whole[0].value;
        return only(options.filter((o) => US.test(low(o.label)) || /^united states\b|u\.?s\.? citizen/.test(low(o.label)))) ?? usCitizenChoice(v, options);
      }
      return only(options.filter((o) => low(o.label).startsWith(v)));
    case "notice_period":
    case "start_date":
      return bySpan(value, options, "weeks");
    case "years_experience":
      return bySpan(value, options, "years");
    case "salary_expectation":
      return byPayRange(value, options);
    case "pronouns": {
      const p = /she/.test(v) ? /she/ : /he\/him|^he/.test(v) ? /\bhe\b/ : /they/.test(v) ? /they/ : null;
      return p ? only(options.filter((o) => p.test(low(o.label)))) : null;
    }
    case "security_clearance":
      if (/^(none|no|n\/a)$/.test(v)) return only(options.filter((o) => /^none\b|do not.*(hold|have)|never held|not.*hold|^n\/a|^no\b/.test(low(o.label))));
      return only(options.filter((o) => low(o.label).includes(v)));
  }
  const yn = yesNoOf(v);
  if (yn) return byYesNo(yn, options);
  // One option that contains the answer whole (a city in "Yes - Boston, MA" is not this; that has a yes first).
  return only(options.filter((o) => low(o.label).includes(v) && v.length >= 3));
}
