// Resume loop profiles (agent2/resumes, 2026-11-09): synthetic people, every one marked TEST, none a real person. Each is a
// resume as a person would paste it (the same plain-text shape as packages/career-data/fixtures/test-resume.txt), the
// name, email and city they would confirm, and the roles they target. Varied on purpose: a student, a career changer, a
// senior with a long record, a sparse profile, a long history, a non-ASCII name, a nurse, a federal applicant, a designer.
export interface LoopProfile { id: string; shape: string; name: string; email: string; location: string; text: string; targets: { role: string; posting: string }[] }

const posting = (title: string, co: string, req: string[]) => `${title}, ${co} (TEST posting)\nRequirements:\n${req.map((r) => `- ${r}`).join("\n")}`;

export const PROFILES: LoopProfile[] = [
  {
    id: "p01", shape: "student, analytics", name: "Riley Fixture", email: "riley.fixture@example.test", location: "Chicago, IL",
    text: `Riley Fixture (TEST)
Chicago, IL | riley.fixture@example.test | +1 555-0101

EDUCATION
TEST State University - B.S. Statistics, graduating May 2027
- Coursework: Regression, Databases, Data Visualization

EXPERIENCE
Data Intern, TEST Transit Office, June 2025 - August 2025
- Built a Python screening workflow that combined company and contact data for 120 targets
- Wrote SQL queries behind 3 weekly dashboards

PROJECTS
Ridership Dashboard (TEST project)
- Built a Tableau dashboard of bus ridership for 14 routes

SKILLS
Python, SQL, Tableau, Excel`,
    targets: [
      { role: "Data Analyst Intern", posting: posting("Data Analyst Intern", "Lakefront Transit Analytics", ["SQL and Python", "Dashboards in Tableau"]) },
      { role: "Business Analyst Intern", posting: posting("Business Analyst Intern", "Prairie Ledger", ["Excel and SQL", "Stakeholder reporting"]) },
      { role: "Analytics Intern", posting: posting("Analytics Intern", "Northline Health Data", ["SQL", "Data visualization"]) },
    ],
  },
  {
    id: "p02", shape: "career changer, teacher to product", name: "Morgan Sample", email: "morgan.sample@example.test", location: "Denver, CO",
    text: `Morgan Sample (TEST)
Denver, CO | morgan.sample@example.test

EXPERIENCE
Math Teacher, TEST Middle School, August 2016 - June 2024
- Designed a grading rubric adopted by 6 teachers
- Ran a tutoring program for 40 students each term

Product Operations Associate, TEST Learning Co, July 2024 - Present
- Collected feedback from 30 teachers and wrote 12 feature requests

EDUCATION
TEST College - B.A. Mathematics, 2016

SKILLS
Jira, Excel, User Interviews, SQL`,
    targets: [
      { role: "Associate Product Manager", posting: posting("Associate Product Manager", "TEST Edtech", ["User research", "Writing requirements in Jira"]) },
      { role: "Product Analyst", posting: posting("Product Analyst", "TEST Learning Labs", ["SQL", "Excel"]) },
      { role: "Customer Success Manager", posting: posting("Customer Success Manager", "TEST SaaS", ["Working with teachers and schools", "Excel"]) },
    ],
  },
  {
    id: "p03", shape: "senior engineer, long record", name: "Jordan Fixturely", email: "jordan.fixturely@example.test", location: "Seattle, WA",
    text: `Jordan Fixturely (TEST)
Seattle, WA | jordan.fixturely@example.test

EXPERIENCE
Staff Software Engineer, TEST Cloud Corp, March 2019 - Present
- Led a team of 7 engineers that rebuilt the billing service in Go
- Cut p99 latency of the billing API from 900 ms to 180 ms

Senior Software Engineer, TEST Payments Inc, January 2014 - February 2019
- Built the fraud scoring pipeline in Java that scored 2 million events a day
- Mentored 5 junior engineers

Software Engineer, TEST Retail Systems, June 2009 - December 2013
- Wrote the inventory sync service in Python for 300 stores

EDUCATION
TEST Institute of Technology - B.S. Computer Science, 2009

SKILLS
Go, Java, Python, Kubernetes, PostgreSQL, Kafka`,
    targets: [
      { role: "Principal Software Engineer", posting: posting("Principal Software Engineer", "TEST Fintech", ["Go and Kubernetes", "Leading engineering teams"]) },
      { role: "Engineering Manager", posting: posting("Engineering Manager", "TEST Platform Co", ["Managing engineers", "Java services"]) },
      { role: "Senior Backend Engineer", posting: posting("Senior Backend Engineer", "TEST Streaming", ["Kafka", "PostgreSQL"]) },
    ],
  },
  {
    id: "p04", shape: "sparse facts", name: "Casey Stub", email: "casey.stub@example.test", location: "Austin, TX",
    text: `Casey Stub (TEST)
Austin, TX | casey.stub@example.test

EXPERIENCE
Barista, TEST Coffee, May 2023 - Present
- Trained 4 new staff

EDUCATION
TEST Community College - A.A. General Studies, 2023`,
    targets: [
      { role: "Shift Supervisor", posting: posting("Shift Supervisor", "TEST Cafe Group", ["Training staff", "Customer service"]) },
      { role: "Retail Associate", posting: posting("Retail Associate", "TEST Outfitters", ["Customer service"]) },
      { role: "Office Assistant", posting: posting("Office Assistant", "TEST Property Co", ["Scheduling", "Microsoft Office"]) },
    ],
  },
  {
    id: "p05", shape: "long history, many roles", name: "Taylor Mock", email: "taylor.mock@example.test", location: "Atlanta, GA",
    text: `Taylor Mock (TEST)
Atlanta, GA | taylor.mock@example.test

EXPERIENCE
Marketing Director, TEST Beverages, January 2020 - Present
- Grew email revenue 35% in two years
- Managed a budget of $2 million

Marketing Manager, TEST Apparel, March 2016 - December 2019
- Launched 4 product lines

Brand Manager, TEST Foods, June 2012 - February 2016
- Ran 20 retail campaigns

Marketing Coordinator, TEST Agency, July 2009 - May 2012
- Coordinated 50 trade-show events

Sales Associate, TEST Department Store, June 2007 - June 2009
- Top seller in 6 quarters

EDUCATION
TEST University - B.B.A. Marketing, 2007

SKILLS
Brand Strategy, Email Marketing, Salesforce, Google Analytics`,
    targets: [
      { role: "VP of Marketing", posting: posting("VP of Marketing", "TEST Consumer Goods", ["Brand strategy", "Budget ownership"]) },
      { role: "Head of Growth", posting: posting("Head of Growth", "TEST DTC", ["Email marketing", "Google Analytics"]) },
      { role: "Senior Brand Manager", posting: posting("Senior Brand Manager", "TEST Snacks", ["Retail campaigns", "Salesforce"]) },
    ],
  },
  {
    id: "p06", shape: "non-ASCII name", name: "Zoë Ñúñez-Øberg", email: "zoe.nunez@example.test", location: "Miami, FL",
    text: `Zoë Ñúñez-Øberg (TEST)
Miami, FL | zoe.nunez@example.test

EDUCATION
TEST Universidad - B.S. Finance, graduating December 2026

EXPERIENCE
Finance Intern, TEST Banco, June 2025 - August 2025
- Reconciled 300 vendor invoices each month
- Built a cash forecast model in Excel

LEADERSHIP
Treasurer, TEST Finance Society, September 2024 - May 2025
- Managed a club budget of $8,000

SKILLS
Excel, Financial Modeling, Spanish, Bloomberg`,
    targets: [
      { role: "Financial Analyst", posting: posting("Financial Analyst", "TEST Capital", ["Excel and financial modeling", "Bilingual Spanish a plus"]) },
      { role: "Investment Banking Analyst", posting: posting("Investment Banking Analyst", "TEST Partners", ["Financial modeling", "Bloomberg"]) },
      { role: "Accounting Associate", posting: posting("Accounting Associate", "TEST Audit Co", ["Invoice reconciliation", "Excel"]) },
    ],
  },
  {
    id: "p07", shape: "nurse, licensed", name: "Avery Example", email: "avery.example@example.test", location: "Columbus, OH",
    text: `Avery Example (TEST)
Columbus, OH | avery.example@example.test

EXPERIENCE
Registered Nurse, TEST General Hospital, July 2019 - Present
- Cared for 5 patients per shift on a 30-bed medical floor
- Precepted 8 new graduate nurses

EDUCATION
TEST University - B.S.N. Nursing, 2019

CERTIFICATIONS
Registered Nurse License, TEST State Board of Nursing, 2019

SKILLS
Patient Care, Epic, Medication Administration`,
    targets: [
      { role: "Charge Nurse", posting: posting("Charge Nurse", "TEST Medical Center", ["RN license", "Precepting new nurses"]) },
      { role: "Clinical Nurse Educator", posting: posting("Clinical Nurse Educator", "TEST Health System", ["Teaching nurses", "Epic"]) },
      { role: "Nurse Case Manager", posting: posting("Nurse Case Manager", "TEST Insurance", ["RN license", "Patient care"]) },
    ],
  },
  {
    id: "p08", shape: "research, graduate student", name: "Sam Testperson", email: "sam.testperson@example.test", location: "Boston, MA",
    text: `Sam Testperson (TEST)
Boston, MA | sam.testperson@example.test

EDUCATION
TEST University - Ph.D. Biology, expected May 2027
TEST College - B.S. Biochemistry, 2020

EXPERIENCE
Graduate Research Assistant, TEST Lab of Cell Biology, September 2020 - Present
- Ran 150 CRISPR screens on cell lines
- Analyzed sequencing data in R

PROJECTS
Gene Expression Atlas (TEST project)
- Built an R Shiny app to browse expression data for 20 tissues

SKILLS
R, Python, CRISPR, Cell Culture`,
    targets: [
      { role: "Research Scientist", posting: posting("Research Scientist", "TEST Biotech", ["CRISPR screening", "R or Python"]) },
      { role: "Computational Biologist", posting: posting("Computational Biologist", "TEST Genomics", ["Sequencing data analysis in R", "Python"]) },
      { role: "Scientist I", posting: posting("Scientist I", "TEST Therapeutics", ["Cell culture", "CRISPR"]) },
    ],
  },
  {
    id: "p09", shape: "designer", name: "Quinn Dummy", email: "quinn.dummy@example.test", location: "Portland, OR",
    text: `Quinn Dummy (TEST)
Portland, OR | quinn.dummy@example.test

EXPERIENCE
Product Designer, TEST Apps Studio, April 2021 - Present
- Redesigned the checkout flow used by 50,000 monthly shoppers
- Ran 24 usability tests

Graphic Designer, TEST Print Shop, June 2018 - March 2021
- Designed 200 posters and menus

EDUCATION
TEST Art Institute - B.F.A. Graphic Design, 2018

SKILLS
Figma, Prototyping, Usability Testing, Illustrator`,
    targets: [
      { role: "Senior Product Designer", posting: posting("Senior Product Designer", "TEST Commerce", ["Figma", "Usability testing"]) },
      { role: "UX Designer", posting: posting("UX Designer", "TEST Travel", ["Prototyping", "Figma"]) },
      { role: "Visual Designer", posting: posting("Visual Designer", "TEST Media", ["Illustrator", "Print design"]) },
    ],
  },
];
