// PEOPLE FINDING AND OUTREACH DRAFTS, ROUND 3 (2026-11-02): ~10,700 fresh-seed scenarios (seed 20261102) over finding
// people and drafting to them, before the send rail. The categories, the scripted writer, the in-memory world and what each
// scenario must do are in tests/architect/scenarios/people-drafts-r3.ts; the end to end sample through the real handler on
// Postgres is tests/architect/flow-scenarios-people-drafts-r3.test.ts. No database, no network, no model.
// The strict invariants, over every scenario: every recipient fact in a draft traces to that recipient's own sourced row;
// every fact about the person to a confirmed fact; no opted-out or bounced address is ever drafted; no guessed personal
// address; no facts merged across two people with one name; nothing from text that speaks to the writer.
import {
  COUNTS, eq, generate, grade, runAddress, runAlumni, runBatch, runInjection, runNames, runNoTitle, runOptOut, runPraise, runReferral, runSameName, runShared, runSources, runStale, runAllowance,
} from "./scenarios/people-drafts-r3.ts";

const ALL = generate();
const clean = async (name: string, xs: { id: number; category: string }[], run: (s: any) => Promise<any>) => { const r = await grade(name, xs, run); eq(r.failed, 0, `${name}: ${r.failed} of ${r.total} failed (see the report above)`); };

Deno.test(`people drafts r3, two people with one name: never merged, the one asked for or "which" (${COUNTS.same_name})`, () => clean("same_name", ALL.same_name, runSameName));
Deno.test(`people drafts r3, a title that changed: the newest sourced title or none (${COUNTS.stale})`, () => clean("stale", ALL.stale, runStale));
Deno.test(`people drafts r3, a row with no title: no title is ever said of them (${COUNTS.no_title})`, () => clean("no_title", ALL.no_title, runNoTitle));
Deno.test(`people drafts r3, praise for work nothing on record says they did (${COUNTS.praise})`, () => clean("praise", ALL.praise, runPraise));
Deno.test(`people drafts r3, a school or employer in common only when on both sides (${COUNTS.shared})`, () => clean("shared", ALL.shared, runShared));
Deno.test(`people drafts r3, referral asks for another firm's job or a closed posting (${COUNTS.referral})`, () => clean("referral", ALL.referral, runReferral));
Deno.test(`people drafts r3, alumni by a short school name: whole words, two schools said (${COUNTS.alumni})`, () => clean("alumni", ALL.alumni, runAlumni));
Deno.test(`people drafts r3, addresses: only sourced ones, never a guessed personal mailbox (${COUNTS.address})`, () => clean("address", ALL.address, runAddress));
Deno.test(`people drafts r3, opted out or bounced, in a fresh search, by name, in a group or an intro (${COUNTS.optout})`, () => clean("optout", ALL.optout, runOptOut));
Deno.test(`people drafts r3, a recipient's row that speaks to the writer (${COUNTS.injection})`, () => clean("injection", ALL.injection, runInjection));
Deno.test(`people drafts r3, non-Latin names, accents and honorifics (${COUNTS.names})`, () => clean("names", ALL.names, runNames));
Deno.test(`people drafts r3, long batches: no per-firm cap, each once, pages of 1,500 characters (${COUNTS.batch})`, () => clean("batch", ALL.batch, runBatch));
Deno.test(`people drafts r3, the contacts module (#335): two people stay two, the newest title, opt-outs never imported (${COUNTS.sources})`, () => clean("sources", ALL.sources, runSources));
Deno.test({ name: `people drafts r3, the daily AI ceiling under a batch's concurrent calls: never one past it (${COUNTS.allowance})`, sanitizeOps: false, sanitizeResources: false, fn: () => clean("allowance", ALL.allowance, runAllowance) });
Deno.test("people drafts r3: the battery is the size it says, deterministic, and covers every category", () => {
  const again = generate();
  for (const [k, xs] of Object.entries(ALL)) {
    eq(xs.length, (COUNTS as Record<string, number>)[k], k);
    eq(JSON.stringify((again as any)[k].map((x: any) => x.category)), JSON.stringify(xs.map((x: any) => x.category)), `${k} is deterministic`);
  }
  const total = Object.values(ALL).reduce((a, xs) => a + xs.length, 0);
  if (total < 10_000) throw new Error(`only ${total} scenarios`);
  const ids = Object.values(ALL).flat().map((x) => x.id);
  eq(new Set(ids).size, ids.length, "every scenario has its own id");
});
