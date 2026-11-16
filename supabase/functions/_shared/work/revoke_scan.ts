// WO-124a: the revoke scan (spec D4). A value the person took back is searched for in every part of the bytes: each
// OOXML part (unzipped), metadata, filenames, alt text, and derived forms of the value. The audit names categories and
// counts only; it never repeats a value, a form or a part name (a part name can itself carry the value).
//
// Scope (owner ruling, fifteenth review of WO-124a): only files Trainee's own writers produce are delivered (provenance.ts;
// deliver.ts refuses any other bytes). Outside files are never re-delivered, so this scan is a second check on Trainee's own
// output, not a general-format reader. Stated limits for OUTSIDE files (not fixed here, since such files are refused before
// any send): an image's chunk or segment bytes that are not text chunks (PNG tIME/pHYs/IHDR padding/IDAT/sPLT entries, JPEG
// APP0/APP14/DQT/scan data, numeric Exif tags, bytes after an IFD, UTF-16 XMP or iTXt, IRB resolution blocks) are not read;
// a PDF's filter chains, indirect /DecodeParms, strings split between literal and hex form, non-content Flate streams
// (JavaScript, ICC, Flate-wrapped JPEG), embedded fonts with a built-in encoding, incremental updates that redefine an object,
// and non-ASCII characters of WinAnsi/MacRoman encodings are not read as a reader would. What does hold on any input: scan()
// never throws, finishes within its time budget, and reports "unreadable container" (fail closed) when it cannot finish.
import zlib from "node:zlib";
import { asciiDigits } from "./model.ts";
import { isGif, isJpeg, isPng, jpegText, meter, pngText } from "./image_text.ts";

// WO-124a fifteenth review (B2): one scan's budget. Every byte decoded, inflated or lexed is charged; past a few times the
// input's size (with a floor and a hard cap), or past the deadline, the scan stops and every file reads as unreadable.
export class ScanLimit extends Error { constructor() { super("revoke scan budget exceeded"); this.name = "ScanLimit"; } }
const BUDGET = { left: Infinity, deadline: Infinity };
export const SCAN_DEADLINE_MS = 1800;
function charge(n: number): void {
  BUDGET.left -= n;
  if (BUDGET.left < 0 || performance.now() > BUDGET.deadline) throw new ScanLimit();
}
const isLimit = (e: unknown) => e instanceof ScanLimit || e instanceof RangeError && /buffer|length|size|memory/i.test(e.message) ||
  (e as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE";
// zlib-wrapped data inflated within the budget; a stream past it is a ScanLimit, any other failure a plain error.
function inflateZ(b: Uint8Array): Uint8Array {
  let out: Uint8Array;
  try { out = new Uint8Array(zlib.inflateSync(b, { maxOutputLength: Math.max(1, Math.min(256 * 1024 * 1024, BUDGET.left)) } as never)); }
  catch (e) { if (isLimit(e)) throw new ScanLimit(); throw e; }
  charge(out.length);
  return out;
}

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
  // Round 9: a comma or space is a thousands group only in the US form (1,500 / 12 500); "1,5%" is not 15 but goes to the
  // text matcher, which searches both readings.
  const m = v.trim().match(/^([$€£¥₹])?\s*(-?(?:\d{1,3}(?:[,  ]\d{3})+|\d+)(?:\.\d+)?)\s*(%|[A-Za-z]+)?$/);
  if (!m) return null;
  // Round 10: one separator before exactly three digits ("1.500", "1,500", "17.280") is either a group or a decimal; such a
  // value goes to the text matcher, which searches both readings.
  if (/^-?\d{1,3}[.,]\d{3}$/.test(m[2])) return null;
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
    // Round 8: a value written in words around a number ("USD 150,000", "$150K-$160K", "1.5 million dollars", "~150000") also
    // matches each number in it, read as a value with its scale, so the number itself is searched for (fail closed).
    // Round 9: a comma is a US thousands group only as \d{1,3}(,\d{3})+; any other comma or a dot before exactly three
    // digits is read both ways ("1,5" is 1.5 and 15; "1.500" is 1.5 and 1500), so neither reading is missed.
    const nums = [...clean(String(v)).matchAll(/[$€£¥₹]?\s?(\d+(?:[.,]\d+)*)\s?(?:(%|percent\b|per\s?cent\b|pct\b)|(k|m|mn|bn|thousand|million|billion)\b)?/gi)].flatMap((m) => {
      const t = m[1], pct = !!m[2], sc = ({ k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, bn: 1e9, billion: 1e9 } as Record<string, number>)[(m[3] ?? "").toLowerCase()] ?? 1;
      const reads = new Set<number>();
      if (/^\d+(?:\.\d+)?$/.test(t)) reads.add(Number(t));
      if (/^\d{1,3}\.\d{3}$/.test(t)) reads.add(Number(t.replace(".", "")));
      if (t.includes(",")) {
        reads.add(Number(t.replace(/,/g, "")));
        if ((t.match(/,/g) ?? []).length === 1 && !t.includes(".")) reads.add(Number(t.replace(",", ".")));
      }
      if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(t)) reads.add(Number(t.replace(/\./g, "").replace(",", ".")));
      // Round 11: with a currency, or "000" after the separator, one separator before three digits is a thousands group only
      // ("$150,000" is not 150; "$1,500" is not 1.5); the decimal reading is kept only for a bare value like "1,500" or "1.500".
      const money = /[$€£¥₹]/.test(m[0]) || /\b(?:usd|eur|gbp|inr|jpy|cad|aud|dollars?|euros?|pounds?|rupees?)\b/i.test(String(v));
      if ((money || /[.,]000$/.test(t)) && /^\d{1,3}[.,]\d{3}$/.test(t)) { reads.clear(); reads.add(Number(t.replace(/[.,]/, ""))); }
      // Round 10: a percent keeps its sign on each reading, so its stored-fraction form (0.015 for 1,5%) is searched too.
      return [...reads].map((n) => pct ? `${n * sc}%` : n * sc);
    }).filter((n) => typeof n === "string" || (Number.isFinite(n) && !(Number.isInteger(n) && Math.abs(n) < 10)));
    const subs = nums.map((n) => matchersFor(n));
    // Round 14 (B5): in a JOINED view (PDF strings run together, separators removed) the phrase is matched with its own
    // separators removed, so a gap drawn by a kerning offset counts as an optional space.
    const bare = clean(String(v)).normalize("NFC").trim().replace(/[\s\-_]+/g, "");
    const joined = bare.length >= 2 ? new RegExp(esc(bare), "i") : null;
    return { form: "text", test: (s) => re.test(s) || (!!joined && s.startsWith(JOINED) && joined.test(s)) || subs.some((m) => m.test(s)) };
  }
  const unit = p.unit ? UNIT_WORDS[p.unit.toLowerCase()] ?? `\\s?${esc(p.unit)}\\b` : "";
  // A small whole number (under 10) is everywhere in a file; it is a hit only with its own unit or currency sign beside
  // it ("$5", "5%", "5 ms"), never bare (third review of WO-124a: revoking $1 blocked every file).
  const small = Number.isInteger(p.num) && Math.abs(p.num) < 10;
  const cur = p.currency ? `${esc(p.currency)}\\s?` : "";
  const res = [new RegExp((small && cur ? cur : "") + numberPattern(p.num) + unit, "i")];
  // A number revoked with a unit is also the number alone ("150000 USD" is in "$150,000 a year"), unless it is small
  // (round 7). Small numbers keep their unit or sign, or a stored cell (below).
  if (!small && (unit || cur)) res.push(new RegExp(numberPattern(p.num)));
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

// Round 9: a zip is known by its end-of-central-directory record too, so bytes before the first entry (a stub, a
// prefix) do not make it a plain part.
function eocdAt(b: Uint8Array): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  return -1;
}
const isZip = (b: Uint8Array) => (b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) || eocdAt(b) >= 0;
const u16 = (b: Uint8Array, i: number) => { if (i < 0 || i + 1 >= b.length) throw new RangeError("short"); return b[i] | (b[i + 1] << 8); };
const u32 = (b: Uint8Array, i: number) => u16(b, i) + u16(b, i + 2) * 65536;
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
// Round 9: the archive comment and each entry's comment are text in the file that unzip does not return.
function zipComments(b: Uint8Array): string {
  const e = eocdAt(b);
  if (e < 0) return "";
  const out = [new TextDecoder().decode(b.subarray(e + 22, e + 22 + u16(b, e + 20)))];
  let p = u32(b, e + 16);
  for (let k = 0, n = u16(b, e + 10); k < n; k++) {
    if (u32(b, p) !== 0x02014b50) throw new RangeError("central directory");
    // Round 10: an encrypted entry (flag bit 0) or one stored with a method unzip does not decode is unreadable; unzip returned
    // its ciphertext as if it were text.
    if ((u16(b, p + 8) & 1) || ![0, 8].includes(u16(b, p + 10))) throw new RangeError("encrypted or unknown method");
    const nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32);
    out.push(new TextDecoder().decode(b.subarray(p + 46 + nl + xl, p + 46 + nl + xl + cl)));
    p += 46 + nl + xl + cl;
  }
  return out.filter(Boolean).join("\n");
}
const decoder = new TextDecoder("utf-8", { fatal: false });
// A part may be UTF-16 (a BOM, or every other byte zero, as in some exported XML and text). Each likely encoding is
// read; scanning a wrong decoding only costs a non-match, never a miss.
function decodings(b: Uint8Array): string[] {
  charge(3 * b.length);
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
  // US-grouped numbers are read whole (round 7: 17,280 read as 17 and 280), as well as plain and E-notation ones.
  const grouped = [...s.matchAll(/(?<![\w.,])[-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w]|,\d)/g)].map((m) => Number(m[0].replace("−", "-").replace(/,/g, "")));
  const plain = [...s.matchAll(/(?<![\w.])[-−]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(?![\w])/g)].map((m) => Number(m[0].replace("−", "-")));
  return [...grouped, ...plain].filter(Number.isFinite);
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
const OPEN_OR_ATTR = new RegExp(`<(?:[\\w.-]+:)?([\\w.-]+)|${ATTR.source}`, "g");
const chainGap = (g: string) => !g || /^(?:\s+[^\s=<>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/.test(g);
const VAL_CONTENT = new Set(["alias", "tag", "docvar", "listitem", "displaytext", "placeholder", "comboboxitem", "dropdownlistitem", "text", "title", "fldsimple",
  "default", "listentry", "statustext", "helptext", "cfvo", "crossesat", "max", "min", "result", "calcpr"]);
const APP_COUNTERS = /<(?:\w+:)?(?:AppVersion|TotalTime|Words|Characters|CharactersWithSpaces|Pages|Lines|Paragraphs|Slides|Notes|HiddenSlides|MMClips|DocSecurity)>[^<]*</gi;
// OOXML parts (XML inside a zip) are read without markup; any other file (code, HTML, plain text) is also read raw, so a
// value inside "a<b ... >" survives (round 5).
const isOoxmlPart = (part: string) => /\.(?:xml|rels|vml)$/i.test(part);
// Round 15 (B4): hand-written linear scanners in place of regexes that rescan to the end from every unclosed "<", "<!--" or
// "<![CDATA[". Each keeps the regex's own result: a section with no close is left as written, and so is everything after it.
function unwrap(s: string, open: string, close: string): string {
  let out = "", i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) break;
    const z = s.indexOf(close, a + open.length);
    if (z < 0) break;
    out += s.slice(i, a) + " " + s.slice(a + open.length, z) + " ";
    i = z + close.length;
  }
  return i ? out + s.slice(i) : s;
}
// Tags removed (as /<[^>]*>/g did): each "<" to the next ">"; with no ">" left, the rest is text.
function stripTags(s: string, sep: string): string {
  let out = "", i = 0;
  for (;;) {
    const a = s.indexOf("<", i);
    if (a < 0) break;
    const z = s.indexOf(">", a + 1);
    if (z < 0) break;
    out += s.slice(i, a) + sep;
    i = z + 1;
  }
  return out + s.slice(i);
}
// Stored cell values: <v>..</v> and the v="" of a pivot cache's <n ...> tag, each tag read once from its "<" to its ">".
function cellValues(s: string): string {
  const out: string[] = [];
  for (const m of s.matchAll(/<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/g)) out.push(m[1]);
  const N = /<(?:\w+:)?n\s/y;
  for (let i = s.indexOf("<"); i >= 0; ) {
    const z = s.indexOf(">", i + 1);
    if (z < 0) break;
    N.lastIndex = i;
    if (N.test(s)) { const v = /\bv="([^"]*)"/.exec(s.slice(i, z)); if (v) out.push(v[1]); }
    i = s.indexOf("<", z + 1);
  }
  return out.join(" ");
}
function views(raw: string, pdf = false, part = ""): string[] {
  charge(8 * raw.length);
  raw = unwrap(unwrap(raw, "<![CDATA[", "]]>"), "<!--", "-->");
  const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? cp(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)), m) : ENT[e.toLowerCase()] ?? m);
  const xml = !pdf && /<[A-Za-z?!\/]/.test(raw);
  if (!xml) return [clean(unent(raw))];
  // app.xml (extended properties) by name, or by shape: a <Properties> root holding <AppVersion>. Only there are the
  // counters stripped (round 5: stripping them from every part hid a customXml <Notes>).
  const appXml = /docProps\/app\.xml$/i.test(part) || (/<(?:\w+:)?Properties\b/.test(raw) && /<(?:\w+:)?AppVersion>/.test(raw));
  const body = appXml ? raw.replace(APP_COUNTERS, "<") : raw;
  // "val" is content only on elements that carry text (a content control's alias or tag, a document variable, a
  // presentation tag, a list item); on sz, color, jc, numFmt and the like it is a setting.
  const attrs: string[] = [];
  // Round 8: attributes are read across the whole part (a quoted value may hold ">"), each with the element it sits on.
  // Round 14 (B4): one forward pass. An element start sets the element; each attribute belongs to it while only attributes
  // and spaces lie between them (the same rule the old per-attribute look-back applied, which was quadratic in the part).
  let el = "", chainEnd = -1;
  for (const m of body.matchAll(OPEN_OR_ATTR)) {
    if (m[1] !== undefined) { el = m[1].toLowerCase(); chainEnd = m.index! + m[0].length; continue; }
    const on = chainEnd >= 0 && chainGap(body.slice(chainEnd, m.index!)) ? el : "";
    chainEnd = on ? m.index! + m[0].length : -1;
    const name = m[3].toLowerCase(), prefix = (m[2] ?? "").toLowerCase();
    if (prefix.startsWith("xmlns") || name === "xmlns" || STRUCTURAL.has(name)) continue;
    if (name === "val" && !VAL_CONTENT.has(on)) continue;
    attrs.push(m[4] ?? m[5] ?? "");
  }

  // Stored cell values on their own (xlsx <v>, pivot-cache v=): the view in which a "$5" is just 5.
  const cells = cellValues(body);
  const texts = [stripTags(body, ""), stripTags(body, " "), attrs.join(" \u0001 ")];
  const rawView = isOoxmlPart(part) ? [] : [clean(unent(raw))];
  return [...texts.map((t) => clean(unent(t))), ...rawView, CELLS + clean(unent(cells))];
}
// NFKC (fullwidth), every script's digits as ASCII, one apostrophe and quote form, no zero-width characters, and no ISO
// timestamps.
export function clean(t: string): string {
  return asciiDigits(t.normalize("NFKC"))
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/[\u2018\u2019\u201B\u2032\u00B4`]/g, "'").replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\b\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):?[0-5]\d)?(?![\d:]|\.\d)/g, " ");
}

// A PDF's text is in Flate-compressed content streams; each is inflated and its string operands added as a part, so a
// value docs.ts printed in a PDF is found (second review of WO-124d: the scan saw nothing in a PDF).
const GLYPH: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", space: " ", period: ".", comma: ",", percent: "%", dollar: "$", hyphen: "-", minus: "-", plus: "+" };
// Round 9: "stream" is followed by CRLF, LF, a lone CR, or spaces before the end of line; each is a stream start.
// Round 10: only after a dictionary's close (">>"), as a reader parses it; the word "stream" in a title is not one.
// Round 11: a comment ("%…" to the end of its line) between ">>" and "stream" is whitespace to a reader, so to the scan too.
const STREAM_AT = />>(?:\s|%[^\r\n]*(?:\r\n|\r|\n))*stream[ \t]*(\r\n|\r|\n)?/y;
const OBJ_AT = /(\d+)\s+\d+\s+obj(?![\w])/y;
function streamBody(bytes: Uint8Array, s: string, m: RegExpExecArray): Uint8Array | null {
  const start = m.index + m[0].length, end = s.indexOf("endstream", start);
  if (end < 0) return null;
  return bytes.subarray(start, s[end - 1] === "\n" ? (s[end - 2] === "\r" ? end - 2 : end - 1) : s[end - 1] === "\r" ? end - 1 : end);
}
// Round 14 (D-088): a PDF is read as a reader parses it, not by windows of raw text. One forward pass skips comments,
// literal and hex strings and stream bodies, matches every << with its >>, and records each top-level dictionary, the object
// it opens ("N G obj"), and the stream after it. An unterminated string, an unbalanced >>, an unclosed << or a stream with no
// end is not a file the scan can place: the PDF is unreadable.
interface PdfStream { dict: string; num: number | null; m: RegExpExecArray; body: Uint8Array }
interface Lexed { dicts: string[]; streams: PdfStream[]; objs: Map<number, string>; bad: boolean; end: number }
// Round 15 (B3): lexing may start at an offset and stop at the close of the first top-level dictionary, so reading one
// value dictionary costs its own length, not the rest of the file. Nesting deeper than MAX_NEST is unreadable.
const MAX_NEST = 64;
function lexPdf(s: string, bytes: Uint8Array | null, start = 0, first = false): Lexed {
  const dicts: string[] = [], streams: PdfStream[] = [], objs = new Map<number, string>(), stack: number[] = [];
  let cur: number | null = null, bad = false, i = start;
  const n = s.length;
  try { return lex(); } finally { charge(i - start); }
  function lex(): Lexed {
  while (i < n) {
    const c = s[i];
    if (c === "%") { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
    if (c === "(") {
      let d = 0;
      for (; i < n; i++) { const ch = s[i]; if (ch === "\\") { i++; continue; } if (ch === "(") d++; else if (ch === ")" && --d === 0) break; }
      if (i >= n) { bad = true; break; }
      i++; continue;
    }
    if (c === "<") {
      if (s[i + 1] === "<") { stack.push(i); if (stack.length > MAX_NEST) { bad = true; break; } i += 2; continue; }
      const e = s.indexOf(">", i);
      if (e < 0) { bad = true; break; }
      i = e + 1; continue;
    }
    if (c === ">" && s[i + 1] === ">") {
      const o = stack.pop();
      if (o === undefined) { bad = true; break; }
      if (!stack.length) {
        const dict = s.slice(o, i + 2), num = cur;
        dicts.push(dict);
        if (first) { i += 2; return { dicts, streams, objs, bad, end: i }; }
        if (cur !== null) { if (!objs.has(cur)) objs.set(cur, dict); cur = null; }
        if (bytes) {
          STREAM_AT.lastIndex = i;
          const m = STREAM_AT.exec(s);
          if (m) {
            const body = m[1] ? streamBody(bytes, s, m) : null; // "stream" with no end of line: not a stream the scan can place
            if (!body) { bad = true; break; }
            streams.push({ dict, num, m, body });
            i = s.indexOf("endstream", m.index + m[0].length) + 9; continue;
          }
        }
      }
      i += 2; continue;
    }
    if (!stack.length && c >= "0" && c <= "9" && (i === 0 || /[\s\])>]/.test(s[i - 1]))) {
      OBJ_AT.lastIndex = i;
      const m = OBJ_AT.exec(s);
      if (m) { cur = Number(m[1]); i += m[0].length; continue; }
    }
    i++;
  }
  return { dicts, streams, objs, bad: bad || stack.length > 0, end: i };
  }
}
// Names may be written with #xx escapes (/Type#30 is /Type0); every check reads them decoded.
const names = (d: string) => (charge(d.length), d).replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
// A dictionary's own top level: nested dictionaries kept only as "<<>>" and strings dropped, so a key is read where it is.
function topLevel(d: string): string {
  charge(d.length);
  let out = "", depth = 0;
  for (let i = 0; i < d.length; i++) {
    if (d[i] === "(") { let k = 0; for (; i < d.length; i++) { if (d[i] === "\\") { i++; continue; } if (d[i] === "(") k++; else if (d[i] === ")" && --k === 0) break; } continue; }
    if (d[i] === "<" && d[i + 1] === "<") { if (++depth === 2) out += "<<"; i++; continue; }
    if (d[i] === ">" && d[i + 1] === ">") { if (depth-- === 2) out += ">>"; i++; continue; }
    if (depth <= 1) out += d[i];
  }
  return out;
}
const FLATE = (d: string) => /\/(?:FlateDecode|Fl)(?![\w])/.test(names(d));
// Each stream is inflated once per scan (round 15: it was inflated up to three times, with no cap on two of them).
const INFLATED = new WeakMap<PdfStream, Uint8Array | Error>();
function inflated(st: PdfStream): Uint8Array {
  let r = INFLATED.get(st);
  if (r === undefined) {
    try { r = inflateZ(st.body); } catch (e) { if (e instanceof ScanLimit) throw e; r = e instanceof Error ? e : new Error(String(e)); }
    INFLATED.set(st, r);
  }
  if (r instanceof Error) throw r;
  return r;
}
const streamData = (st: PdfStream) => FLATE(st.dict) ? inflated(st) : st.body;
// The objects of a PDF: raw ones, and those packed in compressed object streams (/Type /ObjStm, PDF 1.5+, pdf-lib's default),
// whose inflated text is kept too so every structural check reads it (round 14: fonts packed there were never checked).
interface PdfModel { s: string; streams: PdfStream[]; dicts: string[]; objs: Map<number, string>; packed: string[]; bad: boolean }
const MODELS = new WeakMap<Uint8Array, PdfModel>();
function pdfModel(bytes: Uint8Array): PdfModel {
  const had = MODELS.get(bytes);
  if (had) return had;
  const s = latin1(bytes), lx = lexPdf(s, bytes), packed: string[] = [], dicts = [...lx.dicts];
  let bad = lx.bad;
  for (const st of lx.streams) {
    const own = topLevel(names(st.dict));
    if (!/\/Type\s*\/ObjStm(?![\w])/.test(own)) continue;
    let t: string;
    try { t = latin1(streamData(st)); } catch { bad = true; continue; }
    packed.push(t);
    const N = /\/N\s+(\d+)/.exec(own), F = /\/First\s+(\d+)/.exec(own);
    if (!N || !F) { bad = true; continue; }
    const first = Number(F[1]), count = Number(N[1]), headText = t.slice(0, first).trim();
    const head = headText ? headText.split(/\s+/).map(Number) : [];
    if (head.length !== 2 * count || head.some((x) => !Number.isInteger(x) || x < 0)) { bad = true; continue; }
    for (let k = 0; k < count; k++) {
      const piece = t.slice(first + head[2 * k + 1], k + 1 < count ? first + head[2 * k + 3] : t.length), sub = lexPdf(piece, null);
      if (sub.bad) bad = true;
      dicts.push(...sub.dicts);
      if (sub.dicts.length && /^\s*<</.test(piece) && !lx.objs.has(head[2 * k])) lx.objs.set(head[2 * k], sub.dicts[0]);
    }
  }
  const model = { s, streams: lx.streams, dicts, objs: lx.objs, packed, bad };
  MODELS.set(bytes, model);
  return model;
}
// The values of a dictionary of references (a font resource dictionary, an /EF dictionary): each is "N G R" (resolved
// through the object table) or an inline dictionary. Anything else, or a reference to no object, returns null.
function entries(d: string, objs: Map<number, string>): { dict: string | null; num: number | null }[] | null {
  // Round 15 (B3): read in place with sticky patterns; no slice of the rest per entry.
  if (!d.startsWith("<<") || !d.endsWith(">>")) return null;
  const end = d.length - 2, out: { dict: string | null; num: number | null }[] = [];
  const K = /\/[^\s\/<>\[\]()]*/y, R = /(\d+)\s+\d+\s+R(?![\w])/y;
  let i = 2;
  const sp = () => { while (i < end && /\s/.test(d[i])) i++; };
  for (sp(); i < end; sp()) {
    K.lastIndex = i;
    const k = K.exec(d);
    if (!k) return null;
    i += k[0].length; sp();
    R.lastIndex = i;
    const r = R.exec(d);
    if (r && i + r[0].length <= end) { i += r[0].length; out.push({ dict: objs.get(Number(r[1])) ?? null, num: Number(r[1]) }); continue; }
    if (d.startsWith("<<", i)) { const sub = lexPdf(d, null, i, true); if (!sub.dicts.length || sub.end > end) return null; out.push({ dict: sub.dicts[0], num: null }); i = sub.end; continue; }
    return null;
  }
  return out;
}
// The value at a key: an inline dictionary, or the dictionary an "N G R" reference names (null when it names none).
function valueDicts(d: string, key: string, objs: Map<number, string>): (string | null)[] {
  const out: (string | null)[] = [], re = new RegExp(`\\/${key}(?![\\w])\\s*(?:(<<)|(\\d+)\\s+\\d+\\s+R(?![\\w]))`, "g");
  for (const m of d.matchAll(re)) {
    if (m[1]) { const sub = lexPdf(d, null, m.index! + m[0].length - 2, true); out.push(sub.dicts[0] ?? null); }
    else out.push(objs.get(Number(m[2])) ?? null);
  }
  return out;
}
// Round 14 (D-088): a font is readable only on an allow-list: a simple Type1 or TrueType font whose codes are its standard
// encoding's characters (none, WinAnsi, MacRoman or Standard), with no /Differences, no /ToUnicode and no descendants. A
// Type0 or Type3 font, a CMap, a custom encoding, or any other shape draws codes that are not the text the scan reads.
function fontReadable(d: string): boolean {
  const full = names(d), top = topLevel(full);
  const sub = [...top.matchAll(/\/Subtype\s*\/([^\s\/<>\[\]()]+)/g)].map((m) => m[1]);
  if (sub.length !== 1 || !["Type1", "TrueType"].includes(sub[0])) return false;
  if (/\/(?:ToUnicode|DescendantFonts|Differences)(?![\w])/.test(full)) return false;
  const enc = [...top.matchAll(/\/Encoding(?![\w])\s*(\/[^\s\/<>\[\]()]+)?/g)];
  return enc.length === 0 || (enc.length === 1 && /^\/(?:WinAnsiEncoding|MacRomanEncoding|StandardEncoding)$/.test(enc[0][1] ?? ""));
}
// Every font in the file: each dictionary that is one (/Type /Font or a /BaseFont at its top level), and each entry of every
// /Font resource dictionary, inline or referenced. A font entry that names no object is unreadable.
function fontsReadable(md: PdfModel): boolean {
  for (const raw of md.dicts) {
    const d = names(raw);
    if (/\/Type\s*\/Font(?![\w])|\/BaseFont(?![\w])/.test(topLevel(d)) && !fontReadable(d)) return false;
    for (const res of valueDicts(d, "Font", md.objs)) {
      if (res === null) return false;
      const es = entries(names(res), md.objs);
      if (!es || es.some((e) => e.dict === null || !fontReadable(e.dict))) return false;
    }
  }
  return true;
}
// Round 14 (B1): attachments by structure. A stream is an attachment if its own dictionary (nested /Params included) says
// /Type /EmbeddedFile, or if any /EF dictionary references it. Each /EF value must name a stream the scan opens; an
// /EmbeddedFile dictionary that is not a stream's own (packed, inline, or stray), an /EF that is not a dictionary of
// references, or related files (/RF) make the PDF unreadable.
function attachments(md: PdfModel): { refs: Set<number>; bad: boolean } {
  const refs = new Set<number>();
  let bad = false;
  const streamDicts = new Set(md.streams.map((st) => st.dict));
  for (const raw of md.dicts) {
    const d = names(raw);
    if (/\/EmbeddedFile(?![\w])/.test(d) && !streamDicts.has(raw)) bad = true;
    if (/\/RF(?![\w])/.test(d)) bad = true;
    if (/\/EF(?![\w])/.test(d)) {
      const vals = valueDicts(d, "EF", md.objs);
      if (!vals.length) bad = true;
      for (const v of vals) {
        const es = v === null ? null : entries(names(v), md.objs);
        if (!es || es.some((e) => e.num === null)) { bad = true; continue; }
        for (const e of es) refs.add(e.num!);
      }
    }
  }
  for (const p of md.packed) if (/\/EmbeddedFile(?![\w])/.test(names(p))) bad = true;
  const streamNums = new Set(md.streams.map((st) => st.num));
  for (const r of refs) if (!streamNums.has(r)) bad = true;
  return { refs, bad };
}
// Round 13: the inflated bodies of a PDF's metadata (XMP) and embedded-file streams, which viewers show (document properties,
// attachments) but the string reading of content streams never saw. Content streams stay read by their strings only, since
// their operators are full of layout numbers.
export function pdfStreams(bytes: Uint8Array): Uint8Array[] {
  const md = pdfModel(bytes), out: Uint8Array[] = [], { refs } = attachments(md);
  for (const st of md.streams) {
    if (!/\/Type\s*\/(?:Metadata|EmbeddedFile)(?![\w])|\/Subtype\s*\/XML(?![\w])/.test(names(st.dict)) && !(st.num !== null && refs.has(st.num))) continue;
    try { out.push(streamData(st)); } catch (e) { if (e instanceof ScanLimit) throw e; out.push(st.body); }
  }
  return out;
}
// Round 9: readers accept %PDF anywhere in the first 1024 bytes, so the scan does too.
const isPdf = (b: Uint8Array) => b.length > 4 && latin1(b.subarray(0, 1024)).includes("%PDF");
// A stream that does not inflate and holds control bytes is compressed or binary data the scan cannot read.
const binary = (b: Uint8Array) => b.some((x) => x < 0x09 || (x > 0x0d && x < 0x20));
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
// Round 14 (B5): text drawn in pieces ("[(J)83(ordan)-333(Pik)28(e)] TJ", or strings placed one by one) may have a space at
// any gap or none. The strings run together, with every space, hyphen and underscore removed, are a JOINED view, in which a
// phrase is matched with its separators removed too ("JordanPike"), so each gap counts as an optional space.
export const JOINED = "\u0003joined ";
const squeeze = (t: string) => JOINED + t.replace(/[\s\-_]+/g, "");
// Round 15 (B4): literal strings found by a linear scan with the old pattern's meaning: from "(" to the first ")" that is not
// escaped. When one "(" has no such ")", no later one has either (the escapes pair up the same way), so the scan stops.
function literals(src: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf("("); i >= 0; ) {
    let j = i + 1;
    while (j < src.length && src[j] !== ")") j += src[j] === "\\" ? 2 : 1;
    if (j >= src.length) break;
    out.push(src.slice(i + 1, j));
    i = src.indexOf("(", j + 1);
  }
  return out;
}
export function pdfStrings(src: string): string[] {
  charge(6 * src.length);
  const lit = literals(src).map((m) => utf16be(decodePdfLiteral(m)));
  const hex = [...src.matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((m) => {
    const h = m[1].replace(/\s+/g, ""); let bin = "";
    for (let i = 0; i + 1 < h.length; i += 2) bin += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    return utf16be(bin);
  });
  return [lit.join(" "), lit.join(""), hex.join(" "), hex.join(""), squeeze(lit.join("")), squeeze(hex.join(""))];
}
// Round 15 (B4): the body of each "[" ... "]" array that follows a key, found by indexOf (the old /\[[^\]]*\]/ pattern rescanned
// to the end from every unclosed "["). An array with no "]" yields null and stops the list.
function* arrays(s: string, key: RegExp): Generator<string | null> {
  for (const m of s.matchAll(key)) {
    const a = m.index! + m[0].length, z = s.indexOf("]", a);
    if (z < 0) { yield null; return; }
    yield s.slice(a, z);
  }
}
// Each /Filter value: an array (with its brackets), a name, or an indirect reference; null for an array with no close.
function* filterValues(s: string): Generator<string | null> {
  const V = /\s*(\[|\/[A-Za-z0-9]+|\d+\s+\d+\s+R)/y;
  for (const m of s.matchAll(/\/Filter/g)) {
    V.lastIndex = m.index! + m[0].length;
    const v = V.exec(s);
    if (!v) continue;
    if (v[1] !== "[") { yield v[1]; continue; }
    const z = s.indexOf("]", V.lastIndex);
    if (z < 0) { yield null; return; }
    yield s.slice(V.lastIndex - 1, z + 1);
  }
}
// Round 6: a stream with a filter other than FlateDecode, a Flate stream that will not inflate, or a font whose codes are
// not text cannot be read, so the PDF is reported as unreadable rather than clean.
export function pdfUnreadable(bytes: Uint8Array): boolean {
  const md = pdfModel(bytes);
  if (md.bad) return true;
  // Round 14: every check below reads the raw bytes and the inflated object streams, names decoded.
  const s = names([md.s, ...md.packed].join("\n"));
  // Fonts whose codes are not text, encryption, and any /Filter anywhere in the file that is not plain Flate or DCT
  // (an indirect /Filter, an array, LZW, ASCII85...) make the PDF unreadable (round 7: a nested dictionary hid the filter).
  if (/\/Subtype\s*\/Type[03]\b|\/Encrypt\b/.test(s)) return true;
  // Round 13: a simple font's /Differences that draws a code as another digit or letter ("a" drawn as "one") hides text
  // from the string reading, so the PDF is unreadable. (Round 14's font allow-list refuses every /Differences on a font.)
  for (const d of arrays(s, /\/Differences\s*\[/g)) {
    if (d === null) return true; // an array with no close
    let code = -1;
    for (const t of d.matchAll(/(\d+)|\/([A-Za-z0-9._]+)/g)) {
      if (t[1]) { code = Number(t[1]); continue; }
      const ch = GLYPH[t[2]] ?? (/^[A-Za-z]$/.test(t[2]) ? t[2] : null);
      if (ch !== null && code >= 0 && ch !== String.fromCharCode(code)) return true;
      code++;
    }
  }
  for (const f of filterValues(s)) {
    if (f === null) return true; // an array with no close
    const fs = f.startsWith("[") ? [...f.matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]) : f.startsWith("/") ? [f.slice(1)] : ["(indirect)"];
    if (!fs.length || fs.some((n) => !["FlateDecode", "Fl", "DCTDecode", "DCT"].includes(n))) return true;
  }
  if (!fontsReadable(md) || attachments(md).bad) return true;
  for (const st of md.streams) {
    // Round 14: the stream's own dictionary, matched << to >>, nested dictionaries included, however long.
    const own = names(st.dict);
    const filters = [...own.matchAll(/\/(\w+Decode|AHx|A85|Fl|LZW|RL|CCF|DCT)\b/g)].map((x) => x[1]);
    if (filters.some((f) => f !== "FlateDecode" && f !== "Fl" && f !== "DCTDecode" && f !== "DCT")) return true;
    if (filters.some((f) => f === "DCTDecode" || f === "DCT")) continue; // an image
    // Round 13: a PNG/TIFF predictor scrambles the inflated bytes, so such a stream is unreadable unless it is a cross-reference
    // stream (numbers about the file's layout, not content).
    if (/\/Predictor\s+(\d+)/.test(own) && Number(/\/Predictor\s+(\d+)/.exec(own)![1]) > 1 && !/\/Type\s*\/XRef\b/.test(own)) return true;
    // Round 9: a stream is readable only if it inflates or is plain text; a Flate stream whose dictionary the scan
    // did not see is never read as raw bytes.
    try { inflated(st); } catch (e) { if (e instanceof ScanLimit) throw e; if (filters.length || binary(st.body)) return true; }
  }
  return false;
}
function pdfText(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (const st of pdfModel(bytes).streams) {
    let body = st.body;
    try { body = inflated(st); } catch (e) { if (e instanceof ScanLimit) throw e; /* not Flate: read as is */ }
    out.push(...pdfStrings(latin1(body)));
  }
  return out;
}

// Round 5: a container the scan cannot open (too deeply nested, corrupt, or gzip) is never a clean part: it is
// returned as unreadable, and scan() reports it as a hit for every value (fail closed).
const MAX_DEPTH = 6;
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
// Round 11: an entity past the last code point is left as written, never a throw.
function cp(n: number, raw: string): string { return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw; }
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
// Inflates a raw deflate stream to its true end, with no size hint; returns the data and how many input bytes it used.
function inflateRaw(b: Uint8Array, max = 256 * 1024 * 1024): [Uint8Array, number] {
  // (capped, so a small entry cannot expand without bound; past the cap it throws and the container is unreadable)
  // (round 15: also within the scan's budget; past it, a ScanLimit)
  const cap = Math.max(1, Math.min(max, BUDGET.left));
  let r: { buffer: Uint8Array; engine: { bytesWritten: number } };
  try { r = zlib.inflateRawSync(b, { info: true, maxOutputLength: cap } as never) as unknown as typeof r; }
  catch (e) { if (cap < max && isLimit(e)) throw new ScanLimit(); throw e; }
  charge(r.buffer.length);
  return [new Uint8Array(r.buffer), r.engine.bytesWritten];
}
// Round 11: the zip is read from its own central directory, not by unzip's name-keyed map: every entry (duplicate names
// included) is returned, each inflated to its true end with no size hint, and an entry whose size, CRC, flags or method
// disagree with its headers, or a duplicate name, makes the zip unreadable (throws).
function zipEntries(b: Uint8Array): [[string, Uint8Array][], string] {
  // Round 12: a zip is opened only when every byte of it is accounted for, so nothing in it goes unread: exactly one end record
  // in the tail; one disk; its count, the records parsed and the central directory's size agree; the directory ends at the end
  // record and the comment at the end of the file; entries tile the file from byte 0 to the directory with no gap or overlap;
  // each local header matches its central record (name, flags, method, CRC and sizes, or a matching data descriptor); only
  // known extra fields. Anything else throws, and the file is unreadable.
  const ends: number[] = [];
  for (let i = Math.max(0, b.length - 65557); i + 3 < b.length; i++) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) ends.push(i);
  const e = eocdAt(b);
  if (e < 0) throw new RangeError("end record");
  const n = u16(b, e + 10), cdSize = u32(b, e + 12), cdOff = u32(b, e + 16);
  if (u16(b, e + 4) || u16(b, e + 6) || u16(b, e + 8) !== n || n === 0xffff || cdOff === 0xffffffff) throw new RangeError("end record fields");
  if (cdOff + cdSize !== e || e + 22 + u16(b, e + 20) !== b.length) throw new RangeError("directory bounds");
  // Round 13: Office's growth-hint padding (0xa220) is a known field; every known field's payload is also read as text (a
  // payload is file bytes like any other), returned as one "extra fields" part.
  const KNOWN_EXTRA = new Set([0x5455, 0x7875, 0x000a, 0xcafe, 0x5855, 0x7855, 0xa220]);
  const extras: Uint8Array[] = [];
  const extrasOk = (x: Uint8Array) => { let q = 0; while (q < x.length) { if (q + 4 > x.length) return false; const id = u16(x, q), len = u16(x, q + 2); if (!KNOWN_EXTRA.has(id) || q + 4 + len > x.length) return false; extras.push(x.subarray(q + 4, q + 4 + len)); q += 4 + len; } return true; };
  const out: [string, Uint8Array][] = [], seen = new Set<string>(), spans: [number, number][] = [];
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    if (u32(b, p) !== 0x02014b50) throw new RangeError("central directory");
    const flags = u16(b, p + 8), method = u16(b, p + 10), crc = u32(b, p + 16), csize = u32(b, p + 20), usize = u32(b, p + 24);
    const nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), off = u32(b, p + 42);
    const nameBytes = b.subarray(p + 46, p + 46 + nl), name = new TextDecoder().decode(nameBytes);
    if ((flags & 1) || ![0, 8].includes(method) || csize === 0xffffffff || usize === 0xffffffff || seen.has(name)) throw new RangeError("entry");
    if (u16(b, p + 34) || !extrasOk(b.subarray(p + 46 + nl, p + 46 + nl + xl))) throw new RangeError("central extra");
    seen.add(name);
    if (u32(b, off) !== 0x04034b50 || u16(b, off + 6) !== flags || u16(b, off + 8) !== method) throw new RangeError("local header");
    const lnl = u16(b, off + 26), lxl = u16(b, off + 28);
    const lname = b.subarray(off + 30, off + 30 + lnl);
    if (lnl !== nl || lname.some((x, i) => x !== nameBytes[i]) || !extrasOk(b.subarray(off + 30 + lnl, off + 30 + lnl + lxl))) throw new RangeError("local name or extra");
    const desc = (flags & 8) !== 0;
    const lc = u32(b, off + 14), lcs = u32(b, off + 18), lus = u32(b, off + 22);
    if (!desc ? (lc !== crc || lcs !== csize || lus !== usize) : ((lc || lcs || lus) && (lc !== crc || lcs !== csize || lus !== usize))) throw new RangeError("local sizes");
    const start = off + 30 + lnl + lxl;
    if (start + csize > cdOff) throw new RangeError("short entry");
    const raw = b.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) { if (csize !== usize) throw new RangeError("stored size"); data = raw; }
    else { const [d, used] = inflateRaw(raw, usize + 1); if (used !== csize) throw new RangeError("deflate length"); data = d; }
    if (data.length !== usize || crc32(data) !== crc) throw new RangeError("size or crc");
    let endAt = start + csize;
    if (desc) {
      const q = u32(b, endAt) === 0x08074b50 ? endAt + 4 : endAt;
      if (u32(b, q) !== crc || u32(b, q + 4) !== csize || u32(b, q + 8) !== usize) throw new RangeError("data descriptor");
      endAt = q + 12;
    }
    spans.push([off, endAt]);
    out.push([name, data]);
    p += 46 + nl + xl + cl;
  }
  if (p !== e) throw new RangeError("directory size");
  spans.sort((x, y) => x[0] - y[0]);
  let at = 0;
  for (const [a, z] of spans) { if (a !== at) throw new RangeError("gap or overlap"); at = z; }
  if (at !== cdOff) throw new RangeError("bytes before the directory");
  // Round 13: an end-record signature inside an entry's own data (a stored zip inside the zip) is that entry's, not a second
  // end record of this file; any other one is.
  // (round 15: one merge of two sorted lists, not every signature against every entry)
  let outside = 0;
  for (let k = 0, j = 0; k < ends.length; k++) {
    while (j < spans.length && spans[j][1] <= ends[k]) j++;
    if (!(j < spans.length && ends[k] >= spans[j][0])) outside++;
  }
  if (outside !== 1) throw new RangeError("second end record");
  // Round 14: returned apart from the entries, so it is read as the text it is and no entry can take its name.
  return [out, extras.some((x) => x.length) ? extras.map(latin1).join("\n") : ""];
}
// Round 11: every gzip member, each to its true end, with its CRC and size checked; the file must end exactly after the last
// member. Returns the data of all members and the text of every header (stored names and comments).
function gzipMembers(b: Uint8Array): [Uint8Array, string] {
  const datas: Uint8Array[] = [], metas: string[] = [];
  let p = 0;
  while (p < b.length) {
    const m = b.subarray(p);
    if (m.length < 18 || m[0] !== 0x1f || m[1] !== 0x8b || m[2] !== 8 || (m[3] & 0xe0)) throw new RangeError("gzip member");
    const flg = m[3];
    let q = 10;
    if (flg & 4) { const xl = u16(m, q); metas.push(latin1(m.subarray(q + 2, q + 2 + xl))); q += 2 + xl; } // round 13: FEXTRA is read too
    for (const bit of [8, 16]) { if (!(flg & bit)) continue; const end = m.indexOf(0, q); if (end < 0) throw new RangeError("gzip header"); metas.push(latin1(m.subarray(q, end))); q = end + 1; }
    if (flg & 2) q += 2;
    const [d, used] = inflateRaw(m.subarray(q));
    const t = q + used;
    if (t + 8 > m.length || u32(m, t) !== crc32(d) || u32(m, t + 4) !== (d.length >>> 0)) throw new RangeError("gzip trailer");
    datas.push(d); p += t + 8;
  }
  if (!datas.length) throw new RangeError("empty gzip");
  const all = new Uint8Array(datas.reduce((n, d) => n + d.length, 0)); let i = 0; for (const d of datas) { all.set(d, i); i += d.length; }
  return [all, metas.join("\n")];
}
// Text: no control characters (C0 but tab, CR and LF; DEL; C1) once decoded as UTF-8, or as UTF-16 with a BOM, or as UTF-16
// with no BOM only when nine in ten code units are ASCII (every other byte zero), as exported XML and text are.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
function textLike(b: Uint8Array): boolean {
  charge(3 * b.length);
  const ok = (enc: string) => { try { return !CONTROL.test(new TextDecoder(enc, { fatal: true }).decode(b)); } catch { return false; } };
  if (b[0] === 0xff && b[1] === 0xfe) return ok("utf-16le");
  if (b[0] === 0xfe && b[1] === 0xff) return ok("utf-16be");
  if (ok("utf-8")) return true;
  if (b.length % 2) return false;
  let zeroOdd = 0, zeroEven = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0) (i % 2 ? zeroOdd++ : zeroEven++);
  return (zeroOdd >= 0.9 * b.length / 2 && ok("utf-16le")) || (zeroEven >= 0.9 * b.length / 2 && ok("utf-16be"));
}
function partsOf(files: Record<string, Uint8Array>): [string, Uint8Array, boolean][] {
  const out: [string, Uint8Array, boolean][] = [];
  const walk = (name: string, bytes: Uint8Array, depth: number) => {
    if (isZip(bytes)) {
      if (depth >= MAX_DEPTH) { out.push([name, bytes, true]); return; }
      let inner: [string, Uint8Array][], extra: string;
      try { [inner, extra] = zipEntries(bytes); } catch { out.push([name, bytes, true]); return; }
      let note: string;
      try { note = zipComments(bytes); } catch { out.push([name, bytes, true]); return; }
      if (note) out.push([`${name}!comment`, new TextEncoder().encode(note), false]);
      if (extra) out.push([`${name}!(zip extra fields)`, new TextEncoder().encode(extra), false]);
      for (const [n, b] of inner) walk(`${name}!${n}`, b, depth + 1);
      return;
    }
    if (isGzip(bytes)) {
      if (depth >= MAX_DEPTH) { out.push([name, bytes, true]); return; }
      let inner: Uint8Array, meta: string;
      // Round 11: every member read to its true end and checked (round 10's size and header test could be forged).
      try { [inner, meta] = gzipMembers(bytes); } catch { out.push([name, bytes, true]); return; }
      if (meta) out.push([`${name}!gzip-name`, new TextEncoder().encode(meta), false]);
      walk(`${name}!gunzip`, inner, depth + 1);
      return;
    }
    // Round 14 (B3): every other part is read only on an allow-list: a PNG or JPEG whose every chunk or segment is known
    // (its text chunks read, its thumbnail read as an image of its own), a PDF, or text (valid UTF-8 or BOM'd UTF-16 with no
    // control bytes but tab, CR and LF). Anything else (GIF, raw zlib, bzip2, xz, zstd, brotli, .xlsb, vbaProject.bin, EMF,
    // fonts) is unreadable: its bytes are not read as if they were text.
    if (isPng(bytes) || isJpeg(bytes)) {
      const r = depth < MAX_DEPTH && !isPdf(bytes) ? (isPng(bytes) ? pngText(bytes) : jpegText(bytes)) : null;
      if (!r) { out.push([name, bytes, true]); return; }
      out.push([name, new TextEncoder().encode(r.texts.join("\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")), false]);
      r.inner.forEach((b, k) => walk(`${name}!thumbnail-${k}`, b, depth + 1));
      return;
    }
    if (isPdf(bytes)) {
      // Round 13: a PDF's metadata and attachments are parts of their own (an attached docx is opened like any zip).
      if (depth < MAX_DEPTH) pdfStreams(bytes).forEach((b, k) => walk(`${name}!pdf-stream-${k}`, b, depth + 1));
      out.push([name, bytes, false]);
      return;
    }
    out.push([name, bytes, isGif(bytes) || !textLike(bytes)]);
  };
  for (const [n, b] of Object.entries(files)) walk(n, b, 0);
  return out;
}

// Round 15 (B2): the budget is a few times the input's size, with a floor and a hard cap, and a deadline.
export const SCAN_BUDGET = (inputBytes: number) => Math.min(1 << 30, 64 * inputBytes + 64 * 1024 * 1024);
// Returns a promise so a later scanner (a PDF text layer) can join without changing callers.
export function scan(files: Record<string, Uint8Array>, values: RevokedValue[]): Promise<RevokeHit[]> {
  // A value the scan cannot build a matcher for is a hit everywhere (fail closed), never a throw or a clean pass.
  const ms = values.map((v) => {
    try { return matchersFor(v); } catch { return { form: "text" as const, test: (_s: string) => true }; }
  });
  const total = Object.values(files).reduce((n, b) => n + (b?.length ?? 0), 0);
  const saved = { ...BUDGET }, savedMeter = { charge: meter.charge, left: meter.left };
  BUDGET.left = SCAN_BUDGET(total);
  BUDGET.deadline = performance.now() + SCAN_DEADLINE_MS;
  meter.charge = charge;
  meter.left = () => Math.max(0, BUDGET.left);
  try {
    return Promise.resolve(scanParts(files, ms));
  } catch {
    // Round 15 (B2): anything the scan could not finish (its budget, its deadline, or any error) is every file unreadable.
    const hits: RevokeHit[] = [];
    for (const part of Object.keys(files)) ms.forEach((m, i) => hits.push({ part, category: "unreadable container", value: i, form: m.form }));
    return Promise.resolve(hits);
  } finally {
    Object.assign(BUDGET, saved);
    meter.charge = savedMeter.charge;
    meter.left = savedMeter.left;
  }
}
type Matcher = { form: RevokeHit["form"]; test: (s: string) => boolean };
function scanParts(files: Record<string, Uint8Array>, ms: Matcher[]): RevokeHit[] {
  const hits: RevokeHit[] = [];
  for (const [part, bytes, unreadable] of partsOf(files)) {
    if (unreadable) { ms.forEach((m, i) => hits.push({ part, category: "unreadable container", value: i, form: m.form })); continue; }
    const pdf = isPdf(bytes);
    if (pdf && pdfUnreadable(bytes)) { ms.forEach((m, i) => hits.push({ part, category: "unreadable container", value: i, form: m.form })); continue; }
    const texts = [...decodings(bytes), ...(pdf ? [...pdfText(bytes), ...pdfStrings(new TextDecoder("latin1").decode(bytes))] : [])].flatMap((t) => views(t, pdf, part));
    charge(ms.length * texts.reduce((n, t) => n + t.length, 0));
    // The whole path, every folder included (124e review: a revoked value in a bundle's folder name was delivered).
    const name = clean(part.split("!").join(" ").replace(/[\/\\]/g, " ")).normalize("NFKC");
    ms.forEach((m, i) => {
      if (m.test(name)) hits.push({ part, category: "filename", value: i, form: m.form });
      else if (texts.some((t) => m.test(t))) hits.push({ part, category: categoryOf(part), value: i, form: m.form });
    });
  }
  return hits;
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
