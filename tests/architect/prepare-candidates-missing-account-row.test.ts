// LIVE BUG (2026-11-06): career_apply_prepare_candidates(_for) inner-joined the 'career:account' row, so a person with no such row
// (34 of 37 live profiles) had no candidates and was told a wrong reason. A missing row is not paused; only paused = true stops it.
//   unit: the migration reads the pause as a not-exists on a row saying paused = true, in both functions, and the rollback restores the join.
//   pg (needs Postgres 16; runs in CI and wherever initdb is available): no row -> candidate; paused true -> none; paused false -> candidate.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const F = "20261106120000_career_apply_candidates_missing_account_row.sql";

Deno.test("missing account row: the migration, its rollback and the go-live list agree", () => {
  const sql = Deno.readTextFileSync(`${ROOT}/supabase/migrations/${F}`);
  const pause = "not exists (select from public.career_watch_kv pk where pk.user_id = a.user_id and pk.key = 'career:account' and coalesce(pk.value->>'paused', 'false') = 'true')";
  eq(sql.split(pause).length - 1, 2, "both reads treat only paused = true as paused");
  assert(!/<> 'true'/.test(sql), "no inner join on a not-paused row remains");
  for (const sig of ["(timestamptz, integer, integer)", "(uuid, timestamptz, integer, integer)"]) {
    assert(sql.includes(`grant execute on function public.career_apply_prepare_candidates${sig.startsWith("(uuid") ? "_for" : ""}${sig} to service_role;`));
  }
  const down = Deno.readTextFileSync(`${ROOT}/supabase/rollbacks/${F.replace(".sql", ".down.sql")}`);
  eq(down.split("<> 'true'").length - 1, 2, "the rollback restores both bodies");
  assert(Deno.readTextFileSync(`${ROOT}/scripts/launch/trainee-go-live.sh`).includes(`  ${F}\n`));
});

Deno.test({
  name: "pg: no account row is a candidate; paused true is none; paused false is a candidate (both reads)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg({ includeBridge: true });
    try {
      const id = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-${String(n).padStart(12, "0")}`;
      const [none, paused, unpaused] = [id(901), id(902), id(903)];
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        select 'greenhouse:acct' || g || ':1', 'greenhouse', 'acct' || g, 'Acct Co ' || g, 'Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/acct' || g || '/jobs/1', 'x', now(), now()
        from generate_series(901, 903) g;
        insert into auth.users (id, email) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'a' || g || '@example.test' from generate_series(901, 903) g;
        insert into public.profiles (id) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid from generate_series(901, 903) g;
        insert into public.career_watch_kv (user_id, key, value) values
          ('${paused}', 'career:account', '{"epoch":2,"version":5,"paused":true}'),
          ('${unpaused}', 'career:account', '{"epoch":2,"version":5,"paused":false}');
        insert into public.career_apply_wanted (user_id, posting_key, url, company, title, state, queued_at)
        select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'greenhouse:acct' || g || ':1', 'https://boards.greenhouse.io/acct' || g || '/jobs/1', 'Acct Co ' || g, 'Analyst', 'waiting', now()
        from generate_series(901, 903) g;`);
      const rows = async (s: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(x order by x.user_id), '[]') from (${s}) x`));
      const global = await rows(`select user_id, epoch, version from public.career_apply_prepare_candidates(now(), 25, 500) where user_id::text like '7b0f8f8e-6a43-4a49-9d2c-0000000009%'`);
      eq(global.map((r: any) => r.user_id), [none, unpaused], "global read: no row and paused=false are candidates; paused=true is not");
      eq([global[0].epoch, global[0].version], [0, 0], "a missing row reads as epoch 0, version 0");
      eq([global[1].epoch, global[1].version], [2, 5], "an existing row's epoch and version are unchanged");
      for (const [u, n] of [[none, 1], [paused, 0], [unpaused, 1]] as const) {
        eq((await rows(`select * from public.career_apply_prepare_candidates_for('${u}', now(), 25, 500)`)).length, n, `per-person read for ${u}`);
      }
    } finally { await pg.stop(); }
  },
});
