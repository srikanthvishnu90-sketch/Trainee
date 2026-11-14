// WO-127 and WO-130 acceptance tests: a real XLSX with live formulas, recomputed independently, and the integrity checkers
// (spec WORK-ARTIFACTS.md, rules D2 and D9). Written before the code. Fixtures are invented; there is no provider and no network.
import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";
import * as xlsx from "../../../supabase/functions/_shared/work/xlsx.ts";
import * as formula from "../../../supabase/functions/_shared/work/formula.ts";
import * as funnel from "../../../supabase/functions/_shared/work/checks/funnel.ts";
import * as ics from "../../../supabase/functions/_shared/work/ics.ts";
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as capacity from "../../../supabase/functions/_shared/work/checks/capacity.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

const rows = [
  { cohort: "P", acquired: 1000, activated: 600, retained: 300, spend: 15000 },
  { cohort: "Q", acquired: 500, activated: 400, retained: 100, spend: 9000 },
  { cohort: "R", acquired: 300, activated: 0, retained: null, spend: 4000 }, // immature: retention unknown, never zero
];

Deno.test("D2: the workbook holds live formulas and the independent evaluator agrees with the model on every cell", () => {
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const bytes = xlsx.writeXlsx(book);
  const parts = unzipSync(bytes);
  const sheet = strFromU8(parts["xl/worksheets/sheet2.xml"] ?? parts["xl/worksheets/sheet1.xml"]);
  assert(/<f>/.test(sheet), "formulas are live <f> cells, not pasted values");
  assert(parts["xl/charts/chart1.xml"], "a chart part exists");
  const check = formula.recomputeAll(bytes, book.expected);
  eq(check.mismatches, [], "independent recompute matches the model on every cell");
  assert(check.cells > 0, "cells were actually compared");
});

Deno.test("D9: unknown is never zero, and an undefined rate is labelled, not an error", () => {
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const v = formula.recomputeAll(xlsx.writeXlsx(book), book.expected).values;
  eq(v["R.retained_per_acquired"], "Pending", "an immature cohort's retention reads Pending");
  const zero = xlsx.cohortWorkbook({ rows: [{ cohort: "Z", acquired: 0, activated: 0, retained: 0, spend: 0 }], mature: () => true });
  const vz = formula.recomputeAll(xlsx.writeXlsx(zero), zero.expected).values;
  eq(vz["Z.activation_rate"], "Undefined (0 acquired)", "a zero denominator is labelled");
  assert(!Object.values(vz).some((x) => /#DIV\/0!|#VALUE!/.test(String(x))), "no formula errors");
});

Deno.test("D9: a mature baseline is weighted totals, not an average of percentages, and excludes the immature cohort", () => {
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const v = formula.recomputeAll(xlsx.writeXlsx(book), book.expected).values;
  const want = (300 + 100) / (1000 + 500);
  assert(Math.abs(Number(v["baseline.retained_per_acquired"]) - want) <= 1e-9, "weighted baseline over mature P and Q only");
});

Deno.test("D9: the funnel check flags retained above activated and catches an offsetting edit per row", () => {
  eq(funnel.monotone([{ cohort: "X", acquired: 100, activated: 50, retained: 60 }]).map((f) => f.cohort), ["X"], "retained > activated flagged");
  const before = { P: 600, Q: 400 }, after = { P: 601, Q: 399 };
  eq(funnel.perRowChanged(before, after, 1e-9).sort(), ["P", "Q"], "an offsetting edit is caught per row although the sum is unchanged");
});

Deno.test("D2/D9: the ICS hold lints clean, and the UTC offset is computed per date across DST", () => {
  const text = ics.writeIcs([{ uid: "hold-1@trainee.invalid", start: "2026-11-04T15:00:00Z", end: "2026-11-04T15:45:00Z", summary: "Hold; interview (tentative)", private: true, tentative: true }]);
  eq(ics.lintIcs(text), [], "no lint findings (CRLF, folding at 75 octets, escaping, UTC, CLASS, no METHOD)");
  assert(/SUMMARY:Hold\\; interview/.test(text), "the semicolon is escaped");
  eq(ics.offsetOn("America/Chicago", "2026-10-30"), -300, "Oct 30 2026 is CDT, UTC-5, before the DST change on Nov 1");
  eq(ics.offsetOn("America/Chicago", "2026-11-04"), -360, "Nov 4 2026 is CST, UTC-6");
  const bad = ics.lintIcs("BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR");
  assert(bad.some((f) => /CRLF/.test(f)) && bad.some((f) => /METHOD/.test(f)), "a bad file is caught: " + JSON.stringify(bad));
});

Deno.test("D9: triage verdicts per constraint have three states, a newer follow-up overrides an older ad, and none-actionable is valid", () => {
  const limits = [{ id: "sponsor", text: "needs sponsorship after graduation", kind: "hard" }];
  const ad = { source: "ad", date: "2026-11-01", says: { sponsor: "may be considered" } };
  const follow = { source: "recruiter follow-up", date: "2026-11-10", says: { sponsor: "will not sponsor after graduation" } };
  eq(triage.verdict(limits, [ad]).sponsor, "unknown", "'may be considered' is not a promise");
  eq(triage.verdict(limits, [ad, follow]).sponsor, "conflict", "the newer follow-up controls");
  eq(triage.rank([{ id: "B", verdicts: { sponsor: "conflict" } }]).actionable, [], "none actionable is a valid answer");
});

Deno.test("D9: the capacity solver proves infeasibility from the arithmetic", () => {
  const r = capacity.solve({ days: [{ d: 1, hours: 4 }, { d: 2, hours: 4 }], tasks: [{ id: "T", hours: 10, due: 2, required: true }] });
  eq(r.feasible, false, "infeasible");
  eq(r.proof, { due: 2, required: 10, capacity: 8 }, "the proof names required work against capacity by the deadline");
});

Deno.test("D9: the cash-flow check separates a timing shortfall from final economics", () => {
  const r = cashflow.run({ start: 500, events: [{ day: 1, amount: -2000, kind: "deposit_lockup", refundableDay: 30 }, { day: 10, amount: 1600, kind: "stipend" }, { day: 30, amount: 2000, kind: "deposit_refund" }] });
  eq(r.minBalance, -1500, "the lowest point is the timing gap");
  eq(r.final, 2100, "final economics count the lock-up as returned, not as an expense");
  eq(r.feasible, false, "a negative low point means the plan needs cover");
});
