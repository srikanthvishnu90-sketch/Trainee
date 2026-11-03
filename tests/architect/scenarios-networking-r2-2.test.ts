// NETWORKING ROUND 2 AT SCALE (owner rules, 2026-10-30), part 2 of 2: follow-up approvals bound to the batch shown, "stop
// emailing X", and the sending worker. The scenarios, the runners and what each
// must do are in tests/architect/scenarios/networking-r2-generator.ts and networking-r2-run.ts; the end to end sample on
// Postgres is tests/architect/flow-scenarios-networking-r2.test.ts. Seeded, a fixed clock, fakes at every boundary: no
// database, no network, no model.
import { ALL, COUNTS, grade, runApprove, runStop, runWorker } from "./scenarios/networking-r2-run.ts";

Deno.test(`networking r2, follow-up approvals bound to the batch shown in the chat: ${COUNTS.approve} scenarios`, async () => { await grade("approve", ALL.approve, runApprove); });
Deno.test(`networking r2, "stop emailing X": ${COUNTS.stop} scenarios`, async () => { await grade("stop", ALL.stop, runStop); });
Deno.test({ name: `networking r2, the sending worker (bounded wait, Sent check, List-Unsubscribe, mailbox, volume): ${COUNTS.worker} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() { await grade("worker", ALL.worker, runWorker); } });
