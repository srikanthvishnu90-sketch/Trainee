// D-092 / D-094 (owner, 2026-11-16): a preparation request is prepared in ONE pass, every posting of it. prepare-runner.ts runs
// prepareAhead with `only` (one page of candidates, no paging on), and that page was 25 per person: a request of 122 prepared
// 25 and the card showed 25 (eval MA14). Driven through runPrepareRequest with a bridge double whose candidate read honors
// p_per_person and p_limit as the database does; nothing reaches a network or a real employer.
import assertNode from "node:assert/strict";
import { runPrepareRequest } from "../../../workers/career-cloud/prepare-runner.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
Deno.test("122 job_ids: all 122 are tried in one pass (before: 25)", async () => {
  const jobs = Array.from({ length: 122 }, (_, i) => `greenhouse:co${i}:${8000 + i}`);
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
