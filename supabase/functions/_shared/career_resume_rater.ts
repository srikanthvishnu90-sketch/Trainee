// RELEASE 10: the format rater. It scores the person's own resume file 0-100 on measured criteria only, read from the file's
// real geometry (career_resume_geometry.ts: pdf.js positions and widths for a PDF, resolved paragraph properties for a DOCX),
// and names the exact line or element behind every finding. It never guesses: a criterion it cannot measure in a file says
// so and scores nothing either way (it is left out of the total, and the total is rescaled to 100).
//
// The criteria and their points (docs/architect/specs/RESUME-TEMPLATES.md, "The rater", has the evidence for each):
//   columns       15 hard  one column, read in reading order (the file's own text order matches top-to-bottom order)
//   headings       8       standard section headings (Experience, Education, Skills ...)
//   type          10       body 10-12 pt, nothing under 9 pt, common ATS-safe faces
//   margins        8       every margin 0.5-1 in (the bottom only at least 0.5 in: a short page ends early)
//   edges         10       left edges and indents consistent: every bullet's glyph x and text x within ±0.5 pt
//   dates          8       dates aligned one way: all flush right to one x (±0.5 pt) or all starting at one x
//   gaps           7       vertical gaps between same-level blocks equal (±0.5 pt)
//   containers    10 hard  no tables, text boxes, columns or images holding text
//   length         6       pages right for the experience level (1 under ~5 years, at most 2 after; 3+ only for a CV)
//   contact        8 hard  name, email and phone in the body's first lines (not in a header or footer part)
//   roundtrip     10 hard  two independent extractions give the same words in the same order, and the text is real text
// KEEP rule: score >= KEEP_MIN and no hard failure: keep their format and change only the content.
// deno-lint-ignore-file no-explicit-any
import { DATE_RANGE, type DocxGeometry, type DocxPara, isGlyph, type PdfGeometry, type PdfLine, readDocxGeometry, readPdfGeometry, wordsOf } from "./career_resume_geometry.ts";
import { CareerRender } from "./router_core.career.js";
import { type LibraryId, type Level, type RoleFamily, TEMPLATES, type TemplateSpec } from "./career_resume_templates.ts";

export const KEEP_MIN = 85;
export const TOL = 0.5;
export type Criterion = "columns" | "headings" | "type" | "margins" | "edges" | "dates" | "gaps" | "containers" | "length" | "contact" | "roundtrip";
export const POINTS: Record<Criterion, number> = { columns: 15, headings: 8, type: 10, margins: 8, edges: 10, dates: 8, gaps: 7, containers: 10, length: 6, contact: 8, roundtrip: 10 };
export const HARD: Criterion[] = ["columns", "containers", "contact", "roundtrip"];
export interface Finding { criterion: Criterion; points: number; max: number; pass: boolean; hard: boolean; measured: boolean; detail: string; where: string[] }
// parseCheckFails (DOCX only): what 148's parse-check refuses in the file as it is. A kept Word file goes out as their own file,
// so the rater keeps one only when the gate every sent file passes would pass it too (review of #620: the two must agree).
export interface Rating { kind: "pdf" | "docx"; score: number; findings: Finding[]; hardFailures: Criterion[]; keep: boolean; pages: number; measured: Measured; parseCheckFails: string[] }
export interface Measured { margins: { top: number; right: number; bottom: number; left: number } | null; bodyPt: number | null; faces: string[]; bulletX: number | null; bulletTextX: number | null; leadPt: number | null; headingCase: "upper" | "title" | null; headingRule: "below" | "above" | "none" | null; datesFlushRight: boolean | null; years: number | null; entries: number }

const STANDARD_HEADING = /^(summary|professional summary|profile|objective|skills|technical skills|core skills|experience|work experience|professional experience|relevant experience|employment|employment history|work history|projects|education|research|research experience|publications|leadership|activities|leadership (?:&|and) activities|certifications|licenses|awards|honors|honors (?:&|and) awards|coursework|relevant coursework|volunteer(?: experience)?|additional|additional information|languages|interests)$/i;
const SAFE_FACE = /^(arial|helvetica|calibri|cambria|carlito|caladea|times|timesnewroman|times new roman|georgia|garamond|ebgaramond|book antiqua|palatino|verdana|tahoma|trebuchet|segoe|lato|roboto|open ?sans|source ?sans|liberation ?(?:sans|serif)|dejavu ?(?:sans|serif)|aptos|gill ?sans|helvetica ?neue|inter|courier|couriernew|georgia)/i;
const faceFamily = (n: string) => n.replace(/[-,](?:bold|italic|regular|oblique|boldmt|mt|semibold|light|medium|black|bolditalic|it|psmt|ps).*/i, "").replace(/(?:PSMT|MT|PS)$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
const fmt = (n: number) => `${Math.round(n * 100) / 100}`;
const mode = (xs: number[]) => { const c = new Map<number, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null; };
const clusters = (xs: number[], tol = TOL) => { const s = [...xs].sort((a, b) => a - b), out: number[][] = []; for (const x of s) { const c = out[out.length - 1]; if (c && x - c[c.length - 1] <= tol) c.push(x); else out.push([x]); } return out; };
const YEAR = /\b(19[6-9]\d|20[0-4]\d)\b/g;
function yearsOf(dateTexts: string[], now = 2026): number | null {
  const ys = dateTexts.flatMap((t) => [...t.matchAll(YEAR)].map((m) => +m[1]).concat(/present|current|now/i.test(t) ? [now] : []));
  return ys.length ? Math.max(...ys) - Math.min(...ys) : null;
}
function finding(c: Criterion, frac: number | null, detail: string, where: string[] = []): Finding {
  const max = POINTS[c], measured = frac !== null;
  const f = Math.max(0, Math.min(1, frac ?? 0));
  return { criterion: c, max, points: measured ? Math.round(max * f * 10) / 10 : 0, pass: measured ? f >= 0.999 : true, hard: HARD.includes(c), measured, detail, where: where.slice(0, 8) };
}

// ---------------------------------------------------------------- PDF
export async function ratePdf(bytes: Uint8Array, o: { R?: any; cv?: boolean } = {}): Promise<Rating> {
  const g: PdfGeometry = await readPdfGeometry(bytes);
  const F: Finding[] = [], lines = g.lines, pages = g.pages.length;
  const W = g.pages[0]?.w ?? 612, H = g.pages[0]?.h ?? 792;
  const textWords = wordsOf(g.streamText);
  // containers: images, and a PDF with next to no text (a scan)
  if (textWords.length < 40) F.push(finding("containers", 0, `the file has ${textWords.length} words of real text; the rest is an image or a scan, which an applicant tracking system cannot read`, [`${g.images} image(s)`]));
  else F.push(finding("containers", g.images === 0 ? 1 : 0.5, g.images ? `${g.images} image(s) on the page; any words in them are invisible to a parser` : "no images; every word is real text", g.images ? [`${g.images} image(s)`] : []));
  // body size and faces
  const sizes = g.items.flatMap((i) => Array(Math.max(1, i.str.length)).fill(Math.round(i.size * 2) / 2));
  const body = mode(sizes);
  const small = g.items.filter((i) => i.size < 9 - 1e-6);
  const glyphOnly = new Set(g.fonts.map((f) => f.name).filter((n) => g.items.filter((i) => i.font === n).every((i) => isGlyph(i.str))));
  const faces = [...new Set(g.fonts.filter((f) => !glyphOnly.has(f.name)).map((f) => faceFamily(f.name)))];
  const oddFaces = faces.filter((f) => !SAFE_FACE.test(f.replace(/\s+/g, " ")) && !SAFE_FACE.test(f.replace(/\s+/g, "")));
  F.push(finding("type", body === null ? null : (body >= 10 && body <= 12 ? 0.6 : 0) + (small.length ? 0 : 0.2) + (oddFaces.length ? 0 : 0.2),
    body === null ? "no text to measure" : `body text ${fmt(body)} pt${body < 10 || body > 12 ? " (10-12 pt reads best)" : ""}; ${small.length ? `${small.length} run(s) under 9 pt` : "nothing under 9 pt"}; faces: ${faces.join(", ")}${oddFaces.length ? ` (${oddFaces.join(", ")} is not a common ATS-safe face)` : ""}`,
    [...small.slice(0, 4).map((i) => `"${i.str.slice(0, 40)}" at ${fmt(i.size)} pt`), ...oddFaces.map((f) => `font ${f}`)]));
  // margins, from the text's own extent on every page
  const xs0 = g.items.map((i) => i.x), xs1 = g.items.map((i) => i.x + i.w), ys = g.items.map((i) => i.y);
  const m = g.items.length ? { left: Math.min(...xs0), right: W - Math.max(...xs1), top: H - Math.max(...g.items.map((i) => i.y + i.size * 0.75)), bottom: Math.min(...ys) - 2 } : null;
  if (m) {
    // The right margin is where the longest lines end; when no line comes within an inch of the edge it cannot be told from
    // the text (short lines), so only a margin under half an inch counts against it. The bottom is only ever too tight.
    const bad = (["left", "top"] as const).filter((k) => m[k] < 36 - TOL || m[k] > 72 + TOL).map((k) => `${k} ${fmt(m[k] / 72)} in`);
    if (m.right < 36 - TOL) bad.push(`right ${fmt(m.right / 72)} in`);
    if (m.bottom < 36 - TOL - 2) bad.push(`bottom ${fmt(m.bottom / 72)} in`);
    F.push(finding("margins", 1 - bad.length / 4, `margins (from the text's extent): left ${fmt(m.left / 72)} in, top ${fmt(m.top / 72)} in, right ${m.right <= 72 + TOL ? `${fmt(m.right / 72)} in` : `at least ${fmt(m.right / 72)} in (no line reaches it)`}${bad.length ? `; outside 0.5-1 in: ${bad.join(", ")}` : ""}`, bad));
  } else F.push(finding("margins", null, "no text to measure"));
  // columns and reading order: text lines that start right of 40% of the page and are not a flush-right date are a second column
  const left = m?.left ?? 0;
  const second = lines.filter((l) => l.items.some((it) => it.x > W * 0.4 && !DATE_RANGE.test(it.str.trim()) && !(near(it.x + it.w, W - (m?.right ?? 0)) && it.str.length < 40) && l.items[0].x > W * 0.4));
  const streamOrder = wordsOf(g.streamText).join(" "), readingOrder = wordsOf(lines.map((l) => l.text)).join(" ");
  const ordered = streamOrder === readingOrder;
  F.push(finding("columns", second.length === 0 && ordered ? 1 : second.length <= 1 && ordered ? 0.7 : 0,
    second.length ? `${second.length} line(s) start in a second column` : ordered ? "one column, and the file's own text order is the reading order" : "the file's text order is not top-to-bottom reading order (a parser reads it scrambled)",
    second.slice(0, 5).map((l) => `p${l.page + 1}: "${l.text.slice(0, 50)}" at x ${fmt(l.items[0].x)}`).concat(ordered ? [] : [firstDiff(streamOrder, readingOrder)])));
  // headings
  const headingLines = lines.filter((l) => l.items.length <= 2 && l.text.length <= 40 && !DATE_RANGE.test(l.text) && (l.items[0].bold || /^[^a-z]+$/.test(l.text)) && /^[A-Za-z &/]+$/.test(l.text));
  const std = headingLines.filter((l) => STANDARD_HEADING.test(l.text.trim()));
  const keys = new Set(std.map((l) => l.text.toLowerCase()));
  const core = ["experience", "education", "skills"].filter((k) => [...keys].some((h) => h.includes(k))).length;
  const odd = headingLines.filter((l) => /^[^a-z]+$/.test(l.text) && !STANDARD_HEADING.test(l.text.trim()) && l !== lines[0]);
  F.push(finding("headings", Math.min(1, core / 2) * (odd.length ? 0.75 : 1), `standard headings found: ${std.map((l) => l.text).join(", ") || "none"}${odd.length ? `; non-standard: ${odd.map((l) => l.text).join(", ")}` : ""}`, odd.map((l) => `p${l.page + 1}: "${l.text}"`)));
  // edges: bullets
  const bullets = lines.filter((l) => isGlyph(l.items[0].str) && l.items.length > 1);
  const glyphX = clusters(bullets.map((l) => l.items[0].x)), textX = clusters(bullets.map((l) => l.items[1].x));
  const conts = lines.filter((l, i) => i > 0 && !isGlyph(l.items[0].str) && bullets.length && Math.abs(l.items[0].x - (textX[0]?.[0] ?? -99)) <= 3);
  const contX = clusters(conts.map((l) => l.items[0].x));
  const leftEdges = clusters(lines.filter((l) => !isGlyph(l.items[0].str) && l.items[0].x < W * 0.4 && Math.abs(l.items[0].x - left) <= 6).map((l) => l.items[0].x));
  const edgeIssues: string[] = [];
  if (glyphX.length > 1) edgeIssues.push(`bullet glyphs at ${glyphX.length} different x: ${glyphX.map((c) => fmt(c[0])).join(", ")}`);
  if (textX.length > 1) edgeIssues.push(`bullet text at ${textX.length} different x: ${textX.map((c) => fmt(c[0])).join(", ")}`);
  if (contX.length && textX.length && !near(contX[0][0], textX[0][0])) edgeIssues.push(`wrapped bullet lines at x ${fmt(contX[0][0])}, not the bullet text's ${fmt(textX[0][0])}`);
  if (leftEdges.length > 1) edgeIssues.push(`the left edge sits at ${leftEdges.length} x: ${leftEdges.map((c) => fmt(c[0])).join(", ")}`);
  const offenders = bullets.filter((l) => glyphX.length > 1 && !near(l.items[0].x, mode(bullets.map((b) => Math.round(b.items[0].x * 2) / 2))!)).slice(0, 5).map((l) => `p${l.page + 1}: "${l.text.slice(0, 50)}" glyph at x ${fmt(l.items[0].x)}`);
  F.push(finding("edges", 1 - Math.min(1, edgeIssues.length / 3), edgeIssues.length ? edgeIssues.join("; ") : bullets.length ? `${bullets.length} bullets share one glyph x and one hanging indent` : "no bullets; left edges consistent", offenders));
  // dates
  const dateItems = g.items.filter((i) => DATE_RANGE.test(i.str.trim()) || /\b(19|20)\d{2}\s*[–—-]\s*((19|20)\d{2}|present|current)\b/i.test(i.str));
  const pageRight = W - (m?.right ?? 0);
  const right = dateItems.filter((i) => near(i.x + i.w, pageRight) || i.x > W * 0.6), leftD = dateItems.filter((i) => !right.includes(i));
  const rightEnds = clusters(right.map((i) => i.x + i.w)), leftStarts = clusters(leftD.map((i) => i.x), 1);
  const dateIssues: string[] = [];
  if (right.length && leftD.length) dateIssues.push(`${right.length} date(s) flush right and ${leftD.length} elsewhere`);
  if (rightEnds.length > 1) dateIssues.push(`flush-right dates end at ${rightEnds.length} different x: ${rightEnds.map((c) => fmt(c[0])).join(", ")}`);
  if (!right.length && leftStarts.length > 1) dateIssues.push(`dates start at ${leftStarts.length} different x`);
  F.push(finding("dates", dateItems.length ? 1 - Math.min(1, dateIssues.length / 2) : null, dateItems.length ? (dateIssues.join("; ") || `${dateItems.length} dates, aligned ${right.length ? "flush right" : "at one x"}`) : "no dates found to measure",
    (right.length && leftD.length ? leftD : []).slice(0, 5).map((i) => `p${i.page + 1}: "${i.str}" at x ${fmt(i.x)}`)));
  // gaps between same-level blocks
  const gapRes = pdfGaps(lines, textX[0]?.[0] ?? null);
  F.push(finding("gaps", gapRes.checked ? 1 - Math.min(1, gapRes.bad.length / Math.max(3, gapRes.checked / 3)) : null, gapRes.bad.length ? `${gapRes.bad.length} gap(s) differ from the rest of their kind` : `${gapRes.checked} same-level gaps, all equal`, gapRes.bad));
  // length
  const entries = lines.filter((l) => l.items.some((i) => DATE_RANGE.test(i.str.trim()))).length;
  const years = yearsOf(dateItems.map((i) => i.str));
  F.push(lengthFinding(pages, years, !!o.cv));
  // contact
  F.push(contactFinding(lines.filter((l) => l.page === 0).slice(0, 6).map((l) => l.text), []));
  // round trip: pdf.js's text layer (getTextContent: its own glyph-to-text mapping and line building) against the operator walk
  // that measured the geometry, word for word, and the text must be real text (no replacement or private-use characters).
  const layer = wordsOf(await textLayer(bytes)).join(" ");
  const junk = g.items.filter((i) => !isGlyph(i.str) && /[\uFFFD\uE000-\uF8FF]/.test(i.str) || (i.str.length > 3 && !/[\p{L}\p{N}]/u.test(i.str)));
  const agree = layer === streamOrder;
  const notes: string[] = junk.slice(0, 3).map((i) => `p${i.page + 1}: unreadable text "${i.str.slice(0, 20)}"`);
  // 148's own PDF parser (router_core) is reported beside it, never scored: it does not read every embedded font's map.
  if (o.R) { const ours = wordsOf((o.R.extractPdfRuns(o.R.toBuffer(bytes)) as any[]).map((r) => r.text)).join(" "); if (ours !== readingOrder) notes.push(`148's in-repo parser reads ${Math.round(similarity(ours, readingOrder) * 100)}% of the words (not scored)`); }
  const roundtrip = finding("roundtrip", textWords.length < 40 || junk.length > 2 ? 0 : agree && ordered ? 1 : similarity(layer, streamOrder) >= 0.98 && ordered ? 0.5 : 0,
    textWords.length < 40 ? "too little real text to read back" : junk.length > 2 ? `${junk.length} runs read back as unreadable characters (a font with no text map)` : agree && ordered ? "two independent readings give the same words in the same order" : `the two readings disagree: ${firstDiff(layer, streamOrder)}`, notes);
  F.push(roundtrip);
  const measured: Measured = { margins: m, bodyPt: body, faces, bulletX: glyphX[0]?.[0] ?? null, bulletTextX: textX[0]?.[0] ?? null, leadPt: mode(lines.slice(1).map((l, i) => Math.round((lines[i].y - l.y) * 2) / 2).filter((d) => d > 0 && d < 30)),
    headingCase: std.length ? (std.every((l) => /^[^a-z]+$/.test(l.text)) ? "upper" : "title") : null, headingRule: pdfHeadingRule(std, g), datesFlushRight: dateItems.length ? leftD.length === 0 : null, years, entries };
  return total("pdf", F, pages, measured);
}
async function textLayer(bytes: Uint8Array): Promise<string[]> {
  const pdfjs: any = await import("npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs"); // the same pin as career_resume_geometry.ts PDFJS
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) { const page = await doc.getPage(p); for (const it of (await page.getTextContent()).items as any[]) if (typeof it.str === "string") out.push(it.str); }
  await doc.destroy();
  return out;
}
function pdfHeadingRule(heads: PdfLine[], g: PdfGeometry): Measured["headingRule"] {
  if (!heads.length) return null;
  const below = heads.filter((h) => g.rules.some((r) => r.page === h.page && h.y - r.y > 0 && h.y - r.y < 8)).length;
  const above = heads.filter((h) => g.rules.some((r) => r.page === h.page && r.y - h.y > 0 && r.y - h.y < h.items[0].size * 1.6)).length;
  return below === heads.length ? "below" : above === heads.length ? "above" : below + above === 0 ? "none" : null;
}
function pdfGaps(lines: PdfLine[], textX: number | null): { checked: number; bad: string[] } {
  type K = "heading" | "entry" | "bullet" | "line";
  const kindOf = (l: PdfLine): K | "cont" => isGlyph(l.items[0].str) && l.items.length > 1 ? "bullet" : textX !== null && near(l.items[0].x, textX) ? "cont"
    : l.items.length <= 2 && STANDARD_HEADING.test(l.text.trim()) ? "heading" : l.items.some((i) => DATE_RANGE.test(i.str.trim())) ? "entry" : "line";
  const blocks: { k: K; first: PdfLine; last: PdfLine }[] = [];
  let started = false;
  for (const l of lines) {
    const k = kindOf(l);
    if (k === "heading") started = true;
    if (!started) continue;
    const b = blocks[blocks.length - 1];
    if (k === "cont" && b) b.last = l; else blocks.push({ k: k === "cont" ? "line" : k, first: l, last: l });
  }
  const groups = new Map<string, { gap: number; l: PdfLine }[]>();
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1], b = blocks[i];
    if (a.last.page !== b.first.page || !["heading", "entry"].includes(b.k)) continue; // the block-level transitions
    const key = `${a.k}->${b.k}`;
    groups.set(key, [...(groups.get(key) ?? []), { gap: Math.round((a.last.y - b.first.y) * 100) / 100, l: b.first }]);
  }
  const bad: string[] = [];
  let checked = 0;
  for (const [key, xs] of groups) {
    checked += xs.length;
    const usual = mode(xs.map((x) => Math.round(x.gap * 2) / 2))!;
    for (const x of xs) if (Math.abs(x.gap - usual) > TOL) bad.push(`p${x.l.page + 1}: ${key} before "${x.l.text.slice(0, 40)}" is ${fmt(x.gap)} pt (usual ${fmt(usual)} pt)`);
  }
  return { checked, bad };
}

// ---------------------------------------------------------------- DOCX
export function rateDocx(R: any, bytes: Uint8Array, o: { cv?: boolean } = {}): Rating {
  const d: DocxGeometry = readDocxGeometry(R, bytes);
  const F: Finding[] = [], P = d.paras.filter((p) => !p.inTextBox && !p.inTable);
  const all = d.paras;
  // containers
  const holders: string[] = [];
  if (d.tableTextCells) holders.push(`${d.tables} table(s) with ${d.tableTextCells} cell(s) of text`);
  if (d.textBoxes) holders.push(`${d.textBoxes} text box(es): ${all.filter((p) => p.inTextBox).slice(0, 2).map((p) => `"${p.text.slice(0, 30)}"`).join(", ")}`);
  if (d.images) holders.push(`${d.images} image(s)`);
  F.push(finding("containers", holders.length ? 0 : 1, holders.length ? `text is held outside the page's flow: ${holders.join("; ")}` : "no tables, text boxes or images", holders));
  // columns
  const tableCols = d.tableTextCells > 1;
  F.push(finding("columns", d.columns > 1 || tableCols ? 0 : 1, d.columns > 1 ? `the page is set in ${d.columns} columns` : tableCols ? "a table lays text out side by side" : "one column", d.columns > 1 ? [`<w:cols w:num="${d.columns}">`] : []));
  // type
  const weighted = all.flatMap((p) => Array(Math.max(1, p.text.length)).fill(p.sizes[0]));
  const body = mode(weighted.map((s) => Math.round(s * 2) / 2));
  const small = all.filter((p) => p.sizes.some((s) => s < 9));
  const faces = [...new Set(all.flatMap((p) => p.fonts))].filter((f) => !/^(symbol|wingdings|opensymbol)$/i.test(f));
  const oddFaces = faces.filter((f) => !SAFE_FACE.test(f));
  F.push(finding("type", body === null ? null : (body >= 10 && body <= 12 ? 0.6 : 0) + (small.length ? 0 : 0.2) + (oddFaces.length ? 0 : 0.2),
    body === null ? "no text" : `body text ${fmt(body)} pt; ${small.length ? `${small.length} paragraph(s) under 9 pt` : "nothing under 9 pt"}; faces: ${faces.join(", ")}`, [...small.slice(0, 4).map((p) => `"${p.text.slice(0, 40)}" at ${p.sizes.join("/")} pt`), ...oddFaces.map((f) => `font ${f}`)]));
  // margins from the section properties
  const M = d.margins, bad = (["left", "right", "top"] as const).filter((k) => M[k] < 36 - TOL || M[k] > 72 + TOL).map((k) => `${k} ${fmt(M[k] / 72)} in`);
  if (M.bottom < 36 - TOL) bad.push(`bottom ${fmt(M.bottom / 72)} in`);
  F.push(finding("margins", 1 - bad.length / 4, `margins: left ${fmt(M.left / 72)} in, right ${fmt(M.right / 72)} in, top ${fmt(M.top / 72)} in, bottom ${fmt(M.bottom / 72)} in${bad.length ? `; outside 0.5-1 in: ${bad.join(", ")}` : ""}`, bad));
  // headings
  const headingParas = P.filter((p) => (p.outline || (p.bold && p.text.length <= 40 && /^[A-Za-z &/]+$/.test(p.text))) && !DATE_RANGE.test(p.text));
  const std = headingParas.filter((p) => STANDARD_HEADING.test(p.text));
  const core = ["experience", "education", "skills"].filter((k) => std.some((p) => p.text.toLowerCase().includes(k))).length;
  const odd = headingParas.filter((p) => p !== P[0] && !STANDARD_HEADING.test(p.text) && (p.outline || /^[^a-z]+$/.test(p.text) || p.caps));
  F.push(finding("headings", Math.min(1, core / 2) * (odd.length ? 0.75 : 1), `standard headings: ${std.map((p) => p.text).join(", ") || "none"}${odd.length ? `; non-standard: ${odd.map((p) => p.text).join(", ")}` : ""}`, odd.map((p) => `"${p.text}"`)));
  // edges: a bullet is a numbered paragraph or one that starts with a glyph; its hanging indent and left
  const bullets = P.filter((p) => p.numbered || isGlyph(p.text[0] ?? ""));
  const lefts = clusters(bullets.map((p) => p.left)), hangs = clusters(bullets.map((p) => p.hanging));
  const plainLefts = clusters(P.filter((p) => !bullets.includes(p)).map((p) => p.left + p.firstLine));
  const edgeIssues: string[] = [];
  if (lefts.length > 1) edgeIssues.push(`bullet text indents at ${lefts.length} values: ${lefts.map((c) => fmt(c[0])).join(", ")} pt`);
  if (hangs.length > 1) edgeIssues.push(`bullet hanging indents at ${hangs.length} values: ${hangs.map((c) => fmt(c[0])).join(", ")} pt`);
  if (plainLefts.length > 2) edgeIssues.push(`other paragraphs start at ${plainLefts.length} indents: ${plainLefts.map((c) => fmt(c[0])).join(", ")} pt`);
  const usualLeft = mode(bullets.map((p) => p.left));
  F.push(finding("edges", 1 - Math.min(1, edgeIssues.length / 3), edgeIssues.join("; ") || `${bullets.length} bullets share one indent`, bullets.filter((p) => usualLeft !== null && !near(p.left, usualLeft)).slice(0, 5).map((p) => `"${p.text.slice(0, 50)}" indented ${fmt(p.left)} pt`)));
  // dates: right tab stops vs. text
  const dated = P.filter((p) => /\b(19|20)\d{2}\b/.test(p.text) && /\b(19|20)\d{2}\s*[–—-]|[–—-]\s*(present|current)|\b(19|20)\d{2}\s*$/i.test(p.text));
  const rightTab = dated.filter((p) => p.tabs.some((t) => t.val === "right") || p.align === "right");
  const tabPos = clusters(rightTab.flatMap((p) => p.tabs.filter((t) => t.val === "right").map((t) => t.pos)));
  const dateIssues: string[] = [];
  if (rightTab.length && rightTab.length < dated.length) dateIssues.push(`${rightTab.length} dated line(s) use a right tab and ${dated.length - rightTab.length} do not`);
  if (tabPos.length > 1) dateIssues.push(`right tabs at ${tabPos.length} positions: ${tabPos.map((c) => fmt(c[0])).join(", ")} pt`);
  const spaceAligned = dated.filter((p) => /\S {3,}\S/.test(p.text));
  if (spaceAligned.length) dateIssues.push(`${spaceAligned.length} date(s) pushed right with spaces (they never line up)`);
  F.push(finding("dates", dated.length ? 1 - Math.min(1, dateIssues.length / 2) : null, dated.length ? dateIssues.join("; ") || `${dated.length} dated lines, aligned one way` : "no dates found", [...dated.filter((p) => !rightTab.includes(p)), ...spaceAligned].slice(0, 5).map((p) => `"${p.text.slice(0, 60)}"`)));
  // gaps: space before entries and headings
  const kindOf = (p: DocxPara) => (STANDARD_HEADING.test(p.text) ? "heading" : dated.includes(p) ? "entry" : bullets.includes(p) ? "bullet" : "line");
  const groups = new Map<string, { gap: number; p: DocxPara }[]>();
  let started = false;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], kb = kindOf(b);
    if (kindOf(a) === "heading") started = true;
    if (!started || !["heading", "entry"].includes(kb)) continue;
    const key = `${kindOf(a)}->${kb}`;
    groups.set(key, [...(groups.get(key) ?? []), { gap: Math.max(a.after, b.before), p: b }]);
  }
  const gapBad: string[] = [];
  let checked = 0;
  for (const [key, xs] of groups) {
    checked += xs.length;
    const usual = mode(xs.map((x) => x.gap))!;
    for (const x of xs) if (Math.abs(x.gap - usual) > TOL) gapBad.push(`${key} before "${x.p.text.slice(0, 40)}" is ${fmt(x.gap)} pt (usual ${fmt(usual)} pt)`);
  }
  F.push(finding("gaps", checked ? 1 - Math.min(1, gapBad.length / Math.max(3, checked / 3)) : null, gapBad.length ? `${gapBad.length} gap(s) differ from the rest of their kind` : `${checked} same-level gaps, all equal`, gapBad));
  // length: estimated pages from the paragraphs' lines (rough: the DOCX has no page geometry until it is laid out)
  const lineH = (p: DocxPara) => (p.line && p.lineRule === "exact" ? p.line / 20 : (p.sizes[0] ?? 11) * 1.2 * (p.line && p.lineRule === "auto" ? p.line / 240 : 1));
  const usable = d.page.h - M.top - M.bottom, width = d.page.w - M.left - M.right;
  const height = all.reduce((h, p) => h + p.before + p.after + lineH(p) * Math.max(1, Math.ceil((p.text.length * (p.sizes[0] ?? 11) * 0.5) / Math.max(100, width - p.left))), 0);
  const pages = Math.max(1, Math.ceil(height / usable));
  const years = yearsOf(dated.map((p) => p.text));
  F.push(lengthFinding(pages, years, !!o.cv, true));
  F.push(contactFinding(P.slice(0, 6).map((p) => p.text), d.headerFooterText));
  // round trip: the paragraph walk here against 148's DOCX parser, in order
  const ours = wordsOf(all.filter((p) => !p.inTextBox).map((p) => p.text)).join(" ");
  const theirs = wordsOf(R.extractDocxLines(R.toBuffer(bytes))).join(" ");
  const textBoxWords = wordsOf(all.filter((p) => p.inTextBox).map((p) => p.text)).length;
  F.push(finding("roundtrip", ours === theirs && !textBoxWords ? 1 : similarity(ours, theirs) >= 0.98 && !textBoxWords ? 0.5 : 0,
    ours === theirs && !textBoxWords ? "two independent parsers read the same words in the same order" : textBoxWords ? `${textBoxWords} word(s) sit in text boxes a parser may skip or misplace` : `two parsers disagree: ${firstDiff(ours, theirs)}`));
  const headCase = std.length ? (std.every((p) => /^[^a-z]+$/.test(p.text) || p.caps) ? "upper" : "title") : null;
  // 148's own gate on the file as it is (structure: sizes of the styles in use, tables, text frames, images; both parsers).
  const pc = R.parseCheck({ docx: R.toBuffer(bytes) }, {});
  const parseCheckFails = (pc.reasons as any[]).filter((x) => x.level === "fail").map((x) => `${x.check}: ${x.detail}`);
  return total("docx", F, pages, { margins: M, bodyPt: body, faces, bulletX: hangs.length && lefts.length ? lefts[0][0] - hangs[0][0] : null, bulletTextX: lefts[0]?.[0] ?? null, leadPt: null, headingCase: headCase, headingRule: std.length ? (std.every((p) => p.border) ? "below" : std.some((p) => p.border) ? null : "none") : null, datesFlushRight: dated.length ? rightTab.length === dated.length : null, years, entries: dated.length }, parseCheckFails);
}

// ---------------------------------------------------------------- shared
function lengthFinding(pages: number, years: number | null, cv: boolean, estimated = false): Finding {
  const est = estimated ? " (estimated from the paragraphs)" : "";
  if (cv) return finding("length", 1, `${pages} page(s)${est}; a CV has no page limit`);
  if (years === null) return finding("length", pages <= 2 ? 1 : 0, `${pages} page(s)${est}; no dates to tell the experience level`);
  const limit = years < 5 ? 1 : 2;
  return finding("length", pages <= limit ? 1 : pages === limit + 1 ? 0.4 : 0, `${pages} page(s)${est} for about ${years} year(s) of dates; ${limit} page${limit > 1 ? "s" : ""} is the norm`, pages > limit ? [`${pages} pages`] : []);
}
function contactFinding(top: string[], headerFooter: string[]): Finding {
  const t = top.join(" "), hf = headerFooter.join(" ");
  const email = EMAIL.test(t), phone = PHONE.test(t), name = top.slice(0, 3).some((l) => /^\p{L}[\p{L}'.-]+(?:\s+\p{L}[\p{L}'.-]+){1,3}$/u.test(l.trim()));
  const inHf = (!email && EMAIL.test(hf)) || (!phone && PHONE.test(hf));
  const got = [name && "name", email && "email", phone && "phone"].filter(Boolean);
  const frac = !email ? 0 : (name ? 0.4 : 0) + 0.4 + (phone ? 0.2 : 0);
  return finding("contact", frac, `${got.length ? `found at the top: ${got.join(", ")}` : "no contact details at the top"}${inHf ? "; the contact details are in the page header or footer, which many parsers skip" : ""}${!email ? "; no email in the body's first lines" : ""}`, inHf ? ["header/footer part"] : []);
}
function similarity(a: string, b: string): number {
  const A = a.split(" "), B = new Map<string, number>();
  for (const w of b.split(" ")) B.set(w, (B.get(w) ?? 0) + 1);
  let hit = 0; for (const w of A) { const n = B.get(w) ?? 0; if (n) { hit++; B.set(w, n - 1); } }
  return A.length ? hit / Math.max(A.length, b.split(" ").length) : 0;
}
function firstDiff(a: string, b: string): string {
  const A = a.split(" "), B = b.split(" ");
  let n = 0; while (n < A.length && A[n] === B[n]) n++;
  return `from word ${n + 1}: "${A.slice(n, n + 6).join(" ")}" vs "${B.slice(n, n + 6).join(" ")}"`;
}
function total(kind: "pdf" | "docx", F: Finding[], pages: number, measured: Measured, parseCheckFails: string[] = []): Rating {
  const counted = F.filter((f) => f.measured), max = counted.reduce((s, f) => s + f.max, 0), got = counted.reduce((s, f) => s + f.points, 0);
  const score = max ? Math.round((got / max) * 100) : 0;
  const hardFailures = F.filter((f) => f.hard && f.measured && f.points < f.max * 0.5).map((f) => f.criterion);
  return { kind, score, findings: F, hardFailures, keep: score >= KEEP_MIN && hardFailures.length === 0 && parseCheckFails.length === 0, pages, measured, parseCheckFails };
}
export async function rateResumeFile(R: any, bytes: Uint8Array, o: { cv?: boolean } = {}): Promise<Rating> {
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  return pdf ? await ratePdf(bytes, { R, cv: o.cv }) : rateDocx(R, bytes, o);
}

// ---------------------------------------------------------------- the recommendation among the 15
const ROLE_WORDS: [RoleFamily, RegExp][] = [
  ["federal", /\b(federal|gs-\d+|usajobs|government agency|department of)\b/i],
  ["research", /\b(research (?:assistant|scientist|associate|fellow)|postdoc|lab(?:oratory)?|phd|scientist)\b/i],
  ["engineering", /\b(engineer|developer|software|swe|devops|sre|backend|frontend|full[- ]stack|firmware|embedded|machine learning engineer)\b/i],
  ["product_design", /\b(product manager|product designer|ux|ui|designer|design|user research)\b/i],
  ["business_finance", /\b(finance|financial|banking|investment|consult|accountant|accounting|audit|strategy|private equity|equity research|m&a|operations)\b/i],
  ["data", /\b(data|analyst|analytics|statistic|quantitative|bi\b|business intelligence|actuar)/i],
  ["sales_marketing", /\b(sales|account executive|business development|marketing|growth|brand|seo|customer success|recruiter)\b/i],
];
export function roleFamily(text: string): RoleFamily { return ROLE_WORDS.find(([, re]) => re.test(text))?.[0] ?? "general"; }
export function levelOf(o: { years: number | null; student?: boolean; title?: string }): Level {
  if (/\b(chief|vp|vice president|head of|director|cxo|ceo|cto|cfo|coo|partner)\b/i.test(o.title ?? "")) return "executive";
  if (o.student || o.years === null || o.years < 1) return "student";
  return o.years < 3 ? "early" : o.years < 8 ? "mid" : o.years < 15 ? "senior" : "executive";
}
export interface Recommendation { template: LibraryId; name: string; why: string; alternatives: LibraryId[] }
// The best-matching of the fifteen for a role family and level: a template made for both first, then for the role, then for
// the level; a template made first for the role before one that also serves it; among equals, the one-page design for
// one-page levels and the two-page one for senior people. Said in plain words.
export function recommendTemplate(o: { role: RoleFamily; level: Level; careerChange?: boolean }): Recommendation {
  const role: RoleFamily = o.careerChange ? "career_change" : o.role;
  const wantPages = o.level === "senior" || o.level === "executive" ? 2 : 1;
  const ranked = (Object.values(TEMPLATES) as TemplateSpec[]).map((t) => ({
    t, s: (t.roles.includes(role) ? 4 : t.roles.includes("general") ? 1 : 0) + (t.roles[0] === role ? 1 : 0) + (t.levels.includes(o.level) ? 3 : 0) + (t.pages === wantPages ? 1 : 0) - (role !== "federal" && t.roles[0] === "federal" ? 5 : 0),
  })).sort((a, b) => b.s - a.s || a.t.id.localeCompare(b.t.id));
  const best = ranked[0].t;
  const levelWords: Record<Level, string> = { student: "a student or new graduate", early: "someone early in their career", mid: "someone mid-career", senior: "a senior person", executive: "an executive" };
  const why = `${best.name} (template ${Number(best.id.slice(1))}) is made for ${best.for}. For ${levelWords[o.level]} it keeps ${best.pages === 1 ? "to one page" : "to at most two pages"}, puts ${best.order.slice(0, 2).join(" and ")} first, sets one column with the dates flush right, and uses standard headings an applicant tracking system reads.`;
  return { template: best.id as LibraryId, name: best.name, why, alternatives: ranked.slice(1, 3).map((x) => x.t.id as LibraryId) };
}
// What the person reads about their own file: the score, the failures in plain words with the exact line, and the decision.
export function ratingSummary(r: Rating, rec: Recommendation | null): string {
  const fails = r.findings.filter((f) => f.measured && !f.pass).sort((a, b) => (b.max - b.points) - (a.max - a.points));
  const gate = r.parseCheckFails.length ? `, and the applicant-tracking check refuses it (${r.parseCheckFails.slice(0, 2).join("; ")})` : "";
  const head = r.keep ? `Your resume's format scores ${r.score}/100, so I'll keep your layout and change only the words.` : `Your resume's format scores ${r.score}/100${r.hardFailures.length ? `, and it fails ${r.hardFailures.join(", ")}` : ""}${gate}, so I won't reuse it as is.`;
  const lines = fails.slice(0, 4).map((f) => `- ${f.criterion}: ${f.detail}${f.where.length ? ` (${f.where.slice(0, 2).join("; ")})` : ""}`);
  return [head, ...lines, ...(!r.keep && rec ? [`Suggested: ${rec.why}`] : [])].join("\n");
}

// ---------------------------------------------------------------- keep: the person's own PDF, rebuilt from its geometry
// A PDF the rater keeps can be set again with the tailored words only when every part of its layout is something the
// standard-font PDF can reproduce exactly: a Helvetica/Arial or Times face, body 10-12 pt, a name of 10-18 pt, one column,
// dates flush right, bullets at one x with one hanging indent, a measurable leading. Anything else (a 24 pt name, a face like
// Calibri, a sidebar) is not faithful, and the reason says which; then the DOCX is kept where there is one, else a template is offered.
export function ownPdfSpec(r: Rating, nameSize: number | null): { ok: true; spec: TemplateSpec } | { ok: false; reason: string } {
  const m = r.measured;
  if (r.kind !== "pdf" || !r.keep) return { ok: false, reason: "only a kept PDF is rebuilt" };
  const fam = m.faces.map((f) => f.toLowerCase().replace(/\s+/g, ""));
  const face = fam.every((f) => /^(arial|helvetica|liberationsans|arimo)/.test(f)) ? "sans" : fam.every((f) => /^(times|timesnewroman|liberationserif|tinos)/.test(f)) ? "serif" : null;
  const why: string[] = [];
  if (!face) why.push(`its face (${m.faces.join(", ")}) is not one the standard PDF fonts reproduce`);
  if (m.bodyPt === null || m.bodyPt < 10 || m.bodyPt > 12) why.push(`its body size (${m.bodyPt} pt) is outside 10-12 pt`);
  if (nameSize !== null && (nameSize > 18 || nameSize < 10)) why.push(`its name is ${nameSize} pt, outside the 10-18 pt a name may be (R6)`);
  if (!m.margins || m.margins.left < 36 || m.margins.left > 72 || m.margins.top < 36 || m.margins.top > 72) why.push("its margins could not be measured within 0.5-1 in");
  if (m.datesFlushRight === false) why.push("its dates are not flush right");
  if (!m.leadPt) why.push("its line spacing could not be measured");
  if (why.length) return { ok: false, reason: `your PDF's layout can't be rebuilt exactly: ${why.join("; ")}` };
  const body = Math.round(m.bodyPt! * 2) / 2, left = Math.round(m.margins!.left * 2) / 2, top = Math.round(m.margins!.top * 2) / 2;
  const bx = m.bulletX !== null ? Math.max(0, Math.round((m.bulletX - left) * 2) / 2) : 0, tx = m.bulletTextX !== null ? Math.max(bx + 6, Math.round((m.bulletTextX - left) * 2) / 2) : bx + 12;
  const spec: TemplateSpec = {
    id: "OWN", name: "Your own layout", for: "you", roles: ["general"], levels: ["early", "mid", "senior"], pages: r.pages >= 2 ? 2 : 1, face: face!,
    margins: { top, right: left, bottom: Math.max(36, top), left }, body, heading: body, namePt: Math.min(18, Math.max(body, Math.round((nameSize ?? 12) * 2) / 2)), leadRatio: Math.max(1.1, Math.min(1.5, m.leadPt! / body)),
    header: "stack", nameCase: "as-is", headingCase: m.headingCase ?? "upper", headingRule: m.headingRule ?? "none", bullet: { glyph: "•", x: bx, text: tx },
    gaps: { header: 2, section: 2, afterHeading: 1, entry: 1 }, order: [], evidence: [],
  };
  return { ok: true, spec };
}

// The career bundle's renderer with this runtime's node built-ins (the edge's, as career_tailor.ts edgeRenderer loads them).
let runtimeR: Promise<any> | null = null;
export function raterRuntime(): Promise<any> {
  runtimeR ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
    .then(([zlib, crypto, b]) => (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }));
  return runtimeR;
}
// The name's size: the largest text on the first line of page one (a measured number, for ownPdfSpec).
export async function pdfNamePt(bytes: Uint8Array): Promise<number | null> {
  const g = await readPdfGeometry(bytes);
  const first = g.lines.find((l) => l.page === 0);
  return first ? Math.max(...first.items.map((i) => i.size)) : null;
}

// ---------------------------------------------------------------- the choice tailoring makes
export interface LayoutPlan {
  layout: "own" | "template" | null; template: LibraryId | null; ownDocx: Uint8Array | null; ownPdfSpec: TemplateSpec | null;
  rating: Rating | null; recommended: Recommendation | null; summary: string; reason: string;
}
// With no layout asked for: keep theirs when the rater says keep (their Word file, or their PDF where it can be rebuilt
// exactly), else leave the default and offer the best of the fifteen, saying which and why. "keep mine" (own) uses the same
// keep path even under the threshold, but never a PDF that cannot be rebuilt exactly. "use template N" is taken as asked.
export async function planLayout(o: {
  asked: "own" | "template" | "trainee" | null; template: LibraryId | null; upload: { bytes: Uint8Array; kind: "pdf" | "docx" } | null; ownDocx: Uint8Array | null;
  roleText: string; student?: boolean; careerChange?: boolean;
}): Promise<LayoutPlan> {
  const none: LayoutPlan = { layout: null, template: null, ownDocx: null, ownPdfSpec: null, rating: null, recommended: null, summary: "", reason: "" };
  if (o.asked === "template") return { ...none, layout: "template", template: o.template, reason: "asked for" };
  if (o.asked === "trainee") return none;
  if (!o.upload) return o.asked === "own" ? { ...none, layout: "own", ownDocx: o.ownDocx, reason: "asked for" } : none;
  const R = await raterRuntime();
  const rating = await rateResumeFile(R, o.upload.bytes);
  const recommended = recommendTemplate({ role: roleFamily(o.roleText), level: levelOf({ years: rating.measured.years, student: o.student, title: o.roleText }), careerChange: o.careerChange });
  const keepIt = rating.keep || o.asked === "own";
  if (keepIt && o.upload.kind === "docx") return { ...none, layout: "own", ownDocx: o.upload.bytes, rating, recommended, summary: ratingSummary(rating, recommended), reason: rating.keep ? "the rater says keep" : "asked for" };
  if (keepIt && o.upload.kind === "pdf") {
    const spec = ownPdfSpec({ ...rating, keep: true }, await pdfNamePt(o.upload.bytes));
    if (spec.ok) return { ...none, layout: "own", ownPdfSpec: spec.spec, rating, recommended, summary: ratingSummary(rating, recommended), reason: "the rater says keep; the PDF is rebuilt from its measured geometry" };
    if (o.ownDocx?.length) return { ...none, layout: "own", ownDocx: o.ownDocx, rating, recommended, summary: `${ratingSummary(rating, recommended)}\n${spec.reason}, so your Word copy's layout is kept.`, reason: spec.reason };
    return { ...none, rating, recommended, summary: `${ratingSummary(rating, recommended)}\n${spec.reason}. Suggested: ${recommended.why}`, reason: spec.reason };
  }
  return { ...none, rating, recommended, summary: ratingSummary(rating, recommended), reason: "the rater says not to keep it" };
}
