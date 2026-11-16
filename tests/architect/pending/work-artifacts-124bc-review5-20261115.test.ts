// WO-124b/c fifth review (2026-11-15, D-088 structural bar): refunds capped in the running balance, every finding makes
// a plan infeasible, signs checked on every closed kind, the day window's bounds, and a commitment about another
// subject is not meets. Earlier tests unchanged.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

Deno.test("124c review 5: a cash plan with any finding is not feasible, and an over-refund is never credited", () => {
  const c1 = cashflow.run({ start: 1000, events: [{ day: 1, amount: -1000, kind: "deposit_lockup", refundableDay: 5 }, { day: 5, amount: 3000, kind: "deposit_refund" }, { day: 6, amount: -2500, kind: "rent" }] });
  eq([c1.feasible, c1.minBalance], [false, -1500], "only the 1000 paid comes back");
  eq(cashflow.run({ start: 0, events: [{ day: 1, amount: 5000, kind: "deposit_refund" }, { day: 2, amount: -5000, kind: "rent" }] }).feasible, false, "a refund with no lock-up");
  eq(cashflow.run({ start: 0, events: [{ day: 1, amount: 1000, kind: "deposit_lockup" }, { day: 2, amount: -1000, kind: "rent" }] }).feasible, false, "a lock-up entered as money in");
  eq(cashflow.run({ start: 0, events: [{ day: 1, amount: 1000, kind: "rent" }] }).feasible, false, "rent entered as money in");
  eq(cashflow.run({ start: 0, events: [{ day: 1, amount: -1000, kind: "salary" }] }).feasible, false, "salary entered as money out");
  eq(cashflow.run({ start: 500, events: [{ day: 1, amount: -200, kind: "deposit_lockup", refundableDay: 3 }, { day: 3, amount: 200, kind: "deposit_refund" }, { day: 4, amount: -100, kind: "rent" }] }).feasible, true, "a clean plan is feasible");
});

Deno.test("124c review 5: a calendar day spans UTC-12 to UTC+14 for ordering", () => {
  const L = [{ id: "v", text: "needs sponsorship", kind: "hard" }];
  for (const d of ["2026-11-14T01:00+14:00", "2026-11-13T11:00Z"]) {
    eq(triage.verdict(L, [{ source: "a", date: d, says: { v: "we do not sponsor" } }, { source: "b", date: "2026-11-14", says: { v: "we sponsor visas" } }]).v, "unknown", d);
  }
});

Deno.test("124c review 5: a commitment about another subject does not meet the constraint", () => {
  const one = (id: string, text: string, says: string) => triage.verdict([{ id, text, kind: "hard" }], [{ source: "a", date: "2026-11-10", says: { [id]: says } }])[id];
  eq(one("remote", "fully remote", "Hybrid is available."), "unknown", "hybrid is not fully remote");
  eq(one("sponsor", "needs sponsorship", "relocation is available"), "unknown", "relocation is not sponsorship");
  eq(one("st", "stipend of at least 2000", "a stipend is available"), "unknown", "no amount is committed");
  eq(one("remote", "fully remote", "remote work is available"), "meets", "same subject");
  eq(one("v", "needs sponsorship", "we sponsor visas"), "meets", "same subject");
  eq(one("v", "needs sponsorship", "yes"), "meets", "no subject named: about the constraint asked");
});
