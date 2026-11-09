// R10 (owner order 2026-11-09), WO-I: the observed baseline, as data. The five user turns are quoted exactly from
// docs/architect/specs/APP-LAYER-15-FIXES.md A.2 (resume T1-T3, search S1-S2). Shared by the in-process acceptance suite
// (tests/architect/pending/r10-app-layer/) and the post-deploy live replay (scripts/launch/r10-live-replay.ts), so both send
// the same words. Nothing here is personal data: the intake below is a synthetic person shaped like the audit's (spec A.4:
// an AI M&A internship, a private-equity internship with Python screening work over 100+ targets, two founder roles, a test
// score, two GPA values that disagree, skills, certifications and interests; no email, no phone, no LinkedIn).

export const SCENARIOS = {
  resume: [
    { id: "T1", text: "Can you turn the resume I uploaded into a clean one-page PDF for data analyst internships? Keep the facts as written, don't add experience, and send me the actual PDF." },
    { id: "T2", text: "The role is a data analyst internship, like I said. Please tailor the resume for that and generate the one-page PDF. If a fact needs my confirmation, ask me the specific question rather than adding anything." },
    { id: "T3", text: "That's the wrong role. I asked for a data analyst internship, not a machine learning manager job at Reddit. Please fix the target and send a download link for the PDF too, since the attachment isn't opening here. Don't apply to anything." },
  ],
  search: [
    { id: "S1", text: "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet." },
    { id: "S2", text: "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements." },
  ],
} as const;
export const BASELINE = { scenarios: 2, turns: 5 } as const;

// What Trainee said on production after release 9 (spec A.2), one marker per observed failure. A reply that still carries
// one of these is the observed failure again.
export const OBSERVED_FAILURES: Record<string, RegExp[]> = {
  T1: [/There is no document file on this conversation/i, /Name the role \(or paste the posting\)/i],
  T2: [/Machine Learning Engineering Manager/i, /\breddit\b/i, /Picked first from the \d+ roles/i, /parse check/i, /Same as your base resume/i],
  T3: [/haven't started that batch/i, /runner for that kind of ask/i, /apply to the top 10/i],
  S1: [/^\s*Nothing was invented to fill the list\.[^\n]*Widen the role or the place[^\n]*$/im],
  S2: [/The window, checked against the record/i, /2026-10-13/, /Tell me what you'd like to do next/i, /resets at midnight UTC/i],
};

// The synthetic intake (the earlier resume, uploaded as a PDF in the earlier conversation; its file is no longer available).
export const INTAKE_NAME = "Jordan Rivera";
export const INTAKE_RESUME = `Jordan Rivera
Chicago, IL (Lincoln Park)

Education
Lakeshore University, B.S. Economics
SAT: 1520
GPA: 3.6
Cumulative GPA 3.8
Involvement: Investment Club, Data Science Society

Experience
Halcyon Advisory, AI M&A Intern, June 2025 - August 2025
- Researched 40 AI software companies for acquisition screens
- Summarized deal comparables in weekly memos for the deal team
- Tracked target pipeline status in a shared Excel model
Granite Peak Partners, Private Equity Intern, January 2025 - May 2025
- Built a Python screening workflow that combined company, revenue and contact data in one sheet across 100+ targets
- Cleaned and joined three data sources with pandas before each screen
- Presented screening results to two partners every Friday
Rivera Tutoring, Founder, 2023 - present
- Started a peer tutoring service for high school math
- Scheduled 12 tutors across two schools
- Handled invoicing and bookkeeping in Google Sheets
CourtSide Stats, Founder, 2022 - 2024
- Built a basketball stats tracker for a youth league
- Wrote SQL queries to rank players by season
- Grew the tracker to 6 teams

Skills: Python, SQL, Excel, pandas, Tableau
Certifications: Bloomberg Market Concepts, Google Data Analytics Certificate
Interests: Coding, Golf, Chess`;

// The earlier search's list (the "old job list"): five machine-learning roles, the first of which tailoring picked on
// production (spec A.2 T2). Public company name, invented ids; the links answer only inside the suite's fetch double.
export const OLD_LIST = [
  { job: "greenhouse:reddit:7001", company: "reddit", title: "Ads Conversion Modeling, Machine Learning Engineering Manager", location: "San Francisco, CA", url: "https://boards.greenhouse.io/reddit/jobs/7001", description: "Lead the ads conversion modeling team. Requirements: Machine Learning, Python, 8+ years managing engineers." },
  { job: "greenhouse:reddit:7002", company: "reddit", title: "Senior Machine Learning Engineer, Ads Ranking", location: "New York, NY", url: "https://boards.greenhouse.io/reddit/jobs/7002", description: "Requirements: Machine Learning, Python, SQL, 5+ years." },
  { job: "lever:northwindml:7003", company: "Northwind ML", title: "Machine Learning Engineer", location: "Chicago, IL", url: "https://jobs.lever.co/northwindml/7003", description: "Requirements: Python, Machine Learning, PyTorch." },
  { job: "greenhouse:quantaml:7004", company: "Quanta ML", title: "Machine Learning Engineer II", location: "Remote - US", url: "https://boards.greenhouse.io/quantaml/jobs/7004", description: "Requirements: Python, SQL, Machine Learning." },
  { job: "lever:vectorworks:7005", company: "Vectorworks AI", title: "Applied Machine Learning Engineer", location: "Austin, TX", url: "https://jobs.lever.co/vectorworks/7005", description: "Requirements: Python, Machine Learning, Docker." },
] as const;
export const OLD_SEARCH = "find me machine learning engineer jobs";

// The market the in-process replay searches (fictional employers from spec B.6). open: the employer page answers and names the
// role; closed: the page is gone (the posting row is still live, so only an open-check can tell); stale: the row itself is closed.
export type Seeded = { job: string; company: string; title: string; location: string; url: string; description: string; page: "open" | "closed" | "blocked" | "stale"; s1: boolean; s2: boolean };
export const MARKET: Seeded[] = [
  { job: "greenhouse:lakefronttest:8001", company: "Lakefront Transit Analytics", title: "Data Analyst Intern", location: "Chicago, IL", url: "https://boards.greenhouse.io/lakefronttest/jobs/8001", description: "Summer 2027 internship, onsite Tuesdays and Thursdays. Open to students graduating December 2027 or May 2028. Python and SQL.", page: "open", s1: true, s2: true },
  { job: "greenhouse:northlinetest:8002", company: "Northline Health Data", title: "Data Analyst Intern, Summer 2027", location: "Evanston, IL", url: "https://boards.greenhouse.io/northlinetest/jobs/8002", description: "Internship for current undergraduates. Excel, SQL, Tableau.", page: "open", s1: true, s2: true },
  { job: "lever:prairieledgertest:8003", company: "Prairie Ledger", title: "Data Analytics Intern", location: "Chicago, IL (Hybrid)", url: "https://jobs.lever.co/prairieledgertest/8003", description: "Hybrid internship. Must be enrolled in a bachelor's program. SQL and Python.", page: "open", s1: true, s2: true },
  { job: "greenhouse:examplecarbontest:8004", company: "Example Carbon Co", title: "Data Analyst Intern", location: "Chicago, IL", url: "https://boards.greenhouse.io/examplecarbontest/jobs/8004", description: "Data analyst internship. SQL.", page: "closed", s1: false, s2: false },
  { job: "greenhouse:oldharbortest:8005", company: "Old Harbor Freight", title: "Data Analyst Intern", location: "Chicago, IL", url: "https://boards.greenhouse.io/oldharbortest/jobs/8005", description: "Summer 2026 internship.", page: "stale", s1: false, s2: false },
  { job: "greenhouse:lakefronttest:8006", company: "Lakefront Transit Analytics", title: "Senior Data Analyst", location: "Chicago, IL", url: "https://boards.greenhouse.io/lakefronttest/jobs/8006", description: "5+ years of analytics experience.", page: "open", s1: false, s2: false },
  { job: "lever:riverlinetest:8007", company: "Riverline Logistics", title: "Business Analyst Intern", location: "Chicago, IL", url: "https://jobs.lever.co/riverlinetest/8007", description: "Business analyst internship. Students graduating in 2028. Excel and SQL.", page: "open", s1: false, s2: true },
  { job: "greenhouse:harborviewtest:8008", company: "Harborview Insurance", title: "Analytics Intern (Remote, US)", location: "Remote - US", url: "https://boards.greenhouse.io/harborviewtest/jobs/8008", description: "Remote US internship. Applicants must graduate between December 2027 and June 2028. SQL, Python.", page: "open", s1: false, s2: true },
  { job: "lever:maplecresttest:8009", company: "Maplecrest Data", title: "Analytics Intern", location: "Toronto, ON", url: "https://jobs.lever.co/maplecresttest/8009", description: "Canada only.", page: "open", s1: false, s2: false },
  { job: "greenhouse:westloopbanktest:8010", company: "West Loop Bank", title: "Business Analytics Intern", location: "Chicago, IL", url: "https://boards.greenhouse.io/westloopbanktest/jobs/8010", description: "Business analytics internship.", page: "blocked", s1: false, s2: false },
];
