// career-ingest, round 2 (2026-10-30), on a real Postgres 16 with the career schema (the flow harness: tests/flow/pg.ts)
// through the PostgREST double and the real supabase-js client, the way the deployed function talks to the database:
// 60 seeded multi-run sequences through the real scheduled handler (handler.ts), with fake board HTTP for every provider
// (tests/architect/scenarios/ingest-r2-world.ts). Every sequence: a few boards, several runs an hour apart, each run's
// boards answering with a changed list, the same list, an outage, a malformed body, 404 / 410 (a board that is gone), or a
// posting someone has queued to apply to taken down; some sequences run two lane runs at the same moment. After every run:
//   S1  each board read with its list has exactly that list open (no ghost, none lost); a failed read changed nothing
//   S2  a board answering 404 / 410 three reads in a row has every posting closed, its state says "[gone xN]"; a failing
//       board is not read inside its backoff (career_board_state_claim)
//   S3  first_seen_at never moves; every text Postgres was given it took (NUL, broken surrogates, emoji at the cut)
//   S4  the run's career_ingest_runs row is done, and its new / closed / failed counts are what changed in the table
//   S5  an application queued for a posting that closed is not sent (not_submitted, the reason says so)
//   S6  two lane runs at the same moment read each board once (the claim is one statement)
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/ingest-r2-pg.test.ts
// (needs Postgres 16 binaries; in CI it must run).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { boardFetchFeed, GONE_AFTER, supabasePostingsDb, type Board } from "../../supabase/functions/_shared/career_ingest.ts";
import { supabaseBoardState } from "../../supabase/functions/_shared/career_shards.ts";
import { handleIngest } from "../../supabase/functions/career-ingest/handler.ts";
import { fakeFetch, makeJob, PROVIDERS, rng, type Answer, type Job, type Net, type Provider } from "./scenarios/ingest-r2-world.ts";
import { expectedIds, T0, MIN } from "./scenarios/ingest-r2-generator.ts";

const CI = Deno.env.get("CI") === "true";
function ok(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)?.slice(0, 400)} !== ${JSON.stringify(b)?.slice(0, 400)}`);
const URL0 = "http://supabase.test", KEY = ["service", "test", "key"].join("-"), SECRET = () => "q".repeat(40);
const USER = "00000000-0000-4000-8000-00000000ab01";
const iso = (t: number) => new Date(t).toISOString();
const sorted = (xs: string[]) => [...xs].sort();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const waitMs = (f: number) => (f < 2 ? 0 : Math.min(24 * 3600000, 2 ** (f - 2) * 3600000));
const SEQUENCES = 60;

// The flow harness's cluster is SQL_ASCII, where length() counts bytes (production is UTF8, where it counts characters:
// checked 2026-10-30), so a description at the 20,000 cap with an emoji at its end is longer here than there. The
// in-memory battery covers the emoji at the cut; on this cluster the long description is ASCII.
const asciiAtCap = (j: Job): Job => (j.desc.length > 19000 ? { ...j, desc: j.desc.replace(/[^\x00-\x7f]/g, "e") } : j);
interface W { p: Provider; board: string; jobs: Job[]; removed: Job[]; next: number; mode: string; fails: number; gone: number; last: number | null }

Deno.test({
  name: `Ingest round 2 on Postgres: ${SEQUENCES} multi-run sequences through the scheduled handler (mirror, gone boards, backoff, first seen, run log, queued applications, two runs at once)`,
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg: Pg = await startPg();
    try {
      const double = postgrestDouble(pg, { url: URL0, serviceKey: KEY, users: {} });
      const admin = createClient(URL0, KEY, { auth: { persistSession: false }, global: { fetch: ((i: any, init?: any) => double.fetch(i instanceof Request && !init ? i : new Request(i, init))) as typeof fetch } });
      await pg.sql(`insert into auth.users(id,email) values ('${USER}','ingest-r2-pg@example.test'); insert into public.profiles(id) values ('${USER}') on conflict do nothing;`);
      const json = async <T>(sql: string): Promise<T> => JSON.parse((await pg.sql(`select coalesce(json_agg(x), '[]'::json) from (${sql}) x`)) || "[]");
      let totalRuns = 0, goneClosed = 0, appsClosed = 0, twoAtOnce = 0;
      for (let seq = 0; seq < SEQUENCES; seq++) {
        const r = rng(9100 + seq * 7919);
        await pg.sql("delete from public.career_board_state; delete from public.career_ingest_runs;");
        const net: Net = { calls: [], answer: new Map() };
        const feed = boardFetchFeed(fakeFetch(net, r), { stream: true, bodyHash: true, wholeMax: r.chance(0.5) ? 300 : 2_000_000 });
        const worlds: W[] = [];
        for (let i = 0, n = r.int(2, 4); i < n; i++) {
          const p = PROVIDERS[(seq + i * 3) % PROVIDERS.length];
          const board = p === "workday" ? `s${seq}b${i}.wd5/Careers` : `s${seq}b${i}`;
          worlds.push({ p, board, jobs: Array.from({ length: r.int(2, 30) }, (_, k) => asciiAtCap(makeJob(r, k, p))), removed: [], next: 100, mode: "list", fails: 0, gone: 0, last: null });
        }
        const directory: Board[] = worlds.map((w, i) => ({ company: `Seq ${seq} Co ${i}`, provider: w.p, board: w.board }));
        const key = (w: W) => `${w.p}:${w.board.toLowerCase()}`;
        const env: Record<string, string> = { CAREER_INGEST_SECRET: SECRET(), INGEST_CONTACT_EMAIL: "ops@example.test", INGEST_EVERY_MIN: "15", INGEST_CONCURRENCY: String(r.int(1, 6)) };
        const deps = (at: number) => ({ env: { get: (k: string) => env[k] }, boards: directory, now: () => at, db: () => supabasePostingsDb(admin), state: () => supabaseBoardState(admin), fetchFeed: () => feed });
        const firstSeen = new Map<string, string>();
        const runs = r.int(4, 7);
        for (let run = 0; run < runs; run++) {
          const at = T0 + seq * 30 * 86400000 + run * 61 * MIN;
          let queued: string | null = null;
          for (const w of worlds) {
            const m = run === 0 ? "list" : r.pick(["list", "add", "remove", "same", "reopen", "down", "bad", "gone", "gone", "gone", "takedown"] as const);
            w.mode = m === "takedown" ? "remove" : m;
            if (m === "add") w.jobs.push(...Array.from({ length: r.int(1, 4) }, () => asciiAtCap(makeJob(r, w.next += 7, w.p))));
            if ((m === "remove" || m === "takedown") && w.jobs.length) w.removed.push(...w.jobs.splice(r.int(0, w.jobs.length - 1), 1));
            if (m === "reopen" && w.removed.length) w.jobs.push(w.removed.shift()!);
            if (m === "takedown" && !queued) {
              // Someone approved an application to the posting just taken down; it waits in the queue.
              const gone = w.removed.at(-1)!;
              const id = expectedIds(w.p, w.board, [gone])[0];
              if (id && (await pg.sql(`select count(*) from career_postings where job_id = ${q(id)} and closed_at is null`)) === "1") {
                queued = id;
                await pg.sql(`alter table public.career_apply_jobs disable trigger user;
                  insert into public.career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state)
                  values ('${USER}', ${q(id)}, 'Co', 'https://example.test/apply/${seq}', '{}', repeat('c',64), repeat('c',64), 'queued');
                  alter table public.career_apply_jobs enable trigger user;`);
              }
            }
            const ans: Answer = w.mode === "down" ? r.pick([{ kind: "status", status: 503 }, { kind: "status", status: 429 }, { kind: "throw", error: "timed out after 15s" }] as Answer[])
              : w.mode === "gone" ? { kind: "status", status: r.pick([404, 410]) }
              : w.mode === "bad" ? { kind: "body", body: r.pick(["<html>Maintenance</html>", "{}", "null"]) }
              : { kind: "list", jobs: w.jobs };
            net.answer.set(key(w), ans);
          }
          const due = new Set(worlds.filter((w) => w.last === null || at - w.last >= waitMs(w.fails)).map(key));
          const before = new Map<string, string[]>();
          for (const w of worlds) before.set(key(w), (await json<{ job_id: string }[]>(`select job_id from career_postings where provider = ${q(w.p)} and board = ${q(w.board)} and closed_at is null`)).map((x) => x.job_id).sort());
          const known = new Set((await json<{ job_id: string }[]>(`select job_id from career_postings where board like 's${seq}b%'`)).map((x) => x.job_id));
          net.calls.length = 0;
          const two = r.chance(0.15);
          const post = () => new Request("https://fn.test/?lane=0&lanes=1&window_min=15", { method: "POST", headers: { "x-trainee-ingest-secret": SECRET() } });
          const res = two ? await Promise.all([handleIngest(post(), deps(at)), handleIngest(post(), deps(at + 1000))]) : [await handleIngest(post(), deps(at))];
          for (const x of res) ok(x.status === 200, `seq ${seq} run ${run}: ${x.status} ${await x.clone().text()}`);
          totalRuns += res.length; if (two) twoAtOnce++;
          // S6 / S2: each due board read once, none read inside its backoff.
          const reads = new Map<string, number>();
          for (const c of net.calls) reads.set(c.board, (reads.get(c.board) ?? 0) + 1); // one request a read but on the paged boards
          for (const w of worlds) {
            const k = key(w), wasRead = net.calls.some((c) => c.board === k);
            eq(wasRead, due.has(k), `seq ${seq} run ${run} ${k}: read exactly when due (fails ${w.fails})`);
            if (w.p !== "workday" && w.p !== "smartrecruiters") ok((reads.get(k) ?? 0) <= 1, `seq ${seq} run ${run} ${k}: read ${reads.get(k)} times in one tick`);
          }
          // S1 / S2: each board's postings.
          for (const w of worlds) {
            const k = key(w);
            const open = (await json<{ job_id: string }[]>(`select job_id from career_postings where provider = ${q(w.p)} and board = ${q(w.board)} and closed_at is null`)).map((x) => x.job_id).sort();
            if (!due.has(k)) { eq(open, before.get(k), `seq ${seq} run ${run} ${k}: not read, unchanged`); continue; }
            w.last = at;
            if (w.mode === "down" || w.mode === "bad") { w.fails++; w.gone = 0; eq(open, before.get(k), `seq ${seq} run ${run} ${k} ${w.mode}: a failed read closes nothing`); }
            else if (w.mode === "gone") {
              w.fails++; w.gone++;
              if (w.gone >= GONE_AFTER) { eq(open, [], `seq ${seq} run ${run} ${k}: gone ${w.gone} reads in a row, its postings closed`); if (before.get(k)!.length) goneClosed++; }
              else eq(open, before.get(k), `seq ${seq} run ${run} ${k}: gone ${w.gone}: not yet`);
              const st = await json<{ last_status: string }[]>(`select last_status from career_board_state where provider = ${q(w.p)} and board = ${q(w.board)}`);
              ok(st[0]?.last_status.includes(`[gone x${w.gone}]`), `seq ${seq} run ${run} ${k}: state ${st[0]?.last_status}`);
            } else {
              w.fails = 0; w.gone = 0;
              const want = sorted(expectedIds(w.p, w.board, w.jobs));
              if (JSON.stringify(open) !== JSON.stringify(want)) {
                const st = await json<{ last_status: string }[]>(`select last_status from career_board_state where provider = ${q(w.p)} and board = ${q(w.board)}`);
                eq(open, want, `seq ${seq} run ${run} ${k} ${w.mode} (board state: ${st[0]?.last_status}): exactly the board's list`);
              }
            }
            const st = await json<{ fail_count: number }[]>(`select fail_count from career_board_state where provider = ${q(w.p)} and board = ${q(w.board)}`);
            eq(st[0]?.fail_count, w.fails, `seq ${seq} run ${run} ${k}: failures in a row`);
          }
          // S3: first seen fixed, every row the table's.
          const rows = await json<{ job_id: string; first_seen_at: string; last_seen_at: string; closed_at: string | null }[]>(`select job_id, first_seen_at, last_seen_at, closed_at from career_postings where board like 's${seq}b%'`);
          for (const x of rows) {
            const f = firstSeen.get(x.job_id);
            if (f) eq(Date.parse(x.first_seen_at), Date.parse(f), `${x.job_id}: first seen moved`); else firstSeen.set(x.job_id, x.first_seen_at);
          }
          // S4: the log rows.
          const log = await json<{ status: string; postings_new: number; postings_closed: number; boards_failed: number; failures: unknown[] }[]>(`select status, postings_new, postings_closed, boards_failed, failures from career_ingest_runs where at in (${q(iso(at))}, ${q(iso(at + 1000))})`);
          eq(log.length, res.length, `seq ${seq} run ${run}: a row a lane run`);
          ok(log.every((x) => x.status === "done"), `seq ${seq} run ${run}: logged done`);
          const newRows = rows.filter((x) => !known.has(x.job_id)).length;
          const closedRows = rows.filter((x) => x.closed_at && [at, at + 1000].includes(Date.parse(x.closed_at))).length;
          eq(log.reduce((a, x) => a + x.postings_new, 0), newRows, `seq ${seq} run ${run}: new in the log`);
          eq(log.reduce((a, x) => a + x.postings_closed, 0), closedRows, `seq ${seq} run ${run}: closed in the log`);
          const failed = worlds.filter((w) => due.has(key(w)) && ["down", "bad", "gone"].includes(w.mode)).length;
          eq(log.reduce((a, x) => a + x.boards_failed, 0), failed, `seq ${seq} run ${run}: failed boards in the log`);
          eq(log.reduce((a, x) => a + x.failures.length, 0), failed, `seq ${seq} run ${run}: each failure listed`);
          // S5: the queued application to a posting taken down.
          if (queued) {
            const w = worlds.find((x) => queued!.startsWith(key(x) + ":"))!;
            const closed = due.has(key(w));
            const app = await json<{ state: string; reason: string | null }[]>(`select state, reason from career_apply_jobs where job_id = ${q(queued)}`);
            if (closed) { eq([app[0].state, app[0].reason], ["not_submitted", "not sent: the employer closed this posting before it was sent"], `${queued}: the queued application is not sent`); appsClosed++; }
            else eq(app[0].state, "queued", `${queued}: board not read: still waiting`);
          }
        }
      }
      console.log(`ingest r2 on Postgres: ${SEQUENCES} sequences, ${totalRuns} lane runs (${twoAtOnce} ticks with two runs at once), ${goneClosed} gone boards closed, ${appsClosed} queued applications not sent`);
      ok(goneClosed > 0 && appsClosed > 0 && twoAtOnce > 0, "the sequences reached gone boards, taken-down postings with queued applications, and two runs at once");
    } finally {
      await pg.stop();
    }
  },
});
