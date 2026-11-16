// WO-124a: the revoke scan (spec D4). A value the person took back is searched for in every part of the bytes: each
// OOXML part (unzipped), metadata, filenames, alt text, and derived forms of the value. The audit names categories and
// counts only; it never repeats a value, a form or a part name (a part name can itself carry the value).
import { unzlibSync } from "npm:fflate@0.8.2";
import zlib from "node:zlib";
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
    return { form: "text", test: (s) => re.test(s) || subs.some((m) => m.test(s)) };
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
const VAL_CONTENT = new Set(["alias", "tag", "docvar", "listitem", "displaytext", "placeholder", "comboboxitem", "dropdownlistitem", "text", "title", "fldsimple",
  "default", "listentry", "statustext", "helptext", "cfvo", "crossesat", "max", "min", "result", "calcpr"]);
const APP_COUNTERS = /<(?:\w+:)?(?:AppVersion|TotalTime|Words|Characters|CharactersWithSpaces|Pages|Lines|Paragraphs|Slides|Notes|HiddenSlides|MMClips|DocSecurity)>[^<]*</gi;
// OOXML parts (XML inside a zip) are read without markup; any other file (code, HTML, plain text) is also read raw, so a
// value inside "a<b ... >" survives (round 5).
const isOoxmlPart = (part: string) => /\.(?:xml|rels|vml)$/i.test(part);
function views(raw: string, pdf = false, part = ""): string[] {
  raw = raw.replace(/<!\[CDATA\[([^]*?)\]\]>/g, " $1 ").replace(/<!--([^]*?)-->/g, " $1 ");
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
  for (const m of body.matchAll(ATTR)) {
    const name = m[2].toLowerCase(), prefix = (m[1] ?? "").toLowerCase();
    if (prefix.startsWith("xmlns") || name === "xmlns" || STRUCTURAL.has(name)) continue;
    const el = (/<(?:[\w.-]+:)?([\w.-]+)(?:\s+[^\s=<>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/.exec(body.slice(0, m.index!))?.[1] ?? "").toLowerCase();
    if (name === "val" && !VAL_CONTENT.has(el)) continue;
    attrs.push(m[3] ?? m[4] ?? "");
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
    .replace(/\b\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):?[0-5]\d)?(?![\d:]|\.\d)/g, " ");
}

// A PDF's text is in Flate-compressed content streams; each is inflated and its string operands added as a part, so a
// value docs.ts printed in a PDF is found (second review of WO-124d: the scan saw nothing in a PDF).
// Round 9: readers accept %PDF anywhere in the first 1024 bytes, so the scan does too.
const isPdf = (b: Uint8Array) => b.length > 4 && latin1(b.subarray(0, 1024)).includes("%PDF");
// Round 9: "stream" is followed by CRLF, LF, a lone CR, or spaces before the end of line; each is a stream start.
// Round 10: only after a dictionary's close (">>"), as a reader parses it; the word "stream" in a title is not one.
// Round 11: a comment ("%…" to the end of its line) between ">>" and "stream" is whitespace to a reader, so to the scan too.
const STREAM = />>(?:\s|%[^\r\n]*(?:\r\n|\r|\n))*stream[ \t]*(\r\n|\r|\n)?/g;
function streamBody(bytes: Uint8Array, s: string, m: RegExpMatchArray): Uint8Array | null {
  const start = m.index! + m[0].length, end = s.indexOf("endstream", start);
  if (end < 0) return null;
  return bytes.subarray(start, s[end - 1] === "\n" ? (s[end - 2] === "\r" ? end - 2 : end - 1) : s[end - 1] === "\r" ? end - 1 : end);
}
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
  // Fonts whose codes are not text, encryption, and any /Filter anywhere in the file that is not plain Flate or DCT
  // (an indirect /Filter, an array, LZW, ASCII85...) make the PDF unreadable (round 7: a nested dictionary hid the filter).
  if (/\/Subtype\s*\/Type[03]\b|\/Encrypt\b/.test(s)) return true;
  for (const f of s.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+|\d+\s+\d+\s+R)/g)) {
    const names = f[1].startsWith("[") ? [...f[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]) : f[1].startsWith("/") ? [f[1].slice(1)] : ["(indirect)"];
    if (!names.length || names.some((n) => !["FlateDecode", "Fl", "DCTDecode", "DCT"].includes(n))) return true;
  }
  for (const m of s.matchAll(STREAM)) {
    if (!m[1]) return true; // "stream" with no end of line: not a stream the scan can place
    const dict = s.slice(Math.max(0, m.index! - 400), m.index!);
    const filters = [...(dict.slice(dict.lastIndexOf("<<")).matchAll(/\/(\w+Decode|AHx|A85|Fl|LZW|RL|CCF|DCT)\b/g))].map((x) => x[1]);
    if (filters.some((f) => f !== "FlateDecode" && f !== "Fl" && f !== "DCTDecode" && f !== "DCT")) return true;
    if (filters.some((f) => f === "DCTDecode" || f === "DCT")) continue; // an image
    const body = streamBody(bytes, s, m);
    if (!body) return true;
    // Round 9: a stream is readable only if it inflates or is plain text; a Flate stream whose dictionary the scan
    // did not see is never read as raw bytes.
    try { unzlibSync(body); } catch { if (filters.length || binary(body)) return true; }
  }
  return false;
}
function pdfText(bytes: Uint8Array): string[] {
  const s = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  for (const m of s.matchAll(STREAM)) {
    if (!m[1]) continue;
    let body = streamBody(bytes, s, m);
    if (!body) continue;
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
// Round 11: an entity past the last code point is left as written, never a throw.
function cp(n: number, raw: string): string { return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw; }
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
// Inflates a raw deflate stream to its true end, with no size hint; returns the data and how many input bytes it used.
function inflateRaw(b: Uint8Array, max = 256 * 1024 * 1024): [Uint8Array, number] {
  // (capped, so a small entry cannot expand without bound; past the cap it throws and the container is unreadable)
  const r = zlib.inflateRawSync(b, { info: true, maxOutputLength: max } as never) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
  return [new Uint8Array(r.buffer), r.engine.bytesWritten];
}
// Round 11: the zip is read from its own central directory, not by unzip's name-keyed map: every entry (duplicate names
// included) is returned, each inflated to its true end with no size hint, and an entry whose size, CRC, flags or method
// disagree with its headers, or a duplicate name, makes the zip unreadable (throws).
function zipEntries(b: Uint8Array): [string, Uint8Array][] {
  // Round 12: a zip is opened only when every byte of it is accounted for, so nothing in it goes unread: exactly one end record
  // in the tail; one disk; its count, the records parsed and the central directory's size agree; the directory ends at the end
  // record and the comment at the end of the file; entries tile the file from byte 0 to the directory with no gap or overlap;
  // each local header matches its central record (name, flags, method, CRC and sizes, or a matching data descriptor); only
  // known extra fields. Anything else throws, and the file is unreadable.
  let ends = 0;
  for (let i = Math.max(0, b.length - 65557); i + 3 < b.length; i++) if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) ends++;
  const e = eocdAt(b);
  if (e < 0 || ends !== 1) throw new RangeError("end record");
  const n = u16(b, e + 10), cdSize = u32(b, e + 12), cdOff = u32(b, e + 16);
  if (u16(b, e + 4) || u16(b, e + 6) || u16(b, e + 8) !== n || n === 0xffff || cdOff === 0xffffffff) throw new RangeError("end record fields");
  if (cdOff + cdSize !== e || e + 22 + u16(b, e + 20) !== b.length) throw new RangeError("directory bounds");
  const KNOWN_EXTRA = new Set([0x5455, 0x7875, 0x000a, 0xcafe, 0x5855, 0x7855]);
  const extrasOk = (x: Uint8Array) => { let q = 0; while (q < x.length) { if (q + 4 > x.length) return false; const id = u16(x, q), len = u16(x, q + 2); if (!KNOWN_EXTRA.has(id) || q + 4 + len > x.length) return false; q += 4 + len; } return true; };
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
  return out;
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
    if (flg & 4) q += 2 + u16(m, q);
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
function partsOf(files: Record<string, Uint8Array>): [string, Uint8Array, boolean][] {
  const out: [string, Uint8Array, boolean][] = [];
  const walk = (name: string, bytes: Uint8Array, depth: number) => {
    if (isZip(bytes)) {
      if (depth >= MAX_DEPTH) { out.push([name, bytes, true]); return; }
      let inner: [string, Uint8Array][];
      try { inner = zipEntries(bytes); } catch { out.push([name, bytes, true]); return; }
      let note: string;
      try { note = zipComments(bytes); } catch { out.push([name, bytes, true]); return; }
      if (note) out.push([`${name}!comment`, new TextEncoder().encode(note), false]);
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
    out.push([name, bytes, false]);
  };
  for (const [n, b] of Object.entries(files)) walk(n, b, 0);
  return out;
}

// Returns a promise so a later scanner (a PDF text layer) can join without changing callers.
export function scan(files: Record<string, Uint8Array>, values: RevokedValue[]): Promise<RevokeHit[]> {
  // A value the scan cannot build a matcher for is a hit everywhere (fail closed), never a throw or a clean pass.
  const ms = values.map((v) => {
    try { return matchersFor(v); } catch { return { form: "text" as const, test: () => true }; }
  });
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
