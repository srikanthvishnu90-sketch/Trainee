// RELEASE 9 (workstream B): the two resume layouts a tailored resume can go out in, each as a PDF and a DOCX with the
// same words in the same order.
//
//   trainee  Trainee's own design: a one-column header (name, contact, links) over a plum rule, plum section headings
//            each over a thin plum rule, entries with their dates set flush right on the same line, bullets with a
//            hanging indent, one fixed vertical rhythm (every gap is a multiple of half a line). Plum (#5C2751,
//            D-DESIGN-1) is used only for the name, the headings and the rules; the text is ink and the dates and
//            contact line are the muted ink (brand.ts LIGHT). No new hue.
//            Type: the DOCX names Inter for text and Brygada 1918 for the name (the brand faces), with Arial and
//            Georgia as the named fallbacks for a reader that has neither installed. The PDF uses the standard faces
//            nearest them, Helvetica and Times-Bold, because a PDF that embeds a font fails the ATS rule R6 (148's
//            parse-check: standard fonts only) and an applicant tracking system reads the standard faces reliably.
//   own      "Keep my layout": the person's own Word file (the release-8 clean copy, channel_resume_upload.ts cleanDocx),
//            with each tailored bullet put in place of the bullet it was written from, keeping that paragraph's own
//            style, indent and run formatting. Nothing else in their file changes. Its PDF carries the same paragraphs,
//            in the same order, typeset plainly (no plum: it is their layout, not ours).
//
// Page fit: the layout is typeset at 10.5 pt and then tightened in fixed steps (spacing, then 10 pt) until it fits one
// page, else two. Text is never set below 10 pt (R6: 10 to 12 pt); a record that needs more than two pages at the
// tightest step is set on as many as it needs and says so (fit.over).
//
// The words: every printed line is a source line's own text (or a split of it at its dates); 148's parse-check gets the
// printed lines per format and refuses them unless their words, in order, are exactly the source's (layout_text), then
// diffs both parsers' extraction against them. Nothing here adds a word.
import { CareerRender } from "./router_core.career.js";
import { PLUM, LIGHT } from "./brand.ts";

export type LayoutName = "trainee" | "own";
export const LAYOUTS: LayoutName[] = ["trainee", "own"];
export const MIN_BODY_PT = 10;
// The fit steps, loosest first: [body size, spacing scale].
export const FIT_STEPS: [number, number][] = [[10.5, 1], [10.5, 0.85], [10, 0.85], [10, 0.7]];

// ---------------------------------------------------------------- Helvetica metrics (Adobe AFM, 1/1000 em, ASCII 32..126)
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const EXTRA: Record<string, number> = { "–": 556, "—": 1000, "•": 350, "‘": 222, "’": 222, "“": 333, "”": 333, "…": 1000, "€": 556 };
type Font = "F1" | "F2" | "F3"; // Helvetica, Helvetica-Bold, Times-Bold
export function widthPt(text: string, font: Font, size: number): number {
  const table = font === "F1" ? HELV : HELVB; // Times-Bold (the name only) is never aligned; Helvetica-Bold bounds it
  let em = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)!;
    em += c >= 32 && c <= 126 ? table[c - 32] : EXTRA[ch] ?? (ch.toUpperCase() === ch ? 722 : 556);
  }
  return (em * size) / 1000;
}

// ---------------------------------------------------------------- the block model
export interface Block { kind: "name" | "contact" | "links" | "heading" | "entry" | "bullet" | "line"; text: string; right?: string }
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]{0,6}\\.?";
const RANGE = `(?:${MONTH} )?\\d{4}(?:\\s*[–—-]\\s*(?:(?:${MONTH} )?\\d{4}|Present))?`;
const TRAILING_DATES = new RegExp(`^(.*\\S,)\\s*(${RANGE})$`, "i");
// An entry's trailing dates ("Data Analyst, Acme, 2022–Present") go flush right on the entry's line. Every character stays
// the entry's own, its separating comma included: the files print exactly the source's text, split in two.
export function splitDates(text: string): { text: string; right?: string } {
  const m = TRAILING_DATES.exec(String(text).trim());
  return m ? { text: m[1], right: m[2] } : { text: String(text) };
}
// deno-lint-ignore no-explicit-any
export function traineeBlocks(resume: any): Block[] {
  return ((CareerRender as any).sourceLines(resume) as { text: string; kind: string }[]).map((l) => {
    const kind = (["name", "contact", "links", "heading", "entry", "bullet"].includes(l.kind) ? l.kind : "line") as Block["kind"];
    return kind === "entry" ? { kind, ...splitDates(l.text) } : { kind, text: l.text };
  });
}

// ---------------------------------------------------------------- typesetting (shared by the PDF and the fit)
const PAGE = { w: 612, h: 792, x0: 54, x1: 558, top: 742, bottom: 50 };
const COL = PAGE.x1 - PAGE.x0;
const BULLET_X = PAGE.x0 + 4, TEXT_X = PAGE.x0 + 14;
const rgb = (hex: string) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000).join(" ");
export interface Palette { accent: string; ink: string; mute: string; upperHeadings: boolean; rules: boolean }
export const TRAINEE_PALETTE: Palette = { accent: PLUM, ink: LIGHT.ink, mute: LIGHT.mute, upperHeadings: true, rules: true };
export const PLAIN_PALETTE: Palette = { accent: LIGHT.ink, ink: LIGHT.ink, mute: LIGHT.ink, upperHeadings: false, rules: false };
interface Run { text: string; font: Font; size: number; x: number; y: number; color: string }
interface Rule { y: number; w: number; color: string }
interface Page { runs: Run[]; rules: Rule[] }
export interface Spacing { lead: number; unit: number; nameLead: number; before: Record<string, number> }
export function spacingFor(body: number, scale: number): Spacing {
  const lead = Math.round(body * 1.3 * 2) / 2, unit = lead / 2;
  const r = (k: number) => Math.round(unit * k * scale * 100) / 100;
  // Every gap is a whole number of half-lines (times the fit's scale): the rhythm.
  return { lead, unit, nameLead: Math.round(lead * 1.3 * 2) / 2, before: { heading: r(3), firstHeading: r(2), entry: r(1), afterHeading: r(1), headerRule: r(1) } };
}
function wrap(text: string, font: Font, size: number, width: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean), out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || widthPt(next, font, size) <= width) cur = next;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}
export interface Typeset { pages: Page[]; printed: string[]; spacing: Spacing; body: number }
export function typeset(blocks: Block[], body: number, scale: number, pal: Palette): Typeset {
  const sp = spacingFor(body, scale), pages: Page[] = [{ runs: [], rules: [] }], printed: string[] = [];
  let y = PAGE.top;
  const page = () => pages[pages.length - 1];
  const newPage = () => { pages.push({ runs: [], rules: [] }); y = PAGE.top; };
  const linesOf = (b: Block): { pieces: string[]; font: Font; size: number; x: number; width: number; lead: number } => {
    if (b.kind === "name") return { pieces: [b.text], font: "F3", size: 12, x: PAGE.x0, width: COL, lead: sp.nameLead };
    const font: Font = b.kind === "heading" || b.kind === "entry" ? "F2" : "F1";
    const text = b.kind === "heading" && pal.upperHeadings ? b.text.toUpperCase() : b.text;
    if (b.kind === "bullet") return { pieces: wrap(text, font, body, PAGE.x1 - TEXT_X), font, size: body, x: TEXT_X, width: PAGE.x1 - TEXT_X, lead: sp.lead };
    const width = b.right ? COL - widthPt(b.right, "F1", body) - 12 : COL;
    return { pieces: wrap(text, font, body, width), font, size: body, x: PAGE.x0, width, lead: sp.lead };
  };
  let prev: Block["kind"] | null = null, seenHeading = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], L = linesOf(b);
    const header = b.kind === "name" || b.kind === "contact" || b.kind === "links";
    let gap = 0;
    if (b.kind === "heading") gap = seenHeading ? sp.before.heading : sp.before.firstHeading;
    else if (b.kind === "entry" && prev !== "heading" && prev !== null) gap = sp.before.entry;
    else if (prev === "heading") gap = sp.before.afterHeading;
    // Keep a heading or an entry with the first line of what follows it.
    const next = blocks[i + 1];
    const keep = (b.kind === "heading" || b.kind === "entry") && next && !["heading", "name"].includes(next.kind) ? sp.lead + (b.kind === "heading" ? sp.before.afterHeading : 0) : 0;
    if (!header && page().runs.length && y - gap - L.lead * L.pieces.length - keep < PAGE.bottom) newPage();
    else y -= page().runs.length ? gap : 0;
    L.pieces.forEach((piece, k) => {
      if (y - L.lead < PAGE.bottom && page().runs.length) newPage();
      y -= L.lead;
      const yy = Math.round(y * 100) / 100;
      const color = b.kind === "name" || b.kind === "heading" ? pal.accent : header ? pal.mute : pal.ink;
      if (b.kind === "bullet" && k === 0) { page().runs.push({ text: "•", font: "F1", size: body, x: BULLET_X, y: yy, color: pal.ink }); printed.push("•"); }
      page().runs.push({ text: piece, font: L.font, size: L.size, x: L.x, y: yy, color });
      printed.push(piece);
      if (k === 0 && b.right) {
        const x = Math.round((PAGE.x1 - widthPt(b.right, "F1", body)) * 100) / 100;
        page().runs.push({ text: b.right, font: "F1", size: body, x, y: yy, color: pal.mute });
        printed.push(b.right);
      }
    });
    if (b.kind === "heading" && pal.rules) page().rules.push({ y: Math.round((y - 3.5) * 100) / 100, w: 0.5, color: pal.accent });
    if (header && (!next || !["contact", "links"].includes(next.kind)) && pal.rules) { y -= sp.before.headerRule; page().rules.push({ y: Math.round(y * 100) / 100, w: 0.8, color: pal.accent }); }
    if (b.kind === "heading") seenHeading = true;
    prev = b.kind;
  }
  return { pages, printed, spacing: sp, body };
}
export interface Fit { pages: number; body: number; scale: number; target: 1 | 2; over: boolean }
// What a file's record keeps of its fit, in whole numbers only: the body size in tenths of a point (105 = 10.5 pt) and the
// spacing as an integer percent of the loosest step. The router keeps its employer copy on the person's profile, and the
// hosted apply hashes that profile at prepare and again at send with the apply hash, which takes no fraction
// (career_apply_store.ts canonical: INVALID_APPLY_PAYLOAD); a decimal there failed every hosted send after a tailor.
export interface FitRecord { pages: number; target: 1 | 2; over: boolean; body_pt10: number; spacing_pct: number }
export const fitRecord = (f: Fit): FitRecord =>
  ({ pages: f.pages, target: f.target, over: f.over, body_pt10: Math.round(f.body * 10), spacing_pct: Math.round(f.scale * 100) });
export function fit(blocks: Block[], pal: Palette): { fit: Fit; set: Typeset } {
  let last: Typeset | null = null, lastStep = FIT_STEPS[0];
  for (const target of [1, 2] as const) {
    for (const step of FIT_STEPS) {
      const set = typeset(blocks, step[0], step[1], pal);
      last = set; lastStep = step;
      if (set.pages.length <= target) return { fit: { pages: set.pages.length, body: step[0], scale: step[1], target, over: false }, set };
    }
  }
  return { fit: { pages: last!.pages.length, body: lastStep[0], scale: lastStep[1], target: 2, over: true }, set: last! };
}

// ---------------------------------------------------------------- the PDF writer
// deno-lint-ignore no-explicit-any
function writePdf(R: any, set: Typeset): Uint8Array {
  const P = R.primitives, unencodable: string[] = [];
  const objects: [number, Uint8Array][] = [];
  const pageIds = set.pages.map((_, i) => 6 + i * 2), contentIds = set.pages.map((_, i) => 7 + i * 2);
  objects.push([1, P.bytes("<< /Type /Catalog /Pages 2 0 R >>")]);
  objects.push([2, P.bytes(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${set.pages.length} >>`)]);
  objects.push([3, P.bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")]);
  objects.push([4, P.bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")]);
  objects.push([5, P.bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>")]);
  set.pages.forEach((pg, i) => {
    objects.push([pageIds[i], P.bytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentIds[i]} 0 R >>`)]);
    const ops = [
      ...pg.rules.map((r) => `q ${rgb(r.color)} RG ${r.w} w ${PAGE.x0} ${r.y} m ${PAGE.x1} ${r.y} l S Q`),
      ...pg.runs.map((r) => `BT /${r.font} ${r.size} Tf ${rgb(r.color)} rg 1 0 0 1 ${r.x} ${r.y} Tm ${P.pdfLiteral(P.encodeWinAnsi(r.text, unencodable))} Tj ET`),
    ].join("\n");
    const stream = P.deflate(P.bytes(ops, "latin1"));
    objects.push([contentIds[i], P.concat([P.bytes(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, P.bytes("\nendstream", "latin1")])]);
  });
  objects.sort((a, b) => a[0] - b[0]);
  const chunks: Uint8Array[] = [P.bytes("%PDF-1.4\n", "latin1")];
  const offsets = new Map<number, number>();
  let pos = chunks[0].length;
  for (const [id, body] of objects) {
    const head = P.bytes(`${id} 0 obj\n`, "latin1"), tail = P.bytes("\nendobj\n", "latin1");
    offsets.set(id, pos);
    chunks.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  }
  const max = objects[objects.length - 1][0];
  let xref = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= max; id++) xref += `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
  chunks.push(P.bytes(`${xref}trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`, "latin1"));
  return P.concat(chunks);
}

// ---------------------------------------------------------------- the Trainee DOCX
// The DOCX is set in Inter, which runs about 6% wider than the Helvetica metrics the PDF and the page fit are measured with
// (2026-11-08 review of #596: on a wrap-heavy record LibreOffice laid the DOCX out a page longer than its PDF). A paragraph
// that would wrap onto more lines in Inter than it does in the PDF is set with its letters drawn closer, by the least whole
// number of twentieths of a point that keeps the PDF's line count (never more than CONDENSE_MAX), so both files keep the
// same lines per paragraph and the same pages. Every other paragraph is untouched. Inter 4.000's advance widths, per 1000 em,
// for ASCII 32-126 (read from the font's hmtx table); anything else is taken at its Helvetica width times 1.1.
const INTER = [281, 288, 466, 633, 642, 982, 644, 300, 365, 365, 501, 662, 288, 460, 288, 360, 631, 407, 610, 618, 646, 608, 620, 566, 619, 620, 288, 302, 662, 662, 662, 511, 966, 690, 654, 730, 722, 601, 590, 746, 743, 269, 571, 672, 565, 903, 753, 765, 639, 765, 644, 642, 646, 744, 690, 985, 682, 679, 629, 365, 360, 365, 471, 456, 323, 562, 612, 571, 612, 583, 370, 613, 591, 242, 242, 549, 242, 876, 591, 600, 612, 612, 376, 528, 327, 591, 562, 818, 546, 562, 552, 426, 333, 426, 662];
const INTERB = [237, 338, 552, 649, 655, 1016, 672, 339, 377, 377, 559, 679, 334, 468, 334, 388, 674, 431, 630, 646, 676, 639, 649, 582, 651, 649, 334, 343, 679, 679, 679, 560, 1016, 747, 662, 740, 722, 607, 587, 750, 747, 281, 584, 719, 565, 932, 762, 771, 648, 777, 657, 655, 667, 732, 747, 1038, 738, 731, 664, 377, 388, 377, 487, 476, 365, 581, 630, 588, 630, 596, 398, 632, 623, 271, 271, 580, 271, 913, 623, 613, 630, 630, 407, 560, 366, 623, 600, 850, 580, 602, 573, 469, 372, 469, 679];
export const CONDENSE_MAX = 12; // 0.6 pt
export function interWidthPt(text: string, bold: boolean, size: number, condense = 0): number {
  const table = bold ? INTERB : INTER;
  let em = 0, n = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)!;
    em += c >= 32 && c <= 126 ? table[c - 32] : Math.round(widthPt(ch, bold ? "F2" : "F1", 1000) * 1.1);
    n++;
  }
  return (em * size) / 1000 - (n * condense) / 20;
}
function wrapCount(text: string, width: number, w: (s: string) => number): number {
  let lines = 0, cur = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (!cur || w(next) <= width) cur = next;
    else { lines++; cur = word; }
  }
  return Math.max(1, lines + (cur ? 1 : 0));
}
// The condensing (twentieths of a point, 0 for none) a block's text needs in Inter to wrap onto no more lines than the PDF's.
export function docxCondense(b: Block, body: number, pal: Palette): number {
  if (b.kind === "name") return 0; // one line at 12 pt; Brygada is not measured here, and the name never wraps in practice
  const bold = b.kind === "heading" || b.kind === "entry";
  const text = b.kind === "heading" && pal.upperHeadings ? b.text.toUpperCase() : b.text;
  const font: Font = bold ? "F2" : "F1";
  const width = b.kind === "bullet" ? PAGE.x1 - TEXT_X : b.right ? COL - widthPt(b.right, "F1", body) - 12 : COL;
  const pdfLines = wrapCount(text, width, (x) => widthPt(x, font, body));
  // In the DOCX the date sits at a right tab on the margin: the entry's words must end before the date's Inter width.
  const docxWidth = b.right ? Math.min(width, COL - interWidthPt(b.right, false, body) - 12) : width;
  for (let c = 0; c <= CONDENSE_MAX; c++) if (wrapCount(text, docxWidth, (x) => interWidthPt(x, bold, body, c)) <= pdfLines) return c;
  return CONDENSE_MAX;
}
const tw = (pt: number) => Math.round(pt * 20);
const hex = (c: string) => c.slice(1).toUpperCase();
const DOCX_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
function traineeStyles(body: number, pal: Palette): string {
  const sz = Math.round(body * 2);
  const style = (id: string, name: string, ppr: string, rpr: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${DOCX_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Inter" w:hAnsi="Inter" w:cs="Inter"/><w:color w:val="${hex(pal.ink)}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    style("TraineeName", "Trainee Name", "", `<w:rFonts w:ascii="Brygada 1918" w:hAnsi="Brygada 1918" w:cs="Brygada 1918"/><w:b/><w:color w:val="${hex(pal.accent)}"/><w:sz w:val="24"/><w:szCs w:val="24"/>`) +
    style("TraineeContact", "Trainee Contact", "", `<w:color w:val="${hex(pal.mute)}"/>`) +
    style("Heading1", "heading 1", `<w:keepNext/><w:outlineLvl w:val="0"/>`, `<w:b/><w:color w:val="${hex(pal.accent)}"/>`) +
    style("TraineeEntry", "Trainee Entry", `<w:keepNext/><w:tabs><w:tab w:val="right" w:pos="${tw(COL)}"/></w:tabs>`, `<w:b/>`) +
    style("TraineeBullet", "Trainee Bullet", `<w:ind w:left="${tw(TEXT_X - PAGE.x0)}" w:hanging="${tw(TEXT_X - BULLET_X)}"/>`, "") +
    `</w:styles>`;
}
const FONT_TABLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:fonts ${DOCX_NS}><w:font w:name="Inter"><w:altName w:val="Arial"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font><w:font w:name="Brygada 1918"><w:altName w:val="Georgia"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font></w:fonts>`;
const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>`;
// deno-lint-ignore no-explicit-any
function traineeDocx(R: any, blocks: Block[], f: Fit, pal: Palette): { buffer: Uint8Array; printed: string[] } {
  const P = R.primitives, esc = P.escXml, sp = spacingFor(f.body, f.scale), printed: string[] = [];
  const t = (s: string) => `<w:t xml:space="preserve">${esc(s)}</w:t>`;
  let prev: Block["kind"] | null = null, seenHeading = false;
  const paras = blocks.map((b, i) => {
    const header = b.kind === "name" || b.kind === "contact" || b.kind === "links";
    const next = blocks[i + 1];
    let before = 0;
    if (b.kind === "heading") before = seenHeading ? sp.before.heading : sp.before.firstHeading;
    else if (b.kind === "entry" && prev !== "heading" && prev !== null) before = sp.before.entry;
    else if (prev === "heading") before = sp.before.afterHeading;
    const lead = b.kind === "name" ? sp.nameLead : sp.lead;
    const closesHeader = header && (!next || !["contact", "links"].includes(next.kind));
    const border = b.kind === "heading" ? `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="${hex(pal.accent)}"/></w:pBdr>`
      : closesHeader ? `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="${hex(pal.accent)}"/></w:pBdr>` : "";
    const styleId = b.kind === "name" ? "TraineeName" : header ? "TraineeContact" : b.kind === "heading" ? "Heading1" : b.kind === "entry" ? "TraineeEntry" : b.kind === "bullet" ? "TraineeBullet" : null;
    const ppr = `<w:pPr>${styleId ? `<w:pStyle w:val="${styleId}"/>` : ""}${border}<w:spacing w:before="${tw(before)}" w:after="0" w:line="${tw(lead)}" w:lineRule="exact"/></w:pPr>`;
    let runs: string;
    const c = docxCondense(b, f.body, pal), cpr = c ? `<w:rPr><w:spacing w:val="-${c}"/></w:rPr>` : "";
    if (b.kind === "entry" && b.right) { runs = `<w:r>${cpr}${t(b.text)}</w:r><w:r><w:rPr><w:b w:val="0"/><w:color w:val="${hex(pal.mute)}"/></w:rPr><w:tab/>${t(b.right)}</w:r>`; printed.push(`${b.text} ${b.right}`); }
    else if (b.kind === "bullet") { runs = c ? `<w:r>${t("•")}<w:tab/></w:r><w:r>${cpr}${t(b.text)}</w:r>` : `<w:r>${t("•")}<w:tab/>${t(b.text)}</w:r>`; printed.push(`• ${b.text}`); }
    else { const text = b.kind === "heading" && pal.upperHeadings ? b.text.toUpperCase() : b.text; runs = `<w:r>${cpr}${t(text)}</w:r>`; printed.push(text); }
    if (b.kind === "heading") seenHeading = true;
    prev = b.kind;
    return `<w:p>${ppr}${runs}</w:p>`;
  }).join("");
  const sect = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="${tw(PAGE.h - PAGE.top)}" w:right="${tw(PAGE.w - PAGE.x1)}" w:bottom="${tw(PAGE.bottom)}" w:left="${tw(PAGE.x0)}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${DOCX_NS}><w:body>${paras}${sect}</w:body></w:document>`;
  const buffer = P.zipBuffer([
    { name: "[Content_Types].xml", data: CT }, { name: "_rels/.rels", data: RELS }, { name: "word/document.xml", data: doc },
    { name: "word/_rels/document.xml.rels", data: DOC_RELS }, { name: "word/styles.xml", data: traineeStyles(f.body, pal) }, { name: "word/fontTable.xml", data: FONT_TABLE },
  ]);
  return { buffer, printed };
}

// ---------------------------------------------------------------- "Keep my layout": the person's own Word file
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const paraText = (inner: string) => [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] === undefined ? " " : unesc(m[1]))).join("");
const GLYPH = /^[\s•·▪●–—*-]+/;
const key = (s: string) => String(s).replace(GLYPH, "").replace(/\s+/g, " ").trim().toLowerCase();
export interface Swap { before: string; after: string }
export interface OwnParagraph { kind: Block["kind"]; text: string }
// Each swap replaces the first paragraph (not yet replaced) whose words are the swap's `before`, keeping that paragraph's
// properties and its first run's formatting, and any bullet glyph the person typed. A swap whose bullet is not in the
// file is reported in `missing`, never put somewhere else.
// deno-lint-ignore no-explicit-any
export function ownDocx(R: any, original: Uint8Array, swaps: Swap[]): { ok: true; buffer: Uint8Array; replaced: number; missing: string[]; paragraphs: OwnParagraph[] } | { ok: false; reason: string } {
  const P = R.primitives;
  let parts: Map<string, Uint8Array>;
  try { parts = P.unzipParts(P.bytes(original)); } catch { return { ok: false, reason: "your Word file could not be opened" }; }
  const docBuf = parts.get("word/document.xml");
  if (!docBuf) return { ok: false, reason: "your Word file has no document part" };
  const xml = new TextDecoder().decode(docBuf);
  const stylesXml = parts.get("word/styles.xml") ? new TextDecoder().decode(parts.get("word/styles.xml")) : "";
  const styleName = (id: string) => (new RegExp(`<w:style\\b[^>]*w:styleId="${id.replace(/[^\w-]/g, "")}"[^>]*>[\\s\\S]*?<w:name w:val="([^"]+)"`).exec(stylesXml)?.[1] ?? id).toLowerCase();
  const todo = swaps.map((s) => ({ ...s, k: key(s.before), done: false })).filter((s) => s.k && s.after.trim());
  const paragraphs: OwnParagraph[] = [];
  let replaced = 0, seenName = false;
  const out = xml.replace(/<w:p(\s[^>]*)?>([\s\S]*?)<\/w:p>/g, (whole, attrs = "", inner: string) => {
    if (/<w:p[\s>]/.test(inner)) return whole; // a nested paragraph (a text box): left exactly as it is
    let text = paraText(inner);
    const ppr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(inner)?.[0] ?? "";
    const sw = todo.find((s) => !s.done && key(text) === s.k);
    let body = whole;
    if (sw) {
      sw.done = true; replaced++;
      const firstRun = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/.exec(inner.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, ""));
      const rpr = firstRun ? /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(firstRun[1])?.[0] ?? "" : "";
      const glyph = GLYPH.exec(text)?.[0] ?? "";
      text = `${glyph}${sw.after.trim()}`;
      body = `<w:p${attrs}>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${P.escXml(text)}</w:t></w:r></w:p>`;
    }
    if (text.trim()) {
      const style = styleName(/<w:pStyle w:val="([^"]+)"/.exec(ppr)?.[1] ?? "");
      const kind: Block["kind"] = /title/.test(style) && !seenName ? "name" : /heading/.test(style) ? "heading"
        : /<w:numPr>/.test(ppr) || /list/.test(style) || GLYPH.test(text) && /^\s*[•·▪●*-]/.test(text) ? "bullet"
        : !seenName && !paragraphs.length ? "name" : "line";
      if (kind === "name") seenName = true;
      paragraphs.push({ kind, text: kind === "bullet" ? text.replace(GLYPH, "") : text });
    }
    return body;
  });
  // The ZIP writer takes a string (written as UTF-8) or its own byte type; the other parts go back exactly as read.
  const entries = [...parts].map(([name, data]) => ({ name, data: name === "word/document.xml" ? out : data }));
  return { ok: true, buffer: P.zipBuffer(entries), replaced, missing: todo.filter((s) => !s.done).map((s) => s.before), paragraphs };
}

// ---------------------------------------------------------------- the whole render
export interface Designed {
  ok: true; layout: LayoutName; pdf: Uint8Array; docx: Uint8Array; fit: Fit; sameText: boolean; lines: string[];
  parseCheck: { status: string; fails: string[]; warnings: string[] }; replaced?: number; missing?: string[];
}
const words = (lines: string[]) => lines.join(" ").replace(/•/g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
// The two files carry the same words in the same order, read back out of the files themselves by 148's parsers.
// deno-lint-ignore no-explicit-any
export function sameText(R: any, pdf: Uint8Array, docx: Uint8Array): boolean {
  return words(R.extractPdfLines(R.primitives.bytes(pdf))) === words(R.extractDocxLines(R.primitives.bytes(docx)));
}
// deno-lint-ignore no-explicit-any
export function renderDesigned(R: any, resume: any, o: { layout: LayoutName; ownDocx?: Uint8Array | null; swaps?: Swap[] }): Designed | { ok: false; reason: string } {
  if (!R?.primitives) return { ok: false, reason: "the renderer has no byte primitives here" };
  if (!resume || resume.ok === false || resume.refused === true) return { ok: false, reason: "the truth check refused the resume; nothing is rendered" };
  let blocks: Block[], pal: Palette, docx: Uint8Array, docxPrinted: string[] | null, extra: { replaced?: number; missing?: string[] } = {};
  let sourceLines: { text: string; kind: string }[] | null = null;
  if (o.layout === "own") {
    if (!o.ownDocx?.length) return { ok: false, reason: "Keep my layout needs your resume as a Word file (.docx); the file on record is not one" };
    const own = ownDocx(R, o.ownDocx, o.swaps ?? []);
    if (!own.ok) return own;
    if (!own.paragraphs.length) return { ok: false, reason: "your Word file has no text to keep" };
    blocks = own.paragraphs.map((p) => ({ kind: p.kind, text: p.text }));
    pal = PLAIN_PALETTE; docx = own.buffer; docxPrinted = null; extra = { replaced: own.replaced, missing: own.missing };
    sourceLines = own.paragraphs.map((p) => ({ text: p.text, kind: p.kind === "heading" ? "line" : p.kind }));
  } else {
    blocks = traineeBlocks(resume); pal = TRAINEE_PALETTE; docxPrinted = []; docx = new Uint8Array();
  }
  if (!blocks.length) return { ok: false, reason: "the resume has no lines to print" };
  const { fit: f, set } = fit(blocks, pal);
  if (o.layout === "trainee") { const d = traineeDocx(R, blocks, f, pal); docx = d.buffer; docxPrinted = d.printed; }
  const pdf = writePdf(R, set);
  const check = o.layout === "trainee"
    ? R.parseCheck({ resume, pdf: R.primitives.bytes(pdf), docx: R.primitives.bytes(docx) }, { expected: { pdf: set.printed, docx: docxPrinted } })
    : R.parseCheck({ sourceLines, pdf: R.primitives.bytes(pdf), docx: R.primitives.bytes(docx) }, { expected: { pdf: set.printed } });
  // deno-lint-ignore no-explicit-any
  const fails = check.reasons.filter((r: any) => r.level === "fail").map((r: any) => `${r.check}: ${r.detail}`);
  // deno-lint-ignore no-explicit-any
  const warnings = check.reasons.filter((r: any) => r.level === "warn").map((r: any) => `${r.check}: ${r.detail}`);
  if (f.over) warnings.push(`page_fit: the record needs ${f.pages} pages at 10 pt with the tightest spacing; nothing was cut and no text was set smaller`);
  const same = sameText(R, pdf, docx);
  if (!same) fails.push("same_text: the PDF and the DOCX do not carry the same words in the same order");
  const lines = o.layout === "trainee" ? docxPrinted! : sourceLines!.map((l) => l.text);
  return { ok: true, layout: o.layout, pdf, docx, fit: f, sameText: same, lines, parseCheck: { status: fails.length ? "FAIL" : warnings.length ? "WARN" : "PASS", fails, warnings }, ...extra };
}

// "Keep my layout" reads the person's newest Word upload: the release-8 clean copy, which is what career_resume_uploads stores
// for a .docx (channel_resume_upload.ts ingestResumeFile). None, or one that is not a Word file: null, and the layout is refused.
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// deno-lint-ignore no-explicit-any
export function supabaseOwnDocx(admin: any): (userId: string) => Promise<Uint8Array | null> {
  return async (u) => {
    const r = await admin.from("career_resume_uploads").select("content_b64").eq("user_id", u).eq("mime", DOCX_MIME).order("created_at", { ascending: false }).limit(1);
    const b64 = r.error ? null : r.data?.[0]?.content_b64;
    if (typeof b64 !== "string" || !b64) return null;
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
}
