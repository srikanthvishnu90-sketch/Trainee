// WO-124b/c sixth review (2026-11-15, D-088 structural bar): a negated mention in the constraint is not its subject; a
// non-string value from a newer source is unknown, not skipped; capacity sums that overflow are refused.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as capacity from "../../../supabase/functions/_shared/work/checks/capacity.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throws(fn: () => unknown, m: string) { try { fn(); } catch { return; } throw new Error(`${m}: did not throw`); }

Deno.test("124c review 6: a subject the constraint negates is not its subject", () => {
  eq(triage.classify("relocation is available", { id: "remote", text: "fully remote, not relocation" }), "unknown", "not relocation");
  eq(triage.classify("remote work is allowed", { id: "sponsor", text: "visa sponsorship for this remote role" }), "unknown", "the id names the subject: sponsorship, not remote");
  eq(triage.classify("we sponsor visas", { id: "sponsor", text: "needs visa sponsorship" }), "meets", "the constraint's own subject");
});

Deno.test("124c review 6: a newer source that gives a non-string value makes the verdict unknown", () => {
  const L = [{ id: "sponsor", text: "needs sponsorship", kind: "hard" }];
  for (const v of [false, null, ["no"], 0]) {
    const r = triage.verdict(L, [{ source: "ad", date: "2026-11-01", says: { sponsor: "we sponsor visas" } }, { source: "recruiter", date: "2026-11-10", says: { sponsor: v as unknown as string } }]);
    eq(r.sponsor, "unknown", JSON.stringify(v));
  }
});

Deno.test("124c review 6: capacity hours that overflow when added are refused", () => {
  throws(() => capacity.solve({ days: [{ d: 1, hours: 1e308 }, { d: 2, hours: 1e308 }], tasks: [{ id: "a", hours: 1e308, due: 2 }, { id: "b", hours: 1e308, due: 2 }, { id: "c", hours: 1e308, due: 2 }] }), "overflow");
});
