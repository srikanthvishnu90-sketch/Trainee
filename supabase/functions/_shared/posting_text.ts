// INGEST ROUND 3 (2026-11-03): what a board's text fields may hold once stored. Every page escapes what it shows
// (file_page.ts esc, the dashboard's textContent), but a stored title is also the subject of an application email, a
// Telegram line, the model's input and a search word, so it is stored as the plain text the board meant, never as markup:
//   scrubScripts      a <script>, <style>, <noscript>, <template> or <iframe> block and what it holds, raw or entity-escaped
//                     ("&lt;script&gt;..."), is not text: removed whole (its body used to be kept as words of the posting:
//                     "var tracking = 1; Care for patients.")
//   scrubRaw          the same over every string of one raw job, before the provider's normalizer reads it
//   decodeHtmlEntities  every named entity a board's HTML uses ("&ndash;", "&euro;", "&eacute;", "&rsquo;"), numeric ones,
//                     up to three levels deep ("&amp;amp;"). Only six were decoded: "$100,000&ndash;$120,000" read as the
//                     single figure "$100,000" and "&euro;60,000 &ndash; &euro;75,000" as no pay at all
//   plainLine         a short field (title, company, place, department): scripts out, entities decoded, HTML tags out
//                     ("<b>Senior</b> Data Analyst" -> "Senior Data Analyst"; "C++ <Remote>" keeps "<Remote>", not a tag),
//                     bidi override controls out, white space one space, storable (career_ingest_stream.ts), cut at n
//   plainText         a description: the same, every tag out
//   truthfulPostedAt  a posted date only when it can be true: parsed, not before 1995 (a seconds count read as milliseconds
//                     is January 1970) and not more than two days ahead of the read (a board's future date is no posted date)
//   sameJob           whether two titles a board gave one id are one job edited, or the id given to another job
// Pure; nothing here reads the network or a database.
import { cut, storable } from "./career_ingest_stream.ts";

// The HTML 4 / XHTML named entities job boards write (Latin-1, punctuation, currency, symbols).
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", bull: "•", prime: "′", Prime: "″",
  dagger: "†", Dagger: "‡", permil: "‰", lsaquo: "‹", rsaquo: "›", euro: "€", trade: "™", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  minus: "−", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", check: "✓", ensp: " ", emsp: " ", thinsp: " ", zwnj: "\u200c", zwj: "\u200d",
  lrm: "\u200e", rlm: "\u200f", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜", hyphen: "‐", dash: "‐",
  ...Object.fromEntries(LATIN1.map((n, i) => [n, String.fromCharCode(160 + i)])),
};
const ENTITY = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;
export function decodeHtmlEntities(s: string): string {
  let out = String(s ?? "");
  for (let i = 0; i < 3 && /&(#\d|#x[0-9a-f]|[a-z][a-z0-9]*;)/i.test(out); i++) {
    const next = out.replace(ENTITY, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
      }
      return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

// A "<" written as itself or escaped any number of times ("&lt;", "&amp;lt;", "&#60;", "&#x3c;").
const LT = String.raw`(?:<|&(?:amp;)*lt;|&(?:amp;)*#0*60;|&(?:amp;)*#x0*3c;)`;
const GT = String.raw`(?:>|&(?:amp;)*gt;|&(?:amp;)*#0*62;|&(?:amp;)*#x0*3e;)`;
const BLOCK = new RegExp(String.raw`${LT}(script|style|noscript|template|iframe)\b[\s\S]*?${LT}\/\1\s*${GT}`, "gi");
// An opening one never closed: everything after it is the block.
const OPEN_BLOCK = new RegExp(String.raw`${LT}(?:script|style|noscript|template|iframe)\b[\s\S]*$`, "i");
const COMMENT = new RegExp(String.raw`${LT}!--[\s\S]*?--${GT}`, "g");
export function scrubScripts(s: string): string {
  const t = String(s ?? "");
  if (!/script|style|noscript|template|iframe|!--/i.test(t)) return t;
  return t.replace(BLOCK, " ").replace(COMMENT, " ").replace(OPEN_BLOCK, " ");
}
// Every string of one raw job (to depth 6), scripts out; anything else as it was. A new object: the board's own is kept.
export function scrubRaw<T>(v: T, depth = 0): T {
  if (typeof v === "string") return scrubScripts(v) as unknown as T;
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrubRaw(x, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrubRaw(x, depth + 1);
  return out as T;
}

// HTML's own element names, so a word in angle brackets that is not one ("C++ <Remote>") stays text.
const TAGS = "a|abbr|address|article|aside|b|bdi|bdo|big|blockquote|body|br|button|caption|center|cite|code|col|colgroup|dd|del|details|dfn|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|mark|meta|nav|noscript|object|ol|optgroup|option|p|picture|pre|q|s|samp|script|section|select|small|source|span|strike|strong|style|sub|summary|sup|svg|path|table|tbody|td|template|textarea|tfoot|th|thead|title|tr|tt|u|ul|var|video|wbr";
const INLINE = /^(a|abbr|b|bdi|bdo|big|cite|code|dfn|em|font|i|kbd|mark|q|s|samp|small|span|strike|strong|sub|sup|tt|u|var|wbr)$/i;
const TAG = new RegExp(String.raw`<\/?(${TAGS})(?=[\s/>])[^<>]*>`, "gi");
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const stripTags = (s: string) => s.replace(/<!--[\s\S]*?-->/g, " ").replace(TAG, (_m, name: string) => (INLINE.test(name) ? "" : " "));

export function plainLine(v: unknown, max: number): string {
  let t = scrubScripts(storable(v));
  t = scrubScripts(decodeHtmlEntities(t));
  t = stripTags(t.replace(BIDI, "")).replace(/\s+/g, " ").trim();
  return cut(storable(t), max).trim();
}
export function plainText(v: unknown): string {
  const t = scrubScripts(decodeHtmlEntities(scrubScripts(String(v ?? ""))));
  return t.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------------------------------------ dates
export const POSTED_FLOOR = Date.UTC(1995, 0, 1);
export const POSTED_AHEAD_MS = 2 * 86400000;
export function truthfulPostedAt(v: unknown, nowMs: number): string | null {
  if (v === null || v === undefined || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(t) || t < POSTED_FLOOR || t > nowMs + POSTED_AHEAD_MS) return null;
  return new Date(t).toISOString();
}

// ------------------------------------------------------------------------------------------------ one job or two
// The words of a title that say which job it is: not its level, not a filler word, not a number.
const LEVEL = new Set(["senior", "sr", "junior", "jr", "lead", "staff", "principal", "head", "chief", "intern", "internship", "trainee",
  "i", "ii", "iii", "iv", "v", "level", "entry", "mid", "new", "grad", "graduate", "remote", "hybrid", "onsite", "part", "full", "time",
  "parttime", "fulltime", "contract", "temporary", "temp", "the", "a", "an", "and", "or", "of", "for", "in", "at", "to", "with", "on", "m", "w", "d", "f", "h", "x",
  "night", "nights", "day", "days", "weekend", "weekends", "shift", "team", "role", "job", "position", "opening", "urgent", "hiring", "now", "us", "usa", "eu", "uk"]);
export function titleWords(title: unknown): Set<string> {
  const t = plainLine(title, 500).toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "");
  const out = new Set<string>();
  for (const w0 of t.split(/[^\p{L}\p{N}+#]+/u)) {
    const w = w0.replace(/(?<=\p{L}{4,})s$/u, ""); // "nurses" is "nurse"
    if (w.length < 2 && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(w)) continue;
    if (LEVEL.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return out;
}
// One job edited keeps most of the words that say what it is ("Senior Software Engineer" -> "Software Engineer, Payments";
// "Registered Nurse - ICU" -> "Registered Nurse - ICU (Nights)"): the shorter title's words all in the longer, or at least
// half of all their words shared. An id the board gave to another job ("Registered Nurse" -> "Accountant", "Software
// Engineer" -> "Civil Engineer") does not. A title with no such word (only a level, only numbers) cannot tell: one job.
export function sameJob(a: unknown, b: unknown): boolean {
  const x = titleWords(a), y = titleWords(b);
  if (!x.size || !y.size) return true;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  if (shared === Math.min(x.size, y.size)) return true;
  return shared * 2 >= x.size + y.size - shared;
}
