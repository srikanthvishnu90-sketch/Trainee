// The jobs page and its Apply flow at scale (scenarios-file-apply-battery.ts), part 1 of 3: the battery's regressions and
// forced interleavings, and scenarios 1-3,333 of the 10,000 over memory stores. Parts 2 and 3: scenarios-file-apply-2.test.ts
// and scenarios-file-apply-3.test.ts (split for CI time, 2026-10-30; nothing is skipped or counted twice).
import { fileApplyTests } from "./scenarios-file-apply-battery.ts";

fileApplyTests(1);
