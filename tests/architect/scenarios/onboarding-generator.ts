// ONBOARDING SCENARIOS (architect, 2026-10-29): seeded generators for a new person's first conversation and the
// confirmation of their resume (tests/architect/scenarios-onboarding.test.ts runs every one through the product's pure
// code; tests/architect/flow-scenarios-onboarding.test.ts sends a sample of people through the real handler on real
// Postgres).
//   resumes   a synthetic person's resume in many shapes: heading spellings ("PROFESSIONAL EXPERIENCE", "Work History",
//             "Education:", "VOLUNTEER EXPERIENCE", "HONORS & AWARDS"), sections that hold no entries (SUMMARY, OBJECTIVE,
//             INTERESTS, Relevant Coursework), entry and bullet styles, an optional secret typed into it (an SSN, a
//             password, a card number). Each comes with its truth: every entry's kind and first line, the sections not read
//   replies   what a person answers when shown their entries: plain yeses in many spellings; ambiguous replies that must
//             confirm nothing (a question, a hedge, a pause, an emoji, a bare "ok", a yes carrying more); noes;
//             corrections ("my title was X not Y", "change Y to X", "not Y, X" ...) with exactly what they change; and
//             messages that are no reply at all (a new ask)
//   journeys  a whole onboarding: a paste, then replies in any order (ambiguous, no, a correction, a question in between,
//             a new ask, the same resume again, a different resume), then a yes or none, then maybe a different resume
//             and its yes. The test runs each through the career host turn by turn and checks the profile against a
//             model of what the person actually confirmed.
// Every generator is seeded; a failure names its input. No network, no model.
import { rng, type R } from "../scenarios-fixture.ts";
export { rng };

export const NOW = Date.parse("2026-10-29T16:00:00Z");

// ------------------------------------------------------------------------------------------------ people and resumes
const FIRST = ["Avery", "Jordan", "Riley", "Priya", "Mateo", "Lin", "Noor", "Sam", "Kofi", "Elena", "Hiro", "Zoë"];
const LAST = ["Testcase", "Example", "Sample", "Demo", "Fixture", "Placeholder"];
// Two disjoint value sets: a person's first resume draws from set 0, the different resume they send later from set 1, so
// any value of the other resume found in a reply or on the profile is unambiguously the wrong resume's.
const SCHOOLS = [
  ["Lakeview College (TEST)", "Northbridge University (TEST)", "Riverside Tech (TEST)", "Ashford State (TEST)"],
  ["Crestview University (TEST)", "Hollis College (TEST)", "Bayside Institute (TEST)", "Granite State (TEST)"],
];
const COMPANIES = [
  ["Northwind (TEST)", "Contoso Labs (TEST)", "Fabrikam (TEST)", "Tailspin Toys (TEST)", "Wingtip Data (TEST)"],
  ["Adatum Corp (TEST)", "Litware (TEST)", "Proseware (TEST)", "Trey Research (TEST)", "Lucerne Publishing (TEST)"],
];
const GPAS = [["3.41", "3.62", "3.87", "3.15"], ["2.94", "3.28", "3.55", "3.73"]];
const DEGREES = ["B.S. Computer Science", "B.A. Economics", "B.S. Statistics", "B.A. Psychology", "B.S. Mechanical Engineering", "M.S. Data Science"];
const TITLES = [
  ["Data Analyst Intern", "Software Engineering Intern", "Marketing Intern", "Operations Analyst Intern"],
  ["Research Assistant", "Product Intern", "Finance Intern", "Teaching Assistant"],
];
const BULLETS = [
  "Built a dashboard in Python used by 40 analysts", "Cut weekly reporting time by 30% with SQL automation", "Ran A/B tests on onboarding emails for 12,000 users",
  "Wrote a pricing model in Excel for 6 product lines", "Shipped two React features to production", "Cleaned survey data for a 300-person study",
  "Coordinated a 5-person team for a campus launch", "Automated invoice matching with a Python script",
];
const PROJECTS = [["Budget Buddy app (TEST)", "Transit Delay Predictor (TEST)"], ["Course Planner bot (TEST)", "Air Quality Map (TEST)"]];
const CLUBS = [["Data Science Club (TEST)", "Investing Club (TEST)"], ["Robotics Society (TEST)", "Debate Union (TEST)"]];
const LEAD_ROLES = ["President", "Treasurer", "Captain", "Vice President", "Founder"];
const SKILLS = ["Python", "SQL", "Excel", "Tableau", "R", "JavaScript", "React", "Figma", "Java", "Go", "PowerPoint", "Pandas"];
const AWARDS = [["Dean's List (TEST) 2024", "Hackathon Winner (TEST) 2025"], ["Merit Scholarship (TEST) 2023", "Case Competition Finalist (TEST) 2025"]];
const MONTHS = ["Jan", "May", "June", "Aug", "Sept"];

export type Kind = "education" | "experience" | "project" | "leadership" | "award" | "skill";
export const HEADINGS: Record<Kind | "skip", string[]> = {
  education: ["EDUCATION", "Education", "Education:", "ACADEMIC BACKGROUND"],
  experience: ["EXPERIENCE", "Experience", "WORK EXPERIENCE", "Professional Experience", "PROFESSIONAL EXPERIENCE", "Work History", "RELEVANT EXPERIENCE", "Internships", "EMPLOYMENT HISTORY", "Experience:"],
  project: ["PROJECTS", "Projects", "Personal Projects", "ACADEMIC PROJECTS", "SELECTED PROJECTS"],
  leadership: ["LEADERSHIP", "Leadership", "LEADERSHIP & ACTIVITIES", "Activities", "VOLUNTEER EXPERIENCE", "Campus Involvement", "Extracurricular Activities"],
  award: ["HONORS", "Awards", "HONORS & AWARDS", "Honors and Awards"],
  skill: ["SKILLS", "Skills", "TECHNICAL SKILLS", "Skills:"],
  skip: ["SUMMARY", "Summary", "OBJECTIVE", "INTERESTS", "Professional Summary", "Relevant Coursework"],
};
const SKIP_BODY = ["Curious analyst who likes clean data and clear writing.", "Seeking a summer 2027 internship in analytics.", "Chess, trail running, film photography.", "Data Structures, Statistics, Econometrics"];

export interface Entry { kind: Kind; title: string; bullets: string[] }
export interface Resume {
  set: 0 | 1; name: string; school: string; gpa: string; companies: string[]; titles: string[];
  entries: Entry[]; unread: string[]; text: string; secret: { kind: "ssn" | "password" | "card"; value: string } | null; family: string;
}

function luhnDigit(body: string) {
  let sum = 0, dbl = true;
  for (let i = body.length - 1; i >= 0; i--) { let d = body.charCodeAt(i) - 48; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return String((10 - (sum % 10)) % 10);
}
const digits = (r: R, n: number) => Array.from({ length: n }, () => String(r.int(0, 9))).join("");
const bulletMark = (r: R) => r.pick(["- ", "• ", "* "]);

// One person's resume. `set` picks the value set (0: a first resume, 1: the different one sent later).
export function resume(r: R, set: 0 | 1 = 0, o: { secret?: boolean; skipSections?: boolean } = {}): Resume {
  const name = `${r.pick(FIRST)} ${r.pick(LAST)} (TEST)`;
  const school = r.pick(SCHOOLS[set]), gpa = r.pick(GPAS[set]), degree = r.pick(DEGREES);
  const nJobs = r.int(1, 2);
  const companies: string[] = [], titles: string[] = [];
  const pool = COMPANIES[set].slice(), tpool = TITLES[set].slice();
  for (let i = 0; i < nJobs; i++) {
    companies.push(pool.splice(r.int(0, pool.length - 1), 1)[0]);
    titles.push(tpool.splice(r.int(0, tpool.length - 1), 1)[0]);
  }
  const entries: Entry[] = [];
  const grad = r.int(2026, 2028);
  const eduLine = r.pick([
    () => `${school} - ${degree}, GPA ${gpa}, graduating May ${grad}`,
    () => `${school}, ${degree} (GPA: ${gpa}), ${grad}`,
    () => `${school} | ${degree} | GPA ${gpa} | Class of ${grad}`,
  ])();
  entries.push({ kind: "education", title: eduLine, bullets: r.next() < 0.4 ? [r.pick(["Coursework: Statistics, Databases, Algorithms", "Study abroad in Madrid (TEST), spring 2025", "Thesis on transit ridership"])] : [] });
  for (let i = 0; i < nJobs; i++) {
    const y = r.int(2023, 2025), m1 = r.pick(MONTHS);
    const dates = `${m1} ${y} - ${r.pick(["Aug", "Dec", "May"])} ${y + r.int(0, 1)}`;
    const line = r.pick([
      () => `${titles[i]}, ${companies[i]}, ${dates}`,
      () => `${titles[i]} | ${companies[i]} | ${dates}`,
      () => `${companies[i]} - ${titles[i]} (${dates})`,
    ])();
    const bs = Array.from({ length: r.int(1, 3) }, () => r.pick(BULLETS)).filter((b, k, a) => a.indexOf(b) === k);
    entries.push({ kind: "experience", title: line, bullets: bs });
  }
  if (r.next() < 0.7) entries.push({ kind: "project", title: r.pick(PROJECTS[set]), bullets: [r.pick(BULLETS)] });
  if (r.next() < 0.6) entries.push({ kind: "leadership", title: `${r.pick(LEAD_ROLES)}, ${r.pick(CLUBS[set])}, ${r.int(2023, 2025)} - ${r.int(2025, 2026)}`, bullets: r.next() < 0.5 ? ["Grew membership from 20 to 45"] : [] });
  if (r.next() < 0.4) entries.push({ kind: "award", title: r.pick(AWARDS[set]), bullets: [] });
  const skills = Array.from({ length: r.int(3, 6) }, () => r.pick(SKILLS)).filter((s, k, a) => a.indexOf(s) === k);
  // Sections in a shuffled order (education and experience first most of the time), each under one spelling of its heading.
  const order: Kind[] = ["education", "experience", "project", "leadership", "award"].filter((k) => entries.some((e) => e.kind === k)) as Kind[];
  if (r.next() < 0.3) order.reverse();
  const unread: string[] = [];
  const out: string[] = [name, `${r.pick(["Chicago, IL", "Austin, TX", "Remote"])} | ${name.split(" ")[0].toLowerCase()}@example.test | +1 555-01${r.int(10, 99)} (TEST)`];
  let secret: Resume["secret"] = null;
  if (o.secret) {
    const kind = r.pick(["ssn", "password", "card"] as const);
    if (kind === "ssn") { const v = `${r.int(100, 665)}-${r.int(10, 99)}-${r.int(1000, 9999)}`; secret = { kind, value: v }; out.push(`SSN: ${v}`); }
    else if (kind === "password") { const v = `${r.pick(["Maple", "Tr0ub4dor", "goBears", "Panda"])}${r.int(10, 9999)}${r.pick(["!", "#", "$"])}`; secret = { kind, value: v }; out.push(`Workday password: ${v}`); }
    else { const body = "4" + digits(r, 14); const v = body + luhnDigit(body); secret = { kind, value: v }; out.push(`Card for the application fee: ${v.match(/.{4}/g)!.join(" ")}`); }
  }
  out.push("");
  const skipSections = o.skipSections ?? r.next() < 0.5;
  if (skipSections) { const h = r.pick(HEADINGS.skip.filter((x) => /summary|objective/i.test(x))); unread.push(h.replace(/:$/, "")); out.push(h, r.pick(SKIP_BODY), ""); }
  for (const k of order) {
    out.push(r.pick(HEADINGS[k]));
    for (const e of entries.filter((x) => x.kind === k)) { out.push(e.title); for (const b of e.bullets) out.push(`${bulletMark(r)}${b}`); }
    out.push("");
  }
  if (skipSections && r.next() < 0.5) { const h = r.pick(["INTERESTS", "Relevant Coursework"]); unread.push(h); out.push(h, r.pick(SKIP_BODY), ""); }
  out.push(r.pick(HEADINGS.skill), skills.join(r.pick([", ", ", ", "; ", " | "])));
  for (const s of skills) entries.push({ kind: "skill", title: s, bullets: [] });
  const family = `${set ? "second" : "first"}${skipSections ? "+unread" : ""}${secret ? `+${secret.kind}` : ""}`;
  return { set, name, school, gpa, companies, titles, entries, unread, text: out.join("\n"), secret, family };
}
export const pasted = (rs: Resume, lead = "here is my resume:") => `${lead}\n${rs.text}`;

// ------------------------------------------------------------------------------------------------ replies
export type ReplyKind = "yes" | "unclear" | "no" | "correction" | "other";
export interface Reply { input: string; kind: ReplyKind; from?: string; to?: string; family: string }
const YES = ["yes", "Yes", "YES", "yes.", "Yes!", "yeah", "yep", "yup", "yes please", "correct", "Correct.", "confirmed", "confirm", "I confirm", "all correct",
  "that's right", "thats right", "That is right.", "that's correct", "yes, that's my resume", "Yes, that's my resume.", "yes thats my resume", "yes that's right",
  "yes, all correct", "yes looks good", "looks good", "Looks good to me", "looks right", "yes it is", "it's my resume", "that's my resume", "This is my resume",
  "yes, confirm them", "everything is correct", "all good", "perfect", "yesss", "yes yes", "Yes - that's correct", "yes, that's correct, thanks", "sure, that's right", "lgtm", "spot on"];
const UNCLEAR = [
  // questions
  "yes?", "correct?", "is that right?", "looks good?", "yes, is the GPA right?", "is my title right?", "right?", "that's my resume?", "should I say yes?", "is this all of it?",
  // hedges
  "yeah maybe", "maybe", "i guess", "yes i think so", "yes I think so?", "probably", "looks ok I guess?", "kinda", "sort of", "mostly right", "almost", "I think so",
  "yes probably", "seems right", "I suppose", "fine i guess", "if you say so", "close enough I guess",
  // pauses
  "wait", "hold on", "one sec", "hmm", "hmmm", "let me check", "not yet", "later", "do it later", "yes please wait", "hang on, let me look",
  // emoji and punctuation
  "👍", "🤔", "😐", "✅", "🙂", "...", "?", "👍🏽", "🙏",
  // bare acknowledgments
  "ok", "okay", "sure", "k", "fine", "cool", "right", "alright", "true",
  // a yes carrying more
  "yes but", "yes except the dates", "yeah mostly", "yes, one thing though", "yes, though the dates are off", "yes and no",
];
const NO = ["no", "No.", "nope", "NOPE", "nah", "that's wrong", "not mine", "that's not my resume", "wrong", "incorrect", "not quite", "no, that's wrong", "not right"];
const OTHER = ["find data analyst jobs in Chicago", "what jobs are open at Northwind?", "how do I prep for a case interview?", "write a cover letter for Contoso Labs",
  "apply to the analyst job at Fabrikam", "tell me about Litware", "what can you do?", "show me remote internships", "remind me tomorrow to follow up", "track my application to Ramp"];
// Corrections: {to} is what it should say, {from} what it says now.
export const CORRECTIONS: [string, string][] = [
  ["my title was {to} not {from}", "my title was"], ["my title was {to}, not {from}", "my title was,"], ["it's {to} not {from}", "it's"], ["not {from}, {to}", "not Y, X"],
  ["not {from} but {to}", "not Y but X"], ["change {from} to {to}", "change"], ["replace {from} with {to}", "replace"], ["{from} should be {to}", "should be"],
  ["{to}, not {from}", "X, not Y"], ["actually it should say {to} instead of {from}", "instead of"], ["no, my company was {to} not {from}", "no, my company"],
  ["yes but my title was {to} not {from}", "yes but"], ["the school is {to}, not {from}", "the school"], ["my GPA was {to} not {from}", "GPA"],
  ["almost - it's {to} not {from}.", "almost"], ["Please change {from} to {to}", "please change"],
];
const vary = (r: R, s: string) => { const k = r.int(0, 6); return k === 0 ? s.toUpperCase() : k === 1 ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
export function replies(r: R, n: number): Reply[] {
  const out: Reply[] = [];
  for (const y of YES) out.push({ input: y, kind: "yes", family: "fixed yes" });
  for (const u of UNCLEAR) out.push({ input: u, kind: "unclear", family: "fixed unclear" });
  for (const x of NO) out.push({ input: x, kind: "no", family: "fixed no" });
  for (const x of OTHER) out.push({ input: x, kind: "other", family: "fixed other" });
  while (out.length < n) {
    const k = r.int(0, 9);
    if (k <= 2) {
      const y = r.pick(YES);
      out.push({ input: vary(r, `${y}${/thank/.test(y) ? "" : r.pick(["", "", "!", ".", " thanks", ", thank you"])}`), kind: "yes", family: "yes" });
    } else if (k <= 5) {
      const u = r.pick(UNCLEAR);
      out.push({ input: /[\p{L}]/u.test(u) ? vary(r, u) : u, kind: "unclear", family: "unclear" });
    } else if (k === 6) {
      out.push({ input: vary(r, r.pick(NO)), kind: "no", family: "no" });
    } else if (k <= 8) {
      const [tpl, family] = r.pick(CORRECTIONS);
      const gpa = family === "GPA";
      const from = gpa ? r.pick(GPAS[0]) : r.pick([...TITLES[0], ...COMPANIES[0], ...SCHOOLS[0]]);
      let to = gpa ? r.pick(GPAS[1]) : r.pick([...TITLES[1], ...COMPANIES[1], ...SCHOOLS[1]]);
      if (to === from) to = `${to} II`;
      out.push({ input: tpl.replace("{to}", to).replace("{from}", from), kind: "correction", from, to, family: `correction: ${family}` });
    } else {
      out.push({ input: r.pick(OTHER), kind: "other", family: "other" });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ journeys
// One step of a person's first conversation. The test applies each to the career host and to its own model.
export type Step =
  | { t: "paste"; which: "A" | "B" | "A-again"; lead: string }
  | { t: "yes"; input: string; explicit: boolean }
  | { t: "unclear"; input: string }
  | { t: "no"; input: string }
  | { t: "correct"; input: string; from: string; to: string; target: "unique" | "missing" }
  | { t: "question"; input: string }
  | { t: "other"; input: string };
export interface Journey { id: number; a: Resume; b: Resume; steps: Step[]; family: string }
const LEADS = ["here is my resume:", "here's my resume:", "Here is my resume:", "my resume:", "This is my resume:"];
const QUESTIONS = ["where did I go to school?", "what's my GPA?", "whats my gpa", "where do I go to school?"];
const EXPLICIT_YES = ["yes, that's my resume", "Yes, that's my resume.", "yes thats my resume", "that's my resume", "yes, confirm my resume"];
const PLAIN_YES = ["yes", "Yes.", "yep", "correct", "that's right", "looks good", "yes, all correct", "confirmed"];

// A value in exactly one of the resume's entries (a job title, a company, the school, the GPA), for a correction that
// must change exactly that entry.
export function uniqueValue(r: R, rs: Resume): { value: string; kind: "title" | "company" | "school" | "gpa" } {
  const cands: { value: string; kind: "title" | "company" | "school" | "gpa" }[] = [
    ...rs.titles.map((value) => ({ value, kind: "title" as const })), ...rs.companies.map((value) => ({ value, kind: "company" as const })),
    { value: rs.gpa, kind: "gpa" },
  ];
  // The school also names a club entry only when the leadership line repeats it, which this generator never does.
  cands.push({ value: rs.school, kind: "school" });
  return r.pick(cands);
}
export function journeys(r: R, n: number): Journey[] {
  const out: Journey[] = [];
  for (let id = 0; id < n; id++) {
    const a = resume(r, 0), b = resume(r, 1);
    const steps: Step[] = [{ t: "paste", which: "A", lead: r.pick(LEADS) }];
    const noise = r.int(0, 3);
    for (let i = 0; i < noise; i++) {
      const k = r.int(0, 6);
      if (k <= 1) steps.push({ t: "unclear", input: r.pick(UNCLEAR) });
      else if (k === 2) steps.push({ t: "no", input: r.pick(NO) });
      else if (k === 3) {
        const v = uniqueValue(r, a);
        const to = v.kind === "gpa" ? r.pick(GPAS[1]) : v.kind === "school" ? r.pick(SCHOOLS[1]) : v.kind === "company" ? r.pick(COMPANIES[1]) : r.pick(TITLES[1]);
        const tpl = v.kind === "gpa" ? "my GPA was {to} not {from}" : r.pick(CORRECTIONS.filter(([, f]) => f !== "GPA"))[0];
        steps.push({ t: "correct", input: tpl.replace("{to}", to).replace("{from}", v.value), from: v.value, to, target: "unique" });
      } else if (k === 4) {
        steps.push({ t: "correct", input: `change ${r.pick(["Senior Staff Wizard", "Chief Llama Officer", "Moon Base (TEST)"])} to ${r.pick(TITLES[1])}`, from: "", to: "", target: "missing" });
      } else if (k === 5) steps.push({ t: "question", input: r.pick(QUESTIONS) });
      else steps.push({ t: "other", input: r.pick(OTHER.filter((x) => !/apply|track/.test(x))) });
    }
    if (r.next() < 0.15) steps.push({ t: "paste", which: "A-again", lead: r.pick(LEADS) });
    const end = r.int(0, 9);
    if (end <= 5) steps.push({ t: "yes", input: r.pick(PLAIN_YES), explicit: false });
    else if (end <= 7) steps.push({ t: "yes", input: r.pick(EXPLICIT_YES), explicit: true });
    // else: they never say yes
    if (r.next() < 0.35) {
      steps.push({ t: "paste", which: "B", lead: r.pick(LEADS) });
      if (r.next() < 0.3) steps.push({ t: "unclear", input: r.pick(UNCLEAR) });
      if (r.next() < 0.2) steps.push({ t: "question", input: r.pick(QUESTIONS) });
      if (r.next() < 0.8) steps.push({ t: "yes", input: r.pick([...PLAIN_YES, ...EXPLICIT_YES]), explicit: false });
      if (r.next() < 0.2) steps.push({ t: "paste", which: "A-again", lead: r.pick(LEADS) });
    }
    const family = steps.map((s) => s.t === "paste" ? `paste:${s.which}` : s.t).join(">");
    out.push({ id, a, b, steps, family });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the model
// What the person was shown (pending: the entries of the latest paste, as corrected; fresh while it is the last thing
// asked) and what they confirmed. Both tests judge the product against it, turn by turn.
export type MEntry = { kind: string; title: string; bullets: string[] };
export interface Model { confirmed: MEntry[] | null; confirmedFrom: "A" | "B" | "A-again" | null; pending: { from: "A" | "B" | "A-again"; entries: MEntry[]; fresh: boolean } | null }
export const newModel = (): Model => ({ confirmed: null, confirmedFrom: null, pending: null });
export const entriesOf = (rs: Resume): MEntry[] => rs.entries.map((e) => ({ kind: e.kind, title: e.title, bullets: e.bullets.slice() }));
export const sig = (es: MEntry[] | null) => (es ?? []).map((e) => `${e.kind}|${e.title}`).sort();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bounded = (v: string, flags: string) => new RegExp(`${/^\w/.test(v) ? "\\b" : ""}${esc(v)}${/\w$/.test(v) ? "\\b" : ""}`, flags);
const swap = (s: string, from: string, to: string) => s.replace(bounded(from, "gi"), to);
const holding = (es: MEntry[], v: string) => es.filter((e) => [e.title, ...e.bullets].some((x) => bounded(v, "i").test(x)));
export function modelStep(m: Model, s: Step, j: Journey) {
  if (s.t === "paste") {
    const es = entriesOf(s.which === "B" ? j.b : j.a);
    if (m.confirmed && JSON.stringify(sig(m.confirmed)) === JSON.stringify(sig(es))) m.pending = null; // the same resume again
    else m.pending = { from: s.which, entries: es, fresh: true };
  } else if (s.t === "yes") {
    // A plain yes while the entries are the last thing asked, or a yes naming the resume; after another turn a bare yes
    // is not taken, and the entries are asked for again (fresh).
    if (m.pending && (m.pending.fresh || /resume/i.test(s.input))) { m.confirmed = m.pending.entries; m.confirmedFrom = m.pending.from; m.pending = null; }
    else if (m.pending) m.pending.fresh = true;
  } else if (s.t === "correct") {
    if (m.pending && s.target === "unique") {
      const hit = holding(m.pending.entries, s.from);
      if (hit.length === 1) { hit[0].title = swap(hit[0].title, s.from, s.to); hit[0].bullets = hit[0].bullets.map((b) => swap(b, s.from, s.to)); m.pending.fresh = true; }
    }
  } else if (s.t === "question" || s.t === "other") {
    if (m.pending) m.pending.fresh = false;
  }
  // unclear / no: nothing confirmed; asked again while fresh, left to other answers while stale.
}
