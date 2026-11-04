// Sign-in at scale for the hosted jobs page (scenarios-file-signin-battery.ts), part 1 of 2: the battery's regressions and
// scenarios 1-5,000 of the 10,000 over memory stores. Part 2: scenarios-file-signin-2.test.ts (split for CI time,
// 2026-10-30; nothing is skipped or counted twice).
import { fileSigninTests } from "./scenarios-file-signin-battery.ts";

fileSigninTests(1);
