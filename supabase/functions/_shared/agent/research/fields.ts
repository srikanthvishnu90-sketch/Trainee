// Field catalog for open career questions (flag CAREER_KNOWLEDGE). Every line here is GENERAL KNOWLEDGE: method and categories
// only, no number, date, pay figure, named employer or named program (fields.test.ts lints it). The brief labels these lines
// "general knowledge"; anything specific (timelines, programs, pay, outlook, named employers) has to come from a retrieved
// source (guard.ts). Fields are not software-first: software is one entry among ten.
export type FieldId = "ib" | "consulting" | "swe" | "data" | "nursing" | "trades" | "teaching" | "pm_ops" | "eng" | "lnd";
export type Kind = "timeline" | "program" | "eligibility" | "credential" | "pay" | "outlook" | "employer";
export interface Field {
  id: FieldId; label: string; detect: RegExp;
  // what to search, by the kinds of fact each search is for (ground.ts); {field} {stage} {geo} are filled in
  queries: { q: string; kinds: Kind[] }[];
  now: string; later: string;                // the honest read: what is realistic now, and what comes later
  slots: { foundation: string; experience: string; credential: string; target: string }; // the staged path
  targets: string[];                         // categories of employer or program (never names)
  credentials: string[];                     // skills and credentials, with how to get them
  who: string[];                             // networking: who to talk to (categories, never people)
  asks: string[];                            // what to ask them
  verify: string[];                          // what this brief cannot know without a current source
  cycle: string[];                           // the usual route by stage or year, in words (no dates or figures): where the person is on it
  short?: { now: string; later: string; act: string };   // the Telegram paragraph's verdict: one plain sentence each, no list, no figure
  odds: string;                              // the honest odds in words, with no invented rate
  local?: boolean;                           // licensing or hiring rules are set by state or country
}
export const FIELDS: Field[] = [
  { id: "ib", label: "investment banking", detect: /investment bank|\bIB\b|private equity|\bPE (?:shop|firm)s?\b|\bM&A\b|banker/i,
    short: { now: "right now the realistic goal is a base, not a big-bank seat: finance coursework, a finance club and conversations with people ahead of you", later: "boutique and middle-market banks, small private equity shops and corporate finance teams are the realistic first rungs", act: "join the finance or investing club and build one simple three-statement model of a public company from its filings" },
    cycle: [
      "Freshman year: build the base, not the offer. Take accounting and finance courses, join the finance or investing club, keep grades you can defend, and start conversations with upperclassmen and alumni. Ask your career center which large banks offer programs for first-year students; I cannot confirm any from a source here, so check each bank's own careers page for eligibility and dates.",
      "Sophomore year: the first real recruiting cycle. The summer after sophomore year is where most people win a first internship, at a boutique or middle-market bank, a small private equity shop, a corporate finance team, or a large bank's program for sophomores if one exists for your school. Technical prep (accounting, valuation, discounted cash flow, comparable companies) starts here and is tested in interviews.",
      "Junior year: the recruiting that matters most. Large banks fill their summer analyst class from the junior class, with applications opening at the start of that year or earlier, well before the summer they cover. The junior-summer internship is how most full-time analyst offers are made, and a strong summer converts to an offer.",
      "Senior year: with an offer you prepare to start; without one, full-time analyst recruiting at smaller banks outside the main cycle is still open, and lateral moves exist later."],
    odds: "Large-bank analyst seats are hard to get, so treat one as possible but not the plan you depend on. What raises your chances is within your control: grades you can defend, a finance-club record, a modeling project and alumni introductions. If banks do not recruit at your school, start with boutique or middle-market banks, where those same things do the work a school name would otherwise do.",
    queries: [
      { q: "{field} recruiting timeline by class year: first-year and sophomore programs, junior summer analyst internship, conversion to full-time offer {geo}", kinds: ["timeline", "program", "eligibility"] },
      { q: "{field} first-year and sophomore early-insight programs at banks, plus boutique and middle-market banks that hire {stage} interns", kinds: ["employer", "program"] },
      { q: "{field} analyst recruiting GPA expectations target and non-target schools technical interview accounting valuation DCF comps", kinds: ["eligibility", "credential"] },
      { q: "Bureau of Labor Statistics financial analysts pay and outlook", kinds: ["pay", "outlook"] }],
    now: "A summer analyst seat at the largest banks is a stretch this early; what you can build now is a base: coursework, a finance or investing club, a modeling project, a first small-firm or finance-adjacent internship, and relationships with people a few years ahead of you.",
    later: "For the large-bank analyst class, apply early and check each bank's own calendar; a clean story helps: strong grades, a prior finance internship, and technical fluency. Boutique and middle-market banks, small private equity shops, and corporate finance or valuation groups are the realistic first rungs, and people move to larger firms from them later.",
    slots: { foundation: "Take the accounting and corporate finance courses, join the finance or investing club, and learn to read a financial statement end to end.", experience: "Look for a boutique investment bank, a middle-market advisory firm, a small private equity or search fund, a corporate development or valuation team, or a wealth-management office; early roles there are often unposted, so ask directly.", credential: "Build technical fluency: three-statement modeling, basic valuation, and how to talk through a deal you followed.", target: "Apply to the structured programs that open at your stage, and keep a list of every firm category you have talked to." },
    targets: ["Boutique advisory banks", "Middle-market banks", "Small private equity shops and search funds", "Corporate development and valuation groups", "Regional and wealth-management firms"],
    credentials: ["Modeling and valuation: take a course that has you build a three-statement model and a discounted cash flow from scratch, then redo one from a public filing yourself.", "Accounting fluency: finish the intermediate accounting sequence if your school offers it; interviewers test it.", "A deal story: pick one transaction in the news and be able to explain the buyer, the price logic and the risks in two minutes."],
    who: ["Alumni of your school working at boutique or middle-market banks and small private equity firms", "Upperclassmen who have already done a finance internship", "The finance club officers and your career center's finance advisor"],
    asks: ["How did you get your first finance role, and what would you do differently?", "What did your firm look for in interns that applicants usually lack?", "Which technical skill should I be strongest in by my next recruiting season?"],
    verify: ["The exact current recruiting calendar of any single firm", "Which firms run programs for your class year this cycle", "Current analyst pay at specific firms", "Whether a given firm recruits from your school"] },
  { id: "consulting", label: "management consulting", detect: /consult(?:ing|ant)|strategy (?:firm|role)/i,
    short: { now: "right now the realistic goal is case skill and analytical work you can show, since interviews test both", later: "boutique, specialist and mid-size firms and internal strategy teams are strong routes in, and many people move to the largest firms from there", act: "do one live practice case with a partner and write down how you structured it" },
    cycle: [
      "Early college years: build the base. Grades, leadership roles, quantitative coursework and analytical projects, plus first conversations with alumni at firms.",
      "Sophomore year: look for first-year and sophomore diversity or insight programs where your school is eligible, and start learning the case format.",
      "Junior year: the main internship recruiting. Applications open early in the school year, resumes and cases are screened hard, and the summer internship is how most full-time offers are made.",
      "Senior year and after: full-time recruiting continues at smaller and mid-size firms, and an MBA or an industry role is a common later route into the larger ones."],
    odds: "The most selective firms are hard to get into. What raises your chances is within your control: case skill, a clean record of leadership and analytical work, and alumni referrals; boutique and mid-size firms are another door.",
    queries: [
      { q: "{field} recruiting process timeline {stage} applicants {geo}", kinds: ["timeline", "program", "eligibility"] },
      { q: "{field} firms boutique and mid-size entry-level hiring MBA and undergraduate", kinds: ["employer", "program"] },
      { q: "Bureau of Labor Statistics management analysts pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "case interview preparation {field} structure and math", kinds: ["credential"] }],
    now: "At the largest firms the interviews test structured problem solving, leadership and clean numbers; realistic now is to get the case skill to a level where interviews are winnable and to build a record of analytical work.",
    later: "Boutique, industry-specialist and mid-size firms, internal strategy teams and the consulting arms of larger companies are strong routes in, and many people move across to the largest firms from there.",
    slots: { foundation: "Learn the case format by doing live cases with a partner, and write down how you structure a problem.", experience: "Take analytical work that produces a result you can quantify: a strategy or operations role, a student consulting group, or a pro bono engagement.", credential: "Build the toolkit interviewers test: market sizing, profitability, structured synthesis, and quick mental math.", target: "Apply by the stated deadline for the programs you qualify for, and use referrals and alumni conversations for the firms that hire through networks." },
    targets: ["Boutique and industry-specialist consulting firms", "Mid-size generalist firms", "Internal strategy and corporate development teams", "Government and nonprofit consulting groups"],
    credentials: ["Case skill: practice live cases weekly with a partner and keep a log of what you missed.", "Quantitative speed: practice percentages, estimation and chart reading until they are routine.", "One analytical story with a measurable result, told in a clear structure."],
    who: ["Alumni of your program who work in consulting or in strategy roles", "Recent hires and second-year students who just went through the process", "Your school's consulting club leaders"],
    asks: ["What separated candidates who got offers from those who did not?", "How did you practise cases, and what would you change?", "Which firm types fit my background, and why?"],
    verify: ["Each firm's current application window and class-year eligibility", "Current compensation at any named firm", "Whether a given office is hiring this cycle"] },
  { id: "swe", label: "software engineering", detect: /software|\bswe\b|(?:web|app|mobile|front[- ]?end|back[- ]?end|full[- ]?stack) (?:dev|developer|engineer)|programmer|coding bootcamp|computer programming/i,
    short: { now: "right now the way in is shipped projects and real work for real users, which count for more than another course", later: "with finished projects and a referral, small and mid-size companies, agencies and internal tools teams become realistic", act: "pick one small tool you would use yourself and build it end to end, then put it on your public profile" },
    cycle: [
      "Early college years: learn to build. Core programming courses, one or two projects you ship, and a habit of reading other people's code.",
      "Sophomore year: look for a first internship, a research seat, or an open-source or freelance project; many large companies run early-career programs.",
      "Junior year: the main internship recruiting season, with applications opening in the late summer and fall; practice data structures, algorithms and system basics for the interviews.",
      "Senior year and after: return-offer conversion, or a broad application push with referrals; keep shipping while you search."],
    odds: "A first software job is hard to land without evidence. Shipped projects, a prior internship and a referral are the levers you control; I have no sourced hiring-rate figure, so I give none.",
    queries: [
      { q: "software developer entry-level hiring timeline internships {stage} {geo}", kinds: ["timeline", "program", "eligibility"] },
      { q: "small company and startup software internships how to apply {stage}", kinds: ["employer", "program"] },
      { q: "Bureau of Labor Statistics software developers pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "entry-level software developer skills portfolio expected by employers", kinds: ["credential"] }],
    now: "What moves you now is evidence: shipped projects, a small amount of real work for real users, and referrals from people who have seen you build.",
    later: "Once you have one or two finished projects and some real-world work, the realistic targets widen to small and mid-size companies, agencies, internal tools teams and, with a track record, larger employers.",
    slots: { foundation: "Finish the core data structures and one language to the point you can build a small tool end to end.", experience: "Ship a small project that a real person uses, contribute a small fix to an open-source project, or take a part-time or contract task for a small business.", credential: "Keep a public portfolio with two or three finished projects, each with a clear readme and a short write-up of the decisions.", target: "Apply to small and mid-size companies and internships, with a referral where you can, and tailor each application to the product." },
    targets: ["Small companies and early-stage startups", "Agencies and consultancies", "Internal tools teams at non-tech employers", "Mid-size product companies", "Open-source and civic-tech groups"],
    credentials: ["Portfolio: two or three finished projects with readmes, deployed where someone can use them.", "Fundamentals: data structures, version control, testing and reading other people's code.", "Evidence of collaboration: a merged pull request, a team project, or a short engagement with a client."],
    who: ["Engineers at small companies who graduated from your school or program", "Maintainers of the open-source projects you use", "Meetup and campus-club organizers"],
    asks: ["What did your first engineering job look for in a junior hire?", "Can you look at one project of mine and tell me what is weakest?", "Which kinds of small teams hire people at my level?"],
    verify: ["Whether any named company is hiring juniors now", "Current pay at a named employer", "Which internships are open to your class year this cycle"] },
  { id: "data", label: "data analytics", detect: /data (?:analy|scien|engineer)|analytics|business intelligence|statistic(?:s|ian)/i,
    short: { now: "right now the way in is SQL, spreadsheet fluency and one real analysis, aimed at analyst roles in operations, finance, marketing or health", later: "after a stretch as an analyst, data science, analytics engineering and specialist roles open up", act: "pull one public dataset, answer one real question with SQL and a spreadsheet, and write the answer in a page" },
    cycle: [
      "Early college years: SQL, spreadsheets and statistics, plus one analysis of a real dataset you can explain end to end.",
      "Sophomore year: a first analyst internship, campus research or a volunteer analysis for a club or nonprofit.",
      "Junior year: the main internship cycle; a portfolio of two or three analyses and SQL screens carry the interviews.",
      "Senior year and after: apply to analyst roles in operations, finance, marketing and health settings, and move toward data science only after the analysis record is real."],
    odds: "Analyst roles are reachable from many majors if you can show SQL and one real analysis; data scientist titles usually ask for more, often a graduate degree or a stronger quantitative record.",
    queries: [
      { q: "entry-level data analyst hiring requirements and timeline {stage} {geo}", kinds: ["timeline", "program", "eligibility"] },
      { q: "data analyst internships and rotational programs employers {stage} {geo}", kinds: ["employer", "program"] },
      { q: "Bureau of Labor Statistics data scientists operations research analysts pay and outlook", kinds: ["pay", "outlook"] },
      { q: "data analyst skills SQL spreadsheets visualization portfolio expected", kinds: ["credential"] }],
    now: "Analyst roles in operations, finance, marketing and health settings are reachable now if you can show SQL, spreadsheet fluency and one analysis that answers a real question; data scientist titles usually ask for more.",
    later: "With a year or two of analyst experience and a few stronger projects, data science, analytics engineering and specialist roles open up.",
    slots: { foundation: "Get fluent in SQL and spreadsheets, and learn one visualization tool.", experience: "Analyze a real dataset from a public source, write up the question, method and finding, and offer to do the same for a small organization.", credential: "Add one credential only if your target employers ask for it, and ask them what they actually screen on.", target: "Apply to analyst roles in industries you can speak about, and tailor each application to a business question." },
    targets: ["Analyst roles in operations, finance and marketing", "Healthcare and public-sector analytics teams", "Research and nonprofit data teams", "Rotational analyst programs"],
    credentials: ["SQL: write joins, aggregations and window queries against a real dataset until they are routine.", "Spreadsheet fluency and one visualization tool.", "A written analysis: question, data, method, finding, limits."],
    who: ["Analysts at employers in the industry you want", "Alumni working in analytics or operations", "Local data meetup and professional association members"],
    asks: ["What does a day of analysis look like in your role?", "Which tools did you need in your first job?", "What would make a project of mine credible to your team?"],
    verify: ["Current openings and employer-specific requirements", "Whether work authorization limits particular employers", "Current pay in your city"], local: false },
  { id: "nursing", label: "nursing", detect: /\bnurs(?:e|es|ing)\b|\bRN\b|NCLEX/i,
    short: { now: "right now the work is passing the licensing exam and applying to new-graduate programs", later: "after the first stretch on a unit, specialty certifications, charge roles and advanced practice open up", act: "check your state board's application steps and exam timing, and ask your school's career office which employers hire its graduates" },
    cycle: [
      "Before and during the program: clinical placements, grades and a strong record on the clinical rotations decide where you are noticed.",
      "Final year: apply to new-graduate residency programs, which often open before graduation, and prepare for the licensing exam.",
      "After graduation: sit the licensing exam, finish state licensure and start on the unit that hires you; later specialties and advanced degrees open from there."],
    odds: "What raises your chances is within your control: pass the licensing exam on the first try, and stay open to the settings, shifts and units that take new graduates. The most sought-after units and programs are harder to get, so apply to a range.",
    queries: [
      { q: "new graduate registered nurse licensure NCLEX and hiring process {geo}", kinds: ["credential", "eligibility", "timeline"] },
      { q: "new graduate nurse residency programs hospitals {geo}", kinds: ["program", "employer"] },
      { q: "Bureau of Labor Statistics registered nurses pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "state board of nursing license by examination application steps {geo}", kinds: ["credential", "eligibility"] }],
    now: "A new graduate nurse is hired mainly on licensure and clinical fit: pass the licensing exam, apply to the structured new-graduate programs, and be open to the unit types and settings that hire most.",
    later: "After the first year or two on a unit, specialty certifications, charge roles and advanced practice routes open up, and mobility between employers is much easier.",
    slots: { foundation: "Confirm your state board's application steps and exam timing, and ask your school's career office which employers hire your graduates.", experience: "Apply to new-graduate residency or transition programs, and to every setting that hires new nurses, not only the most popular unit.", credential: "Pass the licensing exam and keep your clinical hours, immunizations and certifications current.", target: "Choose a first unit for the training it gives you; specialty moves are easier after the first year." },
    targets: ["Hospital new-graduate residency programs", "Long-term care and rehabilitation facilities", "Community health centers and clinics", "Home health and public-health agencies"],
    credentials: ["The national licensing exam, and your state board's application for licensure by examination.", "Basic and advanced life-support certifications that employers expect.", "Clinical references from preceptors who watched you work."],
    who: ["Nurse recruiters and nurse managers at the employers near you", "Recent graduates of your program now on units", "Your clinical instructors and preceptors"],
    asks: ["What did your unit look for in new graduates?", "What was your first year like, and what helped?", "Which settings in this area hire new nurses?"],
    verify: ["Your state's current licensing steps and fees", "Which employers have open new-graduate cohorts and their deadlines", "Current pay at named employers"], local: true },
  { id: "trades", label: "skilled trades", detect: /electrician|electrical technolog|electrical (?:trade|work|apprentice)|lineman|plumb|pipefitter|apprentice|journeyman|\bIBEW\b|weld(?:er|ing)|hvac|carpent|machinist|diesel mechanic|\bskilled trades?\b/i,
    short: { now: "right now the realistic move is a registered apprenticeship or a contractor who will train you and log your hours", later: "journeyman status comes first, then specialty work, foreman roles or your own license and business, in that order", act: "find the apprenticeship programs near you, check their entry requirements and aptitude test, and call one to ask when they next take applicants" },
    cycle: [
      "Now: apply to registered apprenticeship programs and contractors who train, since the application windows are limited and aptitude tests come first.",
      "Through the apprenticeship: classroom hours and logged on-the-job hours accumulate toward the journeyman license.",
      "After the apprenticeship: sit the licensing exam, then choose between employee, foreman and contractor routes."],
    odds: "Apprentice seats can have waitlists and limited application windows, and the earlier you apply and the more reliable your record, the better your odds; a contractor who will train you is a second door when a program is full.",
    queries: [
      { q: "electrician apprenticeship requirements how to apply and licensing {geo}", kinds: ["eligibility", "credential", "program"] },
      { q: "union and non-union electrical apprenticeship programs {geo}", kinds: ["program", "employer", "timeline"] },
      { q: "Bureau of Labor Statistics electricians pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "state electrical licensing journeyman exam requirements hours {geo}", kinds: ["credential", "eligibility"] }],
    now: "The realistic move now is to get into a registered apprenticeship or a contractor who will train and log your hours; reliability and a clean start are what you control.",
    later: "Journeyman status comes first, then specialty work, foreman and supervisory roles, or your own license and business, in order as your hours and exams accumulate.",
    slots: { foundation: "Get the prerequisites apprenticeship programs screen on: basic algebra, a driver's license, and the ability to pass their aptitude test and drug screen.", experience: "Apply to registered apprenticeships and to contractors who train, and keep a log of every hour and task.", credential: "Complete the classroom hours and pass your state's licensing exams in sequence.", target: "Move toward the specialty you want, such as commercial, industrial, controls or line work, as you gain hours." },
    targets: ["Joint apprenticeship programs run with unions", "Open-shop contractor apprenticeships", "Utility and line-work programs", "Maintenance departments at large facilities"],
    credentials: ["A registered apprenticeship, with your hours and classroom work documented.", "The licensing exams your state sets, taken in order as hours accumulate.", "Safety training that sites require before you step on them."],
    who: ["Journeymen and foremen at contractors near you", "Apprenticeship coordinators and training-center staff", "Instructors at the community college electrical program"],
    asks: ["What does your program look for in applicants?", "What was the hardest part of the first year?", "Which contractors here take on new apprentices?"],
    verify: ["Current application windows, aptitude test dates and pay scales of local programs", "Your state's exact hours and exam requirements", "Whether local union halls are taking applications now"], local: true },
  { id: "teaching", label: "teaching", detect: /\bteach(?:er|ing)\b|\bclassroom\b|education degree/i,
    short: { now: "right now hiring depends on your subject, your certification status and the district, so the realistic move is to confirm what your state requires", later: "experience, added endorsements and a master's degree widen options into leadership, curriculum and specialist roles", act: "look up your state education department's certification pathways and which exams your subject requires" },
    cycle: [
      "Now: confirm your state's certification route and which subjects have shortages.",
      "During preparation: student teaching or a residency, the licensing exams, and school or district applications that often open in the spring.",
      "First years: a provisional or initial license, a mentor, and the path to the full license."],
    odds: "Your odds depend more on subject and certification than on anything on a resume. Ask your state education department and nearby districts which subjects they list as shortage areas, and weigh that when you choose endorsements.",
    queries: [
      { q: "teacher certification requirements and alternative routes {geo}", kinds: ["credential", "eligibility", "program"] },
      { q: "school district teacher hiring timeline {geo}", kinds: ["timeline", "employer"] },
      { q: "Bureau of Labor Statistics high school teachers pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "teacher shortage subject areas high-need {geo}", kinds: ["outlook", "program"] }],
    now: "Hiring depends on your subject, your certification status and the district; realistic now is to confirm what certification your state requires and to apply where shortage subjects make hiring easier.",
    later: "Experience, added endorsements and a master's degree widen options into leadership, curriculum and specialist roles.",
    slots: { foundation: "Check your state education department's certification pathways and which exams are required.", experience: "Substitute, tutor or assist in a classroom to build references and learn how a district works.", credential: "Complete the preparation program or alternative route your state allows and pass the required exams.", target: "Apply to districts in the hiring season, and consider high-need subjects and schools." },
    targets: ["Public school districts", "Charter and independent schools", "Alternative-route certification programs", "Tutoring and after-school programs"],
    credentials: ["A state teaching license through a preparation program or an alternative route.", "Subject-area exams your state requires.", "Classroom references from a mentor teacher or supervisor."],
    who: ["Principals and department heads in nearby districts", "Teachers in the subject you want", "Faculty in your certification program"],
    asks: ["What does your school look for in a new teacher?", "Which subjects are hardest to fill here?", "How did you move through certification?"],
    verify: ["Your state's current certification requirements and exam names", "District hiring calendars and openings", "Current pay scales by district"], local: true },
  { id: "pm_ops", label: "project management", detect: /project manag|program manag|operations (?:manag|role|analyst)|\bpmp\b|scrum|business ops/i,
    short: { now: "right now the work is to translate what you have run into delivery language: scope, budget, people and result", later: "a recognized credential and a quantified delivery record open program management and operations leadership", act: "write down one thing you ran in concrete terms: scope, budget, people, schedule and result" },
    cycle: [
      "Now: translate what you have already run into delivery language and list the scope, team and result of each project.",
      "Next few months: apply for coordinator, project manager and program manager roles that match your scale, and consider a credential only if listings ask for it.",
      "Later: move from projects to programs and portfolios as you take on budget and people."],
    odds: "Experience you can show with results beats any credential; a formal credential helps most as a screen for roles that ask for it, and I have no sourced hiring-rate figure.",
    queries: [
      { q: "project manager hiring outlook and typical requirements {stage} {geo}", kinds: ["outlook", "eligibility", "timeline"] },
      { q: "project management certification PMP eligibility requirements", kinds: ["credential", "eligibility"] },
      { q: "Bureau of Labor Statistics project management specialists pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "employers hiring project coordinators operations {geo} programs for career changers and veterans", kinds: ["employer", "program"] }],
    now: "Realistic now is to translate what you have run into delivery language (scope, budget, people, schedule, result) and target roles that match your scale, such as coordinator, project manager or program manager.",
    later: "A recognized credential, a quantified delivery record and sector depth open program management, portfolio and operations leadership roles.",
    slots: { foundation: "Write your delivery record in concrete terms: scope, budget, people, schedule, result.", experience: "Take on or volunteer for a project you can finish and measure, or apply to coordinator and project manager roles in a sector you know.", credential: "Check what the main certification body requires for eligibility before paying for any course.", target: "Target sectors where your domain knowledge counts, and use alumni or former colleagues for introductions." },
    targets: ["Project coordinator and project manager roles in your own industry", "Operations and program management teams", "Government and contractor program offices", "Construction, healthcare and logistics project teams"],
    credentials: ["A delivery portfolio: three projects, each with scope, constraints and result.", "The main project management certification, once you meet its eligibility rules.", "Fluency in a planning and tracking tool used in your sector."],
    who: ["Project and program managers in your sector", "Former colleagues who now hire", "Professional chapter members of the project management association"],
    asks: ["How is my experience read by hiring managers in your area?", "Which credential, if any, do you actually screen on?", "Which sectors need people with my background?"],
    verify: ["Current eligibility rules and fees for any certification", "Which employers are hiring now", "Current pay in your region"] },
  { id: "eng", label: "engineering", detect: /mechanical|civil|electrical engineer|chemical engineer|\bengineering\b|aerospace|\bECE\b/i,
    short: { now: "right now the realistic move is to secure your degree path and land a co-op or internship that recruiters fill from your major", later: "after the degree, an early-career technical role and, where your discipline uses it, the licensure track lead to senior roles", act: "get a written degree plan from your advisor and ask which co-op or internship seats recruiters fill from your major" },
    cycle: [
      "Now: secure the transfer or degree path and its credit rules in writing.",
      "First terms: join the engineering society, find a faculty research seat or a hands-on project, and ask the cooperative education office when internship recruiting starts.",
      "Junior year: the main internship and co-op recruiting; the internship usually becomes the return offer.",
      "Senior year: full-time recruiting and the licensing exams that apply to your branch."],
    odds: "Your chances rise with the degree, an internship or co-op and strong core courses; the discipline and location you choose shape the list, so check openings for both.",
    queries: [
      { q: "community college to four-year engineering transfer pathways {geo}", kinds: ["program", "eligibility", "timeline"] },
      { q: "engineering internships and co-op programs for transfer students {geo}", kinds: ["employer", "program", "timeline"] },
      { q: "Bureau of Labor Statistics engineers pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "engineer in training FE exam professional engineer licensure steps", kinds: ["credential", "eligibility"] }],
    now: "The realistic move now is to secure the transfer path and its credit rules, then use the first semester at the new school to go after the cooperative education or internship seats your major's recruiters offer.",
    later: "After the degree, an early-career rotation or technical role and, where your discipline uses it, the licensure track lead into senior engineering and project leadership.",
    slots: { foundation: "Get a written transfer plan from your target school's advisor, listing which courses transfer.", experience: "Join the discipline's student chapter and look for co-op, lab or internship seats; these are usually posted through the career center.", credential: "Plan the fundamentals exam for the end of your degree if your discipline pursues licensure.", target: "Apply to internships in the hiring cycle your target school's recruiters use, and keep a project portfolio." },
    targets: ["Manufacturers and industrial employers", "Civil and infrastructure consultancies and public agencies", "Utilities and energy companies", "Research labs and defense contractors"],
    credentials: ["The degree itself, through a transfer pathway with documented credit transfer.", "The fundamentals-of-engineering exam, taken near graduation where your discipline licenses.", "Hands-on projects: a design team, lab work or a capstone with a measurable result."],
    who: ["Transfer students a year ahead of you at your target school", "Engineers at employers near campus", "Student chapter officers and faculty advisors"],
    asks: ["How did you land your first internship as a transfer student?", "Which courses mattered most for interviews?", "What would you do in your first semester?"],
    verify: ["Whether each of your courses transfers", "Recruiting calendars at specific employers", "Current pay for internships and entry roles"] },
  { id: "lnd", label: "instructional design and corporate training", detect: /instructional design|corporate (?:training|learning)|learning (?:and|&) development|\bL&D\b|training specialist/i,
    short: { now: "right now the realistic goal is a portfolio of a few learning samples, which is what you can show", later: "after a first training or design role, you can aim at senior designer and learning-and-development management roles", act: "turn one piece of work you have done into a short learning sample with an objective, an activity and an assessment" },
    cycle: [
      "Now: turn classroom work into design language and start two or three samples.",
      "Next few months: finish a portfolio of samples with measured outcomes and learn one authoring tool.",
      "Then: apply to training, onboarding and curriculum roles in companies, healthcare, higher education and government."],
    odds: "Teachers are a credible source of designers. Samples are what you control: a portfolio and a clear outcome story raise your chances; I have no sourced hiring-rate figure.",
    queries: [
      { q: "instructional designer entry requirements and career changers from teaching {geo}", kinds: ["eligibility", "credential", "timeline"] },
      { q: "instructional design and training roles employers hiring former teachers", kinds: ["employer", "program"] },
      { q: "Bureau of Labor Statistics training and development specialists instructional coordinators pay and outlook", kinds: ["pay", "outlook"] },
      { q: "instructional design portfolio authoring tools expected", kinds: ["credential"] }],
    now: "Teachers are a common, credible source of instructional designers; realistic now is a portfolio of two or three learning samples, each with an objective, since a portfolio is what you can show.",
    later: "After a first training or design role, you can aim at senior designer, learning-experience, and learning-and-development management roles.",
    slots: { foundation: "Translate classroom work into design language: needs, objectives, assessment, outcome.", experience: "Build two or three samples, such as a short course, a job aid and an assessment, and offer to build one for a nonprofit or small business.", credential: "Learn one authoring tool and the common design models; add a certificate only if listings you want ask for it.", target: "Apply to training, onboarding and curriculum roles in companies, healthcare, higher education and government." },
    targets: ["Corporate training and onboarding teams", "Higher-education instructional design offices", "Healthcare and government training units", "Education-technology companies"],
    credentials: ["A portfolio of two or three samples, each with the audience, objective and result.", "One authoring tool and the common design models.", "Evidence of measuring learning: an assessment and what the data showed."],
    who: ["Instructional designers who came from teaching", "Training managers in the sector you want", "Members of the local learning and development association chapter"],
    asks: ["What did your first design role require?", "Which sample in my portfolio would you drop or improve?", "Which employers hire former teachers?"],
    verify: ["Current openings and pay", "Whether listings you want require a certificate", "Employer-specific tool requirements"] },
];
export const fieldById = (id: string): Field | undefined => FIELDS.find((f) => f.id === id);

// Terms general-knowledge lines may use besides plain words: acronyms for credentials, visa statuses and places. Not employers,
// not programs. (The guard checks every capitalized word in a general-knowledge line against this list.)
export const GK_TERMS = new Set(["us", "u.s.", "uk", "f-1", "cpt", "opt", "stem", "dso", "mba", "nclex", "rn", "pmp", "sql", "fe", "pe", "ibew", "gpa", "ats", "ai", "ok", "pdf", "hr", "rfp"]);

// Overlays: what changes when the person says more. Each is general knowledge and applies to every field.
export interface Overlay { id: string; detect: RegExp; lead?: string; read: string; stage?: string; network?: string; verify?: string }
// The person is in school age themselves ("I'm a junior in high school", "I'm 16", "11th grade"), not asking about a high school job.
export const HS_SELF_SRC = String.raw`\b(?:i'?m|i am|im|currently|going into|starting)\b[^.?!]{0,40}\b(?:in\s+|a\s+)?(?:high[- ]?school(?!\s+(?:teacher|counselor|coach|principal|science|math|english|history|art|music|band|football|basketball))|high[- ]?schooler|(?:9th|10th|11th|12th|ninth|tenth|eleventh|twelfth) grade)|\b(?:in|finishing|entering)\s+(?:high school|(?:9th|10th|11th|12th) grade)\b|\bi'?m (?:1[3-8])\b|\b(?:1[3-8])[- ]?(?:year[- ]old|yo|y\/o)\b`;
export const HS_SELF = new RegExp(HS_SELF_SRC, "i");
export const OVERLAYS: Overlay[] = [
  { id: "veteran", detect: /\bveteran\b|\bex-?military\b|\bmilitary service\b|\bmilitary (?:background|spouse)\b|\b(?:separating|separated|left|leaving|retired|retiring|discharged|getting out) (?:from |of )?the (?:army|navy|air force|marines?|marine corps|coast guard|military|national guard|space force)\b/i,
    lead: "Your service counts once translated into civilian terms.",
    read: "Your service is real experience: leadership, logistics, discipline and often technical training. The task is translation, since civilian hiring managers do not read military titles.",
    stage: "Have the military's own transition office or your school's veteran services review a plain-language version of your duties before you apply anywhere.",
    network: "Ask other veterans in the field for introductions; veteran networks tend to answer.", verify: "Which benefits and credit-for-training rules apply to you; ask the veteran services office rather than a forum" },
  { id: "intl", detect: /\bF-?1\b|\binternational student\b|\bstudent visa\b|\bOPT\b|\bCPT\b/i,
    lead: "Confirm work authorization with your school's international office first.",
    read: "Work authorization narrows who can hire you and when, so it shapes the list of employers before anything else does.",
    stage: "Before you accept any work, confirm with your school's international student office (DSO) how F-1 work authorization such as CPT and OPT applies to that job.",
    network: "Ask each contact whether their employer has hired international students before.", verify: "Which employers will sponsor and your exact work authorization dates; your DSO is the source" },
  { id: "older", detect: /\bi'?m (?:[456]\d)\b|\b(?:[456]\d)[- ]?(?:year[- ]old|yo|y\/o)\b|\bin my (?:40s|50s|60s)\b|\bage (?:[456]\d)\b/i,
    lead: "Your experience is the asset; make it current.",
    read: "Experience is your asset, and the work is making it current and easy to read: recent results first, tools you use now, and a clear story about the role you want next.",
    stage: "Update the top third of your resume and your public profile so recent, relevant results lead and the tools you use now are named.",
    network: "Former colleagues and managers are your strongest introductions; reach back out with a specific ask." },
  { id: "high_school", detect: HS_SELF,
    lead: "At your age, exploring the job comes first.",
    read: "You have the longest runway of anyone asking this, so the right work now is exploring and building a base: courses, a school or community program in the field, and seeing the job up close. A full-time job in the field is not the target yet.",
    stage: "Talk to your school counselor about the courses and any dual-enrollment or technical programs for this field, and ask one person who does the job whether you can shadow them for a day.",
    network: "Teachers, your counselor, family friends and local employers can introduce you to someone in the field; ask for a fifteen-minute chat about what the job is really like.",
    verify: "Age limits, work permits and program rules near you; your school counselor is the source" },
  { id: "returner", detect: /\breturning to work\b|\bback to work\b|\bre-?enter(?:ing)? the (?:workforce|job market)\b|\bcareer break\b|\bstay-?at-?home\b|\bafter (?:raising|caring for)\b/i,
    lead: "A career break is easy to explain in one honest line.",
    read: "A career break is common and easy to explain in one honest line; what employers want to see is current skills and a clear target role, so the plan leads with both.",
    stage: "Write the one-line story of your break and your target role, then refresh one current skill with a short course or project you can show.",
    network: "Former colleagues, managers and people from volunteering or community work are warm contacts; reconnect with a specific question rather than a request for a job.",
    verify: "Whether the employers you target run returner programs; check each one's careers page" },
  { id: "displaced", detect: /laid off|layoff|let go|downsiz|redundan|lost my job|fired/i,
    lead: "Protect finances and benefits first, then search on a weekly schedule.",
    read: "A layoff is a business decision, not a verdict on you; the search has two clocks, your finances and your pipeline, and both need attention in the first weeks.",
    stage: "In the first days, collect your separation paperwork and check your benefits and unemployment steps with your state's official sites.",
    verify: "Severance, benefits and unemployment rules for your state and employer; use official sources" },
  { id: "first_gen", detect: /first[- ]gen|first in my family|no one in my family|nobody in my family/i,
    read: "You may not have an inherited network, so the plan builds one on purpose, starting with people your school already gives you access to.",
    network: "Start with your career center, professors' office hours and alumni lists; a short, specific message is enough." },
  { id: "cc", detect: /community college/i,
    lead: "Get transfer-credit rules in writing first.",
    read: "A community college start is a normal route; the details that matter are credit transfer and getting the same access to recruiters that four-year students get.",
    stage: "Ask your advisor for the transfer-credit rules in writing before you register for the next term." },
  { id: "bootcamp", detect: /boot ?camp/i,
    read: "A bootcamp gives you a start, not a track record, so what employers see is the work you can show beyond the course.",
    stage: "Replace group-project work in your portfolio with something you built and own end to end." },
];

// Any field the catalog does not name. The ten above are seed hints (they add field-specific method); this is the same
// pipeline for everything else: the label comes from the person's own question (derive.ts), the substance from the search.
// The general-knowledge lines are method that is true of any occupation, and say so; they carry no field facts.
export function genericField(label: string, local = false): Field {
  return {
    id: "other" as FieldId, label, detect: /(?!)/, local,
    queries: [
      { q: "how to become a {field} entry requirements and training {stage} {geo}", kinds: ["eligibility", "credential", "timeline"] },
      { q: "{field} employers and entry-level training programs hiring {geo}", kinds: ["employer", "program"] },
      { q: "Bureau of Labor Statistics O*NET {field} pay and job outlook", kinds: ["pay", "outlook"] },
      { q: "{field} license or certification required how to get it {geo}", kinds: ["credential", "eligibility"] }],
    cycle: ["Now: learn the occupation's entry requirements from an official or industry source and write down which ones you already meet.", "Next few months: get close to the real work through a placement, trainee role, volunteering or the supervised hours the occupation requires.", "Then: apply to the employers the sources list, starting with those that train new entrants, and work toward the credential employers screen on."],
    odds: "Your odds are set by the entry requirement and by local conditions, which the sources should show; where no source gave a hiring rate I give none, and the first useful step is to learn what the training route requires.",
    short: { now: "right now what is realistic is set by this occupation's own entry requirements, so learn them and meet the first one", later: "once you meet the entry requirement and hold a first role or placement, the credentials the industry body describes come next", act: "find the official description of the occupation and its training route, and write down which entry requirements you already meet" },
    now: "What you can realistically do now is set by this occupation's own entry requirements, so the first job is to learn exactly what they are from an official or industry source and to meet the first one.",
    later: "Once you meet the entry requirement and have a first role or placement, the next rungs are the specializations, credentials and senior roles the occupation's own industry body describes.",
    slots: { foundation: "Find the official description of the occupation, its entry requirements and its usual training route, and write down which ones you already meet.", experience: "Get close to the real work: shadow someone, volunteer, take an assistant or trainee role, or complete the supervised hours the occupation requires.", credential: "Find out which license, certification or degree employers actually screen on, and who grants it, before you pay for any course.", target: "Apply to the employer categories the sources list, starting with those that train new people." },
    targets: ["Employers that hire and train new entrants", "Training programs, schools and apprenticeships the field's industry body lists", "Public-sector and nonprofit employers in the field", "Small and local employers that hire through personal introductions"],
    credentials: ["The entry requirement: ask the field's industry body or licensing board what it is, and read the official page rather than a course seller's summary.", "Hands-on evidence: supervised hours, a placement, a portfolio or work samples, whichever this occupation uses.", "Any license or certification: confirm who grants it, what it costs and how long it takes before committing."],
    who: ["People currently doing the job, found through your school, a local employer or the industry body", "Instructors and program coordinators in the training route", "Recruiters or managers who hire for the role"],
    asks: ["How did you get your first role, and what would you do differently?", "What do employers here actually screen on?", "What should I have finished before I apply?"],
    verify: ["Your state or country's current entry requirements and fees", "Which employers are hiring and their deadlines", "Current pay in your area"],
  };
}

// Fixed phrases general-knowledge lines use that contain a number word but state no fact (the outreach structure the owner set).
export const GK_PHRASES = ["fifteen-minute", "fifteen minute", "three-statement"];
