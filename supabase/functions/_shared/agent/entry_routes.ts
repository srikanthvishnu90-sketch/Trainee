// S3 r12 (architect ruling on the empty-search fix): what an empty job search can offer instead of postings. EMPTY_SEARCH_NOTE asks
// the brain, when someone asks where to start in a new field, to "name two to four roles they could get hired into first"; the reply
// pipeline (#849) keeps only sentences that rest on evidence, so those roles must be evidence the search result itself gives. These
// are code's suggestions: authored general career knowledge about where people commonly start (the same kind, and for the shared
// fields the same roles, as packages/domain/144-career-guidance.js FIELD_ENTRY), never postings, employers, figures or fit verdicts.
// A field is matched from the person's words and the search's words; one the table does not hold gives nothing.
export interface EntryRoutes { field: string; roles: string[] }

const FIELDS: { re: RegExp; field: string; roles: string[] }[] = [
  // (dev H034: "im a cashier wanna do something w computers")
  { re: /\b(?:computers?|tech|it support|help ?desk|tech support|technical support|desktop support)\b/i, field: "computer and IT work",
    roles: ["IT support or help desk technician", "technical or customer support at a software company", "data entry or records clerk", "QA tester"] },
  { re: /\b(?:data analysis|data analytics|data analyst|analytics|business intelligence)\b/i, field: "data analysis", roles: ["data analyst", "business analyst", "reporting analyst"] },
  { re: /\b(?:marketing|social media|content marketing)\b/i, field: "marketing", roles: ["marketing coordinator", "social media or content coordinator", "marketing analyst"] },
  { re: /\b(?:hr|human resources|recruiting|people operations)\b/i, field: "HR", roles: ["HR coordinator", "recruiting coordinator", "people operations assistant"] },
  { re: /\b(?:software|coding|programming|web development)\b/i, field: "software", roles: ["junior software engineer", "QA or test engineer", "technical support engineer"] },
  { re: /\b(?:project management|project manager)\b/i, field: "project management", roles: ["project coordinator", "operations coordinator", "program assistant"] },
  { re: /\b(?:healthcare administration|medical office)\b/i, field: "healthcare administration", roles: ["patient services coordinator", "medical office assistant", "healthcare administration assistant"] },
];

// The entry routes for the fields the person's words (and the search's) name, at most two fields.
export function entryRoutesFor(...texts: string[]): EntryRoutes[] {
  const t = texts.map((x) => String(x ?? "")).join(" \n ");
  return FIELDS.filter((f) => f.re.test(t)).slice(0, 2).map(({ field, roles }) => ({ field, roles: [...roles] }));
}
