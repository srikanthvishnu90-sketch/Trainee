// Work artifacts, cash-flow feasibility (spec WORK-ARTIFACTS.md, rule D9; pack cases 0010 and 0011). Separates the timing
// question (does the balance ever go below zero?) from final economics (where does it end, with refundable lock-ups
// counted as returned), and caps refunds at what was paid.
export type CashEvent = { day: number; amount: number; kind: string; refundableDay?: number };
export type CashResult = {
  minBalance: number; minDay: number | null; final: number; feasible: boolean; shortfall: number;
  outstandingLockup: number; findings: string[]; balances: { day: number; balance: number }[];
};

export const KINDS: ReadonlySet<string> = new Set(["deposit_lockup", "deposit_refund", "income", "stipend", "salary", "bonus", "expense", "rent", "fee", "tax", "transfer_in", "transfer_out"]);
const INFLOW = new Set(["deposit_refund", "income", "stipend", "salary", "bonus", "transfer_in"]);
const OUTFLOW = new Set(["deposit_lockup", "expense", "rent", "fee", "tax", "transfer_out"]);
export class CashInputError extends RangeError {
  constructor(msg: string) { super(msg); this.name = "CashInputError"; }
}

// The low point is read after every event, not at day ends: within one day the order of events is not known, so the
// day's outflows are applied before its inflows (the worst case). Before, a same-day -2000 then +2000 showed no dip
// (review of WO-124c). balances[] still lists the end-of-day balance for each day.
export function run({ start, events }: { start: number; events: CashEvent[] }): CashResult {
  if (!Number.isFinite(start)) throw new CashInputError("the starting balance must be a finite number");
  if (Math.abs(start) > Number.MAX_SAFE_INTEGER) throw new CashInputError("a starting balance past 2^53 cannot be added exactly");
  if (!Array.isArray(events)) throw new CashInputError("events must be a list");
  for (const [i, e] of events.entries()) {
    if (!e || typeof e !== "object") throw new CashInputError(`event ${i + 1} is not an event`);
    if (typeof e.kind !== "string" || !e.kind.trim()) throw new CashInputError(`event ${i + 1} needs a kind`);
    // A closed list of kinds (round 4: escrow / escrow_return, bond / bond_back skipped the cap and timing checks).
    // Money held and returned is always deposit_lockup / deposit_refund; anything else is plain income or a cost.
    if (!KINDS.has(e.kind)) throw new CashInputError(`event ${i + 1}: kind "${e.kind}" is not one of ${[...KINDS].join(", ")}`);
    if (e.refundableDay !== undefined && e.kind !== "deposit_lockup") throw new CashInputError(`event ${i + 1}: only a deposit_lockup has a refundable day`);
    if (!Number.isFinite(e.day) || !Number.isFinite(e.amount)) throw new CashInputError(`event ${i + 1} needs a finite day and amount`);
    if (Math.abs(e.amount) > Number.MAX_SAFE_INTEGER) throw new CashInputError(`event ${i + 1}: an amount past 2^53 cannot be added exactly`);
    if (e.refundableDay !== undefined && !Number.isFinite(e.refundableDay)) throw new CashInputError(`event ${i + 1} has a non-finite refundable day`);
  }
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) =>
    a.e.day - b.e.day || Math.sign(a.e.amount) - Math.sign(b.e.amount) || a.i - b.i
  ).map((x) => x.e);
  const balances: { day: number; balance: number }[] = [];
  let bal = start, minBalance = start, minDay: number | null = null;
  const findings: string[] = [];
  let lockedSoFar = 0, refundedSoFar = 0, earlyRefund = false;
  // Sign errors are findings, not silently summed: a lock-up is money paid out (negative), a refund money back (positive).
  for (const e of ordered) {
    if (e.kind === "deposit_lockup" && e.amount > 0) findings.push(`a lock-up on day ${e.day} is entered as money in; a lock-up is paid out`);
    if (e.kind === "deposit_refund" && e.amount < 0) findings.push(`a refund on day ${e.day} is entered as money out; a refund comes back in`);
    if (INFLOW.has(e.kind) && e.kind !== "deposit_refund" && e.amount < 0) findings.push(`a ${e.kind} on day ${e.day} is entered as money out`);
    if (OUTFLOW.has(e.kind) && e.kind !== "deposit_lockup" && e.amount > 0) findings.push(`a ${e.kind} on day ${e.day} is entered as money in`);
  }

  // Per lock-up, in time order: each refund is matched to the lock-ups paid before it, oldest first, and the part of it
  // that comes back before that lock-up's refundable day is early (third review of WO-124c: a minimum over all lock-ups
  // missed early refunds).
  const open: { amount: number; from: number }[] = [];
  for (const e of ordered) {
    // Round 5: a refund counts in the balance only for the part matched to a lock-up already paid; the rest is not money
    // the person will get, so it is never credited (the cap is applied to the running balance, not only reported).
    let credit = e.amount;
    if (e.kind === "deposit_lockup" && e.amount < 0) { lockedSoFar += -e.amount; open.push({ amount: -e.amount, from: e.refundableDay ?? e.day }); }
    if (e.kind === "deposit_refund" && e.amount > 0) {
      refundedSoFar += e.amount;
      let left = e.amount, early = 0;
      for (const l of open) {
        if (left <= 1e-9) break;
        const take = Math.min(l.amount, left);
        if (take > 0 && e.day < l.from) early += take;
        l.amount -= take; left -= take;
      }
      credit = e.amount - Math.max(0, left);
      const laterLockup = ordered.some((x) => x.kind === "deposit_lockup" && x.day > e.day);
      if (left > 1e-9 && laterLockup && !earlyRefund) {
        earlyRefund = true;
        findings.push(`a refund on day ${e.day} comes before the lock-up it returns was paid`);
      } else if (early > 1e-9 && !earlyRefund) {
        earlyRefund = true;
        findings.push(`a refund on day ${e.day} comes before the lock-up's refundable day`);
      }
    }
    bal += credit;
    if (!Number.isFinite(bal)) throw new CashInputError("the balance overflows");
    if (bal < minBalance) (minBalance = bal, minDay = e.day);
    const lastDay = balances[balances.length - 1];
    if (lastDay?.day === e.day) lastDay.balance = bal;
    else balances.push({ day: e.day, balance: bal });
  }
  const locked = -ordered.filter((e) => e.kind === "deposit_lockup").reduce((s, e) => s + e.amount, 0);
  const refunded = ordered.filter((e) => e.kind === "deposit_refund").reduce((s, e) => s + e.amount, 0);
  if (refunded > locked + 1e-9) findings.push(`refunds (${refunded}) exceed the amount paid in (${locked})`);
  for (const e of ordered) if (e.kind === "deposit_lockup" && e.refundableDay !== undefined && e.refundableDay < e.day) findings.push(`a lock-up on day ${e.day} is refundable before it is paid`);
  const outstandingLockup = Math.max(0, locked - refunded);
  // Feasible only with no finding at all (round 5): an early refund, an over-refund, a sign error or a lock-up refundable
  // before it is paid each means the balances above may not be real.
  return { minBalance, minDay, final: bal, feasible: minBalance >= 0 && findings.length === 0, shortfall: Math.max(0, -minBalance), outstandingLockup, findings, balances };
}
