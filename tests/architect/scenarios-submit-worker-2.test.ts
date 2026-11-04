// Submit worker round (2026-10-31), in memory, part 2 of 2: the odd-numbered scenarios (see scenarios-submit-worker.test.ts).
import { N, runPart, SEED } from "./scenarios-submit-worker-battery.ts";

Deno.test("submit worker battery, part 2: no invariant broken", async () => {
  const r = await runPart(1, 2);
  console.log(`seed ${SEED}, ${N} scenarios in all; this part ran ${r.ran}: ${JSON.stringify(r.tally)}; ${r.bad.length} broken`);
  if (r.bad.length) throw new Error(`${r.bad.length} broken:\n${r.bad.slice(0, 40).join("\n")}`);
});
