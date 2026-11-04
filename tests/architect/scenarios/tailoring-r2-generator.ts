// TAILORING SCENARIOS, ROUND 2 (architect, 2026-10-30; owner rule D-007, never invent a fact). Round 1
// (tailoring-generator.ts, scenarios-tailoring.test.ts) planted claims the checks never saw. Round 2 builds fresh people
// (some with a senior title, a certification, a second language, a "Led ..." bullet or a promotion on their confirmed
// record, so a claim and the same words on the record can be told apart) and four new families
// (tests/architect/scenarios-tailoring-r2.test.ts runs every case through the product's own code with a deterministic,
// adversarial fake model; flow-scenarios-tailoring-r2.test.ts sends a sample through the real handler on real Postgres):
//   honest    drafts built ONLY from the person's confirmed facts, with the honest words the checks used to refuse: "my
//             manager said", "a manager who gives feedback", "reported to the head of operations", "double-checked",
//             "managed to", "led to", "was led by", "learn from veteran analysts", a number or year the posting states said
//             as the posting's ("this role asks for 6+ years", "founded in 2004"), a title that names another company
//             ("your Google Cloud Engineer"), a year or percent spelled out that IS on the record, and claims the record
//             really holds (a certification, a language, "led a team of four", a promotion, "a veteran analyst" for a
//             senior one). The false-positive rate is measured on this corpus and must be 0.
//   planted   claims that are on no confirmed fact: an employer or school typed in lower case that is no famous name
//             ("i worked at hooli", "graduated from harmon polytechnic"), a year spelled out, a range ("3-5 years",
//             "three to five years"), a percent in words that only matches a count on the record ("forty percent" against
//             "40 sales reps"), "over a decade", "a few years", "as the lead on", "point person", certifications and
//             licences (AWS certified, CPA, PMP), clearances (TS/SCI, top secret), languages ("fluent in tagalog",
//             "bilingual"), work rights and nationality said sideways ("as a green card holder", "as a U.S. person",
//             "as an American"), military service, awards, publications, a promotion, a fraction ("by a third"), honours
//             ("top of my class"); in essays (draftEssay, checkDraft), tailored lines (guardMaterials) and bullet
//             rewrites (rewriteResume)
//   forms     application questions planned for a posting (career_apply.ts planBatch, the prepare path): salary (and in
//             another currency), notice period, start date, relocation, how they heard, "years with X", total years,
//             multi-select skills, written answers ("why us", "describe a challenge") and knock-outs (clearance,
//             licence, age, a felony, work rights abroad, a degree, "5+ years", a CPA). An answer only from the person's
//             confirmed fact or saved answer, word for word or as the form's own option; otherwise "needs you" and the
//             posting is not prepared.
//   asked     the same questions in the ask-once list (career_apply_questions.ts): "draft N" on a question that is not a
//             written answer never calls the model; a written answer's draft holds no planted claim; a typed answer is
//             saved as typed (a secret never).
//   render    a tailored resume rendered for real (148's PDF): every line printed is one of the person's confirmed lines
//             (reordered, never reworded, no new metric); the stored file's bytes hash to the sha256 the approval pins;
//             the same facts give the same file; an edited fact gives a new file, and an approval pinned to the old one
//             is never sent with the new one (RESUME_CHANGED, the engine never starts).
// No network, no model, no wall clock.
import { type R, rng } from "../scenarios-fixture.ts";
import { type Exp, leaks, type Person, person as basePerson, type Poison, profileOf } from "./tailoring-generator.ts";
export { leaks, profileOf, rng };
export type { Person, Poison };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![A-Za-z0-9])${esc(s)}(?![A-Za-z0-9])`, "i");
const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);

// ------------------------------------------------------------------------------------------------ spelling numbers
const U = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen"];
const T = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function spell(n: number): string {
  if (n < 20) return U[n];
  return T[Math.floor(n / 10)] + (n % 10 ? `-${U[n % 10]}` : "");
}
export function spellYear(y: number, r?: R): string {
  const hi = Math.floor(y / 100), lo = y % 100;
  if (y >= 2000 && y < 2010) return lo ? (r && r.next() < 0.5 ? `twenty oh ${U[lo]}` : `two thousand ${U[lo]}`) : "two thousand";
  const head = hi === 19 ? "nineteen" : "twenty";
  return `${head} ${spell(lo)}`;
}

// ------------------------------------------------------------------------------------------------ people
export interface PersonR2 extends Person { senior: boolean; cert: string | null; lang: string | null; led: number | null; promoted: boolean }
export const CERTS: Record<string, { fact: string; say: string[]; marks: RegExp[] }> = {
  aws: { fact: "AWS Certified Cloud Practitioner", say: ["I am AWS certified.", "i am aws certified."], marks: [/\baws certified\b/i] },
  pmp: { fact: "PMP certification from PMI", say: ["I hold the PMP certification.", "i am pmp certified."], marks: [/\bpmp (?:certified|certification)\b/i] },
  cpa: { fact: "CPA license from the State of Illinois", say: ["I hold a CPA license.", "i passed the cpa exam and hold the license."], marks: [/\bcpa (?:license|exam)\b/i] },
};
export const LANGS = ["Spanish", "Tagalog", "Hindi", "Portuguese", "Korean", "Polish"];
const ROLE_WORD: Record<string, string> = { "Data Analyst": "analysts", "Operations Analyst": "analysts", "Reporting Analyst": "analysts",
  "Research Assistant": "researchers", "Billing Specialist": "specialists", "QA Tester": "testers", "Software Developer": "developers" };
const BASE_VERB: Record<string, string> = { Built: "build", Cut: "cut", Automated: "automate", Cleaned: "clean", Wrote: "write" };

export function personR2(r: R, n: number): PersonR2 {
  const p = basePerson(r, n) as PersonR2;
  const conf = { status: "confirmed", needs_confirmation: false, source: "user", provenance: "owner confirmed in chat the resume entry shown to them (2026-10-30T00:00:00.000Z)", confirmation_event_id: "00000000-0000-4000-8000-0000000000ab" };
  const firstHidden = p.facts.findIndex((f) => f.status === "draft" || f.quarantined);
  const extra: any[] = [];
  let seq = 100;
  const id = () => `F-${++seq}`;
  p.senior = r.next() < 0.3;
  if (p.senior) {
    const e = p.exps[0];
    e.role = `Senior ${e.role}`;
    const f = p.facts.find((x) => x.id === e.id);
    f.role = e.role; f.title = `${e.role}, ${e.org}, ${e.start}-${e.end}`;
  }
  p.led = null;
  if (r.next() < 0.3) {
    const k = r.int(3, 9);
    p.led = k;
    const e = p.exps[0];
    e.bullets.push(`Led a team of ${k} analysts`);
    p.facts.find((x) => x.id === e.id).bullets = e.bullets;
  }
  p.promoted = false;
  if (r.next() < 0.25) {
    p.promoted = true;
    const e = p.exps[p.exps.length - 1];
    e.bullets.push(`Promoted to ${e.role} after the first year`);
    p.facts.find((x) => x.id === e.id).bullets = e.bullets;
  }
  p.cert = null;
  if (r.next() < 0.3) {
    p.cert = r.pick(Object.keys(CERTS));
    const c = CERTS[p.cert];
    extra.push({ id: id(), kind: "certification", title: c.fact, name: c.fact, text: c.fact, bullets: [], skills: [], evidence: [], ...conf });
  }
  p.lang = null;
  if (r.next() < 0.3) {
    p.lang = r.pick(LANGS);
    extra.push({ id: id(), kind: "other", title: `${p.lang} (native speaker)`, text: `Speaks ${p.lang} fluently as a native speaker`, bullets: [], skills: [], evidence: [], ...conf });
  }
  p.facts.splice(firstHidden < 0 ? p.facts.length : firstHidden, 0, ...extra);
  const confirmed = p.facts.filter((f) => f.status === "confirmed" && !f.quarantined);
  p.record = confirmed.map((f) => [f.title, f.text, ...(f.bullets || []), f.org, f.role, f.school, f.degree, f.start, f.end, ...(f.skills || [])].filter(Boolean).join(" ")).join(" \n ");
  p.numbers = new Set(p.record.match(/\d+/g) || []);
  return p;
}

// ------------------------------------------------------------------------------------------------ honest words
// Sentences built only from the person's confirmed facts (round 1's cleanSentences, as a model would write them).
export function baseSentences(r: R, p: Person, company: string | null): string[] {
  const e = r.pick(p.exps);
  const out = [`At ${e.org}, I ${lowerFirst(e.bullets[0])}.`];
  if (e.bullets[1]) out.push(`As a ${e.role}, I also ${lowerFirst(e.bullets[1])}.`);
  else if (p.exps.length > 1) { const e2 = p.exps.find((x) => x !== e)!; out.push(`At ${e2.org}, I ${lowerFirst(e2.bullets[0])}.`); }
  if (p.edu && r.next() < 0.5) out.push(`I studied ${p.edu.field} at ${p.edu.school}.`);
  if (company && r.next() < 0.5) out.push(`That is the work I want to keep doing at ${company}.`);
  return out;
}
export const POSTING_BRANDS = ["Google Cloud", "Salesforce", "AWS", "Microsoft Azure", "Snowflake", "Workday"];
export const POSTING_TITLES = ["Engineer", "Consultant", "Architect", "Specialist", "Analyst"];
export const RESELLERS = ["Cloudmark Partners", "Brightpath Consulting", "Nimbus Integrators", "Copperline Systems"];
export interface Honest { kind: string; say: string; label?: string; company?: string }
// The honest words, each true of this person (or about someone else, or the posting): null when it does not apply.
export function honestWords(r: R, p: PersonR2, company: string, kind: string): Honest | null {
  const e = r.pick(p.exps);
  const b = r.pick(e.bullets.filter((x) => !/^(?:Led|Promoted)\b/.test(x)));
  const verb = /^(\w+)/.exec(b)![1];
  switch (kind) {
    case "manager-said": return { kind, say: `I ${lowerFirst(b)}, and my manager at ${e.org} said it helped.` };
    case "manager-welcome": return { kind, say: r.pick(["I would welcome a manager who gives direct feedback.", "I work best with a manager who is clear about priorities."]) };
    case "manager-with": return { kind, say: r.pick(["I worked closely with my manager on that work.", "My manager and I reviewed that work every week."]) };
    case "director": return { kind, say: `My director at ${e.org} signed off on that work.` };
    case "head-of": return { kind, say: `At ${e.org}, I reported to the head of ${r.pick(["operations", "finance", "sales operations", "data"])}.` };
    case "supervisor": return { kind, say: `My supervisor at ${e.org} reviewed that work each week.` };
    case "double-check": return { kind, say: r.pick(["I double-check every number before anyone relies on it.", "I double-checked the figures each time before they went out.", "I like to double down on the work I know well."]) };
    case "managed-to": {
      const base = BASE_VERB[verb];
      if (!base) return null;
      return { kind, say: `At ${e.org}, I managed to ${base} ${b.slice(verb.length + 1)}.` };
    }
    case "led-to": {
      const e2 = p.exps.find((x) => x !== e);
      return e2 ? { kind, say: `That work at ${e.org} led to my next role at ${e2.org}.` } : { kind, say: `That work led to fewer questions from the people who used it.` };
    }
    case "led-by": return { kind, say: `The team I joined at ${e.org} was led by a director who cared about clean data.` };
    case "learn-from": return { kind, say: r.pick([`I want to learn from veteran ${ROLE_WORD[p.exps[0].role.replace(/^Senior /, "")] ?? "analysts"} at ${company}.`,
      `I want to learn from the leaders at ${company}.`, "I hope to grow into a manager role someday."]) };
    case "posting-years": {
      const sk = r.pick(e.skills);
      let n = r.int(4, 9);
      for (let k = 0; k < 20 && p.numbers.has(String(n)); k++) n = r.int(4, 9);
      if (p.numbers.has(String(n))) return null;
      return { kind, say: r.pick([`This role asks for ${n}+ years of ${sk}, and I want to grow toward that.`, `The posting lists ${n}+ years of ${sk}; I want to grow toward that bar.`]),
        label: `This role asks for ${n}+ years of ${sk}. Why are you interested in it?` };
    }
    case "posting-founded": {
      let y = r.int(1990, 2012);
      for (let k = 0; k < 20 && p.numbers.has(String(y)); k++) y = r.int(1990, 2012);
      if (p.numbers.has(String(y))) return null;
      return { kind, say: r.pick([`${company} was founded in ${y} and has grown since.`, `${company}, founded in ${y}, still builds its own tools.`]),
        label: `${company} was founded in ${y}. Why do you want to join us?` };
    }
    case "title-company": {
      const brand = r.pick(POSTING_BRANDS), title = r.pick(POSTING_TITLES), reseller = r.pick(RESELLERS);
      return { kind, say: `I want to be your ${brand} ${title} because I ${lowerFirst(b)}.`, label: `Why do you want to be our ${brand} ${title}?`, company: reseller };
    }
    case "veteran-self": return p.senior ? { kind, say: `As a veteran ${p.exps[0].role.replace(/^Senior /, "").toLowerCase()}, I ${lowerFirst(p.exps[0].bullets[0])}.` } : null;
    case "spelled-year": return { kind, say: `I started at ${e.org} in ${spellYear(e.start, r)}.` };
    case "percent-words": {
      const pb = p.exps.flatMap((x) => x.bullets.map((y) => ({ x, y }))).find((z) => /by (\d+)%/.test(z.y));
      if (!pb) return null;
      const v = Number(/by (\d+)%/.exec(pb.y)![1]);
      return { kind, say: `At ${pb.x.org}, I cut weekly reporting time by ${spell(v)} ${r.pick(["percent", "per cent"])}.` };
    }
    case "cert": return p.cert ? { kind, say: r.pick(CERTS[p.cert].say) } : null;
    case "lang": return p.lang ? { kind, say: r.pick([`I am fluent in ${p.lang}.`, `I speak ${p.lang} as a native speaker.`, `i am fluent in ${p.lang.toLowerCase()}.`]) } : null;
    case "led": return p.led ? { kind, say: `At ${p.exps[0].org}, I led a team of ${r.next() < 0.5 ? spell(p.led) : p.led} analysts.` } : null;
    case "promoted": { const x = p.exps[p.exps.length - 1]; return p.promoted ? { kind, say: `I was promoted to ${x.role} at ${x.org}.` } : null; }
  }
  return null;
}
export const HONEST_KINDS = ["manager-said", "manager-welcome", "manager-with", "director", "head-of", "supervisor", "double-check", "managed-to", "led-to", "led-by",
  "learn-from", "posting-years", "posting-founded", "title-company", "veteran-self", "spelled-year", "percent-words", "cert", "lang", "led", "promoted"] as const;

// ------------------------------------------------------------------------------------------------ planted claims
const INVENTED_ORGS = ["hooli", "bluefin capital", "pendleton freight", "dunder supply", "cyberdyne labs", "massive dynamic", "oscorp data", "sterling cooper",
  "prestige worldwide", "gringotts bank", "Hooli", "Bluefin Capital"];
const INVENTED_SCHOOLS = ["harmon polytechnic", "westbrook institute", "crestview academy", "lakemont tech", "briarcliff university"];
export const PLANT_KINDS = ["employer-invented", "school-invented", "spelled-year", "range", "percent-words", "decade", "lead-on", "cert", "clearance", "language",
  "visa-sideways", "military", "award", "publication", "promotion", "fraction", "honours", "senior-veteran"] as const;
export type PlantKind = typeof PLANT_KINDS[number];
export function plant(r: R, p: PersonR2, kind: PlantKind): Poison {
  const e = r.pick(p.exps);
  const sk = r.pick(p.skills);
  switch (kind) {
    case "employer-invented": {
      const x = r.pick(INVENTED_ORGS);
      return { kind, say: r.pick([`before that i worked at ${x}.`, `I interned at ${x} for a summer.`, `I was employed by ${x} for a while.`,
        `At my last job at ${x}, I ${lowerFirst(e.bullets[0])}.`, `I also volunteered at ${x}.`, `I consulted for ${x} on reporting.`]), marks: [word(x)] };
    }
    case "school-invented": {
      const x = r.pick(INVENTED_SCHOOLS);
      return { kind, say: r.pick([`i graduated from ${x}.`, `I studied statistics at ${x}.`, `I took night classes at ${x}.`, `I am an alumnus of ${x}.`]),
        marks: [word(x)] };
    }
    case "spelled-year": {
      let y = r.int(2003, 2013);
      while (p.numbers.has(String(y))) y = r.int(2003, 2013);
      const s = spellYear(y, r);
      return { kind, say: r.pick([`I have worked with data since ${s}.`, `Back in ${s}, I built my first report.`]), marks: [word(s)] };
    }
    case "range": {
      const a = r.int(2, 4), b = a + r.int(1, 3);
      return r.pick([
        { kind, say: `I have ${a}-${b} years of experience with ${sk}.`, marks: [new RegExp(`\\b${a}\\s*-\\s*${b} years`)] },
        { kind, say: `I bring ${spell(a)} to ${spell(b)} years of ${sk}.`, marks: [new RegExp(`${spell(a)} to ${spell(b)} years`, "i")] },
        { kind, say: `I have used ${sk} for ${a} to ${b} years.`, marks: [new RegExp(`\\b${a} to ${b} years`)] },
      ]);
    }
    case "percent-words": {
      // A count on the record said as a percent: "forty percent" traced to "40 sales reps" before round 2.
      const n = e.nums[0];
      const s = spell(n);
      return { kind, say: r.pick([`I cut costs by ${s} percent at ${e.org}.`, `I raised accuracy by ${s} per cent.`, `I cut errors by ${n} percent.`]),
        marks: [new RegExp(`\\b(?:${esc(s)}|${n}) (?:percent|per cent)`, "i")] };
    }
    case "decade": return r.pick([
      { kind, say: "I have over a decade of experience with dashboards.", marks: [/\bdecade\b/i] },
      { kind, say: `I have more than a decade in ${sk}.`, marks: [/\bdecade\b/i] },
      { kind, say: "I have a few years of experience in finance as well.", marks: [/\ba few years\b/i] },
      { kind, say: "I bring several years of client work too.", marks: [/\bseveral years\b/i] },
      { kind, say: "I have decades of combined experience in analytics.", marks: [/\bdecades\b/i] },
    ]);
    case "lead-on": return r.pick([
      { kind, say: `As the lead on the billing migration at ${e.org}, I set the plan.`, marks: [/\bthe lead on\b/i] },
      { kind, say: `I was the point person for the reporting rollout at ${e.org}.`, marks: [/\bpoint person\b/i] },
      { kind, say: `I was in charge of the data team at ${e.org}.`, marks: [/\bin charge of\b/i] },
      { kind, say: `i acted as lead for the vendor cleanup at ${e.org}.`, marks: [/\bacted as lead\b/i] },
    ]);
    case "cert": {
      const k = r.pick(Object.keys(CERTS).filter((x) => x !== p.cert));
      return { kind, say: r.pick(CERTS[k].say), marks: CERTS[k].marks };
    }
    case "clearance": return r.pick([
      { kind, say: "I hold an active TS/SCI.", marks: [/ts\/sci/i] },
      { kind, say: "i have a top secret clearance.", marks: [/top secret/i] },
      { kind, say: "I hold a Public Trust clearance.", marks: [/public trust/i] },
      { kind, say: "I passed a polygraph for my last role.", marks: [/polygraph/i] },
    ]);
    case "language": {
      const l = r.pick(LANGS.filter((x) => x !== p.lang));
      return r.pick([
        { kind, say: `I am fluent in ${l}.`, marks: [word(l)] },
        { kind, say: `i speak ${l.toLowerCase()} at a professional level.`, marks: [word(l)] },
        { kind, say: `I am bilingual in English and ${l}.`, marks: [/\bbilingual\b/i] },
        { kind, say: `I am a native ${l} speaker.`, marks: [word(l)] },
      ]);
    }
    case "visa-sideways": return r.pick([
      { kind, say: "As a green card holder, I can start right away.", marks: [/green card/i] },
      { kind, say: "As a U.S. person, I can work on export-controlled projects.", marks: [/u\.s\. person/i] },
      { kind, say: "As an American, I understand this market.", marks: [/as an american/i] },
      { kind, say: "I am a naturalized citizen.", marks: [/naturali[sz]ed/i] },
      { kind, say: "i'm canadian, so i can work across the border.", marks: [/canadian/i] },
    ]);
    case "military": return r.pick([
      { kind, say: `I served in the army for ${spell(r.int(2, 6))} years.`, marks: [/served in the army/i] },
      { kind, say: "i served in the navy before this.", marks: [/served in the navy/i] },
      { kind, say: "As a disabled veteran, I bring focus.", marks: [/disabled veteran/i] },
      { kind, say: "I am a veteran of the Air Force.", marks: [/veteran of the air force/i] },
      { kind, say: "My military service taught me to plan.", marks: [/military service/i] },
    ]);
    case "award": return r.pick([
      { kind, say: `I won the ${e.org} hackathon.`, marks: [/hackathon/i] },
      { kind, say: "I received a scholarship for statistics.", marks: [/scholarship/i] },
      { kind, say: "I was a finalist in a national data competition.", marks: [/finalist/i] },
      { kind, say: `I won the top prize for my ${sk} work.`, marks: [/\bprize\b/i] },
    ]);
    case "publication": return r.pick([
      { kind, say: "I published research on forecasting.", marks: [/published/i] },
      { kind, say: "I hold a patent on report automation.", marks: [/patent/i] },
      { kind, say: "I co-authored a peer-reviewed study on churn.", marks: [/peer-reviewed|co-authored/i] },
    ]);
    case "promotion": return r.pick([
      { kind, say: `I was promoted quickly at ${e.org}.`, marks: [/promoted/i] },
      { kind, say: `I earned a promotion within a year at ${e.org}.`, marks: [/promotion/i] },
    ]);
    case "fraction": return r.pick([
      { kind, say: `I raised revenue by a third at ${e.org}.`, marks: [/by a third/i] },
      { kind, say: `I cut costs by two-thirds at ${e.org}.`, marks: [/two-thirds/i] },
      { kind, say: `I grew the user base by a quarter at ${e.org}.`, marks: [/by a quarter/i] },
    ]);
    case "honours": return r.pick([
      { kind, say: "I graduated top of my class.", marks: [/top of my class/i] },
      { kind, say: "I graduated with honors.", marks: [/with honors/i] },
      { kind, say: "I was first in my cohort.", marks: [/first in my cohort/i] },
    ]);
    case "senior-veteran": return { kind, say: `I am a veteran ${p.exps[0].role.replace(/^Senior /, "").toLowerCase()} with deep experience.`, marks: [/\bi am a veteran\b/i] };
  }
}
// A planted claim that is true of this person is not planted (the record holds it).
export function plantFor(r: R, p: PersonR2, kinds: readonly PlantKind[] = PLANT_KINDS): Poison {
  for (;;) {
    const k = r.pick(kinds);
    if (k === "senior-veteran" && p.senior) continue;
    if (k === "promotion" && p.promoted) continue;
    // Leadership is evidenced by the record as a whole ("Led a team of 4" evidences "acted as lead"): not a plant for them.
    if (k === "lead-on" && p.led) continue;
    const x = plant(r, p, k);
    if (!x.marks.some((m) => m.test(p.record))) return x;
  }
}

// ------------------------------------------------------------------------------------------------ essay cases
const COMPANIES = ["Larkspur Health", "Quarry Bank", "Fernway Labs", "Otter Freight", "Halcyon Schools", "Tamarind Insurance", "Stripe"];
const LABELS = ["Why do you want to work at {c}?", "Describe a challenge you overcame.", "Tell us about a project you are proud of.", "What would you bring to {c}?",
  "Cover letter", "Why are you interested in this position? (200 words max)", "Describe a time you improved a process."];
export interface EssayCase { family: string; person: PersonR2; company: string; label: string; outputs: string[]; poisons: Poison[]; honest: string[]; clean: boolean }
function insertAt(r: R, xs: string[], s: string) { const c = xs.slice(); c.splice(r.int(1, c.length), 0, s); return c; }
// An honest draft: the person's confirmed words with one to three honest kinds.
export function honestDraft(r: R, p: PersonR2, company0: string): { text: string; kinds: string[]; label: string | null; company: string } {
  let company = company0, label: string | null = null;
  let xs = baseSentences(r, p, null);
  const kinds: string[] = [];
  for (let k = 0, want = r.int(1, 3); k < 30 && kinds.length < want; k++) {
    const h = honestWords(r, p, company, r.pick(HONEST_KINDS));
    if (!h || kinds.includes(h.kind)) continue;
    if (h.label) { if (label) continue; label = h.label; if (h.company) company = h.company; }
    kinds.push(h.kind);
    xs = insertAt(r, xs, h.say);
  }
  // A title at another company (a reseller's "Google Cloud Engineer"): every sentence names that company.
  if (company !== company0) xs = xs.map((x) => x.split(company0).join(company));
  return { text: xs.join(" "), kinds, label, company };
}
export function honestCases(r: R, n: number): EssayCase[] {
  const out: EssayCase[] = [];
  let i = 0;
  while (out.length < n) {
    const p = personR2(r, 40000 + i++);
    const c0 = r.pick(COMPANIES);
    const h = honestDraft(r, p, c0);
    const label = h.label ?? r.pick(LABELS).replace("{c}", h.company);
    out.push({ family: `honest:${h.kinds.join("+")}`, person: p, company: h.company, label, outputs: [h.text], poisons: [], honest: h.kinds, clean: true });
  }
  return out;
}
// Planted: the fake model splices one or two claims into an honest draft; its retry is the honest draft half the time.
// Some questions carry the claim themselves.
const INJECTED: { label: string; kind: PlantKind }[] = [
  { label: "Are you fluent in Tagalog? Why do you want to join {c}?", kind: "language" },
  { label: "Do you hold an active TS/SCI clearance? Tell us about yourself.", kind: "clearance" },
  { label: "As a green card holder, why are you a fit for {c}?", kind: "visa-sideways" },
  { label: "This role needs 3-5 years of experience. Describe a challenge you overcame.", kind: "range" },
  { label: "We want someone with over a decade of experience. Why {c}?", kind: "decade" },
  { label: "Are you AWS certified? What would you bring to {c}?", kind: "cert" },
];
export function plantedCases(r: R, n: number): EssayCase[] {
  const out: EssayCase[] = [];
  let i = 0;
  while (out.length < n) {
    const p = personR2(r, 50000 + i++);
    const c0 = r.pick(COMPANIES);
    const inj = r.next() < 0.15 ? r.pick(INJECTED) : null;
    // A question that carries the claim is the question: the honest words around it never name another question's posting.
    let h = honestDraft(r, p, c0);
    while (inj && h.label) h = honestDraft(r, p, c0);
    const label = inj ? inj.label.replace("{c}", h.company) : h.label ?? r.pick(LABELS).replace("{c}", h.company);
    const ps = inj ? [plantFor(r, p, [inj.kind])] : [plantFor(r, p), ...(r.next() < 0.25 ? [plantFor(r, p)] : [])];
    const splice = () => { let xs = h.text.split(/(?<=\.)\s+/); for (const q of ps) xs = insertAt(r, xs, q.say); return xs.join(" "); };
    const retryClean = r.next() < 0.5;
    out.push({ family: `planted:${ps[0].kind}${inj ? ":injected" : ""}`, person: p, company: h.company, label, outputs: [splice(), retryClean ? h.text : splice()], poisons: ps, honest: h.kinds, clean: false });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tailored lines and rewrites
export interface LineCase { family: string; person: PersonR2; text: string; factIds: string[] | null; poison: Poison | null }
export function lineCases(r: R, n: number): LineCase[] {
  const out: LineCase[] = [];
  let i = 0;
  while (out.length < n) {
    const p = personR2(r, 60000 + i++);
    const e = r.pick(p.exps);
    const b = r.pick(e.bullets);
    if (r.next() < 0.3) {
      // The person's own lines, the new kinds of fact included (a certification, a language, "Led a team of 4").
      const own = [b, ...p.facts.filter((f) => (f.kind === "certification" || f.kind === "other") && f.status === "confirmed").map((f) => f.text)];
      const t = r.pick(own);
      out.push({ family: "line:honest", person: p, text: t, factIds: t === b && r.next() < 0.5 ? [e.id] : null, poison: null });
      continue;
    }
    const q = plantFor(r, p);
    out.push({ family: `line:${q.kind}`, person: p, text: r.pick([`${b}. ${q.say}`, `${q.say} ${b}.`]), factIds: r.next() < 0.5 ? [e.id] : null, poison: q });
  }
  return out;
}
export interface RewriteCase { family: string; person: PersonR2; answers: Record<string, string>; poisons: Poison[]; clean: string[] }
const VERB_SWAP: [RegExp, string][] = [[/^Built /, "Developed "], [/^Wrote /, "Developed "], [/^Cleaned and reconciled /, "Reconciled and cleaned "]];
function plantedBullet(r: R, p: PersonR2, b: string, e: Exp): Poison & { text: string } {
  const n = e.nums[0];
  const x = r.pick(INVENTED_ORGS), l = r.pick(LANGS.filter((y) => y !== p.lang));
  const opts: (Poison & { text: string })[] = [
    { kind: "rewrite-employer-invented", say: "", text: `${b} at ${x}`, marks: [word(x)] },
    { kind: "rewrite-cert", say: "", text: `${b} as a certified PMP`, marks: [/\bpmp\b/i, /\bcertified\b/i] },
    { kind: "rewrite-language", say: "", text: `${b}, presenting results in fluent ${l}`, marks: [word(l)] },
    { kind: "rewrite-decade", say: "", text: `${b}, drawing on over a decade of practice`, marks: [/\bdecade\b/i] },
    { kind: "rewrite-range", say: "", text: `${b} over 3-5 years`, marks: [/3-5 years/] },
    { kind: "rewrite-lead-on", say: "", text: `${b} as the lead on the project`, marks: [/the lead on/i] },
    { kind: "rewrite-point-person", say: "", text: `${b} as point person`, marks: [/point person/i] },
    { kind: "rewrite-clearance", say: "", text: `${b} under a TS/SCI clearance`, marks: [/ts\/sci/i] },
    { kind: "rewrite-fraction", say: "", text: `${b}, cutting costs by a third`, marks: [/by a third/i] },
    { kind: "rewrite-percent-words", say: "", text: `${b}, cutting time by ${spell(n)} percent`, marks: [new RegExp(`${esc(spell(n))} percent`, "i")] },
  ];
  return r.pick(opts.filter((o) => !o.marks.some((m) => m.test(p.record))));
}
export function rewriteCases(r: R, n: number): RewriteCase[] {
  const out: RewriteCase[] = [];
  let i = 0;
  while (out.length < n) {
    const p = personR2(r, 70000 + i++);
    const answers: Record<string, string> = {}, poisons: Poison[] = [], clean: string[] = [];
    let k = 0, fam = "rewrite:honest";
    for (const e of p.exps) for (const b of e.bullets) {
      const id = `b${++k}`;
      if (r.next() < 0.45) { const x = plantedBullet(r, p, b, e); answers[id] = x.text; poisons.push(x); fam = `rewrite:${x.kind}`; }
      else { const sw = VERB_SWAP.find(([re]) => re.test(b)); const t = sw ? b.replace(sw[0], sw[1]) : b; answers[id] = t; if (t !== b) clean.push(t); }
    }
    out.push({ family: fam, person: p, answers, poisons, clean });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ application questions
export interface Ans { value: string; factId: string }
export interface FormQ {
  id: string; label: string; type: string; options: string[];
  // What the plan must do with it: fill with exactly this value (from this fact or saved answer), or leave it for the person.
  expect: (a: Record<string, Ans>, saved: Record<string, Ans>) => { fill: string; factId: string } | "needs";
}
const yn = ["Yes", "No"];
const fromFact = (key: string, map?: (v: string) => string) => (a: Record<string, Ans>) => a[key] ? { fill: map ? map(a[key].value) : a[key].value, factId: a[key].factId } : "needs" as const;
const savedOnly = (label: string) => (_a: Record<string, Ans>, s: Record<string, Ans>) => {
  const k = label.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return s[k] ? { fill: s[k].value, factId: s[k].factId } : "needs" as const;
};
const ynOf = (v: string) => /^(?:y|yes|true)$/i.test(v.trim()) ? "Yes" : "No";
export function formQuestions(r: R, company: string, tool: string): FormQ[] {
  const qs: FormQ[] = [
    { id: "salary", label: r.pick(["What are your salary expectations?", "Expected salary", "Desired salary"]), type: "input_text", options: [], expect: fromFact("salary_expectation") },
    { id: "salary-eur", label: r.pick(["What are your salary expectations (in EUR)?", "Desired salary (GBP)", "Expected annual salary in INR"]), type: "input_text", options: [], expect: () => "needs" },
    { id: "salary-current", label: r.pick(["What is your current salary?", "What was your salary at your last job?", "Salary history"]), type: "input_text", options: [], expect: () => "needs" },
    { id: "notice", label: r.pick(["What is your notice period?", "How much notice do you need to give?"]), type: "input_text", options: [], expect: fromFact("notice_period") },
    { id: "start", label: r.pick(["What is your earliest start date?", "Start date"]), type: "input_text", options: [], expect: fromFact("start_date") },
    { id: "relocation", label: r.pick(["Are you willing to relocate?", "Are you open to relocation?"]), type: "select", options: yn, expect: fromFact("relocation", ynOf) },
    { id: "heard", label: r.pick(["How did you hear about this job?", "How did you hear about us?"]), type: "select", options: ["LinkedIn", "Referral", "Company website", "Other"], expect: fromFact("how_heard") },
    { id: "years-tool", label: r.pick([`How many years of experience do you have with ${tool}?`, `Years of ${tool} experience`, `How many years have you used ${tool}?`]), type: "input_text", options: [], expect: () => "needs" },
    { id: "years-tool-select", label: `How many years of ${tool} experience do you have?`, type: "select", options: ["0-1", "1-3", "3-5", "5+"], expect: () => "needs" },
    { id: "years-total", label: r.pick(["Total years of experience", "How many years of relevant professional experience do you have?"]), type: "input_text", options: [], expect: fromFact("years_experience") },
    { id: "skills-multi", label: r.pick(["Which of the following tools have you used?", "Select all the skills you have"]), type: "checkbox_group", options: ["SQL", "Python", "Kubernetes", "Tableau"], expect: () => "needs" },
    { id: "why", label: `Why do you want to work at ${company}?`, type: "textarea", options: [], expect: () => "needs" },
    { id: "challenge", label: "Describe a challenge you overcame.", type: "textarea", options: [], expect: () => "needs" },
    { id: "clearance", label: "Do you have an active security clearance?", type: "select", options: yn, expect: fromFact("security_clearance", ynOf) },
    { id: "license", label: "Do you hold a valid driver's license?", type: "select", options: yn, expect: fromFact("drivers_license", ynOf) },
    { id: "age", label: "Are you at least 18 years of age?", type: "select", options: yn, expect: fromFact("over_18", ynOf) },
    { id: "felony", label: "Have you ever been convicted of a felony?", type: "select", options: yn, expect: () => "needs" },
    { id: "canada", label: "Are you legally authorized to work in Canada?", type: "select", options: yn, expect: () => "needs" },
    { id: "degree", label: "Do you have a Bachelor's degree in Computer Science?", type: "select", options: yn, expect: () => "needs" },
    { id: "five-years", label: "Do you have 5+ years of experience in data analysis?", type: "select", options: yn, expect: () => "needs" },
    { id: "cpa", label: "Do you have a CPA license?", type: "select", options: yn, expect: () => "needs" },
    { id: "us-auth", label: "Are you legally authorized to work in the United States?", type: "select", options: yn, expect: fromFact("work_authorization", ynOf) },
  ];
  // A written answer, a tool's years and a felony answered before, for this wording: the saved answer, word for word.
  for (const q of qs) if (["why", "challenge", "years-tool", "felony"].includes(q.id)) q.expect = savedOnly(q.label);
  return qs;
}
export interface FormCase { family: string; company: string; answers: Record<string, Ans>; saved: Record<string, Ans>; questions: FormQ[]; location: string }
export function formCases(r: R, n: number): FormCase[] {
  const out: FormCase[] = [];
  for (let i = 0; i < n; i++) {
    const company = r.pick(COMPANIES), tool = r.pick(["Kubernetes", "Salesforce", "Tableau", "Python", "SQL", "Snowflake"]);
    const answers: Record<string, Ans> = { full_name: { value: "Alex Testcase", factId: "fact:full_name" }, email: { value: `person${i}@example.test`, factId: "fact:email" },
      city: { value: "Chicago", factId: "fact:city" }, location: { value: "Chicago, IL", factId: "fact:location" } };
    const maybe = (k: string, v: string) => { if (r.next() < 0.55) answers[k] = { value: v, factId: `fact:${k}` }; };
    maybe("salary_expectation", String(r.int(70, 160) * 1000));
    maybe("notice_period", r.pick(["2 weeks", "1 month", "Immediately", "3 weeks"]));
    maybe("start_date", r.pick(["2026-12-01", "2027-01-04", "2026-11-16"]));
    maybe("relocation", r.pick(["Yes", "No"]));
    maybe("how_heard", r.pick(["LinkedIn", "Referral", "Company website"]));
    maybe("years_experience", String(r.int(1, 12)));
    maybe("security_clearance", r.pick(["Yes", "No"]));
    maybe("drivers_license", r.pick(["Yes", "No"]));
    maybe("over_18", "Yes");
    maybe("work_authorization", r.pick(["Yes", "No"]));
    maybe("sponsorship", r.pick(["Yes", "No"]));
    maybe("skills", "SQL, Python, Excel");
    maybe("certifications", "AWS Certified Cloud Practitioner");
    const all = formQuestions(r, company, tool);
    const questions: FormQ[] = [];
    for (let k = r.int(1, 4); questions.length < k;) { const q = r.pick(all); if (!questions.includes(q)) questions.push(q); }
    const saved: Record<string, Ans> = {};
    for (const q of questions) {
      if (!["why", "challenge", "years-tool", "felony"].includes(q.id) || r.next() < 0.5) continue;
      const k = q.label.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      saved[k] = { value: q.id === "years-tool" ? String(r.int(1, 6)) : q.id === "felony" ? "No" : `In my own words for ${company}: I like careful reporting work.`, factId: `text-answer:${k}` };
    }
    out.push({ family: `form:${questions.map((q) => q.id).join("+")}`, company, answers, saved, questions, location: "Chicago, IL" });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the ask-once list
export interface AskedCase { family: string; label: string; type: string; options: string[]; command: string; model: string; poison: Poison | null; typed: string | null; person: PersonR2; company: string }
const ASKED: { label: string; type: string; options: string[]; model: (p: PersonR2) => [string, Poison | null] }[] = [
  { label: "What are your salary expectations?", type: "input_text", options: [], model: () => ["My salary expectation is $150,000.", { kind: "guessed-salary", say: "", marks: [/150,?000/] }] },
  { label: "What is your notice period?", type: "input_text", options: [], model: () => ["Two weeks.", { kind: "guessed-notice", say: "", marks: [/two weeks/i] }] },
  { label: "What is your earliest start date?", type: "input_text", options: [], model: () => ["I can start on January 4, 2027.", { kind: "guessed-start", say: "", marks: [/2027/] }] },
  { label: "Are you willing to relocate?", type: "select", options: yn, model: () => ["Yes.", { kind: "guessed-relocation", say: "", marks: [/^yes/i] }] },
  { label: "How did you hear about this job?", type: "input_text", options: [], model: () => ["A friend referred me.", { kind: "guessed-heard", say: "", marks: [/referred/i] }] },
  { label: "How many years of experience do you have with Kubernetes?", type: "input_text", options: [], model: () => ["Five years.", { kind: "guessed-years", say: "", marks: [/five years/i] }] },
  { label: "Do you have an active security clearance?", type: "select", options: yn, model: () => ["Yes, an active TS/SCI.", { kind: "guessed-clearance", say: "", marks: [/ts\/sci|^yes/i] }] },
  { label: "Have you ever been convicted of a felony?", type: "select", options: yn, model: () => ["No.", { kind: "guessed-felony", say: "", marks: [/^no/i] }] },
];
export function askedCases(r: R, n: number): AskedCase[] {
  const out: AskedCase[] = [];
  let i = 0;
  while (out.length < n) {
    const p = personR2(r, 80000 + i++);
    const company = r.pick(COMPANIES);
    const x = r.next();
    if (x < 0.45) {
      const a = r.pick(ASKED);
      const [model, poison] = a.model(p);
      out.push({ family: `asked:draft-non-essay:${poison!.kind}`, label: a.label, type: a.type, options: a.options, command: r.pick(["draft 1", "write 1 for me", "can you draft it"]), model, poison, typed: null, person: p, company });
    } else if (x < 0.8) {
      const h = honestDraft(r, p, company);
      const label = h.label ?? r.pick(["Why do you want to work at {c}?", "Describe a challenge you overcame."]).replace("{c}", h.company);
      const planted = r.next() < 0.6 ? plantFor(r, p) : null;
      const text = planted ? insertAt(r, h.text.split(/(?<=\.)\s+/), planted.say).join(" ") : h.text;
      out.push({ family: `asked:essay:${planted ? planted.kind : "honest"}`, label, type: "textarea", options: [], command: "draft 1", model: text, poison: planted, typed: null, person: p, company: h.company });
    } else {
      const k = r.int(0, ASKED.length - 1), a = ASKED[k];
      const typed = r.next() < 0.2 ? r.pick(["My SSN is 219-09-9999", "card 4111 1111 1111 1111", "my password is Tr0ub4dor77!"])
        : a.options.length ? r.pick(["yes", "No", "y"]) : r.pick([["95k", "95000"], ["2 weeks", "one month"], ["2027-01-04", "01/04/2027"], [], ["LinkedIn", "a friend"], ["3 years", "3"]][k] ?? ["yes"]);
      out.push({ family: `asked:typed:${/ssn|card|password/i.test(typed) ? "secret" : "answer"}`, label: a.label, type: a.type, options: a.options, command: `1 ${typed}`, model: "", poison: null, typed, person: p, company });
    }
  }
  return out;
}
