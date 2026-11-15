// Work artifacts, capacity solver (spec WORK-ARTIFACTS.md, rule D9; pack case 0015). Earliest-deadline-first over day
// capacities. Required work is feasible exactly when, for every deadline, the required hours due by then fit the hours
// available by then; the first deadline that fails is the proof of infeasibility.
export type Day = { d: number; hours: number };
export type Task = { id: string; hours: number; due: number; required?: boolean };
export type Plan = { d: number; id: string; hours: number };
export type Proof = { due: number; required: number; capacity: number };
/** Feasible: a plan, optional tasks that did not fit, and spare hours. Infeasible: the proof, and no plan. */
export type Solve = { feasible: boolean; proof?: Proof; plan: Plan[]; dropped: string[]; slack: number };

const capBy = (days: Day[], due: number) => days.filter((x) => x.d <= due).reduce((s, x) => s + x.hours, 0);

export class CapacityInputError extends RangeError {
  constructor(msg: string) { super(msg); this.name = "CapacityInputError"; }
}

// Inputs are checked before solving (review of WO-124c): negative hours made infeasible work look feasible, and a NaN
// made every comparison false. A day is a finite number listed once with finite hours >= 0; a task has a unique
// non-empty id, finite hours > 0 and a finite due day.
function validate(days: Day[], tasks: Task[]) {
  if (!Array.isArray(days) || !Array.isArray(tasks)) throw new CapacityInputError("days and tasks must be lists");
  const seenDays = new Set<number>();
  for (const x of days) {
    if (!Number.isFinite(x?.d)) throw new CapacityInputError("each day needs a finite day number");
    if (seenDays.has(x.d)) throw new CapacityInputError(`day ${x.d} is listed twice`);
    seenDays.add(x.d);
    if (!Number.isFinite(x.hours) || x.hours < 0) throw new CapacityInputError(`day ${x.d} needs hours of zero or more`);
  }
  const seenIds = new Set<string>();
  for (const t of tasks) {
    if (!t?.id || seenIds.has(t.id)) throw new CapacityInputError(`task id "${t?.id ?? ""}" is missing or repeated`);
    seenIds.add(t.id);
    if (!Number.isFinite(t.hours) || t.hours <= 0) throw new CapacityInputError(`task ${t.id} needs more than zero hours`);
    if (!Number.isFinite(t.due)) throw new CapacityInputError(`task ${t.id} needs a finite due day`);
  }
}

export function solve({ days, tasks }: { days: Day[]; tasks: Task[] }): Solve {
  validate(days, tasks);
  const req = tasks.filter((t) => t.required !== false);
  for (const due of [...new Set(req.map((t) => t.due))].sort((a, b) => a - b)) {
    const required = req.filter((t) => t.due <= due).reduce((s, t) => s + t.hours, 0);
    const capacity = capBy(days, due);
    if (required > capacity + 1e-9) return { feasible: false, proof: { due, required, capacity }, plan: [], dropped: [], slack: 0 };
  }
  const left = [...days].sort((a, b) => a.d - b.d).map((x) => ({ ...x }));
  const plan: Plan[] = [], dropped: string[] = [];
  const place = (t: Task, commit: boolean) => {
    let need = t.hours;
    const take: Plan[] = [];
    for (const day of left) {
      if (day.d > t.due || need <= 1e-9) break;
      const h = Math.min(day.hours, need);
      if (h > 0) take.push({ d: day.d, id: t.id, hours: h }), (need -= h);
    }
    if (need > 1e-9 && !commit) return false;
    for (const p of take) left.find((x) => x.d === p.d)!.hours -= p.hours;
    plan.push(...take);
    return true;
  };
  const byDue = (a: Task, b: Task) => a.due - b.due;
  for (const t of [...req].sort(byDue)) place(t, true);
  for (const t of tasks.filter((t) => t.required === false).sort(byDue)) if (!place(t, false)) dropped.push(t.id);
  return { feasible: true, plan, dropped, slack: left.reduce((s, x) => s + x.hours, 0) };
}
