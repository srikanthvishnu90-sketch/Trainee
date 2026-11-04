// NETWORKING ROUND 2 AT SCALE (owner rules, 2026-10-30), part 1 of 2: people discovery over hostile pages, a page the person sends,
// drafts, and replies through both lanes. The scenarios, the runners and what each
// must do are in tests/architect/scenarios/networking-r2-generator.ts and networking-r2-run.ts; the end to end sample on
// Postgres is tests/architect/flow-scenarios-networking-r2.test.ts. Seeded, a fixed clock, fakes at every boundary: no
// database, no network, no model.
import assertNode from "node:assert/strict";
import { ALL, COUNTS, eq, generate, grade, runDiscovery, runDraft, runPage, runReply } from "./scenarios/networking-r2-run.ts";

Deno.test(`networking r2, discovery over hostile pages: ${COUNTS.discovery} scenarios`, async () => { await grade("discovery", ALL.discovery, runDiscovery); });
Deno.test(`networking r2, a page the person sends: ${COUNTS.page} scenarios`, async () => { await grade("page", ALL.page, runPage); });
Deno.test(`networking r2, drafts (claims on both sides, the person's language, the name, secrets): ${COUNTS.draft} scenarios`, async () => { await grade("draft", ALL.draft, runDraft); });
Deno.test(`networking r2, replies through both lanes: ${COUNTS.reply} scenarios`, async () => { await grade("reply", ALL.reply, runReply); });
Deno.test("networking r2: the battery is the size it says, deterministic", () => {
  const again = generate();
  eq(JSON.stringify(again.draft.slice(0, 50)), JSON.stringify(ALL.draft.slice(0, 50)));
  const total = Object.values(ALL).reduce((a, xs) => a + xs.length, 0);
  eq(total, Object.values(COUNTS).reduce((a, b) => a + b, 0));
  assertNode.ok(total >= 10_000, `${total}`);
});
