// The jobs page as a web app under attack (scenarios-file-websec-battery.ts), part 1 of 2: scenarios 1-5,000 of the 10,000 over
// memory stores, plus the battery's direct regressions (scenarios-file-websec-regressions.ts). Part 2:
// scenarios-file-websec-2.test.ts; the Postgres sample: flow-scenarios-file-websec.test.ts.
import { memoryRun } from "./scenarios-file-websec-battery.ts";
import "./scenarios-file-websec-regressions.ts";

Deno.test({ name: "file page web security at scale, part 1 of 2: 5,000 seeded scenarios through the real handler, every invariant after every request", sanitizeOps: false, sanitizeResources: false, fn: () => memoryRun(1, 2) });
