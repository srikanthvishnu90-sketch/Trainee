// Work artifacts, funnel checks (spec WORK-ARTIFACTS.md, rules D5 and D9). Pure functions over the model's numbers.
export type FunnelRow = { cohort: string; acquired: number; activated: number; retained: number | null };
export type FunnelFinding = { cohort: string; stage: string; detail: string };

/** Flags every row where a later stage exceeds an earlier one, or a count is negative. Unknown (null) is skipped, not zero.
 * Round 8: a stage that is not a finite number and not null (NaN, an error value, a string) is a finding, never skipped
 * or compared, so it cannot hide a broken funnel. */
export function monotone(rows: FunnelRow[]): FunnelFinding[] {
  const out: FunnelFinding[] = [];
  for (const r of rows) {
    const raw: [string, unknown][] = [["acquired", r.acquired], ["activated", r.activated], ["retained", r.retained]];
    for (const [s, v] of raw) if (v !== null && !(typeof v === "number" && Number.isFinite(v))) out.push({ cohort: r.cohort, stage: s, detail: `${s} is not a number` });
    const stages: [string, number | null][] = raw.map(([s, v]) => [s, typeof v === "number" && Number.isFinite(v) ? v : null]);
    for (const [s, v] of stages) if (v !== null && v < 0) out.push({ cohort: r.cohort, stage: s, detail: `${s} is negative` });
    let prev: [string, number] | null = null;
    for (const [s, v] of stages) {
      if (v === null) continue;
      if (prev && v > prev[1]) out.push({ cohort: r.cohort, stage: s, detail: `${s} (${v}) exceeds ${prev[0]} (${prev[1]})` });
      prev = [s, v];
    }
  }
  return out;
}

/** Keys whose value changed beyond tol, or that exist on one side only. Per row, so offsetting edits cannot hide in a sum. */
export function perRowChanged(before: Record<string, number>, after: Record<string, number>, tol: number): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  if (!(tol >= 0) || !Number.isFinite(tol)) throw new RangeError("tolerance must be a finite number of zero or more");
  const own = (o: Record<string, number>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  // A value that is not a finite number on either side counts as changed (round 8: 5 -> NaN read as unchanged).
  return [...keys].filter((k) => !own(before, k) || !own(after, k) || !num(before[k]) || !num(after[k]) || Math.abs(before[k] - after[k]) > tol);
}

/** Rows that belong in a dynamic mature range: every row the predicate marks mature, so a newly mature cohort is included. */
export function matureRows<T>(rows: T[], mature: (r: T) => boolean): T[] {
  return rows.filter(mature);
}
