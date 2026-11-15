// Work artifacts, XLSX (spec WORK-ARTIFACTS.md, rules D1, D2, D9). Writes real SpreadsheetML with live <f> formulas and
// cached <v> values, defined names, styles and a DrawingML bar chart. The cached values come from the model computed here
// in plain code; formula.ts recomputes the formulas independently from the bytes and compares them with `expected`.
import { strToU8, zipSync } from "npm:fflate@0.8.2";

export type CellValue = number | string | boolean | null;
export type Cell = { v: CellValue; f?: string; style?: "header" | "percent" | "count" | "money" };
export type Sheet = { name: string; cells: Record<string, Cell>; widths?: number[]; drawing?: boolean };
export type Chart = { sheet: string; title: string; categories: string; series: { name: string; ref: string }[]; anchor: { from: [number, number]; to: [number, number] } };
export type Book = { sheets: Sheet[]; charts: Chart[]; names?: Record<string, string>; expected: Record<string, Expected> };
export type Expected = { sheet: string; ref: string; value: CellValue };

const STYLE_ID = { header: 1, percent: 2, count: 3, money: 4 } as const;

// CR is legal XML but a parser turns "a\rb" and "a\r\nb" into "a\nb" (end-of-line handling), so it is escaped as
// _x000D_ too, the way Excel writes it (second review of WO-124b).
// XML 1.0 forbids C0 controls other than tab, LF and CR, U+FFFE, U+FFFF and lone surrogates; one in a cohort name made
// the part unreadable (review of WO-124b). They are written as OOXML's ST_Xstring escape _xHHHH_ (ECMA-376 Part 1,
// 22.9.2.19), and a literal "_x" that already looks like an escape is itself escaped as _x005F_, so the text reads back
// exactly. formula.ts decodes the same escape.
const BAD_XML = /[\u0000-\u0008\u000B\u000C\r\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const hex4 = (c: string) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`;
export function esc(s: string): string {
  return s.replace(/_x(?=[0-9A-Fa-f]{4}_)/g, "_x005F_x").replace(BAD_XML, hex4)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function colName(n: number): string {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function addr(ref: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad cell ref ${ref}`);
  const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return [Number(m[2]), col];
}

function cellXml(ref: string, c: Cell): string {
  const s = c.style ? ` s="${STYLE_ID[c.style]}"` : "";
  const f = c.f ? `<f>${esc(c.f)}</f>` : "";
  if (c.v === null) return c.f ? `<c r="${ref}"${s}>${f}</c>` : `<c r="${ref}"${s}/>`;
  if (typeof c.v === "number") {
    if (!Number.isFinite(c.v)) throw new Error(`non-finite value at ${ref}`);
    return `<c r="${ref}"${s}>${f}<v>${c.v}</v></c>`;
  }
  if (typeof c.v === "boolean") return `<c r="${ref}"${s} t="b">${f}<v>${c.v ? 1 : 0}</v></c>`;
  if (c.f) return `<c r="${ref}"${s} t="str">${f}<v>${esc(c.v)}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
}

function sheetXml(sh: Sheet): string {
  const byRow = new Map<number, [number, string][]>();
  for (const [ref, c] of Object.entries(sh.cells)) {
    const [r, col] = addr(ref);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r)!.push([col, cellXml(ref, c)]);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b).map((r) =>
    `<row r="${r}">${byRow.get(r)!.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join("")}</row>`
  ).join("");
  const cols = sh.widths?.length
    ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${rows}</sheetData>${sh.drawing ? `<drawing r:id="rId1"/>` : ""}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function rangeCache(book: Book, ref: string): CellValue[] {
  const m = /^'?(.+?)'?!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad chart range ${ref}`);
  const sh = book.sheets.find((s) => s.name === m[1]);
  if (!sh) throw new Error(`no sheet ${m[1]}`);
  const [r1, c1] = addr(m[2] + m[3]), [r2, c2] = addr(m[4] + m[5]);
  const out: CellValue[] = [];
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(sh.cells[colName(c) + r]?.v ?? null);
  return out;
}

function chartXml(book: Book, ch: Chart): string {
  const cats = rangeCache(book, ch.categories);
  const strCache = (vals: CellValue[]) =>
    `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(String(v ?? ""))}</c:v></c:pt>`).join("")}</c:strCache>`;
  const numCache = (vals: CellValue[]) =>
    `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => typeof v === "number" ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : "").join("")}</c:numCache>`;
  const sers = ch.series.map((s, i) =>
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx><c:invertIfNegative val="0"/><c:cat><c:strRef><c:f>${esc(ch.categories)}</c:f>${strCache(cats)}</c:strRef></c:cat><c:val><c:numRef><c:f>${esc(s.ref)}</c:f>${numCache(rangeCache(book, s.ref))}</c:numRef></c:val></c:ser>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="150"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart><c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function drawingXml(charts: number[], book: Book): string {
  const anchors = charts.map((n, i) => {
    const a = book.charts[n].anchor;
    return `<xdr:twoCellAnchor><xdr:from><xdr:col>${a.from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${a.to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${n + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

const rels = (items: [string, string, string][]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const OD = "officeDocument/2006/relationships/";

/** Writes the workbook. Sheets with a chart get a drawing; chart n is xl/charts/chart{n+1}.xml. */
// Excel's rules for a sheet name (it refuses the file otherwise): 1-31 characters, none of : \\ / ? * [ ], no
// control character, not starting or ending with an apostrophe, unique (case-insensitive), and not "History".
// A defined name starts with a letter, _ or \\, holds only letters, digits, _ and ., and is not a cell reference.
export function checkSheetName(n: string): void {
  if (typeof n !== "string" || n.length < 1 || n.length > 31 || /[:\\/?*\[\]\u0000-\u001F]/.test(n) || /^'|'$/.test(n) || n.toLowerCase() === "history") {
    throw new RangeError(`sheet name ${JSON.stringify(n)} is not one Excel accepts`);
  }
}
export function checkDefinedName(n: string): void {
  if (/^(?:r|c|true|false)$/i.test(n) || !/^[A-Za-z_\\][A-Za-z0-9_.]*$/.test(n) || /^[A-Za-z]{1,3}\d+$/.test(n) || /^r\d*c\d*$/i.test(n) || n.length > 255) {
    throw new RangeError(`defined name ${JSON.stringify(n)} is not one Excel accepts`);
  }
}
export function writeXlsx(book: Book): Uint8Array {
  const seen = new Set<string>();
  for (const sh of book.sheets) {
    checkSheetName(sh.name);
    if (seen.has(sh.name.toLowerCase())) throw new RangeError(`sheet name ${JSON.stringify(sh.name)} is used twice`);
    seen.add(sh.name.toLowerCase());
  }
  for (const n of Object.keys(book.names ?? {})) checkDefinedName(n);
  const files: Record<string, Uint8Array> = {};
  const put = (p: string, s: string) => (files[p] = strToU8(s));
  const overrides: string[] = [];
  const ov = (p: string, ct: string) => overrides.push(`<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-${ct}"/>`);
  let drawings = 0;
  book.sheets.forEach((sh, i) => {
    const mine = book.charts.map((c, n) => (c.sheet === sh.name ? n : -1)).filter((n) => n >= 0);
    const xml = sheetXml({ ...sh, drawing: mine.length > 0 });
    put(`xl/worksheets/sheet${i + 1}.xml`, xml);
    ov(`xl/worksheets/sheet${i + 1}.xml`, "officedocument.spreadsheetml.worksheet+xml");
    if (!mine.length) return;
    const d = ++drawings;
    put(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, rels([["rId1", OD + "drawing", `../drawings/drawing${d}.xml`]]));
    put(`xl/drawings/drawing${d}.xml`, drawingXml(mine, book));
    ov(`xl/drawings/drawing${d}.xml`, "officedocument.drawing+xml");
    put(`xl/drawings/_rels/drawing${d}.xml.rels`, rels(mine.map((n, k) => [`rId${k + 1}`, OD + "chart", `../charts/chart${n + 1}.xml`])));
    for (const n of mine) {
      put(`xl/charts/chart${n + 1}.xml`, chartXml(book, book.charts[n]));
      ov(`xl/charts/chart${n + 1}.xml`, "officedocument.drawingml.chart+xml");
    }
  });
  const names = Object.entries(book.names ?? {}).map(([n, r]) => `<definedName name="${esc(n)}">${esc(r)}</definedName>`).join("");
  put("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${book.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${names ? `<definedNames>${names}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  const n = book.sheets.length;
  put("xl/_rels/workbook.xml.rels", rels([...book.sheets.map((_, i): [string, string, string] => [`rId${i + 1}`, OD + "worksheet", `worksheets/sheet${i + 1}.xml`]), [`rId${n + 1}`, OD + "styles", "styles.xml"]]));
  put("xl/styles.xml", STYLES);
  ov("xl/workbook.xml", "officedocument.spreadsheetml.sheet.main+xml");
  ov("xl/styles.xml", "officedocument.spreadsheetml.styles+xml");
  put("_rels/.rels", rels([["rId1", OD + "officeDocument", "xl/workbook.xml"]]));
  put("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`);
  return zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
}

export type CohortRow = { cohort: string; acquired: number; activated: number; retained: number | null; spend: number };
const UNDEF_ACQ = "Undefined (0 acquired)", UNDEF_ACT = "Undefined (0 activated)", PENDING = "Pending";
const ratio = (num: number, den: number, undef: string): CellValue => (den === 0 ? undef : num / den);

/** The cohort workbook: Inputs (typed numbers), Metrics (live formulas), a mature baseline by weighted totals, and a chart. */
export function cohortWorkbook({ rows, mature }: { rows: CohortRow[]; mature: (r: CohortRow) => boolean }): Book {
  if (!rows.length) throw new Error("cohortWorkbook needs at least one row");
  // Each cohort keys its own expected cells; a repeated name or the reserved "baseline" would overwrite another's.
  const names = new Set<string>();
  for (const r of rows) {
    const k = String(r.cohort);
    if (names.has(k)) throw new RangeError(`cohort ${JSON.stringify(k)} appears twice`);
    if (k === "baseline") throw new RangeError(`"baseline" is reserved for the mature totals`);
    if (k.length > 32767) throw new RangeError("a cohort name is longer than a cell can hold (32,767 characters)");
    names.add(k);
  }
  const last = rows.length + 1;
  const inputs: Record<string, Cell> = {}, metrics: Record<string, Cell> = {};
  const expected: Record<string, Expected> = {};
  ["Cohort", "Acquired", "Activated", "Retained", "Spend", "Mature"].forEach((h, i) => (inputs[colName(i + 1) + 1] = { v: h, style: "header" }));
  ["Cohort", "Activation rate", "Retained per acquired", "Retained per activated", "Cost per acquired", "Funnel ok"]
    .forEach((h, i) => (metrics[colName(i + 1) + 1] = { v: h, style: "header" }));
  const keys = ["cohort", "activation_rate", "retained_per_acquired", "retained_per_activated", "cost_per_acquired", "funnel_ok"];
  let matAcq = 0, matRet = 0;
  rows.forEach((r, i) => {
    const n = i + 2, isMature = mature(r) && r.retained !== null;
    if (isMature) (matAcq += r.acquired, matRet += r.retained as number);
    inputs[`A${n}`] = { v: r.cohort };
    inputs[`B${n}`] = { v: r.acquired, style: "count" };
    inputs[`C${n}`] = { v: r.activated, style: "count" };
    inputs[`D${n}`] = { v: r.retained, style: "count" };
    inputs[`E${n}`] = { v: r.spend, style: "money" };
    inputs[`F${n}`] = { v: isMature ? "Yes" : "No" };
    const I = (c: string) => `Inputs!${c}${n}`;
    const funnelOk = r.retained === null ? r.activated <= r.acquired : r.retained <= r.activated && r.activated <= r.acquired;
    const cells: Cell[] = [
      { f: I("A"), v: r.cohort },
      { f: `IF(${I("B")}=0,"${UNDEF_ACQ}",${I("C")}/${I("B")})`, v: ratio(r.activated, r.acquired, UNDEF_ACQ), style: "percent" },
      { f: `IF(AND(${I("F")}="Yes",ISNUMBER(${I("D")})),IF(${I("B")}=0,"${UNDEF_ACQ}",${I("D")}/${I("B")}),"${PENDING}")`, v: isMature ? ratio(r.retained as number, r.acquired, UNDEF_ACQ) : PENDING, style: "percent" },
      { f: `IF(AND(${I("F")}="Yes",ISNUMBER(${I("D")})),IFERROR(${I("D")}/${I("C")},"${UNDEF_ACT}"),"${PENDING}")`, v: isMature ? ratio(r.retained as number, r.activated, UNDEF_ACT) : PENDING, style: "percent" },
      { f: `IF(${I("B")}=0,"${UNDEF_ACQ}",${I("E")}/${I("B")})`, v: ratio(r.spend, r.acquired, UNDEF_ACQ), style: "money" },
      { f: `IF(ISNUMBER(${I("D")}),AND(${I("D")}<=${I("C")},${I("C")}<=${I("B")}),${I("C")}<=${I("B")})`, v: funnelOk },
    ];
    cells.forEach((c, k) => {
      const ref = colName(k + 1) + n;
      metrics[ref] = c;
      expected[`${r.cohort}.${keys[k]}`] = { sheet: "Metrics", ref, value: c.v };
    });
  });
  const b = last + 2;
  metrics[`A${b}`] = { v: "Mature baseline (weighted totals)", style: "header" };
  metrics[`A${b + 1}`] = { v: "Mature acquired" };
  metrics[`B${b + 1}`] = { f: `SUMIFS(CohortAcquired,CohortMature,"Yes")`, v: matAcq, style: "count" };
  metrics[`A${b + 2}`] = { v: "Mature retained" };
  metrics[`B${b + 2}`] = { f: `SUMIFS(CohortRetained,CohortMature,"Yes")`, v: matRet, style: "count" };
  metrics[`A${b + 3}`] = { v: "Retained per acquired" };
  metrics[`B${b + 3}`] = { f: `IF(B${b + 1}=0,"${UNDEF_ACQ}",B${b + 2}/B${b + 1})`, v: ratio(matRet, matAcq, UNDEF_ACQ), style: "percent" };
  expected["baseline.acquired"] = { sheet: "Metrics", ref: `B${b + 1}`, value: matAcq };
  expected["baseline.retained"] = { sheet: "Metrics", ref: `B${b + 2}`, value: matRet };
  expected["baseline.retained_per_acquired"] = { sheet: "Metrics", ref: `B${b + 3}`, value: ratio(matRet, matAcq, UNDEF_ACQ) };
  const rng = (c: string) => `Inputs!$${c}$2:$${c}$${last}`;
  return {
    sheets: [
      { name: "Inputs", cells: inputs, widths: [12, 12, 12, 12, 12, 10] },
      { name: "Metrics", cells: metrics, widths: [34, 16, 22, 22, 18, 10] },
    ],
    charts: [{
      sheet: "Metrics",
      title: "Cohort funnel (blank retained = pending)",
      categories: rng("A"),
      series: [{ name: "Acquired", ref: rng("B") }, { name: "Activated", ref: rng("C") }, { name: "Retained", ref: rng("D") }],
      anchor: { from: [7, 1], to: [15, 18] },
    }],
    names: { CohortAcquired: rng("B"), CohortRetained: rng("D"), CohortMature: rng("F"), BaselineRetainedPerAcquired: `Metrics!$B$${b + 3}` },
    expected,
  };
}
