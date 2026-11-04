// Hand-written Telegram verdicts for the high-traffic fields, and a field-aware template (name plus one route line) for the rest.
// Every line is GENERAL KNOWLEDGE: method and categories only, no figure, date, pay, named employer or named program
// (career-research.test.ts lints these lines like the field catalog). The brief and the chat paragraph both use them.
import type { Field } from "./fields.ts";

export interface Short { key: string; name: string; now: string; later: string; act: string; degree: string; worth: string; late: string }
type Entry = Omit<Short, "late"> & { detect: RegExp };
export const SHORTS: Entry[] = [
  { key: "nursing", name: "nursing", detect: /\bnurs(?:e|es|ing)\b|\bRN\b/i,
    now: "right now the work is passing the licensing exam and applying to new-graduate programs",
    later: "after the first stretch on a unit, specialty certifications, charge roles and advanced practice open up",
    act: "check your state board's application steps and exam timing, and ask your school's career office which employers hire its graduates",
    degree: "Yes: nursing needs an approved nursing program and a license, so check which program types your state board accepts before you enrol.",
    worth: "Nursing is worth it if you can take shift work and patient care; check current demand and pay near you in a source, and shadow a nurse before you commit." },
  { key: "law", name: "law", detect: /\blawyer\b|\battorney\b|\blaw school\b|\bbar exam\b|\bcareer in law\b|^law$|\blaw\b(?! enforcement)/i,
    now: "right now the realistic path to practising law runs through an approved law degree and the bar exam, so the work is a strong undergraduate record and a test plan",
    later: "after you pass the bar, practice areas, clerkships, public service and firm roles open, and your first job strongly shapes the next",
    act: "talk to one practising lawyer about a normal week, and read your state bar's admission requirements",
    degree: "Yes: in most states you need a law degree and a passing bar exam, so read your state bar's rules before you apply anywhere.",
    worth: "Law is worth it mainly when you want the work itself, because the cost of school is real and outcomes vary widely by school and region, so talk to practising lawyers first." },
  { key: "accounting", name: "accounting", detect: /\baccountan?t?s?\b|\baccounting\b|\bCPA\b/i,
    now: "right now the route is the accounting coursework the license requires, a clean record and a first internship",
    later: "after your first years of experience, the professional license, specialties such as audit or tax, and management roles open",
    act: "check your state board's education rules for the license, and ask your accounting department which firms recruit on campus",
    degree: "Usually yes: the license has set coursework and degree rules by state, so check your board's requirements before you choose classes.",
    worth: "Accounting is worth it if you like precise, deadline-driven work; check current openings and pay near you in a source before you decide." },
  { key: "ux", name: "UX design", detect: /\bUX\b|user experience|product design/i,
    now: "right now the realistic goal is a portfolio of a few case studies that show your process",
    later: "after a first design role, senior designer, research and design-lead roles open",
    act: "pick one real problem, interview a few users about it, and write up the process as your first case study",
    degree: "Usually no: design hiring leans on a portfolio more than a degree, though some employers still ask for one, so read a few postings.",
    worth: "Design work for users is worth it if you enjoy research and iteration; test that with one small project before paying for a course." },
  { key: "product", name: "product management", detect: /product manag/i,
    now: "right now product management is usually entered from a nearby role, such as analyst, designer, engineer or support, then a move across",
    later: "after you have shipped something with a team, associate and full product manager roles become realistic",
    act: "write down one decision you influenced at work or school, what you measured, and what happened",
    degree: "Usually no: shipped work and judgment are what you can show, though some postings ask for a degree, so read postings to see what each asks.",
    worth: "Product management is worth it if you like making calls without all the facts; look at the nearby roles first, since that is how most people get in." },
  { key: "pilot", name: "aviation", detect: /\bpilot\b|\baviation\b|\bairline\b/i,
    now: "right now the realistic path is flight training toward the required certificates, which is a long, paid-for route, so the first job is to pass the medical and find a training school",
    later: "after you build flight hours, instructing, regional and then larger airline roles open",
    act: "book an introductory flight, and ask your aviation authority what the medical certificate requires",
    degree: "Not always: the licence is earned through flight training and hours, though some airlines prefer a degree, so check their postings.",
    worth: "Aviation is worth it if you will accept years of training cost and time away from home first; talk to working pilots and check current pay in a source." },
  { key: "welding", name: "welding", detect: /\bweld(?:er|ers|ing)\b/i,
    now: "right now the realistic move is a training program or an apprenticeship that lets you practise and sit a weld test",
    later: "after you hold test certifications, you can aim at specialty processes, inspection and supervision",
    act: "visit one local welding program or union hall, watch a class and ask what the weld test covers",
    degree: "No degree is needed: employers hire on a passed weld test and hours, so check which certifications local shops ask for.",
    worth: "Welding is worth it if you like hands-on work in hot, physical conditions; check local employers and what certifications they ask for before you enrol." },
  { key: "electrician", name: "the electrical trade", detect: /electrician|electrical (?:trade|work|apprentice)|lineman/i,
    now: "right now the realistic move is a registered apprenticeship or a contractor who will train you and log your hours toward the license",
    later: "after the logged hours and the exam, journeyman status comes first, then specialty work, foreman roles or your own license and business",
    act: "find nearby apprenticeship programs, check their entry requirements and aptitude test, and call one about their next intake",
    degree: "No degree is needed: the route is an apprenticeship, logged hours and a licensing exam, so check your state's rules.",
    worth: "The electrical trade is worth it if you like hands-on problem solving and will accept years of apprentice wages first; call local contractors about hiring." },
  { key: "plumbing", name: "plumbing", detect: /plumb|pipefitter/i,
    now: "right now the realistic move is an apprenticeship with a licensed plumbing contractor, who will train you and log your hours",
    later: "after the logged hours and the exam, journeyman status comes first, then master licensing or your own business",
    act: "call two local plumbing contractors and the local trade school and ask when they next take apprentices",
    degree: "No degree is needed: plumbers learn through an apprenticeship with a licensed contractor and then sit a licensing exam, so check your state's hours.",
    worth: "Plumbing is worth it if you like hands-on repair work and on-call hours; check local contractors and apprenticeship openings before you commit." },
  { key: "hvac", name: "HVAC", detect: /hvac|heating and cooling|air conditioning/i,
    now: "right now the realistic move is a trade program or a helper job with a contractor, plus the refrigerant handling certification the work requires",
    later: "after a few seasons of field work, lead technician, installer, service and business roles open",
    act: "ask local contractors whether they hire helpers, and find out which refrigerant certification they expect you to hold",
    degree: "No degree is needed for the usual route: a trade program or helper experience plus the required certifications, so check local postings.",
    worth: "Heating and cooling work is worth it if you can handle attics, heat and on-call seasons; ask local contractors about hiring before you enrol." },
  { key: "mecheng", name: "mechanical engineering", detect: /mechanical engineer/i,
    now: "right now the realistic goal is the accredited degree and a co-op or internship that lets you try the work",
    later: "after a first design or manufacturing role, specialty, project lead and management roles open, and a professional license is optional for most roles",
    act: "ask your department which co-op or internship seats recruiters fill from your major, and add one hands-on build to your resume",
    degree: "Yes: engineering roles expect an accredited engineering degree, so check the program's accreditation before you enrol.",
    worth: "Mechanical engineering is worth it if you like math and building things; check the openings near you in a source before you commit." },
  { key: "civileng", name: "civil engineering", detect: /civil engineer/i,
    now: "right now the realistic path is the accredited degree, an internship with a design firm or public agency, and the first licensing exam",
    later: "after supervised experience, the professional license opens project lead, sign-off and management roles",
    act: "check your state licensing board's steps for engineers, and ask your department which agencies and firms hire its interns",
    degree: "Yes: licensure expects an accredited engineering degree, supervised experience and exams, so check your state board's rules.",
    worth: "Civil engineering is worth it if you want public-works and infrastructure work; check which local agencies and firms hire before you commit." },
  { key: "swe", name: "software engineering", detect: /software|\bswe\b|programmer|computer science/i,
    now: "right now the way in is shipped projects and real work for real users, which count for more than another course",
    later: "with finished projects and a referral, small and mid-size companies, agencies and internal tools teams become realistic",
    act: "pick one small tool you would use yourself and build it end to end, then put it on your public profile",
    degree: "Not strictly: shipped work is the proof you control, and some postings still ask for a degree, so read postings for what each asks.",
    worth: "Software is worth it if you like building and learning constantly; build one project before you invest further and check current openings in a source." },
  { key: "datasci", name: "data science", detect: /data scien/i,
    now: "right now data science titles usually ask for more than analyst roles, so the realistic entry is an analyst role with SQL, statistics and one strong project",
    later: "after a stretch as an analyst, machine learning, analytics engineering and specialist roles open",
    act: "pick a public dataset, answer one real question with SQL and a notebook, and write the answer in a page",
    degree: "Often yes for scientist titles, since many ask for a quantitative degree, but analyst roles hire on skills, so read postings.",
    worth: "Data science is worth it if you enjoy statistics and messy data; aim at analyst work first and check what scientist postings ask for." },
  { key: "teaching", name: "teaching", detect: /\bteach(?:er|ing)\b|\bclassroom\b/i,
    now: "right now hiring depends on your subject, your certification status and the district, so the realistic move is to confirm what your state requires",
    later: "experience, added endorsements and a master's degree widen options into leadership, curriculum and specialist roles",
    act: "look up your state education department's certification pathways and which exams your subject requires",
    degree: "Yes in most public schools: you need a degree and a state certificate, with alternative routes in some states, so check yours.",
    worth: "Teaching is worth it if you want the daily work with students; check pay and demand for your subject in the districts near you." },
  { key: "medicine", name: "medicine", detect: /physician(?! assistant)|\bdoctor\b|medical school|\bmedicine\b|surgeon/i,
    now: "right now the realistic path is long: a strong undergraduate record in the required science courses, clinical exposure and an admissions test",
    later: "after medical school, residency in a chosen specialty and then a license lead to practice",
    act: "shadow a physician for a day and list the science courses your target schools require",
    degree: "Yes: physicians need a medical degree, residency training and a license, so plan the required courses early.",
    worth: "Medicine is worth it only if you want the work itself, because the training is long and its cost is real; shadow physicians before you commit." },
  { key: "marketing", name: "marketing", detect: /\bmarketing\b/i,
    now: "right now the realistic goal is proof you can run something: a small campaign or channel with results you can describe",
    later: "after a first role, channel, brand, product marketing and management roles open",
    act: "run one small campaign for a club or local business and write down what you did and what changed",
    degree: "Usually not strictly: employers hire on work samples and results, though some ask for a degree, so read postings.",
    worth: "Marketing is worth it if you like mixing creativity and numbers; build proof of results first and read current postings for what they ask." },
  { key: "consulting", name: "consulting", detect: /consult(?:ing|ant)/i,
    now: "right now the realistic goal is case skill and analytical work you can show, since interviews test both",
    later: "boutique, specialist and mid-size firms and internal strategy teams are strong routes in, and many people move to the largest firms from there",
    act: "do one live practice case with a partner and write down how you structured it",
    degree: "Usually yes at the larger firms, which recruit from degree programs, while smaller firms weigh experience more, so check each one.",
    worth: "Consulting is worth it if you like structured problem solving and project work; practise cases before you decide and ask consultants what the job is like." },
  { key: "ib", name: "investment banking", detect: /investment bank|\bIB\b|banker/i,
    now: "right now the realistic goal is a base, not a big-bank seat: finance coursework, a finance club and conversations with people ahead of you",
    later: "boutique and middle-market banks, small private equity shops and corporate finance teams are the realistic first rungs",
    act: "join the finance or investing club and build one simple three-statement model of a public company from its filings",
    degree: "Usually yes: banks recruit from degree programs with finance coursework, so plan your courses and clubs early.",
    worth: "Investment banking is worth it if you accept demanding hours for the learning; build a base first and ask analysts what a normal week looks like." },
];

// Field-aware template for every occupation without a hand-written entry. It names the occupation, gives the route for its class
// (licensed, clinical, creative, public service, driving, field science, office, or open), and says what to do next. Route level
// only: no figure, no market claim, no named employer.
interface Route { id: string; re: RegExp; now: (n: string) => string; later: (n: string) => string; act: (n: string) => string; late: (n: string) => string }
const TIME = (n: string, tail: string) => `the question for ${n} is time to the credential, not age: ${tail}`;
const ROUTES: Route[] = [
  { id: "creative", re: /design|film|music|journalis|writ|photo|animation|video|illustrat|\bart\b|editor/i,
    now: (n) => `right now getting into ${n} is won on work you can show, so the realistic step is a few finished pieces of the kind you want to be hired for`,
    later: (n) => `after paid or published work in ${n}, you can aim for more roles and a reputation that brings work`,
    act: (n) => `finish one small piece of ${n} work and ask someone in the field what they would change`,
    late: (n) => TIME(n, "it is built piece by piece, so finish a first sample and show it to people in the field.") },
  { id: "public", re: /police|firefight|law enforcement|paramedic|\bemt\b|corrections|\bfire\b/i,
    now: (n) => `right now getting into ${n} runs through a public application with written, physical and background screening, then an academy, so find the next application window`,
    later: (n) => `after the academy and probation in ${n}, specialist units, promotion exams and supervisory roles open`,
    act: (n) => `find the hiring agency's official requirements for ${n} and check them against your age, record and fitness`,
    late: (n) => TIME(n, "agencies set their own age, fitness and background rules, so read the hiring agency's requirements before you plan anything else.") },
  { id: "clinical", re: /therap|hygien|pharmac|physician assistant|radiolog|veterinar|social work|psycholog|clinical|dental|counsel/i,
    now: (n) => `right now getting into ${n} runs through an approved program with clinical placements and then a licensing exam, so find the approved programs and their prerequisite courses`,
    later: (n) => `once licensed in ${n}, specializations, senior roles and advanced practice open`,
    act: (n) => `list the approved programs for ${n} in your state with their prerequisite courses, and check which ones you have finished`,
    late: (n) => TIME(n, "an approved degree, practice placements and a licensing exam take years, so check the licensing board's rules first.") },
  { id: "driving", re: /truck|driver|trucking/i,
    now: (n) => `right now getting into ${n} runs through a commercial license, a training course and a clean driving record`,
    later: (n) => `after a stretch of safe driving in ${n}, better routes, specialty freight and owner-operator work open`,
    act: (n) => `check your state's commercial license requirements for ${n} and call one training school or carrier about their route`,
    late: (n) => TIME(n, "the license and the training course are the gate, and medical and age rules for drivers are set by your state, so check them first.") },
  { id: "field", re: /wind|solar|energy|biolog|wildlife|environment|forest|agricultur|geolog|survey|ecolog|conservation|turbine|technician/i,
    now: (n) => `right now getting into ${n} usually runs through a technical program or a field assistant or seasonal role that lets you log hands-on hours, so the realistic step is to find those entry roles`,
    later: (n) => `after a season or two of field experience in ${n}, technician, specialist and lead roles open`,
    act: (n) => `search for field assistant, trainee or seasonal postings in ${n}, and note which certificate or course each one asks for first`,
    late: (n) => TIME(n, "a technical program or a seasonal field role gets you started, so find which one fits.") },
  { id: "office", re: /sales|human resources|\bhr\b|librar|admin|recruit|customer|account manager|office/i,
    now: (n) => `right now getting into ${n} usually runs through an entry seat such as coordinator, assistant or associate, so find those titles and what they ask for`,
    later: (n) => `after a first year or so in ${n}, specialist and team-lead roles open`,
    act: (n) => `read a few current ${n} entry postings and match the skills they ask for first to something you have done`,
    late: (n) => TIME(n, "it is entered through entry roles, so what counts is how soon you can show matching experience.") },
];
function baseTemplate(n: string, local: boolean): Short {
  return local
    ? { key: "template-licensed", name: n, now: `right now getting into ${n} runs through a licensing route set by your state or country, so learn that route and start its first requirement`,
        later: `once you are licensed in ${n}, specializations and senior roles open as the licensing body describes`,
        act: `find the licensing body for ${n}, read its entry requirements, and write down which ones you already meet`,
        late: TIME(n, "licensing takes set training and a set exam, so read the licensing body's rules and count that time against your plans."),
        degree: `Licensed fields set their own training rules, so whether ${n} needs a degree is decided by your licensing board; check before you enrol.`,
        worth: `Whether ${n} is worth it depends on pay and demand where you live, which I cannot quote without a source, and on whether you like the daily work, so shadow someone first.` }
    : { key: "template-open", name: n, now: `right now getting into ${n} turns on what employers screen on, so the realistic step is to read current postings and find out whether that is a credential, experience or samples`,
        later: `after a first role or placement in ${n}, specializations and senior roles come next`,
        act: `read a few current ${n} postings, note what each asks for first, and ask someone working in ${n} what they were hired on`,
        late: TIME(n, "read postings to see whether employers screen on experience, samples or a credential, then plan the time that one takes."),
        degree: `Employers in ${n} differ on whether they screen on a degree or on proven work, so read a few current postings before you pay for one.`,
        worth: `Whether ${n} is worth it depends on pay and demand where you live, which I cannot quote without a source, and on whether you like the daily work, so shadow someone first.` };
}
export function template(label: string, local: boolean): Short {
  const n = label, base = baseTemplate(n, local), r = ROUTES.find((x) => x.re.test(n));
  return r ? { ...base, key: `template-${r.id}`, now: r.now(n), later: r.later(n), act: r.act(n), late: r.late(n) } : base;
}
// The short verdict for this question: the hand-written entry whose field matches (label first, then the question), else the
// catalog field's own short with the template's degree and worth lines, else the template.
const L_: Record<string, string> = {
 "nursing": "the approved program and the licensing exam take years of study, so count that time and check your state board's rules.",
 "law": "a law degree and the bar exam take years and real cost, so count both before you apply.",
 "accounting": "the route is the coursework your state board requires for the license, so count the semesters it asks for.",
 "ux": "the route is a portfolio built project by project, so start your first case study and show it to designers.",
 "product": "the route is a move from a nearby role, and the experience you already have is the asset, so aim it at the role you move from.",
 "pilot": "flight training, the hours it needs and the medical certificate are the gates, and airlines set their own rules, so check both.",
 "welding": "a training program and a weld test are the gates, and the work is physical, so try a class before you plan around it.",
 "electrician": "an apprenticeship runs for years of logged hours, so count that time and ask programs about their entry rules.",
 "plumbing": "an apprenticeship runs for years of logged hours, so count that time and ask local contractors about their entry rules.",
 "hvac": "a trade program or helper job plus the refrigerant certification are the gates, so ask local contractors where to start.",
 "mecheng": "the accredited degree takes years of study, so count that time and ask about transfer credit for what you have done.",
 "civileng": "the accredited degree and supervised work toward the license take years, so count that time against your plans.",
 "swe": "the route is shipped projects, so the time that matters is how long until your first finished one.",
 "datasci": "the route is statistics, SQL and an analyst role first, so count that time before a scientist title.",
 "teaching": "the gate is your state's certification, and some states have routes for career changers, so check yours.",
 "medicine": "the path takes many years of school and residency, so count that time against your plans and talk to physicians who started later.",
 "marketing": "the route is proof of results, so the time that matters is how long until you have one campaign to describe.",
 "consulting": "the larger firms recruit on a set cycle, and smaller firms weigh experience, so check which door fits your timing.",
 "ib": "the large banks recruit on a set cycle tied to school years, so check how your timing fits it and look at smaller firms."
};
const LATE = (k: string, n: string) => (L_[k] ? TIME(n, L_[k]) : undefined);
export function shortFor(f: Field, message: string): Short {
  const hit = SHORTS.find((e) => e.detect.test(f.label)) ?? ((f.id as string) === "other" ? undefined : SHORTS.find((e) => e.detect.test(message)));
  if (hit) return { key: hit.key, name: hit.name, now: hit.now, later: hit.later, act: hit.act, degree: hit.degree, worth: hit.worth, late: LATE(hit.key, hit.name) ?? template(hit.name, false).late };
  const t = template(f.label, !!f.local);
  if (f.short && (f.id as string) !== "other") return { ...t, key: f.id, now: f.short.now, later: f.short.later, act: f.short.act };
  return t;
}
export const WORTH_ASK = /\bworth (?:it|doing|pursuing)\b|\ba good (?:career|field|major|bet|path|choice|job|profession)\b/i;
export const DEGREE_ASK = /\b(?:do|does|would) (?:i|you|it)\b[^?.!]{0,20}\b(?:need|require|take)\b[^?.!]{0,20}\b(?:degree|diploma|college|school)\b|\bwithout a (?:degree|college)\b/i;
export const LATE_ASK = /\btoo (?:late|old)\b|\bat my age\b|\bis it (?:still )?(?:possible|realistic) (?:for me )?(?:to|at)\b[^?.!]*\b(?:late|older|age)\b/i;
export function directAnswer(message: string, s: Short): string | null {
  if (LATE_ASK.test(message)) return s.late;
  if (DEGREE_ASK.test(message)) return s.degree;
  if (WORTH_ASK.test(message)) return s.worth;
  return null;
}
