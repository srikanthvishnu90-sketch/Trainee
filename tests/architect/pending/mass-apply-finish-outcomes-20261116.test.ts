// D-094 (owner, 2026-11-16, with D-092): the bridge's finish read only the first 100 outcomes a sandbox reported
// (cloud_prepare.ts: body.outcomes.slice(0, 100)), so a request of 122 recorded 100 and the other 22 were never weighed for
// the card or told. Every outcome is read now; what the row keeps stays within its 60,000-byte bound (storedOutcomes). No
// network, no database: the bridge with an rpc double.
import assertNode from "node:assert/strict";
import { handlePrepareBridge, prepareToken } from "../../../supabase/functions/_shared/cloud_prepare.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "TEST-d094-outcomes-secret-0123456789abcdef0123";
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000d0951", RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000d0951", LEASE = "11111111-2222-4333-8444-0000000d0951";

async function finish(n: number, detail: string) {
  const jobs = Array.from({ length: n }, (_, i) => `lever:co${i}:${9000 + i}`);
  let stored: any = null;
  const deps = { secret: SECRET, stop: async () => {},
    readRequest: async () => ({ id: RID, user_id: U, job_ids: jobs, lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() }),
    rpc: async (name: string, args: any) => {
      if (name === "career_apply_prepare_request_finish") { stored = args.p_outcome; return { state: "done" }; }
      if (name === "career_apply_prepare_request_notice") return true;
      return [];
    } };
  const out = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_o", token: await prepareToken(SECRET, RID, LEASE, "sbx_o"),
    outcomes: jobs.map((job_id) => ({ job_id, outcome: "refused", detail })) }, deps as any);
  eq(out.status, 200, JSON.stringify(out.body));
  return { stored, jobs };
}

Deno.test("122 outcomes: all 122 are recorded (before: the first 100)", async () => {
  const { stored, jobs } = await finish(122, "the employer's form could not be filled ahead of time");
  ok(Array.isArray(stored.outcomes), JSON.stringify(stored).slice(0, 200));
  eq(stored.outcomes.length, 122, `${stored.outcomes.length} recorded`);
  eq(stored.outcomes.map((o: any) => o.job_id), jobs, "every posting, in order");
});

Deno.test("a very large request keeps every posting's outcome within the row's bound: details shortened before any outcome is dropped", async () => {
  const { stored } = await finish(400, "x".repeat(300));
  ok(JSON.stringify(stored).length <= 60_000, `${JSON.stringify(stored).length} bytes`);
  eq(stored.outcomes.length, 400, "all 400 outcomes kept");
  ok(stored.outcomes.every((o: any) => o.outcome === "refused"), "each with its outcome");
});
