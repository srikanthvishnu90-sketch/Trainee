// career-ingest, round 3 (2026-11-03), on a real Postgres 16 with the career schema (the flow harness: tests/flow/pg.ts)
// through the PostgREST double and the real supabase-js client, the way the deployed function talks to the database:
// seeded sequences through the real scheduled handler (handler.ts) with fake board HTTP for every provider
// (tests/architect/scenarios/ingest-r3-generator.ts netFetch; no network). Every sequence, on the table itself:
//   Q1  titles, places and descriptions with tags, entities and script blocks are stored as plain text; a posted date
//       ahead of the read or from 1970 is stored as none
//   Q2  an id the board gives to another job: the row is the new job (first seen now, open), and the application queued
//       for the old job is not sent (career_apply_jobs not_submitted, the reason the close trigger writes)
//   Q3  a board answering 200 with an empty list: its postings and the application queued for one stay open and queued
//       for EMPTY_AFTER - 1 reads (career_board_state says "ok [empty xN]"), and close on the EMPTY_AFTER-th
//   Q4  a Workday board whose total says fewer than it lists: read to its last page, its postings exactly
//   Q5  a Workday board past one read's pages, read in parts under ?posting_budget= (career_board_state pass_offset,
//       "[seen marked]"); the next pass closes exactly what it took down
//   Q6  every lane run's career_ingest_runs row is done
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/ingest-r3-pg.test.ts
// (needs Postgres 16 binaries; in CI it must run).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg, type Pg } from "../flow/pg.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { boardFetchFeed, EMPTY_AFTER, supabasePostingsDb, type Board } from "../../supabase/functions/_shared/career_ingest.ts";
import { supabaseBoardState } from "../../supabase/functions/_shared/career_shards.ts";
import { handleIngest } from "../../supabase/functions/career-ingest/handler.ts";
import { atsId, rng } from "./scenarios/ingest-r2-world.ts";
import { dress, netFetch, type Listing, type Net } from "./scenarios/ingest-r3-generator.ts";

const CI = Deno.env.get("CI") === "true";
function ok(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)?.slice(0, 400)} !== ${JSON.stringify(b)?.slice(0, 400)}`);
const URL0 = "http://supabase.test", KEY = ["service", "test", "key"].join("-"), SECRET = () => "r".repeat(40);
const USER = "00000000-0000-4000-8000-00000000ab03";
const T0 = Date.UTC(2026, 10, 3, 9, 7), MIN = 60000, H = 3600000, DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const SEQUENCES = 16;
const PLAIN = ["Senior Data Analyst", "R&D Lab Technician", "Ingénieur Logiciel", "Pharmacy Technician", "Registered Nurse - ICU", "Forklift Operator"];
const CLOSED_REASON = "not sent: the employer closed this posting before it was sent";

Deno.test({
  name: `Ingest round 3 on Postgres: ${SEQUENCES} sequences through the scheduled handler (plain text, dates, an id given to another job, empty lists, a lying total, a board read in parts)`,
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg: Pg = await startPg();
    try {
      const double = postgrestDouble(pg, { url: URL0, serviceKey: KEY, users: {} });
      const admin = createClient(URL0, KEY, { auth: { persistSession: false }, global: { fetch: ((i: any, init?: any) => double.fetch(i instanceof Request && !init ? i : new Request(i, init))) as typeof fetch } });
      await pg.sql(`insert into auth.users(id,email) values ('${USER}','ingest-r3-pg@example.test'); insert into public.profiles(id) values ('${USER}') on conflict do nothing;`);
      const json = async <T>(sql: string): Promise<T> => JSON.parse((await pg.sql(`select coalesce(json_agg(x), '[]'::json) from (${sql}) x`)) || "[]");
      const queue = async (jobId: string, n: number) => pg.sql(`alter table public.career_apply_jobs disable trigger user;
        insert into public.career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state)
        values ('${USER}', ${q(jobId)}, 'Co', 'https://example.test/apply/${n}', '{}', repeat('d',64), repeat('d',64), 'queued');
        alter table public.career_apply_jobs enable trigger user;`);
      const app = async (jobId: string) => (await json<{ state: string; reason: string | null }[]>(`select state, reason from career_apply_jobs where job_id = ${q(jobId)} order by created_at desc limit 1`))[0];
      const row = async (jobId: string) => (await json<{ title: string; location: string; description: string; posted_at: string | null; first_seen_at: string; closed_at: string | null }[]>(`select title, location, description, posted_at, first_seen_at, closed_at from career_postings where job_id = ${q(jobId)}`))[0];
      const openOf = async (p: string, b: string) => (await json<{ job_id: string }[]>(`select job_id from career_postings where provider = ${q(p)} and board = ${q(b)} and closed_at is null order by job_id`)).map((x) => x.job_id);
      const status = async (p: string, b: string) => (await json<{ last_status: string; pass_offset: number }[]>(`select last_status, pass_offset from career_board_state where provider = ${q(p)} and board = ${q(b)}`))[0];
      let replacedApps = 0, heldApps = 0, parts = 0;
      for (let seq = 0; seq < SEQUENCES; seq++) {
        const r = rng(31000 + seq * 7907);
        await pg.sql("delete from public.career_board_state; delete from public.career_ingest_runs;");
        const net: Net = { srv: new Map(), calls: [] };
        const feed = boardFetchFeed(netFetch(net, r), { stream: true, bodyHash: true, wholeMax: r.chance(0.5) ? 400 : 2_000_000 });
        const one = (["greenhouse", "lever", "ashby", "workable", "teamtailor", "personio"] as const)[seq % 6];
        const A = { p: one as string, board: `r3s${seq}a` }, E = { p: (["lever", "greenhouse", "breezy", "recruitee"] as const)[seq % 4] as string, board: `r3s${seq}e` };
        const L = { p: "workday", board: `r3s${seq}l.wd5/Careers` }, P = { p: "workday", board: `r3s${seq}p.wd3/External` };
        const id = (w: { p: string; board: string }, n: number) => `${w.p}:${w.board.toLowerCase()}:${atsId(w.p as any, n)}`;
        const key = (w: { p: string; board: string }) => `${w.p}:${w.board.toLowerCase()}`;
        // Board A: dressed text, dates ahead and from 1970. Board E: plain. Board L: a lying total. Board P: 1,100+ postings.
        const plainA = Array.from({ length: r.int(3, 6) }, (_, n) => `${r.pick(PLAIN)} ${n}`);
        const listA: Listing[] = plainA.map((t, n) => ({ n, title: dress(t, r, n), loc: dress("Austin, TX", r, n, { html: one !== "teamtailor" && one !== "personio" }), dept: "Ops",
          desc: `<p>Stock shelves &amp; help customers.</p><script>var PWNED_${n}=1;</script><p>Pay: $100,000&ndash;$120,000 per year.</p>`,
          posted: n === 0 ? (one === "lever" ? T0 + 30 * DAY : iso(T0 + 30 * DAY)) : n === 1 ? (one === "lever" ? 1_700_000_000 : "1970-01-20T00:00:00Z") : (one === "lever" ? T0 - 3 * DAY : iso(T0 - 3 * DAY)) }));
        const listE: Listing[] = Array.from({ length: r.int(2, 8) }, (_, n) => ({ n, title: `Barista ${n}`, loc: "Austin, TX", desc: "Plain.", dept: "Ops" }));
        const listL: Listing[] = Array.from({ length: r.int(45, 95) }, (_, n) => ({ n, title: `Store Associate ${n}`, loc: "Austin, TX", desc: "", dept: "" }));
        let listP: Listing[] = Array.from({ length: r.int(1050, 1300) }, (_, n) => ({ n, title: `Cashier ${n}`, loc: "US Remote", desc: "", dept: "" }));
        net.srv.set(key(A), { list: listA }); net.srv.set(key(E), { list: listE });
        net.srv.set(key(L), { list: listL, mode: "total_low", lie: r.int(5, 30) }); net.srv.set(key(P), { list: listP });
        const directory: Board[] = [A, E, L, P].map((w, i) => ({ company: `Seq ${seq} Co ${i}`, provider: w.p, board: w.board }));
        const env: Record<string, string> = { CAREER_INGEST_SECRET: SECRET(), INGEST_CONTACT_EMAIL: "ops@example.test", INGEST_EVERY_MIN: "15", INGEST_CONCURRENCY: String(r.int(1, 4)) };
        const deps = (at: number) => ({ env: { get: (k: string) => env[k] }, boards: directory, now: () => at, db: () => supabasePostingsDb(admin), state: () => supabaseBoardState(admin), fetchFeed: () => feed });
        const BUDGET = 700;
        const run = async (at: number) => {
          const res = await handleIngest(new Request(`https://fn.test/?lane=0&lanes=1&window_min=15&posting_budget=${BUDGET}`, { method: "POST", headers: { "x-trainee-ingest-secret": SECRET() } }), deps(at));
          ok(res.status === 200, `seq ${seq}: ${res.status} ${await res.clone().text()}`);
          const log = await json<{ status: string }[]>(`select status from career_ingest_runs where at = ${q(iso(at))}`);
          eq(log.map((x) => x.status), ["done"], `seq ${seq} ${iso(at)}: Q6 the run's row`);
        };
        // Runs an hour apart until board P's first pass is over (a run reads at most its posting budget).
        let at = T0, guard = 0;
        do { await run(at); at += 61 * MIN; parts++; } while ((await status(P.p, P.board)).pass_offset > 0 && ++guard < 10);
        ok(guard < 10, `seq ${seq}: P's pass ends`);
        // Q1
        for (let n = 0; n < plainA.length; n++) {
          const x = await row(id(A, n));
          ok(x, `${id(A, n)} stored`);
          eq(x.title, plainA[n], `Q1 ${id(A, n)}: the title as plain text`);
          eq(x.location, "Austin, TX", `Q1 ${id(A, n)}: the place as plain text`);
          ok(!/PWNED|<script|&ndash;|&amp;/.test(x.description) && x.description.includes("$100,000–$120,000"), `Q1 ${id(A, n)}: the description as plain text: ${x.description}`);
          if (n < 2) eq(x.posted_at, null, `Q1 ${id(A, n)}: a posted date ${n === 0 ? "a month ahead" : "from 1970"} is no date`);
          else ok(x.posted_at && Math.abs(Date.parse(x.posted_at) - (T0 - 3 * DAY)) < 1000, `Q1 ${id(A, n)}: a true date kept`);
        }
        // Q4
        eq(await openOf(L.p, L.board), listL.map((l) => id(L, l.n)).sort(), "Q4 a total that says fewer: every posting listed, read");
        // Q5: P read in parts, every posting stored.
        eq((await openOf(P.p, P.board)).length, listP.length, `Q5 ${listP.length} postings over ${guard + 1} runs`);
        // Q2: an application queued for A's job 2, then the board gives job 2's id to another job.
        await queue(id(A, 2), seq * 10 + 1);
        listA[2] = { ...listA[2], title: "Accountant" };
        // Q3: an application queued for E's job 0; E answers empty from now on.
        await queue(id(E, 0), seq * 10 + 2);
        net.srv.set(key(E), { list: [], etag: r.chance(0.5) });
        // P: some taken down; its next pass closes exactly those.
        const down = new Set(Array.from({ length: r.int(1, 8) }, () => r.int(0, listP.length - 1)));
        listP = listP.filter((l) => !down.has(l.n));
        net.srv.set(key(P), { list: listP });
        at += 6 * H; // past the touch interval: the next pass is a new one
        const runAt = at;
        for (let k = 1; k <= EMPTY_AFTER; k++) {
          await run(at);
          if (k === 1) {
            const x = await row(id(A, 2));
            eq([x.title, x.first_seen_at && iso(Date.parse(x.first_seen_at)), x.closed_at], ["Accountant", iso(runAt), null], "Q2 another job under the old id: the new job, first seen now, open");
            eq(await app(id(A, 2)), { state: "not_submitted", reason: CLOSED_REASON }, "Q2 the application queued for the old job is not sent");
            replacedApps++;
          }
          const eOpen = await openOf(E.p, E.board), st = await status(E.p, E.board);
          eq(st.last_status, `ok [empty x${k}]`, `Q3 empty read ${k}: counted in the board's state`);
          if (k < EMPTY_AFTER) {
            eq(eOpen.length, listE.length, `Q3 empty read ${k}: held, nothing closed`);
            eq((await app(id(E, 0))).state, "queued", `Q3 empty read ${k}: the application still waits`);
            heldApps++;
          } else {
            eq(eOpen, [], `Q3 empty read ${k}: closed`);
            eq(await app(id(E, 0)), { state: "not_submitted", reason: CLOSED_REASON }, "Q3 closed: the application is not sent");
          }
          at += 61 * MIN;
        }
        guard = 0;
        while ((await status(P.p, P.board)).pass_offset > 0 && ++guard < 10) { await run(at); at += 61 * MIN; parts++; }
        const st = await status(P.p, P.board);
        ok(!/^partial/.test(st.last_status), `Q5 the second pass ended: ${st.last_status}`);
        eq(await openOf(P.p, P.board), listP.map((l) => id(P, l.n)).sort(), "Q5 the second pass closed exactly what was taken down");
      }
      console.log(`ingest r3 on Postgres: ${SEQUENCES} sequences, ${replacedApps} applications to a replaced job not sent, ${heldApps} held through empty reads, ${parts} lane runs`);
    } finally {
      await pg.stop();
    }
  },
});
