// Apply round 4 (2026-11-05), in memory, part 1 of 2: the even-numbered scenarios of scenarios-apply-r4-battery.ts (seed 20261105,
// 10,000 scenarios over bridge / flag / dispatch / mail / words / posting; every invariant after every scenario).
import { N, runPart, SEED } from "./scenarios-apply-r4-battery.ts";

Deno.test("apply round 4 battery, part 1: no invariant broken", async () => {
  const r = await runPart(0, 2);
  console.log(`seed ${SEED}, ${N} scenarios in all; this part ran ${r.ran}: ${JSON.stringify(r.tally)}; ${r.bad.length} broken`);
  if (r.bad.length) throw new Error(`${r.bad.length} broken:\n${r.bad.slice(0, 40).join("\n")}`);
});
