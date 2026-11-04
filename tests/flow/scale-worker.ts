// One worker instance for tests/architect/mass-scale-pg.test.ts, in its own process: the scheduler (mass-run.ts massRun)
// over the fair leased claim (career_apply_claim_fair -> career_apply_lease_begin -> career_apply_finish), the shared host
// gate (career_apply_host_backoff_*) and its own journal. The engine is a stand-in that takes ENGINE_MS and refuses on
// hosts named "refuse-*" (a 429 with Retry-After) the first time each host is tried. Every engine start is appended to
// a log line "RAN <job id> <host> <ms>" (the test counts them: each job at most once, ever).
//   SCALE_PG="<socket dir>:<port>:<pgbin>" SCALE_ID=<n> SCALE_JOURNAL=<dir> SCALE_CONCURRENCY=<n> ENGINE_MS=<ms> [SCALE_START=<uuid>]
//   deno run -A tests/flow/scale-worker.ts
import { psqlSession } from "./psql-session.ts";
import { dbHostGate, fileJournal, type MassJob, massRun, pacingFrom } from "../../workers/career-browser/mass-run.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const [host, port, bin] = env("SCALE_PG").split(":");
const id = env("SCALE_ID"), engineMs = Number(env("ENGINE_MS") || 5);
const db = psqlSession({ host, port: Number(port), bin, role: "service_role" });
const gdb = psqlSession({ host, port: Number(port), bin, role: "service_role" });
const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (xs: string[], t: string) => `array[${xs.map(lit).join(",")}]::${t}[]`;
const gate = dbHostGate({
  rpc: async (name: string, a: any) => {
    try {
      if (name === "career_apply_host_backoff_get") {
        const rows = await gdb.q(`select host, until from public.career_apply_host_backoff_get(${arr(a.p_hosts, "text")})`);
        return { data: rows.map((l) => { const [h, u] = l.split("|"); return { host: h, until: u }; }), error: null };
      }
      if (name === "career_apply_host_refused") {
        const [u] = await gdb.q(`select public.career_apply_host_refused(${lit(a.p_host)}, ${lit(a.p_reason)}, ${a.p_retry_after_s ?? "null"})`);
        return { data: u, error: null };
      }
      await gdb.q(`select public.career_apply_host_ok(${lit(a.p_host)})`);
      return { data: null, error: null };
    } catch (e) { return { data: null, error: { message: String((e as Error).message) } }; }
  },
}, { log: () => {}, cacheMs: 200 });
type J = MassJob & { user_id: string };
const tried = new Set<string>();
// Where this instance's walk over people begins. Production passes none (the claim starts each fresh walk at a random
// person); the scale test spreads its instances evenly (SCALE_START) so that "every person is served within the first
// starts" depends on the claim's walk, not on where random starting points happened to fall (2026-10-30: with random
// starts, 1994 of 2001 people were reached in a window shorter than one walk per instance, on run 40877292448).
let cursor: string | null = env("SCALE_START") || null;
let stop = false;
// A worker in production never stops asking; this one stops once the database holds nothing queued that is not leased
// by another instance (a single empty claim is not proof: rows a concurrent claim holds are skipped).
const watch = psqlSession({ host, port: Number(port), bin, role: "service_role" });
let idleChecks = 0;
const watcher = setInterval(async () => {
  try {
    const [n] = await watch.q(`select count(*) from public.career_apply_jobs where state = 'queued' and coalesce(lease_until, '-infinity') < now()`);
    idleChecks = Number(n) === 0 ? idleChecks + 1 : 0;
    if (idleChecks >= 3) stop = true;
  } catch { /* asked again next second */ }
}, 1000);
Deno.addSignalListener("SIGTERM", () => { stop = true; });
const out = await massRun<J>({
  claim: async (n) => {
    const rows = (await db.q(`select id, lease_token, url, user_id, claimed_at from public.career_apply_claim_fair(${n}, ${Number(env("SCALE_LEASE_S") || 120)}, ${cursor ? lit(cursor) : "null"})`))
      .map((l) => { const [jid, lease, url, user] = l.split("|"); return { id: jid, lease_token: lease, url, user_id: user }; });
    // This instance's own place in the walk over people: the last one served.
    if (rows.length) cursor = rows[rows.length - 1].user_id;
    return rows;
  },
  begin: async (jobs) => new Set(await db.q(`select * from public.career_apply_lease_begin(${arr(jobs.map((j) => j.id), "uuid")}, ${arr(jobs.map((j) => j.lease_token!), "uuid")})`)),
  run: async (job, onStart) => {
    await onStart();
    const h = new URL(job.url).host, t0 = Date.now();
    await Deno.writeTextFile(env("SCALE_RUNLOG"), `RAN ${job.id} ${h} ${t0} ${id}\n`, { append: true });
    await new Promise((r) => setTimeout(r, engineMs));
    let state = "submitted_unconfirmed", reason: string | null = "acknowledged", retry: number | null = null;
    // The two refusing hosts each refuse once, the first time any instance reaches them (a 429 with Retry-After: 2).
    if (h.startsWith("refuse-") && !tried.has(h)) {
      tried.add(h);
      const first = await db.q(`insert into scale_refused (host) values (${lit(h)}) on conflict do nothing returning host`);
      if (first.length) { state = "not_submitted"; reason = "HOST_RATE_LIMITED"; retry = 2; }
    }
    await db.q(`select (public.career_apply_finish(${lit(job.id)}, ${lit(job.lease_token!)}, ${lit(state)}, jsonb_build_object('reason', ${lit(reason ?? "")}))).id`);
    return { state, reason, retry_after_s: retry, recorded: true };
  },
  unstarted: async (job, why) => {
    // A lease given back: claimable again by any instance (career_apply_lease_release).
    await db.q(`select public.career_apply_lease_release(${arr([job.id], "uuid")}, ${arr([job.lease_token!], "uuid")})`);
    return { state: "released", reason: why, recorded: true };
  },
  orphaned: async (job) => ({ state: "orphan_left_to_sweep", reason: job.id, recorded: true }),
  pacing: pacingFrom(() => undefined, { concurrency: Number(env("SCALE_CONCURRENCY") || 25) }),
  stop: () => stop,
  journal: fileJournal<J>(env("SCALE_JOURNAL")),
  gate,
  drain: false,
  idleMs: 50,
  log: () => {},
});
clearInterval(watcher);
await watch.close();
console.log(`DONE ${id} ${out.filter((x) => x.started).length}`);
await db.close();
await gdb.close();
