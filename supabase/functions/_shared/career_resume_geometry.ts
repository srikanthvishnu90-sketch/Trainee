// RELEASE 10: a resume file's real geometry, read from the file itself, for the format rater (career_resume_rater.ts) and the
// pixel-perfect checker (career_resume_pixel.ts). Nothing here guesses a position.
//   PDF   Mozilla's pdf.js (npm pdfjs-dist, pinned) reads every text item with its baseline, x, advance width, size and the
//         font's real name, in the file's content-stream order, plus the page's horizontal rules and its images, from the
//         operator list. It is loaded only when a PDF is read, so nothing else pays for it. pdf.js is independent of the PDF
//         writer here (it measures the standard faces with its own metrics), which is what makes the checker an outside
//         reading of our files rather than our own model read back.
//   DOCX  the package's XML: each paragraph's text with its resolved properties (document defaults, then its style chain,
//         then its numbering level, then the paragraph's own), the section's page and margins and columns, and what may
//         hold text outside the paragraph flow (tables, text boxes, drawings, headers and footers).
// deno-lint-ignore-file no-explicit-any
export const PDFJS = "npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs";

export interface PdfItem { page: number; order: number; str: string; x: number; y: number; w: number; size: number; font: string; bold: boolean }
export interface PdfLine { page: number; y: number; items: PdfItem[]; text: string; x: number; x1: number }
export interface PdfRule { page: number; y: number; x0: number; x1: number }
export interface PdfGeometry {
  kind: "pdf"; pages: { w: number; h: number }[]; items: PdfItem[]; lines: PdfLine[]; rules: PdfRule[]; images: number;
  fonts: { name: string; embedded: boolean }[]; streamText: string[];
}
const STRIP_SUBSET = (n: string) => String(n || "").replace(/^[A-Z]{6}\+/, "");
const isBold = (n: string) => /bold|black|heavy|semibold|demi/i.test(n);

let pdfjsP: Promise<any> | null = null;
export async function readPdfGeometry(bytes: Uint8Array): Promise<PdfGeometry> {
  pdfjsP ??= import("npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs"); // a literal specifier: the edge bundler only bundles those
  const pdfjs = await pdfjsP;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, verbosity: 0, useSystemFonts: false }).promise;
  const raw = new TextDecoder("latin1").decode(bytes);
  const embeddedHint = /\/FontFile[23]?\b/.test(raw);
  const items: PdfItem[] = [], rules: PdfRule[] = [], pages: { w: number; h: number }[] = [], fonts = new Map<string, boolean>();
  let images = 0, order = 0;
  const OPS = pdfjs.OPS;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ w: vp.viewBox[2] - vp.viewBox[0], h: vp.viewBox[3] - vp.viewBox[1] });
    const ops = await page.getOperatorList();
    // Text from the operators themselves (not getTextContent, which merges a bullet glyph into the words after it): each
    // show-text operator is one item, positioned by the text and the current transformation matrices, its width the sum of
    // the font's own advances; a TJ adjustment that jumps more than half an em starts a new item (a tab Word set as a jump).
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    const mul = (m: number[], n: number[]) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
    const pt = (x: number, y: number) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], font: any = null, fsize = 0, cs = 0, ws = 0, hs = 1, lead = 0;
    const fontOf = (id: string) => { try { return page.commonObjs.has(id) ? page.commonObjs.get(id) : page.objs.has(id) ? page.objs.get(id) : null; } catch { return null; } };
    const emit = (glyphs: any[]) => {
      const name = STRIP_SUBSET(font?.name ?? "unknown");
      const embedded = !!font && (/^[A-Z]{6}\+/.test(String(font.name)) || !!font.isType3Font || (embeddedHint && font.missingFile === false));
      fonts.set(name, (fonts.get(name) ?? false) || embedded);
      const fm = font?.fontMatrix?.[0] ?? 0.001;
      let cur: { str: string; x0: number; adv: number } | null = null;
      const flush = () => {
        if (cur && cur.str.trim()) {
          const m = mul([fsize * hs, 0, 0, fsize, 0, 0], mul([1, 0, 0, 1, cur.x0, 0], mul(tm, ctm)));
          const lead0 = cur.str.length - cur.str.trimStart().length;
          const str = cur.str.trim();
          items.push({ page: p - 1, order: order++, str, x: m[4] + lead0 * 0, y: m[5], w: cur.adv * Math.hypot(tm[0] * ctm[0], tm[1] * ctm[1]) * hs, size: Math.round(fsize * Math.hypot(tm[0] * ctm[0] + tm[1] * ctm[2], tm[0] * ctm[1] + tm[1] * ctm[3]) * 100) / 100, font: name, bold: isBold(name) || !!font?.bold || isBold(font?.loadedName ?? "") });
        }
        cur = null;
      };
      let x = 0;
      for (const gl of glyphs) {
        if (typeof gl === "number") {
          const move = (-gl / 1000) * fsize;
          if (move > fsize * 0.5) { flush(); }
          x += move; continue;
        }
        if (!gl) continue;
        const adv = (gl.width ?? 0) * fm * fsize + cs + (gl.isSpace ? ws : 0);
        const u = gl.unicode ?? "";
        if (!cur) { if (!u.trim()) { x += adv; continue; } cur = { str: "", x0: x, adv: 0 }; }
        cur.str += u; cur.adv = x + adv - cur.x0; x += adv;
      }
      flush();
      tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + x * hs * tm[0], tm[5] + x * hs * tm[1]];
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(args, ctm);
      else if (fn === OPS.beginText) { tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; }
      else if (fn === OPS.setFont) { font = fontOf(args[0]); fsize = args[1]; }
      else if (fn === OPS.setTextMatrix) { tm = [...args]; tlm = [...args]; }
      else if (fn === OPS.moveText) { tlm = mul([1, 0, 0, 1, args[0], args[1]], tlm); tm = [...tlm]; }
      else if (fn === OPS.setLeadingMoveText) { lead = -args[1]; tlm = mul([1, 0, 0, 1, args[0], args[1]], tlm); tm = [...tlm]; }
      else if (fn === OPS.setLeading) lead = args[0];
      else if (fn === OPS.nextLine) { tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = [...tlm]; }
      else if (fn === OPS.setCharSpacing) cs = args[0];
      else if (fn === OPS.setWordSpacing) ws = args[0];
      else if (fn === OPS.setHScale) hs = args[0] / 100;
      else if (fn === OPS.showText || fn === OPS.showSpacedText) emit(args[0]);
      else if (fn === OPS.nextLineShowText) { tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = [...tlm]; emit(args[0]); }
      else if (fn === OPS.nextLineSetSpacingShowText) { ws = args[0]; cs = args[1]; tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = [...tlm]; emit(args[2]); }
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) images++;
      else if (fn === OPS.constructPath) {
        const [sub, coords] = args;
        let c = 0, cx = 0, cy = 0;
        for (const op of sub) {
          if (op === OPS.moveTo) { [cx, cy] = [coords[c], coords[c + 1]]; c += 2; }
          else if (op === OPS.lineTo) {
            const [x2, y2] = [coords[c], coords[c + 1]]; c += 2;
            const [ax, ay] = pt(cx, cy), [bx, by] = pt(x2, y2);
            if (Math.abs(ay - by) < 0.5 && Math.abs(bx - ax) > 30) rules.push({ page: p - 1, y: ay, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
            [cx, cy] = [x2, y2];
          } else if (op === OPS.rectangle) {
            const [rx, ry, rw, rh] = coords.slice(c, c + 4); c += 4;
            const [ax, ay] = pt(rx, ry), [bx, by] = pt(rx + rw, ry + rh);
            if (Math.abs(by - ay) < 2 && Math.abs(bx - ax) > 30) rules.push({ page: p - 1, y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
          } else if (op === OPS.curveTo) c += 6;
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) c += 4;
        }
      }
    }
    page.cleanup();
  }
  await doc.destroy();
  return { kind: "pdf", pages, items, lines: linesOf(items), rules, images, fonts: [...fonts].map(([name, embedded]) => ({ name, embedded })), streamText: items.map((i) => i.str) };
}
// RELEASE 10 (architect ruling 2026-11-08): the edge's startup probe. pdf.js is the first npm module the edge loads; if it
// does not load or cannot read a page there, the rater is skipped (tailoring falls back to the default file, career_tools.ts)
// and this logs it once per instance, so a staging check sees it. A one-page PDF of one standard-font word is read back.
const PROBE_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj 4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj 5 0 obj<</Length 36>>stream\nBT /F1 12 Tf 10 50 Td (probe) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
export interface PdfjsProbe { evt: "pdfjs_probe"; ok: boolean; ms: number; error: string | null }
export async function probePdfjs(o: { read?: (b: Uint8Array) => Promise<PdfGeometry>; log?: (line: string) => void; now?: () => number } = {}): Promise<PdfjsProbe> {
  const now = o.now ?? (() => performance.now()), t0 = now();
  let out: PdfjsProbe;
  try {
    const g = await (o.read ?? readPdfGeometry)(new TextEncoder().encode(PROBE_PDF));
    const ok = g.items.some((i) => i.str === "probe");
    out = { evt: "pdfjs_probe", ok, ms: Math.round(now() - t0), error: ok ? null : "pdf.js loaded but did not read the probe page's text" };
  } catch (e) {
    out = { evt: "pdfjs_probe", ok: false, ms: Math.round(now() - t0), error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  if (!out.ok) (o.log ?? console.error)(JSON.stringify(out));
  return out;
}

// Items on one baseline (within 1 pt) of one page are one line, left to right; lines top to bottom.
export function linesOf(items: PdfItem[]): PdfLine[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: PdfLine[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= 1) last.items.push(it);
    else out.push({ page: it.page, y: it.y, items: [it], text: "", x: 0, x1: 0 });
  }
  for (const l of out) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
    l.x = l.items[0].x; l.x1 = Math.max(...l.items.map((i) => i.x + i.w));
  }
  return out;
}

// ---------------------------------------------------------------- DOCX
export interface DocxPara {
  text: string; style: string; styleName: string; outline: boolean; left: number; hanging: number; firstLine: number; before: number; after: number;
  line: number | null; lineRule: string; sizes: number[]; fonts: string[]; bold: boolean; numbered: boolean; tabs: { val: string; pos: number }[];
  align: string; caps: boolean; inTable: boolean; inTextBox: boolean; border: boolean;
}
export interface DocxGeometry {
  kind: "docx"; page: { w: number; h: number }; margins: { top: number; right: number; bottom: number; left: number }; columns: number;
  paras: DocxPara[]; tables: number; tableTextCells: number; textBoxes: number; drawings: number; images: number; headerFooterText: string[];
}
const attr = (xml: string, tag: string, a: string) => new RegExp(`<w:${tag}\\b[^>]*\\bw:${a}="([^"]*)"`).exec(xml)?.[1];
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
interface Props { left?: number; hanging?: number; firstLine?: number; before?: number; after?: number; line?: number; lineRule?: string; size?: number; font?: string; bold?: boolean; numbered?: boolean; tabs?: { val: string; pos: number }[]; align?: string; caps?: boolean; outline?: boolean; border?: boolean; numId?: string; ilvl?: string }
function propsOf(xml: string): Props {
  const p: Props = {};
  const ppr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)?.[1] ?? "", rpr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(xml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, ""))?.[1] ?? /<w:pPr>[\s\S]*?<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(xml)?.[1] ?? "";
  const ind = /<w:ind\b[^>]*\/?>/.exec(ppr)?.[0] ?? "";
  const l = num(attr(ind, "ind", "left") ?? attr(ind, "ind", "start")); if (l !== undefined) p.left = l / 20;
  const h = num(attr(ind, "ind", "hanging")); if (h !== undefined) p.hanging = h / 20;
  const f = num(attr(ind, "ind", "firstLine")); if (f !== undefined) p.firstLine = f / 20;
  const sp = /<w:spacing\b[^>]*\/?>/.exec(ppr)?.[0] ?? "";
  const b = num(attr(sp, "spacing", "before")); if (b !== undefined) p.before = b / 20;
  const a = num(attr(sp, "spacing", "after")); if (a !== undefined) p.after = a / 20;
  const ln = num(attr(sp, "spacing", "line")); if (ln !== undefined) p.line = ln;
  const lr = attr(sp, "spacing", "lineRule"); if (lr) p.lineRule = lr;
  const sz = num(attr(rpr, "sz", "val")); if (sz !== undefined) p.size = sz / 2;
  const font = attr(rpr, "rFonts", "ascii") ?? attr(rpr, "rFonts", "hAnsi"); if (font) p.font = font;
  if (/<w:b\/>|<w:b w:val="(?:1|true|on)"\/>/.test(rpr)) p.bold = true; else if (/<w:b w:val="(?:0|false|off)"\/>/.test(rpr)) p.bold = false;
  if (/<w:caps\/>|<w:caps w:val="(?:1|true)"\/>/.test(rpr)) p.caps = true;
  if (/<w:numPr>/.test(ppr)) { p.numbered = true; p.numId = attr(ppr, "numId", "val"); p.ilvl = attr(ppr, "ilvl", "val") ?? "0"; }
  const tabs = [...ppr.matchAll(/<w:tab\b[^>]*w:val="([^"]+)"[^>]*w:pos="(-?\d+)"/g)].map((m) => ({ val: m[1], pos: Number(m[2]) / 20 }));
  if (tabs.length) p.tabs = tabs;
  const jc = attr(ppr, "jc", "val"); if (jc) p.align = jc;
  if (/<w:outlineLvl\b/.test(ppr)) p.outline = true;
  if (/<w:pBdr>/.test(ppr)) p.border = true;
  return p;
}
const merge = (...ps: Props[]): Props => Object.assign({}, ...ps.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))));

// deno-lint-ignore no-explicit-any
export function readDocxGeometry(R: any, bytes: Uint8Array): DocxGeometry {
  const parts: Map<string, Uint8Array> = R.primitives.unzipParts(R.primitives.bytes(bytes));
  const dec = (n: string) => (parts.get(n) ? new TextDecoder().decode(parts.get(n)) : "");
  const xml = dec("word/document.xml"), stylesXml = dec("word/styles.xml"), numXml = dec("word/numbering.xml");
  const defaults = propsOf(`<w:pPr>${/<w:pPrDefault>[\s\S]*?<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(stylesXml)?.[1] ?? ""}</w:pPr><w:rPr>${/<w:rPrDefault>[\s\S]*?<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(stylesXml)?.[1] ?? ""}</w:rPr>`);
  if (defaults.size === undefined) defaults.size = 10; // the OOXML default when nothing sets it
  const styles = new Map<string, { name: string; basedOn?: string; props: Props }>();
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    styles.set(m[1], { name: (attr(m[2], "name", "val") ?? m[1]).toLowerCase(), basedOn: attr(m[2], "basedOn", "val"), props: propsOf(m[2]) });
  }
  const defaultPara = /<w:style\b[^>]*w:type="paragraph"[^>]*w:default="1"[^>]*w:styleId="([^"]+)"/.exec(stylesXml)?.[1] ?? "Normal";
  const chain = (id: string | undefined, seen = new Set<string>()): Props => {
    if (!id || seen.has(id) || !styles.has(id)) return {};
    seen.add(id);
    const s = styles.get(id)!;
    return merge(chain(s.basedOn, seen), s.props);
  };
  const numLevel = (numId?: string, ilvl = "0"): Props => {
    if (!numId || !numXml) return {};
    const absId = new RegExp(`<w:num\\b[^>]*w:numId="${numId}"[^>]*>[\\s\\S]*?<w:abstractNumId w:val="(\\d+)"`).exec(numXml)?.[1];
    const abs = absId ? new RegExp(`<w:abstractNum\\b[^>]*w:abstractNumId="${absId}"[^>]*>([\\s\\S]*?)</w:abstractNum>`).exec(numXml)?.[1] : null;
    const lvl = abs ? new RegExp(`<w:lvl\\b[^>]*w:ilvl="${ilvl}"[^>]*>([\\s\\S]*?)</w:lvl>`).exec(abs)?.[1] : null;
    return lvl ? propsOf(lvl) : {};
  };
  const sect = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(xml)?.[0] ?? "";
  const pg = (a: string, d: number) => (num(attr(sect, "pgSz", a)) ?? d) / 20;
  const mg = (a: string, d: number) => (num(attr(sect, "pgMar", a)) ?? d) / 20;
  const columns = num(attr(sect, "cols", "num")) ?? 1;
  const paras: DocxPara[] = [];
  // Mark the paragraphs inside tables and text boxes by their offsets in the XML.
  const spans = (re: RegExp) => [...xml.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
  const tblSpans = spans(/<w:tbl>[\s\S]*?<\/w:tbl>/g), boxSpans = spans(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g);
  const inside = (i: number, ss: number[][]) => ss.some(([a, b]) => i >= a && i < b);
  for (const m of xml.matchAll(/<w:p\b(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const inner = m[1];
    if (/<w:p[\s>]/.test(inner)) continue; // an outer paragraph holding a text box: its inner ones are read on their own
    const text = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((x) => (x[1] === undefined ? " " : unesc(x[1]))).join("").replace(/\s+/g, " ").trim();
    const own = propsOf(inner);
    const styleId = attr(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(inner)?.[0] ?? "", "pStyle", "val") ?? defaultPara;
    const st = chain(styleId);
    const numbered = own.numbered ?? st.numbered;
    const p = merge(defaults, st, numbered ? numLevel(own.numId ?? st.numId, own.ilvl ?? st.ilvl) : {}, own);
    const runs = [...inner.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].filter((r) => /<w:t[\s>]/.test(r[1]));
    const sizes = [...new Set(runs.map((r) => { const s = num(attr(/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(r[1])?.[0] ?? "", "sz", "val")); return s !== undefined ? s / 2 : p.size ?? 10; }))];
    const fonts = [...new Set(runs.map((r) => attr(/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(r[1])?.[0] ?? "", "rFonts", "ascii") ?? p.font ?? "Calibri"))];
    const boldRuns = runs.filter((r) => /<w:b\/>|<w:b w:val="(?:1|true)"\/>/.test(r[1]));
    const sname = styles.get(styleId)?.name ?? styleId.toLowerCase();
    paras.push({
      text, style: styleId, styleName: sname, outline: !!p.outline || /heading/.test(sname), left: p.left ?? 0, hanging: p.hanging ?? 0, firstLine: p.firstLine ?? 0,
      before: p.before ?? 0, after: p.after ?? 0, line: p.line ?? null, lineRule: p.lineRule ?? "auto", sizes: sizes.length ? sizes : [p.size ?? 10], fonts,
      bold: runs.length > 0 && (boldRuns.length === runs.length || (!!p.bold && !runs.some((r) => /<w:b w:val="(?:0|false)"\/>/.test(r[1])))), numbered: !!numbered,
      tabs: p.tabs ?? [], align: p.align ?? "left", caps: !!p.caps, inTable: inside(m.index!, tblSpans), inTextBox: inside(m.index!, boxSpans), border: !!p.border,
    });
  }
  const tableTextCells = [...xml.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].filter((c) => /<w:t[\s>][^<]*\S/.test(c[1])).length;
  const hf = [...parts.keys()].filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).map((n) => [...dec(n).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((x) => unesc(x[1])).join(" ").trim()).filter(Boolean);
  return {
    kind: "docx", page: { w: pg("w", 12240), h: pg("h", 15840) }, margins: { top: mg("top", 1440), right: mg("right", 1440), bottom: mg("bottom", 1440), left: mg("left", 1440) }, columns,
    paras: paras.filter((p) => p.text), tables: (xml.match(/<w:tbl>/g) || []).length, tableTextCells, textBoxes: boxSpans.length,
    drawings: (xml.match(/<w:drawing>|<w:pict>/g) || []).length, images: [...parts.keys()].filter((n) => /^word\/media\//.test(n)).length, headerFooterText: hf,
  };
}

// ---------------------------------------------------------------- shared text helpers
export const wordsOf = (s: string | string[]) => (Array.isArray(s) ? s.join(" ") : s).replace(/[•–—·▪●]/g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]{0,6}\\.?";
export const DATE_RANGE = new RegExp(`^(?:${MONTH}\\s+)?(?:\\d{1,2}/)?\\d{4}(?:\\s*[–—-]\\s*(?:(?:${MONTH}\\s+)?(?:\\d{1,2}/)?\\d{4}|Present|Current|Now))?$`, "i");
// A bullet glyph: a dash or dot character, or one private-use character (Word and LibreOffice set a Symbol-font bullet as U+F0B7).
export const isGlyph = (s: string) => /^(?:[•–·▪●○◦\-*]|[\uE000-\uF8FF])$/u.test(s.trim());
