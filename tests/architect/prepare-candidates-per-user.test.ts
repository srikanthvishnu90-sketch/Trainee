// MASS APPLY (2026-11-02): the sandbox's candidate read is per person. The global career_apply_prepare_candidates(p_now, 25, 500)
// was filtered to the request's person only AFTERWARDS, so once more than ~500 newer candidate rows of other people existed, a
// waiting person got none and was told the posting was "no longer open on file".
//   unit  (runs anywhere, no database): the bridge calls career_apply_prepare_candidates_for with p_user = the request's person;
//         a person is not starved by 600 other people's rows; a posting that is not the request's is still not returned.
//   pg    (needs Postgres 16: CI only; NOT run in the sandbox it was written in): the new function returns the same rows as the
//         global one for a person, is not starved, and is executable by service_role only.
import assertNode from "node:assert/strict";
import { handlePrepareBridge, prepareToken } from "../../supabase/functions/_shared/cloud_prepare.ts";
import { pgBinDir, startPg } from "../flow/pg.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SECRET = "TEST-unit-runner-secret-0123456789abcdef0123";
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000002a1", OTHER = "7b0f8f8e-6a43-4a49-9d2c-0000000002a2";
const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000002f1", LEASE = "11111111-2222-4333-8444-0000000002f1";

function bridge(globalRows: any[], perUserRows: (u: string) => any[]) {
  const row: any = { id: RID, user_id: U, job_ids: ["ashby:ramp:1"], lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const calls: { name: string; args: any }[] = [];
  const deps = {
    secret: SECRET, readRequest: async () => row,
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "career_apply_prepare_candidates") return globalRows.slice(0, args.p_limit); // the starving read
      if (name === "career_apply_prepare_candidates_for") return perUserRows(args.p_user).slice(0, args.p_limit);
      return { ok: true };
    },
  };
  return { calls, call: async (extra: any) => handlePrepareBridge("rpc", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), ...extra }, deps) };
}
const ask = { name: "career_apply_prepare_candidates", args: { p_now: "x", p_per_person: 999, p_limit: 999 } };

Deno.test("per-person candidates: the per-person RPC is called with the request's person, never the body's", async () => {
  const { calls, call } = bridge([], () => [{ user_id: U, job_id: "ashby:ramp:1" }]);
  const r = await call({ ...ask, args: { ...ask.args, p_user: OTHER } });
  eq(r.status, 200);
  eq(calls.length, 1);
  eq(calls[0].name, "career_apply_prepare_candidates_for");
  eq(calls[0].args.p_user, U);
  eq([calls[0].args.p_per_person, calls[0].args.p_limit], [25, 500], "the bounds are the bridge's, not the sandbox's");
});

Deno.test("per-person candidates: a request is not starved when 600 other people's rows exist", async () => {
  const others = Array.from({ length: 600 }, (_, i) => ({ user_id: OTHER, job_id: `ashby:x:${i}` }));
  const mine = [{ user_id: U, job_id: "ashby:ramp:1" }];
  // The global read puts 600 newer rows of other people first: the old bridge would have got zero of this person's.
  const { call } = bridge([...others, ...mine], (u) => (u === U ? mine : others));
  const r = await call(ask);
  eq(r.body, [{ user_id: U, job_id: "ashby:ramp:1" }]);
});

Deno.test("per-person candidates: a posting that is not the request's, or another person's row, is still refused", async () => {
  const { call } = bridge([], () => [
    { user_id: U, job_id: "ashby:ramp:1" }, { user_id: U, job_id: "ashby:other:9" }, { user_id: OTHER, job_id: "ashby:ramp:1" },
  ]);
  eq((await call(ask)).body, [{ user_id: U, job_id: "ashby:ramp:1" }]);
});

Deno.test("per-person candidates: the migration, its rollback and the go-live list agree", () => {
  const f = "20261102120000_career_apply_prepare_candidates_for.sql";
  const sql = Deno.readTextFileSync(`${ROOT}/supabase/migrations/${f}`);
  assert(/where o\.user_id = p_user and o\.kind = 'alert'/.test(sql) && /where w\.user_id = p_user and w\.state = 'waiting'/.test(sql), "the person is named at the start of the CTEs");
  assert(/revoke all on function public\.career_apply_prepare_candidates_for\(uuid, timestamptz, integer, integer\) from public, anon, authenticated;/.test(sql));
  assert(/grant execute on function public\.career_apply_prepare_candidates_for\(uuid, timestamptz, integer, integer\) to service_role;/.test(sql));
  assert(!/create or replace function public\.career_apply_prepare_candidates\(/.test(sql), "the global function is not changed");
  assert(Deno.readTextFileSync(`${ROOT}/supabase/rollbacks/${f.replace(".sql", ".down.sql")}`).includes("drop function if exists public.career_apply_prepare_candidates_for"));
  assert(Deno.readTextFileSync(`${ROOT}/scripts/launch/trainee-go-live.sh`).includes(`  ${f}\n`));
});

Deno.test({
  name: "pg: career_apply_prepare_candidates_for is not starved by other people's rows and matches the global function for the person",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg = await startPg({ includeBridge: true });
    try {
      // 30 other people, 25 waiting postings each (the per-person cap): 750 newer rows, more than the global read's 500.
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        select 'greenhouse:p' || g || ':' || n, 'greenhouse', 'p' || g, 'Co ' || g, 'Intern', 'Chicago, IL', 'https://boards.greenhouse.io/p' || g || '/jobs/' || n, 'x', now(), now()
        from generate_series(1, 31) g, generate_series(1, 25) n;
        insert into auth.users (id, email) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@example.test' from generate_series(1, 31) g;
        insert into public.profiles (id) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 31) g;
        insert into public.career_watch_kv (user_id, key, value) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'career:account', '{"epoch":0,"version":0,"paused":false}' from generate_series(1, 31) g;
        insert into public.career_apply_wanted (user_id, posting_key, url, company, title, state, queued_at)
        select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'greenhouse:p' || g || ':' || n, 'https://boards.greenhouse.io/p' || g || '/jobs/' || n, 'Co ' || g, 'Intern', 'waiting',
          now() - (g * interval '1 minute') + (n * interval '1 second') from generate_series(1, 31) g, generate_series(1, 25) n;`);
      const mine = "7b0f8f8e-6a43-4a49-9d2c-000000000031"; // queued longest ago: last in the global order
      const jobs = async (s: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(x.job_id order by x.job_id), '[]') from (${s}) x`));
      const global = await jobs(`select * from public.career_apply_prepare_candidates(now(), 25, 500) where user_id = '${mine}'`);
      const per = await jobs(`select * from public.career_apply_prepare_candidates_for('${mine}', now(), 25, 500)`);
      eq(global.length, 0, "the global read starves this person (the bug)");
      eq(per.length, 25, "the per-person read does not");
      const other = await jobs(`select * from public.career_apply_prepare_candidates_for('${mine}', now(), 25, 500) where user_id <> '${mine}'`);
      eq(other, [], "only this person's rows");
      eq(await jobs(`select * from public.career_apply_prepare_candidates_for('${mine}', now(), 3, 500)`).then((r) => r.length), 3, "p_per_person still applies");
      const ok = (role: string) => pg.sql(`select has_function_privilege('${role}', 'public.career_apply_prepare_candidates_for(uuid, timestamptz, integer, integer)', 'execute')`);
      eq([await ok("service_role"), await ok("anon"), await ok("authenticated")].map((s) => s.trim()), ["t", "f", "f"], "service_role only");
    } finally { await pg.stop(); }
  },
});
