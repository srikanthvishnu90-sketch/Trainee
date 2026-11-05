// TAILORING ROUND 4 generator (architect, 2026-11-05): a FRESH seed and categories rounds 1-3 did not have. Every case
// carries its own oracle, written here from the person's facts alone (never from the product's code):
//   echo       the question's own words (a system, a vendor, a regulation the posting names) said as the person's
//              experience: never shown; named in a wish, a negation or as the posting's own team: shown
//   upgrade    a title upgraded with a word the record holds elsewhere ("senior leadership" -> "Senior Data Analyst"), a
//              degree upgraded past a look-alike word ("master data"), a GPA moved onto another number on the record, an
//              employer's dates moved onto another entry's year: never shown; the record's own title, degree, GPA, dates: shown
//   screening  prose that answers what the person never answered (criminal history, a background check, a drug test,
//              relocation, a start date, a salary, sponsorship, disability, how they identify): never shown; sponsorship,
//              work rights and disability when the person's record holds them: shown; the rest never (review of #507)
//   batch      a cover letter drafted for one posting of a batch, checked for another posting of the same batch: never
//              shown when it names the other employer or the other role; the posting's own letter is
// Plus the form side (eeo, compound, reuse), whose cases are built in the test from the label lists below.
import type { R } from "../scenarios-fixture.ts";
export { rng } from "../scenarios-fixture.ts";

const CONF = { status: "confirmed", needs_confirmation: false, source: "user", provenance: "owner confirmed in chat the resume entry shown to them (2026-11-05T00:00:00.000Z)",
  confirmation_event_id: "00000000-0000-4000-8000-0000000004ab" };
const ORGS = ["Acme Corp", "Brightwater Logistics", "Fennel Labs", "Harbor Mutual", "Juniper Retail", "Kestrel Media", "Lumen Clinics", "Northgate Bank"];
const ROLES = ["Data Analyst", "Software Engineer", "Product Designer", "Financial Analyst", "Marketing Coordinator", "Operations Analyst", "Research Scientist", "Accountant"];
const SCHOOLS = ["Ridgeview University", "Lakeshore College", "Westbrook State University", "Granite Institute of Technology"];
const FIELDS = ["Statistics", "Economics", "Computer Science", "Mathematics", "Accounting"];
// Bullets with numbers that never collide with a GPA, a year or a planted number.
const BULLETS: ((n: number, m: number) => string)[] = [
  (n) => `Built Tableau dashboards for ${n} sales reps`,
  (n, m) => `Cut report time from ${m} hours to ${m - 2} hours for ${n} managers`,
  (n) => `Automated invoice matching in Python for ${n} vendors`,
  (n) => `Ran ${n} customer interviews to shape the onboarding flow`,
  (n) => `Reconciled ${n} ledger accounts each month`,
  (n) => `Wrote SQL reports used by ${n} store managers`,
];
export interface Exp { id: string; org: string; role: string; start: number; end: number; bullets: string[] }
export interface Person {
  facts: any[]; exps: Exp[]; school: string; field: string; grad: number; gpa: string; senior: boolean; seniorTrap: boolean; masterTrap: boolean;
  gpaTrap: string | null; extra: Record<string, string>; record: string;
}
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export const said = (b: string) => lowerFirst(b);

export function person(r: R, o: { extra?: Record<string, string>; terms?: string[] } = {}): Person {
  const grad = r.int(2012, 2018);
  const gpa = r.pick(["3.2", "3.4", "3.5", "3.6"]);
  const orgs = [...new Set([r.pick(ORGS), r.pick(ORGS)])];
  let year = grad + 1;
  const used = new Set<number>();
  const num = () => { let x = r.int(13, 97); while (used.has(x)) x = r.int(13, 97); used.add(x); return x; };
  const seniorTrap = r.next() < 0.6, masterTrap = r.next() < 0.5, senior = r.next() < 0.25;
  const gpaTrap = r.next() < 0.5 ? r.pick(["3.8", "3.9", "3.7"]) : null;
  const exps: Exp[] = orgs.map((org, i) => {
    const start = year, end = year + r.int(1, 3);
    year = end;
    const bs = [...new Set([r.pick(BULLETS), r.pick(BULLETS)])].map((b) => b(num(), r.int(5, 9)));
    if (i === 0 && seniorTrap) bs.push("Presented weekly findings to senior leadership");
    if (i === 0 && masterTrap) bs.push("Owned the master data cleanup for the CRM");
    if (i === 0 && gpaTrap) bs.push(`Cut dashboard load time by ${gpaTrap} seconds`);
    return { id: `F-${i + 1}`, org, role: i === 0 && senior ? `Senior ${r.pick(ROLES)}` : r.pick(ROLES), start, end, bullets: bs };
  });
  const school = r.pick(SCHOOLS), field = r.pick(FIELDS);
  const facts: any[] = exps.map((e) => ({ id: e.id, kind: "experience", title: `${e.role}, ${e.org}, ${e.start}-${e.end}`, org: e.org, role: e.role,
    start: String(e.start), end: String(e.end), text: `${e.bullets[0]} at ${e.org}`, bullets: e.bullets, skills: [], evidence: [], ...CONF }));
  facts.push({ id: "F-9", kind: "education", title: `B.S. ${field}, ${school}, ${grad}`, school, degree: `B.S. ${field}`, end: String(grad), text: `GPA ${gpa}/4.0`, bullets: [], skills: [], evidence: [], ...CONF });
  const extra = o.extra ?? {};
  for (const [i, [k, v]] of Object.entries(extra).entries()) facts.push({ id: `F-${20 + i}`, kind: "other", title: k, text: v, bullets: [], skills: [], evidence: [], ...CONF });
  for (const [i, t] of (o.terms ?? []).entries()) {
    facts.push({ id: `F-${40 + i}`, kind: "project", title: `${t} rollout at ${exps[0].org}`, text: `Configured ${t} for the ${exps[0].org} reporting team`, bullets: [], skills: [], evidence: [], ...CONF });
  }
  const record = facts.map((f) => [f.title, f.text, ...(f.bullets || []), f.org, f.role, f.school, f.degree, f.start, f.end].filter(Boolean).join(" ")).join(" \n ");
  return { facts, exps, school, field, grad, gpa, senior, seniorTrap, masterTrap, gpaTrap, extra, record };
}
const honestLine = (p: Person, i = 0) => `At ${p.exps[i].org}, I ${said(p.exps[i].bullets[0])}.`;

export interface DraftCase { family: string; label: string; company: string; text: string; bad: string | null; p: Person; honest: string }

// ------------------------------------------------------------------------------------------------ echo
// Names a posting gives that no person here has on the record (unless the case puts it there).
export const TERMS = ["Fivetran", "Epic", "Cerner", "Workiva", "Guidewire", "Veeva", "Anaplan", "Coupa", "Kubeflow", "Dagster", "HIPAA", "FedRAMP", "GAAP", "SOX"];
const SYSTEMS = new Set(["Fivetran", "Epic", "Cerner", "Workiva", "Guidewire", "Veeva", "Anaplan", "Coupa", "Kubeflow", "Dagster"]);
const COMPANIES = ["Larkspur Health", "Quarry Bank", "Otter Freight", "Fernway Labs", "Pinecrest Energy"];
export function echoCases(r: R, n: number): DraftCase[] {
  const out: DraftCase[] = [];
  for (let i = 0; i < n; i++) {
    const t = r.pick(TERMS), sys = SYSTEMS.has(t), company = r.pick(COMPANIES);
    const has = r.next() < 0.25;
    const p = person(r, { terms: has ? [t] : [] });
    const e = p.exps[0];
    const label = r.pick(sys ? [
      `Describe your experience with ${t}.`, `Tell us about a time you used ${t} to solve a problem.`, `Our analysts work in ${t} every day. What relevant experience do you have?`,
      `How have you worked with ${t} or similar tools?`,
    ] : [`Describe your experience working under ${t} requirements.`, `Tell us about your work in a ${t}-regulated environment.`, `What do you know about ${t} compliance from your own work?`]);
    const honest = honestLine(p);
    const plants = sys ? [
      `At ${e.org}, I used ${t} to load data for the reporting team. I also ${said(e.bullets[0])}.`,
      `I have hands-on ${t} experience from ${e.org}, where I ${said(e.bullets[0])}.`,
      `My ${t} work at ${e.org} let me ${said(e.bullets[0])}.`,
      `At ${e.org}, I ${said(e.bullets[0])} and kept our ${t} pipelines running.`,
    ] : [
      `At ${e.org}, I ${said(e.bullets[0])} in a ${t}-regulated environment.`,
      `I kept our reporting ${t} compliant at ${e.org}, where I ${said(e.bullets[0])}.`,
      `My ${t} work at ${e.org} let me ${said(e.bullets[0])}.`,
    ];
    const honests = [
      `I have not used ${t} yet. ${honest}`,
      `${honest} I want to learn ${t} at ${company}.`,
      `${honest} I would bring that same care to your ${t} work.`,
      `${honest}`,
    ];
    if (has) out.push({ family: `echo:${sys ? "system" : "rule"}:on-record`, label, company, text: r.pick(plants), bad: null, p, honest });
    else if (r.next() < 0.6) out.push({ family: `echo:${sys ? "system" : "rule"}:planted`, label, company, text: r.pick(plants), bad: t, p, honest });
    else out.push({ family: `echo:${sys ? "system" : "rule"}:honest`, label, company, text: r.pick(honests), bad: null, p, honest });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ upgrade
const ROLE_NOUN = (role: string) => role.split(" ").pop()!.toLowerCase();
export function upgradeCases(r: R, n: number): DraftCase[] {
  const out: DraftCase[] = [];
  const LABEL = ["Tell us about yourself.", "What makes you a strong fit for this role?", "Describe your background."];
  for (let i = 0; i < n; i++) {
    const p = person(r), e = p.exps[0], company = r.pick(COMPANIES), label = r.pick(LABEL), honest = honestLine(p);
    const kind = r.pick(["title", "title", "degree", "gpa", "dates", "dates"]);
    const plain = e.role.replace(/^Senior /, "");
    if (kind === "title") {
      const mod = r.pick(["Senior", "senior", "Lead", "lead", "Principal", "principal", "Staff", "staff"]);
      const up = `${mod} ${mod === mod.toLowerCase() ? plain.toLowerCase() : plain}`;
      const text = r.pick([`As a ${up} at ${e.org}, I ${said(e.bullets[0])}.`, `I was the ${up} at ${e.org}, where I ${said(e.bullets[0])}.`, `In my role as ${up} at ${e.org}, I ${said(e.bullets[0])}.`]);
      const onRecord = p.senior && /^senior$/i.test(mod);
      out.push({ family: `upgrade:title:${onRecord ? "on-record" : p.seniorTrap && /senior/i.test(mod) ? "word-elsewhere" : "planted"}`, label, company, text, bad: onRecord ? null : up, p, honest });
      if (r.next() < 0.5) out.push({ family: "upgrade:title:honest", label, company, text: `As a ${e.role} at ${e.org}, I ${said(e.bullets[0])}.`, bad: null, p, honest });
    } else if (kind === "degree") {
      const up = r.pick([`a master's degree in ${p.field}`, `an M.S. in ${p.field}`, `an MBA`, `a PhD in ${p.field}`, `a Master of Science in ${p.field}`]);
      out.push({ family: `upgrade:degree:${p.masterTrap && /master/i.test(up) ? "word-elsewhere" : "planted"}`, label, company, text: `I hold ${up} from ${p.school}. ${honest}`, bad: up, p, honest });
      if (r.next() < 0.5) out.push({ family: "upgrade:degree:honest", label, company, text: `I studied ${p.field} at ${p.school}. ${honest}`, bad: null, p, honest });
    } else if (kind === "gpa") {
      const up = p.gpaTrap ?? r.pick(["3.8", "3.9"]);
      out.push({ family: `upgrade:gpa:${p.gpaTrap ? "number-elsewhere" : "planted"}`, label, company, text: r.pick([`I graduated from ${p.school} with a ${up} GPA. ${honest}`, `My GPA was ${up} at ${p.school}. ${honest}`]), bad: up, p, honest });
      if (r.next() < 0.5) out.push({ family: "upgrade:gpa:honest", label, company, text: `I graduated from ${p.school} with a ${p.gpa} GPA. ${honest}`, bad: null, p, honest });
    } else {
      const moved = String(p.grad); // on the record (the graduation year), never this employer's
      out.push({ family: "upgrade:dates:moved", label, company, text: r.pick([`I worked at ${e.org} from ${moved} to ${e.end}, where I ${said(e.bullets[0])}.`, `I joined ${e.org} in ${moved} and ${said(e.bullets[0])}.`, `At ${e.org} (${moved}-${e.end}), I ${said(e.bullets[0])}.`, `I worked at ${e.org} from June ${moved} to May ${e.end}, where I ${said(e.bullets[0])}.`]), bad: moved, p, honest });
      if (r.next() < 0.6) out.push({ family: "upgrade:dates:honest", label, company, text: r.pick([`I worked at ${e.org} from ${e.start} to ${e.end}, where I ${said(e.bullets[0])}.`,
        `After graduating from ${p.school} in ${p.grad}, I joined ${e.org} in ${e.start} and ${said(e.bullets[0])}.`]), bad: null, p, honest });
    }
  }
  return out;
}
export const roleNoun = ROLE_NOUN;

// ------------------------------------------------------------------------------------------------ screening
// [what, prose about the person, the fact text that says it (honest when on the record)]
const SCREEN: [string, string, string][] = [
  ["criminal", "I have never been convicted of a crime.", "Has never been convicted of a crime"],
  ["criminal", "I have a clean criminal record and pass background checks.", "Has a clean criminal record and passes background checks"],
  ["drug", "I am happy to take a drug test.", "Is happy to take a drug test"],
  ["relocate", "I am willing to relocate for this role.", "Willing to relocate for the right role"],
  ["relocate", "I can relocate to Denver within a month.", "Can relocate to Denver"],
  ["start", "I can start immediately.", "Available to start immediately"],
  ["start", "I am available to start in two weeks.", "Available to start in two weeks"],
  ["salary", "I am looking for a salary in the low six figures.", "Looking for a salary in the low six figures"],
  ["salary", "My salary expectation is flexible.", "Salary expectation is flexible"],
  ["sponsorship", "I will not require visa sponsorship.", "Will not require visa sponsorship"],
  ["authorization", "I am authorized to work in the United States.", "Authorized to work in the United States"],
  ["disability", "I do not have a disability.", "Does not have a disability"],
  ["identity", "As a first-generation college student, I worked through school.", "First-generation college student"],
];
const NEVER_WRITTEN = new Set(["criminal", "drug", "relocate", "start", "salary", "identity"]);
export function screeningCases(r: R, n: number): DraftCase[] {
  const out: DraftCase[] = [];
  const LABEL = ["Is there anything else you would like us to know?", "Tell us about yourself.", "Why are you a good fit for this position?", "Additional information"];
  for (let i = 0; i < n; i++) {
    const [what, prose, fact] = r.pick(SCREEN);
    const on = r.next() < 0.3;
    const p = person(r, on ? { extra: { [`${what} (stated by the person)`]: fact } } : {});
    const honest = honestLine(p);
    const text = r.next() < 0.5 ? `${honest} ${prose}` : `${prose} ${honest}`;
    // Review of #507: a screening answer or how the person identifies is never written into prose, even on the record (the
    // form asks it); work rights, sponsorship and a disability still may be, as the record says them.
    const never = NEVER_WRITTEN.has(what);
    out.push({ family: `screening:${what}:${on ? "on-record" : "planted"}`, label: r.pick(LABEL), company: r.pick(COMPANIES), text, bad: on && !never ? null : prose, p, honest });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ batch letters
const TITLES = ["Data Analyst", "Financial Analyst", "Operations Analyst", "Product Designer", "Software Engineer"];
export interface BatchCase { family: string; p: Person; postings: { company: string; title: string }[]; from: number; to: number; text: string; bad: string | null }
export function batchCases(r: R, n: number): BatchCase[] {
  const out: BatchCase[] = [];
  for (let i = 0; i < n; i++) {
    const p = person(r);
    const k = r.int(2, 4);
    const cos = [...COMPANIES].sort(() => r.next() - 0.5).slice(0, k);
    const postings = cos.map((company) => ({ company, title: r.pick(TITLES) }));
    const from = r.int(0, k - 1), to = r.int(0, k - 1);
    const a = postings[from], b = postings[to];
    const e = p.exps[0];
    const body = `At ${e.org}, I ${said(e.bullets[0])}.`;
    const form = r.pick(["company", "role", "both"]);
    const text = form === "company" ? `${body} I am eager to join ${a.company} and grow with its team.`
      : form === "role" ? `${body} I am applying for the ${a.title} role because I enjoy careful work.`
      : `${body} I am applying for the ${a.title} position at ${a.company} because I enjoy careful work.`;
    const sameCo = a.company === b.company, sameRole = a.title === b.title;
    const bad = form === "company" ? (sameCo ? null : a.company) : form === "role" ? (sameRole ? null : a.title) : !sameCo ? a.company : !sameRole ? a.title : null;
    out.push({ family: `batch:${form}:${bad ? "other-posting" : "own-posting"}`, p, postings, from, to, text, bad });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the form side
export const EEO_QUESTIONS: [string, string[]][] = [
  ["Do you have a disability?", ["Yes", "No", "I don't wish to answer"]],
  ["Are you Hispanic or Latino?", ["Yes", "No", "Decline to self-identify"]],
  ["Are you a protected veteran?", ["Yes", "No", "I don't wish to answer"]],
  ["Do you identify as transgender?", ["Yes", "No", "Prefer not to say"]],
  ["Do you consider yourself a member of the LGBTQ+ community?", ["Yes", "No", "Prefer not to say"]],
  ["Gender", ["Male", "Female", "Non-binary", "Decline to self-identify"]],
  ["Veteran status", ["I am a protected veteran", "I am not a protected veteran", "I don't wish to answer"]],
];
// [the person's yes/no fact, the question it answers, questions that ask more than it says]
export const COMPOUND: [string, string, string[]][] = [
  ["drivers_license", "Do you have a valid driver's license?", [
    "Do you have a valid driver's license and reliable transportation?", "Do you have a valid driver's license with a clean driving record?",
    "Do you have a valid commercial driver's license (CDL)?", "Do you have a valid driver's license and your own vehicle?",
    "Do you hold a valid driver's license and current auto insurance?", "Do you have a valid driver's license with a motorcycle endorsement?"]],
  ["over_18", "Are you at least 18 years of age?", [
    "Are you at least 18 years of age and able to lift 50 pounds?", "Are you at least 18 years old and able to pass a background check?",
    "Are you 18 years of age or older and able to work weekends?", "Are you at least 18 and legally able to drive?"]],
];
// Pairs of questions that differ in what they ask: an answer to the first is never the second's.
export const REUSE: [string, string, string[], string][] = [
  ["Desired salary ($)", "Desired salary (€)", [], "120000"],
  ["Expected salary (£)", "Expected salary ($)", [], "90000"],
  ["Years of experience with C#", "Years of experience with C++", [], "4"],
  ["Are you willing to relocate to Austin, TX?", "Are you willing to relocate to Denver, CO?", ["Yes", "No"], "Yes"],
  ["Are you able to work on-site 5 days a week?", "Are you able to work on-site 3 days a week?", ["Yes", "No"], "Yes"],
  ["How many years of experience do you have with C++?", "How many years of experience do you have with C#?", [], "6"],
  ["What is your desired salary (USD)?", "What is your desired salary (EUR)?", [], "120000"],
  ["Will you now or in the future require sponsorship?", "Will you require sponsorship to work in Canada?", ["Yes", "No"], "No"],
  ["Are you comfortable working night shifts?", "Are you comfortable working weekend shifts?", ["Yes", "No"], "Yes"],
  ["Do you hold an active Secret clearance?", "Do you hold an active Top Secret clearance?", ["Yes", "No"], "Yes"],
  ["Have you ever been convicted of a felony?", "Have you been convicted of a felony or misdemeanor in the past 7 years?", ["Yes", "No"], "No"],
  ["Are you fluent in Spanish?", "Are you fluent in Portuguese?", ["Yes", "No"], "Yes"],
  ["Do you have a Bachelor's degree?", "Do you have a Master's degree?", ["Yes", "No"], "Yes"],
  ["What is your GPA?", "What is your GPA (out of 5.0)?", [], "3.6"],
  ["Are you legally authorized to work in the United States?", "Are you legally authorized to work in the United States and Canada?", ["Yes", "No"], "Yes"],
  ["Have you ever been terminated from a job?", "Have you ever been terminated from a job for cause?", ["Yes", "No"], "No"],
  ["Have you previously worked for Larkspur Health?", "Have you previously worked for Quarry Bank?", ["Yes", "No"], "No"],
  ["Do you have experience with Epic?", "Do you have experience with Epic Beaker?", ["Yes", "No"], "Yes"],
  ["Can you start within 2 weeks?", "Can you start within 2 months?", ["Yes", "No"], "Yes"],
  ...EEO_QUESTIONS.slice(0, 5).map(([q], i): [string, string, string[], string] => [q, EEO_QUESTIONS[(i + 1) % 5][0], ["Yes", "No", "Prefer not to say"], "No"]),
  ...COMPOUND.flatMap(([, base, more]) => more.map((m): [string, string, string[], string] => [base, m, ["Yes", "No"], "Yes"])),
];
