// The file page's sign-in and links, round 4 (scenarios-file-signin-r4-battery.ts): part 4 of 4 of the ~10,000 seeded scenarios
// through the real handler over memory stores (this file: one quarter of them; scenarios-file-signin-r4.test.ts names the rest).
import { memoryRun } from "./scenarios-file-signin-r4-battery.ts";

Deno.test({ name: "file page sign-in round 4, part 4 of 4: two devices, split codes, the lock-out oracle, account changes, stale tabs, CSRF, cache, host, long queries", sanitizeOps: false, sanitizeResources: false, fn: () => memoryRun(4, 4) });
