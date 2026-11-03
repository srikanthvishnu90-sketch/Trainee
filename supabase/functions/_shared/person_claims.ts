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
//
// TAILORING ROUND 2 (architect, 2026-10-30; tests/architect/scenarios-tailoring-r2.test.ts). Two directions:
//   - honest text was refused (measured on a corpus of drafts built only from confirmed facts): "a veteran engineer" read
//     as a military claim; "my manager said", "a manager who gives feedback", "reported to the head of sales" read as the
//     person's own title; "double-checked" and "double down" as a multiplier; "managed to" and "was led by" as leadership;
//     a number or year the posting states, said as the posting's ("the 5 years this role asks for", "founded in 2010"), as
//     the person's; a title that names another company ("your Google Cloud Engineer role") as theirs. A role word now counts
//     as a claim only when it is said of the person (roleFraming); a posting's number only in a clause about the posting
//     that claims nothing of the person (postingClause).
//   - claims still got through: an employer or school typed in lower case that is not a well-known name ("i worked at
//     initech", "graduated from northfield state"), a year spelled out ("twenty nineteen"), a range or a vague span ("3-5
//     years", "over a decade", "a few years"), a percent in words ("forty percent" traced to "40 sales reps"), "as the
//     lead on", ownership ("point person", "in charge of"), a promotion, certifications and licences (AWS certified, CPA,
//     PMP), clearances (TS/SCI, "top secret"), languages ("fluent in spanish", "bilingual"), nationality ("as a green card
//     holder", "as an American", "a U.S. person"), military service ("served in the army"), awards and publications, and
//     fractions ("by a third").
import { redactIdentity } from "./identity_redact.ts";

// company: the posting's own company, whose name is never a claim ("why Visa", "why Stripe", "why 23andMe") unless it is
// said as where the person worked or studied.
// line: a tailored resume line (career_materials_guard.ts), where any name after "at", "for", "with", "from" or "by" is an
// employer, school or client and must be on the record ("Built SQL dashboards at hooli").
export interface ClaimInput { record: string[]; mentionable?: (string | null | undefined)[]; vocab?: string[]; company?: string | null; line?: boolean }

const lower = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ")} `;
// Words as words: punctuation (but not + # ' $ % .) becomes a space.
const flat = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9+#'$%.\s-]/g, " ").replace(/\s+/g, " ")} `;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasPhrase = (corpus: string, p: string) => new RegExp(`(^|[^a-z0-9])${esc(p.toLowerCase())}(?![a-z0-9])`).test(corpus);
const all = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

// ------------------------------------------------------------------ who a word is said of
// The words of the same sentence before a match (lower case).
function sentenceBefore(t: string, at: number): string {
  const b = t.slice(0, at);
  const i = Math.max(b.lastIndexOf(". "), b.lastIndexOf("! "), b.lastIndexOf("? "), b.lastIndexOf("; "), b.lastIndexOf(": "), b.lastIndexOf("\n"));
  return ` ${b.slice(i + 1).replace(/\s+/g, " ").trimStart()}`;
}
const FILL = "(?:(?!(?:to|with|for|from|by|under|of|about|and|or|on|at|in|who|that|which)\\b)[a-z-]+\\s+){0,2}";
const POSSESSIVE_BEFORE = /\s(?:my|our|your|his|her|their|whose|[a-z]+'s)\s+(?:[a-z-]+\s+){0,2}$/;
const SELF_POSSESSIVE = /\s(?:i am|i'm|i was|i've been|i have been|i became|became|served as|worked as|acted as|serving as|working as)\s+(?:my|our|their|his|her)\s+(?:[a-z-]+\s+){0,2}$/;
// A role said of "you" is a claim too: in a reply "you" is the person, in an outreach draft the recipient (whose title is
// only from their row), never "someone else" (TAILORING R2 fix: "I see you're a data scientist at Stripe" read as "a ...",
// someone else's role, and an invented recipient title passed the outreach fact-lock).
const CLAIMED_BEFORE = new RegExp(`\\s(?:you are|you're|youre|you were|you've been|you have been|you had been|you became|i am|i'm|im|i was|i've been|i have been|i had been|i became|i served|i acted|i stepped in|as|became|serving as|served as|worked as|working as|work as|acting as|acted as|stepped in as|promoted to|hired as|joined as|role as|title of|title as|title is|title was|position as|being)\\s+(?:(?:a|an|the|their|its|our)\\s+)?${FILL}$`);
const OTHER_BEFORE = /\s(?:a|an|the|this|that|these|those|each|every|another|other|some|any|our|my|your|his|her|their|its|whose|to|with|for|from|by|under|alongside|among|like|than|about|and|or|whom|of)\s+(?:[a-z-]+\s+){0,2}$/;
// A role word ("manager", "director", "head of", "lead", "veteran") is a claim about the person when it is said of them
// ("I was the manager", "as a team lead", "my role as director"); not when it names someone else ("my manager said", "a
// manager who gives feedback", "reported to the head of sales", "learn from the leaders", "your Google Cloud Engineer
// role"). Anything else is read as a claim (fail closed).
export function roleFraming(before: string): "self" | "other" {
  const b = ` ${String(before ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'\s-]/g, " ").replace(/\s+/g, " ").trimStart()}`;
  if (POSSESSIVE_BEFORE.test(b)) return SELF_POSSESSIVE.test(b) ? "self" : "other";
  if (CLAIMED_BEFORE.test(b)) return "self";
  return OTHER_BEFORE.test(b) ? "other" : "self";
}
// Every place `word` is said in `text` as the person's own role.
export function selfRole(text: string, word: string): boolean {
  const t = lower(text);
  const re = new RegExp(`(?<![a-z0-9])${esc(word.toLowerCase()).replace(/\\? /g, "[\\s-]+")}(?![a-z0-9])`, "g");
  for (const m of t.matchAll(re)) if (roleFraming(sentenceBefore(t, m.index!)) === "self") return true;
  return false;
}

// ------------------------------------------------------------------ the posting's own numbers
// A clause about the posting or the company ("this role asks for 5 years", "your team, founded in 2010") may repeat a
// number the posting states, as long as it claims nothing of the person in the same clause.
const POSTING_SUBJECT = /\b(?:th(?:e|is|at) (?:role|posting|position|job|opening|listing|description|req|requisition|team|company|program|internship|firm|organi[sz]ation)|your (?:posting|role|team|company|listing|job|description|mission|program|firm|organi[sz]ation|business|product|platform)|you(?:'re| are| were| have)?)\b[^.;!?]{0,60}?\b(?:asks?|asking|asked|requires?|required|requiring|needs?|needed|wants?|calls? for|lists?|listed|mentions?|mentioned|says?|said|seeks?|seeking|looks? for|looking for|founded|started|launched|serves?|served|has|have|had|was|were|employs?|grew|raised|operates?|opened|expanded|is|are)\b/;
const POSTING_EVENT = /\b(?:founded|established|launched|started|opened|incorporated|ipo'?d) in\b/;
const PERSON_IN_CLAUSE = /\b(?:i|i've|i'd|i'm|me)\b(?!\s+(?:want|hope|aim|plan|wish|admire|read|saw|noticed|see|would like to|would love to)\b)|\bmy\b/;
const clausesOf = (t: string) => t.split(/(?<=[.;!?])\s+|\n/);
export function postingClause(clause: string): boolean {
  const c = lower(clause);
  return (POSTING_SUBJECT.test(c) || POSTING_EVENT.test(c)) && !PERSON_IN_CLAUSE.test(c);
}

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
  // Round 2: honours said in other words.
  { said: /\b(?:top|first|best) (?:of|in) (?:my|the|our) (?:class|cohort|program|year|graduating class)\b/, on: /\b(?:top|first|best) (?:of|in) (?:my|the|our) (?:class|cohort|program|year)\b/, what: "top of the class" },
  { said: /\bwith (?:high |highest )?(?:honou?rs|distinction)\b|\bhonou?rs (?:program|college|society|student)\b/, on: /\bhonou?rs\b|\bdistinction\b/, what: "honours" },
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
  // Round 2: a clearance named without the word ("an active TS/SCI", "top secret"), export-control status, naturalization.
  { said: /\bts\/sci\b|\btop secret\b|\bpublic trust\b|\bpolygraph\b|\bclearances?\b/, what: "a security clearance" },
  { said: /\bu\.?s\.? (?:persons?|nationals?)\b|\bnaturali[sz](?:ed|ation)\b|\bdual (?:national|nationality|citizen)\b/, what: "citizenship" },
];
const AUTH_CASED = /\b(?:OPT|CPT|EAD)\b/; // upper case only: "opt in" is not a visa status
const NATIONALITIES = "american|canadian|british|australian|indian|german|french|mexican|chinese|irish|italian|spanish|brazilian|nigerian|filipino|japanese|korean|european|eu";
// "As an American, ...", "I am Canadian": a nationality said of the person (not "an American company").
const NATIONALITY = new RegExp(`\\b(?:i am|i'm|as) an? (${NATIONALITIES})\\b(?![ -][a-z])|\\b(?:i am|i'm) (${NATIONALITIES})\\b|\\b(${NATIONALITIES}) (?:citizen|national|passport)\\b`);
// Demographic and EEO self-identification: never written unless the person put it on their record. A veteran is handled
// on its own (veteranProblems): "a veteran engineer" is not a military claim.
const DEMOGRAPHIC = [
  /\bdisabilit(?:y|ies)\b/, /\bdisabled\b/, /\btransgender\b/, /\bnon-?binary\b/, /\bgay\b/, /\blesbian\b/, /\bbisexual\b/,
  /\bqueer\b/, /\blgbtq?i?a?\+?(?![a-z])/, /\bhispanic\b/, /\blatin[oax]s?\b/, /\bafrican[- ]american\b/, /\bnative american\b/,
  /\bpacific islander\b/, /\balaska native\b/, /\bpronouns?\b/, /\b(?:she|he|they)\/(?:her|him|them)\b/,
  /\bmy (?:gender|race|ethnicity|religion|sexual orientation|national origin)\b/,
  /\b(?:i am|i'm|as) an? (?:black|white|asian|indigenous|woman|man|female|male|mother|father|immigrant|muslim|christian|jewish|hindu|first[- ]generation)\b/,
  // Round 2: military service said without the word "veteran".
  /\bserved in the (?:u\.?s\.? )?(?:army|navy|marines?|marine corps|air force|coast guard|military|armed forces|national guard|space force|reserves?)\b/,
  /\b(?:active[- ]duty|military service|military spouse|reservist)\b/,
];
const MILITARY = "army|navy|marines?|marine corps|air force|coast guard|military|armed forces|national guard|space force|reserves?|war|combat|service";
// Leadership, by family: a fact that says the same family of word (a noun that only shares the stem, "the management
// team", "the leadership team", is no claim to have managed or led anyone). `role`: the match is a role noun, a claim only
// when said of the person (roleFraming). A verb said in the passive ("was led by", "managed by") or "managed to" (a feat,
// not a team) is no leadership claim.
const LEADERSHIP: { said: RegExp; on: RegExp; what: string; role?: boolean }[] = [
  // What the person did: "led", "leading a team". "Lead" as a wish ("I want to lead") and "led to" (a cause) claim nothing.
  { said: /\bled\b(?! to\b)|\bleading (?:a|the|my|our) (?:team|group|squad|project|crew)\b/, on: /\b(?:led|lead|leads|leading|leader|leaders)\b(?! to\b)/, what: "led" },
  // The role they held: "team lead", "lead analyst", "a leader".
  { said: /\b(?:leader|leaders)\b|\b(?:team|tech|project|engineering) lead\b|\blead (?:analyst|engineer|developer|designer|researcher|consultant|auditor)\b/, on: /\b(?:led|lead|leads|leading|leader|leaders)\b(?! to\b)/, what: "led", role: true },
  { said: /\b(?:as|was|am|i'm|became|served as|acted as|act as) (?:the |a |our |their )?lead\b(?! to\b)|\bthe lead (?:on|for)\b/, on: /\b(?:led|lead|leads|leading|leader|leaders)\b(?! to\b)/, what: "led" },
  { said: /\bmanaged\b(?! to\b)|\bmanaging (?:a|the|my|our) (?:team|group|staff|crew|people|analysts|engineers)\b|\b(?:as|was|am|became|served as) (?:a |an |the )?(?:[a-z]+ )?manager\b/, on: /\b(?:managed|manage|manages|managing|manager|managers)\b/, what: "managed" },
  { said: /\b(?:supervised|supervising)\b/, on: /\bsupervis\w*/, what: "supervised" },
  { said: /\b(?:oversaw|overseeing|overseen)\b/, on: /\b(?:oversaw|overs[e]e\w*)\b/, what: "oversaw" },
  { said: /\bdirected\b(?! (?:to|at|toward|towards)\b)/, on: /\b(?:directed|directing|director|directors)\b/, what: "directed" },
  { said: /\bheaded\b/, on: /\b(?:headed|head of)\b/, what: "headed" },
  { said: /\bhead of\b/, on: /\b(?:headed|head of)\b/, what: "headed", role: true },
  { said: /\b(?:mentored|mentoring)\b/, on: /\bmentor\w*/, what: "mentored" },
  { said: /\b(?:spearheaded|spearheading)\b/, on: /\bspearhead\w*/, what: "spearheaded" },
  { said: /\b(?:hired|recruited)\b/, on: /\b(?:hired|hiring|recruited|recruiting)\b/, what: "hired" },
  // Round 2: ownership and promotion.
  { said: /\bpoint person\b|\bin charge of\b|\btook charge\b|\bowner of\b|\bownership of\b/, on: /\b(?:owned|owner|ownership|point person|in charge)\b/, what: "owned" },
  { said: /\bpromoted\b|\bpromotions? to\b|\b(?:got|earned|received|won) (?:a |two |three )?promotions?\b/, on: /\bpromot/, what: "a promotion" },
];
const PASSIVE_BEFORE = /\b(?:was|were|been|being|be|is|are|get|got|getting|gets)\s+(?:[a-z]+ly\s+)?$/;
// Kinds of claim whose own words must be on the record (a certification, a language, an award, a publication).
const LANGS = "english|spanish|french|german|mandarin|chinese|cantonese|japanese|korean|portuguese|italian|dutch|arabic|hindi|russian|polish|turkish|vietnamese|tagalog|swedish|hebrew|greek|urdu|bengali|punjabi|tamil|telugu|farsi|persian|swahili|ukrainian|romanian|czech|thai|indonesian|malay|asl|sign language";
const WORDED: { said: RegExp; what: string; key?: (m: RegExpMatchArray) => string }[] = [
  { said: /\b(?:certified|certification|certifications|certificate|licensed|licen[cs]e|licen[cs]es|chartered|accredited)\b|\b(?:cpa|pmp|cfa|cissp|ccna|ccnp|cism|cisa|frm|caia|csm|psm|cscp|cpim|shrm-cp|shrm-scp|sphr|phr|comptia|six sigma|scrum master|black belt|green belt|series (?:6|7|63|65|66|79|82)|bar exam|passed the bar)\b/, what: "a certification or licence" },
  { said: /\b(?:bilingual|trilingual|multilingual|polyglot|native speaker)\b/, what: "a language" },
  { said: new RegExp(`\\b(?:fluent|fluency|native|proficient|proficiency|conversational|speak|speaks|spoke|speaking|read and write|business-level|working knowledge of)\\b[a-z ,]{0,30}?\\b(${LANGS})\\b|\\b(${LANGS})[- ](?:speaker|speaking|fluency|proficiency|fluent)\\b`), what: "a language",
    key: (m) => m[1] || m[2] },
  { said: /\b(?:won|win) (?:the|a|an|first|second|third|1st|2nd|3rd|top|best)\b|\b(?:awarded|award|awards|prize|prizes|scholarship|scholarships|fellowship|medal|medals|finalist|winner|honorable mention|hackathon)\b/, what: "an award" },
  { said: /\b(?:published|publications?|peer[- ]reviewed|patents?|patented|co-?authored|journal articles?)\b/, what: "a publication" },
];
// Spelled-out numbers and multipliers: their value (or the same word) must be on the record. "one" is a determiner.
const UNITS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG = /\b(?:hundreds?|thousands?|millions?|billions?|dozens?)\b/;
// "double-checked", "double down", "double as" are no multiplier (round 2).
const MULTIPLIER = /\b(?:half|halved|halving|twice|double(?![- ](?:check|checks|checked|checking|click|clicked|clicking|down|as|up)\b)[ds]?|doubling|triple[ds]?|tripling|quadruple[ds]?|tenfold|twofold|threefold|fivefold|[0-9]+x)\b|\bby (?:a|one|two) (?:third|quarter|fifth|tenth)s?\b|\btwo[- ]thirds\b|\bthree[- ]quarters\b/;
const ONES = "one|two|three|four|five|six|seven|eight|nine";
const SPELLED = new RegExp(`\\b(?:(${Object.keys(TENS).join("|")})(?:[- ](${ONES}))?|(${Object.keys(UNITS).join("|")}))\\b`, "g");
const ONE_TO_NINE: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
// A year spelled out: "twenty nineteen", "nineteen ninety-nine", "twenty oh five", "two thousand eighteen" (round 2).
const TEENS_AND_UNITS: Record<string, number> = { ...ONE_TO_NINE, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19 };
const TEENS = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const SPELLED_YEAR = new RegExp(`\\b(nineteen|twenty)[- ](?:(?:oh|o)[- ](${ONES})|(${TEENS})|(${Object.keys(TENS).join("|")})(?:[- ](${ONES}))?)\\b|\\btwo thousand(?:[- ]and)?(?:[- ](?:(${TEENS}|${ONES})|(twenty)(?:[- ](${ONES}))?))?\\b`, "g");
function spelledYears(s: string): { value: number; at: number; len: number }[] {
  const out: { value: number; at: number; len: number }[] = [];
  for (const m of s.matchAll(SPELLED_YEAR)) {
    let v: number;
    if (m[1]) v = (m[1] === "nineteen" ? 1900 : 2000) + (m[2] ? ONE_TO_NINE[m[2]] : m[3] ? TEENS_AND_UNITS[m[3]] : TENS[m[4]] + (m[5] ? ONE_TO_NINE[m[5]] : 0));
    else v = 2000 + (m[6] ? TEENS_AND_UNITS[m[6]] : m[7] ? 20 + (m[8] ? ONE_TO_NINE[m[8]] : 0) : 0);
    out.push({ value: v, at: m.index!, len: m[0].length });
  }
  return out;
}
const withoutSpelledYears = (s: string) => s.replace(SPELLED_YEAR, " ");
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
// Round 2: any name, in any case, said as where the person worked or studied ("i worked at initech", "interned at bluefin
// capital", "graduated from northfield state", "at my last job at hooli"): its words must be on the record.
const EMPLOY_FRAME = /\b(?:worked|interned|employed|hired|studied|graduated|enrolled|attended|consulted|freelanced|contracted|volunteered|apprenticed|taught|lectured|clerked|(?:took|completed|finished) (?:night |online |evening |summer )?(?:classes|courses|a course|a degree|a program))(?:\s+(?!(?:at|for|from|by|with|on|in|and|to|i|my|our|under|alongside|toward|towards|into|during|while|after|before|since)\b)[a-z'-]+){0,3}\s+(?:at|for|from|by)\s+|\b(?:my|the) (?:last|previous|prior|former|first|current|old|summer|recent) (?:job|role|position|employer|company|internship|team|school|university|college|placement|contract|gig)\s+(?:at|with|was|is|in)\s+|\bwhile (?:at|with)\s+|\b(?:during|in) my (?:time|years?|tenure|internship|studies|degree|stint|days) (?:at|with)\s+|\bi (?:was|am) (?:at|with)\s+|\bi joined\s+|\balumn(?:us|a|i|ae) of\s+/g;
const NAME_STOP = new Set(("a an the this that these those my our your his her their its i we you he she they it me us them and or but so then to in on at for " +
  "from with by as of during while since until before after because when where which who whom whose there here than also too had has have having been was " +
  "were is are be being did do does will would can could should may might not no yes each every some any all both either one two three four five six seven " +
  "eight nine ten few several many most more less over under about around nearly almost").split(" "));
const GENERIC_PLACE = new Set(("company companies startup start-up firm agency bank school university college hospital clinic store shop nonprofit non-profit " +
  "charity government organization organisation department team group office lab client clients customer customers home remote remotely free years year " +
  "months month weeks week days day hours hour while time living local small large big same other previous last first summer summers night weekend " +
  "weekends people users reps staff family families friends").split(" "));
const LINE_FRAME = /\b(?:at|for|with|from|by)\s+/g;
function employerProblems(t: string, recFlat: string, add: (s: string) => void, frame: RegExp = EMPLOY_FRAME) {
  for (const m of t.matchAll(frame)) {
    const rest = t.slice(m.index! + m[0].length);
    const toks: string[] = [];
    for (const w of rest.split(" ")) {
      const x = /^([a-z0-9][a-z0-9&'-]*?)((?:'s)?[.,;:!?)"]*)$/.exec(w);
      if (!x || toks.length >= 4) break;
      const tok = x[1];
      // A verb after the name ends it ("acme corp building dashboards"); the first word is always the name's ("sterling").
      if (NAME_STOP.has(tok) || /^\d/.test(tok) || (toks.length && tok.length > 4 && /(?:ing|ed)$/.test(tok) && !hasPhrase(recFlat, tok))) break;
      toks.push(tok);
      if (x[2]) break; // punctuation ends the name
    }
    const named = toks.filter((w) => !GENERIC_PLACE.has(w));
    if (!named.length || hasPhrase(recFlat, toks.join(" "))) continue;
    if (named.every((w) => hasPhrase(recFlat, w))) continue;
    add(`the name "${toks.join(" ")}" is not on your confirmed record (said as where you worked or studied)`);
  }
}

const FUNCTION_WORDS = new Set("at during while after before from with for in as when my our i since until throughout".split(" "));

export function numbersOf(s: string): Set<string> {
  const out = new Set<string>();
  const t0 = String(s ?? "").toLowerCase();
  for (const y of spelledYears(t0)) out.add(String(y.value));
  const t = withoutSpelledYears(t0);
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, ""));
  for (const m of t.matchAll(SPELLED)) out.add(String(m[3] ? UNITS[m[3]] : TENS[m[1]] + (m[2] ? ONE_TO_NINE[m[2]] : 0)));
  return out;
}
const spelledValue = (w: string) => {
  const m = new RegExp(`^(?:(${Object.keys(TENS).join("|")})(?:[- ](${ONES}))?|(${Object.keys(UNITS).join("|")})|(one))$`).exec(w);
  return m ? String(m[4] ? 1 : m[3] ? UNITS[m[3]] : TENS[m[1]] + (m[2] ? ONE_TO_NINE[m[2]] : 0)) : null;
};
const NUM_WORD = `\\d+(?:\\.\\d+)?|(?:${Object.keys(TENS).join("|")})(?:[- ](?:${ONES}))?|${Object.keys(UNITS).join("|")}|one`;
// A percent, in digits or words: "40%", "40 percent", "forty per cent".
export function percentsOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(s ?? "").toLowerCase().matchAll(new RegExp(`(${NUM_WORD})\\s*(?:%|percent\\b|per cent\\b|pct\\b)`, "g"))) {
    const v = /^\d/.test(m[1]) ? m[1] : spelledValue(m[1]);
    if (v) out.add(v);
  }
  return out;
}
// A span of time: "5 years", "3-5 years", "three to five years", "18 months".
const SPAN = new RegExp(`(?<![\\d.])(${NUM_WORD})(?:\\s*(?:-|–|to)\\s*(${NUM_WORD}))?\\s*(\\+)?\\s*(?:years?|yrs?|months?)\\b`, "g");
function spansOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(s ?? "").toLowerCase().matchAll(SPAN)) {
    const a = /^\d/.test(m[1]) ? m[1] : spelledValue(m[1]), b = m[2] ? (/^\d/.test(m[2]) ? m[2] : spelledValue(m[2])) : null;
    if (a) out.add(b ? `${a}-${b}` : a);
  }
  return out;
}
const VAGUE_SPAN = /\b(?:a few|several|many|multiple|numerous|countless|a couple of) (?:years|decades)\b|\b(?:over|more than|nearly|almost|about|around|close to|well over|under|less than)?\s?(?:a|one) decade\b|\bdecades\b/;

// A veteran: a military claim ("as a veteran,", "a veteran of the Army", "veteran status", "a disabled veteran") is how
// the person identifies; "a veteran engineer" or "a veteran of payments" says they are experienced, a claim of seniority,
// and only when said of the person ("my team's veteran engineers" is someone else).
function veteranProblems(t: string, rec: string, add: (s: string) => void) {
  for (const m of t.matchAll(/\bveterans?\b/g)) {
    const before = sentenceBefore(t, m.index!), after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
    const military = new RegExp(`\\b(?:${MILITARY}|disabled|protected|u\\.?s\\.?|us)\\s+$`).test(before) ||
      /^\s*(?:[,.;:!?)"]|$)/.test(after) || /^\s+(?:status|preference|benefits|affairs|owned|myself|and\b|who\b|i\b|with a disability)/.test(after) ||
      new RegExp(`^\\s+(?:of|in|from)\\s+(?:the\\s+)?(?:[a-z.]+\\s+){0,3}?(?:${MILITARY})\\b`).test(after);
    if (military) { if (!hasPhrase(rec, "veteran")) add(`"${m[0]}" (how you identify) is not on your confirmed record`); continue; }
    if (roleFraming(before) === "other") continue;
    if (!/\b(?:veteran|seasoned|senior|sr|principal|staff|decades?)\b/.test(rec)) add(`"${m[0]}" (a claim of seniority) is not on your confirmed record`);
  }
}

// Role words that name a person's title: said of someone else they are no claim (roleFraming).
const ROLE_WORDS = new Set(["engineer", "engineering manager", "manager", "director", "analyst", "scientist", "designer", "founder", "cofounder", "co founder",
  "intern", "vice president", "vp", "president", "ceo", "cto", "cfo", "coo", "chief", "principal", "staff", "senior", "junior", "consultant", "controller",
  "accountant", "architect", "recruiter", "researcher", "professor", "developer", "head of", "team lead", "tech lead", "associate", "partner", "specialist",
  "coordinator", "administrator", "officer", "fellow", "supervisor", "leader", "lead"]);
export const isRoleWord = (w: string) => ROLE_WORDS.has(String(w).toLowerCase());

export function claimProblems(text: string, o: ClaimInput): string[] {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  const company = String(o.company ?? "").trim();
  const scrub = company.length > 1 ? raw.replace(new RegExp(`(?<![A-Za-z0-9])${esc(company)}(?![A-Za-z0-9])`, "gi"), "the company") : raw;
  const t = lower(scrub), tRaw = lower(raw), f = flat(raw), fs = flat(scrub);
  const recordRaw = (o.record || []).filter(Boolean).join(" \n ");
  const rec = lower(recordRaw), recFlat = flat(recordRaw);
  const mentionRaw = (o.mentionable || []).filter(Boolean).join(" \n ");
  const mention = flat(mentionRaw);
  // Secrets: never written into anything, whatever the record holds.
  const secret = redactIdentity(raw).removed;
  if (secret.length) add(`it holds a ${secret[0] === "ssn" ? "Social Security number" : secret[0] === "card" ? "card number" : secret[0] === "account" ? "account number" : secret[0] === "code" ? "one-time code" : "password"}`);
  for (const d of DEGREE) if (d.said.test(t) && !d.on.test(rec)) add(`${d.what} is not on your confirmed record`);
  for (const a of AUTHORIZATION) {
    const m = a.said.exec(t);
    if (m && !hasPhrase(rec, m[0].trim())) add(`${a.what} ("${m[0].trim()}") is not on your confirmed record`);
  }
  { const m = AUTH_CASED.exec(scrub); if (m && !hasPhrase(rec, m[0].toLowerCase())) add(`a visa status ("${m[0]}") is not on your confirmed record`); }
  { const m = NATIONALITY.exec(t); if (m && !hasPhrase(rec, (m[1] || m[2] || m[3]))) add(`a nationality ("${m[0].trim()}") is not on your confirmed record`); }
  for (const re of DEMOGRAPHIC) {
    const m = re.exec(t);
    if (m && !hasPhrase(rec, m[0].trim())) add(`"${m[0].trim()}" (how you identify) is not on your confirmed record`);
  }
  veteranProblems(t, rec, add);
  for (const l of LEADERSHIP) {
    if (l.on.test(rec)) continue;
    for (const m of t.matchAll(all(l.said))) {
      const before = sentenceBefore(t, m.index!), after = t.slice(m.index! + m[0].length);
      if (l.role && roleFraming(before) === "other") continue;
      if (!l.role && /^(?:led|managed|supervised|mentored|directed|headed|overseen|oversaw|hired|recruited)$/.test(m[0]) &&
        (PASSIVE_BEFORE.test(before) || /^\s+by\b/.test(after))) continue;
      add(`"${m[0]}" (a leadership claim) is not on your confirmed record`);
      break;
    }
  }
  for (const w of WORDED) {
    for (const m of t.matchAll(all(w.said))) {
      const key = (w.key ? w.key(m) : m[0]).trim();
      // A word of the same family is the same claim: "certified" is on a record that says "PMP certification".
      const family = /^certif/.test(key) ? /\bcertif/ : /^licen[cs]/.test(key) ? /\blicen[cs]/ : /^(?:award|awarded)$/.test(key) ? /\bawards?\b|\bawarded\b/ : /^(?:published|publications?)$/.test(key) ? /\bpublish|\bpublication/ : null;
      if (family ? !family.test(rec) : !hasPhrase(rec, key)) { add(`${w.what} ("${m[0].trim()}") is not on your confirmed record`); break; }
    }
  }
  // Numbers: every number (in digits or spelled out, a spelled year as its year) on the record; "N+" only where the record
  // says "N+"; a percent only as a percent the record states; a span of time ("5 years", "3-5 years", "over a decade")
  // only as the record states it. A clause about the posting may repeat the posting's own numbers.
  const nums = numbersOf(recordRaw), mentionNums = numbersOf(mentionRaw);
  const recPct = percentsOf(recordRaw), mentionPct = percentsOf(mentionRaw);
  const recSpans = spansOf(recordRaw), mentionSpans = spansOf(mentionRaw);
  for (const clause of clausesOf(scrub)) {
    const ours = postingClause(clause);
    for (const n of numbersOf(clause)) if (!nums.has(n) && !(ours && mentionNums.has(n))) add(`the number "${n}" is not on your confirmed record`);
    for (const m of clause.matchAll(/(\d[\d,.]*)\s?\+/g)) {
      if (rec.includes(`${m[1]}+`) || rec.includes(`${m[1]} +`) || (ours && mentionRaw.includes(`${m[1]}+`))) continue;
      add(`"${m[0].trim()}" is more than your record says`);
    }
    for (const p of percentsOf(clause)) if (!recPct.has(p) && !(ours && mentionPct.has(p))) add(`"${p}%" is not a percent on your confirmed record`);
    // A tailored line's or form answer's single span ("3 years") is the guard's own rule (the person's stated years).
    for (const s of spansOf(clause)) if (!recSpans.has(s) && !(ours && mentionSpans.has(s)) && !(o.line && !s.includes("-"))) add(`"${s} years" (a span of time) is not on your confirmed record`);
    { const m = VAGUE_SPAN.exec(lower(clause)); if (m && !hasPhrase(rec, m[0].trim()) && !/\bdecades?\b/.test(rec) && !ours) add(`"${m[0].trim()}" (a span of time) is not on your confirmed record`); }
  }
  { const m = BIG.exec(withoutSpelledYears(t)); if (m && !hasPhrase(rec, m[0])) add(`"${m[0]}" is not on your confirmed record`); }
  { const m = MULTIPLIER.exec(t); if (m && !hasPhrase(rec, m[0])) add(`"${m[0]}" is not on your confirmed record`); }
  // Lower-case employers and schools; and any name the posting gave, used as where the person worked or studied.
  for (const m of f.matchAll(ORG_RE)) {
    const name = m[1];
    if (hasPhrase(recFlat, name)) continue;
    const before = f.slice(0, m.index);
    if (hasPhrase(mention, name) && !EMPLOYED_BEFORE.test(before)) continue;
    add(`the name "${name}" is not on your confirmed record`);
  }
  employerProblems(tRaw, recFlat, add);
  if (o.line) employerProblems(tRaw, recFlat, add, LINE_FRAME);
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
  // never because the question or the company says them. A role word is a claim only where it is said of the person.
  for (const v of o.vocab ?? []) {
    const p = String(v).toLowerCase();
    if (!p || !hasPhrase(fs, p) || hasPhrase(recFlat, p)) continue;
    if (isRoleWord(p) && !selfRole(scrub, p)) continue;
    if (!isRoleWord(p) && onlyInPostingTitle(scrub, p, mentionRaw)) continue;
    add(`"${v}" is not on your confirmed record`);
  }
  return out;
}

// A tool or brand said only inside the posting's own job title, as the role sought ("your Google Cloud Engineer", "the
// Salesforce Consultant role" at a reseller): the title names the job, not something the person used.
function onlyInPostingTitle(text: string, word: string, mentionRaw: string): boolean {
  if (!mentionRaw) return false;
  const t = String(text ?? "");
  const re = new RegExp(`(?<![A-Za-z0-9])${esc(word).replace(/ /g, "\\s+")}(?![A-Za-z0-9])`, "gi");
  let seen = false;
  for (const m of t.matchAll(re)) {
    seen = true;
    // The capitalized run around the word: "Google Cloud Engineer", "AWS Solutions Architect".
    const left = /((?:[A-Z][A-Za-z0-9&.+-]*\s+)*)$/.exec(t.slice(0, m.index!))?.[1] ?? "";
    const right = /^((?:\s+[A-Z][A-Za-z0-9&.+-]*)*)/.exec(t.slice(m.index! + m[0].length))?.[1] ?? "";
    const run = `${left}${m[0]}${right}`.replace(/\s+/g, " ").trim();
    const last = run.split(" ").pop()!.toLowerCase();
    if (!isRoleWord(last) || run.split(" ").length < 2) return false;
    if (!new RegExp(`(?<![A-Za-z0-9])${esc(run).replace(/ /g, "\\s+")}(?![A-Za-z0-9])`, "i").test(mentionRaw)) return false;
    const at = m.index! - left.length;
    if (roleFraming(sentenceBefore(lower(t.slice(0, at)), lower(t.slice(0, at)).length)) !== "other") return false;
  }
  return seen;
}
