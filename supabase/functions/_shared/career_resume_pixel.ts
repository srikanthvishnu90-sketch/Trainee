// RELEASE 10: the pixel-perfect checker. It reads a template's PDF back through pdf.js (career_resume_geometry.ts: positions
// and widths measured from the file, by a reader that is not our writer) and holds every line to the geometry the template
// declares (career_resume_templates.ts Geometry). It fails on any of:
//   grid         a baseline off the template's baseline grid, or a text start off its x stops, by more than 0.5 pt
//   indent       bullets that do not share one glyph x and one hanging text x (wrapped lines included)
//   dates        a date that does not end flush on the right margin, or is not on the same baseline as its entry
//   gaps         two same-level transitions (entry to entry, section to section, heading to its first line ...) with
//                different gaps
//   widow        a page that opens with a wrapped line of a paragraph, or closes with a heading, an entry or the first
//                line of a paragraph that continues on the next page
//   overflow     text past a margin
//   docx_text    the DOCX's words not the PDF's words, in the same order
//   fonts        a font outside the template's two standard faces, an embedded font, or a size outside 10-12 pt (the name:
//                its template's size, 10-18 pt)
// deno-lint-ignore-file no-explicit-any
import { DATE_RANGE, isGlyph, type PdfGeometry, type PdfLine, readDocxGeometry, readPdfGeometry, wordsOf } from "./career_resume_geometry.ts";
import type { Geometry } from "./career_resume_templates.ts";

export const TOL = 0.5;
export type PixelRule = "grid" | "indent" | "dates" | "gaps" | "widow" | "overflow" | "docx_text" | "fonts";
export interface PixelFailure { rule: PixelRule; page: number; line: string; detail: string }
export interface PixelReport { pass: boolean; failures: PixelFailure[]; lines: number; pages: number }

type Kind = "header" | "heading" | "entry" | "bullet" | "cont" | "line";
export function classify(g: Geometry, lines: PdfLine[]): Kind[] {
  const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
  let seenHeading = false;
  return lines.map((l) => {
    const first = l.items[0];
    if (isGlyph(first.str) && l.items.length > 1) return "bullet";
    if (!near(first.x, g.x.left) && near(first.x, g.x.text)) return "cont";
    const heading = first.bold && near(first.size, g.heading) && l.items.length === 1 && isHeadingText(first.str);
    if (heading) { seenHeading = true; return "heading"; }
    if (!seenHeading) return "header";
    return first.bold ? "entry" : "line";
  });
}
const HEADING_WORDS = "summary|profile|professional summary|skills|technical skills|experience|work experience|professional experience|relevant experience|projects|education|research|research experience|publications|leadership|activities|leadership & activities|certifications|awards|honors|coursework|additional|additional information";
const isHeadingText = (s: string) => new RegExp(`^(?:${HEADING_WORDS})$`, "i").test(s.trim());

export async function checkTemplatePdf(g: Geometry, pdf: Uint8Array, o: { R?: any; docx?: Uint8Array } = {}): Promise<PixelReport> {
  const geo: PdfGeometry = await readPdfGeometry(pdf);
  const F: PixelFailure[] = [];
  const add = (rule: PixelRule, l: PdfLine | null, detail: string) => F.push({ rule, page: l ? l.page + 1 : 0, line: l ? l.text.slice(0, 80) : "", detail });
  const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
  const lines = geo.lines, kinds = classify(g, lines);
  // fonts
  for (const f of geo.fonts) {
    if (!g.faces.includes(f.name as any)) add("fonts", null, `font ${f.name} is not one of the template's faces (${g.faces.join(", ")})`);
    if (f.embedded) add("fonts", null, `font ${f.name} is embedded`);
  }
  // Sizes: the name (the first line of page one) at the template's name size, 10-18 pt; everything else 10-12 pt (R6, scoped).
  const nameLine = lines.find((l) => l.page === 0) ?? null;
  for (const it of geo.items) {
    const isName = !!nameLine && nameLine.items.includes(it);
    const [lo, hi] = isName ? [10, 18] : [10, 12];
    if (it.size < lo - 1e-6 || it.size > hi + 1e-6) add("fonts", lines.find((l) => l.items.includes(it)) ?? null, `"${it.str.slice(0, 30)}" is ${it.size} pt (${lo}-${hi} pt only)`);
    if (isName && Math.abs(it.size - g.name) > 1e-6) add("fonts", nameLine, `the name is ${it.size} pt, not the template's ${g.name} pt`);
  }
  for (const p of geo.pages) if (!near(p.w, g.page.w) || !near(p.h, g.page.h)) add("overflow", null, `page is ${p.w}x${p.h}, not ${g.page.w}x${g.page.h}`);
  lines.forEach((l, i) => {
    const k = kinds[i];
    // grid: baselines
    const units = (g.gridTop - l.y) / g.unit;
    if (Math.abs(units - Math.round(units)) * g.unit > TOL) add("grid", l, `baseline ${l.y.toFixed(2)} is ${(Math.abs(units - Math.round(units)) * g.unit).toFixed(2)} pt off the ${g.unit} pt grid`);
    for (const it of l.items) {
      if (Math.abs(it.y - l.y) > TOL) add("grid", l, `"${it.str.slice(0, 20)}" sits ${Math.abs(it.y - l.y).toFixed(2)} pt off its line's baseline`);
      // overflow
      if (it.x < g.x.left - TOL) add("overflow", l, `"${it.str.slice(0, 20)}" starts ${(g.x.left - it.x).toFixed(2)} pt left of the margin`);
      if (it.x + it.w > g.x.right + TOL) add("overflow", l, `"${it.str.slice(0, 20)}" ends ${(it.x + it.w - g.x.right).toFixed(2)} pt past the right margin`);
      if (it.y < g.margins.bottom - TOL) add("overflow", l, `baseline ${it.y.toFixed(2)} is below the bottom margin`);
      if (it.y + it.size * 0.75 > g.gridTop + TOL) add("overflow", l, `"${it.str.slice(0, 20)}" rises above the top margin`);
    }
    // x stops: the first item at a stop; any other item is a date flush right
    const first = l.items[0];
    const stops = [g.x.left, g.x.bullet, g.x.text];
    if (!stops.some((s) => near(first.x, s))) add("grid", l, `text starts at x ${first.x.toFixed(2)}, not on a stop (${stops.map((s) => s.toFixed(2)).join(", ")})`);
    if (k === "bullet") {
      if (!near(first.x, g.x.bullet)) add("indent", l, `bullet glyph at x ${first.x.toFixed(2)}, not ${g.x.bullet.toFixed(2)}`);
      if (!near(l.items[1].x, g.x.text)) add("indent", l, `bullet text at x ${l.items[1].x.toFixed(2)}, not the hanging indent ${g.x.text.toFixed(2)}`);
    }
    if (k === "cont" && i > 0 && !["bullet", "cont"].includes(kinds[i - 1]) && lines[i - 1].page === l.page) add("indent", l, "a line at the hanging indent that does not follow a bullet");
    const rest = l.items.slice(k === "bullet" ? 2 : 1);
    for (const it of rest) {
      if (DATE_RANGE.test(it.str.trim())) {
        if (!near(it.x + it.w, g.x.right)) add("dates", l, `date "${it.str}" ends at ${(it.x + it.w).toFixed(2)}, not flush on the right margin ${g.x.right.toFixed(2)}`);
        if (!near(it.y, first.y)) add("dates", l, `date "${it.str}" is not on its entry's baseline`);
      } else add("grid", l, `"${it.str.slice(0, 20)}" at x ${it.x.toFixed(2)} is neither a line start nor a flush-right date`);
    }
    if (l.items.length === 1 && DATE_RANGE.test(first.str.trim())) add("dates", l, `date "${first.str}" stands on a line of its own`);
  });
  // gaps: blocks (a wrapped line belongs to the block above it); per transition kind, one gap
  const blocks: { k: Kind; first: PdfLine; last: PdfLine }[] = [];
  lines.forEach((l, i) => {
    const k = kinds[i], b = blocks[blocks.length - 1];
    if (k === "cont" && b) b.last = l; else blocks.push({ k, first: l, last: l });
  });
  const seen = new Map<string, { gap: number; line: PdfLine }>();
  for (let j = 1; j < blocks.length; j++) {
    const a = blocks[j - 1], b = blocks[j];
    if (a.last.page !== b.first.page || a.k === "header" || b.k === "header") continue;
    const key = `${a.k}->${b.k}`, gap = Math.round((a.last.y - b.first.y) * 100) / 100, had = seen.get(key);
    if (had && Math.abs(had.gap - gap) > TOL) add("gaps", b.first, `${key} gap is ${gap} pt here and ${had.gap} pt at "${had.line.text.slice(0, 30)}"`);
    else if (!had) seen.set(key, { gap, line: b.first });
  }
  // widows and orphans
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i + 1].page === lines[i].page) continue;
    const a = kinds[i], b = kinds[i + 1];
    if (a === "heading" || (a === "entry" && b !== "heading" && b !== "entry")) add("widow", lines[i], `a ${a} closes page ${lines[i].page + 1} and its content starts the next page`);
    if (b === "cont") add("widow", lines[i + 1], `page ${lines[i + 1].page + 1} opens with a wrapped line of a paragraph from the page before`);
  }
  // DOCX text
  if (o.docx && o.R) {
    const d = readDocxGeometry(o.R, o.docx);
    const pw = wordsOf(geo.streamText).join(" "), dw = wordsOf(d.paras.map((p) => p.text)).join(" ");
    if (pw !== dw) {
      const a = pw.split(" "), b = dw.split(" ");
      let n = 0; while (n < a.length && a[n] === b[n]) n++;
      add("docx_text", null, `the DOCX and the PDF differ at word ${n + 1}: PDF "${a.slice(n, n + 5).join(" ")}" vs DOCX "${b.slice(n, n + 5).join(" ")}"`);
    }
  }
  return { pass: F.length === 0, failures: F, lines: lines.length, pages: geo.pages.length };
}
