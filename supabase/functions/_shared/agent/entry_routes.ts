// S3 r12 (architect ruling on the empty-search fix): what an empty job search can offer instead of postings. EMPTY_SEARCH_NOTE asks
// the brain, when someone asks where to start in a new field, to "name two to four roles they could get hired into first"; the reply
// pipeline (#849) keeps only sentences that rest on evidence, so those roles must be evidence the search result itself gives. These
// are code's suggestions: authored general career knowledge about where people commonly start (the same kind, and for the shared
// fields the same roles, as packages/domain/144-career-guidance.js FIELD_ENTRY), never postings, employers, figures or fit verdicts.
// A field is matched from the person's words and the search's words; one the table does not hold gives nothing.
// D-100 (architect ruling, 2026-11-21, S3 r12e): `uses` is what work in the field commonly involves: tool or skill classes, each with
// at most two common examples. General career knowledge only: never a posting, an employer, a figure, pay or anything about the
// person. It rides the search's suggestion unit (reply_pipeline.ts Ledger.fromToolResult) so the role half of a sentence that maps
// what the person said to the field has a unit the judge reads (the D-100 pair).
export interface EntryRoutes { field: string; roles: string[]; uses: string }

const FIELDS: { re: RegExp; field: string; roles: string[]; uses: string }[] = [
  // (dev H034: "im a cashier wanna do something w computers")
  { re: /\b(?:computers?|tech|it support|help ?desk|tech support|technical support|desktop support)\b/i, field: "computer and IT work",
    roles: ["IT support or help desk technician", "technical or customer support at a software company", "data entry or records clerk", "QA tester"],
    uses: "troubleshooting hardware and software, a ticketing system (such as Jira or ServiceNow), an operating system (such as Windows or macOS), and explaining fixes to users" },
  { re: /\b(?:data analysis|data analytics|data analyst|analytics|business intelligence)\b/i, field: "data analysis", roles: ["data analyst", "business analyst", "reporting analyst"],
    uses: "a database query language, a spreadsheet (such as Excel or Google Sheets), a BI or dashboard tool (such as Tableau or Power BI), and recurring reporting" },
  { re: /\b(?:marketing|social media|content marketing)\b/i, field: "marketing", roles: ["marketing coordinator", "social media or content coordinator", "marketing analyst"],
    uses: "a social media or content platform (such as Instagram or LinkedIn), a web analytics tool (such as Google Analytics), copywriting, and campaign reporting" },
  { re: /\b(?:hr|human resources|recruiting|people operations)\b/i, field: "HR", roles: ["HR coordinator", "recruiting coordinator", "people operations assistant"],
    uses: "an HR or applicant tracking system (such as Workday or Greenhouse), interview scheduling and coordination, a spreadsheet (such as Excel), and confidential record keeping" },
  { re: /\b(?:software|coding|programming|web development)\b/i, field: "software", roles: ["junior software engineer", "QA or test engineer", "technical support engineer"],
    uses: "a programming language (such as Python or JavaScript), version control (such as Git), testing, and debugging" },
  { re: /\b(?:project management|project manager)\b/i, field: "project management", roles: ["project coordinator", "operations coordinator", "program assistant"],
    uses: "a project tracking tool (such as Jira or Asana), a spreadsheet (such as Excel), scheduling, and status reporting" },
  { re: /\b(?:healthcare administration|medical office)\b/i, field: "healthcare administration", roles: ["patient services coordinator", "medical office assistant", "healthcare administration assistant"],
    uses: "scheduling and patient intake, an electronic health record system (such as Epic or Cerner), insurance and billing basics, and a spreadsheet (such as Excel)" },
];

// The entry routes for the fields the person's words (and the search's) name, at most two fields.
export function entryRoutesFor(...texts: string[]): EntryRoutes[] {
  const t = texts.map((x) => String(x ?? "")).join(" \n ");
  return FIELDS.filter((f) => f.re.test(t)).slice(0, 2).map(({ field, roles, uses }) => ({ field, roles: [...roles], uses }));
}
