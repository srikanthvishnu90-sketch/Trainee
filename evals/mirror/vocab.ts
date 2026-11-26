// MIRROR-1000 entity vocabulary (architect builder, 2026-11-11). The slot values build.ts fills into prompts, and the words
// distinct.ts strips to read a prompt's skeleton (its shape with every entity removed), so two prompts that differ only in
// these words read as the same skeleton. People are fictional; email domains are example.test or .invalid; phone numbers are
// 555 numbers. Companies are well-known public employers (research and search only need a name the agent can look up) or
// the fictional employers of the test fixtures (Lakefront Transit Analytics, Prairie Ledger, Northline Health Data, Contoso).

export const ROLES = [
  "data analyst", "business analyst", "product analyst", "financial analyst", "marketing coordinator", "software engineer",
  "UX designer", "data scientist", "product manager", "operations analyst", "supply chain analyst", "investment banking analyst",
  "consultant", "research assistant", "QA engineer", "machine learning engineer", "sales development rep", "content writer",
  "HR coordinator", "nurse", "mechanical engineer", "civil engineer", "accountant", "graphic designer", "teacher",
  "paralegal", "lab technician", "social media manager", "customer success manager", "frontend developer", "backend developer",
  "data engineer", "security analyst", "actuarial analyst", "policy analyst", "biostatistician", "growth marketer",
  "project coordinator", "technical writer", "devops engineer",
];
export const CITIES = [
  "Chicago", "Austin", "Seattle", "New York", "Boston", "Denver", "Atlanta", "San Francisco", "Los Angeles", "Minneapolis",
  "Pittsburgh", "Phoenix", "Raleigh", "Columbus", "Detroit", "Miami", "Nashville", "Portland", "San Diego", "Philadelphia",
  "Salt Lake City", "Dallas", "Houston", "Madison", "Ann Arbor", "Charlotte", "St. Louis", "Kansas City", "Baltimore", "Cleveland",
  "Toronto", "London", "Berlin", "Bangalore", "Singapore", "Dublin", "Boise", "Omaha", "Tampa", "Sacramento",
];
export const COMPANIES = [
  "Stripe", "Datadog", "Snowflake", "Target", "Deloitte", "Mayo Clinic", "Capital One", "Spotify", "Airbnb", "Salesforce",
  "Nike", "Boeing", "McKinsey", "Goldman Sachs", "JPMorgan", "Microsoft", "Google", "Amazon", "Netflix", "Adobe",
  "Shopify", "Figma", "Notion", "Duolingo", "Pfizer", "Kaiser Permanente", "Ford", "Tesla", "Walmart", "Costco",
  "IBM", "Intel", "Nvidia", "Uber", "Lyft", "DoorDash", "Robinhood", "Plaid", "Coinbase", "HubSpot",
  "Lakefront Transit Analytics", "Prairie Ledger", "Northline Health Data", "Contoso",
];
// Fictional people (recruiters, alumni, managers, referrers). No real person is named anywhere in the set.
export const PEOPLE = [
  "Maya Okafor", "Jordan Reyes", "Priya Natarajan", "Sam Whitfield", "Lena Kowalski", "Diego Marin", "Aisha Bello", "Tom Achterberg",
  "Grace Lindqvist", "Omar Haddad", "Wen Liu", "Rosa Delgado", "Ethan Brooks", "Nia Campbell", "Felix Ober", "Hana Sato",
  "Leo Ferreira", "Zoe Abernathy", "Kofi Mensah", "Ines Duarte", "Marcus Vale", "Tara Quinn", "Yusuf Demir", "Elena Petrova",
];
export const FIRST_NAMES = PEOPLE.map((p) => p.split(" ")[0]);
export const SCHOOLS = ["TEST State University", "Lakeshore College", "Ridgeview University", "Bellows College", "Northbrook Institute", "Cedar Valley University"];
export const MAJORS = ["statistics", "economics", "computer science", "finance", "marketing", "mechanical engineering", "nursing", "psychology", "biology", "political science", "accounting", "information systems"];
export const LEVELS = ["internship", "new grad", "entry-level", "junior", "mid-level", "senior", "co-op", "part-time", "contract", "fellowship", "apprenticeship"];
export const TERMS = ["summer 2027", "fall 2027", "spring 2027", "January 2027", "next summer", "this winter"];
export const INDUSTRIES = ["fintech", "healthcare", "climate", "edtech", "gaming", "biotech", "logistics", "media", "retail", "government", "nonprofit", "aerospace", "insurance", "energy"];
export const SKILLS = ["SQL", "Python", "Tableau", "Excel", "R", "Figma", "Java", "React", "Power BI", "Salesforce", "Looker", "AWS", "Spark", "dbt", "Go"];
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Every entity phrase, longest first (so "San Francisco" is stripped before "San").
export const ENTITY_PHRASES: string[] = [...new Set([...ROLES, ...CITIES, ...COMPANIES, ...PEOPLE, ...FIRST_NAMES, ...SCHOOLS, ...MAJORS, ...LEVELS, ...TERMS,
  ...INDUSTRIES, ...SKILLS, ...WEEKDAYS, ...MONTHS].map((s) => s.toLowerCase()))].sort((a, b) => b.length - a.length);
