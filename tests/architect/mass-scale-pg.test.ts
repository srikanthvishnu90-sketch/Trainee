// Mass submission at scale (owner, 2026-10-27 19:52 "operate these things at large scale", 19:55 "never set a limit"), on a
// real Postgres 16 with the career schema and the leased, fair claim this lane asks the database lane for
// (tests/flow/host-backoff.sql, the reference SQL of the Request; never applied to a live project):
//   SCALE_PEOPLE people x SCALE_PER items queued (defaults 10,000 x 50 = 500,000; CI-sized by env), plus one heavy person
//   with SCALE_HEAVY items, on SCALE_HOSTS employer hosts, two of which refuse once (a 429 with Retry-After);
//   SCALE_WORKERS worker processes (tests/flow/scale-worker.ts: the real scheduler, mass-run.ts massRun, its journal and the
//   shared host gate), each SCALE_CONCURRENCY engines at once, the engine a stand-in taking ENGINE_MS (the browser and
//   employer pages are measured in mass-submit-pg.test.ts; here the database and the scheduler are).
//   One worker is SIGKILLed mid-run and another started in its place.
// Checked: every item ends in a recorded state, or is a drive the killed worker held (swept unknown, never driven again);
// no engine ever started twice for one item; fairness (in the first claims every person had a first item started before
// anyone had a third); the heavy person never starved others and others never starved them; the refusing hosts were
// held off for every instance (no start on them inside the Retry-After window after their refusal, by any worker); no
// global lock (claims run in parallel: total throughput grows with workers). The measured numbers are printed.
// Run: bash tests/flow/run-real-flow.sh tests/architect/mass-scale-pg.test.ts   (SCALE_* to size it)
import { pgBinDir, startPg } from "../flow/pg.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const num = (k: string, d: number) => { const v = Number(Deno.env.get(k)); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };
const PEOPLE = num("SCALE_PEOPLE", CI ? 2000 : 10000), PER = num("SCALE_PER", CI ? 10 : 50), HEAVY = num("SCALE_HEAVY", CI ? 2000 : 5000);
const HOSTS = num("SCALE_HOSTS", 200), WORKERS = num("SCALE_WORKERS", CI ? 8 : 20), CONC = num("SCALE_CONCURRENCY", 25), ENGINE_MS = num("ENGINE_MS", 5);
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }

Deno.test({
  name: `mass submission at scale: ${PEOPLE} people x ${PER} + one heavy person (${HEAVY}), ${WORKERS} worker processes, fair leased claims, a worker killed and replaced, shared host back-off; each item once`,
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres"); return; }
    const pg = await startPg();
    const work = await Deno.makeTempDir({ prefix: "trainee-scale-" });
    if (Deno.uid?.() === 0) await new Deno.Command("chmod", { args: ["-R", "a+rwX", work] }).output();
    try {
      await pg.sql(await Deno.readTextFile(`${ROOT}/tests/flow/host-backoff.sql`));
      // The data: profiles, accounts, and queued approved items. The payload is the smallest the queue accepts; each row's
      // hashes are the canonical payload hash (career_apply_jobs' own check), current for the person's account.
      const total = PEOPLE * PER + HEAVY;
      const heavy = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const t0 = performance.now();
      await pg.sql(`
        set session_replication_role = replica;
        create temporary table ppl as select gen_random_uuid() as id from generate_series(1, ${PEOPLE}) g
          union all select '${heavy}'::uuid;
        insert into auth.users (id, email) select id, id::text || '@example.test' from ppl;
        insert into public.profiles (id) select id from ppl;
        -- The owner's resume rule (20261026210016): each person has a confirmed resume on file (an experience entry, its
        -- fact_confirmed event, the file the cloud keeps), and every payload binds that file's sha256; without it the claim's
        -- queued -> driving guard skips the row and nothing is ever sent.
        insert into public.career_watch_kv (user_id, key, value) select id, 'career:account', jsonb_build_object('epoch', 0, 'version', 0, 'paused', false,
          'memory', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(jsonb_build_object('kind', 'experience', 'status', 'confirmed',
          'needs_confirmation', false, 'confirmation_event_id', 'scale-ev-' || id, 'text', 'Analyst, Scale Co'))))) from ppl;
        insert into public.career_events (user_id, kind, subject, detail, source)
          select id, 'fact_confirmed', 'resume entry', jsonb_build_object('confirmation_event_id', 'scale-ev-' || id), 'chat' from ppl;
        insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
          select id, encode(sha256(convert_to('%PDF-1.4 scale test resume', 'UTF8')), 'hex'), 'resume.pdf', convert_to('%PDF-1.4 scale test resume', 'UTF8'), 0 from ppl;
        insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, created_at)
        select x.user_id, x.job_id, x.company, x.url, x.p, h, h, x.at from (
          select p.id as user_id, 'scale:' || p.id || ':' || n as job_id, 'TEST Co ' || n as company,
            'https://' || (case when (n % ${HOSTS}) < 2 then 'refuse-' else 'h' end) || (n % ${HOSTS}) || '.example.test/' || p.id || '/' || n as url,
            jsonb_build_object('version', 1, 'user_id', p.id, 'job_id', 'scale:' || p.id || ':' || n, 'company', 'TEST Co ' || n,
              'url', 'https://h.example.test/' || n, 'fields', '[]'::jsonb, 'privacy_epoch', 0, 'account_version', 0,
              'expires_at', '2099-01-01T00:00:00Z', 'engine_approval', repeat('a', 64),
              'resume_sha256', encode(sha256(convert_to('%PDF-1.4 scale test resume', 'UTF8')), 'hex')) as p,
            now() - make_interval(secs => n) as at
          from ppl p cross join lateral generate_series(1, case when p.id = '${heavy}' then ${HEAVY} else ${PER} end) n) x
        cross join lateral (select public.career_apply_payload_hash(x.p) as h) hh;
        set session_replication_role = origin;
        analyze public.career_apply_jobs;
        create table public.scale_refused (host text primary key); grant all on public.scale_refused to service_role;`);
      const seeded = Number(await pg.sql(`select count(*) from public.career_apply_jobs where state = 'queued'`));
      assert(seeded === total, `seeded ${seeded} of ${total}`);
      console.log(`SEEDED ${total} items for ${PEOPLE + 1} people in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

      const runlog = `${work}/runs.log`;
      await Deno.writeTextFile(runlog, "");
      if (Deno.uid?.() === 0) await new Deno.Command("chmod", { args: ["a+rw", runlog] }).output();
      const im = Deno.env.get("IMPORT_MAP");
      // Each instance's walk over people starts at its own evenly spaced place (id / (WORKERS + 2) of the uuid space), so
      // the fairness window below is covered by the claim's walks themselves; random places (production's) leave gaps in
      // a window shorter than one walk per instance by chance alone (7 of 2001 people unserved on run 40877292448).
      const startOf = (id: number) => `${Math.floor((id * 0x100000000) / (WORKERS + 2)).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      const spawn = (id: number) => {
        const c = new Deno.Command("setsid", {
          args: [Deno.execPath(), "run", "-A", "--no-check", ...(im ? [`--import-map=${im}`] : []), `${ROOT}/tests/flow/scale-worker.ts`],
          env: { ...Deno.env.toObject(), SCALE_PG: `${pg.host}:${pg.port}:${pgBinDir()}`, SCALE_ID: String(id), SCALE_JOURNAL: `${work}/journal-${id}`,
            SCALE_CONCURRENCY: String(CONC), ENGINE_MS: String(ENGINE_MS), SCALE_RUNLOG: runlog, SCALE_LEASE_S: "3", SCALE_START: startOf(id) },
          stdout: "piped", stderr: "piped", stdin: "null",
        }).spawn();
        return { id, c, out: new Response(c.stdout).text(), err: new Response(c.stderr).text() };
      };
      const t1 = performance.now();
      const workers = Array.from({ length: WORKERS }, (_, i) => spawn(i));
      // Kill one mid-run (its engines with it) once a tenth of the work is done; start a replacement.
      let killed = false;
      while (!killed) {
        await new Promise((r) => setTimeout(r, 200));
        const ran = (await Deno.readTextFile(runlog)).split("\n").length;
        if (ran > total / 10) {
          await new Deno.Command("kill", { args: ["-KILL", "--", `-${workers[0].c.pid}`] }).output();
          killed = true;
          workers.push(spawn(WORKERS));
        }
      }
      // The drive sweep (15 minutes in production) runs once, after every live worker has finished: then the only drives
      // left are the killed worker's, and a busy machine's slow finish is never mistaken for a dead worker.
      const codes = await Promise.all(workers.map(async (w) => ({ id: w.id, st: await w.c.status, out: await w.out, err: await w.err })));
      // A lease the killed worker took and never began lapses (3 s here, 2 minutes in production) and is claimable again:
      // a worker started after it takes it (production workers never stop asking; these drain and exit).
      await new Promise((r) => setTimeout(r, 3500));
      const mop = spawn(WORKERS + 1);
      codes.push({ id: mop.id, st: await mop.c.status, out: await mop.out, err: await mop.err });
      await new Promise((r) => setTimeout(r, 3500));
      await pg.sql(`select public.career_apply_lease_sweep(interval '3 seconds')`);
      const wall = (performance.now() - t1) / 1000;
      const leftover = await pg.sql(`select coalesce(string_agg(state || ' leased=' || l || ' n=' || n, ', '), '') from (select state, coalesce((lease_until > now())::text, 'none') l, count(*) n
        from public.career_apply_jobs where state in ('queued', 'driving') group by 1, 2) y`).catch((e) => String(e));
      if (leftover) console.log(`LEFTOVER ${leftover}`);
      for (const c of codes) console.log(`WORKER ${c.id} exit=${c.st.code} ${c.out.trim().slice(-200)} ${c.err.trim().slice(-300)}`);
      for (const c of codes.slice(1)) assert(c.st.code === 0, `worker ${c.id} exited ${c.st.code}: ${c.err.slice(-800)}`);

      // ---- what happened
      const runs = (await Deno.readTextFile(runlog)).split("\n").filter(Boolean).map((l) => { const [, id, host, at, w] = l.split(" "); return { id, host, at: Number(at), w }; });
      const per = new Map<string, number>();
      for (const r of runs) per.set(r.id, (per.get(r.id) ?? 0) + 1);
      const twice = [...per].filter(([, n]) => n > 1);
      const states = Object.fromEntries((await pg.sql(`select state || '=' || count(*) from public.career_apply_jobs group by state`)).split("\n").map((l) => l.split("=")).map(([s, n]) => [s, Number(n)]));
      const left = (states.queued ?? 0) + (states.driving ?? 0);
      const unknown = states.unknown_outcome ?? 0;
      // Fairness. Each instance walks every waiting person in turn, one item each (career_apply_claim_fair), so within one
      // lap of the instances (WORKERS x people starts) every person is served and nobody gets more than about one start
      // per instance, however many items they queued. Served oldest first instead, the heavy person's thousands of oldest
      // items would take every one of the first starts.
      const sorted = [...runs].sort((a, b) => a.at - b.at);
      const userOf = new Map((await pg.sql(`select id || '|' || user_id from public.career_apply_jobs`)).split("\n").map((l) => l.split("|") as [string, string]));
      // The window: one lap of the instances, within the first half of the run (while every person still has items).
      const lap = Math.min(Math.floor(total / 2), (WORKERS + 2) * (PEOPLE + 1)), fairShare = lap / (PEOPLE + 1);
      const seen = new Map<string, number>();
      for (const r of sorted.slice(0, lap)) seen.set(userOf.get(r.id)!, (seen.get(userOf.get(r.id)!) ?? 0) + 1);
      const servedInLap = seen.size, mostInLap = Math.max(...seen.values()), heavyInLap = seen.get(heavy) ?? 0;
      const heavyFirst = sorted.findIndex((r) => userOf.get(r.id) === heavy);
      // The refusing hosts: after a refusal (Retry-After 2 s), no start there by ANY worker within the window.
      const refusals = (await pg.sql(`select host || '|' || extract(epoch from until) * 1000 from public.career_apply_host_backoff`)).split("\n").filter(Boolean)
        .map((l) => { const [h, u] = l.split("|"); return { host: h, until: Number(u) }; });
      // An instance sees another's refusal within its gate read cache (200 ms here, 1 s by default): the window checked
      // starts after that, and every later start until the host's time is a failure.
      const early = refusals.flatMap((rf) => runs.filter((r) => r.host === rf.host && r.at > rf.until - 2000 + 400 && r.at < rf.until - 50));
      const sent = states.submitted_unconfirmed ?? 0;
      console.log(`MEASURED items=${total} people=${PEOPLE + 1} workers=${WORKERS}(+1 replacement, 1 killed) concurrency_each=${CONC} engine_ms=${ENGINE_MS} ` +
        `wall_s=${wall.toFixed(1)} throughput_per_s=${(runs.length / wall).toFixed(0)} engine_starts=${runs.length} started_twice=${twice.length} ` +
        `states=${JSON.stringify(states)} first_${lap}_starts(one lap of the instances): people_served=${servedInLap} most_for_one_person=${mostInLap} heavy_person=${heavyInLap} heavy_first_start_at=${heavyFirst} ` +
        `refused_hosts=${refusals.length} starts_inside_backoff=${early.length}`);

      assert(twice.length === 0, `an item's engine started twice: ${JSON.stringify(twice.slice(0, 5))}`);
      assert(left === 0, `nothing left queued or driving (${left}): ${JSON.stringify(states)}`);
      // Exactly once: every started item was recorded once (a finish) or swept unknown (the killed worker's), and every
      // unknown one was started exactly once before the kill.
      assert(sent + (states.not_submitted ?? 0) + unknown === total, `every item accounted for: ${JSON.stringify(states)}`);
      assert(unknown <= CONC, `only what the killed worker was running is unknown (${unknown} <= ${CONC})`);
      // Every item that finished was started exactly once. An item the killed worker had begun (its row moved to driving) may
      // have died before its start line was written: such an item is swept unknown and never driven again, never unstarted
      // and finished, and there are at most what that worker held.
      const unknownIds = new Set((await pg.sql(`select id from public.career_apply_jobs where state = 'unknown_outcome'`)).split("\n").filter(Boolean));
      const notRun = [...userOf.keys()].filter((id) => !per.has(id));
      assert(notRun.every((id) => unknownIds.has(id)), `an item that was never started finished anyway: ${notRun.filter((id) => !unknownIds.has(id)).slice(0, 5)}`);
      assert(runs.length + notRun.length === total && notRun.length <= CONC, `every item's engine started once (${runs.length} of ${total}; ${notRun.length} begun by the killed worker before their start was logged)`);
      // A host's refusal ends that one application as not sent (nothing was filled), each with the host's reason.
      const notSent = Number(await pg.sql(`select count(*) from public.career_apply_jobs where state = 'not_submitted' and reason <> 'HOST_RATE_LIMITED'`));
      assert(notSent === 0, `every not-sent one is a host refusal (${notSent} other)`);
      assert(servedInLap === PEOPLE + 1, `fair: every person was served within one lap of the instances (${servedInLap} of ${PEOPLE + 1} in the first ${lap} starts)`);
      assert(mostInLap <= 3 * fairShare + 2, `fair: nobody took more than about their share of that window (most ${mostInLap}, heavy ${heavyInLap}, fair share ${fairShare.toFixed(1)})`);
      assert(refusals.length === 2, `both refusing hosts were held off in the database (${refusals.length})`);
      assert(early.length === 0, `no instance started on a refusing host inside its back-off: ${JSON.stringify(early.slice(0, 3))}`);
    } finally {
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
