// Owner (2026-10-28): a reply that says "none", "later" or "wait" next to a yes approves NOTHING. "approve none" used to
// read as "only the employer named 'ne'" and "yes except none" as "all except 'ne'": fail-open. And the whole shown
// batch is read, never silently cut at 1000. Synthetic only; no network, no database.
import assertNode from "node:assert/strict";
import { parseCardReply, supabaseCardStore } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { db } from "./mass-submit-fixture.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

const NEVER = ["approve none", "send it later", "yes but wait", "yes except none", "approve all except none", "Approve nothing",
  "send none of them", "yes, send them tomorrow", "yes but hold", "yes not now", "send later", "only none", "yes except nobody",
  "yes, send them after lunch", "yes but not yet", "Yes but wait!", "approve none.", "yes except all", "yes except everything",
  "send them on monday", "yes if they are remote", "yes, maybe", "yes, don't send 3"];

Deno.test("FAIL-CLOSED/1 'approve none', 'send it later', 'yes but wait', 'yes except none' and kin approve nothing", async () => {
  for (const m of NEVER) eq(parseCardReply(m)?.kind, "unclear", m);
  for (const m of NEVER) {
    // Employers whose names contain "ne", "m" and "later" so a mangled name would have matched.
    const w = db({ n: 6 });
    w.prepared[0].company = "Ne Systems";
    w.prepared[1].company = "Later Labs";
    w.prepared[2].company = "Wait Inc";
    await w.say("show my applications");
    const r = await w.say(m);
    eq(r?.status, "unclear", m);
    eq(w.queue.length, 0, `nothing queued: ${m}`);
    eq(w.answerCalls.length, 0, `no approval call: ${m}`);
  }
  // The clear answers still work.
  eq((parseCardReply("yes except 3") as any).except, [3]);
  eq((parseCardReply("only 1,2") as any).only, [1, 2]);
  eq(parseCardReply("send none")?.kind, "no");
  eq(parseCardReply("later")?.kind, "hold");
});

Deno.test("FAIL-CLOSED/2 the pending batch is read in full, in pages, never cut at 1000", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}`, company: "Acme", card_lines: ["x"], created_at: String(i) }));
  const ranges: [number, number][] = [];
  const q: any = {
    select: () => q, eq: () => q, in: () => q, order: () => q,
    limit: () => { throw new Error("pending must page, not limit"); },
    range: (a: number, b: number) => {
      ranges.push([a, b]);
      // PostgREST's own max-rows: at most 1000 per request whatever is asked.
      return Promise.resolve({ data: rows.slice(a, Math.min(b + 1, a + 1000)), error: null });
    },
  };
  const store = supabaseCardStore({ from: () => q });
  const got = await store.pending("u");
  eq(got.length, 2500, "every prepared application is read");
  eq(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});
