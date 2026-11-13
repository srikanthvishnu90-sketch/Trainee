// The live judge measurement spends model money only under a DECISIONS.md row written for it (review of round 4: any existing row
// passed). The row must be a row of docs/architect/DECISIONS.md, name this measurement ("judge-measure") and give a dollar cap at
// least the run's --budget-usd.
export function measureApproval(approval: string, budgetUsd: number, decisions: string): string | null {
  if (!/^D-\d{3}[a-z]?$/.test(approval)) return `the approval "${approval}" is not a DECISIONS.md id (D-xxx)`;
  const row = decisions.split("\n").find((l) => l.startsWith(`| ${approval} |`));
  if (!row) return `the approval "${approval}" is not a row of docs/architect/DECISIONS.md`;
  if (!/judge-measure/i.test(row)) return `DECISIONS ${approval} does not name this measurement (judge-measure)`;
  const caps = [...row.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!caps.some((c) => c >= budgetUsd)) return `DECISIONS ${approval} gives no dollar cap of at least $${budgetUsd}`;
  return null;
}
