// The live judge measurement spends model money only under a DECISIONS.md row that is the owner's approval of it (reviews of rounds
// 4 to 7). Rows are `| D-0NN | **<ruling text>** <rest> |` (an ID and one cell; older rows have more cells). The ruling is the text of
// the cells after the ID, bold marks taken off. It approves this run only when it:
//   - is the owner's: it starts with "Owner" or records the owner as rows do ("(owner, 20…");
//   - says "approves" or "approved", and names judge-measure;
//   - gives "cap $X" with X at least the run's --budget-usd;
//   - says none of: not, no, pending, awaited, awaiting, later, would, if, once, draft, proposed, proposal, until, unless, after.
const REFUSING = /(?<![\p{L}])(?:not|no|pending|awaited|awaiting|later|would|if|once|draft|proposed|proposal|until|unless|after)(?![\p{L}])|n['’]t(?![\p{L}])/iu;
export function measureApproval(approval: string, budgetUsd: number, decisions: string): string | null {
  if (!/^D-\d{3}[a-z]?$/.test(approval)) return `the approval "${approval}" is not a DECISIONS.md id (D-xxx)`;
  const row = decisions.split("\n").find((l) => l.startsWith(`| ${approval} |`));
  if (!row) return `the approval "${approval}" is not a row of docs/architect/DECISIONS.md`;
  const ruling = row.split("|").slice(2).join(" ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (!/^owner(?![\p{L}])/iu.test(ruling) && !/\(owner, 20/i.test(ruling)) return `DECISIONS ${approval} is not the owner's ruling`;
  if (!/(?<![\p{L}])approve[sd](?![\p{L}])/iu.test(ruling)) return `DECISIONS ${approval} does not say "approves" or "approved"`;
  if (!/judge-measure/i.test(ruling)) return `DECISIONS ${approval} does not name this measurement (judge-measure)`;
  if (REFUSING.test(ruling)) return `DECISIONS ${approval} is not an outright approval (a "not", a condition, a draft or a later)`;
  const caps = [...ruling.matchAll(/cap \$\s?(\d+(?:\.\d+)?)/gi)].map((m) => Number(m[1]));
  if (!caps.some((c) => c >= budgetUsd)) return `DECISIONS ${approval} gives no "cap $X" of at least $${budgetUsd}`;
  return null;
}
