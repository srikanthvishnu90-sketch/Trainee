// Work artifacts, the independent formula evaluator (spec WORK-ARTIFACTS.md, rule D2). It reads the workbook bytes, parses
// every <f> text out of the sheet XML and evaluates it with its own interpreter. It never imports xlsx.ts's computation; it
// only receives `expected` (a sheet, a cell and the model's value) and reports every cell that disagrees.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";

type Err = { error: string };
type Val = number | string | boolean | null | Err;
type Range = { range: Val[][] };
type Any = Val | Range;
type Raw = { f?: string; v: Val };
export type ExpectedCell = { sheet: string; ref: string; value: number | string | boolean | null };
export type Recompute = { mismatches: string[]; cells: number; values: Record<string, Val> };

const TOL = 1e-9;
const isErr = (v: unknown): v is Err => typeof v === "object" && v !== null && "error" in v;
const isRange = (v: unknown): v is Range => typeof v === "object" && v !== null && "range" in v;
const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function colNum(c: string): number {
  return [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}
function colStr(n: number): string {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function readBook(bytes: Uint8Array) {
  const parts = unzipSync(bytes);
  const text = (p: string) => {
    if (!parts[p]) throw new Error(`workbook part missing: ${p}`);
    return strFromU8(parts[p]);
  };
  const wb = text("xl/workbook.xml");
  const relXml = text("xl/_rels/workbook.xml.rels");
  const targets: Record<string, string> = {};
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) targets[attr(m[0], "Id")!] = attr(m[0], "Target")!;
  const sheets: Record<string, Record<string, Raw>> = {};
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(attr(m[0], "name")!), target = targets[attr(m[0], "r:id")!].replace(/^\/?(xl\/)?/, "");
    const cells: Record<string, Raw> = {};
    for (const c of text("xl/" + target).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], "r")!, t = attr(c[1], "t"), body = c[2] ?? "";
      const f = /<f>([\s\S]*?)<\/f>/.exec(body)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const inl = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      let val: Val = null;
      if (t === "inlineStr") val = unxml(inl ?? "");
      else if (v === undefined) val = null;
      else if (t === "b") val = v === "1";
      else if (t === "str" || t === "s") val = unxml(v);
      else if (t === "e") val = { error: v };
      else val = Number(v);
      cells[ref] = { f: f === undefined ? undefined : unxml(f), v: val };
    }
    sheets[name] = cells;
  }
  const names: Record<string, string> = {};
  for (const m of wb.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) names[unxml(attr(m[1], "name")!).toUpperCase()] = unxml(m[2]);
  return { sheets, names };
}

type Tok = { t: "num" | "str" | "ref" | "name" | "fn" | "op" | "bool"; s: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re =
    /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|"((?:[^"]|"")*)"|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?|\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)(?![\w(])|(TRUE|FALSE)(?![\w(])|([A-Za-z_][\w.]*)(?=\s*\()|([A-Za-z_][\w.]*)|(<>|<=|>=|[-+*/^&=<>(),]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot parse formula at ${i}: ${src}`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", s: m[1] });
    else if (m[2] !== undefined) out.push({ t: "str", s: m[2].replace(/""/g, '"') });
    else if (m[3] !== undefined) out.push({ t: "ref", s: m[3] });
    else if (m[4] !== undefined) out.push({ t: "bool", s: m[4] });
    else if (m[5] !== undefined) out.push({ t: "fn", s: m[5].toUpperCase() });
    else if (m[6] !== undefined) out.push({ t: "name", s: m[6] });
    else out.push({ t: "op", s: m[7] });
  }
  return out;
}

type Node =
  | { k: "lit"; v: Val }
  | { k: "ref"; s: string }
  | { k: "name"; s: string }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...ops: string[]) => peek()?.t === "op" && ops.includes(peek().s);
  const expect = (s: string) => {
    if (!isOp(s)) throw new Error(`expected ${s} in ${src}`);
    p++;
  };
  const level = (ops: string[], next: () => Node) => () => {
    let a = next();
    while (isOp(...ops)) a = { k: "bin", op: toks[p++].s, a, b: next() };
    return a;
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new Error(`unexpected end of ${src}`);
    if (t.t === "num") return { k: "lit", v: Number(t.s) };
    if (t.t === "str") return { k: "lit", v: t.s };
    if (t.t === "bool") return { k: "lit", v: t.s === "TRUE" };
    if (t.t === "ref") return { k: "ref", s: t.s };
    if (t.t === "name") return { k: "name", s: t.s };
    if (t.t === "fn") {
      expect("(");
      const args: Node[] = [];
      if (!isOp(")")) do args.push(cmp()); while (isOp(",") && ++p);
      expect(")");
      return { k: "call", fn: t.s, args };
    }
    if (t.s === "(") {
      const e = cmp();
      expect(")");
      return e;
    }
    if (t.s === "-" || t.s === "+") return { k: "un", op: t.s, a: primary() };
    throw new Error(`unexpected ${t.s} in ${src}`);
  };
  const mul = level(["*", "/"], primary);
  const add = level(["+", "-"], mul);
  const cat = level(["&"], add);
  const cmp = level(["=", "<>", "<", ">", "<=", ">="], cat);
  const e = cmp();
  if (p !== toks.length) throw new Error(`trailing tokens in ${src}`);
  return e;
}

function num(v: Val): number | Err {
  if (isErr(v)) return v;
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : { error: "#VALUE!" };
}
function truthy(v: Val): boolean | Err {
  if (typeof v === "string") return { error: "#VALUE!" };
  const n = num(v);
  return isErr(n) ? n : n !== 0;
}
function compare(op: string, a: Val, b: Val): boolean {
  const rank = (v: Val) => (typeof v === "number" || v === null ? 0 : typeof v === "string" ? 1 : 2);
  let c: number;
  const na = a === null ? (typeof b === "string" ? "" : 0) : a, nb = b === null ? (typeof a === "string" ? "" : 0) : b;
  if (rank(na as Val) !== rank(nb as Val)) c = rank(na as Val) - rank(nb as Val);
  else if (typeof na === "string") c = na.toLowerCase().localeCompare(String(nb).toLowerCase());
  else c = Number(na) - Number(nb);
  return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[op]!;
}
function criterion(crit: Val): (v: Val) => boolean {
  const m = typeof crit === "string" ? /^(<>|<=|>=|=|<|>)?(.*)$/.exec(crit)! : null;
  const op = m?.[1] ?? "=", raw: Val = m ? m[2] : crit;
  const asNum = typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  return (v) => {
    if (isErr(v)) return false;
    if (typeof asNum === "number" && typeof v !== "number") return op === "<>";
    if (op === "=" && asNum === "") return v === null || v === "";
    return compare(op, v, asNum);
  };
}

export function evaluator(bytes: Uint8Array) {
  const { sheets, names } = readBook(bytes);
  const memo = new Map<string, Val>(), busy = new Set<string>();
  const cell = (sheet: string, ref: string): Val => {
    const key = `${sheet}!${ref}`;
    if (memo.has(key)) return memo.get(key)!;
    const raw = sheets[sheet]?.[ref];
    if (!raw) return null;
    if (raw.f === undefined) return raw.v;
    if (busy.has(key)) return { error: "#CIRCULAR!" };
    busy.add(key);
    const r = scalar(ev(parse(raw.f), sheet));
    busy.delete(key);
    memo.set(key, r);
    return r;
  };
  const ref = (s: string, here: string): Any => {
    const m = /^(?:'?((?:[^']|'')+?)'?!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(s);
    if (!m) return { error: "#REF!" };
    const sh = m[1] ? m[1].replace(/''/g, "'") : here;
    if (!sheets[sh]) return { error: "#REF!" };
    if (!m[4]) return cell(sh, m[2] + m[3]);
    const rows: Val[][] = [];
    for (let r = Number(m[3]); r <= Number(m[5]); r++) {
      const row: Val[] = [];
      for (let c = colNum(m[2]); c <= colNum(m[4]); c++) row.push(cell(sh, colStr(c) + r));
      rows.push(row);
    }
    return { range: rows };
  };
  const scalar = (v: Any): Val => (isRange(v) ? (v.range.length === 1 && v.range[0].length === 1 ? v.range[0][0] : { error: "#VALUE!" }) : v);
  const flat = (v: Any): Val[] => (isRange(v) ? v.range.flat() : [v]);
  const ev = (n: Node, here: string): Any => {
    switch (n.k) {
      case "lit": return n.v;
      case "ref": return ref(n.s, here);
      case "name": {
        const target = names[n.s.toUpperCase()];
        return target === undefined ? { error: "#NAME?" } : ref(target, here);
      }
      case "un": {
        const a = num(scalar(ev(n.a, here)));
        return isErr(a) ? a : n.op === "-" ? -a : a;
      }
      case "bin": {
        const a = scalar(ev(n.a, here)), b = scalar(ev(n.b, here));
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (n.op === "&") return `${a ?? ""}${b ?? ""}`;
        if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) return compare(n.op, a, b);
        const x = num(a), y = num(b);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        if (n.op === "/") return y === 0 ? { error: "#DIV/0!" } : x / y;
        return n.op === "+" ? x + y : n.op === "-" ? x - y : x * y;
      }
      case "call": return call(n.fn, n.args, here);
    }
  };
  const call = (fn: string, args: Node[], here: string): Val => {
    const arg = (i: number) => scalar(ev(args[i], here));
    switch (fn) {
      case "IF": {
        const c = truthy(arg(0));
        if (isErr(c)) return c;
        return c ? arg(1) : args.length > 2 ? arg(2) : false;
      }
      case "IFERROR": {
        const v = arg(0);
        return isErr(v) ? arg(1) : v;
      }
      case "ISNUMBER": return typeof arg(0) === "number";
      case "ABS": {
        const v = num(arg(0));
        return isErr(v) ? v : Math.abs(v);
      }
      case "AND":
      case "OR": {
        const vs = args.flatMap((a) => flat(ev(a, here))).filter((v) => v !== null && typeof v !== "string");
        for (const v of vs) if (isErr(v)) return v;
        if (!vs.length) return { error: "#VALUE!" };
        const bs = vs.map((v) => num(v) !== 0);
        return fn === "AND" ? bs.every(Boolean) : bs.some(Boolean);
      }
      case "SUM": {
        let s = 0;
        for (const a of args) {
          const r = ev(a, here);
          for (const v of flat(r)) {
            if (isErr(v)) return v;
            if (typeof v === "number") s += v;
            else if (!isRange(r) && v !== null) { const x = num(v); if (isErr(x)) return x; s += x; }
          }
        }
        return s;
      }
      case "SUMIFS": {
        const sum = flat(ev(args[0], here));
        const tests: [Val[], (v: Val) => boolean][] = [];
        for (let i = 1; i + 1 < args.length; i += 2) {
          const r = flat(ev(args[i], here));
          if (r.length !== sum.length) return { error: "#VALUE!" };
          tests.push([r, criterion(arg(i + 1))]);
        }
        let s = 0;
        sum.forEach((v, k) => {
          if (typeof v === "number" && tests.every(([r, t]) => t(r[k]))) s += v;
        });
        return s;
      }
      default:
        return { error: "#NAME?" };
    }
  };
  return { cell, formulas: () => Object.entries(sheets).flatMap(([s, cs]) => Object.entries(cs).filter(([, c]) => c.f !== undefined).map(([r]) => ({ sheet: s, ref: r, cached: cs[r].v }))) };
}

const same = (a: Val, b: Val) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= TOL : JSON.stringify(a) === JSON.stringify(b);

/** Recomputes every formula in the bytes, compares recomputed and cached values with `expected`, and checks that no
 * formula in the workbook evaluates to an error. `values` holds the recomputed value for each expected key. */
export function recomputeAll(bytes: Uint8Array, expected: Record<string, ExpectedCell>): Recompute {
  const ev = evaluator(bytes);
  const mismatches: string[] = [];
  const values: Record<string, Val> = {};
  let cells = 0;
  for (const [key, e] of Object.entries(expected)) {
    const got = ev.cell(e.sheet, e.ref);
    values[key] = got;
    cells++;
    if (!same(got, e.value)) mismatches.push(`${key} (${e.sheet}!${e.ref}): recomputed ${JSON.stringify(got)}, model ${JSON.stringify(e.value)}`);
  }
  for (const f of ev.formulas()) {
    const got = ev.cell(f.sheet, f.ref);
    if (isErr(got)) mismatches.push(`${f.sheet}!${f.ref}: formula error ${got.error}`);
    else if (!same(got, f.cached)) mismatches.push(`${f.sheet}!${f.ref}: cached ${JSON.stringify(f.cached)}, recomputed ${JSON.stringify(got)}`);
  }
  return { mismatches, cells, values };
}
