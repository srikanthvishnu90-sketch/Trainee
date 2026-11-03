// LETTER TARGET SCENARIOS (architect, 2026-10-29; owner rule D-007, never invent a fact). A cover-letter or tailoring ask's
// target (the company, the role, the posting) is only what the person named. The onboarding battery found "write a cover
// letter … I live in Boston" set the letter's target to "the Boston Consulting Group role": a city expanded into a firm.
// This seeded generator builds ~10,000 asks (tests/architect/scenarios-letter-target.test.ts runs every one through the
// router's own extraction and a sample through the router's turn; tests/architect/flow-scenarios-letter-target.test.ts
// sends a sample through the real handler on real Postgres):
//   named      a real company named as the target, in many frames ("a cover letter for X", "the analyst role at X",
//              "X's internship", "the company is X", "apply to X", "X cover letter"), with a company file (BCG, Goldman,
//              McKinsey ...) and without one (Wells Fargo, Capital One, General Electric ...), as typed (case, "&"/"and")
//   prefix     words that open a firm's name standing as something else: cities (Boston, Phoenix, Dallas, Houston, Austin,
//              Jersey City, Washington ...), people (Morgan, Jane, Dr. Goldman), plain words (the capital, in general,
//              American, united, delta hedging, the oracle, my target role, the Amazon river, apple pie, ramp up, a notion,
//              stripes, a snowflake), schools (Boston University, University of Phoenix, Columbia ...), skills (Oracle SQL,
//              Snowflake, Figma, Microsoft Excel, Google Sheets, Palantir Foundry ...), employers they have or had
//   mixed      a named target beside a city, a school, a skill or a former employer ("for Stripe. I live in Boston")
//   negation   "X, not Y", "not Y. ... for X", "but not for Y", "X instead of Y", "anything but Y"
//   multiple   two companies named: the first is the target
//   longer     a longer name that only opens with a firm's name ("Bain Capital" is not Bain & Company)
//   typos      a misspelled ask; a misspelled firm is read as typed, never as another firm
//   onfile     postings on file at firms whose names open with a city ("Boston Dynamics"): named whole or not at all
// Every case says the target it expects (the company's name as the product states it, or null). No network, no model.
import { rng, type R } from "../scenarios-fixture.ts";
export { rng };

// A company with a file on record (packages/career-data/cirs): the name the product states and the forms a person types.
export const FILED: { name: string; typed: string[] }[] = [
  { name: "Boston Consulting Group", typed: ["Boston Consulting Group", "BCG", "the Boston Consulting Group", "bcg"] },
  { name: "Goldman Sachs", typed: ["Goldman Sachs", "Goldman", "goldman sachs"] },
  { name: "Morgan Stanley", typed: ["Morgan Stanley", "morgan stanley"] },
  { name: "JPMorganChase", typed: ["JPMorgan", "JP Morgan", "J.P. Morgan", "JPMorgan Chase"] },
  { name: "McKinsey & Company", typed: ["McKinsey", "McKinsey & Company", "mckinsey", "McKinsey and Company"] },
  { name: "Bain & Company", typed: ["Bain", "Bain & Company", "Bain and Company"] },
  { name: "Deloitte Consulting", typed: ["Deloitte Consulting"] },
  { name: "Citadel Securities", typed: ["Citadel Securities"] },
  { name: "Jane Street", typed: ["Jane Street", "jane street"] },
  { name: "Hudson River Trading", typed: ["Hudson River Trading", "HRT"] },
  { name: "Two Sigma", typed: ["Two Sigma"] },
  { name: "D. E. Shaw & Co.", typed: ["D. E. Shaw", "DE Shaw", "D.E. Shaw"] },
  { name: "Palantir Technologies", typed: ["Palantir", "Palantir Technologies"] },
  { name: "Anduril Industries", typed: ["Anduril", "Anduril Industries"] },
  { name: "Stripe", typed: ["Stripe"] },
  { name: "Ramp", typed: ["Ramp"] },
  { name: "Plaid", typed: ["Plaid"] },
  { name: "Notion", typed: ["Notion"] },
  { name: "Amazon", typed: ["Amazon"] },
  { name: "Google", typed: ["Google"] },
  { name: "Microsoft", typed: ["Microsoft"] },
  { name: "Coinbase", typed: ["Coinbase", "coinbase"] },
  { name: "Datadog", typed: ["Datadog"] },
  { name: "Duolingo", typed: ["Duolingo"] },
  { name: "Airbnb", typed: ["Airbnb", "airbnb"] },
  { name: "Snowflake", typed: ["Snowflake"] },
  { name: "Figma", typed: ["Figma"] },
  { name: "KKR", typed: ["KKR"] },
  { name: "Blackstone", typed: ["Blackstone"] },
  { name: "Evercore", typed: ["Evercore"] },
  { name: "Lazard", typed: ["Lazard"] },
  { name: "Point72", typed: ["Point72"] },
  { name: "Millennium", typed: ["Millennium"] },
];
// Words that are a firm's name and a plain word or a person's name: a person writing the firm writes it mid-sentence.
export const COMMON = new Set(["Stripe", "Ramp", "Plaid", "Notion", "Amazon", "Google", "Snowflake", "Figma", "Millennium", "Bain", "Goldman", "Deloitte", "Citadel"]);
// Real companies with no file on record: the product states them as typed.
export const UNFILED = ["Wells Fargo", "Capital One", "General Electric", "General Motors", "American Express", "United Airlines", "Delta Air Lines",
  "Bank of America", "Boston Dynamics", "Phoenix Contact", "Dallas Mavericks", "Houston Methodist", "Austin Energy", "Jersey Central Power & Light",
  "Washington Post", "Deloitte", "Citadel", "Salesforce", "Adobe", "Nvidia", "Accenture", "Pfizer", "Moderna", "Boeing", "Lockheed Martin", "Tesla",
  "SpaceX", "Netflix", "Spotify", "Shopify", "Databricks", "Robinhood", "Affirm", "HubSpot", "Intuit", "Bain Capital", "Morgan Lewis",
  "Goldman Sachs Asset Management", "Procter & Gamble", "Johnson & Johnson", "Texas Instruments", "Charles Schwab", "Fidelity Investments",
  "Liberty Mutual", "State Street", "Raytheon"];
export const ROLES = ["data analyst", "software engineering", "investment banking analyst", "product management", "consulting", "marketing", "summer analyst", "operations"];
// Cities and places, many of them the opening word of a firm's name (Hudson, Wells and Delta are towns too).
export const CITIES = ["Boston", "Phoenix", "Dallas", "Houston", "Austin", "Jersey City", "New Jersey", "Washington", "Washington DC", "Denver", "Charlotte",
  "Chicago", "New York", "San Francisco", "Seattle", "Atlanta", "Columbus", "Richmond", "Cambridge", "Hudson", "Wells", "Delta"];
export const SCHOOLS = ["Boston University", "Boston College", "University of Phoenix", "Washington University", "University of Washington", "Columbia",
  "Duke", "Rice", "Brown", "NYU", "Georgetown", "Northeastern", "Texas A&M University", "Arizona State University", "Houston Community College",
  "Goldman School of Public Policy", "Morgan State University", "Wells College", "Delta State University", "American University", "Capital University",
  "the University of Texas at Austin"];
// Skills and tools that carry a firm's name.
export const SKILLS = ["Oracle SQL", "Oracle", "Snowflake", "Figma", "Microsoft Excel", "Excel", "Google Sheets", "Google Analytics", "Palantir Foundry",
  "Datadog dashboards", "Notion", "Salesforce", "Tableau", "Python", "SQL", "Amazon Web Services", "Stripe APIs", "Plaid APIs"];
// Plain words that contain a firm's name and name no firm.
export const PLAIN = [
  "my professor, Dr. Goldman, said I should write one", "my friend Morgan reviewed it", "my sister Jane helped me", "in general I am flexible",
  "I'm American and don't need sponsorship", "I live in the capital", "I have experience in delta hedging", "my target role is analyst",
  "I want it to target roles in finance", "I wrote an essay about the Amazon river", "I bake apple pie on weekends", "I need to ramp up fast",
  "I have a notion of what I want", "I earned my stripes in retail", "I'm a unique snowflake lol", "it's for the millennium fellowship",
  "I love plaid shirts", "the oracle at Delphi is my favorite myth", "united we stand", "two years of experience", "point being, I need it today",
  "I'm a Wells Fargo customer, not an employee", "my dad uses Microsoft Word", "I google everything", "I work in the Hudson Valley",
];
// Employers they have or had: named, but not the letter's target.
export const PAST = ["I used to work at {C}", "I worked at {C} last year", "I interned at {C} last summer", "I currently work at {C}", "I was employed at {C}",
  "I left {C} in May", "previously I was at {C}"];

const LEADS = ["", "", "", "hey ", "hi! ", "ok so ", "quick one: ", "Can you ", "can u ", "pls ", "please ", "Hey Trainee, ", "so basically ", "yo ", "um "];
const ASKS = ["write a cover letter", "write me a cover letter", "draft a cover letter", "help me with a cover letter", "make me a cover letter",
  "I need a cover letter", "tailor my resume", "help me tailor my resume", "write my cover letter"];
const ASK_TYPO = ["write a covr letter", "rite a cover leter", "drafft a cover letter", "tailr my resume", "write a cover lettr", "write a cover-letter"];
// Frames that name {C} as the target (any company); {r} is a role. Frames that open with {C} are kept for names that are no
// plain word.
const NAMED_FRAMES = [
  "{a} for {C}", "{a} for the {r} role at {C}", "{a} for {C}'s {r} internship", "{a}. the company is {C}", "{a}, I'm applying to {C}",
  "{a} for an {r} position at {C}", "{a} for my application to {C}", "{a} for the {r} job at {C}", "{C} {r} internship: {a}", "{a} for {C} please",
  "{a} for {C}.", "{a} for {C}!", "{a} for the internship at {C}", "I want to work at {C}, {a}", "{a}, the firm is {C}",
];
// Frames for a company with a file (its name is known, so a short frame is enough).
const FILED_ONLY_FRAMES = ["{a} to {C}", "{C} cover letter please", "{a} targeting {C}", "{a} for {C} {r}"];
const NO_TARGET_ASKS = ["{a}", "{a} for a {r} role", "{a} for my target role", "{a}, I don't have a company yet", "{a} for any {r} job"];

export type LetterCase = { input: string; expect: string | null; family: string; postings?: string[] };
const fill = (r: R, tpl: string, a: string, c: string) => tpl.replaceAll("{a}", a).replaceAll("{C}", c).replaceAll("{r}", r.pick(ROLES));
const ask = (r: R) => r.pick(LEADS) + r.pick(ASKS);
const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const finish = (v: string) => cap(v.replace(/\s+/g, " ").trim());
const filed = (r: R) => { const f = r.pick(FILED); return { name: f.name, typed: r.pick(f.typed) }; };
const plainWordFirm = (c: string) => COMMON.has(c) || /^[a-z]/.test(c);

function named(r: R): LetterCase {
  if (r.next() < 0.6) {
    const f = filed(r);
    const tpls = [...NAMED_FRAMES, ...FILED_ONLY_FRAMES].filter((t) => !plainWordFirm(f.typed) || !/^\{C\}/.test(t));
    return { input: finish(fill(r, r.pick(tpls), ask(r), f.typed)), expect: f.name, family: `named:filed` };
  }
  const c = r.pick(UNFILED);
  const tpl = r.pick(NAMED_FRAMES.filter((t) => !/^\{C\}/.test(t)));
  return { input: finish(fill(r, tpl, ask(r), c)), expect: c, family: "named:unfiled" };
}
function prefix(r: R): LetterCase {
  const k = r.int(0, 4);
  const a = ask(r);
  const join = (said: string) => finish(r.next() < 0.5 ? `${a}, ${said}` : `${said}. ${a}`);
  if (k === 0) {
    const city = r.pick(CITIES);
    return { input: join(r.pick([`I live in ${city}`, `I'm based in ${city}`, `I'm moving to ${city}`, `I'm from ${city}`, `I'd like to stay near ${city}`, `I'm relocating to ${city} in June`, `I grew up in ${city}`])), expect: null, family: "prefix:city" };
  }
  if (k === 1) {
    const school = r.pick(SCHOOLS);
    return { input: join(r.pick([`I studied at ${school}`, `I graduated from ${school}`, `I'm a senior at ${school}`, `I go to ${school}`, `I'm a student at ${school}`, `I attended ${school}`])), expect: null, family: "prefix:school" };
  }
  if (k === 2) {
    const s0 = r.pick(SKILLS), s1 = r.pick(SKILLS);
    return { input: join(r.pick([`I know ${s0} and ${s1}`, `I'm proficient in ${s0}`, `I have experience with ${s0}, ${s1} and Python`, `skills: ${s0}, ${s1}`, `I'm skilled in ${s0}`, `I use ${s0} daily`])), expect: null, family: "prefix:skill" };
  }
  if (k === 3) return { input: join(r.pick(PLAIN)), expect: null, family: "prefix:plain" };
  const c = r.next() < 0.5 ? filed(r).typed : r.pick(UNFILED);
  return { input: join(r.pick(PAST).replace("{C}", c)), expect: null, family: "prefix:past" };
}
function mixed(r: R): LetterCase {
  const t = named(r);
  const k = r.int(0, 3);
  const other = k === 0 ? r.pick([`I live in ${r.pick(CITIES)}`, `I'm based in ${r.pick(CITIES)}`])
    : k === 1 ? r.pick([`I studied at ${r.pick(SCHOOLS)}`, `I'm a junior at ${r.pick(SCHOOLS)}`])
      : k === 2 ? `I know ${r.pick(SKILLS)} and ${r.pick(SKILLS)}`
        : r.pick(PAST).replace("{C}", r.pick(UNFILED.filter((u) => u !== t.expect)));
  const body = t.input.replace(/[.!]$/, "");
  return { input: r.next() < 0.5 ? `${body}. ${cap(other)}` : `${cap(other)}. ${body}`, expect: t.expect, family: `mixed:${t.family.split(":")[1]}` };
}
function negation(r: R): LetterCase {
  const a = filed(r), b = filed(r);
  if (a.name === b.name) return { input: finish(`${ask(r)} for anything but ${a.typed}`), expect: null, family: "negation:only" };
  const k = r.int(0, 3);
  if (k === 0) return { input: finish(`${ask(r)} for ${a.typed}, not ${b.typed}`), expect: a.name, family: "negation:x-not-y" };
  if (k === 1) return { input: finish(`not ${b.typed}. ${ask(r)} for ${a.typed}`), expect: a.name, family: "negation:not-y-x" };
  if (k === 2) return { input: finish(`${ask(r)}, but not for ${b.typed}`), expect: null, family: "negation:only" };
  return { input: finish(`${ask(r)} for ${a.typed} instead of ${b.typed}`), expect: a.name, family: "negation:instead" };
}
function multiple(r: R): LetterCase {
  const a = filed(r);
  const b = r.next() < 0.5 ? filed(r).typed : r.pick(UNFILED);
  return { input: finish(`${ask(r)} for ${a.typed} and ${b}`), expect: a.name, family: "multiple:first" };
}
function longer(r: R): LetterCase {
  const typed = r.pick(["Bain Capital", "Goldman Sachs Asset Management", "Morgan Lewis", "Boston Dynamics", "Jane Street Capital", "Citadel LLC", "Boston Scientific", "Phoenix Contact", "Stripe Partners", "Palantir Foundry Labs"]);
  return { input: finish(`${ask(r)} for ${typed}`), expect: typed, family: "longer" };
}
function typos(r: R): LetterCase {
  const k = r.int(0, 2);
  if (k === 0) { const f = filed(r); return { input: finish(`${r.pick(ASK_TYPO)} for ${f.typed}`), expect: f.name, family: "typo:ask" }; }
  if (k === 1) { const bad = r.pick(["Goldmen Sachs", "Mckinsy", "Bostn Consulting", "Gogle", "Palantr", "Stirpe"]); return { input: finish(`${ask(r)} for ${bad}`), expect: bad, family: "typo:firm" }; }
  return { input: finish(`${r.pick(ASK_TYPO)}, I live in ${r.pick(CITIES)}`), expect: null, family: "typo:city" };
}
function noTarget(r: R): LetterCase {
  return { input: finish(fill(r, r.pick(NO_TARGET_ASKS), ask(r), "")), expect: null, family: "none" };
}
// Postings on file at firms whose names open with a city or a plain word: a name on file is the target only when named whole.
export const ONFILE = ["Boston Dynamics", "Delta Metrics", "Phoenix Labs", "Austin Bikes", "Target Analytics"];
function onFile(r: R): LetterCase {
  if (r.next() < 0.5) return { input: finish(`${ask(r)}, I live in ${r.pick(["Boston", "Phoenix", "Austin", "Delta"])}`), expect: null, family: "onfile:city", postings: ONFILE };
  const p = r.pick(ONFILE);
  return { input: finish(`${ask(r)} for the ${r.pick(ROLES)} role at ${p}`), expect: p, family: "onfile:named", postings: ONFILE };
}

export function letterCases(r: R, n: number): LetterCase[] {
  const gens: [number, (r: R) => LetterCase][] = [[0.28, named], [0.28, prefix], [0.14, mixed], [0.07, negation], [0.05, multiple], [0.04, longer], [0.06, typos], [0.04, noTarget], [0.04, onFile]];
  const out: LetterCase[] = [];
  for (let i = 0; i < n; i++) {
    let x = r.next(), g = gens[gens.length - 1][1];
    for (const [w, f] of gens) { if (x < w) { g = f; break; } x -= w; }
    out.push(g(r));
  }
  return out;
}

// What the person named, independent of the product: a company is named when one of the forms a person types for it stands
// in the text as whole words (any case; "&" and "and" alike). A firm's own short form (Goldman, BCG) counts; a word that only
// opens its name (Boston, Morgan, Jane) never does.
export const FORMS: Record<string, string[]> = Object.fromEntries(FILED.map((f) => [f.name, [f.name, ...f.typed]]));
const plainOf = (v: string) => ` ${v.toLowerCase().replace(/’/g, "'").replace(/&/g, " and ").replace(/'s\b/g, "").replace(/\.(?=\s|$)/g, "").replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim()} `;
export function namedIn(input: string, company: string): boolean {
  const hay = plainOf(input);
  return (FORMS[company] ?? [company]).some((f) => hay.includes(plainOf(f.replace(/^the /i, ""))));
}

// A posting on file at a company, in the router's corpus shape.
export const postingOf = (c: string, i: number) => ({ id: `lt-${i}`, job_id: `lt-${i}`, company: c, title: "Data Analyst", location: "Chicago, IL", jd_text: "Data Analyst. Requirements: SQL, dashboards.", url: `https://boards.greenhouse.io/lt${i}/jobs/${i}` });

// ------------------------------------------------------------------------------------------------ the reply's targets
// The targets a reply sets or states, as the product words them.
const TARGET_LINES: RegExp[] = [
  /target is set — (.+?)\.(?:\s+(?:It|One)\b|[ \t]*\n|\s*$)/g,
  /I need the (.+?) posting to tailor against/g,
  /no (.+?) role is in the current list/g,
];
const FILLER = new Set(["the", "role", "at", "a", "an"]);
const wordsOf = (v: string) => v.toLowerCase().replace(/’/g, "'").replace(/&/g, " and ").replace(/'s\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);
// null when every target the reply states is a posting they referenced or made only of what they said; else why not. A
// company with a file on record is never named in the reply unless the ask named it.
export function replyViolation(input: string, reply: string, posting?: { company?: string | null; title?: string | null } | null): string | null {
  const said = new Set(wordsOf(input));
  for (const re of TARGET_LINES) {
    for (const m of reply.matchAll(re)) {
      let label = m[1];
      if (posting && (posting.company && label.includes(posting.company) || posting.title && label.includes(posting.title))) continue;
      // A company with a file the ask named (in any of the forms a person types for it) is theirs.
      for (const f of FILED) if (label.includes(f.name) && namedIn(input, f.name)) label = label.replace(f.name, " ");
      const extra = wordsOf(label).filter((w) => !FILLER.has(w) && !said.has(w));
      if (extra.length) return `the reply states a target the ask never named ("${m[0]}": ${extra.join(", ")})`;
    }
  }
  for (const f of FILED) if (reply.includes(f.name) && !namedIn(input, f.name)) return `the reply names ${f.name}, which the ask never named`;
  return null;
}
