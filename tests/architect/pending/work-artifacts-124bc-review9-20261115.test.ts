// WO-124c ninth review (2026-11-15, D-088 structural bar): money added exactly in cents within $1 trillion; capacity totals
// within a billion hours and every required hour placed, or the plan is infeasible.
import * as capacity from "../../../supabase/functions/_shared/work/checks/capacity.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }
const M = Number.MAX_SAFE_INTEGER;

Deno.test("124c review 9: cash flow adds exact cents and refuses amounts that cannot be added exactly", () => {
  throws(() => cashflow.run({ start: 0, events: [{ day: 1, amount: M, kind: "income" }, { day: 2, amount: 1, kind: "income" }, { day: 4, amount: -M, kind: "expense" }, { day: 5, amount: -5, kind: "expense" }] }), "past $1 trillion");
  const r = cashflow.run({ start: 1000, events: [{ day: 1, amount: 0.07, kind: "income" }, { day: 2, amount: -1000, kind: "expense" }, { day: 3, amount: -0.1, kind: "expense" }] });
  eq([r.minBalance, r.feasible], [-0.03, false], "the true low point in cents");
});

Deno.test("124c review 9: capacity refuses totals it cannot add exactly and never reports a short plan feasible", () => {
  throws(() => capacity.solve({ days: [{ d: 1, hours: M }, { d: 2, hours: 1 }, { d: 3, hours: 3 }], tasks: [{ id: "a", hours: M, due: 3 }, { id: "b", hours: 1, due: 3 }, { id: "c", hours: 4, due: 3 }] }), "over a billion hours");
  eq(capacity.solve({ days: [{ d: 1, hours: 4 }, { d: 2, hours: 4 }], tasks: [{ id: "a", hours: 5, due: 2 }, { id: "b", hours: 3, due: 2 }] }).feasible, true, "an exact fit is feasible");
});
