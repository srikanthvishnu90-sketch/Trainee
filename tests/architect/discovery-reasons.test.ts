// Muse's review of fc7ac325 (c): the reasons the boundary stops on are by design, never errors, and the record keeps
// what stopped (the field), in the cloud worker's settle() and in the cloud prepare's refusal.
import assertNode from "node:assert/strict";
import { settle } from "../../workers/career-cloud/worker.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

for (const reason of [
  "LOOKUP_NEEDS_APPROVAL: Location (City)", "MULTI_STEP_NEEDS_APPROVAL", "DISCOVERY_NAVIGATION_STOPPED", "DISCOVERY_FILL_LOCAL_ONLY",
  "LOOKUP_UNRESOLVED: Location",
]) {
  Deno.test(`boundary reason is by design and names what stopped: ${reason}`, () => {
    const s = settle({ state: "not_submitted", reason });
    eq(s.outcome, "not_sent", JSON.stringify(s));
    eq(s.errorKind, reason.split(":")[0]);
    eq(s.reason, reason, "the field it names is kept");
  });
}

Deno.test("an unknown reason is still an error, by its class", () => {
  const s = settle({ state: "not_submitted", reason: "SOMETHING_NEW: detail" });
  eq([s.outcome, s.errorKind], ["error", "SOMETHING_NEW"]);
});
