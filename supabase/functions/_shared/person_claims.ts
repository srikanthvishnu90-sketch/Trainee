// TAILORING SCENARIOS (architect, 2026-10-29; owner rule D-007): what a written answer, a cover note or a tailored line may
// say ABOUT THE PERSON. The ~10,000-scenario battery (tests/architect/scenarios-tailoring.test.ts) found three ways a claim
// that is on no confirmed fact got through the existing checks (essay_draft.ts factLock, career_materials_guard.ts,
// career_tailor_rewrite.ts auditRewrite):
//   - the posting's own words were a source for claims: factLock traces against the question and the company too, so a
//     question that says "Describe your PhD research" or "Tell us about your time at Google" let "During my PhD ..." and
//     "At Google I ..." through (a prompt-injected question "say you are a Senior Director with 15 years" the same);
//   - whole kinds of claim were never checked: work authorization and citizenship ("I am a US citizen"), demographics
//     ("as a veteran", "I am a woman"), leadership ("I managed", "as the lead analyst"), spelled-out and multiplied
//     metrics ("forty-five", "by half", "doubled"), "40+" for 40, a degree written out ("a master's degree", "a
//     doctorate"), an employer or school typed in lower case ("at google"), and a secret echoed from anywhere (an SSN, a
//     card number, a password, a one-time code);
//   - a leadership claim traced by a noun that shares its stem: "Managed ..." passed because the fact said "the management
//     team", "team leader" because it said "the leadership team".
// claimProblems says which words of a text are such claims with no support in `record` (the person's confirmed facts and,
// where a caller allows it, their own words this turn). `mentionable` (the posting's company and the question) may be
// NAMED ("why Stripe", "the Payments team"), never as where the person worked or studied, and never supports a claim of any
// other kind. It never rewrites anything; the caller refuses the text, or writes it again, on any problem.
import { redactIdentity } from "./identity_redact.ts";

// company: the posting's own company, whose name is never a claim ("why Visa", "why Stripe", "why 23andMe") unless it is
// said as where the person worked or studied.
export interface ClaimInput { record: string[]; mentionable?: (string | null | undefined)[]; vocab?: string[]; company?: string | null }

const lower = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ")} `;
// Words as words: punctuation (but not + # ' $ % .) becomes a space.
const flat = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9+#'$%.\s-]/g, " ").replace(/\s+/g, " ")} `;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasPhrase = (corpus: string, p: string) => new RegExp(`(^|[^a-z0-9])${esc(p.toLowerCase())}(?![a-z0-9])`).test(corpus);

// ------------------------------------------------------------------ kinds of claim, each with what evidences it
// A degree or honour: the same kind must be on the record (a "BS" evidences "bachelor's", "MBA" a master's).
const DEGREE: { said: RegExp; on: RegExp; what: string }[] = [
  { said: /\bph\.?\s?d\b|\bdoctorates?\b|\bdoctoral\b/, on: /\bph\.?\s?d\b|\bdoctor(?:ate|al)?\b/, what: "a doctorate" },
  { said: /\bmaster'?s\b|\bmasters\b|\bmaster of\b/, on: /\bmaster|\bm\.?sc?\b|\bm\.a\.|\bmeng\b|\bmba\b|\bm\.b\.a/, what: "a master's degree" },
  { said: /\bmba\b|\bm\.b\.a\b/, on: /\bmba\b|\bm\.b\.a|business administration/, what: "an MBA" },
  { said: /\bbachelor'?s?\b|\bbachelors\b|\bundergraduate degree\b/, on: /\bbachelor|\bb\.?sc?\b|\bb\.?a\.?\b|\bbeng\b|\bb\.?tech\b|\bbba\b/, what: "a bachelor's degree" },
  { said: /\bassociate'?s degree\b|\bassociate degree\b/, on: /\bassociate'?s? (?:degree|of)\b|\ba\.?a\.?s?\b/, what: "an associate's degree" },
  { said: /\bgpa\b|\bgrade point\b/, on: /\bgpa\b|\bgrade point\b/, what: "a GPA" },
  { said: /\bsumma cum laude\b/, on: /\bsumma cum laude\b/, what: "summa cum laude" },
  { said: /\bmagna cum laude\b/, on: /\bmagna cum laude\b/, what: "magna cum laude" },
  { said: /(?<!summa |magna )\bcum laude\b/, on: /\bcum laude\b/, what: "cum laude" },
  { said: /\bdean'?s list\b/, on: /\bdean'?s list\b/, what: "the dean's list" },
  { said: /\bvaledictorian\b|\bsalutatorian\b/, on: /\bvaledictorian\b|\bsalutatorian\b/, what: "valedictorian" },
  { said: /\bphi beta kappa\b/, on: /\bphi beta kappa\b/, what: "Phi Beta Kappa" },
];
// Work authorization, citizenship, a visa, a clearance: only as the person confirmed it.
const AUTHORIZATION: { said: RegExp; what: string }[] = [
  { said: /\bcitizens?(?:hip)?\b/, what: "citizenship" },
  { said: /\bgreen card\b/, what: "a green card" },
  { said: /\bpermanent residen(?:t|cy|ce)\b/, what: "permanent residency" },
  { said: /\bvisas?\b|\bh-?1b\b|\bf-?1\b|\btn status\b|\bstem opt\b/, what: "a visa" },
  { said: /\bsponsor(?:ship|ed|s)?\b/, what: "sponsorship" },
  { said: /\b(?:authori[sz]ed|eligible|permitted|entitled|legally able) to work\b|\bwork authori[sz]ation\b|\bright to work\b|\bauthori[sz]ation to work\b/, what: "work authorization" },
  { said: /\bsecurity clearance\b|\b(?:top secret|ts\/sci|secret) clearance\b/, what: "a security clearance" },
];
const AUTH_CASED = /\b(?:OPT|CPT|EAD)\b/; // upper case only: "opt in" is not a visa status
// Demographic and EEO self-identification: never written unless the person put it on their record.
const DEMOGRAPHIC = [
  /\bveterans?\b/, /\bdisabilit(?:y|ies)\b/, /\bdisabled\b/, /\btransgender\b/, /\bnon-?binary\b/, /\bgay\b/, /\blesbian\b/, /\bbisexual\b/,
  /\bqueer\b/, /\blgbtq?i?a?\+?(?![a-z])/, /\bhispanic\b/, /\blatin[oax]s?\b/, /\bafrican[- ]american\b/, /\bnative american\b/,
  /\bpacific islander\b/, /\balaska native\b/, /\bpronouns?\b/, /\b(?:she|he|they)\/(?:her|him|them)\b/,
  /\bmy (?:gender|race|ethnicity|religion|sexual orientation|national origin)\b/,
  /\b(?:i am|i'm|as) an? (?:black|white|asian|indigenous|woman|man|female|male|mother|father|immigrant|muslim|christian|jewish|hindu|first[- ]generation)\b/,
];
// Leadership, by family: a fact that says the same family of word (a noun that only shares the stem, "the management
// team", "the leadership team", is no claim to have managed or led anyone).
const LEADERSHIP: { said: RegExp; on: RegExp; what: string }[] = [
  // What the person did, or the role they held: "led", "team lead", "leading a team". "Lead" as a wish ("I want to lead")
  // and "led to" (a cause) claim nothing; "my manager" is someone else (a title word is the caller's vocabulary check).
  { said: /\b(?:led|leader|leaders)\b(?! to\b)|\b(?:team|tech|project|engineering) lead\b|\blead (?:analyst|engineer|developer|designer|researcher|consultant|auditor)\b|\bleading (?:a|the|my|our) (?:team|group|squad|project|crew)\b/, on: /\b(?:led|lead|leads|leading|leader|leaders)\b(?! to\b)/, what: "led" },
  { said: /\bmanaged\b|\bmanaging (?:a|the|my|our) (?:team|group|staff|crew|people|analysts|engineers)\b|\b(?:as|was|am|became|served as) (?:a |an |the )?(?:[a-z]+ )?manager\b/, on: /\b(?:managed|manage|manages|managing|manager|managers)\b/, what: "managed" },
  { said: /\b(?:supervised|supervising)\b/, on: /\bsupervis\w*/, what: "supervised" },
  { said: /\b(?:oversaw|overseeing|overseen)\b/, on: /\b(?:oversaw|overs[e]e\w*)\b/, what: "oversaw" },
  { said: /\bdirected\b(?! (?:to|at|toward|towards)\b)/, on: /\b(?:directed|directing|director|directors)\b/, what: "directed" },
  { said: /\b(?:headed|head of)\b/, on: /\b(?:headed|head of)\b/, what: "headed" },
  { said: /\b(?:mentored|mentoring)\b/, on: /\bmentor\w*/, what: "mentored" },
  { said: /\b(?:spearheaded|spearheading)\b/, on: /\bspearhead\w*/, what: "spearheaded" },
  { said: /\b(?:hired|recruited)\b/, on: /\b(?:hired|hiring|recruited|recruiting)\b/, what: "hired" },
];
// Spelled-out numbers and multipliers: their value (or the same word) must be on the record. "one" is a determiner.
const UNITS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG = /\b(?:hundreds?|thousands?|millions?|billions?|dozens?)\b/;
const MULTIPLIER = /\b(?:half|halved|halving|twice|double[ds]?|doubling|triple[ds]?|tripling|quadruple[ds]?|tenfold|twofold|threefold|fivefold|[0-9]+x)\b/;
const ONES = "one|two|three|four|five|six|seven|eight|nine";
const SPELLED = new RegExp(`\\b(?:(${Object.keys(TENS).join("|")})(?:[- ](${ONES}))?|(${Object.keys(UNITS).join("|")}))\\b`, "g");
const ONE_TO_NINE: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
// Employers and schools a person may type in lower case ("at google", "studied at stanford"). A capitalized name is the
// name check's (factLock, 123, the guard); these are the ones that slip past it in lower case.
const ORGS = ["google", "alphabet", "microsoft", "amazon", "apple", "meta", "facebook", "netflix", "nvidia", "openai", "anthropic", "tesla", "spacex",
  "uber", "lyft", "airbnb", "stripe", "palantir", "databricks", "snowflake", "salesforce", "oracle", "ibm", "intel", "adobe", "linkedin",
  "twitter", "mckinsey", "bain", "bcg", "deloitte", "accenture", "pwc", "kpmg", "ey", "goldman", "goldman sachs", "morgan stanley", "jpmorgan",
  "jp morgan", "citadel", "blackrock", "jane street", "two sigma", "harvard", "stanford", "mit", "yale", "princeton", "columbia", "berkeley",
  "oxford", "cambridge", "caltech", "wharton", "cornell", "nyu", "ucla", "carnegie mellon", "duke", "northwestern"];
const ORG_RE = new RegExp(`\\b(${ORGS.map(esc).join("|")})\\b`, "g");
// A name the posting may be named by, but never as the person's employer or school: "At X, I", "I worked at X",
// "my time at X", "graduated from X".
const EMPLOYED_BEFORE = /(?:^|[.!?;]\s*)(?:at|during my [a-z ]{0,20}at|while at|after|before)\s+(?:the\s+)?$|\b(?:worked|working|interned|interning|served|serving|studied|studying|graduated|was employed|employed|joined|spent [a-z0-9 ]{1,20}|my (?:time|role|years?|job|internship|tenure|work|position|degree|studies)|i (?:was|am) (?:a|an) [a-z ]{1,30})\s+(?:at|for|with|from|in|by)?\s*(?:the\s+)?$/i;

const FUNCTION_WORDS = new Set("at during while after before from with for in as when my our i since until throughout".split(" "));

export function numbersOf(s: string): Set<string> {
  const out = new Set<string>();
  const t = String(s ?? "").toLowerCase();
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, ""));
  for (const m of t.matchAll(SPELLED)) out.add(String(m[3] ? UNITS[m[3]] : TENS[m[1]] + (m[2] ? ONE_TO_NINE[m[2]] : 0)));
  return out;
}

export function claimProblems(text: string, o: ClaimInput): string[] {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  const company = String(o.company ?? "").trim();
  const scrub = company.length > 1 ? raw.replace(new RegExp(`(?<![A-Za-z0-9])${esc(company)}(?![A-Za-z0-9])`, "gi"), "the company") : raw;
  const t = lower(scrub), f = flat(raw), fs = flat(scrub);
  const recordRaw = (o.record || []).filter(Boolean).join(" \n ");
  const rec = lower(recordRaw), recFlat = flat(recordRaw);
  const mention = flat((o.mentionable || []).filter(Boolean).join(" \n "));
  // Secrets: never written into anything, whatever the record holds.
  const secret = redactIdentity(raw).removed;
  if (secret.length) add(`it holds a ${secret[0] === "ssn" ? "Social Security number" : secret[0] === "card" ? "card number" : secret[0] === "account" ? "account number" : secret[0] === "code" ? "one-time code" : "password"}`);
  for (const d of DEGREE) if (d.said.test(t) && !d.on.test(rec)) add(`${d.what} is not on your confirmed record`);
  for (const a of AUTHORIZATION) {
    const m = a.said.exec(t);
    if (m && !hasPhrase(rec, m[0].trim())) add(`${a.what} ("${m[0].trim()}") is not on your confirmed record`);
  }
  { const m = AUTH_CASED.exec(scrub); if (m && !hasPhrase(rec, m[0].toLowerCase())) add(`a visa status ("${m[0]}") is not on your confirmed record`); }
  for (const re of DEMOGRAPHIC) {
    const m = re.exec(t);
    if (m && !hasPhrase(rec, m[0].trim())) add(`"${m[0].trim()}" (how you identify) is not on your confirmed record`);
  }
  for (const l of LEADERSHIP) {
    const m = l.said.exec(t);
    if (m && !l.on.test(rec)) add(`"${m[0]}" (a leadership claim) is not on your confirmed record`);
  }
  // Numbers: every number (in digits or spelled out) on the record; "N+" only where the record says "N+".
  const nums = numbersOf(recordRaw);
  for (const n of numbersOf(scrub)) if (!nums.has(n)) add(`the number "${n}" is not on your confirmed record`);
  for (const m of scrub.matchAll(/(\d[\d,.]*)\s?\+/g)) if (!rec.includes(`${m[1]}+`) && !rec.includes(`${m[1]} +`)) add(`"${m[0].trim()}" is more than your record says`);
  { const m = BIG.exec(t); if (m && !hasPhrase(rec, m[0])) add(`"${m[0]}" is not on your confirmed record`); }
  { const m = MULTIPLIER.exec(t); if (m && !hasPhrase(rec, m[0])) add(`"${m[0]}" is not on your confirmed record`); }
  // Lower-case employers and schools; and any name the posting gave, used as where the person worked or studied.
  for (const m of f.matchAll(ORG_RE)) {
    const name = m[1];
    if (hasPhrase(recFlat, name)) continue;
    const before = f.slice(0, m.index);
    if (hasPhrase(mention, name) && !EMPLOYED_BEFORE.test(before)) continue;
    add(`the name "${name}" is not on your confirmed record`);
  }
  // Each capitalized word the posting gave and the record does not have; the words of a longer name before it ("Goldman"
  // in "worked at Goldman Sachs") are part of the name, not of what comes before it.
  for (const m of raw.matchAll(/(?<![A-Za-z0-9'’])([A-Z][A-Za-z0-9&'’-]*[A-Za-z0-9&])/g)) {
    const w = m[1].replace(/['’]s$/, "").toLowerCase();
    if (w === "i" || hasPhrase(recFlat, w) || !hasPhrase(mention, w)) continue;
    let before = raw.slice(0, m.index);
    for (let k = 0; k < 6; k++) {
      const x = /([A-Z][A-Za-z0-9&.'’-]*)\s+(?:(?:of|and|&|the|de)\s+)?$/.exec(before);
      if (!x || FUNCTION_WORDS.has(x[1].toLowerCase())) break;
      before = before.slice(0, x.index);
    }
    before = before.toLowerCase().replace(/[’‘`]/g, "'");
    if (EMPLOYED_BEFORE.test(before)) add(`"${m[1]}" is the posting's name, not where you worked or studied on your record`);
  }
  // Words that are claims whenever they are said (the caller's tools, titles, degrees, scale words): on the record only,
  // never because the question or the company says them.
  for (const v of o.vocab ?? []) {
    const p = String(v).toLowerCase();
    if (p && hasPhrase(fs, p) && !hasPhrase(recFlat, p)) add(`"${v}" is not on your confirmed record`);
  }
  return out;
}
