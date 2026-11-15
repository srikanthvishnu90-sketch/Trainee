// WO-124a: versions, diffs and invariants (spec D5). Each version's diff is made by code, per cell and per text block,
// carrying the round and the constraints that round stated. Invariants run per row at full precision with a stated
// tolerance, so offsetting edits (one cell up, another down, total unchanged) are caught.
import { currentRound, type WorkCase, type WorkVersion } from "./case.ts";
import { evaluate, type Model, type Values } from "./model.ts";

export interface DiffRow { path: string; before: unknown; after: unknown; round: number; constraint: string[] }
export interface Invariant { name: string; fn: (prev: Values, next: Values, tol: number) => boolean; tol: number }
export interface InvariantResult { name: string; tol: number; ran: boolean; ok: boolean; why?: string }

// fn receives the stated tolerance as its third argument, so the tolerance the report prints is the one applied.
export function invariant(name: string, fn: (prev: Values, next: Values, tol: number) => boolean, tol: number): Invariant {
  if (!(tol >= 0) || !Number.isFinite(tol)) throw new RangeError(`invariant "${name}" needs a finite tolerance of zero or more`);
  return { name, fn, tol };
}

// The common invariant: each named cell is unchanged, one by one, within tol. A cell missing from either version fails.
export function unchanged(name: string, ids: string[], tol: number): Invariant {
  if (!ids.length) throw new RangeError(`invariant "${name}" names no cells`);
  return invariant(name, (prev, next, t) => ids.every((k) =>
    typeof prev[k] === "number" && typeof next[k] === "number" && Math.abs(prev[k] - next[k]) <= t), tol);
}

const cellDef = (m: Model, id: string) => {
  const c = m.cells.find((x) => x.id === id);
  return c ? { value: c.value, formula: c.formula, unit: c.unit, format: c.format } : undefined;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// A cell changes when its definition or its evaluated value changes; a text block changes when its words change.
export function diff(a: Model | null, b: Model, round = 0, constraint: string[] = []): DiffRow[] {
  const out: DiffRow[] = [];
  const va = a ? evaluate(a) : {}, vb = evaluate(b);
  const ids: string[] = [];
  for (const c of [...(a?.cells ?? []), ...b.cells]) if (!ids.includes(c.id)) ids.push(c.id);
  for (const id of ids) {
    const da = a ? cellDef(a, id) : undefined, db = cellDef(b, id);
    if (same(da, db) && same(va[id], vb[id])) continue;
    out.push({ path: id, before: va[id] ?? null, after: vb[id] ?? null, round, constraint });
  }
  const ta = a?.text ?? [], tb = b.text ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] !== tb[i]) out.push({ path: `text[${i}]`, before: ta[i] ?? null, after: tb[i] ?? null, round, constraint });
  }
  return out;
}

export function saveVersion(
  c: WorkCase,
  v: { kind: string; model: Model; files: Record<string, Uint8Array>; invariants?: Invariant[] },
): WorkVersion & { diff: DiffRow[]; invariants: InvariantResult[] } {
  const prev = c.versions[c.versions.length - 1];
  const round = currentRound(c);
  const stated = c.rounds.find((r) => r.round === round)?.constraints ?? [];
  const values = evaluate(v.model);
  const d = diff(prev ? prev.model as Model : null, v.model, round, stated);
  const inv: InvariantResult[] = (v.invariants ?? []).map((k) => {
    if (!prev) return { name: k.name, tol: k.tol, ran: false, ok: false, why: "no earlier version to compare" };
    try { return { name: k.name, tol: k.tol, ran: true, ok: k.fn(prev.values, values, k.tol) === true }; }
    catch (e) { return { name: k.name, tol: k.tol, ran: true, ok: false, why: (e as Error).message }; }
  });
  const saved = {
    version: c.versions.length + 1, round, kind: v.kind, model: structuredClone(v.model), files: { ...v.files },
    values, diff: d, invariants: inv,
  };
  c.versions.push(saved);
  return saved;
}
