// career-ingest's re-read gap (2026-10-31) on a real Postgres 16 with the career schema (tests/flow/pg.ts):
//   P1  career_board_state_claim (20261030150000_career_ingest_reread_gap.sql) and career_shards.ts memoryBoardState.claim
//       (claimable: backoff, in flight, the gap) take the same boards in the same order and mark them the same, over 500
//       seeded board tables (every status, failures 0..40, attempts never / long ago / at each rule's edge / in the future)
//       and gaps (none, under the in-flight 5 minutes, the plan's 10 minutes, an hour); the 3-argument form is the same
//       claim with DEFAULT_REREAD_GAP_MS. The two can no longer drift apart unnoticed.
//   P2  through the deployed path (supabaseBoardState over the PostgREST double and supabase-js): two claims of one lane
//       back to back with the first run's outcomes recorded in between take disjoint boards (CI run 41146111368); the
//       boards come back once the gap has passed; without the 4-argument form (before the migration) the 3-argument form
//       is called.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/ingest-reread-gap-pg.test.ts
// (needs Postgres 16 binaries; in CI it must run).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { boardKey, DEFAULT_REREAD_GAP_MS, IN_FLIGHT_MS, memoryBoardState, retryAfterMs, supabaseBoardState, type BoardState } from "../../supabase/functions/_shared/career_shards.ts";
import { rng } from "./scenarios/ingest-r2-world.ts";

const CI = Deno.env.get("CI") === "true";
function ok(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)?.slice(0, 600)} !== ${JSON.stringify(b)?.slice(0, 600)}`);
const MIN = 60000, H = 3600000;
const NOW0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const iso = (t: number) => new Date(t).toISOString();
const lit = (v: string | number | null) => (v === null ? "null" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const PROVIDERS = ["greenhouse", "lever", "ashby", "smartrecruiters"] as const;
const STATUSES = [null, "ok", "reading", "not_modified", "failed: HTTP 429", "failed: HTTP 404 [gone x2]", "partial: next part from 100"];
const CASES = 500;

async function seedRows(pg: Pg, rows: BoardState[]) {
  await pg.sql("delete from public.career_board_state;");
  if (!rows.length) return;
  await pg.sql(`insert into public.career_board_state(provider,board,bucket,last_attempt_at,last_ok_at,last_status,fail_count) values ${rows
    .map((s) => `(${lit(s.provider)},${lit(s.board)},${s.bucket},${lit(s.last_attempt_at)},${lit(s.last_ok_at)},${lit(s.last_status)},${s.fail_count})`).join(",")};`);
}

Deno.test({
  name: `the re-read gap on Postgres: the SQL claim and career_shards.ts take the same boards (${CASES} seeded tables); two claims back to back take disjoint boards`,
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg: Pg = await startPg();
    try {
      const svc = pg.asService();
      const json = async <T>(sql: string): Promise<T> => JSON.parse((await pg.sql(`select coalesce(json_agg(x), '[]'::json) from (${sql}) x`)) || "[]");
      // ------------------------------------------------------------------ P1
      let taken = 0, heldByGap = 0, threeArg = 0;
      for (let c = 0; c < CASES; c++) {
        const r = rng(31000 + c * 7907);
        const now = NOW0 + c * 86400000 + r.int(0, 999);
        const gap = r.pick([0, 0, 2 * MIN + 30000, DEFAULT_REREAD_GAP_MS, DEFAULT_REREAD_GAP_MS, H, r.int(1, 120) * MIN]);
        const rows: BoardState[] = [];
        for (let i = 0, n = r.int(0, 24); i < n; i++) {
          const fail = r.pick([0, 0, 0, 1, 2, 3, 5, 9, 40]);
          // The attempt: never, long ago, anywhere in the last day, or at the edge of one of the rules (the gap, the
          // 5 minutes in flight, the backoff), a millisecond either side; or ahead of the clock.
          const edge = r.pick([gap, IN_FLIGHT_MS, retryAfterMs(fail), 0]);
          const at = r.chance(0.12) ? null : r.pick([now - 40 * H, now - r.int(0, 24 * 60) * MIN - r.int(0, 59999), now - edge + r.pick([-1, 0, 1]), now + r.int(1, 30) * 1000, now - r.int(0, 30) * MIN]);
          const status = at === null ? null : r.pick(STATUSES);
          rows.push({ provider: r.pick(PROVIDERS), board: `c${c}b${i}`, bucket: r.int(0, 3), last_attempt_at: at === null ? null : iso(at), last_ok_at: null, last_status: status,
            etag: null, last_modified: null, fail_count: at === null ? 0 : fail, body_sha: null });
        }
        const buckets = r.pick([[0], [0, 1], [1, 2, 3], [0, 1, 2, 3], [3]]);
        const limit = r.pick([1, 2, 3, 5, 10, 30]);
        const useThree = c % 5 === 4;
        await seedRows(pg, rows);
        const mem = memoryBoardState();
        for (const s of rows) mem.rows.set(boardKey(s), { ...s });
        const sql = useThree
          ? await svc.rpc("career_board_state_claim", { p_buckets: buckets, p_limit: limit, p_now: iso(now) })
          : await svc.rpc("career_board_state_claim", { p_buckets: buckets, p_limit: limit, p_now: iso(now), p_reread_gap_ms: gap });
        ok(!sql.error, `case ${c}: ${sql.error?.message}`);
        const got = useThree ? await mem.claim!(buckets, limit, iso(now)) : await mem.claim!(buckets, limit, iso(now), gap);
        const keys = (xs: BoardState[]) => xs.map((s) => `${s.provider}:${s.board}`);
        eq(keys(sql.data as BoardState[]), keys(got!), `case ${c} (gap ${useThree ? "3-argument form" : gap / MIN + " min"}, limit ${limit}, buckets ${buckets}): the same boards in the same order`);
        // The rows came back as they were, and are marked the same way in both stores.
        for (const s of sql.data as BoardState[]) {
          const was = rows.find((x) => x.provider === s.provider && x.board === s.board)!;
          eq([s.last_status, s.fail_count, s.last_attempt_at === null ? null : Date.parse(s.last_attempt_at)], [was.last_status, was.fail_count, was.last_attempt_at === null ? null : Date.parse(was.last_attempt_at)], `case ${c} ${s.board}: returned as it was`);
        }
        const after = await json<{ provider: string; board: string; last_attempt_at: string | null; last_status: string | null }[]>("select provider, board, last_attempt_at, last_status from public.career_board_state order by provider, board");
        for (const a of after) {
          const m = mem.rows.get(boardKey(a))!;
          eq([a.last_status, a.last_attempt_at === null ? null : Date.parse(a.last_attempt_at)], [m.last_status, m.last_attempt_at === null ? null : Date.parse(m.last_attempt_at)], `case ${c} ${a.board}: marked the same`);
        }
        taken += got!.length;
        if (useThree) threeArg++;
        const effGap = useThree ? DEFAULT_REREAD_GAP_MS : gap;
        heldByGap += rows.filter((s) => buckets.includes(s.bucket) && s.last_attempt_at && now - Date.parse(s.last_attempt_at) < effGap && s.last_status !== "reading" && (s.fail_count < 2)).length;
      }
      console.log(`re-read gap on Postgres: ${CASES} tables, ${taken} boards claimed alike, ${heldByGap} held back by the gap alone, ${threeArg} through the 3-argument form`);
      ok(taken > 500 && heldByGap > 100, "the tables reached claims and boards the gap holds back");

      // ------------------------------------------------------------------ P2
      const KEY = ["service", "test", "key"].join("-"), URL0 = "http://supabase.test";
      const double = postgrestDouble(pg, { url: URL0, serviceKey: KEY, users: {} });
      const admin = createClient(URL0, KEY, { auth: { persistSession: false }, global: { fetch: ((i: any, init?: any) => double.fetch(i instanceof Request && !init ? i : new Request(i, init))) as typeof fetch } });
      for (let c = 0; c < 20; c++) {
        const r = rng(52000 + c);
        await pg.sql("delete from public.career_board_state;");
        const st = supabaseBoardState(admin);
        const n = r.int(2, 12), limit = r.int(1, n + 2), gap = r.pick([DEFAULT_REREAD_GAP_MS, H, 5 * MIN]);
        await st.seed(Array.from({ length: n }, (_, i) => ({ company: `Co ${i}`, provider: r.pick(PROVIDERS), board: `p${c}b${i}` })));
        const lane = Array.from({ length: 64 }, (_, b) => b);
        const t = NOW0 + c * 86400000;
        const a = (await st.claim!(lane, limit, iso(t), gap))!;
        ok(a.length === Math.min(n, limit), `pg ${c}: the first claim takes ${Math.min(n, limit)}, took ${a.length}`);
        // The first run finished: its outcomes recorded (ok, one failure, a 404) before the second run claims.
        await st.record(a.map((s) => ({ ...s, last_attempt_at: iso(t), last_ok_at: iso(t), last_status: r.pick(["ok", "not_modified", "failed: HTTP 429", "failed: HTTP 404 [gone x1]"]), fail_count: r.pick([0, 0, 1]) })));
        const b = (await st.claim!(lane, limit, iso(t + r.int(0, 3000)), gap))!;
        const ak = new Set(a.map(boardKey));
        ok(b.every((s) => !ak.has(boardKey(s))), `pg ${c}: the second claim took a board the first had just read: ${b.map(boardKey).filter((k) => ak.has(k))}`);
        eq(b.length, Math.min(n - a.length, limit), `pg ${c}: the second claim takes the boards the first left`);
        await st.record(b.map((s) => ({ ...s, last_attempt_at: iso(t), last_status: "ok", fail_count: 0 })));
        // A second before the gap: only the boards neither run took; at the gap, the two runs' boards again.
        const read = new Set([...a, ...b].map(boardKey));
        const before = (await st.claim!(lane, n, iso(t + gap - 1000), gap))!;
        eq(before.map(boardKey).filter((k) => read.has(k)), [], `pg ${c}: a second before the gap, none of the boards just read`);
        eq(before.length, n - read.size, `pg ${c}: a second before the gap, the boards never read`);
        await st.record(before.map((s) => ({ ...s, last_attempt_at: iso(t + gap - 1000), last_status: "ok", fail_count: 0 })));
        eq((await st.claim!(lane, n, iso(t + gap), gap))!.map(boardKey).sort(), [...read].sort(), `pg ${c}: at the gap the two runs' boards are due again`);
      }
      // Before the migration (no 4-argument form): the 3-argument claim is called and still claims in one statement.
      await pg.sql("alter function public.career_board_state_claim(integer[], integer, timestamptz, integer) rename to career_board_state_claim_x;");
      try {
        await pg.sql("delete from public.career_board_state;");
        const st = supabaseBoardState(admin);
        await st.seed([{ company: "A", provider: "lever", board: "fallback0" }]);
        const got = await st.claim!(Array.from({ length: 64 }, (_, b) => b), 5, iso(NOW0), H);
        ok(got === null, "with neither form callable the store says it cannot claim (the handler then takes due() and records)");
      } finally {
        await pg.sql("alter function public.career_board_state_claim_x(integer[], integer, timestamptz, integer) rename to career_board_state_claim;");
      }
    } finally {
      await pg.stop();
    }
  },
});
