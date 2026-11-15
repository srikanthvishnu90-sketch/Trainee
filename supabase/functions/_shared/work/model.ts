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
    if (!(id in values)) throw new UnknownRef(id);
    return formatValue(values[id], formats[id]);
  });
}

// D1: the numbers typed in prose that no cell accounts for. A figure matches a cell when it equals the value at the
// precision it was typed (19,280 and 19.3k match 19280; 19,200 does not), or, with "%", the value or the value times 100.
// Read fail closed (review of WO-124a):
//  - the text is NFKC-normalised first, so fullwidth digits and signs read as ASCII;
//  - a unit glued to the digits is read (17280USD, 1.5x, 40ms); k, m, mn and bn scale only where they mean thousand,
//    million or billion (k always; m, mn, bn after a currency sign or before a currency word); any other unit is kept
//    as a label and does not scale;
//  - number words are figures too ("forty percent", "twenty-five", "two hundred"). A lone "one" is read as the article
//    sense and is not listed (it is listed when it carries a unit or percent, or joins a larger number);
//  - calendar dates and times are not figures: an ISO date (2026-11-14), a month-name date (Nov 14, 2026 or 14 November
//    2026), a clock time (10:30), and a year from 1900 to 2099 written bare after a year word (in, by, since, until,
//    from, through, during, of, FY, Q1-Q4, a month name) or before a month.
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_SPANS = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\.?(?:,?\\s+\\d{4})?\\b`, "gi"),
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?\b/gi,
];
const YEAR_BEFORE = new RegExp(`(?:\\b(?:in|by|since|until|till|from|through|thru|during|of|fy|q[1-4]|h[12])|${MONTH}\\.?|[-–])\\s*$`, "i");
const YEAR_AFTER = new RegExp(`^\\s*(?:[-–]\\s*\\d{2,4}\\b|${MONTH}\\b)`, "i");

const UNITS: Record<string, number> = {};
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
ONES.forEach((w, i) => (UNITS[w] = i));
TENS.forEach((w, i) => { if (w) UNITS[w] = i * 10; });
const SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const WORD = `(?:${[...Object.keys(UNITS), ...Object.keys(SCALES)].join("|")})`;
const WORDS_RE = new RegExp(`\\b${WORD}(?:(?:\\s+and\\s+|[\\s-]+)${WORD})*\\b(\\s*(?:%|per\\s?cent\\b|percent\\b))?`, "gi");
const CURRENCY_WORD = /^\s*(?:usd|eur|gbp|dollars?|euros?|pounds?)\b/i;

function wordsValue(src: string): number {
  let total = 0, cur = 0;
  for (const w of src.toLowerCase().split(/(?:\s+and\s+|[\s-]+)/).filter(Boolean)) {
    if (w in UNITS) cur += UNITS[w];
    else if (w === "hundred") cur = (cur || 1) * 100;
    else { total += (cur || 1) * SCALES[w]; cur = 0; }
  }
  return total + cur;
}

const NUM = /([$€£¥]\s?)?(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:(%)|([A-Za-z]+))?(?![\d]|[.,]\d)/g;
export function loose(prose: string, values: Values): string[] {
  const text = String(prose ?? "").normalize("NFKC");
  const vals = Object.values(values);
  const masked = new Set<number>();
  for (const re of DATE_SPANS) for (const m of text.matchAll(re)) for (let i = m.index!; i < m.index! + m[0].length; i++) masked.add(i);
  const found: { at: number; raw: string; typed: number; step: number; pct: boolean }[] = [];
  for (const m of text.matchAll(NUM)) {
    const at = m.index! + (m[1]?.length ?? 0);
    if (masked.has(at)) continue;
    const cur = !!m[1];
    const intPart = m[2].replace(/,/g, "");
    const suffix = (m[5] ?? "").toLowerCase();
    const after = text.slice(m.index! + m[0].length);
    const isYear = !cur && !m[3] && !m[4] && !suffix && !m[2].includes(",") && /^(19|20)\d\d$/.test(intPart) &&
      (YEAR_BEFORE.test(text.slice(0, m.index!)) || YEAR_AFTER.test(after));
    if (isYear) continue;
    const moneyCtx = cur || CURRENCY_WORD.test(after);
    const scale = suffix === "k" ? 1e3
      : (suffix === "m" || suffix === "mn" || suffix === "mm") && moneyCtx ? 1e6
      : (suffix === "bn" || suffix === "b") && moneyCtx ? 1e9 : 1;
    const dec = m[3] ? m[3].length - 1 : 0;
    found.push({ at: m.index!, raw: m[0].trim(), typed: Number(intPart + (m[3] ?? "")) * scale, step: Math.pow(10, -dec) * scale, pct: m[4] === "%" });
  }
  for (const m of text.matchAll(WORDS_RE)) {
    const body = m[0].replace(/\s*(?:%|per\s?cent|percent)$/i, "");
    const pct = !!m[1];
    if (/^one$/i.test(body.trim()) && !pct) continue;
    found.push({ at: m.index!, raw: m[0].trim(), typed: wordsValue(body), step: 1, pct });
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
