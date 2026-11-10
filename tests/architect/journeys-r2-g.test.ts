// architect amendment E.21 (2026-11-10): a search's posting-page checks are held to helpers/posting_checks.ts via scenarios/journeys-r2-world.ts and journeys-r2-run.ts (invariant I7) (no board listing, at most N for the N shown, never over 10); every other off-machine request is still a fault.
// WHOLE JOURNEYS, ROUND 2 — slice G (the journeys and their checks: scenarios/journeys-r2-run.ts; the world:
// scenarios/journeys-r2-world.ts). Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/journeys-r2-g.test.ts
import { runSlice } from "./journeys-r2-slice.ts";
runSlice("G", 6);
