// ag/ma-10-whole-request-prep (2026-11-17; source: ag/mass-apply-10 b01849ec0, d53acba1f and the prepare-runner half of
// 5ddfb61ed). D-092/D-094 (owner, 2026-11-16): every posting of a preparation request is prepared in ONE pass, ahead of the
// card. Before (eval MA14): a request of 50 prepared 25 and a card of those 25 was pushed; the other 25 were never prepared,
// with nothing said, because
//   1. the sandbox's candidate read (cloud_prepare.ts "rpc" career_apply_prepare_candidates) was bounded at 25 per person,
//      and the database numbers a person's candidates BEFORE it drops those already prepared, so the second round read the
//      same 25 (all prepared, all dropped) and stopped;
//   2. prepare-runner.ts ran prepareAhead with a page of 25 per person, so a request of 122 tried 25;
//   3. the finish's hold check read the same 25, so a card of part of the batch was pushed while the rest still waited.
// The review of ag/mass-apply-10 (should-fix): the hold check read up to 10,000 rows on every finish; it now asks the
// database for at most one row more than this run made ready. Nothing here approves or sends anything: the card and its
// payload-hash yes are unchanged (D-MS-1).
import assertNode from "node:assert/strict";
import { CANDIDATES_READ, handlePrepareBridge, prepareToken } from "../../../supabase/functions/_shared/cloud_prepare.ts";
import { runPrepareRequest } from "../../../workers/career-cloud/prepare-runner.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "TEST-unit-runner-secret-0123456789abcdef0123", U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1", LEASE = "11111111-2222-4333-8444-0000000000f1";
const jobsOf = (n: number) => Array.from({ length: n }, (_, i) => `greenhouse:co${i}:${8000 + i}`);
// career_apply_prepare_candidates_for as the database runs it: number the person's candidates (rn <= p_per_person), THEN drop
// the ones already prepared, then p_limit.
const candidatesFor = (jobs: string[], prepared: Set<string>) => (args: any) =>
  jobs.slice(0, args.p_per_person).filter((j) => !prepared.has(j)).slice(0, args.p_limit).map((job_id) => ({ user_id: U, job_id }));

Deno.test("the sandbox's candidate read: a request of 122 reads all 122 (before: 25)", async () => {
  const jobs = jobsOf(122);
  const row = { id: RID, user_id: U, job_ids: jobs, lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const asked: any[] = [];
  const read = candidatesFor(jobs, new Set());
  const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
    rpc: async (name: string, args: any) => { if (name === "career_apply_prepare_candidates_for") { asked.push(args); return read(args); } throw Error(name); } };
  const out = await handlePrepareBridge("rpc", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), name: "career_apply_prepare_candidates", args: { p_per_person: 25, p_limit: 25 } }, deps as any);
  assert(Array.isArray(out.body) && (out.body as any[]).length === 122, `${(out.body as any[])?.length} of 122 read`);
  assert(CANDIDATES_READ >= 122 && asked.at(-1).p_per_person >= 122 && asked.at(-1).p_limit >= 122, JSON.stringify(asked));
});

Deno.test("the second round after 25 were prepared reads the other 25 (before: the same 25, all dropped, and the run stopped)", async () => {
  const jobs = jobsOf(50);
  const row = { id: RID, user_id: U, job_ids: jobs, lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const read = candidatesFor(jobs, new Set(jobs.slice(0, 25)));
  const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
    rpc: async (name: string, args: any) => { if (name === "career_apply_prepare_candidates_for") return read(args); throw Error(name); } };
  const out = await handlePrepareBridge("rpc", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), name: "career_apply_prepare_candidates", args: {} }, deps as any);
  eq((out.body as any[]).map((c) => c.job_id), jobs.slice(25));
});

Deno.test("finish: a candidate still waiting past the 25th holds the card; the hold check asks for one row more than this run readied", async () => {
  const jobs = jobsOf(40), readyIds = jobs.slice(0, 25);
  const row = { id: RID, user_id: U, job_ids: jobs, lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const ready = readyIds.map((job_id, i) => ({ id: `cccccccc-bbbb-4ccc-8ddd-${String(i).padStart(12, "0")}`, company: `Co ${i}`, card_lines: [`Co ${i}`, "Email: a@example.test"], created_at: new Date().toISOString(), job_id }));
  const run = async (waiting: string[]) => {
    const asked: any[] = [], calls: string[] = [];
    const read = candidatesFor([...readyIds, ...waiting], new Set(readyIds));
    const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
      rpc: async (name: string, args: any) => {
        calls.push(name);
        if (name === "career_apply_prepare_request_ready") return ready;
        if (name === "career_apply_questions_open_as") return [];
        if (name === "career_apply_prepare_candidates_for") { asked.push(args); return read(args); }
        if (name.startsWith("career_apply_card_push")) return "dddddddd-bbbb-4ccc-8ddd-0000000000f4";
        if (name === "career_apply_prepare_request_finish") return { state: "done" };
        return null;
      } };
    const out = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"),
      outcomes: readyIds.map((job_id) => ({ job_id, outcome: "ready", detail: "" })) }, deps as any);
    return { push: (out.body as any).push, asked, calls };
  };
  const held = await run(jobs.slice(25));
  eq(held.push, "held_for_answers", "15 more of the request still wait to be prepared");
  assert(held.asked.every((a) => a.p_per_person >= 40 && a.p_limit <= readyIds.length + 1), JSON.stringify(held.asked));
  assert(!held.calls.some((c) => c.startsWith("career_apply_card_push")), "no card of part of the batch");
  const none = await run([]);
  assert(none.push !== "held_for_answers", `nothing else waits: the card goes (${none.push})`);
});

Deno.test("prepare-runner: 122 job_ids are all tried in one pass (before: 25)", async () => {
  const jobs = jobsOf(122);
  const asked: any[] = [];
  const bridge: any = {
    call: async (op: string, extra?: any) => {
      if (op === "request") return { user_id: U, job_ids: jobs };
      if (op === "resume") return null;
      if (op === "finish") return { state: "done", outcomes: extra?.outcomes?.length };
      return null;
    },
    db: { rpc: async (name: string, args: any) => {
      if (name === "career_apply_prepare_candidates") {
        asked.push(args);
        return { data: jobs.slice(0, Math.min(args.p_per_person, args.p_limit)).map((job_id, i) => ({ user_id: U, job_id, company: `Co ${i}`, title: "Operations Associate", url: `https://boards.greenhouse.io/co${i}/jobs/${8000 + i}`, location: "Remote", description: "", epoch: 0, version: 0 })), error: null };
      }
      if (name === "career_apply_answers_for") return { data: [], error: null };
      return { data: null, error: null };
    } },
  };
  const r = await runPrepareRequest({ bridge, runEngine: (async () => ({ result: { state: "not_submitted" } })) as any, schema: false, log: () => {} });
  eq(new Set(r.outcomes.map((o: any) => o.job_id)).size, 122, `${r.outcomes.length} tried; reads: ${JSON.stringify(asked.map((a) => [a.p_per_person, a.p_limit]))}`);
});
