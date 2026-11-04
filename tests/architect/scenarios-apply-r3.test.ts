// Apply flow round 3, in memory: every generated scenario (scenarios/apply-r3-generator.ts, seed 20261033) through the real handler
// and Telegram's card path over the database's rules as plain code; every check of scenarios-apply-r3-battery.ts after every request.
// Split in two files for CI time: this one runs the even scenarios and the regressions, scenarios-apply-r3-2.test.ts the odd ones.
import { applyR3Tests } from "./scenarios-apply-r3-parts.ts";
await applyR3Tests(0);
