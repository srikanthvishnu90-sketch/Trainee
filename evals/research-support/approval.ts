// The live judge measurement spends model money only under a DECISIONS.md row that is the owner's approval of it (reviews of rounds
// 4 and 5: any existing row passed, then "judge-measure is prepared and NOT approved" and "Do not run judge-measure" passed). The row
// must be a row of docs/architect/DECISIONS.md (| ID | Decision | Status | By | Date |, or | ID | By | Decision |) whose cells:
//   - name the owner as who decided (a cell that is "owner", "Owner", "owner, architect", ...);
//   - approve judge-measure: the decision names judge-measure and says it is approved (approved / approve / yes / go ahead / run it);
//   - deny nothing: no "not", "no", "never", "don't", "do not", "denied", "declined", "rejected", "withdrawn", "pending", "superseded";
//   - give a dollar cap at least the run's --budget-usd.
const NEGATED = /(?<![\p{L}])(?:not|no|never|don['’]?t|do not|cannot|can['’]?t|denied|deny|declined?|rejected|reject|withdrawn|withdraw|pending|superseded|revoked|paused|halt(?:ed)?|stop(?:ped)?|unapproved)(?![\p{L}])/iu;
const APPROVES = /(?<![\p{L}])(?:approved?|approves|yes|go ahead|go-ahead|run it|authori[sz]ed?)(?![\p{L}])/iu;
export function measureApproval(approval: string, budgetUsd: number, decisions: string): string | null {
  if (!/^D-\d{3}[a-z]?$/.test(approval)) return `the approval "${approval}" is not a DECISIONS.md id (D-xxx)`;
  const row = decisions.split("\n").find((l) => l.startsWith(`| ${approval} |`));
  if (!row) return `the approval "${approval}" is not a row of docs/architect/DECISIONS.md`;
  const cells = row.split("|").map((c) => c.trim()).filter(Boolean).slice(1);
  if (!cells.some((c) => /^owner(?![\p{L}])/iu.test(c))) return `DECISIONS ${approval} is not the owner's decision`;
  const text = cells.filter((c) => !/^owner(?![\p{L}])/iu.test(c)).join(" | ");
  if (!/judge-measure/i.test(text)) return `DECISIONS ${approval} does not name this measurement (judge-measure)`;
  if (NEGATED.test(text)) return `DECISIONS ${approval} does not approve it without a "not", "no" or a refusal`;
  if (!APPROVES.test(text)) return `DECISIONS ${approval} does not say judge-measure is approved`;
  const caps = [...text.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!caps.some((c) => c >= budgetUsd)) return `DECISIONS ${approval} gives no dollar cap of at least $${budgetUsd}`;
  return null;
}
