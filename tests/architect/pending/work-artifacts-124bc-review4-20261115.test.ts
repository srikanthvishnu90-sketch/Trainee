// WO-124b/c fourth review (2026-11-15), under D-088's structural bar: cross-zone ordering, rank by allow-list, strict
// ICS times, a closed list of cash kinds, early refunds and feasibility, Excel-reserved names. Earlier tests unchanged.
import * as xlsx from "../../../supabase/functions/_shared/work/xlsx.ts";
import * as ics from "../../../supabase/functions/_shared/work/ics.ts";
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }
const L = [{ id: "v", text: "needs sponsorship", kind: "hard" }];

Deno.test("124c review 4: an untimed day and a timed source that could fall on it, in any zone, are unordered", () => {
  const v = (a: triage.Source, b: triage.Source) => triage.verdict(L, [a, b]).v;
  eq(v({ source: "A", date: "2026-11-11T20:00-05:00", says: { v: "yes, we sponsor" } }, { source: "B", date: "2026-11-12", says: { v: "we do not sponsor" } }), "unknown", "evening west of UTC vs next day");
  eq(v({ source: "A", date: "2026-11-11T22:00-08:00", says: { v: "yes, we sponsor" } }, { source: "B", date: "Nov 12, 2026", says: { v: "we do not sponsor" } }), "unknown", "month-name next day");
  eq(v({ source: "A", date: "2026-11-01", says: { v: "we sponsor visas" } }, { source: "B", date: "2026-11-10", says: { v: "we do not sponsor" } }), "conflict", "days apart stay ordered");
});

Deno.test("124c review 4: rank is actionable only when every verdict is exactly meets", () => {
  const r = triage.rank([{ id: "a", verdicts: { v: "Conflict" as triage.Verdict } }, { id: "b", verdicts: { v: "no" as triage.Verdict } },
    { id: "c", verdicts: { v: undefined as unknown as triage.Verdict } }, { id: "d", verdicts: {} }, { id: "e", verdicts: { v: "meets" } }]);
  eq(r.actionable, ["e"], "only the all-meets job");
});

Deno.test("124c review 4: ICS times are strict ISO with an offset on a real day", () => {
  for (const t of ["2026-11-10 10:00", "2026-11-10t10:00", "Nov 10 2026 10:00", "10 Nov 2026 10:00", "2026-11-10T10:00", "2026-02-30T10:00Z", "2026-11-10T24:00Z"]) throws(() => ics.utc(t), t);
  eq(ics.utc("2026-11-10T10:00-05:00"), "20261110T150000Z", "an offset converts");
});

Deno.test("124c review 4: cash kinds are a closed list; only a lock-up has a refundable day; an early refund is not feasible", () => {
  for (const kind of ["escrow", "escrow_return", "bond", "bond_back", "security_hold", "Kaution", "retainer", "reimbursement"]) {
    throws(() => cashflow.run({ start: 1000, events: [{ day: 1, amount: -1000, kind }] }), kind);
  }
  throws(() => cashflow.run({ start: 0, events: [{ day: 1, amount: -5, kind: "rent", refundableDay: 9 }] }), "a refundable day on rent");
  const r = cashflow.run({ start: 1000, events: [{ day: 1, amount: -1000, kind: "deposit_lockup", refundableDay: 30 }, { day: 2, amount: 1000, kind: "deposit_refund" }, { day: 5, amount: -800, kind: "rent" }] });
  eq(r.feasible, false, "an early refund's money is not really there");
});

Deno.test("124b review 4: Excel-reserved defined names and over-long cohort names are refused", () => {
  for (const n of ["r", "c", "R", "C", "TRUE", "false"]) throws(() => xlsx.checkDefinedName(n), n);
  throws(() => xlsx.cohortWorkbook({ rows: [{ cohort: "x".repeat(40000), acquired: 1, activated: 1, retained: 1, spend: 1 }], mature: () => true }), "40,000 characters");
});
