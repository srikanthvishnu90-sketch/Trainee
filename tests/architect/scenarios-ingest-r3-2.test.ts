// INGEST ROUND 3 (2026-11-03), part 2 of 2: what reads over time do to the table. Paged boards whose totals lie, whose
// list moves between pages (a posting taken down mid-read: the next page skips one), whose cursor repeats a page; the
// scheduled handler over runs with a board answering 200 and an empty list during an outage; an id the board gives to
// another job (and a closed id reused), with applications queued for each; one company on two ATS boards at once; boards
// of 1,000 to 12,000 postings read in parts inside a posting budget. Scenarios and checks:
// tests/architect/scenarios/ingest-r3-generator.ts. Seeded, fakes at every boundary: no database, no network, no model.
import { COUNTS, generate, grade, runEmpty, runLarge, runMigrate, runPaging, runReuse } from "./scenarios/ingest-r3-generator.ts";

const ALL = generate();
Deno.test({ name: `ingest r3, paged boards: totals that lie, a posting taken down mid-read, a repeated page, exact multiples: ${COUNTS.paging} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("paging", ALL.paging, runPaging); } });
Deno.test({ name: `ingest r3, the scheduled handler: 200 with an empty list during an outage, between good reads and failures: ${COUNTS.empty} sequences`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("empty", ALL.empty, runEmpty); } });
Deno.test({ name: `ingest r3, an id given to another job, a title edited, a closed id reused, applications queued for each: ${COUNTS.reuse} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("reuse", ALL.reuse, runReuse); } });
Deno.test({ name: `ingest r3, one company on two ATS boards (a migration): never merged; the old board emptied: ${COUNTS.migrate} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("migrate", ALL.migrate, runMigrate); } });
Deno.test({ name: `ingest r3, boards of 1,000 to 12,000 postings read in parts inside a posting budget: ${COUNTS.large} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("large", ALL.large, runLarge); } });
