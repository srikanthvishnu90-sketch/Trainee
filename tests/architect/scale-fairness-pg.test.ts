// MASS APPLY at scale, the database half (20261102130000_career_apply_prepare_fair_claim.sql). Postgres 16 required: CI always;
// locally when the binaries are there and CI=true (the harness drops to the postgres account itself).
//   1. one person's 100 roles through the real door (career_apply_prepare_request_put: four parts of 25) next to 40 people with one
//      part each, six slots a tick, every running part finishing before the next tick: the heavy person never takes more than one
//      slot while others wait, and every light person starts within ceil(40 / 5) ticks (the old oldest-first order gave the heavy
//      person four of the first six slots and made the light ones wait behind all four parts);
//   2. nothing idles: with only the heavy person waiting, all four parts start in one tick;
//   3. tests/db/career_apply_prepare_fair_claim.test.sql, the SQL-level cases (limits, split, expiry, grants, rollback and re-apply).
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HEAVY = "7b0f8f8e-6a43-4a49-9d2c-000000000e01";
const light = (i: number) => `7b0f8f8e-6a43-4a49-9d2c-${String(1000 + i).padStart(12, "0")}`;

Deno.test({
  name: "pg: preparation is claimed in turns per person: 100 roles do not block 40 other people; nothing idles when alone",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: set CI=true (the harness runs the cluster as postgres)"); return; }
    const pg = await startPg({ includeBridge: true });
    try {
      const json = async (s: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(x), '[]') from (${s}) x`));
      await pg.sql(`insert into auth.users (id, email) select u, 'u' || right(u::text, 6) || '@example.test' from (
          select '${HEAVY}'::uuid u union all select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad((1000 + g)::text, 12, '0'))::uuid from generate_series(1, 40) g) s;
        insert into public.profiles (id) select id from auth.users where id::text like '7b0f8f8e-6a43-4a49-9d2c-%';
        insert into public.career_apply_wanted (user_id, posting_key, url, company, title)
        select '${HEAVY}', 'greenhouse:heavy:' || n, 'https://boards.greenhouse.io/heavy/jobs/' || n, 'Heavy Co', 'Intern' from generate_series(1, 100) n;`);
      // The real door: 100 roles in one ask become four parts of 25, all stamped before anyone else asks.
      const put = await json(`select public.career_apply_prepare_request_put('${HEAVY}', array(select 'greenhouse:heavy:' || n from generate_series(1, 100) n), null) as v`);
      eq(put[0].v.postings, 100);
      eq(put[0].v.requests.length, 4, "100 roles are four parts of 25");
      // Forty other people ask afterwards: one part each (3 postings).
      await pg.sql(`insert into public.career_apply_prepare_requests (user_id, job_ids, hosts)
        select ('7b0f8f8e-6a43-4a49-9d2c-' || lpad((1000 + g)::text, 12, '0'))::uuid, array['greenhouse:l' || g || ':1', 'greenhouse:l' || g || ':2', 'greenhouse:l' || g || ':3'],
          array['boards.greenhouse.io', 'boards.greenhouse.io', 'boards.greenhouse.io'] from generate_series(1, 40) g;`);

      const started = new Map<string, number>(); // person -> tick of the first start
      const heavyPerTick: number[] = [];
      for (let tick = 1; tick <= 12; tick++) {
        const got = await json(`select id, user_id from public.career_apply_prepare_request_claim(6, 6, null, null)`);
        for (const r of got) if (!started.has(r.user_id)) started.set(r.user_id, tick);
        heavyPerTick.push(got.filter((r: { user_id: string }) => r.user_id === HEAVY).length);
        // The tick's sandboxes finish, freeing every slot, before the next tick.
        await pg.sql(`update public.career_apply_prepare_requests set state = 'done', finished_at = now() where state = 'running'`);
      }
      const lightTicks = Array.from({ length: 40 }, (_, i) => started.get(light(i + 1)));
      assert(lightTicks.every((t) => t !== undefined), `every one of the 40 people started: ${JSON.stringify(lightTicks)}`);
      assert(Math.max(...(lightTicks as number[])) <= Math.ceil(40 / 5) + 1, `the last light person started by tick ${Math.max(...(lightTicks as number[]))}`);
      eq(heavyPerTick[0], 1, "the heavy person takes ONE of the first six slots (the old order gave them four)");
      assert(heavyPerTick.slice(0, 8).every((n) => n <= 1), `never more than one slot while others wait: ${heavyPerTick}`);
      assert(started.get(HEAVY) === 1, "and is not made to wait either: their first part runs in the first tick");
      eq((await json(`select count(*)::int as n from public.career_apply_prepare_requests where state = 'queued'`))[0].n, 0, "within 12 ticks the whole queue is served");

      // Alone, the heavy person gets every free slot.
      await pg.sql(`delete from public.career_apply_prepare_requests`);
      await pg.sql(`select public.career_apply_prepare_request_put('${HEAVY}', array(select 'greenhouse:heavy:' || n from generate_series(1, 100) n), null)`);
      eq((await json(`select id from public.career_apply_prepare_request_claim(6, 6, null, null)`)).length, 4, "alone: all four parts start in one tick");

      // The SQL-level cases, with the test helper schema the db runner's earlier files define.
      await pg.sql(`create schema if not exists t;
        create or replace function t.must_fail(sql text, pattern text, label text) returns void language plpgsql as $$ begin
          begin execute sql; exception when others then
            if sqlerrm !~* pattern then raise exception 'FAIL %: failed, but with "%" (wanted /%/)', label, sqlerrm, pattern; end if;
            raise notice 'ok   %', label; return; end;
          raise exception 'FAIL %: statement succeeded but had to fail', label; end $$;
        create or replace function t.ok(cond boolean, label text) returns void language plpgsql as $$ begin
          if cond is not true then raise exception 'FAIL %', label; end if; raise notice 'ok   %', label; end $$;`);
      await pg.sql(`delete from public.career_apply_prepare_requests`);
      const p = await new Deno.Command(`${pgBinDir()}/psql`, { args: ["-X", "-q", "-h", pg.host, "-p", String(pg.port), "-U", "postgres", "-d", "postgres",
        "-f", `${ROOT}/tests/db/career_apply_prepare_fair_claim.test.sql`], stdout: "piped", stderr: "piped" }).output();
      const err = new TextDecoder().decode(p.stderr), out = new TextDecoder().decode(p.stdout);
      assert(p.success, `${err}\n${out}`);
      assert((err.match(/ok {3}/g) ?? []).length >= 20, `the SQL cases ran and passed (${(err.match(/ok {3}/g) ?? []).length} ok lines)`);
      assert(!/FAIL/.test(err), err);
    } finally { await pg.stop(); }
  },
});
