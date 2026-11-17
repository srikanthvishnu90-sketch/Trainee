// MASS APPLY CONVERSATIONS (2026-11-16, eval MA14: 50 queued, a card of 25): the preparation sandbox reads its person's
// candidates through the bridge (cloud_prepare.ts "rpc" career_apply_prepare_candidates). The read was bounded at 25 per person,
// and the database numbers a person's candidates before it drops those already prepared, so the sandbox's second round read
// the same 25 (all prepared, all dropped) and stopped: half the request was never prepared, with nothing said. Now the read
// takes every candidate of the request (a sanity bound on the argument only, D-NO-LIMITS).
import assertNode from "node:assert/strict";
import { CANDIDATES_READ, handlePrepareBridge, prepareToken } from "../../../supabase/functions/_shared/cloud_prepare.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "TEST-unit-runner-secret-0123456789abcdef0123", U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1", LEASE = "11111111-2222-4333-8444-0000000000f1";

Deno.test("a request of 122 postings: the sandbox's candidate read returns all 122 (before: 25)", async () => {
  const jobs = Array.from({ length: 122 }, (_, i) => `greenhouse:co${i}:${8000 + i}`);
  const row = { id: RID, user_id: U, job_ids: jobs, lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  let asked: any = null;
  const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
    rpc: async (name: string, args: any) => {
      if (name === "career_apply_prepare_candidates_for") { asked = args; return jobs.slice(0, Math.min(args.p_per_person, args.p_limit)).map((job_id) => ({ user_id: U, job_id })); }
      throw Error(name);
    } };
  const out = await handlePrepareBridge("rpc", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), name: "career_apply_prepare_candidates", args: { p_per_person: 25, p_limit: 25 } }, deps as any);
  assert(Array.isArray(out.body) && (out.body as any[]).length === 122, `${(out.body as any[])?.length} of 122 read`);
  assert(asked.p_per_person >= 122 && asked.p_limit >= 122 && CANDIDATES_READ >= 122, JSON.stringify(asked));
});
