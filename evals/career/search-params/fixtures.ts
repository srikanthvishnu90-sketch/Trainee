// Fixture postings for the search-parameter eval. Everything a stated parameter can constrain is recorded as ground truth
// in `meta` (never shown to the code under test): the code reads only the posting text, exactly as production does.
// All employers and postings are invented test data (no real posting, no live fetch).
export type Fam = "swe" | "data" | "ml" | "pm" | "nurse" | "finance" | "design" | "marketing" | "dataeng";
export type Band = "intern" | "new_grad" | "junior" | "mid" | "senior";
export interface Meta {
  title: string; fam: Fam; band: Band; country: "us" | "ca" | "uk" | "de"; city: string; remote: "remote" | "hybrid" | "onsite";
  payHr?: number; payYr?: number; payYrMax?: number; sponsors?: "yes" | "no"; term?: string; company: string;
}
export interface Fx { id: string; company: string; title: string; location: string; text: string; ageDays: number; meta: Meta }

const SPONSOR_NO = " We are unable to sponsor work visas for this role.";
const SPONSOR_YES = " We sponsor visas for qualified candidates.";
let n = 0;
function p(company: string, title: string, location: string, text: string, m: Omit<Meta, "company" | "title">, ageDays = 3 + (n % 9)): Fx {
  n++;
  const sp = m.sponsors === "no" ? SPONSOR_NO : m.sponsors === "yes" ? SPONSOR_YES : "";
  const nums = [...text.matchAll(/\$(\d{2,3},\d{3})/g)].map((x) => Number(x[1].replace(",", "")));
  if (m.payYr && nums.length) m = { ...m, payYrMax: Math.max(...nums) };
  return { id: `greenhouse:${company.toLowerCase().replace(/\W+/g, "")}:${1000 + n}`, company, title, location, text: text + sp, ageDays, meta: { ...m, company, title } };
}
const I = (extra: Partial<Meta>): Omit<Meta, "company" | "title"> => ({ fam: "swe", band: "intern", country: "us", city: "", remote: "onsite", ...extra });

export const FIXTURES: Fx[] = [
  // software engineering interns
  p("Stripe", "Software Engineer Intern", "Chicago, IL", "Summer 2027 internship on payments infrastructure. Pay: $55/hour. Build services in Java and Go with a mentor.", I({ city: "chicago", term: "summer 2027", payHr: 55 })),
  p("Datadog", "Software Engineer Intern", "New York, NY", "Summer 2027 internship. Compensation $48/hour. Work on the metrics pipeline in Go.", I({ city: "new york", term: "summer 2027", payHr: 48 })),
  p("Acmeworks", "Software Engineering Intern - Summer 2026", "Chicago, IL", "Summer 2026 internship. $40/hour. Python and React.", I({ city: "chicago", term: "summer 2026", payHr: 40 })),
  p("Braze", "Software Engineer Intern, Summer 2027", "Remote - US", "Remote summer 2027 internship, US only. $44/hour. Ruby and TypeScript.", I({ city: "", remote: "remote", term: "summer 2027", payHr: 44 })),
  p("Cloudflare", "Software Engineering Intern (Fall 2027)", "Austin, TX", "Fall 2027 internship. Rust and Go on the edge network. $46/hour.", I({ city: "austin", term: "fall 2027", payHr: 46 })),
  p("Ramp", "Software Engineer Intern", "San Francisco, CA", "Summer 2027 internship building product for finance teams. $52/hour.", I({ city: "san francisco", term: "summer 2027", payHr: 52 })),
  p("Stripe", "Software Engineer Intern", "Toronto, ON, Canada", "Summer 2027 internship in Toronto. CAD 38/hour.", I({ country: "ca", city: "toronto", term: "summer 2027" })),
  p("Siemer", "Software Engineer Intern", "Berlin, Germany", "Summer 2027 internship, Berlin office. Kotlin and Postgres.", I({ country: "de", city: "berlin", term: "summer 2027" })),
  p("Lumen Labs", "Software Engineer Intern", "Chicago, IL", "Summer 2027 internship. Unpaid stipend of $18/hour. Learn Python.", I({ city: "chicago", term: "summer 2027", payHr: 18 })),
  p("Northpoint", "Software Engineering Intern", "Chicago, IL", "Summer 2027 internship. Hybrid, three days in our Loop office. $36/hour.", I({ city: "chicago", remote: "hybrid", term: "summer 2027", payHr: 36 })),
  p("Helix", "Machine Learning Intern, Summer 2027", "Remote - US", "Remote ML internship, summer 2027. PyTorch. $50/hour.", I({ fam: "ml", remote: "remote", term: "summer 2027", payHr: 50 })),
  p("Helix", "Data Science Intern, Summer 2027", "Chicago, IL", "Summer 2027 data science internship. SQL, Python. $42/hour.", I({ fam: "data", city: "chicago", term: "summer 2027", payHr: 42 })),
  p("Orbit", "Product Manager Intern - Summer 2027", "New York, NY", "Summer 2027 product internship. $45/hour.", I({ fam: "pm", city: "new york", term: "summer 2027", payHr: 45 })),
  p("Orbit", "Software Engineer Intern - Fall 2027", "Austin, TX", "Fall 2027 internship, Austin office. $41/hour.", I({ city: "austin", term: "fall 2027", payHr: 41 })),
  p("Goldwater", "Investment Banking Summer Analyst 2027", "New York, NY", "Summer 2027 analyst programme in New York. Base $110,000 annualized.", I({ fam: "finance", city: "new york", term: "summer 2027", payYr: 110000 })),
  p("Goldwater", "Investment Banking Summer Analyst 2027", "London, UK", "Summer 2027 analyst programme in London.", I({ fam: "finance", country: "uk", city: "london", term: "summer 2027" })),
  p("Pixel & Co", "Data Analyst Intern", "Chicago, IL", "Summer 2027 internship, SQL and Tableau. $26/hour.", I({ fam: "data", city: "chicago", term: "summer 2027", payHr: 26 })),
  // new grad / junior backend
  p("Mercury Pay", "Backend Engineer, New Grad", "Remote - US", "New grad backend role, remote within the US. $130,000 - $150,000 USD per year. Python and Postgres." , { fam: "swe", band: "new_grad", country: "us", city: "", remote: "remote", payYr: 130000, sponsors: "no" }),
  p("Notion Labs", "Software Engineer, New Grad 2027", "San Francisco, CA", "New grad software engineer, class of 2027. $140,000 - $165,000 per year.", { fam: "swe", band: "new_grad", country: "us", city: "san francisco", remote: "onsite", payYr: 140000, sponsors: "yes" }),
  p("Plaidly", "Backend Software Engineer (New Grad)", "New York, NY", "New grad backend engineer, services in Go. $135,000 - $155,000 per year.", { fam: "swe", band: "new_grad", country: "us", city: "new york", remote: "onsite", payYr: 135000, sponsors: "no" }),
  p("Twillow", "Software Engineer I - Backend", "Denver, CO", "Early career backend engineer, 0-2 years. $120,000 - $140,000 per year.", { fam: "swe", band: "junior", country: "us", city: "denver", remote: "onsite", payYr: 120000, sponsors: "yes" }),
  p("Twillow", "Senior Backend Engineer", "Remote - US", "8+ years building distributed systems. $190,000 - $230,000 per year.", { fam: "swe", band: "senior", country: "us", city: "", remote: "remote", payYr: 190000 }),
  p("Kestrel", "Backend Engineer", "Remote - US", "Remote backend engineer, 3+ years. $150,000 - $175,000 per year.", { fam: "swe", band: "mid", country: "us", city: "", remote: "remote", payYr: 150000 }),
  p("Kestrel", "Backend Engineer", "Remote - US", "Remote backend engineer, startup, 2+ years. $105,000 - $125,000 per year.", { fam: "swe", band: "mid", country: "us", city: "", remote: "remote", payYr: 105000 }),
  p("Fernhill", "Software Engineer, New Grad", "Seattle, WA", "New grad SWE. $145,000 per year. Visa sponsorship available.", { fam: "swe", band: "new_grad", country: "us", city: "seattle", remote: "onsite", payYr: 145000, sponsors: "yes" }),
  p("Fernhill", "Senior Software Engineer", "Seattle, WA", "Senior SWE. $200,000 - $240,000 per year.", { fam: "swe", band: "senior", country: "us", city: "seattle", remote: "onsite", payYr: 200000 }),
  p("Fernhill", "Software Engineer II", "Seattle, WA", "Mid-level SWE, 3+ years. $160,000 - $185,000 per year.", { fam: "swe", band: "mid", country: "us", city: "seattle", remote: "onsite", payYr: 160000 }),
  // Stripe and others, mid level
  p("Stripe", "Software Engineer, Payments", "Seattle, WA", "3+ years of experience. $170,000 - $230,000 per year.", { fam: "swe", band: "mid", country: "us", city: "seattle", remote: "onsite", payYr: 170000 }),
  p("Stripe", "Backend Engineer", "Remote - US", "Remote, US only. $165,000 - $210,000 per year.", { fam: "swe", band: "mid", country: "us", city: "", remote: "remote", payYr: 165000 }),
  p("Stripe", "Software Engineer", "Toronto, ON, Canada", "Toronto office, 2+ years. CAD 140,000 - 170,000 per year.", { fam: "swe", band: "mid", country: "ca", city: "toronto", remote: "onsite" }),
  p("Stripe", "Senior Software Engineer", "Chicago, IL", "Senior engineer, Chicago. $185,000 - $250,000 per year.", { fam: "swe", band: "senior", country: "us", city: "chicago", remote: "onsite", payYr: 185000 }),
  p("Kintsugi", "Senior Software Engineer", "Chicago, IL", "6+ years. $175,000 - $210,000 per year.", { fam: "swe", band: "senior", country: "us", city: "chicago", remote: "onsite", payYr: 175000 }),
  p("Kintsugi", "Software Engineer", "Chicago, IL", "2+ years of experience. $125,000 - $150,000 per year.", { fam: "swe", band: "mid", country: "us", city: "chicago", remote: "onsite", payYr: 125000 }),
  p("Siemer", "Software Engineer", "Berlin, Germany", "Berlin office, 3+ years. Kotlin.", { fam: "swe", band: "mid", country: "de", city: "berlin", remote: "onsite" }),
  p("Siemer", "Software Engineer (Remote - Germany)", "Remote - Germany", "Remote within Germany only.", { fam: "swe", band: "mid", country: "de", city: "", remote: "remote" }),
  // data analysts
  p("Quanta", "Data Analyst", "Remote - US", "Remote data analyst. $34/hour. SQL and Looker.", { fam: "data", band: "mid", country: "us", city: "", remote: "remote", payHr: 34 }),
  p("Quanta", "Data Analyst", "Remote - US", "Remote data analyst, part of support ops. $22/hour. Excel and SQL.", { fam: "data", band: "mid", country: "us", city: "", remote: "remote", payHr: 22 }),
  p("Meridian Health", "Data Analyst", "Chicago, IL", "Onsite in Chicago. $95,000 - $115,000 per year. SQL and Tableau.", { fam: "data", band: "mid", country: "us", city: "chicago", remote: "onsite", payYr: 95000 }),
  p("Meridian Health", "Senior Data Analyst", "Chicago, IL", "Senior analyst. $130,000 - $150,000 per year.", { fam: "data", band: "senior", country: "us", city: "chicago", remote: "onsite", payYr: 130000 }),
  p("Tamesis", "Data Analyst", "London, UK", "Hybrid, London. GBP 45,000 - 55,000 per year.", { fam: "data", band: "mid", country: "uk", city: "london", remote: "hybrid" }),
  p("Tamesis", "Junior Data Analyst", "Remote - Canada", "Remote within Canada. CAD 60,000 per year.", { fam: "data", band: "junior", country: "ca", city: "", remote: "remote" }),
  p("Tamesis", "Junior Data Analyst", "Chicago, IL", "Entry level, 0-2 years. $70,000 - $80,000 per year.", { fam: "data", band: "junior", country: "us", city: "chicago", remote: "onsite", payYr: 70000 }),
  p("Quanta", "Data Engineer", "Remote - US", "Remote data engineer. $150,000 per year. Spark.", { fam: "dataeng", band: "mid", country: "us", city: "", remote: "remote", payYr: 150000 }),
  p("Pixel & Co", "Marketing Analyst", "Chicago, IL", "Campaign reporting. $75,000 - $90,000 per year.", { fam: "marketing", band: "mid", country: "us", city: "chicago", remote: "onsite", payYr: 75000 }),
  p("Birchwood Bank", "Credit Risk Analyst", "Chicago, IL", "Credit risk. $85,000 - $100,000 per year.", { fam: "finance", band: "mid", country: "us", city: "chicago", remote: "onsite", payYr: 85000 }),
  p("Birchwood Bank", "Financial Analyst", "New York, NY", "FP&A. $90,000 - $105,000 per year.", { fam: "finance", band: "mid", country: "us", city: "new york", remote: "onsite", payYr: 90000 }),
  // nursing and others
  p("Lakeshore Hospital", "Registered Nurse", "Chicago, IL", "Med-surg RN. $44/hour.", { fam: "nurse", band: "mid", country: "us", city: "chicago", remote: "onsite", payHr: 44 }),
  p("Lakeshore Hospital", "Registered Nurse", "Chicago, IL", "Float pool RN. $36/hour.", { fam: "nurse", band: "mid", country: "us", city: "chicago", remote: "onsite", payHr: 36 }),
  p("Lakeshore Hospital", "Registered Nurse", "Evanston, IL", "Outpatient RN. $41/hour.", { fam: "nurse", band: "mid", country: "us", city: "evanston", remote: "onsite", payHr: 41 }),
  p("Studio Nine", "Product Designer", "Remote - US", "Remote product designer. $120,000 per year.", { fam: "design", band: "mid", country: "us", city: "", remote: "remote", payYr: 120000 }),
  p("Orbit", "Product Manager", "New York, NY", "3+ years of PM experience. $150,000 per year.", { fam: "pm", band: "mid", country: "us", city: "new york", remote: "onsite", payYr: 150000 }),
  p("Helix", "Machine Learning Engineer", "Remote - US", "Remote ML engineer. $170,000 per year.", { fam: "ml", band: "mid", country: "us", city: "", remote: "remote", payYr: 170000 }),
  p("Helix", "Machine Learning Engineer, New Grad", "San Francisco, CA", "New grad ML engineer. $150,000 per year. We sponsor visas.", { fam: "ml", band: "new_grad", country: "us", city: "san francisco", remote: "onsite", payYr: 150000, sponsors: "yes" }),
  p("Ramp", "Software Engineer, New Grad", "San Francisco, CA", "New grad SWE. $155,000 per year.", { fam: "swe", band: "new_grad", country: "us", city: "san francisco", remote: "onsite", payYr: 155000, sponsors: "no" }),
  p("Cloudflare", "Software Engineer", "Austin, TX", "2+ years. $130,000 - $155,000 per year.", { fam: "swe", band: "mid", country: "us", city: "austin", remote: "onsite", payYr: 130000 }),
  p("Cloudflare", "Software Engineering Intern (Summer 2027)", "Austin, TX", "Summer 2027 internship in Austin. $47/hour.", I({ city: "austin", term: "summer 2027", payHr: 47 })),
];
