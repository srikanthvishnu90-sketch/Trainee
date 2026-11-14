// The live judge measurement spends model money only under a DECISIONS.md row that is the owner's outright approval of it (reviews of
// rounds 4 to 10: keyword gates kept letting "Owner rejected judge-measure; it approves nothing", "Architect approves …", "should the
// budget allow", "provided …", "only next week", "to be confirmed", "tomorrow", "just kidding" and "wait" through). One exact form:
//   - the row is `| D-0NN | **<ruling>** <rest> |` and the bold ruling starts "Owner approves judge-measure";
//   - the first "cap $X" in the bold ruling is at least the run's --budget-usd;
//   - the bold ruling contains none of the words that hedge, refuse, defer or condition it (HEDGED);
//   - round 10: a row approves ONE run. The request names the row and its run number (run-request.json `"run": N`); the bold ruling
//     says "run N" (for run 1, "run 1" or "one run"); a (row, run) already spent (USED) is refused.
const HEDGED = /(?<![\p{L}])(?:reject\p{L}*|refus\p{L}*|not|no|pending|await\p{L}*|wait\p{L}*|later|would|if|once|draft\p{L}*|propos\p{L}*|until|unless|except\p{L}*|after|should|provided|providing|confirm\p{L}*|tomorrow|next|only|maybe|perhaps|tentative\p{L}*|conditional\p{L}*|subject to|in principle|kidding|joking|jk)(?![\p{L}])|n['’]t(?![\p{L}])/iu;
// The runs already spent, by row: D-079 approved one run and it ran (2026-11-13, $0.0698); D-080 run 2 ran (2026-11-13, $0.116).
export const USED: Record<string, number[]> = { "D-079": [1], "D-080": [2], "D-082": [3], "D-083": [4] };
export function measureApproval(approval: string, budgetUsd: number, decisions: string, run: number): string | null {
  if (!/^D-\d{3}[a-z]?$/.test(approval)) return `the approval "${approval}" is not a DECISIONS.md id (D-xxx)`;
  if (!Number.isInteger(run) || run < 1) return `the request names no run number ("run": N, from 1)`;
  if ((USED[approval] ?? []).includes(run)) return `DECISIONS ${approval} run ${run} has already been spent`;
  const row = decisions.split("\n").find((l) => l.startsWith(`| ${approval} |`));
  if (!row) return `the approval "${approval}" is not a row of docs/architect/DECISIONS.md`;
  const m = /^\|\s*D-\d{3}[a-z]?\s*\|\s*\*\*(.+?)\*\*/.exec(row);
  if (!m) return `DECISIONS ${approval} has no bold ruling (| ${approval} | **<ruling>** … |)`;
  const ruling = m[1].replace(/\s+/g, " ").trim();
  if (!/^Owner approves judge-measure(?![\p{L}\p{N}-])/u.test(ruling)) return `DECISIONS ${approval} does not start "Owner approves judge-measure"`;
  if (HEDGED.test(ruling)) return `DECISIONS ${approval} is not an outright approval (it refuses, defers, hedges or conditions)`;
  const runs = [...ruling.matchAll(/(?<![\p{L}])run (\d+)(?![\p{N}])/giu)].map((x) => Number(x[1]));
  const named = runs.length ? runs : /(?<![\p{L}])one run(?![\p{L}])/iu.test(ruling) ? [1] : [];
  if (named.length !== 1) return `DECISIONS ${approval} does not approve exactly one run ("run N", or "one run" for run 1)`;
  if (named[0] !== run) return `DECISIONS ${approval} approves run ${named[0]}, not run ${run}`;
  const cap = /cap \$\s?(\d+(?:\.\d+)?)/i.exec(ruling);
  if (!cap) return `DECISIONS ${approval} gives no "cap $X"`;
  if (Number(cap[1]) < budgetUsd) return `DECISIONS ${approval} caps the run at $${cap[1]}, below $${budgetUsd}`;
  return null;
}
