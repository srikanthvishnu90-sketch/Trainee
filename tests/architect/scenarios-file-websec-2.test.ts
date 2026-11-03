// The jobs page as a web app under attack (scenarios-file-websec-battery.ts), part 2 of 2: scenarios 5,001-10,000 over memory
// stores (split for CI time; nothing is skipped or run twice).
import { memoryRun } from "./scenarios-file-websec-battery.ts";

Deno.test({ name: "file page web security at scale, part 2 of 2: 5,000 seeded scenarios through the real handler, every invariant after every request", sanitizeOps: false, sanitizeResources: false, fn: () => memoryRun(2, 2) });
