// WO-124a: the typed artifact model (spec D1). Every number in an artifact is a cell evaluated here; prose holds
// {{ref:id}} slots, never typed figures. Formulas are arithmetic over cell ids (+ - * / and parentheses); the
// spreadsheet formula subset is xlsx.ts and formula.ts (124b).

export interface Cell { id: string; value?: number; formula?: string; unit?: string; format?: string }
export interface Model { cells: Cell[]; text: string[] }
export type Values = Record<string, number>;

export class UnknownRef extends Error {
  constructor(public ref: string) { super(`no cell "${ref}" in the model`); this.name = "UnknownRef"; }
}
export class ModelError extends Error {
  constructor(msg: string) { super(msg); this.name = "ModelError"; }
}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))/y;
  let at = 0;
  while (at < src.length) {
    if (/^\s*$/.test(src.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(src);
    if (!m) throw new ModelError(`formula "${src}": cannot read at "${src.slice(at)}"`);
    at = re.lastIndex;
    out.push(m[1] ? { t: "num", v: Number(m[1]) } : m[2] ? { t: "id", v: m[2] } : { t: "op", v: m[3] });
  }
  return out;
}

// Recursive descent: expr := term (('+'|'-') term)*; term := unary (('*'|'/') unary)*; unary := '-' unary | atom.
function compute(src: string, get: (id: string) => number): number {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) { const op = toks[i++].v; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/")) {
      const op = toks[i++].v; const r = unary();
      if (op === "/" && r === 0) throw new ModelError(`formula "${src}" divides by zero`);
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const unary = (): number => {
    if (isOp("-")) { i++; return -unary(); }
    if (isOp("+")) { i++; return unary(); }
    const k = toks[i++];
    if (!k) throw new ModelError(`formula "${src}" ends early`);
    if (k.t === "num") return k.v;
    if (k.t === "id") return get(k.v);
    if (k.v === "(") { const v = expr(); if (!isOp(")")) throw new ModelError(`formula "${src}": missing ")"`); i++; return v; }
    throw new ModelError(`formula "${src}": unexpected "${k.v}"`);
  };
  const v = expr();
  if (i < toks.length) throw new ModelError(`formula "${src}": unexpected "${(toks[i] as { v: unknown }).v}"`);
  return v;
}

export function evaluate(m: Model): Values {
  const byId = new Map<string, Cell>();
  for (const c of m.cells) {
    if (byId.has(c.id)) throw new ModelError(`cell "${c.id}" is defined twice`);
    if ((c.value === undefined) === (c.formula === undefined)) throw new ModelError(`cell "${c.id}" needs exactly one of value or formula`);
    byId.set(c.id, c);
  }
  const out: Values = {};
  const busy = new Set<string>();
  const get = (id: string): number => {
    if (id in out) return out[id];
    const c = byId.get(id);
    if (!c) throw new UnknownRef(id);
    if (busy.has(id)) throw new ModelError(`cell "${id}" refers to itself`);
    busy.add(id);
    const v = c.formula !== undefined ? compute(c.formula, get) : Number(c.value);
    busy.delete(id);
    if (!Number.isFinite(v)) throw new ModelError(`cell "${id}" is not a finite number`);
    return (out[id] = v);
  };
  for (const c of m.cells) get(c.id);
  return out;
}

// Excel-style number formats: "#,##0", "#,##0.00", "0", "0.0", "0%", "0.0%". Anything else prints the full value.
export function formatValue(v: number, fmt?: string): string {
  if (!fmt) return String(v);
  const pct = fmt.endsWith("%");
  const body = pct ? fmt.slice(0, -1) : fmt;
  const dec = (body.split(".")[1] ?? "").replace(/[^0#]/g, "").length;
  const n = pct ? v * 100 : v;
  const s = body.includes(",")
    ? n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : n.toFixed(dec);
  return pct ? `${s}%` : s;
}

export function render(text: string, values: Values, formats: Record<string, string> = {}): string {
  return text.replace(/\{\{\s*ref:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, id: string) => {
    if (!Object.hasOwn(values, id)) throw new UnknownRef(id); // own keys only: {{ref:__proto__}} is no cell
    return formatValue(values[id], formats[id]);
  });
}

// D1: the numbers typed in prose that no cell accounts for. A figure matches a cell when it equals the value at the
// precision it was typed (19,280 and 19.3k match 19280; 19,200 does not), or, with "%", the value or the value times 100.
// Read fail closed (reviews of WO-124a and WO-124d): when in doubt, a figure is listed.
//  - Every Unicode decimal digit is read as its ASCII digit first (fullwidth, Arabic-Indic, Devanagari, ...).
//  - Digits are figures even when glued to letters on either side (USD19,200, Rs19200, x30, 17280USD, 1.5x, 40ms, H1B,
//    Q3, COVID-19); a leading-dot decimal (.5%) and a sign (-500) are read.
//  - A unit decides scale: k always; m, mn, bn after a currency sign or before a currency word; "thousand", "million",
//    "billion" after a space; "percent" / "per cent" after a space is a percent. Any other unit is a label.
//  - Number words are figures ("forty percent", "twenty-five", "a dozen", "half", "twice"). A lone "one" in its
//    article sense is not listed.
//  - Calendar dates are not figures, and only real ones: an ISO date that exists (2026-11-14), a month-name date with a
//    day from 1 to 31 and a year, "Month YYYY", a clock time with am/pm or after "at", a year range of two years
//    (2024-2026, from 2024 to 2026), and a year 1900-2099 after in / since / until / through / during / FY / Q1-Q4 /
//    H1-H2 / mid- / early- / late- / a month name, when no noun follows it ("in 2026 users" lists 2026). Lower-case
//    "may" is never read as a month.
const MONTH_SRC = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const realDay = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d; };
const monthOk = (raw: string) => raw !== "may"; // "may" is a month only when capitalised ("May")
export type Span = [number, number];
export function dateSpans(t: string): Span[] {
  const out: Span[] = [];
  const add = (m: RegExpMatchArray) => out.push([m.index!, m.index! + m[0].length]);
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g)) if (realDay(+m[1], +m[2] - 1, +m[3])) add(m);
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_SRC}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"))) {
    if (monthOk(m[1]) && realDay(+m[3], MONTHS3.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2])) add(m);
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_SRC}\\.?,?\\s+(\\d{4})\\b`, "gi"))) {
    if (monthOk(m[2]) && realDay(+m[3], MONTHS3.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1])) add(m);
  }
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_SRC}\\.?,?\\s+((?:19|20)\\d\\d)\\b(?!\\s*[A-Za-z])`, "gi"))) if (monthOk(m[1])) add(m);
  for (const m of t.matchAll(/(?:\bat\s+)?\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?!\d)(\s?[ap]\.?m\.?\b)?/gi)) if (m[3] || /^at\s/i.test(m[0])) add(m);
  for (const m of t.matchAll(/\b(?:from\s+)?((?:19|20)\d\d)\s*(?:-|–|to|through)\s*((?:19|20)\d\d)\b(?!\s*[A-Za-z])/gi)) if (+m[2] >= +m[1]) add(m);
  const YEAR_CTX = new RegExp(`(?:\\b(?:in|since|until|till|through|thru|during|fy|q[1-4]|h[12])\\s*|\\b(?:mid|early|late)-|\\b${MONTH_SRC}\\.?,?\\s+)((?:19|20)\\d\\d)\\b`, "gi");
  for (const m of t.matchAll(YEAR_CTX)) {
    const after = t.slice(m.index! + m[0].length);
    if (/^\s*(?:$|[.,;:!?)\]]|(?:and|or|but|when|while|as|so|we|i|they|he|she|it|you|the|a|an|our|my|this|that|to)\b)/i.test(after)) {
      if (m[2] && !monthOk(m[2])) continue;
      out.push([m.index! + m[0].length - 4, m.index! + m[0].length]);
    }
  }
  return out;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
// A backstop word list (D-088: word-list gaps are stated limits, not blockers); fail closed where it reads.
const UNITS: Record<string, number> = { dozen: 12, dozens: 12, half: 0.5, halved: 0.5, halves: 0.5, twice: 2, thrice: 3, third: 1 / 3, thirds: 1 / 3,
  quarter: 0.25, quarters: 0.25, fourth: 0.25, fourths: 0.25, fifth: 0.2, fifths: 0.2, sixth: 1 / 6, seventh: 1 / 7, eighth: 0.125, ninth: 1 / 9,
  tenth: 0.1, tenths: 0.1, hundredth: 0.01, thousandth: 0.001, double: 2, doubled: 2, triple: 3, tripled: 3, quadruple: 4, quadrupled: 4,
  quintupled: 5, couple: 2, pair: 2, score: 20, gross: 144, nought: 0, naught: 0, nil: 0, hundreds: 100, thousands: 1e3, millions: 1e6,
  billions: 1e9, trillions: 1e12 };
ONES.forEach((w, i) => (UNITS[w] = i));
TENS.forEach((w, i) => { if (w) UNITS[w] = i * 10; });
const SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const WORD = `(?:${[...Object.keys(UNITS), ...Object.keys(SCALES)].join("|")})`;
const WORDS_RE = new RegExp(`\\b${WORD}(?:(?:\\s+and\\s+|[\\s-]+)${WORD})*\\b(\\s*(?:%|per\\s?cent\\b|percent\\b))?`, "gi");
const CURRENCY_WORD = /^\s*(?:usd|eur|gbp|inr|dollars?|euros?|pounds?|rupees?)\b/i;

function wordsValue(src: string): number {
  let total = 0, cur = 0;
  for (const w of src.toLowerCase().split(/(?:\s+and\s+|[\s-]+)/).filter(Boolean)) {
    if (w in UNITS) cur += UNITS[w];
    else if (w === "hundred") cur = (cur || 1) * 100;
    else { total += (cur || 1) * SCALES[w]; cur = 0; }
  }
  return total + cur;
}

// Each Unicode decimal digit as its ASCII digit (a decimal block is ten consecutive code points starting at zero).
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    let z = cp;
    while (cp - z < 9 && /\p{Nd}/u.test(String.fromCodePoint(z - 1))) z--;
    return String(cp - z);
  });
}

const NUM = /([$€£¥₹]\s?)?(?<![\d.,])([-−]?)(\d{1,3}(?:,\d{3})+|\d+|(?=\.\d))(\.\d+)?(?:(%)|([A-Za-z]+))?(?![\d]|[.,]\d)/g;
export function loose(prose: string, values: Values): string[] {
  const text = asciiDigits(String(prose ?? "").normalize("NFKC"));
  const vals = Object.values(values);
  const masked = new Set<number>();
  for (const [a, b] of dateSpans(text)) for (let i = a; i < b; i++) masked.add(i);
  const found: { at: number; raw: string; typed: number; step: number; pct: boolean }[] = [];
  for (const m of text.matchAll(NUM)) {
    if (!m[3] && !m[4]) continue;
    const at = m.index! + (m[1]?.length ?? 0) + m[2].length;
    // Skipped only when the whole figure lies inside a date span (round 6: "at 9:30000" and "2026-11-14,000" hid digits).
    const end = m.index! + m[0].length;
    let inside = true;
    for (let i = at; i < end; i++) if (!masked.has(i)) { inside = false; break; }
    if (inside) continue;
    const cur = !!m[1];
    const intPart = (m[3] || "0").replace(/,/g, "");
    const suffix = (m[6] ?? "").toLowerCase();
    const after = text.slice(m.index! + m[0].length);
    const word = /^\s+(thousand|million|billion|per\s?cent|percent)\b/i.exec(after)?.[1]?.toLowerCase() ?? "";
    const moneyCtx = cur || CURRENCY_WORD.test(after);
    const scale = suffix === "k" || word === "thousand" ? 1e3
      : ((suffix === "m" || suffix === "mn" || suffix === "mm") && moneyCtx) || word === "million" ? 1e6
      : ((suffix === "bn" || suffix === "b") && moneyCtx) || word === "billion" ? 1e9 : 1;
    const pct = m[5] === "%" || /cent/.test(word);
    const sign = m[2] ? -1 : 1;
    const dec = m[4] ? m[4].length - 1 : 0;
    found.push({ at: m.index!, raw: (m[0] + (word ? ` ${word}` : "")).trim(), typed: sign * Number(intPart + (m[4] ?? "")) * scale, step: Math.pow(10, -dec) * scale, pct });
  }
  // A digit group written any other way (12,5 / 3,5% / 1,23,456 / 1.234,56 / 1'234 / 1.2.3) is not US-grouped, so it
  // can never be matched to a cell with confidence: it is listed as typed (third review of WO-124a).
  for (const m of text.matchAll(/[$€£¥₹]?\d[\d.,'’]*\d(?:%|[A-Za-z]+)?/g)) {
    let all = true; // skipped only when the whole token lies inside a date span (round 7)
    for (let i = m.index!; i < m.index! + m[0].length; i++) if (!masked.has(i)) { all = false; break; }
    if (all) continue;
    const core = m[0].replace(/^[$€£¥₹]/, "").replace(/(?:%|[A-Za-z]+)$/, "");
    if (/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(core)) continue; // US-grouped or plain: read above
    if (!found.some((f) => f.at === m.index && f.raw === m[0])) found.push({ at: m.index!, raw: m[0], typed: NaN, step: 0, pct: false });
  }
  const spans = found.map((f) => [f.at, f.at + f.raw.length] as Span);
  for (const m of text.matchAll(WORDS_RE)) {
    if (spans.some(([a, b]) => m.index! >= a && m.index! < b)) continue; // "5 million": already read with its digits
    const body = m[0].replace(/\s*(?:%|per\s?cent|percent)$/i, "");
    const pct = !!m[1];
    if (/^one$/i.test(body.trim()) && !pct) continue;
    found.push({ at: m.index!, raw: m[0].trim(), typed: wordsValue(body), step: /half/i.test(body) ? 1e-9 : 1, pct });
  }
  for (const m of text.matchAll(/\b[a-z]+fold\b/gi)) {
    if (!found.some((f) => f.at === m.index)) found.push({ at: m.index!, raw: m[0], typed: NaN, step: 0, pct: false });
  }
  found.sort((x, y) => x.at - y.at);
  const near = (v: number, t: number, step: number) => Math.abs(v - t) <= step / 2 + 1e-9 * Math.max(1, Math.abs(v));
  const out: string[] = [];
  for (const f of found) {
    const ok = vals.some((v) => near(v, f.typed, f.step) || (f.pct && near(v * 100, f.typed, f.step)));
    if (!ok) out.push(f.raw);
  }
  return out;
}
