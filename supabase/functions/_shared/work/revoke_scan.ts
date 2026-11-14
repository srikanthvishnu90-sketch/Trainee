// WO-124a: the revoke scan (spec D4). A value the person took back is searched for in every part of the bytes: each
// OOXML part (unzipped), metadata, filenames, alt text, and derived forms of the value. The audit names categories and
// counts only; it never repeats a value, a form or a part name (a part name can itself carry the value).
import { unzipSync } from "npm:fflate@0.8.2";

export type RevokedValue = string | number | { before: string | number; after: string | number };
export type PartCategory = "body" | "metadata" | "alt text or media" | "comments or notes" | "filename";
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

// Every written form of one number: as typed, rounded to whole and to one decimal, any separator style.
function numberPattern(n: number): string {
  const forms = new Set<string>();
  const add = (x: string) => {
    const [i, d] = x.replace(/^-/, "").split(".");
    forms.add(digitsPattern(i) + (d ? `[.,]${d}` : ""));
  };
  add(String(Math.abs(n)));
  if (!Number.isInteger(n)) { add(String(Math.round(Math.abs(n)))); add(Math.abs(n).toFixed(1).replace(/\.0$/, "")); }
  return `(?<![\\d.,])-?(?:${[...forms].join("|")})(?![\\d]|[.,]\\d)`;
}

interface Parsed { num: number; unit: string | null }
function parse(v: string | number): Parsed | null {
  if (typeof v === "number") return Number.isFinite(v) ? { num: v, unit: null } : null;
  const m = v.trim().match(/^[$€£]?\s*(-?\d[\d,  ]*(?:\.\d+)?)\s*(%|[A-Za-z]+)?$/);
  if (!m) return null;
  const num = Number(m[1].replace(/[,  ]/g, ""));
  return Number.isFinite(num) ? { num, unit: m[2] ?? null } : null;
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
    const re = new RegExp(esc(String(v).trim()).replace(/\s+/g, "[\\s\\-_]+"), "i");
    return { form: "text", test: (s) => re.test(s) };
  }
  const unit = p.unit ? UNIT_WORDS[p.unit.toLowerCase()] ?? `\\s?${esc(p.unit)}\\b` : "";
  const re = new RegExp(numberPattern(p.num) + unit, "i");
  return { form: p.unit === "%" ? "percent" : "number", test: (s) => re.test(s) };
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
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function views(raw: string): string[] {
  const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
  // Raw (attributes such as descr= and title= keep alt text), tags removed (a value split across runs), tags as spaces.
  return [unent(raw), unent(raw.replace(/<[^>]*>/g, "")), unent(raw.replace(/<[^>]*>/g, " "))];
}

function partsOf(files: Record<string, Uint8Array>): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  const walk = (name: string, bytes: Uint8Array, depth: number) => {
    if (depth < 3 && isZip(bytes)) {
      let inner: Record<string, Uint8Array>;
      try { inner = unzipSync(bytes); } catch { out.push([name, bytes]); return; }
      for (const [n, b] of Object.entries(inner)) walk(`${name}!${n}`, b, depth + 1);
      return;
    }
    out.push([name, bytes]);
  };
  for (const [n, b] of Object.entries(files)) walk(n, b, 0);
  return out;
}

// Returns a promise so a later scanner (a PDF text layer) can join without changing callers.
export function scan(files: Record<string, Uint8Array>, values: RevokedValue[]): Promise<RevokeHit[]> {
  const ms = values.map(matchersFor);
  const hits: RevokeHit[] = [];
  for (const [part, bytes] of partsOf(files)) {
    const texts = views(decoder.decode(bytes));
    const name = part.split("!").map((s) => s.split("/").pop() ?? s).join(" ");
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
