// WO-124d: DOCX, PPTX and PDF built from the typed model (spec WORK-ARTIFACTS.md D1, D2). Every figure printed is a
// cell rendered by model.ts; prose holds {{ref:id}} or {{ref:id|format}} slots. Before any byte is written, the text of
// every block (slots removed) is run through model.loose with no values, so any typed number throws LooseNumber.
//
// The stated exemptions (the only numbers prose may type):
//   years   a 19xx or 20xx four-digit year in a date context: an ISO date (2026-11-14), after a month name
//           (Nov 14, 2026; November 2026), before one (14 November 2026), after in / since / by / from / until / to /
//           through / during / before / after / FY / Q1-Q4 / class of, or a year range (2025-2026, 2025-26).
//   ordinals a list ordinal ("1." or "2)") at the start of a line or item; 1st, 2nd and 3rd are words, not numbers.
//
// The PDF uses the standard faces Helvetica and Helvetica-Bold (no embedding), measured with the Adobe AFM widths in
// career_resume_design.ts widthPt; pages() measures every run with the same widths. Each page's /ArtBox is its content
// box, and every table cell is drawn inside its own clip rectangle, so pages() can report a run wider than its box as
// clipped. Nothing is ever cut by the writer: a word that cannot wrap is set whole and reported.
import { strToU8, unzlibSync, zipSync } from "npm:fflate@0.8.2";
import { CareerRender } from "../router_core.career.js";
import { widthPt } from "../career_resume_design.ts";
import { type Cell, evaluate, loose, render, type Values } from "./model.ts";

// deno-lint-ignore no-explicit-any
const P = (CareerRender as any).primitives;
const esc = (s: string): string => P.escXml(String(s));

export type DocBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "table"; rows: string[][] };
export interface DocModel {
  title: string;
  cells: Cell[];
  blocks: DocBlock[];
  formats?: Record<string, string>;
  page?: { size?: "letter" | "a4"; margin?: number };
  wrapTables?: boolean;
}
export interface Series { name: string; refs: string[]; labels: string[] }
export interface Slide { title: string; bullets?: string[]; chart?: { kind: "bar" | "line"; title?: string; series: Series[] }; notes?: string }
export interface Deck { title: string; cells: Cell[]; slides: Slide[]; formats?: Record<string, string> }

export class LooseNumber extends Error {
  constructor(public numbers: { where: string; number: string }[]) {
    super(`typed numbers that are not cell references: ${numbers.map((n) => `${n.number} (${n.where})`).join(", ")}`);
    this.name = "LooseNumber";
  }
}
export class Unencodable extends Error {
  constructor(public chars: string[]) { super(`the PDF's standard fonts cannot print ${chars.join(" ")}`); this.name = "Unencodable"; }
}

// ---------------------------------------------------------------- slots and the loose-number check
const SLOT = /\{\{\s*ref:([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*([^}]+?)\s*\}\}/g;
const ANY_SLOT = /\{\{[^}]*\}\}/g;
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const YEAR = "(?:19|20)\\d{2}";
const EXEMPT = [
  new RegExp(`\\b${YEAR}-\\d{2}-\\d{2}\\b`, "g"),
  new RegExp(`\\b${MONTH}\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?${YEAR}\\b`, "g"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+${YEAR}\\b`, "g"),
  new RegExp(`\\b(?:in|since|by|from|until|to|through|during|before|after|FY|Q[1-4]|class of)\\s+${YEAR}\\b`, "gi"),
  new RegExp(`\\b${YEAR}\\s*[-–]\\s*(?:${YEAR}|\\d{2})\\b`, "g"),
  /^\s*\d{1,2}[.)](?=\s)/gm,
];
export function typedNumbers(text: string): string[] {
  let t = String(text).replace(ANY_SLOT, " ");
  for (const re of EXEMPT) t = t.replace(re, (m) => " ".repeat(m.length));
  return loose(t, {});
}

// render: {{ref:id|format}} first (a format named in the slot), then model.render for {{ref:id}} with the model's formats.
export function renderText(text: string, values: Values, formats: Record<string, string> = {}): string {
  const withFmt = String(text).replace(SLOT, (_, id: string, fmt: string) => render(`{{ref:${id}}}`, values, { [id]: fmt }));
  return render(withFmt, values, formats);
}

// Evaluates the model and checks every text before anything is rendered; returns the renderer.
function prepare(cells: Cell[], texts: [string, string][], formats: Record<string, string> = {}) {
  const values = evaluate({ cells, text: texts.map(([, t]) => t) });
  const bad = texts.flatMap(([where, t]) => typedNumbers(t).map((number) => ({ where, number })));
  if (bad.length) throw new LooseNumber(bad);
  return { values, r: (t: string) => renderText(t, values, formats) };
}
function docTexts(m: DocModel): [string, string][] {
  const out: [string, string][] = [["title", m.title]];
  m.blocks.forEach((b, i) => {
    if (b.kind === "table") b.rows.forEach((row, ri) => row.forEach((c, ci) => out.push([`block ${i + 1} row ${ri + 1} cell ${ci + 1}`, c])));
    else if (b.kind === "bullets") b.items.forEach((t, j) => out.push([`block ${i + 1} item ${j + 1}`, t]));
    else out.push([`block ${i + 1}`, b.text]);
  });
  return out;
}

// ---------------------------------------------------------------- counts
// A word is a whitespace-separated token holding a letter or digit; "forty-five" is one word. Speaking time is at 150 wpm.
export function counts(text: string): { words: number; chars: number; seconds_at_150wpm: number } {
  const words = String(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, chars: String(text).length, seconds_at_150wpm: Math.round((words / 150) * 600) / 10 };
}

// ---------------------------------------------------------------- shared OOXML parts
const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const REL = (t: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;
const rels = (list: [string, string, string][]) =>
  `${XML}<Relationships xmlns="${PKG_RELS}">${list.map(([id, t, target]) => `<Relationship Id="${id}" Type="${REL(t)}" Target="${target}"/>`).join("")}</Relationships>`;
const core = (title: string) =>
  `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Trainee</dc:creator></cp:coreProperties>`;
const app = (name: string) => `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${name}</Application></Properties>`;
const ct = (defaults: string, overrides: [string, string][]) =>
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults}${
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("")
  }<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
const zip = (parts: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(parts).map(([n, s]) => [n, strToU8(s)])), { level: 6 });
const ROOT_RELS = (main: string) => rels([["rId1", "officeDocument", main], ["rId2", "metadata/core-properties", "docProps/core.xml"], ["rId3", "extended-properties", "docProps/app.xml"]])
  .replace(`${REL("metadata/core-properties")}`, "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties");

// ---------------------------------------------------------------- DOCX
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PAGE_PT = { letter: [612, 792], a4: [595, 842] } as const;
export function writeDocx(m: DocModel): Uint8Array {
  const { r } = prepare(m.cells, docTexts(m), m.formats);
  const [pw, ph] = PAGE_PT[m.page?.size ?? "letter"], margin = m.page?.margin ?? 54, tw = (pt: number) => Math.round(pt * 20);
  const run = (t: string, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const para = (t: string, style?: string, bold = false) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${run(t, bold)}</w:p>`;
  const body = [para(r(m.title), "Title")];
  const contentTw = tw(pw - 2 * margin);
  for (const b of m.blocks) {
    if (b.kind === "heading") body.push(para(r(b.text), "Heading1"));
    else if (b.kind === "para") body.push(para(r(b.text)));
    else if (b.kind === "bullets") for (const t of b.items) body.push(`<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(r(t))}</w:p>`);
    else {
      const cols = Math.max(1, ...b.rows.map((row) => row.length)), cw = Math.floor(contentTw / cols);
      const border = ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join("");
      const rows = b.rows.map((row, i) =>
        `<w:tr>${i === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: cols }, (_, c) =>
          `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/></w:tcPr><w:p>${run(r(row[c] ?? ""), i === 0)}</w:p></w:tc>`).join("")}</w:tr>`).join("");
      body.push(`<w:tbl><w:tblPr><w:tblW w:w="${cw * cols}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${
        Array.from({ length: cols }, () => `<w:gridCol w:w="${cw}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`, "<w:p/>");
    }
  }
  const sect = `<w:sectPr><w:pgSz w:w="${tw(pw)}" w:h="${tw(ph)}"/><w:pgMar w:top="${tw(margin)}" w:right="${tw(margin)}" w:bottom="${tw(margin)}" w:left="${tw(margin)}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  const style = (id: string, name: string, ppr: string, rpr: string, type = "paragraph") =>
    `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${id === "Normal" ? "" : `<w:basedOn w:val="Normal"/>`}<w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}<w:rPr>${rpr}</w:rPr></w:style>`;
  const styles = `${XML}<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica" w:cs="Arial"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${
    style("Normal", "Normal", "", "")}${style("Title", "Title", `<w:spacing w:after="200"/>`, `<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>`)}${
    style("Heading1", "heading 1", `<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/>`, `<w:b/><w:sz w:val="26"/><w:szCs w:val="26"/>`)}${
    style("ListBullet", "List Bullet", `<w:ind w:left="360" w:hanging="360"/>`, "")}</w:styles>`;
  const numbering = `${XML}<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  return zip({
    "[Content_Types].xml": ct("", [["/word/document.xml", `${WML}.document.main+xml`], ["/word/styles.xml", `${WML}.styles+xml`], ["/word/numbering.xml", `${WML}.numbering+xml`]]),
    "_rels/.rels": ROOT_RELS("word/document.xml"),
    "docProps/core.xml": core(r(m.title)),
    "docProps/app.xml": app("Trainee"),
    "word/document.xml": `${XML}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body.join("")}${sect}</w:body></w:document>`,
    "word/_rels/document.xml.rels": rels([["rId1", "styles", "styles.xml"], ["rId2", "numbering", "numbering.xml"]]),
    "word/styles.xml": styles,
    "word/numbering.xml": numbering,
  });
}

// ---------------------------------------------------------------- PPTX
const EMU = 12700; // per point
const SW = 12192000, SH = 6858000;
const PML = "application/vnd.openxmlformats-officedocument.presentationml";
const THEME = `${XML}<a:theme xmlns:a="${A_NS}" name="Trainee"><a:themeElements><a:clrScheme name="Trainee"><a:dk1><a:srgbClr val="1F1A1E"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="5C2751"/></a:dk2><a:lt2><a:srgbClr val="F4F1F3"/></a:lt2>${
  ["5C2751", "3A6EA5", "8A5A00", "4F7F52", "9C4A3C", "6B6470"].map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join("")
}<a:hlink><a:srgbClr val="3A6EA5"/></a:hlink><a:folHlink><a:srgbClr val="5C2751"/></a:folHlink></a:clrScheme><a:fontScheme name="Trainee"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Trainee"><a:fillStyleLst>${
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${`<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${
  `<a:effectStyle><a:effectLst/></a:effectStyle>`.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${`<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const CLRMAP = `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"`;
const NS = `xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"`;
const GRP = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
const xfrm = (x: number, y: number, w: number, h: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const paras = (lines: string[], size: number, bold = false, bullet = false) => lines.map((t) =>
  `<a:p>${bullet ? `<a:pPr marL="285750" indent="-285750"><a:buChar char="•"/></a:pPr>` : ""}<a:r><a:rPr lang="en-US" sz="${size * 100}"${bold ? ` b="1"` : ""} dirty="0"/><a:t>${esc(t)}</a:t></a:r></a:p>`).join("");
const textBox = (id: number, name: string, box: [number, number, number, number], body: string, ph = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${ph ? "" : ` txBox="1"`}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(...box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body || "<a:p/>"}</p:txBody></p:sp>`;

function chartXml(chart: NonNullable<Slide["chart"]>, values: Values, formats: Record<string, string>, r: (t: string) => string): string {
  const col = (i: number) => String.fromCharCode(66 + i);
  const ser = chart.series.map((s, i) => {
    const n = s.refs.length, fmt = formats[s.refs[0]] ?? "General";
    const strPts = s.labels.map((l, j) => `<c:pt idx="${j}"><c:v>${esc(r(l))}</c:v></c:pt>`).join("");
    const numPts = s.refs.map((id, j) => {
      if (!(id in values)) throw new Error(`chart series "${s.name}" names no cell "${id}"`);
      return `<c:pt idx="${j}"><c:v>${values[id]}</c:v></c:pt>`;
    }).join("");
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>Sheet1!$${col(i)}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(r(s.name))}</c:v></c:pt></c:strCache></c:strRef></c:tx>${
      chart.kind === "line" ? `<c:marker><c:symbol val="circle"/></c:marker>` : `<c:invertIfNegative val="0"/>`}<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${n + 1}</c:f><c:strCache><c:ptCount val="${n}"/>${strPts}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$${col(i)}$2:$${col(i)}$${n + 1}</c:f><c:numCache><c:formatCode>${esc(fmt)}</c:formatCode><c:ptCount val="${n}"/>${numPts}</c:numCache></c:numRef></c:val>${
      chart.kind === "line" ? `<c:smooth val="0"/>` : ""}</c:ser>`;
  }).join("");
  const plot = chart.kind === "line"
    ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="1001"/><c:axId val="1002"/></c:lineChart>`
    : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="150"/><c:axId val="1001"/><c:axId val="1002"/></c:barChart>`;
  const fmt = formats[chart.series[0]?.refs[0]] ?? "General";
  // A bar's length is its value, so a bar axis starts at zero unless a value is negative.
  const floor = chart.kind === "bar" && chart.series.every((s) => s.refs.every((id) => values[id] >= 0)) ? `<c:min val="0"/>` : "";
  const title = chart.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(r(chart.title))}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : `<c:autoTitleDeleted val="1"/>`;
  return `${XML}<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}` +
    `<c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="1002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>` +
    `<c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/>${floor}</c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="${esc(fmt)}" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="1001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea>` +
    `${chart.series.length > 1 ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>` : ""}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

export function writePptx(deck: Deck): Uint8Array {
  const texts: [string, string][] = [["title", deck.title]];
  deck.slides.forEach((s, i) => {
    const at = `slide ${i + 1}`;
    texts.push([`${at} title`, s.title], ...(s.bullets ?? []).map((b, j): [string, string] => [`${at} bullet ${j + 1}`, b]), [`${at} notes`, s.notes ?? ""]);
    if (s.chart) texts.push([`${at} chart title`, s.chart.title ?? ""], ...s.chart.series.flatMap((se) => [se.name, ...se.labels].map((t): [string, string] => [`${at} chart`, t])));
  });
  const formats = deck.formats ?? {};
  const { values, r } = prepare(deck.cells, texts, formats);
  const parts: Record<string, string> = {};
  const over: [string, string][] = [];
  const M = 457200, W = SW - 2 * M;
  let chartN = 0;
  deck.slides.forEach((s, i) => {
    const n = i + 1, shapes = [textBox(2, "Title", [M, 365760, W, 1005840], paras([r(s.title)], 32, true))];
    const slideRels: [string, string, string][] = [["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "notesSlide", `../notesSlides/notesSlide${n}.xml`]];
    const top = 1554480, bodyH = SH - top - M;
    const bullets = (s.bullets ?? []).map(r);
    if (bullets.length) shapes.push(textBox(3, "Body", [M, top, s.chart ? W / 2 - M / 2 : W, bodyH], paras(bullets, 20, false, true)));
    if (s.chart) {
      chartN++;
      const x = bullets.length ? M + W / 2 : M, w = bullets.length ? W / 2 : W;
      parts[`ppt/charts/chart${chartN}.xml`] = chartXml(s.chart, values, formats, r);
      over.push([`/ppt/charts/chart${chartN}.xml`, "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"]);
      slideRels.push(["rId3", "chart", `../charts/chart${chartN}.xml`]);
      shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart ${chartN}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${top}"/><a:ext cx="${w}" cy="${bodyH}"/></p:xfrm><a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" r:id="rId3"/></a:graphicData></a:graphic></p:graphicFrame>`);
    }
    parts[`ppt/slides/slide${n}.xml`] = `${XML}<p:sld ${NS}><p:cSld><p:spTree>${GRP}${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/slides/_rels/slide${n}.xml.rels`] = rels(slideRels);
    const notes = r(s.notes ?? "").split("\n");
    parts[`ppt/notesSlides/notesSlide${n}.xml`] = `${XML}<p:notes ${NS}><p:cSld><p:spTree>${GRP}${
      textBox(2, "Notes", [685800, 4400550, 5486400, 3600450], paras(notes, 12), `<p:ph type="body" idx="1"/>`)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
    parts[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = rels([["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"], ["rId2", "slide", `../slides/slide${n}.xml`]]);
    over.push([`/ppt/slides/slide${n}.xml`, `${PML}.slide+xml`], [`/ppt/notesSlides/notesSlide${n}.xml`, `${PML}.notesSlide+xml`]);
  });
  const N = deck.slides.length;
  const TX = `<a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`;
  Object.assign(parts, {
    "[Content_Types].xml": ct("", [
      ["/ppt/presentation.xml", `${PML}.presentation.main+xml`], ["/ppt/presProps.xml", `${PML}.presProps+xml`],
      ["/ppt/slideMasters/slideMaster1.xml", `${PML}.slideMaster+xml`], ["/ppt/slideLayouts/slideLayout1.xml", `${PML}.slideLayout+xml`],
      ["/ppt/notesMasters/notesMaster1.xml", `${PML}.notesMaster+xml`], ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
      ["/ppt/theme/theme2.xml", "application/vnd.openxmlformats-officedocument.theme+xml"], ...over,
    ]),
    "_rels/.rels": ROOT_RELS("ppt/presentation.xml"),
    "docProps/core.xml": core(r(deck.title)),
    "docProps/app.xml": app("Trainee"),
    "ppt/presentation.xml": `${XML}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${
      deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${SW}" cy="${SH}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle>${TX}</p:defaultTextStyle></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "notesMaster", "notesMasters/notesMaster1.xml"], ["rId3", "theme", "theme/theme1.xml"], ["rId4", "presProps", "presProps.xml"],
      ...Array.from({ length: N }, (_, i): [string, string, string] => [`rId${10 + i}`, "slide", `slides/slide${i + 1}.xml`])]),
    "ppt/presProps.xml": `${XML}<p:presentationPr ${NS}/>`,
    "ppt/slideMasters/slideMaster1.xml": `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${TX}</p:titleStyle><p:bodyStyle>${TX}</p:bodyStyle><p:otherStyle>${TX}</p:otherStyle></p:txStyles></p:sldMaster>`,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]),
    "ppt/slideLayouts/slideLayout1.xml": `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/notesMasters/notesMaster1.xml": `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${
      textBox(2, "Notes Placeholder", [685800, 4400550, 5486400, 3600450], "", `<p:ph type="body" idx="1"/>`)}</p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:notesStyle>${TX}</p:notesStyle></p:notesMaster>`,
    "ppt/notesMasters/_rels/notesMaster1.xml.rels": rels([["rId1", "theme", "../theme/theme2.xml"]]),
    "ppt/theme/theme1.xml": THEME,
    "ppt/theme/theme2.xml": THEME,
  });
  return zip(parts);
}

// ---------------------------------------------------------------- PDF
type Run = { font: "F1" | "F2"; size: number; x: number; y: number; text: string; clip?: [number, number, number, number] };
const pdfNum = (n: number) => String(Math.round(n * 100) / 100);
export function writePdf(m: DocModel): Uint8Array {
  const { r } = prepare(m.cells, docTexts(m), m.formats);
  const [pw, ph] = PAGE_PT[m.page?.size ?? "letter"], margin = m.page?.margin ?? 54;
  const x0 = margin, x1 = pw - margin, bottom = margin, top = ph - margin, wrapCells = m.wrapTables !== false;
  const pages: { runs: Run[]; rules: [number, number, number][] }[] = [{ runs: [], rules: [] }];
  let y = top;
  const pg = () => pages[pages.length - 1];
  const room = (h: number) => { if (y - h < bottom && y < top) { pages.push({ runs: [], rules: [] }); y = top; } };
  const wrap = (text: string, font: Run["font"], size: number, width: number): string[] => {
    const out: string[] = [];
    let line = "";
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (line && widthPt(next, font, size) > width) { out.push(line); line = w; } else line = next;
    }
    return out.length || line ? [...out, line] : [""];
  };
  const lines = (text: string, font: Run["font"], size: number, before: number) => {
    y -= before;
    for (const l of wrap(text, font, size, x1 - x0)) { room(size * 1.3); y -= size * 1.3; pg().runs.push({ font, size, x: x0, y: y + size * 0.3, text: l }); }
  };
  lines(r(m.title), "F2", 18, 0);
  for (const b of m.blocks) {
    if (b.kind === "heading") lines(r(b.text), "F2", 13, 10);
    else if (b.kind === "para") lines(r(b.text), "F1", 10.5, 4);
    else if (b.kind === "bullets") for (const t of b.items) lines(`• ${r(t)}`, "F1", 10.5, 2);
    else {
      y -= 6;
      const cols = Math.max(1, ...b.rows.map((row) => row.length)), cw = (x1 - x0) / cols, pad = 4, size = 10, lead = 13;
      b.rows.forEach((row, ri) => {
        const font = ri === 0 ? "F2" : "F1";
        const cells = Array.from({ length: cols }, (_, c) => { const t = r(row[c] ?? ""); return wrapCells ? wrap(t, font, size, cw - 2 * pad) : [t]; });
        const h = Math.max(...cells.map((c) => c.length)) * lead + 2 * pad;
        room(h);
        cells.forEach((ls, c) => {
          const cx = x0 + c * cw;
          ls.forEach((t, li) => pg().runs.push({ font, size, x: cx + pad, y: y - pad - (li + 1) * lead + 3, text: t, clip: [cx + pad, y - h, cw - 2 * pad, h] }));
        });
        y -= h;
        pg().rules.push([x0, x1, y]);
      });
    }
  }
  const unencodable: string[] = [];
  const objs: Uint8Array[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = P.bytes("<< /Type /Catalog /Pages 2 0 R >>");
  objs[2] = P.bytes(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objs[3] = P.bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs[4] = P.bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((p, i) => {
    const art = [x0, bottom, x1, top].map(pdfNum).join(" ");
    objs[pageIds[i]] = P.bytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /ArtBox [${art}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    const ops = [
      ...p.rules.map(([a, b, ry]) => `q 0.6 G 0.5 w ${pdfNum(a)} ${pdfNum(ry)} m ${pdfNum(b)} ${pdfNum(ry)} l S Q`),
      ...p.runs.map((u) => {
        const text = `BT /${u.font} ${u.size} Tf 1 0 0 1 ${pdfNum(u.x)} ${pdfNum(u.y)} Tm ${P.pdfLiteral(P.encodeWinAnsi(u.text, unencodable))} Tj ET`;
        return u.clip ? `q ${u.clip.map(pdfNum).join(" ")} re W n ${text} Q` : text;
      }),
    ].join("\n");
    const stream = P.deflate(P.bytes(ops, "latin1"));
    objs[pageIds[i] + 1] = P.concat([P.bytes(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, P.bytes("\nendstream", "latin1")]);
  });
  if (unencodable.length) throw new Unencodable(unencodable);
  const chunks: Uint8Array[] = [P.bytes("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let pos = chunks[0].length;
  for (let id = 1; id < objs.length; id++) {
    const head = P.bytes(`${id} 0 obj\n`, "latin1"), tail = P.bytes("\nendobj\n", "latin1");
    offsets[id] = pos;
    chunks.push(head, objs[id], tail);
    pos += head.length + objs[id].length + tail.length;
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  const info = `${P.pdfLiteral(P.encodeWinAnsi(r(m.title), []))}`;
  chunks.push(P.bytes(`${xref}trailer\n<< /Size ${objs.length} /Root 1 0 R /Info << /Title ${info} >> >>\nstartxref\n${pos}\n%%EOF`, "latin1"));
  return P.concat(chunks);
}

// ---------------------------------------------------------------- the page check
// Reads a PDF this module wrote: counts its pages and measures every text run with the writer's widths. A run whose
// measured extent leaves its clip rectangle (a table cell) or the page's /ArtBox (the content box) is clipped.
export interface Clipped { page: number; text: string; width_pt: number; box_pt: number; over_pt: number }
const WIN_EXTRA: Record<number, string> = { 0x80: "€", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—" };
function unLiteral(lit: string): string {
  let out = "";
  for (let i = 1; i < lit.length - 1; i++) {
    let c = lit[i];
    if (c === "\\") {
      const oct = /^[0-7]{1,3}/.exec(lit.slice(i + 1));
      if (oct) { c = String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length; } else c = lit[++i];
    }
    const code = c.charCodeAt(0);
    out += WIN_EXTRA[code] ?? c;
  }
  return out;
}
export function pages(pdf: Uint8Array): { count: number; clipped: Clipped[] } {
  const s = new TextDecoder("latin1").decode(pdf);
  const objAt = (id: number) => s.indexOf(`\n${id} 0 obj\n`) + 1;
  const pageDicts = [...s.matchAll(/<< \/Type \/Page \/[^]*?\/Contents (\d+) 0 R >>/g)];
  const clipped: Clipped[] = [];
  pageDicts.forEach((pm, pi) => {
    const art = /\/ArtBox \[([\d. -]+)\]/.exec(pm[0])?.[1].trim().split(/\s+/).map(Number) ?? [0, 0, Infinity, Infinity];
    const at = objAt(Number(pm[1])), len = Number(/\/Length (\d+)/.exec(s.slice(at, at + 200))![1]);
    const start = s.indexOf("stream\n", at) + 7;
    const ops = new TextDecoder("latin1").decode(unzlibSync(pdf.subarray(start, start + len)));
    const RUN = /(?:q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re W n )?BT \/(F[12]) ([\d.]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm (\((?:\\[^]|[^\\)])*\)) Tj ET/g;
    for (const m of ops.matchAll(RUN)) {
      const text = unLiteral(m[9]), x = Number(m[7]), y = Number(m[8]);
      const w = widthPt(text, m[5] as "F1" | "F2", Number(m[6]));
      const [bx0, bx1] = m[1] ? [Number(m[1]), Number(m[1]) + Number(m[3])] : [art[0], art[2]];
      const over = Math.max(x + w - bx1, bx0 - x, art[1] - y, 0);
      if (over > 0.01) clipped.push({ page: pi + 1, text, width_pt: Math.round(w * 10) / 10, box_pt: Math.round((bx1 - bx0) * 10) / 10, over_pt: Math.round(over * 10) / 10 });
    }
  });
  return { count: pageDicts.length, clipped };
}
