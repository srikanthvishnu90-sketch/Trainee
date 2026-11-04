// The flow harness's pg.sql (tests/flow/pg.ts) answers over kept connections (tests/flow/pgwire.ts, statements split
// as psql splits them: tests/flow/psql-split.ts) instead of one psql process per call (2026-10-30, for CI time). This
// proves the two give the same answer: the same rows, the same error, the same autocommit and stop-at-the-first-error
// behaviour, nothing a call leaves on its session seen by the next call, and concurrent calls never queued behind one
// another (a held lock does not stall an unrelated call).
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { splitPsql } from "../flow/psql-split.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";

Deno.test("psql split: strings, quoted names, dollar bodies, comments and parentheses keep their semicolons; \\g /dev/null ends a silent statement; the unmodeled goes to psql", () => {
  const s = (t: string) => splitPsql(t)?.map((x) => [x.sql.trim(), x.devnull, x.line]) ?? null;
  eq(s("select 1; select 2"), [["select 1;", false, 1], ["select 2", false, 1]]);
  eq(s("select ';', \"a;b\", E'\\';' ;\nselect $$x;y$$, $q1$z;$q1$;"), [[`select ';', "a;b", E'\\';' ;`, false, 1], ["select $$x;y$$, $q1$z;$q1$;", false, 2]]);
  eq(s("-- a; comment\nselect /* b; /* nested; */ c */ 1;"), [["-- a; comment\nselect /* b; /* nested; */ c */ 1;", false, 2]]);
  eq(s("create rule r as on insert to t do (insert into u values (1); insert into u values (2));"), [["create rule r as on insert to t do (insert into u values (1); insert into u values (2));", false, 1]]);
  eq(s("begin;\nselect set_config('a', 'b', true) \\g /dev/null\nselect 2;\ncommit;"), [["begin;", false, 1], ["select set_config('a', 'b', true)", true, 2], ["select 2;", false, 3], ["commit;", false, 4]]);
  eq(s("select $1::int, 'it''s'"), [["select $1::int, 'it''s'", false, 1]]);
  eq(s("select 1; ;  -- trailing\n"), [["select 1;", false, 1]]);
  eq(s("select 1 \\gset"), null, "another meta-command: psql");
  eq(s("select :'DBNAME'"), null, "a psql variable: psql");
  eq(s("create function f() returns int begin atomic select 1; end"), null, "a SQL-standard body: psql");
  eq(s("copy t from stdin"), null, "COPY: psql");
  eq(s("select 'open"), null, "an unterminated string: psql reports it");
  const safe = (t: string) => splitPsql(t)!.every((x) => x.poolSafe);
  eq([safe("begin; set local role authenticated; select 1; commit;"), safe("set role service_role"), safe("set session_replication_role = replica"),
    safe("create temporary table x as select 1"), safe("select pg_advisory_lock(1)"), safe("select pg_advisory_xact_lock(1)"), safe("select set_config('a', 'b', false)")],
    [true, false, false, false, false, true, false]);
});

Deno.test({
  name: "pg.sql over kept connections answers exactly as psql does, and nothing a call leaves on its session reaches the next",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres"); return; }
    const pg = await startPg();
    const both = async (text: string) => {
      const one = async () => { try { return { out: await pg.sql(text) }; } catch (e) { return { err: (e as Error).message } }; };
      const wire = await one();
      Deno.env.set("FLOW_PG_PSQL", "1");
      try { return { wire, psql: await one() }; } finally { Deno.env.delete("FLOW_PG_PSQL"); }
    };
    try {
      await pg.sql("create table public.wire_t (id int primary key, v text, n numeric, j jsonb, b boolean, a int[])");
      const scripts = [
        "select 1",
        "select 1, 'two', null, true, 1.50::numeric, '{\"a\":[1,null]}'::jsonb, array[1,2]",
        "select x, x * 2 from generate_series(1, 4) x",
        "select null",
        "select '' union all select 'x' union all select ''",
        "select 1 where false",
        "insert into public.wire_t values (100, 'a|b', 1, '{}', false, '{1}') returning id, v",
        "select 'line one\nline two'",
        "begin; set local role authenticated; select current_user; commit;",
        "begin;\nselect set_config('request.jwt.claim.sub', 'u1', true) \\g /dev/null\nselect current_setting('request.jwt.claim.sub');\ncommit;",
        "select 1; select 2; select 3 where false; select 4",
        "do $$ begin raise notice 'hello; there'; end $$; select 'after'",
        // errors: the first error stops the script; what came before it in autocommit stays
        "insert into public.wire_t (id) values (1); insert into public.wire_t (id) values (1); insert into public.wire_t (id) values (2)",
        "select count(*) from public.wire_t where id in (1, 2)",
        "begin; insert into public.wire_t (id) values (3); select 1/0; commit;",
        "select count(*) from public.wire_t where id = 3",
        "select no_such_column from public.wire_t",
        "do $$ begin raise exception 'custom: %', 42 using detail = 'the detail', hint = 'the hint'; end $$",
        "insert into public.wire_t (id, v) values (7, null), (8, E'tab\\there'); select v from public.wire_t where id in (7, 8) order by id",
      ];
      // psql runs second each time, so a script that changes data is compared where it is idempotent; the inserts are
      // checked by the counts read after them. psql's LINE/caret lines under a syntax-position error are not reproduced
      // (every reader takes the first line: pg.ts rpc, postgrest.ts pgError).
      const norm = (r: { out?: string; err?: string }) => r.err === undefined ? r : { err: r.err.split("\n").filter((l) => !/^LINE \d+: /.test(l) && !/^\s*\^\s*$/.test(l)).join("\n") };
      for (const t of scripts) {
        const r = await both(t);
        if (/^insert into public.wire_t \(id, v\) values \(7/.test(t)) { eq(r.wire.out, "tab\there"); assertNode.ok(r.psql.err && /duplicate key/.test(r.psql.err)); continue; }
        if (/returning id, v/.test(t)) { eq(r.wire.out, "100|a|b"); assertNode.ok(r.psql.err && /duplicate key/.test(r.psql.err)); continue; }
        eq(norm(r.wire), norm(r.psql), t);
      }
      // Session state never leaks: a session-level setting, a temp table and a role are gone on the next call.
      await pg.sql("set statement_timeout = '1234ms'; create temporary table wire_tmp (x int); set role authenticated");
      eq(await pg.sql("select current_setting('statement_timeout'), current_user, to_regclass('pg_temp.wire_tmp') is null"), "0|postgres|t");
      // A failed transaction left open never reaches the next call.
      await pg.sql("begin; select 1/0").catch(() => {});
      eq(await pg.sql("select 'fresh'"), "fresh");
      // Concurrent calls are never queued behind one another: one holds a row lock while another call runs.
      await pg.sql("insert into public.wire_t (id) values (50)");
      const holder = pg.sql("begin; select id from public.wire_t where id = 50 for update; select pg_sleep(5); commit;").then(() => "holder");
      eq(await Promise.race([holder, pg.sql("select 'not queued'")]), "not queued", "an unrelated call did not wait for the one holding a lock");
      await holder;
    } finally {
      await pg.stop();
    }
  },
});
