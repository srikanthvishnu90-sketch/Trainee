// The end-to-end eval's record (run.ts writes it, deploy-standard.ts S6 reads it): the run's shape and its row in the E2E
// section of evals/career/SCORE-LOG.md. No I/O here, so the gate's tests import it without the runner.
import type { Area } from "./judge.ts";

export interface E2EItem { id: string; area: Area; kind: string; pass: boolean; failed: string[]; stage: string[]; replies: string[]; intents: (string | null)[] }
export interface E2ERun { label: string; brain: string; model: string; commit: string; total: number; passed: number; rate: number; areas: Record<Area, { total: number; passed: number }>; guards: { total: number; held: number }; stopped: string | null; cost_usd: number; items: E2EItem[]; run_at: string }

const pct = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : "-";
// The E2E section of SCORE-LOG.md: one row per run, appended, never edited. Its first column after the time is the literal
// E2E, so the reply-quality parser (deploy-standard.ts parseScoreLog, which needs a commit there) never reads it.
export const E2E_HEADER = "## End-to-end task completion (release 9, workstream D)";
export const E2E_TABLE = "| run at (UTC) | E2E | commit | label | brain | model | tasks | completed | completion | apply | outreach | research | resume | guards held | cost | stopped |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
export function scoreRow(r: E2ERun): string {
  const a = (x: Area) => `${r.areas[x].passed}/${r.areas[x].total}`;
  return `| ${r.run_at.slice(0, 19).replace("T", " ")} | E2E | ${r.commit.slice(0, 40)} | ${r.label} | ${r.brain} | ${r.model} | ${r.total} | ${r.passed} | ${pct(r.passed, r.total)} | ${a("apply")} | ${a("outreach")} | ${a("research")} | ${a("resume")} | ${r.guards.held}/${r.guards.total} | $${r.cost_usd.toFixed(3)} | ${r.stopped ? `STOPPED: ${r.stopped}` : "no"} |`;
}
// The E2E section sits ABOVE the reply-quality table, so the brain-eval logger (score-log.ts), which appends its rows to the
// end of the file, keeps landing in its own table. A new E2E row goes right after the last E2E row; no earlier row moves.
export const E2E_INTRO = "One row per end-to-end run (evals/career/e2e/run.ts), appended, never edited. A task counts only on the real outcome in the stub worlds (submitted with proof matching the approved payload; delivered exactly as approved to a verified address with the opt-out header; a research file delivered with every number cited; a tailored PDF returned that opens, fits the page and carries only confirmed facts). Guards (nothing done that the person did not ask for) are counted apart. The proposed release bar (deploy-standard.ts S6, off until the owner sets S6_REQUIRED=1, D-042): completion >= 90% on the full set (40 tasks, 6 guards) with the production brain and the claude model, every guard held, on the release head. Rows with model fake are the oracle fixture (what the code paths finish when the model plans right), and rows with another brain are experiments: never the bar.";
const REPLY_TABLE = "| run at (UTC) | brain commit |";
export function appendRow(log: string, row: string): string {
  const lines = String(log ?? "").replace(/\s*$/, "").split("\n");
  const last = lines.map((l, i) => (/^\|[^|]*\| E2E \|/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  if (last !== undefined) { lines.splice(last + 1, 0, row); return `${lines.join("\n")}\n`; }
  const section = [E2E_HEADER, "", E2E_INTRO, "", ...E2E_TABLE.split("\n"), row, "", "## Reply quality (WO-061)", ""];
  const at = lines.findIndex((l) => l.startsWith(REPLY_TABLE));
  if (at < 0) return `${[...lines, "", ...section.slice(0, -3)].join("\n")}\n`;
  lines.splice(at, 0, ...section);
  return `${lines.join("\n")}\n`;
}
// The run's spend cap (--budget-usd): a finite positive number of dollars, or null. "3x", "Infinity", "0" and "-1" are
// refused before anything starts (a NaN or infinite cap would never trip the stop).
export function parseBudgetUsd(v: string): number | null {
  const t = String(v ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
