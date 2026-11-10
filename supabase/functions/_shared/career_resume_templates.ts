// RELEASE 10 (owner ask 2026-11-08): the template library. Fifteen original resume layouts, each one built on a structure that
// public evidence supports (docs/architect/specs/RESUME-TEMPLATES.md, a source for every claim): section order, one column,
// header shape, dates flush right on the entry's own line, bullet glyph and hanging indent, margins and type scale. Nothing
// here copies a third-party template's look, text or branding. The designs differ by face, margins, type scale, heading
// treatment, rhythm, header shape, bullet geometry and section order.
//
// Every template is EXACT GEOMETRY (US Letter, points, origin bottom-left as in the PDF):
//   x stops     the left margin (headings, entries, lines), the bullet glyph's x and the bullet text's x (one hanging
//               indent for every bullet and every wrapped bullet line), and the right margin, where every date ends (on
//               the entry's last line when its title wraps).
//   rhythm      one baseline grid per file: unit = half the body leading; every baseline sits a whole number of units
//               below the top margin, and every gap is a whole number of units (fit steps change units, never fractions).
//   type        standard faces only (Helvetica or Times, regular and bold, never embedded: rule R6 of 148's parse-check);
//               body and headings 10-12 pt, the name 14-18 pt (R6 scoped, architect ruling 2026-11-08).
//   fit         the loosest step first, then fewer units of space, then a smaller body (never under 10 pt), one page first
//               and two pages after; a template whose evidence says two pages for its level never squeezes to one.
//   pages       paragraphs never split across pages (no widow, no orphan); a heading or an entry keeps with its next block.
// The words: every printed line is a source line's own text or a split of it at its dates (as career_resume_design.ts),
// with the sections in the template's order; the inline header joins the contact and links lines with " | " (no word).
// Plum (#5C2751) only when the file is Trainee-branded (branded: true); every neutral template is ink only.
import { CareerRender } from "./router_core.career.js";
import { LIGHT, PLUM } from "./brand.ts";
import { ENCODABLE, type Face, METRICS } from "./career_resume_metrics.ts";

export const TEMPLATE_IDS = ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15"] as const;
export type TemplateId = typeof TEMPLATE_IDS[number] | "OWN"; // OWN: the person's own PDF layout, measured (career_resume_rater.ts)
export type Level = "student" | "early" | "mid" | "senior" | "executive";
export type RoleFamily = "general" | "engineering" | "data" | "product_design" | "business_finance" | "sales_marketing" | "research" | "career_change" | "federal";
export type SectionKey = "summary" | "skills" | "experience" | "projects" | "education" | "research" | "publications" | "leadership" | "certifications" | "awards" | "coursework" | "additional";

export interface TemplateSpec {
  id: TemplateId; name: string; for: string; roles: RoleFamily[]; levels: Level[];
  pages: 1 | 2;                      // the length its evidence supports at its levels (2: never squeezed to one)
  face: "sans" | "serif";
  margins: { top: number; right: number; bottom: number; left: number };
  body: number; heading: number; namePt: number; leadRatio: number;
  header: "stack" | "inline";        // stack: name, contact, links on their own lines; inline: contact | links on one line
  nameCase: "as-is" | "upper";
  headingCase: "upper" | "title";
  headingRule: "below" | "above" | "none";
  bullet: { glyph: "•" | "–"; x: number; text: number }; // offsets from the left margin
  gaps: { header: number; section: number; afterHeading: number; entry: number }; // units (half-lines), loosest
  order: SectionKey[];
  evidence: string[];                // E-ids in RESUME-TEMPLATES.md
}

const IN = 72;
// The fifteen. Each `for` says who it suits in plain words; `evidence` names the spec's claims behind its structure.
export type LibraryId = typeof TEMPLATE_IDS[number];
export const TEMPLATES: Record<LibraryId, TemplateSpec> = {
  T01: { id: "T01", name: "Foundation", for: "students and new graduates in any field", roles: ["general"], levels: ["student", "early"], pages: 1, face: "sans",
    margins: { top: 0.75 * IN, right: 0.75 * IN, bottom: 0.75 * IN, left: 0.75 * IN }, body: 10.5, heading: 11, namePt: 16, leadRatio: 1.25,
    header: "stack", nameCase: "upper", headingCase: "upper", headingRule: "below", bullet: { glyph: "•", x: 2, text: 12 },
    gaps: { header: 2, section: 3, afterHeading: 1, entry: 1 }, order: ["education", "experience", "projects", "leadership", "skills", "awards", "coursework"], evidence: ["E1", "E2", "E5", "E6", "E8"] },
  T02: { id: "T02", name: "Campus Serif", for: "students and new graduates applying to traditional employers", roles: ["general", "business_finance"], levels: ["student", "early"], pages: 1, face: "serif",
    margins: { top: 0.7 * IN, right: 0.8 * IN, bottom: 0.7 * IN, left: 0.8 * IN }, body: 11, heading: 11, namePt: 16, leadRatio: 1.2,
    header: "stack", nameCase: "upper", headingCase: "upper", headingRule: "below", bullet: { glyph: "•", x: 0, text: 11 },
    gaps: { header: 2, section: 2, afterHeading: 1, entry: 1 }, order: ["education", "experience", "leadership", "skills", "awards"], evidence: ["E1", "E5", "E6", "E7", "E8"] },
  T03: { id: "T03", name: "Engineer", for: "software and technical roles, early to mid career", roles: ["engineering"], levels: ["student", "early", "mid"], pages: 1, face: "sans",
    margins: { top: 0.6 * IN, right: 0.6 * IN, bottom: 0.6 * IN, left: 0.6 * IN }, body: 10, heading: 11, namePt: 16, leadRatio: 1.3,
    header: "inline", nameCase: "as-is", headingCase: "title", headingRule: "below", bullet: { glyph: "•", x: 4, text: 14 },
    gaps: { header: 2, section: 2, afterHeading: 1, entry: 1 }, order: ["summary", "skills", "experience", "projects", "education", "awards"], evidence: ["E1", "E2", "E14", "E15"] },
  T04: { id: "T04", name: "Engineer Two-Page", for: "senior and staff engineers with a long record", roles: ["engineering"], levels: ["senior", "executive"], pages: 2, face: "sans",
    margins: { top: 0.75 * IN, right: 0.75 * IN, bottom: 0.75 * IN, left: 0.75 * IN }, body: 10.5, heading: 11, namePt: 16, leadRatio: 1.3,
    header: "inline", nameCase: "as-is", headingCase: "title", headingRule: "below", bullet: { glyph: "•", x: 4, text: 14 },
    gaps: { header: 2, section: 3, afterHeading: 1, entry: 2 }, order: ["summary", "experience", "skills", "projects", "education", "certifications"], evidence: ["E1", "E2", "E10", "E14"] },
  T05: { id: "T05", name: "Analyst", for: "data, analytics and quantitative roles", roles: ["data"], levels: ["student", "early", "mid"], pages: 1, face: "sans",
    margins: { top: 0.7 * IN, right: 0.7 * IN, bottom: 0.7 * IN, left: 0.7 * IN }, body: 10.5, heading: 10.5, namePt: 14, leadRatio: 1.25,
    header: "inline", nameCase: "upper", headingCase: "upper", headingRule: "above", bullet: { glyph: "•", x: 0, text: 10 },
    gaps: { header: 2, section: 3, afterHeading: 1, entry: 1 }, order: ["summary", "experience", "projects", "skills", "education", "certifications"], evidence: ["E1", "E2", "E11", "E15"] },
  T06: { id: "T06", name: "Product & Design", for: "product, UX and design roles (portfolio link in the header)", roles: ["product_design"], levels: ["early", "mid", "senior"], pages: 1, face: "sans",
    margins: { top: 0.8 * IN, right: 0.8 * IN, bottom: 0.8 * IN, left: 0.8 * IN }, body: 10.5, heading: 11, namePt: 18, leadRatio: 1.35,
    header: "stack", nameCase: "as-is", headingCase: "title", headingRule: "none", bullet: { glyph: "–", x: 0, text: 11 },
    gaps: { header: 3, section: 3, afterHeading: 1, entry: 2 }, order: ["summary", "experience", "projects", "skills", "education"], evidence: ["E1", "E2", "E16"] },
  T07: { id: "T07", name: "Ledger", for: "finance, banking, consulting and business roles", roles: ["business_finance"], levels: ["early", "mid", "senior"], pages: 1, face: "serif",
    margins: { top: 0.6 * IN, right: 0.6 * IN, bottom: 0.6 * IN, left: 0.6 * IN }, body: 10.5, heading: 10.5, namePt: 14, leadRatio: 1.2,
    header: "inline", nameCase: "upper", headingCase: "upper", headingRule: "below", bullet: { glyph: "•", x: 4, text: 13 },
    gaps: { header: 2, section: 2, afterHeading: 1, entry: 1 }, order: ["experience", "education", "leadership", "skills", "certifications", "additional"], evidence: ["E1", "E5", "E6", "E17"] },
  T08: { id: "T08", name: "Results", for: "sales, marketing and customer-facing roles (results first)", roles: ["sales_marketing"], levels: ["early", "mid", "senior"], pages: 1, face: "sans",
    margins: { top: 0.75 * IN, right: 0.75 * IN, bottom: 0.75 * IN, left: 0.75 * IN }, body: 11, heading: 11, namePt: 16, leadRatio: 1.2,
    header: "inline", nameCase: "as-is", headingCase: "upper", headingRule: "above", bullet: { glyph: "•", x: 2, text: 12 },
    gaps: { header: 2, section: 3, afterHeading: 1, entry: 1 }, order: ["summary", "experience", "skills", "education", "awards"], evidence: ["E1", "E2", "E9"] },
  T09: { id: "T09", name: "Research CV-lite", for: "research, lab and academic-adjacent roles", roles: ["research"], levels: ["student", "early", "mid", "senior"], pages: 2, face: "serif",
    margins: { top: 1 * IN, right: 1 * IN, bottom: 1 * IN, left: 1 * IN }, body: 11, heading: 11, namePt: 14, leadRatio: 1.2,
    header: "stack", nameCase: "as-is", headingCase: "title", headingRule: "below", bullet: { glyph: "•", x: 0, text: 11 },
    gaps: { header: 2, section: 3, afterHeading: 1, entry: 1 }, order: ["education", "research", "publications", "experience", "projects", "awards", "skills"], evidence: ["E5", "E12"] },
  T10: { id: "T10", name: "Bridge", for: "career changers (skills first, then the full dated history)", roles: ["career_change"], levels: ["early", "mid", "senior"], pages: 1, face: "sans",
    margins: { top: 0.75 * IN, right: 0.75 * IN, bottom: 0.75 * IN, left: 0.75 * IN }, body: 10.5, heading: 11, namePt: 16, leadRatio: 1.25,
    header: "stack", nameCase: "as-is", headingCase: "upper", headingRule: "below", bullet: { glyph: "•", x: 2, text: 12 },
    gaps: { header: 2, section: 3, afterHeading: 1, entry: 1 }, order: ["summary", "skills", "projects", "experience", "education", "certifications"], evidence: ["E1", "E2", "E13"] },
  T11: { id: "T11", name: "Executive", for: "directors, VPs and executives (summary at the top, two pages)", roles: ["general", "business_finance"], levels: ["senior", "executive"], pages: 2, face: "serif",
    margins: { top: 1 * IN, right: 1 * IN, bottom: 1 * IN, left: 1 * IN }, body: 11, heading: 12, namePt: 18, leadRatio: 1.25,
    header: "stack", nameCase: "upper", headingCase: "upper", headingRule: "below", bullet: { glyph: "•", x: 0, text: 12 },
    gaps: { header: 3, section: 3, afterHeading: 1, entry: 2 }, order: ["summary", "experience", "education", "certifications", "skills", "awards"], evidence: ["E1", "E10", "E18"] },
  T12: { id: "T12", name: "Federal", for: "US federal applications (two-page limit, full month-year dates)", roles: ["federal"], levels: ["early", "mid", "senior", "executive"], pages: 2, face: "serif",
    margins: { top: 1 * IN, right: 1 * IN, bottom: 1 * IN, left: 1 * IN }, body: 11, heading: 11, namePt: 14, leadRatio: 1.2,
    header: "stack", nameCase: "as-is", headingCase: "upper", headingRule: "none", bullet: { glyph: "•", x: 0, text: 12 },
    gaps: { header: 2, section: 3, afterHeading: 1, entry: 1 }, order: ["summary", "experience", "education", "certifications", "skills", "awards"], evidence: ["E3", "E4", "E19", "E20"] },
  T13: { id: "T13", name: "Compact", for: "mid-career people who need one dense page", roles: ["general"], levels: ["early", "mid"], pages: 1, face: "sans",
    margins: { top: 0.5 * IN, right: 0.5 * IN, bottom: 0.5 * IN, left: 0.5 * IN }, body: 10, heading: 10.5, namePt: 14, leadRatio: 1.2,
    header: "inline", nameCase: "upper", headingCase: "upper", headingRule: "below", bullet: { glyph: "•", x: 2, text: 11 },
    gaps: { header: 2, section: 2, afterHeading: 1, entry: 1 }, order: ["summary", "experience", "skills", "projects", "education"], evidence: ["E1", "E5", "E6"] },
  T14: { id: "T14", name: "Two-Page Classic", for: "experienced generalists with 8+ years", roles: ["general"], levels: ["mid", "senior"], pages: 2, face: "sans",
    margins: { top: 0.9 * IN, right: 0.9 * IN, bottom: 0.9 * IN, left: 0.9 * IN }, body: 11, heading: 11.5, namePt: 16, leadRatio: 1.25,
    header: "stack", nameCase: "as-is", headingCase: "upper", headingRule: "below", bullet: { glyph: "•", x: 2, text: 13 },
    gaps: { header: 3, section: 3, afterHeading: 1, entry: 2 }, order: ["summary", "experience", "skills", "education", "certifications"], evidence: ["E1", "E10"] },
  T15: { id: "T15", name: "Plain Text-Safe", for: "any role where the safest possible parse matters most", roles: ["general"], levels: ["student", "early", "mid", "senior"], pages: 1, face: "serif",
    margins: { top: 1 * IN, right: 1 * IN, bottom: 1 * IN, left: 1 * IN }, body: 11, heading: 11, namePt: 14, leadRatio: 1.2,
    header: "stack", nameCase: "as-is", headingCase: "upper", headingRule: "none", bullet: { glyph: "•", x: 0, text: 12 },
    gaps: { header: 2, section: 2, afterHeading: 1, entry: 1 }, order: ["summary", "experience", "education", "skills"], evidence: ["E2", "E3", "E4"] },
};
export const isTemplateId = (s: unknown): s is TemplateId => typeof s === "string" && (TEMPLATE_IDS as readonly string[]).includes(s.toUpperCase());
export const templateId = (s: unknown): LibraryId | null => {
  const m = /^\s*(?:t(?:emplate)?\s*)?0?(\d{1,2})\s*$/i.exec(String(s ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 15 ? (`T${String(n).padStart(2, "0")}` as LibraryId) : null;
};

// ---------------------------------------------------------------- measuring
export const PAGE_W = 612, PAGE_H = 792;
const FACES: Record<TemplateSpec["face"], { regular: Face; bold: Face; docx: string }> = {
  sans: { regular: "Helvetica", bold: "Helvetica-Bold", docx: "Arial" },
  serif: { regular: "Times-Roman", bold: "Times-Bold", docx: "Times New Roman" },
};
const INDEX = new Map([...ENCODABLE].map((ch, i) => [ch, i]));
export const unencodable = (text: string) => [...new Set([...String(text)].filter((ch) => !INDEX.has(ch)))];
export function textWidth(text: string, face: Face, size: number): number {
  const w = METRICS[face].w;
  let em = 0;
  for (const ch of String(text)) em += w[INDEX.get(ch) ?? INDEX.get("?")!];
  return (em * size) / 1000;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const half = (n: number) => Math.round(n * 2) / 2;

// ---------------------------------------------------------------- sections in the template's order
const SECTION_OF: [RegExp, SectionKey][] = [
  [/summary|profile|objective|about/i, "summary"], [/skill|technolog|tools|competenc/i, "skills"], [/publication|paper|presentation/i, "publications"],
  [/research/i, "research"], [/project|portfolio/i, "projects"], [/education|academic|degree/i, "education"], [/leadership|activit|volunteer|service|extracurricular/i, "leadership"],
  [/certif|licen|clearance/i, "certifications"], [/award|honor|achievement/i, "awards"], [/coursework|courses/i, "coursework"], [/experience|employment|work|career|history/i, "experience"],
  [/additional|interest|languages|other/i, "additional"],
];
export const sectionKey = (heading: string): SectionKey | null => SECTION_OF.find(([re]) => re.test(String(heading)))?.[1] ?? null;
// The resume with its sections in the template's order: known sections by the order, then the rest as they came. No line is
// added, dropped or changed, so every truth check the source passed still holds of the reordered one.
// deno-lint-ignore no-explicit-any
export function reorderSections(resume: any, order: SectionKey[]): any {
  const secs = Array.isArray(resume?.sections) ? resume.sections : null;
  if (!secs?.length) return resume;
  // A summary always leads (it is the overview a reader's first seconds land on), whatever the template's order lists.
  const full: SectionKey[] = order.includes("summary") ? order : ["summary", ...order];
  const rank = (s: { heading?: string }) => { const k = sectionKey(s?.heading ?? ""); const i = k ? full.indexOf(k) : -1; return i < 0 ? full.length : i; };
  const sorted = secs.map((s: any, i: number) => ({ s, i })).sort((a: any, b: any) => rank(a.s) - rank(b.s) || a.i - b.i).map((x: any) => x.s);
  return { ...resume, sections: sorted, lines: sorted.flatMap((s: any) => (s.lines || []).map((l: any) => ({ ...l, section: s.heading }))) };
}

// ---------------------------------------------------------------- blocks
export interface TBlock { kind: "name" | "contact" | "links" | "heading" | "entry" | "bullet" | "line"; text: string; right?: string }
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]{0,6}\\.?";
const RANGE = `(?:${MONTH} )?\\d{4}(?:\\s*[–—-]\\s*(?:(?:${MONTH} )?\\d{4}|Present))?`;
const TRAILING_DATES = new RegExp(`^(.*\\S,)\\s*(${RANGE})$`, "i");
export function splitDates(text: string): { text: string; right?: string } {
  const m = TRAILING_DATES.exec(String(text).trim());
  return m ? { text: m[1], right: m[2] } : { text: String(text) };
}
// deno-lint-ignore no-explicit-any
export function templateBlocks(resume: any, spec: TemplateSpec): TBlock[] {
  const headings = new Map<string, string>((resume?.sections || []).map((s: any) => [String(s.heading).toUpperCase(), String(s.heading)]));
  const raw = ((CareerRender as any).sourceLines(resume) as { text: string; kind: string }[]);
  const out: TBlock[] = [];
  for (const l of raw) {
    const kind = (["name", "contact", "links", "heading", "entry", "bullet"].includes(l.kind) ? l.kind : "line") as TBlock["kind"];
    if (kind === "heading") out.push({ kind, text: spec.headingCase === "upper" ? l.text.toUpperCase() : headings.get(l.text) ?? l.text });
    else if (kind === "name") out.push({ kind, text: spec.nameCase === "upper" ? l.text.toUpperCase() : l.text });
    else if (kind === "links" && spec.header === "inline" && out.length && out[out.length - 1].kind === "contact") out[out.length - 1] = { kind: "contact", text: `${out[out.length - 1].text} | ${l.text}` };
    else if (kind === "entry") out.push({ kind, ...splitDates(l.text) });
    else out.push({ kind, text: l.text });
  }
  return out;
}

// ---------------------------------------------------------------- geometry and the typesetter
export interface Geometry {
  template: TemplateId; branded: boolean; page: { w: number; h: number }; margins: TemplateSpec["margins"];
  x: { left: number; bullet: number; text: number; right: number }; gridTop: number; unit: number; lead: number;
  body: number; heading: number; name: number; faces: Face[]; colors: string[];
  gaps: TemplateSpec["gaps"]; // the gaps used, in units, after the fit
}
export interface TLine { page: number; y: number; runs: { text: string; face: Face; size: number; x: number; color: string; role: "text" | "glyph" | "date" }[]; block: number; kind: TBlock["kind"]; first: boolean }
export interface TRule { page: number; y: number; w: number; color: string }
export interface TSet { geometry: Geometry; lines: TLine[]; rules: TRule[]; pages: number; printed: string[]; pageStarts: number[] /* block index that opens each page after the first */ }
interface Step { body: number; tighten: number }
export function fitSteps(spec: TemplateSpec): Step[] {
  const steps: Step[] = [];
  for (let b = spec.body; b >= 10 - 1e-9; b = half(b - 0.5)) for (const t of [0, 1]) steps.push({ body: b, tighten: t });
  return steps;
}
function palette(branded: boolean) {
  return branded ? { accent: PLUM, ink: LIGHT.ink, mute: LIGHT.mute } : { accent: LIGHT.ink, ink: LIGHT.ink, mute: LIGHT.ink };
}
function wrap(text: string, face: Face, size: number, width: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean), out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || textWidth(next, face, size) <= width) cur = next;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}
// The DOCX gives Word the same text width, in whole twentieths of a point, that the PDF wraps at, less a 0.1 pt margin of safety.
const twip = (pt: number) => Math.round(pt * 20);
export const wrapWidth = (pt: number) => twip(pt) / 20 - 0.1;
// The room an entry keeps for its dates on the right: their width and a 12 pt gap, in whole twentieths of a point.
export const dateRoom = (date: string, face: Face, size: number) => twip(textWidth(date, face, size) + 12) / 20;
export function typesetTemplate(blocks: TBlock[], spec: TemplateSpec, step: Step, branded: boolean): TSet {
  const f = FACES[spec.face], pal = palette(branded);
  const body = step.body, lead = half(body * spec.leadRatio), unit = lead / 2;
  const gaps = { header: Math.max(1, spec.gaps.header - step.tighten), section: Math.max(2, spec.gaps.section - step.tighten), afterHeading: spec.gaps.afterHeading, entry: Math.max(1, spec.gaps.entry - step.tighten) };
  const M = spec.margins, left = M.left, right = PAGE_W - M.right, col = right - left;
  const bulletX = left + spec.bullet.x, textX = left + spec.bullet.text;
  const gridTop = PAGE_H - M.top, floor = M.bottom;
  // The name at the template's size, a point smaller at a time (never under 14 pt, or the template's own size if smaller)
  // until it fits the column on one line; a name still too wide at the floor wraps at it.
  const nameText = blocks.find((b) => b.kind === "name")?.text ?? "";
  let namePt = spec.namePt;
  while (namePt - 1 >= Math.min(14, spec.namePt) && textWidth(nameText, f.bold, namePt) > wrapWidth(col)) namePt -= 1;
  const nameUnits = Math.ceil((namePt * 1.25) / unit), headingUnits = Math.max(2, Math.ceil((spec.heading * 1.15) / unit));
  const geometry: Geometry = { template: spec.id, branded, page: { w: PAGE_W, h: PAGE_H }, margins: M, x: { left, bullet: bulletX, text: textX, right }, gridTop, unit, lead, body, heading: spec.heading, name: namePt, faces: [f.regular, f.bold], colors: [...new Set([pal.accent, pal.ink, pal.mute])], gaps };
  // Each block as its lines (pieces), its line advance in units and its gap before in units.
  const laid = blocks.map((b, i) => {
    const prev = blocks[i - 1];
    const header = b.kind === "name" || b.kind === "contact" || b.kind === "links";
    let gap = 0;
    if (b.kind === "heading") gap = blocks.slice(0, i).some((x) => x.kind === "heading") ? gaps.section : gaps.header;
    else if (!header && prev?.kind === "heading") gap = gaps.afterHeading;
    else if (b.kind === "entry" && prev && !["heading", "name", "contact", "links"].includes(prev.kind)) gap = gaps.entry;
    else if (!header && prev && ["name", "contact", "links"].includes(prev.kind)) gap = gaps.header;
    const face = b.kind === "name" || b.kind === "heading" || b.kind === "entry" ? f.bold : f.regular;
    const size = b.kind === "name" ? namePt : b.kind === "heading" ? spec.heading : body;
    const adv = b.kind === "name" ? nameUnits : b.kind === "heading" ? headingUnits : 2;
    // An entry with dates wraps short of the date on every line (the date and a 12 pt gap); the DOCX gives the paragraph the
    // same right indent and sets the date at a right tab past it, on the margin (templateDocx), so both wrap identically.
    const width = b.kind === "bullet" ? right - textX : b.right ? col - dateRoom(b.right, f.regular, body) : col;
    const pieces = b.kind === "heading" ? [b.text] : wrap(b.text, face, size, wrapWidth(width));
    return { b, i, gap, face, size, adv, pieces, x: b.kind === "bullet" ? textX : left };
  });
  const lines: TLine[] = [], rules: TRule[] = [], printed: string[] = [], pageStarts: number[] = [];
  let page = 0, k = 0; // k: units used on this page below gridTop
  const maxUnits = Math.floor((gridTop - floor) / unit);
  const need = (j: number, atTop: boolean) => (atTop ? 0 : laid[j].gap) + laid[j].adv * laid[j].pieces.length;
  for (let j = 0; j < laid.length; j++) {
    const L = laid[j], atTop = k === 0;
    // Keep-with-next: a heading or an entry needs the whole next block on the same page (never orphaned).
    let units = need(j, atTop);
    if ((L.b.kind === "heading" || L.b.kind === "entry") && laid[j + 1] && laid[j + 1].b.kind !== "heading") {
      units += need(j + 1, false);
      if (L.b.kind === "heading" && laid[j + 1].b.kind === "entry" && laid[j + 2] && laid[j + 2].b.kind === "bullet") units += need(j + 2, false);
    }
    const header = L.b.kind === "name" || L.b.kind === "contact" || L.b.kind === "links";
    if (!header && !atTop && k + units > maxUnits) { page++; k = 0; pageStarts.push(j); }
    k += k === 0 ? 0 : L.gap;
    L.pieces.forEach((piece, n) => {
      k += L.adv;
      const y = r2(gridTop - k * unit);
      const color = L.b.kind === "name" || L.b.kind === "heading" ? pal.accent : header ? pal.mute : pal.ink;
      const runs: TLine["runs"] = [];
      if (L.b.kind === "bullet" && n === 0) { runs.push({ text: spec.bullet.glyph, face: f.regular, size: body, x: r2(bulletX), color: pal.ink, role: "glyph" }); printed.push(spec.bullet.glyph); }
      if (piece) { runs.push({ text: piece, face: L.face, size: L.size, x: r2(L.x), color, role: "text" }); printed.push(piece); }
      // The date sits flush right on the entry's LAST line: a wrapped title then reads title, then date, in reading order,
      // exactly as the source line does, and exactly where the DOCX's right tab puts it.
      if (n === L.pieces.length - 1 && L.b.right) {
        runs.push({ text: L.b.right, face: f.regular, size: body, x: r2(right - textWidth(L.b.right, f.regular, body)), color: pal.mute, role: "date" });
        printed.push(L.b.right);
      }
      lines.push({ page, y, runs, block: j, kind: L.b.kind, first: n === 0 });
    });
    const y = gridTop - k * unit;
    if (L.b.kind === "heading" && spec.headingRule === "below") rules.push({ page, y: r2(y - Math.min(3.5, unit * 0.55)), w: 0.6, color: pal.accent });
    if (L.b.kind === "heading" && spec.headingRule === "above") rules.push({ page, y: r2(y + spec.heading * 0.95 + 1), w: 0.6, color: pal.accent });
  }
  return { geometry, lines, rules, pages: page + 1, printed, pageStarts };
}
export interface TemplateFit { pages: number; body: number; tighten: number; target: 1 | 2; over: boolean }
export function fitTemplate(blocks: TBlock[], spec: TemplateSpec, branded: boolean): { fit: TemplateFit; set: TSet } {
  const steps = fitSteps(spec);
  let last: { fit: TemplateFit; set: TSet } | null = null;
  for (const target of [1, 2] as const) {
    // A two-page template does not squeeze to one: one page is taken only at its loosest step.
    const tries = target === 1 && spec.pages === 2 ? steps.slice(0, 1) : steps;
    for (const step of tries) {
      const set = typesetTemplate(blocks, spec, step, branded);
      last = { fit: { pages: set.pages, body: step.body, tighten: step.tighten, target, over: false }, set };
      if (set.pages <= target) return last;
    }
  }
  return { fit: { ...last!.fit, target: 2, over: true }, set: last!.set };
}

// ---------------------------------------------------------------- the PDF
const rgb = (hex: string) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000).join(" ");
// deno-lint-ignore no-explicit-any
export function templatePdf(R: any, set: TSet): Uint8Array {
  const P = R.primitives, bad: string[] = [];
  const g = set.geometry, fid = (face: Face) => (face === g.faces[0] ? "F1" : "F2");
  const pageIds = Array.from({ length: set.pages }, (_, i) => 5 + i * 2), contentIds = pageIds.map((id) => id + 1);
  const objects: [number, Uint8Array][] = [
    [1, P.bytes("<< /Type /Catalog /Pages 2 0 R >>")],
    [2, P.bytes(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${set.pages} >>`)],
    [3, P.bytes(`<< /Type /Font /Subtype /Type1 /BaseFont /${g.faces[0]} /Encoding /WinAnsiEncoding >>`)],
    [4, P.bytes(`<< /Type /Font /Subtype /Type1 /BaseFont /${g.faces[1]} /Encoding /WinAnsiEncoding >>`)],
  ];
  for (let p = 0; p < set.pages; p++) {
    objects.push([pageIds[p], P.bytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentIds[p]} 0 R >>`)]);
    const ops = [
      ...set.rules.filter((r) => r.page === p).map((r) => `q ${rgb(r.color)} RG ${r.w} w ${g.x.left} ${r.y} m ${g.x.right} ${r.y} l S Q`),
      ...set.lines.filter((l) => l.page === p).flatMap((l) => l.runs.map((r, i) => {
        const head = `BT /${fid(r.face)} ${r.size} Tf ${rgb(r.color)} rg 1 0 0 1 ${r.x} ${l.y} Tm ${P.pdfLiteral(P.encodeWinAnsi(r.text, bad))} Tj`;
        const next = l.runs[i + 1];
        if (next?.role !== "date") return `${head} ET`;
        // ATS ORDER (r-resume-design, 2026-11-10): a flush-right date drawn alone is read by text parsers that follow
        // the glyphs (pdfminer, PDFium) as its own column, after the whole section, cut from its entry. The entry's run
        // ends with plain spaces, word-spaced to stop exactly where the date starts, so those parsers read one line: the
        // title, then its dates. Same faces, nothing visible changes, and the date keeps its own run.
        const from = r.x + textWidth(r.text, r.face, r.size), gap = next.x - from, sp = textWidth(" ", r.face, r.size);
        const n = Math.max(1, Math.floor(gap / sp)), tw = Math.floor(((gap - n * sp) / n) * 1000) / 1000;
        return `${head} ${tw} Tw (${" ".repeat(n)}) Tj 0 Tw ET`;
      })),
    ].join("\n");
    const stream = P.deflate(P.bytes(ops, "latin1"));
    objects.push([contentIds[p], P.concat([P.bytes(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, P.bytes("\nendstream", "latin1")])]);
  }
  objects.sort((a, b) => a[0] - b[0]);
  const chunks: Uint8Array[] = [P.bytes("%PDF-1.4\n", "latin1")];
  const offsets = new Map<number, number>();
  let pos = chunks[0].length;
  for (const [id, b] of objects) {
    const head = P.bytes(`${id} 0 obj\n`, "latin1"), tail = P.bytes("\nendobj\n", "latin1");
    offsets.set(id, pos); chunks.push(head, b, tail); pos += head.length + b.length + tail.length;
  }
  const max = objects[objects.length - 1][0];
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= max; id++) xref += `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
  chunks.push(P.bytes(`${xref}trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`, "latin1"));
  return P.concat(chunks);
}

// ---------------------------------------------------------------- the DOCX (same paragraphs, same geometry, same page breaks)
const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const hexc = (c: string) => c.slice(1).toUpperCase();
const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
// deno-lint-ignore no-explicit-any
export function templateDocx(R: any, blocks: TBlock[], spec: TemplateSpec, set: TSet): { buffer: Uint8Array; printed: string[] } {
  const P = R.primitives, esc = P.escXml, g = set.geometry, pal = palette(g.branded), face = FACES[spec.face].docx;
  const t = (s: string) => `<w:t xml:space="preserve">${esc(s)}</w:t>`, printed: string[] = [];
  const col = g.x.right - g.x.left, sz = (pt: number) => Math.round(pt * 2);
  const firstLine = new Map<number, TLine>();
  for (const l of set.lines) if (l.first && !firstLine.has(l.block)) firstLine.set(l.block, l);
  const breaks = new Set(set.pageStarts);
  const paras = blocks.map((b, i) => {
    const l = firstLine.get(i)!, prevLine = set.lines.filter((x) => x.block < i && x.page === l.page).pop();
    // Space before, from the PDF's own baselines: this block's first baseline less the last one above it, less one advance.
    const adv = b.kind === "name" ? Math.ceil((g.name * 1.25) / g.unit) * g.unit : b.kind === "heading" ? Math.max(2, Math.ceil((spec.heading * 1.15) / g.unit)) * g.unit : g.lead;
    // A paragraph border adds its own space (w:space 1 pt plus the 0.625 pt rule) to the paragraph it borders: taken back out
    // of the space before (a rule above: this heading's; a rule below: the next paragraph's), so the baselines stay the PDF's.
    const BORDER = 1.625;
    const ruled = (k: number) => blocks[k]?.kind === "heading" && spec.headingRule !== "none";
    const takeBack = (spec.headingRule === "above" && ruled(i) ? BORDER : 0) + (spec.headingRule === "below" && ruled(i - 1) ? BORDER : 0);
    const before = prevLine ? Math.max(0, r2(prevLine.y - l.y - adv - takeBack)) : 0;
    const rule = b.kind === "heading" && spec.headingRule !== "none" ? `<w:pBdr><w:${spec.headingRule === "below" ? "bottom" : "top"} w:val="single" w:sz="5" w:space="1" w:color="${hexc(pal.accent)}"/></w:pBdr>` : "";
    const keep = b.kind === "heading" || b.kind === "entry" ? "<w:keepNext/>" : "";
    // Word wraps 0.1 pt inside the right margin (w:right 2 twips), as the PDF does (wrapWidth).
    const ind = b.kind === "bullet" ? `<w:ind w:left="${twip(g.x.text - g.x.left)}" w:hanging="${twip(g.x.text - g.x.bullet)}" w:right="2"/>`
      : b.kind === "entry" && b.right ? `<w:ind w:right="${twip(dateRoom(b.right, FACES[spec.face].regular, g.body)) + 2}"/>` : `<w:ind w:right="2"/>`;
    const tabs = b.kind === "entry" && b.right ? `<w:tabs><w:tab w:val="right" w:pos="${twip(col)}"/></w:tabs>` : "";
    const ppr = `<w:pPr>${keep}<w:keepLines/>${breaks.has(i) ? "<w:pageBreakBefore/>" : ""}<w:widowControl/>${rule}${tabs}<w:spacing w:before="${twip(before)}" w:after="0" w:line="${twip(adv)}" w:lineRule="exact"/>${ind}</w:pPr>`;
    const color = b.kind === "name" || b.kind === "heading" ? pal.accent : ["contact", "links"].includes(b.kind) ? pal.mute : pal.ink;
    const rpr = (bold: boolean, size: number, c: string) => `<w:rPr>${bold ? "<w:b/>" : ""}<w:color w:val="${hexc(c)}"/><w:sz w:val="${sz(size)}"/><w:szCs w:val="${sz(size)}"/></w:rPr>`;
    const bold = b.kind === "name" || b.kind === "heading" || b.kind === "entry";
    const size = b.kind === "name" ? g.name : b.kind === "heading" ? spec.heading : g.body;
    let runs: string;
    if (b.kind === "entry" && b.right) { runs = `<w:r>${rpr(true, size, color)}${t(b.text)}</w:r><w:r>${rpr(false, g.body, pal.mute)}<w:tab/>${t(b.right)}</w:r>`; printed.push(`${b.text} ${b.right}`); }
    else if (b.kind === "bullet") { runs = `<w:r>${rpr(false, size, color)}${t(spec.bullet.glyph)}<w:tab/>${t(b.text)}</w:r>`; printed.push(`${spec.bullet.glyph} ${b.text}`); }
    else { runs = `<w:r>${rpr(bold, size, color)}${t(b.text)}</w:r>`; printed.push(b.text); }
    return `<w:p>${ppr}${runs}</w:p>`;
  }).join("");
  const M = spec.margins;
  // The top margin is the grid's top; Word sets each exact-height line's text in its own height, as the PDF's baselines are.
  const sect = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="${twip(M.top)}" w:right="${twip(M.right)}" w:bottom="${twip(M.bottom)}" w:left="${twip(M.left)}" w:header="360" w:footer="360" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:cs="${face}" w:eastAsia="${face}"/><w:color w:val="${hexc(pal.ink)}"/><w:sz w:val="${sz(g.body)}"/><w:szCs w:val="${sz(g.body)}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${paras}${sect}</w:body></w:document>`;
  const buffer = P.zipBuffer([{ name: "[Content_Types].xml", data: CT }, { name: "_rels/.rels", data: RELS }, { name: "word/document.xml", data: doc }, { name: "word/_rels/document.xml.rels", data: DOC_RELS }, { name: "word/styles.xml", data: styles }]);
  return { buffer, printed };
}

// ---------------------------------------------------------------- one call: the resume in one template
export interface TemplateRender { ok: true; template: TemplateId; branded: boolean; pdf: Uint8Array; docx: Uint8Array; fit: TemplateFit; set: TSet; source: any; printedPdf: string[]; printedDocx: string[] }
// deno-lint-ignore no-explicit-any
export function renderTemplate(R: any, resume: any, o: { template: TemplateId; branded?: boolean; spec?: TemplateSpec }): TemplateRender | { ok: false; reason: string } {
  const spec = o.spec ?? TEMPLATES[o.template as LibraryId];
  if (!spec) return { ok: false, reason: `no template ${o.template}` };
  const source = reorderSections(resume, spec.order);
  const blocks = templateBlocks(source, spec);
  if (!blocks.length) return { ok: false, reason: "the resume has no lines to print" };
  // A character the standard faces cannot print is refused, never printed as "?" (the file would not say what the record says).
  const cannot = unencodable(blocks.map((b) => `${b.text}${b.right ?? ""}`).join(""));
  if (cannot.length) return { ok: false, reason: `the standard PDF fonts an applicant tracking system reads cannot print ${cannot.map((c) => `"${c}"`).join(", ")}; the file was not made rather than print it wrong` };
  const { fit, set } = fitTemplate(blocks, spec, !!o.branded);
  const pdf = templatePdf(R, set);
  const d = templateDocx(R, blocks, spec, set);
  return { ok: true, template: spec.id, branded: !!o.branded, pdf, docx: d.buffer, fit, set, source, printedPdf: set.printed, printedDocx: d.printed };
}
