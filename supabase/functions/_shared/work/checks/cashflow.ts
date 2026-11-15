// Work artifacts, cash-flow feasibility (spec WORK-ARTIFACTS.md, rule D9; pack cases 0010 and 0011). Separates the timing
// question (does the balance ever go below zero?) from final economics (where does it end, with refundable lock-ups
// counted as returned), and caps refunds at what was paid.
export type CashEvent = { day: number; amount: number; kind: string; refundableDay?: number };
export type CashResult = {
  minBalance: number; minDay: number | null; final: number; feasible: boolean; shortfall: number;
  outstandingLockup: number; findings: string[]; balances: { day: number; balance: number }[];
};

export class CashInputError extends RangeError {
  constructor(msg: string) { super(msg); this.name = "CashInputError"; }
}

// The low point is read after every event, not at day ends: within one day the order of events is not known, so the
// day's outflows are applied before its inflows (the worst case). Before, a same-day -2000 then +2000 showed no dip
// (review of WO-124c). balances[] still lists the end-of-day balance for each day.
export function run({ start, events }: { start: number; events: CashEvent[] }): CashResult {
  if (!Number.isFinite(start)) throw new CashInputError("the starting balance must be a finite number");
  if (!Array.isArray(events)) throw new CashInputError("events must be a list");
  for (const [i, e] of events.entries()) {
    if (!e || typeof e !== "object") throw new CashInputError(`event ${i + 1} is not an event`);
    if (!Number.isFinite(e.day) || !Number.isFinite(e.amount)) throw new CashInputError(`event ${i + 1} needs a finite day and amount`);
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
  }
  // The earliest day each lock-up may be refunded; a refund before every open lock-up's refundable day is early.
  const refundableFrom = ordered.filter((e) => e.kind === "deposit_lockup").map((e) => e.refundableDay ?? e.day);
  for (const e of ordered) {
    bal += e.amount;
    if (bal < minBalance) (minBalance = bal, minDay = e.day);
    const lastDay = balances[balances.length - 1];
    if (lastDay?.day === e.day) lastDay.balance = bal;
    else balances.push({ day: e.day, balance: bal });
    if (e.kind === "deposit_lockup") lockedSoFar += -e.amount;
    if (e.kind === "deposit_refund") {
      refundedSoFar += e.amount;
      // A refund cannot come back before the lock-up it returns was paid, or before that lock-up's refundable day
      // (checked in time order, not only in total). When no later lock-up exists, the refund simply exceeds the paid
      // amount, which the total check below reports.
      const laterLockup = ordered.some((x) => x.kind === "deposit_lockup" && x.day > e.day);
      if (refundedSoFar > lockedSoFar + 1e-9 && laterLockup && !earlyRefund) {
        earlyRefund = true;
        findings.push(`a refund on day ${e.day} comes before the lock-up it returns was paid`);
      } else if (lockedSoFar > 0 && refundableFrom.length && e.day < Math.min(...refundableFrom) && !earlyRefund) {
        earlyRefund = true;
        findings.push(`a refund on day ${e.day} comes before the lock-up's refundable day`);
      }
    }
  }
  const locked = -ordered.filter((e) => e.kind === "deposit_lockup").reduce((s, e) => s + e.amount, 0);
  const refunded = ordered.filter((e) => e.kind === "deposit_refund").reduce((s, e) => s + e.amount, 0);
  if (refunded > locked + 1e-9) findings.push(`refunds (${refunded}) exceed the amount paid in (${locked})`);
  for (const e of ordered) if (e.kind === "deposit_lockup" && e.refundableDay !== undefined && e.refundableDay < e.day) findings.push(`a lock-up on day ${e.day} is refundable before it is paid`);
  const outstandingLockup = Math.max(0, locked - refunded);
  return { minBalance, minDay, final: bal, feasible: minBalance >= 0, shortfall: Math.max(0, -minBalance), outstandingLockup, findings, balances };
}
