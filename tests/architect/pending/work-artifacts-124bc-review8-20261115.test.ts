// WO-124c eighth review (2026-11-15, D-088 structural bar): the constraint id goes through the same subject rules as its
// text; a funnel stage that is not a number is a finding; perRowChanged reads a non-number as changed.
import * as triage from "../../../supabase/functions/_shared/work/checks/triage.ts";
import * as funnel from "../../../supabase/functions/_shared/work/checks/funnel.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const one = (id: string, text: string, says: string) => triage.verdict([{ id, text, kind: "hard" }], [{ source: "s", date: "2026-11-10", says: { [id]: says } }])[id];

Deno.test("124c review 8: an id that negates or lists subjects lets no subject-bearing statement meet", () => {
  for (const [id, text, says] of [["no_hybrid", "Must not be hybrid", "Hybrid is available"], ["hybrid_not_ok", "", "Hybrid is available"],
    ["remote_not_hybrid", "Fully remote, not hybrid", "Hybrid is available"], ["visa_and_relocation", "", "Visa sponsorship is available"]]) eq(one(id, text, says), "unknown", id);
  eq(one("remote", "Fully remote", "remote work is available"), "meets", "the id's own subject");
  eq(one("hybrid", "", "Hybrid is available"), "meets", "an un-negated id");
});

Deno.test("124c review 8: a funnel stage that is not a number is a finding; a non-number value is a change", () => {
  for (const v of [{ error: "#DIV/0!" }, NaN, undefined, "10"]) {
    const f = funnel.monotone([{ cohort: "x", acquired: 10, activated: v as unknown as number, retained: 50 }]);
    eq(f.some((x) => /not a number/.test(x.detail)) && f.some((x) => /exceeds acquired/.test(x.detail)), true, JSON.stringify(v) ?? "undefined");
  }
  eq(funnel.perRowChanged({ P: 5 }, { P: NaN }, 1e-9), ["P"], "5 -> NaN changed");
  let threw = false; try { funnel.perRowChanged({ P: 5 }, { P: 5 }, NaN); } catch { threw = true; }
  eq(threw, true, "a NaN tolerance is refused");
});
