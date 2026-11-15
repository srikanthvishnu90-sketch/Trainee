// WO-124c tenth review (2026-11-15, D-088 structural bar): a negation anywhere in a subject's clause means it is not wanted;
// money must be whole cents.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }
const one = (id: string, text: string, says: string) => triage.verdict([{ id, text, kind: "hard" }], [{ source: "s", date: "2026-11-10", says: { [id]: says } }])[id];

Deno.test("124c review 10: a negation after the subject in its clause means the subject is not wanted", () => {
  for (const [id, text, says] of [["location", "Austin office, remote not acceptable", "Remote work is available"], ["work_mode", "Onsite only; remote is a dealbreaker", "Remote is allowed"],
    ["office", "Must be in office. Remote: no.", "remote is available"], ["remote", "remote not ok", "remote is allowed"], ["relocation", "relocation is not wanted", "relocation is paid"]]) eq(one(id, text, says), "unknown", `${id}: ${text}`);
  eq(one("remote", "Fully remote", "remote work is available"), "meets", "wanted subject");
  eq(triage.verdict([{ id: "__proto__", text: "needs sponsorship", kind: "hard" }], [{ source: "s", date: "2026-11-10", says: { ["__proto__"]: "we do not sponsor" } }])["__proto__"], "conflict", "an ordinary id");
});

Deno.test("124c review 10: an amount that is not whole cents is refused, never rounded", () => {
  throws(() => cashflow.run({ start: 0, events: [{ day: 1, amount: -0.005, kind: "expense" }] }), "half a cent");
  throws(() => cashflow.run({ start: 0.001, events: [] }), "a sub-cent start");
  eq(cashflow.run({ start: 100, events: [{ day: 1, amount: -0.33, kind: "expense" }] }).minBalance, 99.67, "whole cents add exactly");
});
