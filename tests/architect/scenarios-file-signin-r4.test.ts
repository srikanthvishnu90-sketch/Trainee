// The file page's sign-in and links, round 4 (scenarios-file-signin-r4-battery.ts): part 1 of 4 of the ~10,000 seeded scenarios
// through the real handler over memory stores. Parts 2 to 4: scenarios-file-signin-r4-2.test.ts, -3, -4. Regressions for
// the round's fixes: scenarios-file-signin-r4-regressions.test.ts. The Postgres sample: flow-scenarios-file-signin-r4.test.ts.
import { memoryRun } from "./scenarios-file-signin-r4-battery.ts";

Deno.test({ name: "file page sign-in round 4, part 1 of 4: two devices, split codes, the lock-out oracle, account changes, stale tabs, CSRF, cache, host, long queries", sanitizeOps: false, sanitizeResources: false, fn: () => memoryRun(1, 4) });
