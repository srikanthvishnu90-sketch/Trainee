// WO-124b/c review findings (handoff 2026-11-15, section 2): one test per finding, added after the review said NOT fit.
// The acceptance tests in work-artifacts-xlsx-checks-20261114.test.ts are unchanged. Fixtures are invented.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";
import * as xlsx from "../../../supabase/functions/_shared/work/xlsx.ts";
import * as formula from "../../../supabase/functions/_shared/work/formula.ts";
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as capacity from "../../../supabase/functions/_shared/work/checks/capacity.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}`); }
  throw new Error(`${m}: did not throw`);
}
// XML 1.0 Char production: no C0 control other than tab, LF, CR.
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

Deno.test("124b review: a control character in a cohort name writes valid XML and reads back exactly", () => {
  const name = "Cohort\u000B A\u0001 _x0041_ & <B>";
  const rows = [
    { cohort: name, acquired: 1000, activated: 600, retained: 300, spend: 15000 },
    { cohort: "Q", acquired: 500, activated: 400, retained: 100, spend: 9000 },
  ];
  const book = xlsx.cohortWorkbook({ rows, mature: (r) => r.retained !== null });
  const bytes = xlsx.writeXlsx(book);
  const parts = unzipSync(bytes);
  for (const [n, b] of Object.entries(parts)) if (n.endsWith(".xml")) assert(!XML_BAD.test(strFromU8(b)), `${n} has a character XML 1.0 forbids`);
  eq(xlsx.esc("a\u000Bb"), "a_x000B_b", "a control is written as the OOXML escape");
  eq(xlsx.esc("_x0041_"), "_x005F_x0041_", "a literal escape-shaped text is itself escaped");
  const check = formula.recomputeAll(bytes, book.expected);
  eq(check.mismatches, [], "the evaluator still agrees with the model on every cell");
  assert(check.cells > 0, "cells were compared");
  assert(Object.values(check.values as Record<string, unknown>).includes(name), "the name reads back exactly, control characters included");
});

Deno.test("124c review: triage reads refusals, carve-outs and dates correctly", () => {
  eq(triage.classify("do not consider international applicants"), "conflict", "'do not consider' refuses");
  eq(triage.classify("applicants on OPT will not be considered"), "conflict", "'will not be considered' refuses");
  eq(triage.classify("we sponsor H-1B but not OPT"), "unknown", "a carve-out is not meets");
  eq(triage.classify("sponsorship only for full-time hires"), "unknown", "'only' is a carve-out");
  eq(triage.classify("may not sponsor"), "unknown", "a modal keeps a negative open");
  eq(triage.classify("we sponsor visas"), "meets", "a plain commitment still meets");
  const L = [{ id: "s", text: "needs sponsorship", kind: "hard" }];
  const ad = { source: "ad", date: "2026-11-01", says: { s: "we sponsor visas" } };
  eq(triage.verdict(L, [{ source: "follow-up", date: "Nov 10, 2026", says: { s: "will not sponsor" } }, ad]).s, "conflict", "a month-name date is placed in time");
  eq(triage.verdict(L, [{ source: "follow-up", date: "10 November 2026", says: { s: "will not sponsor" } }, ad]).s, "conflict", "day-month-year too");
  eq(triage.verdict(L, [ad, { source: "follow-up", says: { s: "will not sponsor" } }]).s, "unknown", "an undated source that disagrees makes it unknown");
  eq(triage.verdict(L, [ad, { source: "note", date: "soon", says: { s: "will not sponsor" } }]).s, "unknown", "an unreadable date is undated");
  eq(triage.verdict(L, [ad, { source: "note", says: { s: "sponsors visas" } }]).s, "meets", "an undated source that agrees changes nothing");
  eq(triage.dateOf("2026-11-10T09:00:00-05:00"), Date.UTC(2026, 10, 10, 14), "ISO with an offset");
});

Deno.test("124c review: cash flow shows a dip within a day and flags a refund before its lock-up", () => {
  const r = cashflow.run({ start: 100, events: [
    { day: 5, amount: 2000, kind: "stipend" },
    { day: 5, amount: -2000, kind: "deposit_lockup", refundableDay: 20 },
    { day: 20, amount: 2000, kind: "deposit_refund" },
  ] });
  eq(r.minBalance, -1900, "same-day outflow before inflow: the worst case is shown");
  eq(r.feasible, false, "the plan needs cover for the dip");
  eq(r.balances.find((b) => b.day === 5)?.balance, 100, "the end-of-day balance is still listed");
  const early = cashflow.run({ start: 0, events: [
    { day: 3, amount: 500, kind: "deposit_refund" },
    { day: 7, amount: -500, kind: "deposit_lockup" },
  ] });
  assert(early.findings.some((f) => /before the lock-up/.test(f)), `a refund before its lock-up is flagged: ${early.findings}`);
  throwsNamed(() => cashflow.run({ start: 0, events: [{ day: 1, amount: NaN, kind: "stipend" }] }), "CashInputError", "NaN amount refused");
});

Deno.test("124c review: capacity refuses invalid input instead of solving it", () => {
  const ok = { days: [{ d: 1, hours: 4 }], tasks: [{ id: "T", hours: 2, due: 1 }] };
  eq(capacity.solve(ok).feasible, true, "valid input still solves");
  throwsNamed(() => capacity.solve({ days: [{ d: 1, hours: -8 }, { d: 2, hours: 20 }], tasks: [{ id: "T", hours: 10, due: 2 }] }), "CapacityInputError", "negative day hours");
  throwsNamed(() => capacity.solve({ days: [{ d: 1, hours: 4 }], tasks: [{ id: "T", hours: -3, due: 1 }] }), "CapacityInputError", "negative task hours");
  throwsNamed(() => capacity.solve({ days: [{ d: 1, hours: NaN }], tasks: [{ id: "T", hours: 1, due: 1 }] }), "CapacityInputError", "NaN hours");
  throwsNamed(() => capacity.solve({ days: [{ d: 1, hours: 4 }, { d: 1, hours: 4 }], tasks: [{ id: "T", hours: 1, due: 1 }] }), "CapacityInputError", "a day listed twice");
  throwsNamed(() => capacity.solve({ days: [{ d: 1, hours: 4 }], tasks: [{ id: "T", hours: 1, due: 1 }, { id: "T", hours: 1, due: 1 }] }), "CapacityInputError", "a repeated task id");
  throwsNamed(() => capacity.solve({ days: [{ d: 1, hours: 4 }], tasks: [{ id: "T", hours: 1, due: Infinity }] }), "CapacityInputError", "an infinite due day");
});
