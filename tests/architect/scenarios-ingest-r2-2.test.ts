// INGEST ROUND 2 AT SCALE (2026-10-30), part 2 of 2: the scheduled handler over several boards and runs (adds, removals,
// reposts, reopenings, outages, gone boards, malformed answers, a board renamed, a schedule re-planned across lanes), and
// the races (two runs of one lane at once, a run killed mid-way, a clock behind, statement timeouts, a store failure that
// ends the run, a lane whose boards all fail). Scenarios and checks: tests/architect/scenarios/ingest-r2-generator.ts.
// Seeded, a fixed clock, fakes at every boundary: no database, no network, no model.
import { ALL, COUNTS, grade, runLife, runRace } from "./scenarios/ingest-r2-generator.ts";

Deno.test({ name: `ingest r2, the scheduled handler over many runs: ${COUNTS.life} sequences`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("life", ALL.life, runLife); } });
Deno.test({ name: `ingest r2, races, a killed run, a clock behind, timeouts, a failed store, a lane all failing: ${COUNTS.race} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("race", ALL.race, runRace); } });
