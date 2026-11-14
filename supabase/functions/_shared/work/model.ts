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
const NUM = /(?<![\w.,])([$€£]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%|k\b|m\b)?(?![\w]|[.,]\d)/gi;
export function loose(prose: string, values: Values): string[] {
  const vals = Object.values(values);
  const out: string[] = [];
  for (const m of prose.matchAll(NUM)) {
    const typed = Number(m[2].replace(/,/g, "") + (m[3] ?? ""));
    const dec = m[3] ? m[3].length - 1 : 0;
    const scale = /k/i.test(m[4] ?? "") ? 1e3 : /m/i.test(m[4] ?? "") ? 1e6 : 1;
    const step = Math.pow(10, -dec) * scale;
    const near = (v: number, t: number) => Math.abs(v - t) <= step / 2 + 1e-9 * Math.max(1, Math.abs(v));
    const ok = vals.some((v) => near(v, typed * scale) || (m[4] === "%" && near(v * 100, typed)));
    if (!ok) out.push(m[0]);
  }
  return out;
}
