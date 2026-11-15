// WO-124b/c second review (2026-11-15): one test per finding the re-review raised. Earlier tests are unchanged.
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";
import * as xlsx from "../../../supabase/functions/_shared/work/xlsx.ts";
import * as formula from "../../../supabase/functions/_shared/work/formula.ts";
import * as ics from "../../../supabase/functions/_shared/work/ics.ts";
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as capacity from "../../../supabase/functions/_shared/work/checks/capacity.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}`); }
  throw new Error(`${m}: did not throw`);
}

Deno.test("124c re-review: triage never reads a refusal as meets, and a refusal first stays conflict", () => {
  const conflict = [
    "no visa support", "visa support: none", "sponsorship eligible: no", "eligible: false", "we sponsor nobody",
    "we offer no relocation", "without sponsorship support", "lacks visa support", "no H-1B support", "no remote work available",
    "we will sponsor? no", "we cannot sponsor visas but offer great benefits", "we will not sponsor, but we wish you luck",
    "we do not sponsor; however, we pay well", "Sponsorship not provided", "visa sponsorship is not offered", "not sponsoring",
    "sponsorship is unavailable", "ineligible", "the role is not sponsored", "we are unable to sponsor at this time",
  ];
  for (const s of conflict) eq(triage.classify(s), "conflict", s);
  for (const s of ["may not sponsor", "we sponsor H-1B but not OPT", "yes, except interns", "we don't not sponsor", "sponsorship considered case by case"]) eq(triage.classify(s), "unknown", s);
  for (const s of ["we sponsor visas", "sponsorship is available", "yes"]) eq(triage.classify(s), "meets", s);
  const L = [{ id: "s", text: "needs sponsorship", kind: "hard" }];
  const job = (says: string) => ({ id: "J", verdicts: triage.verdict(L, [{ source: "excerpt", date: "2026-11-10", says: { s: says } }]) });
  eq(triage.rank([job("no visa support")]).actionable, [], "a 'no visa support' job is never actionable");
});

Deno.test("124c re-review: same-day disagreement is unknown; impossible and fractional-second dates are read correctly", () => {
  const L = [{ id: "s", text: "needs sponsorship", kind: "hard" }];
  const a = { source: "ad", date: "2026-11-10", says: { s: "we sponsor visas" } };
  const b = { source: "recruiter", date: "2026-11-10", says: { s: "will not sponsor" } };
  eq(triage.verdict(L, [a, b]).s, "unknown", "same day, ad first");
  eq(triage.verdict(L, [b, a]).s, "unknown", "same day, either order");
  eq(triage.dateOf("2026-11-10T09:00:00.000Z"), Date.UTC(2026, 10, 10, 9), "toISOString form with milliseconds");
  for (const d of ["Feb 30, 2026", "2026-02-30", "Nov 31, 2026"]) eq(triage.dateOf(d), null, `${d} does not exist`);
});

Deno.test("124c re-review: cash flow flags early refunds against the refundable day, sign errors and bad input", () => {
  const early = cashflow.run({ start: 0, events: [{ day: 1, amount: -500, kind: "deposit_lockup", refundableDay: 30 }, { day: 5, amount: 500, kind: "deposit_refund" }] });
  assert(early.findings.some((f) => /refundable day/.test(f)), `refund before its refundable day: ${early.findings}`);
  const signs = cashflow.run({ start: 0, events: [{ day: 1, amount: 500, kind: "deposit_lockup" }, { day: 2, amount: -500, kind: "deposit_refund" }] });
  assert(signs.findings.some((f) => /entered as money in/.test(f)) && signs.findings.some((f) => /entered as money out/.test(f)), `sign errors: ${signs.findings}`);
  const over = cashflow.run({ start: 0, events: [{ day: 1, amount: -500, kind: "deposit_lockup" }, { day: 2, amount: 300, kind: "deposit_refund" }, { day: 3, amount: 300, kind: "deposit_refund" }] });
  assert(over.findings.some((f) => /exceed/.test(f)) && !over.findings.some((f) => /before the lock-up it returns/.test(f)), `over-refund named as such: ${over.findings}`);
  throwsNamed(() => cashflow.run({ start: 0, events: null as unknown as [] }), "CashInputError", "null events");
});

Deno.test("124b re-review: a CR in text survives an XML parser's end-of-line handling; leading spaces are preserved", () => {
  eq(xlsx.esc("a\rb"), "a_x000D_b", "CR is escaped the way Excel writes it");
  const name = "  Padded\r\nCohort ";
  const book = xlsx.cohortWorkbook({ rows: [{ cohort: name, acquired: 10, activated: 5, retained: 2, spend: 100 }], mature: (r) => r.retained !== null });
  const bytes = xlsx.writeXlsx(book);
  const sheets = Object.entries(unzipSync(bytes)).filter(([n]) => n.startsWith("xl/worksheets/")).map(([, b]) => strFromU8(b)).join("");
  assert(!/\r/.test(sheets), "no raw CR in a worksheet");
  assert(/<t xml:space="preserve">/.test(sheets), "inline text keeps its spaces");
  const check = formula.recomputeAll(bytes, book.expected);
  eq(check.mismatches, [], "the evaluator agrees");
  assert(Object.values(check.values as Record<string, unknown>).includes(name), "the name reads back exactly");
});

Deno.test("124c re-review: ICS text never carries a control character", () => {
  eq(ics.escapeText("Hold\u0001 call"), "Hold call", "a control is dropped from TEXT");
  assert(ics.lintIcs("BEGIN:VCALENDAR\r\nSUMMARY:a\u0001b\r\nEND:VCALENDAR\r\n").some((f) => /control character/.test(f)), "lint reports one");
});

Deno.test("124c re-review: a task id of 0 is a real id", () => {
  eq(capacity.solve({ days: [{ d: 1, hours: 4 }], tasks: [{ id: 0 as unknown as string, hours: 1, due: 1 }] }).feasible, true, "id 0 accepted");
});
