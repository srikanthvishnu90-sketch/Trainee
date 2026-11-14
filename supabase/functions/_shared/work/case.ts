// WO-124a: a work case, its rounds and its constraint ledger (spec docs/architect/specs/WORK-ARTIFACTS.md, D4 and D6).
// Pure: no database, no network; the clock is an input. A practice case is a sealed namespace: the profile guard throws.

export type ConstraintKind = "hard" | "preference" | "permission" | "output";
export type ConstraintStatus = "active" | "superseded" | "revoked";
const KINDS: ConstraintKind[] = ["hard", "preference", "permission", "output"];

export interface ConstraintInput {
  id: string;
  kind: ConstraintKind;
  text: string;
  values?: string[]; // literal values this row is about (a figure, a name); a revoke makes them searchable (revoke_scan.ts)
  supersedes?: string;
  revokes?: string;
}
export interface LedgerRow extends ConstraintInput { round: number; status: ConstraintStatus; endedBy?: string; endedRound?: number }
export interface Round { round: number; text: string; constraints: string[] }
export interface GuardEvent { at: number; op: "read" | "write"; refused: boolean }
export interface WorkVersion {
  version: number; round: number; kind: string; model: unknown; files: Record<string, Uint8Array>;
  values: Record<string, number>; diff: unknown[]; invariants: unknown[];
}
export interface WorkCase {
  id: string; owner: string; practice: boolean; title: string; createdAt: number;
  rounds: Round[]; rows: LedgerRow[]; versions: WorkVersion[]; guardLog: GuardEvent[];
}

export class PracticeIsolation extends Error {
  constructor(op: "read" | "write") {
    super(`practice case: the profile cannot be ${op === "read" ? "read" : "written"} here`);
    this.name = "PracticeIsolation";
  }
}
export class LedgerError extends Error {
  constructor(msg: string) { super(msg); this.name = "LedgerError"; }
}

export function newCase(o: { owner: string; practice: boolean; title: string; now: number }): WorkCase {
  if (!o.owner) throw new LedgerError("a case needs an owner");
  const slug = String(o.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "case";
  return {
    id: `${o.practice ? "practice" : "own"}:${o.now.toString(36)}:${slug}`,
    owner: o.owner, practice: o.practice === true, title: String(o.title ?? ""), createdAt: o.now,
    rounds: [], rows: [], versions: [], guardLog: [],
  };
}

export function currentRound(c: WorkCase): number {
  return c.rounds.length ? c.rounds[c.rounds.length - 1].round : 0;
}

// A round is appended, never rewritten. A supersede or revoke ends the earlier row's life; the row stays in the ledger.
export function addRound(c: WorkCase, r: { round: number; text: string; constraints: ConstraintInput[] }): Round {
  if (!Number.isInteger(r.round) || r.round <= currentRound(c)) throw new LedgerError(`round ${r.round} must come after round ${currentRound(c)}`);
  const seen = new Set(c.rows.map((x) => x.id));
  for (const k of r.constraints) {
    if (!k.id || seen.has(k.id)) throw new LedgerError(`constraint id "${k.id}" is missing or repeated`);
    if (!KINDS.includes(k.kind)) throw new LedgerError(`constraint "${k.id}" has unknown kind "${k.kind}"`);
    seen.add(k.id);
  }
  const byId = new Map(c.rows.map((x) => [x.id, x]));
  const check = (target: string | undefined, by: string) => {
    if (!target) return;
    const row = byId.get(target);
    if (!row) throw new LedgerError(`constraint "${by}" ends "${target}", which is not in the ledger`);
    if (row.status !== "active") throw new LedgerError(`constraint "${target}" is already ${row.status}`);
  };
  for (const k of r.constraints) { check(k.supersedes, k.id); check(k.revokes, k.id); }
  for (const k of r.constraints) {
    for (const [target, status] of [[k.supersedes, "superseded"], [k.revokes, "revoked"]] as const) {
      const row = target ? byId.get(target) : undefined;
      if (row) { row.status = status; row.endedBy = k.id; row.endedRound = r.round; }
    }
    c.rows.push({ ...k, ...(k.values ? { values: [...k.values] } : {}), round: r.round, status: "active" });
  }
  const round = { round: r.round, text: r.text, constraints: r.constraints.map((k) => k.id) };
  c.rounds.push(round);
  return round;
}

export function ledger(c: WorkCase): LedgerRow[] { return c.rows.map((r) => ({ ...r })); }
export function active(c: WorkCase): LedgerRow[] { return ledger(c).filter((r) => r.status === "active"); }

// Values the person took back: those on revoked rows, and any named on the revoking row itself.
export function revoked(c: WorkCase): string[] {
  const out: string[] = [];
  for (const r of c.rows) {
    const vals = r.status === "revoked" || r.revokes ? r.values ?? [] : [];
    for (const v of vals) if (!out.includes(v)) out.push(v);
  }
  return out;
}

// D6: the only way a case reaches the profile. io is the caller's own profile accessor (none in this module).
export function profileGuard<T = unknown>(c: WorkCase, io?: { read: () => T; write: (fact: unknown) => void }, now = c.createdAt) {
  const gate = (op: "read" | "write") => {
    c.guardLog.push({ at: now, op, refused: c.practice });
    if (c.practice) throw new PracticeIsolation(op);
  };
  return {
    read(): T | undefined { gate("read"); return io?.read(); },
    write(fact: unknown): void { gate("write"); io?.write(fact); },
  };
}
