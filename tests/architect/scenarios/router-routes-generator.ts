// ROUTER ROUTING ROUND (architect, 2026-11-02; D-007): the seeded generator for the router's routing decisions. Fresh seed and
// fresh families: job search vs people search vs company research vs pay questions vs application status vs outreach, said
// as questions, commands, in lower case, with typos and emoji, two asks in one, in other languages, and at employers whose
// names are everyday words or carry "people", "team", "jobs" or "hired" (Applebee's, People Inc., Teamworks, Jobber, Indeed).
//
// Every case carries its own truth: the landings its intent needs, written here from the template that made it and never
// read back from the product's code. A landing is where the turn ends up (tests/architect/scenarios/router-routes-landing.ts):
//   search          the role search (the router's discovery, or the handler's search over the board)
//   people          a people search at the employer (the networking turn's discovery)
//   networking      the networking turn's other parts (who-do-I-know, drafts held for approval, contacts)
//   company_file    the router's sourced company file
//   company_absent  the router's "X has no company file yet" answer
//   brain           the staged brain (a question the router has no data for, in any language)
//   status          application status (the standing / status turns or the router's tracker)
//   outreach        the router's outreach answers (drafts and asks; never a send)
//   people_plan     the router's plan for a list of people at the firm, for outreach the person approves step by step
//   company_lib     the role library's answer (a role's posting evidence; no firm named in a way code can read)
//   site_refused    the plain refusal for LinkedIn / Indeed / Handshake work
// A strict case (the template as written, lower case, end punctuation) must land on its first landing or on one of its
// `also` landings; a noisy case (typos, emoji, filler) may also land on the brain (it reads anything), never on another
// family's deterministic landing.
export const SEED = 20261102;
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type R = () => number;
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

export type Landing = "search" | "people" | "networking" | "company_file" | "company_absent" | "company_lib" | "brain" | "status" | "outreach" | "people_plan" | "site_refused";
export type Family = "job" | "job_q" | "people" | "company" | "pay" | "role_pay" | "status" | "outreach" | "multi" | "indeed" | "foreign";
export interface Case { family: Family; message: string; template: string; company: string | null; variant: string; strict: boolean; expect: Landing[] }

// Employers. FILED have a sourced company file in the library (the truth here is the library's content, listed by hand);
// every other employer has none. TRICKY names are everyday words or carry the families' own words.
export const FILED = ["Stripe", "Google", "Goldman Sachs", "Ramp", "Notion", "McKinsey", "JPMorgan", "Datadog", "Figma"];
export const TRICKY = ["Applebee's", "People Inc.", "Teamworks", "Jobber", "Target", "Gap", "Square", "Box", "Shell", "Compass", "Discover",
  "Monster", "Workday", "Hired", "TeamSnap", "PeopleGrove", "Jobvite", "Outreach", "Recruit Holdings", "Applied Materials", "Openings Co", "Status Labs", "Best Buy", "Chipotle"];
export const PLAIN = ["Delta Dental", "Acmeworks", "Ironstack Payments", "Bravo Labs"];
const NOFILE = [...TRICKY, ...PLAIN];
const ROLES = ["data analyst", "software engineer", "product manager", "accountant", "nurse", "marketing coordinator", "line cook", "ux designer"];
const PLACES = ["Chicago", "Austin", "Denver", "remote"];
const plural = (role: string) => `${role}s`;

type T = { family: Family; text: string; expect: Landing[]; also?: Landing[]; company?: string | null };
// Templates: {co} employer, {role} role, {roles} its plural, {place} a place.
const JOB_CMD = [
  "find me {role} roles at {co}", "find {role} jobs at {co}", "show me {role} openings at {co}", "search for {role} positions at {co}",
  "{role} jobs at {co}", "{role} roles at {co}", "find me jobs at {co}", "show me jobs at {co}", "look for {role} internships at {co}",
  "find me openings at {co}", "list {role} positions at {co}", "get me {role} postings at {co}", "find {role} jobs at {co} in {place}",
  "i want {role} jobs at {co}", "find me a {role} job at {co}", "{role} openings at {co}", "search {co} jobs", "show me {co} jobs",
];
const JOB_Q = [
  "any {role} openings at {co}?", "is {co} hiring {roles}?", "does {co} have any {role} jobs?", "are there {role} roles at {co}?",
  "any jobs at {co}?", "what {role} jobs does {co} have?", "is {co} hiring right now?", "got any {role} roles at {co}?",
];
const PEOPLE = [
  "who works at {co}", "find recruiters at {co}", "find {roles} at {co}", "who are the recruiters at {co}", "show me {roles} at {co}",
  "find people on the data team at {co}", "who are the hiring managers at {co}", "recruiters at {co}", "find engineers at {co}",
  "find people who work at {co}", "who do I know at {co}", "do I know anyone at {co}", "find someone at {co}",
];
const COMPANY = [
  "tell me about {co}", "what's the culture like at {co}?", "what's it like to work at {co}?", "what does {co} look for in {roles}?",
  "how's the interview process at {co}?", "what do you have on {co}?", "what is {co}'s culture like?",
];
const PAY = [
  "what does {co} pay?", "how much does {co} pay?", "how much does {co} pay {roles}?", "what does {co} pay {roles}?",
  "what's the salary for a {role} at {co}?", "how much do {roles} make at {co}?", "what's the pay like at {co}?", "what's {co}'s pay like?",
  "what is the pay at {co} for {roles}?", "what does a {role} at {co} make?", "salary at {co} for a {role}?",
];
const ROLE_PAY = [
  "what does a {role} make in {place}?", "how much do {roles} make?", "average salary for a {role}?", "what's the pay for {roles} in {place}?",
  "how much does a {role} earn?",
];
const STATUS = [
  "where's my application to {co}", "did I hear back from {co}", "what's the status of my {co} application", "did my application to {co} go through",
  "what happened with my application at {co}", "where do I stand with {co}", "did you apply to {co}", "status of my application to {co}",
];
const OUTREACH = [
  "email the recruiter at {co}", "draft a message to the hiring manager at {co}", "write a cold email to someone at {co}",
  "message my contacts at {co}", "reach out to engineers at {co}", "send a note to the recruiter at {co}", "draft an email to people at {co}",
  "help me write to a recruiter at {co}",
];
const MULTI = [
  "find jobs at {co} and who works there", "{role} roles at {co} and the recruiters there", "show me openings at {co} and who I know there",
  "find {role} jobs at {co} and tell me what they pay", "who works at {co} and are they hiring", "find recruiters at {co} and {role} jobs there",
];
const INDEED_T: [string, Landing[], Landing[]][] = [
  // The person's own alert emails (networking) or our own board search answer it; nothing is done on Indeed.
  ["find me {role} jobs on Indeed", ["site_refused"], ["networking", "search", "brain"]],
  ["search indeed for {role} jobs", ["site_refused"], ["networking", "search", "brain"]],
  ["apply to {role} jobs on indeed for me", ["site_refused"], []],
  ["what does Indeed pay {roles}?", ["brain"], []],
  ["what does Indeed pay?", ["brain"], []],
  ["tell me about Indeed", ["company_absent"], ["brain"]],
  ["where's my application to Indeed", ["status"], []],
  ["is Indeed hiring {roles}?", ["search"], ["brain", "site_refused", "networking"]],
];
// Other languages: the brain reads them (the router claims none of its English shapes), or the family's own landing.
const FOREIGN: [string, Landing[]][] = [
  ["busco trabajo de {role} en {co}", ["brain", "search"]], ["¿cuánto paga {co}?", ["brain"]], ["¿cuánto paga {co} a un {role}?", ["brain"]],
  ["¿quién trabaja en {co}?", ["brain", "people"]], ["¿cómo va mi solicitud en {co}?", ["brain", "status"]],
  ["quel est le salaire chez {co} ?", ["brain"]], ["qui travaille chez {co} ?", ["brain", "people"]], ["je cherche un emploi chez {co}", ["brain", "search"]],
  ["quanto paga a {co}?", ["brain"]], ["vagas de {role} na {co}", ["brain", "search"]],
  ["was zahlt {co}?", ["brain"]], ["wo ist meine Bewerbung bei {co}?", ["brain", "status"]], ["{co} kitna pay karta hai?", ["brain"]],
];

function bases(): T[] {
  const out: T[] = [];
  for (const co of [...FILED, ...NOFILE]) {
    const filed = FILED.includes(co);
    for (const x of JOB_CMD) out.push({ family: "job", text: x, expect: ["search"], company: co });
    for (const x of JOB_Q) out.push({ family: "job_q", text: x, expect: ["search"], also: ["brain"], company: co });
    for (const x of PEOPLE) out.push({ family: "people", text: x, expect: /know/.test(x) ? ["networking"] : ["people"], also: ["networking", "people_plan"], company: co });
    for (const x of COMPANY) out.push({ family: "company", text: x, expect: filed ? ["company_file"] : ["company_absent"], also: filed ? [] : ["brain"], company: co });
    // A pay question: the file's comp section when a file exists; otherwise the brain (it reads postings and the web through
    // its tools, under the figure checks), never the "no company file" answer that stops there.
    for (const x of PAY) out.push({ family: "pay", text: x, expect: filed ? ["company_file"] : ["brain"], also: filed ? ["brain"] : [], company: co });
    for (const x of STATUS) out.push({ family: "status", text: x, expect: ["status"], company: co });
    for (const x of OUTREACH) out.push({ family: "outreach", text: x, expect: ["networking"], also: ["outreach", "brain", "people_plan"], company: co });
    for (const x of MULTI) out.push({ family: "multi", text: x, expect: ["search"], also: ["people", "networking", "brain", "company_file", "company_absent"], company: co });
    for (const [x, e] of FOREIGN) out.push({ family: "foreign", text: x, expect: [e[0]], also: e.slice(1), company: co });
  }
  for (const x of ROLE_PAY) out.push({ family: "role_pay", text: x, expect: ["brain"], company: null });
  for (const [x, e, also] of INDEED_T) out.push({ family: "indeed", text: x, expect: e, also, company: "Indeed" });
  return out;
}

// Landings a variant itself makes right, beyond the template's own:
//   - a firm typed without its capitals ("what does square look for in data analysts?") cannot be told from a word, so the
//     role library's answer for the role named (no firm claimed), or the brain, is honest for a company question;
//   - a noisy ask that names Indeed may read the person's own job-alert emails (the networking turn; nothing is done on
//     Indeed), as tests/architect/routing-scenarios.test.ts allows.
function extra(b: T, message: string, strict: boolean): Landing[] {
  const out: Landing[] = [];
  if (b.family === "company" && b.company && !message.includes(b.company)) out.push("company_lib", "brain");
  if (b.family === "indeed" && !strict) out.push("networking");
  return out;
}
const fill = (tpl: string, co: string | null, role: string, place: string) =>
  tpl.replaceAll("{co}", co ?? "").replaceAll("{roles}", plural(role)).replaceAll("{role}", role).replaceAll("{place}", place);
const STRICT: [string, (s: string) => string][] = [
  ["as-is", (s) => s], ["lower", (s) => s.toLowerCase()], ["upper-first", (s) => s[0].toUpperCase() + s.slice(1)],
  ["end", (s) => /[?!.]$/.test(s) ? s : /^(?:who|what|where|how|is|are|does|did|do|any|got)\b/i.test(s) ? `${s}?` : `${s}.`],
  ["no-q", (s) => s.replace(/\s*[?.!]$/, "")],
];
const NOISY: [string, (s: string, r: R) => string][] = [
  ["hey", (s) => `hey ${s}`], ["pls", (s) => `${s} pls`], ["please", (s) => `please ${s}`], ["emoji", (s) => `${s} 🙏`], ["emoji-lead", (s) => `👀 ${s}`],
  ["lol", (s) => `${s} lol`], ["ok-so", (s) => `ok so ${s}`], ["upper", (s) => s.toUpperCase()], ["qq", (s) => `quick q: ${s}`],
  ["typo-swap", (s, r) => typo(s, r, "swap")], ["typo-drop", (s, r) => typo(s, r, "drop")], ["typo-double", (s, r) => typo(s, r, "double")],
  ["u", (s) => s.replace(/\byou\b/g, "u").replace(/\bplease\b/g, "pls").replace(/\bare\b/g, "r")], ["thx", (s) => `${s} thx`],
];
// One edit inside a lower-case word of 5+ letters that is not the employer's name (an edit to the name names another firm).
function typo(s: string, r: R, kind: "swap" | "drop" | "double", co?: string | null): string {
  const words = s.split(" ");
  const coWords = new Set(String(co ?? "").toLowerCase().split(/\s+/));
  const idx = words.map((w, i) => (/^[a-z]{5,}$/.test(w) && !coWords.has(w) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return s;
  const i = idx[Math.floor(r() * idx.length)], w = words[i];
  const j = 1 + Math.floor(r() * (w.length - 2));
  words[i] = kind === "swap" ? w.slice(0, j - 1) + w[j] + w[j - 1] + w.slice(j + 1) : kind === "drop" ? w.slice(0, j) + w.slice(j + 1) : w.slice(0, j) + w[j] + w.slice(j);
  return words.join(" ");
}

export function cases(seed = SEED, target = 10_000): Case[] {
  const r = rng(seed);
  const out: Case[] = [];
  const seen = new Set<string>();
  const push = (c: Case) => { if (!seen.has(c.message)) { seen.add(c.message); out.push(c); } };
  const all = bases();
  // Strict: every template once per employer, with a seeded role and place, under a seeded strict variant.
  for (const b of all) {
    const role = pick(r, ROLES), place = pick(r, PLACES);
    const [name, f] = pick(r, STRICT);
    const text = fill(b.text, b.company ?? null, role, place);
    push({ family: b.family, message: f(text), template: b.text, company: b.company ?? null, variant: name, strict: true, expect: [...new Set<Landing>([...b.expect, ...(b.also ?? []), ...extra(b, f(text), true)])] });
  }
  // Then noisy variants, drawn at random, until the target count.
  let guard = 0;
  while (out.length < target && guard++ < target * 30) {
    const b = all[Math.floor(r() * all.length)];
    const role = pick(r, ROLES), place = pick(r, PLACES);
    const strictFirst = r() < 0.35;
    const [n1, f] = strictFirst ? pick(r, STRICT) : ["", (x: string) => x] as [string, (s: string) => string];
    const [n2, g] = pick(r, NOISY);
    // A typo in another language is not this round's question (the brain reads those); English typos are.
    if (b.family === "foreign" && n2.startsWith("typo")) continue;
    const base = fill(b.text, b.company ?? null, role, place);
    const message = n2.startsWith("typo") ? typo(f(base), r, n2 === "typo-swap" ? "swap" : n2 === "typo-drop" ? "drop" : "double", b.company) : g(f(base), r);
    if (message === base && !strictFirst) continue;
    push({ family: b.family, message, template: b.text, company: b.company ?? null, variant: [n1, n2].filter(Boolean).join("+"), strict: false,
      expect: [...new Set<Landing>([...b.expect, ...(b.also ?? []), "brain", ...extra(b, message, false)])] });
  }
  return out;
}

// The acting landings no case here may take: none of these messages asks to apply, cancel or pay.
export const ACTING = ["apply", "cancel", "billing"];
