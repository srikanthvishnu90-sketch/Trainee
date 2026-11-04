// The whole jobs-page journey, round 2 (scenarios-file-journey-r2-battery.ts), part 1 of 4: the regressions this round found, then
// scenarios 1-2,500 of the 10,000 over memory stores with a fixed clock. Parts 2-4 (scenarios-file-journey-r2-{2,3,4}.test.ts) run the rest;
// the real-Postgres journeys are flow-scenarios-file-journey-r2.test.ts.
import { journeyRegressions, journeyScale } from "./scenarios-file-journey-r2-battery.ts";

journeyRegressions();
journeyScale(1);
