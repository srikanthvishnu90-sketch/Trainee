// LIVE BUG (2026-11-06): career_apply_prepare_candidates(_for) inner-joined the 'career:account' row, so a person with no such row
// (34 of 37 live profiles) had no candidates and was told a wrong reason. A missing row is not paused; only paused = true stops it.
// Every person has the account row (backfill + AFTER INSERT trigger on profiles); the candidate reads also tolerate its absence.
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

Deno.test("every person has the account row: backfill and ensure never overwrite; the rollback leaves rows", () => {
  const sql = Deno.readTextFileSync(`${ROOT}/supabase/migrations/${F}`);
  eq(sql.split("on conflict (user_id, key) do nothing").length - 1, 2, "the ensure function and the backfill never overwrite");
  assert(!/create (constraint )?trigger/.test(sql), "no trigger on profiles (it breaks every test that inserts a profile and then its account row)");
  assert(/grant execute on function public\.career_account_row_ensure\(uuid\) to service_role;/.test(sql));
  const down = Deno.readTextFileSync(`${ROOT}/supabase/rollbacks/${F.replace(".sql", ".down.sql")}`);
  assert(/drop function if exists public\.career_account_row_ensure\(uuid\)/.test(down) && !/delete from public\.career_watch_kv/.test(down), "rollback drops the function only; rows stay");
});

Deno.test({
  name: "pg: backfill gives every profile the row (idempotent, never overwriting); a rowless person can keep a cloud resume and is a candidate; paused=true is not",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg({ includeBridge: true });
    try {
      const id = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-${String(n).padStart(12, "0")}`;
      const [none, paused, unpaused, late] = [id(901), id(902), id(903), id(904)];
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        select 'greenhouse:acct' || g || ':1', 'greenhouse', 'acct' || g, 'Acct Co ' || g, 'Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/acct' || g || '/jobs/1', 'x', now(), now()
        from generate_series(901, 904) g;
        insert into auth.users (id, email) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'a' || g || '@example.test' from generate_series(901, 904) g;
        insert into public.profiles (id) select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid from generate_series(901, 904) g;
        insert into public.career_watch_kv (user_id, key, value) values
          ('${paused}', 'career:account', '{"epoch":2,"version":5,"paused":true}'),
          ('${unpaused}', 'career:account', '{"epoch":2,"version":5,"paused":false}');
        insert into public.career_apply_wanted (user_id, posting_key, url, company, title, state, queued_at)
        select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad(g::text, 12, '0'))::uuid, 'greenhouse:acct' || g || ':1', 'https://boards.greenhouse.io/acct' || g || '/jobs/1', 'Acct Co ' || g, 'Analyst', 'waiting', now()
        from generate_series(901, 904) g;`);
      const rows = async (s: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(x order by x.user_id), '[]') from (${s}) x`));
      const acct = (u: string) => rows(`select user_id, value from public.career_watch_kv where user_id = '${u}' and key = 'career:account'`);
      const raised = async (q: string) => { let m = ""; await pg.sql(q).catch((e) => { m = String(e.message); }); return m; };
      eq((await acct(none)).length, 0, "setup: two people have no account row");
      // (A) rowless: both candidate reads see them (defense in depth), epoch/version 0; paused=true is none.
      const g0 = await rows(`select user_id, epoch, version from public.career_apply_prepare_candidates(now(), 25, 500) where user_id::text like '7b0f8f8e-6a43-4a49-9d2c-0000000009%'`);
      eq(g0.map((r: any) => r.user_id), [none, unpaused, late], "global read: rowless and paused=false are candidates; paused=true is not");
      eq([g0[0].epoch, g0[0].version, g0[1].epoch, g0[1].version], [0, 0, 2, 5]);
      for (const [u, n] of [[none, 1], [paused, 0], [unpaused, 1]] as const) {
        eq((await rows(`select * from public.career_apply_prepare_candidates_for('${u}', now(), 25, 500)`)).length, n, `per-person read for ${u}`);
      }
      // (B) the backfill (applied twice) gives the rowless people the row and never touches the others.
      const mig = Deno.readTextFileSync(`${ROOT}/supabase/migrations/${F}`);
      await pg.sql(mig); await pg.sql(mig);
      const v = (await acct(none))[0].value;
      eq([v.version, v.epoch], [0, 0], "backfilled with {version 0, epoch 0}");
      eq((await rows(`select user_id from public.career_watch_kv where key = 'career:account' and user_id = '${none}'`)).length, 1, "once, not twice");
      eq((await acct(paused))[0].value.paused, true, "an existing row is never overwritten");
      eq([(await acct(unpaused))[0].value.epoch, (await acct(unpaused))[0].value.version], [2, 5]);
      // (C) a formerly rowless person keeps a cloud resume and reads it back.
      await pg.sql(`select public.career_apply_cloud_resume_put_for('${none}', 'r.pdf', 'aGVsbG8=')`);
      eq((await pg.sql(`select public.career_apply_cloud_resume_kept_for('${none}')->>'filename'`)).trim(), "r.pdf");
      // (D) a person with no row (created after the backfill): the cloud resume door ensures the row instead of raising no_account.
      await pg.sql(`delete from public.career_watch_kv where user_id = '${late}' and key = 'career:account'`);
      eq(await raised(`select public.career_apply_cloud_resume_put_for('${late}', 'l.pdf', 'aGVsbG8=')`), "", "no no_account for a person who exists");
      eq((await pg.sql(`select public.career_apply_cloud_resume_kept_for('${late}')->>'filename'`)).trim(), "l.pdf");
      eq((await acct(late)).length, 1);
      // (E) the one resume door keeps the cloud copy for a rowless person too (it deleted it before).
      const hex = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
      await pg.sql(`delete from public.career_watch_kv where user_id = '${none}' and key = 'career:account'; delete from public.career_apply_cloud_resumes where user_id = '${none}'`);
      eq(await raised(`select public.career_resume_put('${none}', '${hex}', 'file', 'ref', 'r2.pdf', convert_to('hello', 'UTF8'), 'evt-1')`), "");
      eq((await pg.sql(`select public.career_apply_cloud_resume_kept_for('${none}')->>'filename'`)).trim(), "r2.pdf", "the one door kept the cloud copy");
      // (F) defense in depth: with the row removed again the reads still treat the person as not paused.
      await pg.sql(`delete from public.career_watch_kv where user_id = '${unpaused}' and key = 'career:account'`);
      const g2 = await rows(`select user_id, epoch, version from public.career_apply_prepare_candidates(now(), 25, 500) where user_id = '${unpaused}'`);
      eq([g2.length, g2[0]?.epoch, g2[0]?.version], [1, 0, 0]);
    } finally { await pg.stop(); }
  },
});
