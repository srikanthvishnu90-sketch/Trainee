// Work artifacts, cash-flow feasibility (spec WORK-ARTIFACTS.md, rule D9; pack cases 0010 and 0011). Separates the timing
// question (does the balance ever go below zero?) from final economics (where does it end, with refundable lock-ups
// counted as returned), and caps refunds at what was paid.
export type CashEvent = { day: number; amount: number; kind: string; refundableDay?: number };
export type CashResult = {
  minBalance: number; minDay: number | null; final: number; feasible: boolean; shortfall: number;
  outstandingLockup: number; findings: string[]; balances: { day: number; balance: number }[];
};

export function run({ start, events }: { start: number; events: CashEvent[] }): CashResult {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.day - b.e.day || a.i - b.i).map((x) => x.e);
  const balances: { day: number; balance: number }[] = [];
  let bal = start, minBalance = start, minDay: number | null = null;
  for (const e of ordered) {
    bal += e.amount;
    const lastDay = balances[balances.length - 1];
    if (lastDay?.day === e.day) lastDay.balance = bal;
    else balances.push({ day: e.day, balance: bal });
  }
  for (const b of balances) if (b.balance < minBalance) (minBalance = b.balance, minDay = b.day);
  const findings: string[] = [];
  const locked = -ordered.filter((e) => e.kind === "deposit_lockup").reduce((s, e) => s + e.amount, 0);
  const refunded = ordered.filter((e) => e.kind === "deposit_refund").reduce((s, e) => s + e.amount, 0);
  if (refunded > locked + 1e-9) findings.push(`refunds (${refunded}) exceed the amount paid in (${locked})`);
  for (const e of ordered) if (e.kind === "deposit_lockup" && e.refundableDay !== undefined && e.refundableDay < e.day) findings.push(`a lock-up on day ${e.day} is refundable before it is paid`);
  const outstandingLockup = Math.max(0, locked - refunded);
  return { minBalance, minDay, final: bal, feasible: minBalance >= 0, shortfall: Math.max(0, -minBalance), outstandingLockup, findings, balances };
}
