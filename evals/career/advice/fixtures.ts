// Eleven fixture personas for the open-question pipeline (flag CAREER_KNOWLEDGE). The search layer is mocked: `retrieved` is all the
// "web" returns (fixture sources at fixtures.example, with invented figures that exist only here); `injected` are claims the
// guard must drop (a URL the search never returned, a number the quote does not carry); `poison` strings are never in any
// source, so they may not appear anywhere in the brief or the chat paragraph. Deterministic, offline.
import type { Fact, GroundOut, GroundSearch } from "../../../supabase/functions/_shared/agent/research/ground.ts";
import type { Kind } from "../../../supabase/functions/_shared/agent/research/fields.ts";

type F = [Kind, string, string];   // kind, text, quote
export interface Persona {
  id: string; field: string; message: string; facts: { id: string; kind: string; text: string }[]; url: string;
  retrieved: F[]; injected: F[]; poison: string[]; must: string[]; foreign?: RegExp; chat: string;
}
export const LINK = "https://files.example/brief/plan.md";
const same = (s: string) => [s, s] as const;
export const PERSONAS: Persona[] = [
  { id: "ib-freshman", field: "ib", message: "how do I get hired as an investment banker", facts: [{ id: "F-1", kind: "education", text: "Freshman at a state university, economics major" }], url: "https://fixtures.example/ib",
    retrieved: [
      ["timeline", "Large banks open summer analyst applications in the summer or early fall before the internship year.", "Large banks open summer analyst applications in the summer or early fall before the internship year, well ahead of the start date."],
      ["program", "Some banks run early-insight programs for first-year and sophomore students.", "Some banks run early-insight programs for first-year and sophomore students, separate from the summer analyst class."],
      ["employer", "Northfield Advisory Partners, a middle-market advisory firm, recruits interns through direct outreach.", "Northfield Advisory Partners, a middle-market advisory firm, recruits interns through direct outreach and alumni referrals."],
      ["pay", "The median annual wage for financial analysts was $99,010.", "The median annual wage for financial analysts was $99,010 in the most recent year."],
      ["outlook", "Employment of financial analysts is projected to grow 9 percent over the decade.", "Employment of financial analysts is projected to grow 9 percent over the decade, faster than average."]],
    injected: [["pay", "First-year analysts earn $250,000 at Goldman Sachs.", "analysts are paid well"]],
    poison: ["Goldman", "Lazard", "$250,000", "Blackstone", "Morgan Stanley"], must: ["boutique", "middle-market", "private equity", "early-insight", "fifteen-minute", "Realistic now", "Realistic later"],
    chat: `Right now a summer analyst seat at the largest banks is unlikely, so build a base this year with finance coursework, a finance club and relationships with people a few years ahead of you. Later, boutique and middle-market banks and small private equity shops are the realistic first rungs. The full plan, with sources and an outreach script, is here: ${LINK}` },
  { id: "nurse-new-grad", field: "nursing", message: "I'm a new grad nurse in Texas, how do I get my first job?", facts: [{ id: "F-1", kind: "education", text: "BSN, graduated this spring" }], url: "https://fixtures.example/rn",
    retrieved: [
      ["credential", "Graduates must pass the NCLEX-RN to be licensed as a registered nurse.", "Graduates must pass the NCLEX-RN to be licensed as a registered nurse in any state."],
      ["program", "Many hospitals run new-graduate residency programs lasting up to a year.", "Many hospitals run new-graduate residency programs lasting up to a year with a preceptor."],
      ["pay", "The median annual wage for registered nurses was $86,070.", "The median annual wage for registered nurses was $86,070 in the most recent year."],
      ["outlook", "Employment of registered nurses is projected to grow 6 percent over the decade.", "Employment of registered nurses is projected to grow 6 percent over the decade."]],
    injected: [["employer", "Mayo Clinic hires every new graduate in Texas.", "hospitals hire nurses"]],
    poison: ["Mayo Clinic", "travel nursing", "$120,000"], must: ["NCLEX", "residency", "licens", "preceptor", "Texas"], foreign: /\b(leetcode|github|software|python|coding)\b/i,
    chat: `Right now your first job depends on licensure and fit, so pass the licensing exam and apply to every new-graduate residency program in Texas, not only the most popular unit. Later, once you have a year on a unit, specialty certifications and charge roles open up. The plan, sources and an outreach script are in the file: ${LINK}` },
  { id: "electrician-apprentice", field: "trades", message: "I'm a first-year electrician apprentice in Ohio. What's my path to journeyman and beyond?", facts: [], url: "https://fixtures.example/electrician",
    retrieved: [
      ["eligibility", "Apprenticeship programs typically require a high school diploma or equivalent and passing an aptitude test.", "Apprenticeship programs typically require a high school diploma or equivalent and passing an aptitude test."],
      ["credential", "Most states require a journeyman license, earned with documented work hours and an exam.", "Most states require a journeyman license, earned with documented work hours and an exam."],
      ["pay", "The median annual wage for electricians was $61,590.", "The median annual wage for electricians was $61,590 in the most recent year."],
      ["outlook", "Employment of electricians is projected to grow 11 percent over the decade.", "Employment of electricians is projected to grow 11 percent over the decade, much faster than average."]],
    injected: [["program", "IBEW Local 38 accepts applications every March.", "union halls accept applications"]],
    poison: ["Local 38", "every March", "$55"], must: ["journeyman", "hours", "licens", "foreman"], foreign: /\b(leetcode|github|software|python|coding)\b/i,
    chat: `Right now the job is to log every hour and task and finish the classroom work, because your hours and exams are what turn an apprentice into a journeyman. Later, specialty work, foreman roles or your own license are open to you in that order. The staged plan and sources are in the file: ${LINK}` },
  { id: "teacher-switcher", field: "lnd", message: "I teach high school English and I want to move into corporate training or instructional design. Where do I start?", facts: [{ id: "F-1", kind: "experience", text: "High school English teacher" }], url: "https://fixtures.example/id",
    retrieved: [
      ["eligibility", "Entry-level instructional design roles often accept a bachelor's degree plus a portfolio of work samples.", "Entry-level instructional design roles often accept a bachelor's degree plus a portfolio of work samples."],
      ["pay", "The median annual wage for training and development specialists was $63,080.", "The median annual wage for training and development specialists was $63,080 in the most recent year."],
      ["outlook", "Employment of training and development specialists is projected to grow 8 percent over the decade.", "Employment of training and development specialists is projected to grow 8 percent over the decade."]],
    injected: [["credential", "The Association for Talent Development certificate is required for every role.", "certificates can help"]],
    poison: ["Association for Talent Development", "$78,000", "Articulate"], must: ["portfolio", "samples", "teach", "objective"], foreign: /\b(leetcode|github|python|coding)\b/i,
    chat: `Right now you can be credible in this field because teachers already design lessons, objectives and assessments, and these roles hire on work samples more than on credentials. Build two or three samples this semester, and later a first training role opens the door to senior design work. The plan and sources are in the file: ${LINK}` },
  { id: "laid-off-52-pm", field: "pm_ops", message: "I'm 52, a project manager, laid off last month. How do I get hired again?", facts: [{ id: "F-1", kind: "experience", text: "Project manager in construction" }], url: "https://fixtures.example/pm",
    retrieved: [
      ["outlook", "Employment of project management specialists is projected to grow 6 percent over the decade.", "Employment of project management specialists is projected to grow 6 percent over the decade."],
      ["credential", "The main project management certification requires documented project experience and training hours.", "The main project management certification requires documented project experience and training hours."],
      ["pay", "The median annual wage for project management specialists was $98,580.", "The median annual wage for project management specialists was $98,580 in the most recent year."]],
    injected: [["employer", "Booz Allen is hiring 400 project managers.", "firms are hiring"]],
    poison: ["Booz Allen", "ageism", "lawsuit", "400"], must: ["delivery", "unemployment", "recent", "former colleagues"], foreign: /\b(leetcode|github|python|coding)\b/i,
    chat: `Right now your experience is the asset, and the work is making it easy to read: lead with recent results and name the tools you use today. In the first weeks, sort out your separation paperwork and benefits, then use former colleagues for introductions. The staged plan and sources are in the file: ${LINK}` },
  { id: "f1-data", field: "data", message: "I'm an international student on an F-1 visa and want a data analyst job. How do I get one?", facts: [{ id: "F-1", kind: "education", text: "Master's student in statistics" }], url: "https://fixtures.example/data",
    retrieved: [
      ["eligibility", "F-1 students may work off campus only with Curricular Practical Training or Optional Practical Training authorization.", "F-1 students may work off campus only with Curricular Practical Training or Optional Practical Training authorization."],
      ["pay", "The median annual wage for data scientists was $108,020.", "The median annual wage for data scientists was $108,020 in the most recent year."],
      ["outlook", "Employment of data scientists is projected to grow 36 percent over the decade.", "Employment of data scientists is projected to grow 36 percent over the decade, much faster than average."]],
    injected: [["timeline", "The H-1B lottery has a 25 percent selection rate.", "visas are limited"]],
    poison: ["H-1B", "25 percent", "Google"], must: ["SQL", "DSO", "authorization", "analysis"],
    chat: `Right now data analyst roles in operations, finance and health settings are reachable if you can show SQL and one real analysis, but work authorization narrows which employers can hire you. Before any offer, confirm with your international student office how CPT and OPT apply. Later, specialist data roles open up. The plan and sources are in the file: ${LINK}` },
  { id: "veteran-trades", field: "trades", message: "I'm a veteran leaving the Army and want to become an electrician. What should I do?", facts: [{ id: "F-1", kind: "experience", text: "Army logistics specialist" }], url: "https://fixtures.example/vet",
    retrieved: [
      ["eligibility", "Apprenticeship programs typically require a high school diploma or equivalent and passing an aptitude test.", "Apprenticeship programs typically require a high school diploma or equivalent and passing an aptitude test."],
      ["pay", "The median annual wage for electricians was $61,590.", "The median annual wage for electricians was $61,590 in the most recent year."]],
    injected: [["program", "SkillBridge places veterans in electrical apprenticeships for $5,000.", "programs exist"]],
    poison: ["SkillBridge", "$5,000", "Local 11"], must: ["apprentice", "transition office", "licens", "veteran"], foreign: /\b(leetcode|github|software|python|coding)\b/i,
    chat: `Right now the realistic move is a registered apprenticeship or a contractor that trains and logs your hours, and your Army logistics background already shows reliability and safety discipline. Have the military transition office translate your duties first. Later, journeyman status and specialty work follow as your hours and exams accumulate. The plan is in the file: ${LINK}` },
  { id: "cc-transfer-eng", field: "eng", message: "I'm at a community college and want to transfer to finish a mechanical engineering degree. How do I get hired as an engineer after?", facts: [{ id: "F-1", kind: "education", text: "Community college student, pre-engineering" }], url: "https://fixtures.example/eng",
    retrieved: [
      ["program", "Many universities publish articulation agreements listing which community college courses transfer.", "Many universities publish articulation agreements listing which community college courses transfer for credit."],
      ["credential", "Engineers seeking licensure first pass the Fundamentals of Engineering exam.", "Engineers seeking licensure first pass the Fundamentals of Engineering exam, then gain experience."],
      ["pay", "The median annual wage for mechanical engineers was $99,510.", "The median annual wage for mechanical engineers was $99,510 in the most recent year."],
      ["outlook", "Employment of mechanical engineers is projected to grow 11 percent over the decade.", "Employment of mechanical engineers is projected to grow 11 percent over the decade."]],
    injected: [["employer", "Ford guarantees interviews to all transfer students.", "employers recruit students"]],
    poison: ["Ford", "MIT", "guarantees"], must: ["transfer", "co-op", "credit", "Fundamentals of Engineering"], foreign: /\b(leetcode|github|python|coding)\b/i,
    chat: `Right now the move is to lock in the transfer path and its credit rules in writing, because a smooth transfer is what makes the internship cycle at your new school winnable. Later, a co-op or internship in your first semester there leads to an early-career technical role. The staged plan and sources are in the file: ${LINK}` },
  { id: "bootcamp-swe", field: "swe", message: "I finished a coding bootcamp three months ago and I'm applying for software developer jobs with no callbacks. What now?", facts: [{ id: "F-1", kind: "project", text: "Built a budgeting web app in the bootcamp as a group project" }], url: "https://fixtures.example/swe",
    retrieved: [
      ["pay", "The median annual wage for software developers was $132,270.", "The median annual wage for software developers was $132,270 in the most recent year."],
      ["outlook", "Employment of software developers is projected to grow 17 percent over the decade.", "Employment of software developers is projected to grow 17 percent over the decade, much faster than average."]],
    injected: [["employer", "Meta hires bootcamp graduates in bulk.", "companies hire developers"]],
    poison: ["Meta", "Hack Reactor", "$120k"], must: ["portfolio", "readme", "small companies", "referral"],
    chat: `Right now the gap is probably evidence rather than effort, because group projects from a bootcamp look the same to employers, so replace one with something you built and own end to end. Then target small companies and agencies, using referrals where you can. Later, a first role widens your options. The plan is in the file: ${LINK}` },
  { id: "mba-consulting", field: "consulting", message: "I'm a first-year MBA student and want to break into management consulting. How do I do it?", facts: [{ id: "F-1", kind: "education", text: "MBA student, previously operations manager" }], url: "https://fixtures.example/consulting",
    retrieved: [
      ["timeline", "Consulting firms recruit MBA candidates in the fall for the following summer.", "Consulting firms recruit MBA candidates in the fall for the following summer internship."],
      ["pay", "The median annual wage for management analysts was $99,410.", "The median annual wage for management analysts was $99,410 in the most recent year."],
      ["outlook", "Employment of management analysts is projected to grow 11 percent over the decade.", "Employment of management analysts is projected to grow 11 percent over the decade."]],
    injected: [["employer", "McKinsey offers $192,000 to every MBA intern.", "firms pay well"]],
    poison: ["McKinsey", "$192,000"], must: ["case", "structure", "recruit", "alumni"], foreign: /\b(leetcode|github|python|coding)\b/i,
    chat: `Right now your window is the fall recruiting season, so the work is getting case interviews to a winnable level and showing analytical results from your operations background. Later, boutique and industry-specialist firms or an internal strategy team are strong routes if the largest firms do not work out. The plan and sources are in the file: ${LINK}` },
  { id: "firstgen-swe-small", field: "swe", message: "I'm a first-gen freshman and want a software engineering job at a small company. How do I get hired?", facts: [{ id: "F-1", kind: "education", text: "Freshman, computer science" }], url: "https://fixtures.example/swe2",
    retrieved: [
      ["program", "Many universities run first-year research and project programs that count as experience.", "Many universities run first-year research and project programs that count as experience."],
      ["outlook", "Employment of software developers is projected to grow 17 percent over the decade.", "Employment of software developers is projected to grow 17 percent over the decade."]],
    injected: [["employer", "Stripe has a freshman internship with 500 seats.", "internships exist"]],
    poison: ["Stripe", "500"], must: ["career center", "office hours", "open-source", "small companies"],
    chat: `Right now a full-time software job is not the realistic target, but a first-year project, a research seat or a small-company internship is, so use this year to build two finished projects. Later, small companies and agencies hire people who have shipped something and have a referral. Start with your career center and office hours. The plan is in the file: ${LINK}` },
];
export function mockSearch(p: Persona, calls: { n: number } = { n: 0 }): GroundSearch {
  return async (plan): Promise<GroundOut> => {
    calls.n++;
    const mk = (kind: Kind, text: string, quote: string, url: string): Fact => ({ id: "", kind, text, quote, url, label: "fixtures.example" });
    const facts = [...p.retrieved, ...p.injected].filter(([k]) => plan.kinds.includes(k)).map(([k, t, q], i) => mk(k, t, q, p.injected.some((x) => x[1] === t) ? "https://unreturned.example/page" : `${p.url}/${k}`));
    return { status: "ok", facts, urls: [...new Set(p.retrieved.map(([k]) => `${p.url}/${k}`))], cost_usd: 0.03 };
  };
}
void same;
