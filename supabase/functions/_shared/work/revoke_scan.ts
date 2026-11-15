// WO-124a: the revoke scan (spec D4). A value the person took back is searched for in every part of the bytes: each
// OOXML part (unzipped), metadata, filenames, alt text, and derived forms of the value. The audit names categories and
// counts only; it never repeats a value, a form or a part name (a part name can itself carry the value).
import { gunzipSync, unzipSync, unzlibSync } from "npm:fflate@0.8.2";
import { asciiDigits } from "./model.ts";

export type RevokedValue = string | number | { before: string | number; after: string | number };
export type PartCategory = "body" | "metadata" | "alt text or media" | "comments or notes" | "filename" | "unreadable container";
export interface RevokeHit { part: string; category: PartCategory; value: number; form: "percent" | "number" | "pair" | "text" }

const UNIT_WORDS: Record<string, string> = {
  "%": "\\s?(?:%|per\\s?cent\\b|pct\\b|percentage\\s+points?\\b)",
  ms: "\\s?(?:ms\\b|msecs?\\b|milliseconds?\\b)",
  s: "\\s?(?:s\\b|secs?\\b|seconds?\\b)",
  h: "\\s?(?:h\\b|hrs?\\b|hours?\\b)",
  k: "\\s?(?:k\\b|thousand\\b)",
  m: "\\s?(?:m\\b|mn\\b|million\\b)",
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The integer part may be written with or without thousands separators (17280, 17,280, 17 280, 17.280, 17'280).
function digitsPattern(intPart: string): string {
  const groups: string[] = [];
  for (let i = intPart.length; i > 0; i -= 3) groups.unshift(intPart.slice(Math.max(0, i - 3), i));
  return groups.join("[,.\\u00a0\\u202f' ]?");
}

// Every written form of one number: as typed, rounded to whole and to one decimal, any separator style. A rounded form is
// added only when it keeps at least two significant digits (17.28 -> 17, 17.3; but 2.5 -> not 3, and 0.4 -> not 0),
// so a revoke never matches every lone "0" or "3" in a file (second review of WO-124a). exact = no rounded forms.
function numberPattern(n: number, exact = false): string {
  const forms = new Set<string>();
  const sig = (x: string) => x.replace(/^-?0*\.?0*/, "").replace(/\./, "").length;
  const add = (x: string) => {
    const [i, d] = x.replace(/^-/, "").split(".");
    // Trailing zeros are the same number: 0.4 is also 0.40, and 40 is also 40.0 (review of WO-124a).
    forms.add(digitsPattern(i) + (d ? `[.,]${d}0*` : "(?:[.,]0+)?"));
  };
  add(String(Math.abs(n)));
  if (!exact && !Number.isInteger(n)) {
    for (const r of [String(Math.round(Math.abs(n))), Math.abs(n).toFixed(1).replace(/\.0$/, "")]) if (sig(r) >= 2) add(r);
  }
  return `(?<![\\d.,])-?(?:${[...forms].join("|")})(?![\\d]|[.,]\\d)`;
}

// The words form of a whole number below a million ("forty", "forty-two", "one hundred and five"), as a pattern that
// takes a space or a hyphen between words and an optional "and". Fractions have no words form here.
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function under1000(n: number): string[] {
  const out: string[] = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], "hundred"); n %= 100; if (n) out.push("and?"); }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) out.push(ONES[n]); }
  else if (n > 0 || !out.length) out.push(ONES[n]);
  return out;
}
function numberWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n >= 1e6) return null;
  const parts = n >= 1000 ? [...under1000(Math.floor(n / 1000)), "thousand", ...(n % 1000 ? under1000(n % 1000) : [])] : under1000(n);
  return parts.map((w, i) => w === "and?" ? "(?:and[\\s-]+)?" : (i ? "" : "") + w + (i < parts.length - 1 && parts[i + 1] !== "and?" ? "[\\s-]+" : (parts[i + 1] === "and?" ? "[\\s-]+" : ""))).join("");
}

interface Parsed { num: number; unit: string | null; currency: string | null }
function parse(v: string | number): Parsed | null {
  if (typeof v === "number") return Number.isFinite(v) ? { num: v, unit: null, currency: null } : null;
  const m = v.trim().match(/^([$€£¥₹])?\s*(-?\d[\d,  ]*(?:\.\d+)?)\s*(%|[A-Za-z]+)?$/);
  if (!m) return null;
  const num = Number(m[2].replace(/[,  ]/g, ""));
  return Number.isFinite(num) ? { num, unit: m[3] ?? null, currency: m[1] ?? null } : null;
}

function matchersFor(v: RevokedValue): { form: RevokeHit["form"]; test: (s: string) => boolean } {
  if (typeof v === "object" && v !== null) {
    const a = matchersFor(v.before), b = matchersFor(v.after);
    const pa = parse(v.before), pb = parse(v.after);
    const bare = (p: Parsed | null) => p ? new RegExp(numberPattern(p.num)) : null;
    const ba = bare(pa), bb = bare(pb);
    // Either value alone is a hit; so are both bare numbers in one part ("from 250 to 150").
    return { form: "pair", test: (s) => a.test(s) || b.test(s) || (!!ba && !!bb && ba.test(s) && bb.test(s)) };
  }
  const p = parse(v);
  if (!p) {
    const re = new RegExp(esc(clean(String(v)).normalize("NFC").trim()).replace(/\s+/g, "[\\s\\-_]+"), "i");
    return { form: "text", test: (s) => re.test(s) };
  }
  const unit = p.unit ? UNIT_WORDS[p.unit.toLowerCase()] ?? `\\s?${esc(p.unit)}\\b` : "";
  // A small whole number (under 10) is everywhere in a file; it is a hit only with its own unit or currency sign beside
  // it ("$5", "5%", "5 ms"), never bare (third review of WO-124a: revoking $1 blocked every file).
  const small = Number.isInteger(p.num) && Math.abs(p.num) < 10;
  const cur = p.currency ? `${esc(p.currency)}\\s?` : "";
  const res = [new RegExp((small && cur ? cur : "") + numberPattern(p.num) + unit, "i")];
  // Round 4 (D-088): a bare small number (revoked "7") is matched bare too: a miss that reports "nothing found" fails
  // open, a false block fails closed. Markup and app.xml counters are no longer read, so this blocks far less than before.
  if (small && !unit && !cur) res.splice(0, 1, new RegExp(numberPattern(p.num)));
  // Numbers compared as numbers: float noise (0.30000000000000004), E-notation (1.728E4, 4E-1) and leading-dot
  // decimals (.4) are the same value. Targets: the value (not when small), a percent's fraction (only when not a whole
  // number: 100% is 1 and 0% is 0, which every file holds), and the scaled whole of a k/m/bn value.
  const targets: number[] = [];
  // A small number revoked with its unit or sign ("$5") matches bare only in stored cell values, where the sign is a format
  // and not text (<v>5</v>); in prose it needs its sign ("score 5 of 9" is not "$5").
  const cellOnly = small && !!(unit || cur);
  targets.push(p.num);
  const words = numberWords(Math.abs(p.num));
  if (words) res.push(new RegExp(`\\b${words}\\b` + unit, "i"));
  // A percent is also stored as its fraction: an xlsx cell formatted 0% holds <v>0.4</v> for 40%.
  const pct = p.unit === "%" || /^(?:percent|pct)$/i.test(p.unit ?? "");
  if (pct && !Number.isInteger(p.num / 100)) { res.push(new RegExp(numberPattern(Number((p.num / 100).toPrecision(12)), true))); targets.push(p.num / 100); }
  // Scaled forms: $1.5m is also 1,500,000; 17,280 is also 17.3k / 17k / 17.28 thousand (second review of WO-124a).
  const scale = p.unit ? ({ k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, bn: 1e9, b: 1e9, billion: 1e9 } as Record<string, number>)[p.unit.toLowerCase()] : undefined;
  if (scale) { res.push(new RegExp(numberPattern(p.num * scale, true))); targets.push(p.num * scale); }
  const whole = scale ? p.num * scale : p.num;
  for (const [div, word] of [[1e3, "(?:k|thousand)"], [1e6, "(?:m|mn|million)"], [1e9, "(?:bn|b|billion)"]] as const) {
    if (Math.abs(whole) >= div && Math.abs(whole) < div * 1000) res.push(new RegExp(numberPattern(Number((whole / div).toPrecision(6))) + `\\s?${word}\\b`, "i"));
  }
  const near = (x: number, t: number) => Math.abs(x - t) <= 1e-9 * Math.max(1, Math.abs(t));
  const numeric = (s: string) => {
    const isCells = s.startsWith(CELLS);
    return numbersIn(s).some((x) => targets.some((t) => near(x, t) && (!cellOnly || t !== p.num || isCells)));
  };
  return { form: p.unit === "%" ? "percent" : "number", test: (s) => res.some((re) => re.test(s)) || numeric(s) };
}

function categoryOf(part: string): PartCategory {
  const p = part.toLowerCase();
  if (/docprops\/|customxml\/|\[content_types\]|\.rels$/.test(p)) return "metadata";
  if (/media\/|alt|descr/.test(p)) return "alt text or media";
  if (/comment|notesslide|footnote|endnote/.test(p)) return "comments or notes";
  return "body";
}

const isZip = (b: Uint8Array) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const decoder = new TextDecoder("utf-8", { fatal: false });
// A part may be UTF-16 (a BOM, or every other byte zero, as in some exported XML and text). Each likely encoding is
// read; scanning a wrong decoding only costs a non-match, never a miss.
function decodings(b: Uint8Array): string[] {
  const out = [decoder.decode(b)];
  const bomLE = b[0] === 0xff && b[1] === 0xfe, bomBE = b[0] === 0xfe && b[1] === 0xff;
  let zeroOdd = 0, zeroEven = 0;
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 ? zeroOdd++ : zeroEven++);
  if (bomLE || zeroOdd > n / 8) out.push(new TextDecoder("utf-16le").decode(b));
  if (bomBE || zeroEven > n / 8) out.push(new TextDecoder("utf-16be").decode(b));
  return out;
}
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Every number written in a text, as a number (E-notation and leading-dot decimals included).
function numbersIn(s: string): number[] {
  return [...s.matchAll(/(?<![\w.])[-−]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(?![\w])/g)].map((m) => Number(m[0].replace("−", "-"))).filter(Number.isFinite);
}
// Markup is not content (third review of WO-124a): version="1.0", sheetId="1", sz="12" and pageMargins left="0.7"
// made every file "hold" a revoked 100%, $1, $12 or 30%. A part is read as its text (tags removed, and tags as spaces
// for values split across runs) plus only the attributes that carry text a person sees (alt text, titles, names). ISO
// timestamps are removed first, so a 12:00 in core.xml is not a revoked 12.
// Round 4: reading only a few named attributes missed values in namespaced (w:val, w:instr, w:alias), single-quoted and
// relationship (Target="mailto:...") attributes. Fail closed instead: every attribute value is read EXCEPT those whose
// local name is structural (ids, sizes, positions, styles, versions, namespaces), and docProps/app.xml's counters.
const ATTR = /\s([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const STRUCTURAL = new Set(["version", "encoding", "standalone", "id", "rid", "sheetid", "r", "s", "t", "sz", "szcs", "w", "h", "x", "y", "cx", "cy", "ilvl", "numid",
  "left", "right", "top", "bottom", "header", "footer", "gutter", "space", "basecolwidth", "defaultrowheight", "ht", "customwidth", "width", "min", "max",
  "xfid", "fontid", "fillid", "borderid", "numfmtid", "applynumberformat", "applyfont", "applyfill", "applyborder", "applyalignment", "count", "uniquecount",
  "idx", "order", "ptcount", "type", "xmlns", "ignorable", "lang", "eastasia", "bidi", "ascii", "hansi", "cs", "rsidr", "rsidrpr", "rsidrdefault", "rsidp",
  "rsidsect", "tabselected", "workbookviewid", "activetab", "zoomscale", "spans", "dyDescent".toLowerCase(), "rot", "flip", "prst", "algn", "anchor", "lins", "tins", "rins", "bins",
  "dirty", "b", "i", "u", "baseline", "kern", "spc", "cap", "extension", "contenttype", "partname", "targetmode", "calcid", "fullcalcload", "fullcalconload",
  "pos", "lim", "dist", "distt", "distb", "distl", "distr", "simplepos", "relativeheight", "behinddoc", "locked", "layoutincell", "allowoverlap", "noproof",
  "orient", "code", "char", "pitchfamily", "charset", "typeface", "panose", "mod", "sx", "sy", "kx", "ky", "spid", "shapeid", "nvpr", "ph", "hasCustomPrompt".toLowerCase()]);
const CELLS = "\u0002cells ";
const VAL_CONTENT = new Set(["alias", "tag", "docvar", "listitem", "displaytext", "placeholder", "comboboxitem", "dropdownlistitem", "text", "title", "fldsimple",
  "default", "listentry", "statustext", "helptext", "cfvo", "crossesat", "max", "min", "result", "calcpr"]);
const APP_COUNTERS = /<(?:\w+:)?(?:AppVersion|TotalTime|Words|Characters|CharactersWithSpaces|Pages|Lines|Paragraphs|Slides|Notes|HiddenSlides|MMClips|DocSecurity)>[^<]*</gi;
// OOXML parts (XML inside a zip) are read without markup; any other file (code, HTML, plain text) is also read raw, so a
// value inside "a<b ... >" survives (round 5).
const isOoxmlPart = (part: string) => /\.(?:xml|rels|vml)$/i.test(part);
function views(raw: string, pdf = false, part = ""): string[] {
  raw = raw.replace(/<!\[CDATA\[([^]*?)\]\]>/g, " $1 ").replace(/<!--([^]*?)-->/g, " $1 ");
  const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
  const xml = !pdf && /<[A-Za-z?!\/]/.test(raw);
  if (!xml) return [clean(unent(raw))];
  // app.xml (extended properties) by name, or by shape: a <Properties> root holding <AppVersion>. Only there are the
  // counters stripped (round 5: stripping them from every part hid a customXml <Notes>).
  const appXml = /docProps\/app\.xml$/i.test(part) || (/<(?:\w+:)?Properties\b/.test(raw) && /<(?:\w+:)?AppVersion>/.test(raw));
  const body = appXml ? raw.replace(APP_COUNTERS, "<") : raw;
  // "val" is content only on elements that carry text (a content control's alias or tag, a document variable, a
  // presentation tag, a list item); on sz, color, jc, numFmt and the like it is a setting.
  const attrs: string[] = [];
  for (const tag of body.matchAll(/<(?:[\w.-]+:)?([\w.-]+)(\s[^>]*)>/g)) {
    const el = tag[1].toLowerCase();
    for (const m of tag[2].matchAll(ATTR)) {
      const name = m[2].toLowerCase(), prefix = (m[1] ?? "").toLowerCase();
      if (prefix.startsWith("xmlns") || name === "xmlns" || STRUCTURAL.has(name)) continue;
      if (name === "val" && !VAL_CONTENT.has(el)) continue;
      attrs.push(m[3] ?? m[4] ?? "");
    }
  }
  // Stored cell values on their own (xlsx <v>, pivot-cache v=): the view in which a "$5" is just 5.
  const cells = [...body.matchAll(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>|<(?:\w+:)?n\s[^>]*\bv="([^"]*)"/g)].map((m) => m[1] ?? m[2]).join(" ");
  const texts = [body.replace(/<[^>]*>/g, ""), body.replace(/<[^>]*>/g, " "), attrs.join(" \u0001 ")];
  const rawView = isOoxmlPart(part) ? [] : [clean(unent(raw))];
  return [...texts.map((t) => clean(unent(t))), ...rawView, CELLS + clean(unent(cells))];
}
// NFKC (fullwidth), every script's digits as ASCII, one apostrophe and quote form, no zero-width characters, and no ISO
// timestamps.
export function clean(t: string): string {
  return asciiDigits(t.normalize("NFKC"))
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/[\u2018\u2019\u201B\u2032\u00B4`]/g, "'").replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, " ");
}

// A PDF's text is in Flate-compressed content streams; each is inflated and its string operands added as a part, so a
// value docs.ts printed in a PDF is found (second review of WO-124d: the scan saw nothing in a PDF).
const isPdf = (b: Uint8Array) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
// Every PDF string, decoded (round 5): literal strings with all escapes (\\ddd octal, \\n, \\(, line continuations),
// hex strings, and UTF-16BE strings that start with FE FF.
function decodePdfLiteral(body: string): string {
  return body.replace(/\\(?:([0-7]{1,3})|(\r\n|\r|\n)|(.))/g, (_m, oct?: string, nl?: string, ch?: string) =>
    oct ? String.fromCharCode(parseInt(oct, 8)) : nl ? "" : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[ch!] ?? ch!);
}
function utf16be(bin: string): string {
  if (bin.charCodeAt(0) !== 0xfe || bin.charCodeAt(1) !== 0xff) return bin;
  let out = "";
  for (let i = 2; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
  return out;
}
export function pdfStrings(src: string): string[] {
  const lit = [...src.matchAll(/\((?:\\[^]|[^\\)])*\)/g)].map((m) => utf16be(decodePdfLiteral(m[0].slice(1, -1))));
  const hex = [...src.matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((m) => {
    const h = m[1].replace(/\s+/g, ""); let bin = "";
    for (let i = 0; i + 1 < h.length; i += 2) bin += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    return utf16be(bin);
  });
  return [lit.join(" "), lit.join(""), hex.join(" "), hex.join("")];
}
// Round 6: a stream with a filter other than FlateDecode, a Flate stream that will not inflate, or a Type0 (CID) font
// whose glyph codes are not text cannot be read, so the PDF is reported as unreadable rather than clean.
export function pdfUnreadable(bytes: Uint8Array): boolean {
  const s = new TextDecoder("latin1").decode(bytes);
  if (/\/Subtype\s*\/Type0\b/.test(s)) return true;
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const dict = s.slice(Math.max(0, m.index! - 400), m.index!);
    const filters = [...(dict.slice(dict.lastIndexOf("<<")).matchAll(/\/(\w+Decode|AHx|A85|Fl|LZW|RL|CCF|DCT)\b/g))].map((x) => x[1]);
    if (filters.some((f) => f !== "FlateDecode" && f !== "Fl" && f !== "DCTDecode" && f !== "DCT")) return true;
    if (filters.length && filters.every((f) => f === "FlateDecode" || f === "Fl")) {
      const start = m.index! + m[0].length, end = s.indexOf("endstream", start);
      try { unzlibSync(bytes.subarray(start, s[end - 1] === "\n" ? (s[end - 2] === "\r" ? end - 2 : end - 1) : end)); } catch { return true; }
    }
  }
  return false;
}
function pdfText(bytes: Uint8Array): string[] {
  const s = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length, end = s.indexOf("endstream", start);
    if (end < 0) continue;
    let body = bytes.subarray(start, end);
    try { body = unzlibSync(body); } catch { /* not Flate: read as is */ }
    const ops = new TextDecoder("latin1").decode(body);
    out.push(...pdfStrings(ops));
  }
  return out;
}

// Round 5: a container the scan cannot open (too deeply nested, corrupt, or gzip) is never a clean part: it is
// returned as unreadable, and scan() reports it as a hit for every value (fail closed).
const MAX_DEPTH = 6;
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
function partsOf(files: Record<string, Uint8Array>): [string, Uint8Array, boolean][] {
  const out: [string, Uint8Array, boolean][] = [];
  const walk = (name: string, bytes: Uint8Array, depth: number) => {
    if (isZip(bytes)) {
      if (depth >= MAX_DEPTH) { out.push([name, bytes, true]); return; }
      let inner: Record<string, Uint8Array>;
      try { inner = unzipSync(bytes); } catch { out.push([name, bytes, true]); return; }
      for (const [n, b] of Object.entries(inner)) walk(`${name}!${n}`, b, depth + 1);
      return;
    }
    if (isGzip(bytes)) {
      if (depth >= MAX_DEPTH) { out.push([name, bytes, true]); return; }
      try { walk(`${name}!gunzip`, gunzipSync(bytes), depth + 1); } catch { out.push([name, bytes, true]); }
      return;
    }
    out.push([name, bytes, false]);
  };
  for (const [n, b] of Object.entries(files)) walk(n, b, 0);
  return out;
}

// Returns a promise so a later scanner (a PDF text layer) can join without changing callers.
export function scan(files: Record<string, Uint8Array>, values: RevokedValue[]): Promise<RevokeHit[]> {
  const ms = values.map(matchersFor);
  const hits: RevokeHit[] = [];
  for (const [part, bytes, unreadable] of partsOf(files)) {
    if (unreadable) { ms.forEach((m, i) => hits.push({ part, category: "unreadable container", value: i, form: m.form })); continue; }
    const pdf = isPdf(bytes);
    if (pdf && pdfUnreadable(bytes)) { ms.forEach((m, i) => hits.push({ part, category: "unreadable container", value: i, form: m.form })); continue; }
    const texts = [...decodings(bytes), ...(pdf ? [...pdfText(bytes), ...pdfStrings(new TextDecoder("latin1").decode(bytes))] : [])].flatMap((t) => views(t, pdf, part));
    // The whole path, every folder included (124e review: a revoked value in a bundle's folder name was delivered).
    const name = clean(part.split("!").join(" ").replace(/[\/\\]/g, " ")).normalize("NFKC");
    ms.forEach((m, i) => {
      if (m.test(name)) hits.push({ part, category: "filename", value: i, form: m.form });
      else if (texts.some((t) => m.test(t))) hits.push({ part, category: categoryOf(part), value: i, form: m.form });
    });
  }
  return Promise.resolve(hits);
}

const FORM_WORD: Record<RevokeHit["form"], string> = { percent: "a percentage", number: "a number", pair: "a before-and-after pair", text: "a phrase" };
export function audit(hits: RevokeHit[]): string {
  if (!hits.length) return "Revoke scan: no revoked value was found in any part, filename or metadata.";
  const byCat = new Map<string, Set<string>>();
  for (const h of hits) byCat.set(h.category, (byCat.get(h.category) ?? new Set()).add(h.part));
  const forms = [...new Set(hits.map((h) => FORM_WORD[h.form]))].join(", ");
  const where = [...byCat].map(([c, ps]) => `${c} (${ps.size === 1 ? "one part" : `${ps.size} parts`})`).join("; ");
  return `Revoke scan: a revoked value is still present, in ${where}. Kinds found: ${forms}. Not deliverable until removed.`;
}
