// WO-124c seventh review (2026-11-15, D-088 structural bar): a constraint naming several subjects lets no subject meet;
// repeated constraint ids and amounts past 2^53 are refused.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as capacity from "../../../supabase/functions/_shared/work/checks/capacity.ts";
import * as cashflow from "../../../supabase/functions/_shared/work/checks/cashflow.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }
const one = (text: string, says: string) => triage.verdict([{ id: "j1", text, kind: "hard" }], [{ source: "s", date: "2026-11-10", says: { j1: says } }]).j1;

Deno.test("124c review 7: when the constraint names several subjects, a statement about one of them is unknown", () => {
  for (const [text, says] of [["Fully remote, won't relocate", "Relocation is provided"], ["Fully remote; can't relocate", "relocation is paid"],
    ["Remote only, hybrid is a dealbreaker", "Hybrid is available"], ["Remote only (hybrid not acceptable)", "hybrid is allowed"],
    ["Remote work; relocation is out of the question", "relocation is covered"]]) eq(one(text, says), "unknown", `${text} | ${says}`);
  eq(triage.rank([{ id: "j", verdicts: triage.verdict([{ id: "j1", text: "Fully remote, won't relocate", kind: "hard" }], [{ source: "s", date: "2026-11-10", says: { j1: "Relocation is provided" } }]) }]).actionable, [], "never actionable");
  eq(one("Fully remote", "remote work is available"), "meets", "one subject, the same one");
});

Deno.test("124c review 7: repeated constraint ids and amounts past 2^53 are refused", () => {
  throws(() => triage.verdict([{ id: "r", text: "Fully remote", kind: "hard" }, { id: "r", text: "Visa sponsorship", kind: "hard" }], []), "repeated id");
  throws(() => cashflow.run({ start: 9007199254740996, events: [{ day: 1, amount: -1, kind: "rent" }] }), "start past 2^53");
  throws(() => capacity.solve({ days: [{ d: 1, hours: 2 ** 53 + 2 }], tasks: [{ id: "a", hours: 2 ** 53, due: 1 }] }), "hours past 2^53");
});
