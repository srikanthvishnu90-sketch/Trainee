// WHOLE JOURNEYS, ROUND 2 — slice A (the journeys and their checks: scenarios/journeys-r2-run.ts; the world:
// scenarios/journeys-r2-world.ts). Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/journeys-r2-a.test.ts
import { runSlice } from "./journeys-r2-slice.ts";
runSlice("A", 0);
