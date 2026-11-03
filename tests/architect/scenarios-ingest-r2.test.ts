// INGEST ROUND 2 AT SCALE (2026-10-30), part 1 of 2: one board's reads against every answer real boards give, paged
// boards, and the pay a board states. The scenarios, the world and what each must do are in
// tests/architect/scenarios/ingest-r2-generator.ts and ingest-r2-world.ts; part 2 (scenarios-ingest-r2-2.test.ts) runs the
// scheduled handler over many runs and the races; the multi-run sequences on Postgres are tests/architect/ingest-r2-pg.test.ts.
// Seeded, a fixed clock, fakes at every boundary: no database, no network, no model.
import { ALL, COUNTS, eq, generate, grade, runPaging, runPay, runRead } from "./scenarios/ingest-r2-generator.ts";

Deno.test(`ingest r2, one board's reads against the answers real boards give: ${COUNTS.read} scenarios`, async () => { await grade("read", ALL.read, runRead); });
Deno.test(`ingest r2, paged boards (a list that moves, a loop, the cap, duplicates): ${COUNTS.paging} scenarios`, async () => { await grade("paging", ALL.paging, runPaging); });
Deno.test(`ingest r2, the pay a board states, as it states it: ${COUNTS.pay} scenarios`, async () => { await grade("pay", ALL.pay, runPay); });
Deno.test("ingest r2: the battery is the size it says, deterministic", () => {
  const again = generate();
  eq(JSON.stringify(again.read.slice(0, 50)), JSON.stringify(ALL.read.slice(0, 50)));
  const total = Object.values(ALL).reduce((a, xs) => a + xs.length, 0);
  eq(total, Object.values(COUNTS).reduce((a, b) => a + b, 0));
  if (total < 10_000) throw new Error(`${total} scenarios`);
});
