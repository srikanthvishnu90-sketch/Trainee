// Submit worker round (2026-10-31), in memory, part 1 of 2: the even-numbered scenarios of scenarios-submit-worker-battery.ts
// (seed 20261031, 10,000 scenarios over drive / restart / mail / words / backoff; every invariant after every scenario).
import { N, runPart, SEED } from "./scenarios-submit-worker-battery.ts";

Deno.test("submit worker battery, part 1: no invariant broken", async () => {
  const r = await runPart(0, 2);
  console.log(`seed ${SEED}, ${N} scenarios in all; this part ran ${r.ran}: ${JSON.stringify(r.tally)}; ${r.bad.length} broken`);
  if (r.bad.length) throw new Error(`${r.bad.length} broken:\n${r.bad.slice(0, 40).join("\n")}`);
});
