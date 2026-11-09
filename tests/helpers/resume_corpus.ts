// RELEASE 10: a deterministic corpus of varied synthetic resumes (TEST people only) for the template checks: short and long,
// long titles and company names, non-ASCII names, 0-4 jobs, students without experience, career changers, two-page seniors.
// Each item is the submission resume shape career_tailor.ts renders (header + sections of entry / bullet / line), plus the
// fields a round trip must bring back (name, email, phone, each entry's text and dates, each bullet).
// deno-lint-ignore-file no-explicit-any
export interface CorpusItem { id: string; shape: string; doc: any; expect: { name: string; email: string; phone: string; entries: { text: string; dates: string | null }[]; bullets: string[] } }

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const NAMES = ["Alex Testcase", "José Álvarez-Núñez", "Zoë Brontë", "Søren Østergaard", "François Ngô", "Priya Ramanathan-Venkatesan", "Li Wei", "Mary-Kate O'Connor", "Björn Ångström", "Chidi Okafor", "Ana Lúcia Gonçalves", "Sam Lee", "Maximiliane von Hohenzollern-Sigmaringen", "Noël Dupré", "Jordan Kim"];
const CITIES = ["Chicago, IL", "Austin, TX", "New York, NY", "Seattle, WA", "Remote", "Toronto, ON", "Washington, DC"];
const TITLES = ["Data Analyst", "Software Engineer", "Senior Principal Staff Software Engineer, Infrastructure Reliability and Developer Productivity", "Product Designer", "Account Executive", "Research Assistant", "Financial Analyst", "Marketing Coordinator", "Operations Manager", "Program Analyst", "Director of Engineering", "Teaching Assistant", "Barista"];
const COMPANIES = ["Acme Corp (TEST)", "Northwind Traders (TEST)", "Contoso Bank (TEST)", "The International Consortium for Interdisciplinary Applied Research and Development (TEST)", "Fabrikam (TEST)", "Globex Ltd (TEST)", "State University (TEST)", "Initech (TEST)"];
const VERBS = ["Built", "Led", "Cut", "Designed", "Wrote", "Ran", "Shipped", "Grew", "Automated", "Trained", "Negotiated", "Analyzed"];
const OBJECTS = ["the weekly sales dashboard", "a churn model in Python", "onboarding for 40 new hires", "the quarterly close process", "a React component library", "pricing experiments across three regions", "the customer research program", "a SQL data pipeline feeding finance", "vendor contracts worth $2.4M", "a survey of 3,000 households"];
const TAILS = ["", " used by 12 teams every week", ", cutting report time from six hours to forty minutes", " and presented the results to the leadership team each quarter, which set the next year's budget", " (Python, SQL, dbt)", ", lifting conversion 18% over two quarters while keeping the cost per lead flat across every paid channel we ran"];
const YEARS = (r: () => number, i: number) => {
  const end = 2026 - i * 2 - Math.floor(r() * 2), start = end - 1 - Math.floor(r() * 3);
  const fmt = r() < 0.5 ? (y: number) => `${y}` : (y: number) => `${["Jan", "Mar", "Jun", "Sep", "Nov"][Math.floor(r() * 5)]} ${y}`;
  return i === 0 && r() < 0.5 ? `${fmt(start)}–Present` : `${fmt(start)}–${fmt(end)}`;
};
function bullet(r: () => number) { return `${VERBS[Math.floor(r() * VERBS.length)]} ${OBJECTS[Math.floor(r() * OBJECTS.length)]}${TAILS[Math.floor(r() * TAILS.length)]}`; }

const SHAPES = ["student", "early", "mid", "career_change", "senior_two_page", "short", "long_titles"] as const;
export function corpus(n = 63, seed = 20261108): CorpusItem[] {
  const out: CorpusItem[] = [];
  for (let k = 0; k < n; k++) {
    const r = rng(seed + k * 7919), shape = SHAPES[k % SHAPES.length];
    const name = NAMES[k % NAMES.length];
    const handle = name.normalize("NFD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
    const email = `${handle}@example.test`, phone = `(555) 01${String(k % 100).padStart(2, "0")}-${String(1000 + k * 37).slice(-4)}`;
    const contactLine = `${email} | ${phone} | ${CITIES[k % CITIES.length]}`;
    const linksLine = r() < 0.6 ? `linkedin.com/in/${handle.replace(/\./g, "-")}-test${r() < 0.5 ? ` | github.com/${handle.replace(/\./g, "")}` : ""}` : undefined;
    const jobs = shape === "student" ? 0 : shape === "short" ? 1 : shape === "senior_two_page" ? 4 : shape === "long_titles" ? 2 + Math.floor(r() * 2) : 1 + Math.floor(r() * 4);
    const perJob = shape === "senior_two_page" ? 6 : shape === "short" ? 2 : 2 + Math.floor(r() * 3);
    const entries: { text: string; dates: string | null }[] = [], bullets: string[] = [];
    const exp: any[] = [], used = new Set<string>();
    // A line belongs in one place (148's parse-check refuses a repeated line): every bullet is new in its resume.
    const fresh = () => { for (let t = 0; t < 50; t++) { const b = bullet(r); if (!used.has(b)) { used.add(b); return b; } } throw new Error("corpus: no fresh bullet"); };
    for (let i = 0; i < jobs; i++) {
      // A role is listed once: a title at a company never repeats in one resume.
      let title = "", company = "";
      for (let t = 0; t < 50 && (!title || used.has(`${title}|${company}`)); t++) {
        title = shape === "long_titles" && t === 0 ? TITLES[2] : TITLES[Math.floor(r() * TITLES.length)];
        company = shape === "long_titles" ? COMPANIES[3] : COMPANIES[Math.floor(r() * COMPANIES.length)];
      }
      used.add(`${title}|${company}`);
      const dates = YEARS(r, i), text = `${title}, ${company},`;
      exp.push({ type: "entry", text: `${text} ${dates}` }); entries.push({ text, dates });
      for (let b = 0; b < perJob; b++) { const t = fresh(); exp.push({ type: "bullet", text: t }); bullets.push(t); }
    }
    const eduDates = String(2026 - Math.floor(r() * 12));
    const eduText = `${["BS Statistics", "BA Economics", "MS Computer Science", "BFA Design", "PhD Molecular Biology"][k % 5]}, State University (TEST),`;
    const edu: any[] = [{ type: "entry", text: `${eduText} ${eduDates}` }]; entries.push({ text: eduText, dates: eduDates });
    if (shape === "student") { const t = "Dean's List; coursework in statistics, econometrics and machine learning"; edu.push({ type: "bullet", text: t }); bullets.push(t); }
    const sections: any[] = [];
    if (shape === "career_change" || shape === "senior_two_page" || r() < 0.3) sections.push({ heading: "Summary", lines: [{ type: "line", text: shape === "career_change" ? "Former teacher moving into data analysis, with two years of SQL and Python projects and a certificate in analytics." : "Leader with a record of shipping products and building teams across finance and technology." }] });
    if (exp.length) sections.push({ heading: "Experience", lines: exp });
    if (shape === "student" || shape === "career_change" || r() < 0.4) {
      const pj: any[] = [];
      for (let p = 0; p < (shape === "student" ? 3 : 2); p++) {
        const text = `${["Churn Predictor", "Budget Tracker App", "Transit Delay Study", "Portfolio Site"][(k + p) % 4]} (TEST),`, dates = String(2024 + (p % 2));
        pj.push({ type: "entry", text: `${text} ${dates}` }); entries.push({ text, dates });
        const t = fresh(); pj.push({ type: "bullet", text: t }); bullets.push(t);
      }
      sections.push({ heading: "Projects", lines: pj });
    }
    sections.push({ heading: "Education", lines: edu });
    if (shape === "student") { const text = "Treasurer, Data Science Club (TEST),", dates = "2024–2025"; sections.push({ heading: "Leadership", lines: [{ type: "entry", text: `${text} ${dates}` }, { type: "bullet", text: "Ran a $12,000 budget for 30 events" }] }); entries.push({ text, dates }); bullets.push("Ran a $12,000 budget for 30 events"); }
    if (shape === "senior_two_page") sections.push({ heading: "Certifications", lines: [{ type: "line", text: "PMP; AWS Certified Solutions Architect" }] });
    sections.push({ heading: "Skills", lines: [{ type: "line", text: ["SQL, Python, Tableau, Excel", "TypeScript, React, Node.js, PostgreSQL, AWS, Docker, Kubernetes, Terraform, Go", "Figma, user research, prototyping", "Salesforce, HubSpot, negotiation"][k % 4] }] });
    const doc = { header: { name, contactLine, ...(linksLine ? { linksLine } : {}) }, sections, lines: sections.flatMap((s) => s.lines.map((l: any) => ({ ...l, section: s.heading }))) };
    out.push({ id: `C${String(k + 1).padStart(2, "0")}`, shape, doc, expect: { name, email, phone, entries, bullets } });
  }
  return out;
}
