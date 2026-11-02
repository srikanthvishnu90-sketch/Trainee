// Owner, 2026-11-02: "make sure the AI knows exactly what is needed" — a role ask queues every listed role to be PREPARED (its form's
// own required questions become known and are asked in chat), and sends nothing.
import assertNode from "node:assert/strict";
const eq = (a: unknown, b: unknown) => assertNode.deepStrictEqual(a, b);
import { resultsFile, whatOf } from "../../supabase/functions/_shared/role_results.ts";

const hit = (n: number) => ({ job_id: `greenhouse:acme:${n}`, title: `Data Analyst ${n}`, company: "Acme", location: "Chicago, IL", url: `https://boards.greenhouse.io/acme/jobs/${n}`, first_seen_at: "2026-11-01T00:00:00Z", pay: null });

function store(over: Record<string, unknown> = {}) {
  const wanted: string[] = [];
  const s = {
    async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; },
    async save() { return "saved" as const; }, async prepared() { return null; }, async applied() { return false; },
    async want(_u: string, job: { job_id: string }) { wanted.push(job.job_id); return { result: "queued" as const }; },
    async rememberListMeta() {}, ...over,
  };
  return { s, wanted };
}
const run = (s: unknown, n = 3) => resultsFile({ userId: "u1", now: 1762100000000, what: whatOf({ role: "data analyst", place: "Chicago", remote: false }), floor: null,
  picked: Array.from({ length: n }, (_, i) => ({ hit: hit(i + 1) as never, posting: null })), store: s as never, links: async () => ({ url: "https://x.test/file?t=abc" }) });

Deno.test("a role ask queues every listed role to be prepared, so what each application needs is known before Apply", async () => {
  const { s, wanted } = store();
  const r = await run(s);
  eq(!!r, true);
  eq(wanted.sort(), ["greenhouse:acme:1", "greenhouse:acme:2", "greenhouse:acme:3"]);
});

Deno.test("a refused or failing queue never breaks the list", async () => {
  const { s } = store({ async want() { throw new Error("db down"); } });
  const r = await run(s);
  eq(!!r, true);
  const { s: s2 } = store({ async want() { return { result: "refused", reason: "cap" }; } });
  eq(!!(await run(s2)), true);
});
