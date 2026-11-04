// Regression (CI of #447, flow-scenarios-research B): with research dark the staged brain's plain answer reached the person with a
// model-written link in it. A link the turn never saw (not typed, not returned by a tool) is removed; a seen one is kept.
import assertNode from "node:assert/strict";
import { stripUnseenLinks } from "../../supabase/functions/_shared/agent/research/reply.ts";

Deno.test("stripUnseenLinks removes every invented link shape and keeps the ones the turn saw", () => {
  const seen = ["https://boards.greenhouse.io/acme/jobs/1"];
  for (const bad of ["https://evil.example.com/apply", "www.evil.example.com/guide", "evil.example.com/apply-now", "javascript:alert(1)", "mailto:a@b.co"]) {
    const out = stripUnseenLinks(`Right now, build a base. This week, apply at ${bad} and message one alum.`, seen);
    assertNode.ok(!/evil|javascript|mailto/.test(out), `${bad} -> ${out}`);
    assertNode.ok(/build a base/.test(out) && /message one alum/.test(out), out);
  }
  assertNode.equal(stripUnseenLinks("See [the guide](javascript:alert(1)) now.", seen), "See the guide now.");
  const kept = "Apply here: https://boards.greenhouse.io/acme/jobs/1.";
  assertNode.equal(stripUnseenLinks(kept, seen), kept);
  assertNode.equal(stripUnseenLinks("No links at all.", seen), "No links at all.");
});
