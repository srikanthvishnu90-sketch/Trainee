// The live judge measurement spends model money only under a DECISIONS.md row that is the owner's outright approval of it (reviews of
// rounds 4 to 8: keyword gates kept letting "Owner rejected judge-measure; it approves nothing", "Architect approves …", "should the
// budget allow", "provided …", "only next week", "to be confirmed" and "tomorrow" through). One exact form, nothing else:
//   - the row is `| D-0NN | **<ruling>** <rest> |` and the bold ruling starts "Owner approves judge-measure";
//   - the first "cap $X" in the bold ruling is at least the run's --budget-usd;
//   - the bold ruling contains none of the words that hedge, refuse, defer or condition it (HEDGED).
const HEDGED = /(?<![\p{L}])(?:reject\p{L}*|not|no|pending|await\p{L}*|later|would|if|once|draft\p{L}*|propos\p{L}*|until|unless|after|should|provided|providing|confirm\p{L}*|tomorrow|next|only|maybe|perhaps|tentative\p{L}*|conditional\p{L}*|subject to|in principle)(?![\p{L}])|n['’]t(?![\p{L}])/iu;
export function measureApproval(approval: string, budgetUsd: number, decisions: string): string | null {
  if (!/^D-\d{3}[a-z]?$/.test(approval)) return `the approval "${approval}" is not a DECISIONS.md id (D-xxx)`;
  const row = decisions.split("\n").find((l) => l.startsWith(`| ${approval} |`));
  if (!row) return `the approval "${approval}" is not a row of docs/architect/DECISIONS.md`;
  const m = /^\|\s*D-\d{3}[a-z]?\s*\|\s*\*\*(.+?)\*\*/.exec(row);
  if (!m) return `DECISIONS ${approval} has no bold ruling (| ${approval} | **<ruling>** … |)`;
  const ruling = m[1].replace(/\s+/g, " ").trim();
  if (!/^Owner approves judge-measure(?![\p{L}\p{N}-])/u.test(ruling)) return `DECISIONS ${approval} does not start "Owner approves judge-measure"`;
  if (HEDGED.test(ruling)) return `DECISIONS ${approval} is not an outright approval (it refuses, defers, hedges or conditions)`;
  const cap = /cap \$\s?(\d+(?:\.\d+)?)/i.exec(ruling);
  if (!cap) return `DECISIONS ${approval} gives no "cap $X"`;
  if (Number(cap[1]) < budgetUsd) return `DECISIONS ${approval} caps the run at $${cap[1]}, below $${budgetUsd}`;
  return null;
}
