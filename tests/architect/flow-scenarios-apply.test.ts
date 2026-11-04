// THE APPLY FLOW AND MASS SUBMISSION, end to end on real Postgres (architect, 2026-10-29). A seeded sample of the
// generated scenarios (tests/architect/scenarios/apply-generator.ts; every one of them runs through the pure code in
// scenarios-apply.test.ts) on Postgres 16 with every migration (tests/flow/pg.ts), judged by the database's own rows:
//   A  postings   ~60 pairs: the first approved and queued (career_apply_enqueue), the second asked for through the
//                 chat's queue (career_apply_want_put_for, through the chat's own store and queueWants) and approved: the
//                 same posting in any form is refused as the same posting, in plain words; another posting at the same
//                 company is queued. The database's link key never merges two of the 4,000 generated pairs.
//   B  history    ~50 earlier applications in every queue state around the 30-day mark: the same posting is refused
//                 while its application counts, at any age; another posting at the company is never refused.
//   C  resumes    people with no resume, a draft, an unconfirmed entry, a quarantined (owner-bank) entry and a confirmed
//                 one: only the confirmed one is a resume on file; nothing else is approved into the queue or claimed.
//   D  hosts      ~50 approved applications over hosts that answer, rate-limit (Retry-After seconds and an HTTP date),
//                 check, wall, fail and time out, driven by three cloud workers at once (mass-run.ts massRun over the pool
//                 claim and the shared host gate): each engine once; refusing hosts held in the database and resumed;
//                 nothing started on a held host inside its hold; everything recorded.
//   E  crashes    the person's own computer (approve-first.ts runLoop over career_apply_claim_own / _finish_own) killed at
//                 five points and started again on its journal, and a lost machine with no journal (the 15-minute sweep):
//                 a started application is unknown and never driven again; an unstarted one runs once; a recorded one
//                 stays recorded. Four computers of one person drain one queue: each application once.
//   F  approvals  approvals that do not carry the exact payload hash, and a payload changed after its approval: nothing
//                 queued, and the claim closes the changed one unsent.
//   G  resume     hosts that refuse before anything is sent (429 seconds, an HTTP date, 503) and then clear, three cloud
//                 workers on the pool claim and the person's computer on its own (career_apply_requeue_refused_for/_own,
//                 20261029180000): the same row queued again with its hash, never claimed before its time or twice at
//                 once, submitted once; a check and an unknown never retried; what the person is told while it waits.
//   H  unstarted  cloud workers stopped mid-batch and out of their lease budget, and the person's computer stopped
//                 mid-batch (career_apply_requeue_unstarted_for/_own, 20261029190000), beside hosts that answer, check,
//                 time out or answer a 503 with no Retry-After: every claim let go before its engine started is the same
//                 row queued again with its hash, and is submitted once later.
// No model, no network, no Chromium: engines are stand-ins at the scheduler's boundary.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { AGES, BLOCKING, CRASH_POINTS, type CrashPoint, historyCases, httpDate, isoIn, type Link, postingCases, rng, sample, STATES } from "./scenarios/apply-generator.ts";
import { formUrlFor, postingKey } from "../../supabase/functions/_shared/posting_key.ts";
import { queueWants, supabaseWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { type Job, ownQueue, runLoop } from "../../workers/career-browser/approve-first.ts";
import { dbHostGate, type HostGate, hostOf, type Journal, type JournalEntry, localHostGate, type MassJob, massRun, pacingFrom, retryAfterSeconds } from "../../workers/career-browser/mass-run.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
import { answerText } from "../../supabase/functions/_shared/career_apply_cards.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const SEED = 20261029;
const RESUME_TEXT = "%PDF-1.4 TEST apply scenarios resume";
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const RESUME_SHA = await sha(RESUME_TEXT);
const lit = (v: unknown) => `$q$${typeof v === "string" ? v : JSON.stringify(v)}$q$`;
const eff = (l: Link) => formUrlFor(String(l.job_id ?? "")) ?? l.url;
const P = (n: number) => `6c0f8f8e-6a43-4a49-9d2c-0000000a${String(n).padStart(4, "0")}`;

type ResumeState = "none" | "draft" | "unconfirmed" | "quarantined" | "confirmed";
// Setup, not the person acting: an account, its pace-free settings and, by state, the resume entries the profile holds
// (each with its fact_confirmed event) and the resume file the cloud keeps (career_apply_cloud_resumes).
async function person(pg: Pg, id: string, resume: ResumeState) {
  const ev = `apply-scen-${id.slice(-8)}`;
  const fact = resume === "none" ? null : {
    id: "resume-1", kind: "experience", text: "TEST Analyst, TEST Co", confirmation_event_id: ev,
    status: resume === "draft" ? "draft" : "confirmed", needs_confirmation: resume === "unconfirmed",
    ...(resume === "quarantined" ? { factId: "F-033", provenance: "owner-delegated (answer-all)" } : {}),
  };
  await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test') on conflict do nothing;
    insert into public.profiles (id) values ('${id}') on conflict do nothing;
    insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', ${lit({ epoch: 0, version: 0, paused: false, memory: { profile: { facts: fact ? [fact] : [] } } })}::jsonb)
      on conflict (user_id, key) do update set value = excluded.value;
    ${fact ? `insert into public.career_events (user_id, kind, subject, detail, source) values ('${id}', 'fact_confirmed', 'resume entry', ${lit({ confirmation_event_id: ev })}::jsonb, 'chat');` : ""}
    insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
      values ('${id}', '${RESUME_SHA}', 'resume.pdf', convert_to(${lit(RESUME_TEXT)}, 'UTF8'), 0) on conflict do nothing;`);
}
// One approved application of one posting, as the card's yes queues it: its payload, its own hash as the approval.
const payload = (user: string, jobId: string, company: string, url: string, extra: Record<string, unknown> = {}) => ({
  version: 1, user_id: user, job_id: jobId, company, url, fields: [], privacy_epoch: 0, account_version: 0, expires_at: "2099-01-01T00:00:00Z",
  engine_approval: "e".repeat(64), resume_sha256: RESUME_SHA, destination: url, ...extra,
});
async function hashOf(pg: Pg, p: unknown) { return await pg.sql(`select public.career_apply_payload_hash(${lit(p)}::jsonb)`); }
async function enqueue(pg: Pg, p: any, o: { hash?: string; approval?: string } = {}) {
  const h = await hashOf(pg, p);
  const r = await pg.asService().rpc("career_apply_enqueue", { p_payload: p, p_hash: o.hash ?? h, p_approval: o.approval ?? o.hash ?? h });
  return r.error ? r.error.message : "queued";
}
// The chat's own store (supabaseWantStore) over the database: rpc as the service role, and the two reads it makes.
function adminShim(pg: Pg) {
  const q = (table: string) => {
    const where: string[] = [];
    let cols = "*", head = false, order = "", limit = "";
    const b: any = {
      select(c: string, o?: { count?: string; head?: boolean }) { cols = c; head = !!o?.head; return b; },
      eq(c: string, v: string) { where.push(`${c} = ${lit(v)}`); return b; },
      gte(c: string, v: string) { where.push(`${c} >= ${lit(v)}`); return b; },
      order(c: string, o?: { ascending?: boolean }) { order = ` order by ${c} ${o?.ascending === false ? "desc" : "asc"}`; return b; },
      limit(n: number) { limit = ` limit ${n}`; return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        const sel = head ? `select count(*)::int from public.${table} where ${where.join(" and ") || "true"}`
          : `select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select ${cols} from public.${table} where ${where.join(" and ") || "true"}${order}${limit}) x`;
        return pg.sql(sel).then((out) => head ? { count: Number(out), error: null } : { data: JSON.parse(out), error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { rpc: (n: string, a: unknown) => pg.asService().rpc(n, a), from: q };
}
const never = <T>() => new Promise<T>(() => {});

Deno.test({
  name: "the apply flow and mass submission on real Postgres: postings, history, resumes, hosts, crashes, approvals",
  sanitizeResources: false, sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres"); return; }
    const pg = await startPg();
    const counts: Record<string, number> = {};
    const fails: string[] = [];
    const fail = (m: string) => { fails.push(m); };
    try {
      // ------------------------------------------------------------------------------------------------ A postings
      await t.step("A postings: the same posting in any form is refused as one, in plain words; another posting at the company is queued", async () => {
        const all = postingCases(rng(SEED), 4000);
        // The database's link key never merges two different postings (over every generated pair, one query).
        const rows = all.map((c, i) => `(${i}, ${lit(eff(c.a))}, ${lit(eff(c.b))}, ${c.same})`).join(",\n");
        const merged = await pg.sql(`select coalesce(string_agg(i::text || ' ' || a || ' ' || b, E'\\n'), '') from (values ${rows}) v(i, a, b, same)
          where not same and public.career_apply_posting_key(a) = public.career_apply_posting_key(b)`);
        if (merged) fail(`A: the database's key merged different postings:\n${merged.slice(0, 600)}`);
        counts.A_keys = all.length;
        const U = P(1);
        await person(pg, U, "confirmed");
        const store = supabaseWantStore(adminShim(pg));
        for (const c of sample(rng(SEED + 100), all, 60)) {
          const ka = postingKey(eff(c.a))!, kb = postingKey(eff(c.b))!;
          const first = await enqueue(pg, payload(U, ka, c.company, eff(c.a)));
          if (first !== "queued") { fail(`A ${c.form}: the first could not be queued: ${first}`); continue; }
          // The chat's queue: the same posting refused in plain words (never the database's own code); another queued.
          const q = await queueWants(store, U, [{ url: c.b.url, job_id: c.b.job_id, company: c.b.company, title: c.b.title }], Date.now());
          if (c.same) {
            if (q.queued !== 0 || !q.refused.some((x) => /already in your applications as the same posting/.test(x.said))) fail(`A ${c.form}: the same posting through the chat queue: ${JSON.stringify({ queued: q.queued, refused: q.refused.map((x) => x.said) })} (${eff(c.a)} vs ${c.b.url})`);
            if (q.refused.some((x) => /duplicate_job|refused it \(/.test(x.said))) fail(`A ${c.form}: an internal code in the reply: ${q.refused.map((x) => x.said)}`);
          } else if (q.queued !== 1) fail(`A ${c.form}: another posting at ${c.company} not queued: ${JSON.stringify(q.refused.map((x) => x.said))}`);
          // Approved by its own card: the same posting refused, another posting queued.
          const second = await enqueue(pg, payload(U, kb, c.company, eff(c.b)));
          if (c.same ? !/duplicate_job/.test(second) : second !== "queued") fail(`A ${c.form} same=${c.same}: the second approval -> ${second} (${eff(c.a)} vs ${eff(c.b)})`);
          counts.A = (counts.A ?? 0) + 1;
        }
        const many = Number(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${U}' and state = 'queued'`));
        assert(many >= 60, `every posting queued for one person, many at the same companies, no number of ours (${many})`);
      });

      // ------------------------------------------------------------------------------------------------ B history
      await t.step("B history: an earlier application in each state around the 30-day mark: the same posting refused while it counts, at any age; another at the company never", async () => {
        const U = P(2);
        await person(pg, U, "confirmed");
        const hs = sample(rng(SEED + 200), historyCases(rng(SEED + 1), 2000), 50);
        // Every zone's spelling is the same instant to the database.
        const zones = await pg.sql(`select bool_and(a::timestamptz = b::timestamptz) from (values ${hs.map((h) => `(${lit(h.applied_at)}, ${lit(new Date(Date.parse(h.applied_at)).toISOString())})`).join(",")}) v(a, b)`);
        if (zones !== "t") fail("B: a time zone's spelling read as another instant");
        for (const [i, h] of hs.entries()) {
          const ka = postingKey(eff(h.prior.a))!, kb = postingKey(eff(h.b))!;
          // Setup: the earlier application as the queue recorded it, created that long before now.
          const p = payload(U, ka, h.prior.company, eff(h.prior.a));
          const hh = await hashOf(pg, p);
          await pg.sql(`set session_replication_role = replica;
            insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, attempts, claimed_at, lease_token, created_at, updated_at)
            values ('${U}', ${lit(ka)}, ${lit(h.prior.company)}, ${lit(eff(h.prior.a))}, ${lit(p)}::jsonb, '${hh}', '${hh}', '${h.state}', ${h.state === "queued" ? 0 : 1},
              ${h.state === "queued" ? "null" : `now() - interval '${AGES[h.age] / 1000} seconds'`}, ${h.state === "queued" ? "null" : "gen_random_uuid()"},
              now() - interval '${AGES[h.age] / 1000} seconds', now() - interval '${AGES[h.age] / 1000} seconds');
            set session_replication_role = origin;`);
          const put = await pg.asService().rpc("career_apply_want_put_for", { p_user: U, p_items: [{ posting_key: kb, url: eff(h.b), company: h.b.company, title: h.b.title }] });
          const refused = (put.data?.refused ?? []).some((x: any) => x.reason === "duplicate_job");
          if (put.error || refused !== h.blocked) fail(`B ${i} ${h.candidate} ${h.state} ${h.age}: the chat queue refused=${refused} (${put.error?.message ?? JSON.stringify(put.data)}), expected ${h.blocked}`);
          if ((put.data?.refused ?? []).some((x: any) => x.reason !== "duplicate_job")) fail(`B ${i}: refused for another reason: ${JSON.stringify(put.data.refused)}`);
          const second = await enqueue(pg, payload(U, kb === ka ? `${kb}#again` : kb, h.b.company ?? h.prior.company, eff(h.b)));
          if (h.blocked ? !/duplicate_job/.test(second) : second !== "queued") fail(`B ${i} ${h.candidate} ${h.state} ${h.age}: the approval -> ${second}, expected ${h.blocked ? "duplicate_job" : "queued"}`);
          counts.B = (counts.B ?? 0) + 1;
        }
        void STATES; void BLOCKING;
      });

      // ------------------------------------------------------------------------------------------------ C resumes
      await t.step("C resumes: only a confirmed resume is on file; nothing else is approved into the queue or claimed", async () => {
        const states: ResumeState[] = ["none", "draft", "unconfirmed", "quarantined", "confirmed"];
        for (const [k, st] of states.entries()) {
          const U = P(30 + k);
          await person(pg, U, st);
          const onFile = (await pg.asService().rpc("career_resume_on_file", { p_user: U })).data;
          if (onFile !== (st === "confirmed")) fail(`C ${st}: career_resume_on_file says ${onFile}`);
          for (let i = 0; i < 4; i++) {
            const url = `https://jobs.lever.co/resume${k}/0f6e0c2a-1b2c-4d3e-8f90-00000000000${i}`;
            const r = await enqueue(pg, payload(U, `lever:resume${k}:${i}`, `Resume Co ${k}`, url, i === 3 ? { resume_sha256: "f".repeat(64) } : {}));
            const want = st === "confirmed" && i !== 3 ? "queued" : "no_resume";
            if (want === "queued" ? r !== "queued" : !/no_resume/.test(r)) fail(`C ${st} item ${i}${i === 3 ? " (a resume not stored for them)" : ""}: ${r}, expected ${want}`);
            counts.C = (counts.C ?? 0) + 1;
          }
          // A row that got into the queue before the rule (setup, past the guards): the claim never hands it out.
          if (st !== "confirmed") {
            const p = payload(U, `lever:resume${k}:old`, `Resume Co ${k}`, `https://jobs.lever.co/resume${k}/0f6e0c2a-1b2c-4d3e-8f90-0000000000ff`);
            const hh = await hashOf(pg, p);
            await pg.sql(`set session_replication_role = replica; insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash)
              values ('${U}', ${lit(p.job_id)}, ${lit(p.company)}, ${lit(p.url)}, ${lit(p)}::jsonb, '${hh}', '${hh}'); set session_replication_role = origin;
              insert into public.career_apply_claim_turns (user_id) values ('${U}') on conflict (user_id) do update set queued = true;`);
          }
        }
        const pool = await pg.asService().rpc("career_apply_claim_fair", { p_now: new Date().toISOString(), p_limit: 1000, p_per_person: 1 });
        if (pool.error) fail(`C: the pool claim: ${pool.error.message}`);
        const claimed = pool.data ?? [];
        // Their own computers too (career_apply_claim_own, as each person): nothing for anyone without a confirmed resume.
        for (const [k, st] of states.entries()) {
          if (st === "confirmed") continue;
          const own = await pg.asPerson(P(30 + k)).rpc("career_apply_claim_own", { p_limit: 100 });
          if (own.error || (own.data ?? []).length) fail(`C ${st}: their own computer's claim -> ${own.error?.message ?? JSON.stringify(own.data)}`);
        }
        const bad = claimed.filter((j: any) => states.some((st, k) => st !== "confirmed" && j.user_id === P(30 + k)));
        if (bad.length) fail(`C: the claim handed out ${bad.length} application(s) of people with no confirmed resume`);
        // Give the claimed ones back as not sent (they were only claimed to look).
        for (const j of claimed) await pg.asService().rpc("career_apply_finish", { p_id: j.id, p_lease: j.lease_token, p_state: "not_submitted", p_evidence: { reason: "TEST look only" } });
        const sent = Number(await pg.sql(`select count(*) from public.career_apply_jobs where user_id in (${states.map((st, k) => st === "confirmed" ? null : `'${P(30 + k)}'`).filter(Boolean).join(",")}) and state not in ('queued', 'not_submitted')`));
        if (sent) fail(`C: ${sent} application(s) without a confirmed resume left the queue other than unsent`);
      });

      // ------------------------------------------------------------------------------------------------ D hosts
      await t.step("D hosts: three cloud workers at once over hosts that answer, refuse, check, wall, fail and time out: each once; held hosts held in the database, then resumed", async () => {
        // Everything still queued from the steps above is closed (setup), so the pool holds only this step's work.
        await pg.sql(`update public.career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before D' where state = 'queued'`);
        type B = "ok" | "rl_seconds" | "rl_date" | "captcha" | "login_wall" | "server_error" | "timeout" | "mid_batch";
        const plan: { host: string; b: B; n: number }[] = [
          { host: "d-ok1.example.test", b: "ok", n: 10 }, { host: "d-ok2.example.test", b: "ok", n: 8 }, { host: "d-rl1.example.test", b: "rl_seconds", n: 5 },
          { host: "d-rl2.example.test", b: "rl_date", n: 5 }, { host: "d-check.example.test", b: "captcha", n: 1 }, { host: "d-wall.example.test", b: "login_wall", n: 4 },
          { host: "d-err.example.test", b: "server_error", n: 4 }, { host: "d-slow.example.test", b: "timeout", n: 3 }, { host: "d-mid.example.test", b: "mid_batch", n: 6 },
        ];
        const people = [P(40), P(41), P(42)];
        for (const u of people) await person(pg, u, "confirmed");
        let k = 0;
        for (const h of plan) for (let i = 0; i < h.n; i++, k++) {
          const u = people[k % people.length];
          const r = await enqueue(pg, payload(u, `d:${h.host}:${i}`, `D Co ${k}`, `https://${h.host}/jobs/${i}`));
          if (r !== "queued") fail(`D: setup enqueue ${h.host} ${i}: ${r}`);
        }
        const total = k;
        counts.D = total;
        const svc = pg.asService();
        const engine = new Map<string, number>(), starts: { id: string; host: string; at: number }[] = [], refusedTried = new Map<string, number>();
        let left = total, stop = false;
        const watch = setInterval(async () => { try { left = Number(await pg.sql(`select count(*) from public.career_apply_jobs where job_id like 'd:%' and state in ('queued', 'driving')`)); if (left === 0) stop = true; } catch { /* next tick */ } }, 250);
        const deadline = Date.now() + 45_000;
        const worker = (w: number) => massRun<MassJob & { user_id: string }>({
          claim: async (n) => {
            const c = await svc.rpc("career_apply_claim_fair", { p_now: new Date().toISOString(), p_limit: n, p_per_person: 1 });
            if (c.error) { fail(`D: the claim: ${c.error.message}`); throw Error(c.error.message); }
            return (c.data ?? []).map((j: any) => ({ id: j.id, lease_token: j.lease_token, url: j.url, user_id: j.user_id, claimed_at: j.claimed_at }));
          },
          run: async (job, onStart) => {
            await onStart();
            const h = plan.find((x) => x.host === hostOf(job.url))!;
            starts.push({ id: job.id, host: h.host, at: Date.now() });
            engine.set(job.id, (engine.get(job.id) ?? 0) + 1);
            const tried = (refusedTried.get(h.host) ?? 0) + 1;
            refusedTried.set(h.host, tried);
            const res: { state: string; reason: string; retry_after_s?: number | null } =
              h.b === "ok" || (h.b === "mid_batch" && tried <= 2) ? { state: "submitted_unconfirmed", reason: "acknowledged" }
              : h.b === "rl_seconds" || h.b === "mid_batch" ? { state: "not_submitted", reason: "HOST_RATE_LIMITED", retry_after_s: retryAfterSeconds("1", Date.now()) }
              : h.b === "rl_date" ? { state: "not_submitted", reason: "HOST_RATE_LIMITED", retry_after_s: retryAfterSeconds(httpDate(Date.now() + 2000, "imf"), Date.now()) }
              : h.b === "captcha" ? { state: "needs_user", reason: "captcha" }
              : h.b === "login_wall" ? { state: "needs_user", reason: "login_required" }
              : h.b === "server_error" ? { state: "failed", reason: "SUBMIT_HTTP_500" }
              : { state: "unknown_outcome", reason: "the engine gave no result after it started; not retried" };
            const f = await svc.rpc("career_apply_finish", { p_id: job.id, p_lease: job.lease_token, p_state: res.state, p_evidence: { reason: res.reason } });
            return { ...res, recorded: !f.error };
          },
          unstarted: async (job, why) => { const f = await svc.rpc("career_apply_finish", { p_id: job.id, p_lease: job.lease_token, p_state: "not_submitted", p_evidence: { reason: why } }); return { state: "not_submitted", reason: why, recorded: !f.error }; },
          orphaned: async () => ({ state: "unknown_outcome", recorded: true }),
          pacing: pacingFrom(() => undefined, { concurrency: 3 + w }), stop: () => stop || Date.now() > deadline,
          gate: dbHostGate(svc, { log: () => {}, cacheMs: 0 }), drain: false, idleMs: 100, log: () => {},
        });
        await Promise.all([worker(0), worker(1), worker(2)]);
        clearInterval(watch);
        if (Date.now() > deadline) fail(`D: the workers did not finish the queue in time (${left} left)`);
        const rows = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'url', url, 'state', state, 'reason', reason)), '[]') from public.career_apply_jobs where job_id like 'd:%'`));
        if (rows.length !== total) fail(`D: ${rows.length} rows of ${total}`);
        for (const r of rows) {
          const h = plan.find((x) => x.host === hostOf(r.url))!;
          if (engine.get(r.id) !== 1) fail(`D ${h.host}: ${r.id} engine started ${engine.get(r.id) ?? 0} times (state ${r.state})`);
          if (["queued", "driving"].includes(r.state)) fail(`D ${h.host}: ${r.id} left ${r.state}`);
          const want = { ok: "submitted_unconfirmed", captcha: "needs_user", login_wall: "needs_user", server_error: "failed", timeout: "unknown_outcome" }[h.b as string];
          if (want && r.state !== want) fail(`D ${h.host}: ${r.id} ${r.state}, expected ${want}`);
        }
        // The refusing hosts are held in the database (shared by every worker); the others never were.
        const held = JSON.parse(await pg.sql(`select coalesce(jsonb_object_agg(host, jsonb_build_object('refusals', refusals, 'reason', last_reason, 'until', extract(epoch from until) * 1000)), '{}') from public.career_apply_host_backoff where scope = 'cloud' and host like 'd-%'`));
        for (const h of plan) {
          const refuses = ["rl_seconds", "rl_date", "captcha", "mid_batch"].includes(h.b);
          if (refuses !== !!held[h.host]) fail(`D ${h.host} (${h.b}): held in the database = ${!!held[h.host]}`);
        }
        // Nothing started on a held host inside its hold, by any worker: each refusal (its engine's start + its wait).
        for (const h of plan.filter((x) => ["rl_seconds", "rl_date", "mid_batch"].includes(x.b))) {
          const s = starts.filter((x) => x.host === h.host).sort((a, b) => a.at - b.at);
          const refusedAt = s.filter((_, i) => h.b !== "mid_batch" || i >= 2);
          for (const rf of refusedAt) {
            const wait = h.b === "rl_date" ? 1000 : 1000; // at least a second either way (the date was ~2 s ahead when sent)
            const inside = s.filter((x) => x.at > rf.at + 400 && x.at < rf.at + wait - 100);
            if (inside.length) fail(`D ${h.host}: ${inside.length} start(s) inside the hold after ${rf.id}`);
          }
        }
        console.log(`[apply e2e] D: ${total} applications, ${starts.length} engine starts, held hosts ${Object.keys(held).join(", ")}`);
      });

      // ------------------------------------------------------------------------------------------------ E crashes
      await t.step("E crashes: the person's computer killed at five points and started again; a lost machine; four computers on one queue", async () => {
        const U = P(50);
        await person(pg, U, "confirmed");
        await pg.sql(`update public.career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before E' where state = 'queued'`);
        const me = pg.asPerson(U);
        const resume = { path: "/tmp/TEST-resume.pdf", sha256: RESUME_SHA };
        const quiet = { log: () => {}, sleep: async () => {}, idleMs: 1, writeFacts: async () => "/tmp/TEST-facts.json", resume };
        const r = rng(SEED + 500);
        let round = 0;
        const points: (CrashPoint | "lost_machine")[] = [...CRASH_POINTS, ...CRASH_POINTS, ...CRASH_POINTS, "lost_machine", "lost_machine"];
        for (const point of points) {
          round++;
          const n = r.int(2, 4), at = r.int(0, n - 1);
          const ids: string[] = [];
          for (let i = 0; i < n; i++) {
            const res = await enqueue(pg, payload(U, `e:${round}:${i}`, `E Co ${round}`, `https://e${round}-${i % 2}.example.test/jobs/${i}`));
            if (res !== "queued") fail(`E setup: ${res}`);
          }
          for (const id of (await pg.sql(`select id from public.career_apply_jobs where user_id = '${U}' and job_id like 'e:${round}:%' order by job_id`)).split("\n")) ids.push(id);
          const target = ids[at];
          const engine = new Map<string, number>();
          const entries = new Map<string, JournalEntry<Job>>();
          const lives = [{ dead: false, died: null as null | (() => void) }, { dead: false, died: null as null | (() => void) }];
          let died!: Promise<void>;
          died = new Promise<void>((res) => { lives[0].died = res; });
          const die = () => { if (!lives[0].dead) { lives[0].dead = true; lives[0].died!(); } };
          const journal = (w: number): Journal<Job> => ({
            async put(job, claimedAt) { if (lives[w].dead) return await never(); entries.set(job.id, { job: structuredClone(job), claimedAt, started: false }); },
            async start(id) {
              if (w === 0 && id === target && point === "before_journal_start") die();
              if (lives[w].dead) return await never();
              entries.set(id, { ...entries.get(id)!, started: true });
              if (w === 0 && id === target && point === "after_start_before_engine") die();
              if (lives[w].dead) return await never();
            },
            async done(id) { if (w === 0 && id === target && point === "after_record_before_clear") die(); if (lives[w].dead) return await never(); entries.delete(id); },
            async list() { return [...entries.values()].sort((a, b) => a.claimedAt - b.claimedAt); },
          });
          const client = (w: number) => ({
            rpc: async (name: string, a: any) => {
              if (lives[w].dead) return await never<any>();
              if (w === 0 && name === "career_apply_finish_own" && a.p_id === target && point === "after_engine_before_record") die();
              if (lives[w].dead) return await never<any>();
              const out = await me.rpc(name, a);
              if (lives[w].dead) return await never<any>(); // a reply that arrives after the death is never acted on
              return out;
            },
          });
          const engineOf = (w: number) => async (args: string[]) => {
            if (lives[w].dead) return await never<any>();
            const id = args[args.indexOf("--application-id") + 1];
            engine.set(id, (engine.get(id) ?? 0) + 1);
            if (w === 0 && id === target && (point === "during_engine" || point === "lost_machine")) { die(); return await never<any>(); }
            return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
          };
          const lost = point === "lost_machine";
          const w1 = runLoop({ ...quiet, queue: ownQueue(client(0)), stop: () => false, drain: true, gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: 2 }),
            ...(lost ? {} : { journal: journal(0) }), runEngine: engineOf(0) });
          await Promise.race([died, w1]);
          if (!lives[0].dead) { fail(`E ${point}: the worker never reached its crash point`); continue; }
          await new Promise((res) => setTimeout(res, 50));
          const before = JSON.parse(await pg.sql(`select jsonb_object_agg(id, state) from public.career_apply_jobs where id in (${ids.map((x) => `'${x}'`).join(",")})`));
          const startedBy1 = new Set([...entries.values()].filter((e) => e.started).map((e) => e.job.id));
          if (lost) {
            // No journal: the database's sweep (15 minutes in production) closes the drive as unknown.
            await pg.asService().rpc("career_apply_sweep", { p_now: new Date(Date.now() + 16 * 60_000).toISOString() });
          }
          await runLoop({ ...quiet, queue: ownQueue(client(1)), stop: () => false, drain: true, gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: 2 }),
            ...(lost ? {} : { journal: journal(1) }), runEngine: engineOf(1) });
          // A claim the database answered after the worker died left drives with no journal line: the database's sweep
          // (15 minutes in production) closes them as unknown, never driven.
          await pg.asService().rpc("career_apply_sweep", { p_now: new Date(Date.now() + 16 * 60_000).toISOString() });
          const after = JSON.parse(await pg.sql(`select jsonb_object_agg(id, state) from public.career_apply_jobs where id in (${ids.map((x) => `'${x}'`).join(",")})`));
          for (const id of ids) {
            const n2 = engine.get(id) ?? 0;
            if (n2 > 1) fail(`E ${point}: ${id} engine started ${n2} times`);
            if (["queued", "driving"].includes(after[id])) fail(`E ${point}: ${id} left ${after[id]}`);
            if (!["queued", "driving"].includes(before[id]) && after[id] !== before[id]) fail(`E ${point}: ${id} was ${before[id]}, now ${after[id]}`);
            if (before[id] === "driving" && (startedBy1.has(id) || lost) && id === target && after[id] !== "unknown_outcome") fail(`E ${point}: the started one is ${after[id]}`);
            if (after[id] === "submitted_unconfirmed" && n2 !== 1) fail(`E ${point}: ${id} sent without one engine start`);
            if (after[id] === "unknown_outcome" && before[id] === "driving" && !startedBy1.has(id) && !lost && n2 !== 0) fail(`E ${point}: ${id} claimed without a journal line was driven`);
          }
          const tn = engine.get(target) ?? 0;
          const want = point === "before_journal_start" ? ["submitted_unconfirmed", 1] : point === "after_record_before_clear" ? ["submitted_unconfirmed", 1]
            : point === "after_start_before_engine" ? ["unknown_outcome", 0] : ["unknown_outcome", 1];
          if (after[target] !== want[0] || tn !== want[1]) fail(`E ${point}: the target is ${after[target]} with ${tn} engine start(s), expected ${want[0]} with ${want[1]}`);
          counts.E = (counts.E ?? 0) + n;
        }
        // Four computers of one person drain one queue at once (FOR UPDATE SKIP LOCKED): each application once.
        for (let i = 0; i < 40; i++) {
          const res = await enqueue(pg, payload(U, `e4:${i}`, `E4 Co ${i % 5}`, `https://four-${i % 6}.example.test/jobs/${i}`));
          if (res !== "queued") fail(`E4 setup: ${res}`);
        }
        const engine = new Map<string, number>();
        await Promise.all([0, 1, 2, 3].map((w) => runLoop({ ...quiet, queue: ownQueue(me), stop: () => false, drain: true, gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: 2 + w }),
          runEngine: async (args) => { const id = args[args.indexOf("--application-id") + 1]; engine.set(id, (engine.get(id) ?? 0) + 1); return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null }; } })));
        const rows = (await pg.sql(`select id || ' ' || state from public.career_apply_jobs where user_id = '${U}' and job_id like 'e4:%'`)).split("\n").map((l) => l.split(" "));
        for (const [id, st] of rows) if (engine.get(id) !== 1 || st !== "submitted_unconfirmed") fail(`E4: ${id} ${st} engine x${engine.get(id) ?? 0}`);
        counts.E4 = 1; // one scenario: 40 applications, four computers at once
      });

      // ------------------------------------------------------------------------------------------------ F approvals
      await t.step("F approvals: nothing is queued without its exact payload hash; a payload changed after its yes is closed unsent", async () => {
        const U = P(60);
        await person(pg, U, "confirmed");
        await pg.sql(`update public.career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before F' where state = 'queued'`);
        const base = (i: number) => payload(U, `f:${i}`, `F Co ${i}`, `https://f-${i}.example.test/jobs/${i}`);
        const other = await hashOf(pg, base(99));
        const cases: [string, () => Promise<string>][] = [
          ["approval of another payload", () => enqueue(pg, base(1), { approval: other })],
          ["hash of another payload", () => enqueue(pg, base(2), { hash: other })],
          ["no approval", () => enqueue(pg, base(3), { approval: "" })],
          ["a hash in capitals", async () => enqueue(pg, base(4), { hash: (await hashOf(pg, base(4))).toUpperCase() })],
          ["the hash with one character changed", async () => { const h = await hashOf(pg, base(5)); return enqueue(pg, base(5), { hash: h.slice(0, -1) + (h.endsWith("0") ? "1" : "0") }); }],
          ["an expired approval", () => enqueue(pg, { ...base(6), expires_at: "2020-01-01T00:00:00Z" })],
          ["another person's account version", () => enqueue(pg, { ...base(7), account_version: 5 })],
        ];
        for (const [what, go] of cases) {
          const r = await go();
          if (r === "queued") fail(`F ${what}: queued`);
          counts.F = (counts.F ?? 0) + 1;
        }
        const queuedBad = Number(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${U}'`));
        if (queuedBad) fail(`F: ${queuedBad} rows queued without their exact hash`);
        // Approved exactly, then changed (past every trigger: what a bug or an attacker with table access could do).
        for (const i of [10, 11, 12]) {
          if (await enqueue(pg, base(i)) !== "queued") fail(`F setup ${i}`);
          counts.F++;
        }
        await pg.sql(`set session_replication_role = replica;
          update public.career_apply_jobs set payload = payload || '{"fields":[{"name":"salary","value":"TEST 1"}]}'::jsonb where user_id = '${U}' and job_id = 'f:10';
          update public.career_apply_jobs set payload_hash = '${other}', approval_hash = '${other}' where user_id = '${U}' and job_id = 'f:11';
          set session_replication_role = origin;`);
        const pool = await pg.asService().rpc("career_apply_claim_fair", { p_now: new Date().toISOString(), p_limit: 100, p_per_person: 100 });
        if (pool.error) fail(`F: the pool claim: ${pool.error.message}`);
        const claimed = pool.data ?? [];
        const mine = claimed.filter((j: any) => j.user_id === U).map((j: any) => j.job_id).sort();
        eq(mine, ["f:12"], "only the unchanged approval is handed out");
        const closed = JSON.parse(await pg.sql(`select jsonb_object_agg(job_id, state || ': ' || coalesce(reason, '')) from public.career_apply_jobs where user_id = '${U}' and job_id in ('f:10', 'f:11')`));
        for (const k of ["f:10", "f:11"]) if (!/^not_submitted: not sent: the application changed after it was approved/.test(closed[k] ?? "")) fail(`F ${k}: ${closed[k]}`);
        for (const j of claimed) await pg.asService().rpc("career_apply_finish", { p_id: j.id, p_lease: j.lease_token, p_state: "not_submitted", p_evidence: { reason: "TEST look only" } });
      });

      // ------------------------------------------------------------------------------------------------ G back off, then resume
      await t.step("G resume: hosts that refuse before anything is sent (429 seconds, an HTTP date, 503) and then clear, three cloud workers and the person's computer: the same job is queued again, never claimed before its time or twice at once, and submitted once; checks and unknowns never retried", async () => {
        await pg.sql(`update public.career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before G' where state = 'queued'`);
        const plan = [
          { host: "g-rl1.example.test", b: "rl_seconds", refuse: 2, n: 4 }, { host: "g-rl2.example.test", b: "rl_date", refuse: 1, n: 3 },
          { host: "g-503.example.test", b: "busy_503", refuse: 2, n: 3 }, { host: "g-ok.example.test", b: "ok", refuse: 0, n: 4 },
          { host: "g-check.example.test", b: "captcha", refuse: 0, n: 1 }, { host: "g-slow.example.test", b: "timeout", refuse: 0, n: 1 },
        ];
        const people = [P(70), P(71), P(72)];
        for (const u of people) await person(pg, u, "confirmed");
        let k = 0;
        for (const h of plan) for (let i = 0; i < h.n; i++, k++) {
          const r = await enqueue(pg, payload(people[k % people.length], `g:${h.host}:${i}`, `G Co ${k}`, `https://${h.host}/jobs/${i}`));
          if (r !== "queued") fail(`G: setup enqueue ${h.host} ${i}: ${r}`);
        }
        const total = k;
        counts.G = total;
        const approved = JSON.parse(await pg.sql(`select jsonb_object_agg(id, payload_hash || '/' || approval_hash) from public.career_apply_jobs where job_id like 'g:%'`));
        const svc = pg.asService();
        const engine = new Map<string, number>(), attempts = new Map<string, number>(), inFlight = new Set<string>(), notBefore = new Map<string, number>();
        const early: string[] = [];
        let overlap = 0, stop = false;
        const watch = setInterval(async () => { try { if (Number(await pg.sql(`select count(*) from public.career_apply_jobs where job_id like 'g:%' and state in ('queued', 'driving')`)) === 0) stop = true; } catch { /* next tick */ } }, 250);
        const deadline = Date.now() + 60_000;
        const worker = (w: number) => massRun<MassJob & { user_id: string }>({
          claim: async (n) => {
            const c = await svc.rpc("career_apply_claim_fair", { p_now: new Date().toISOString(), p_limit: n, p_per_person: 2 });
            if (c.error) { fail(`G: the claim: ${c.error.message}`); throw Error(c.error.message); }
            return (c.data ?? []).filter((j: any) => String(j.job_id).startsWith("g:")).map((j: any) => ({ id: j.id, lease_token: j.lease_token, url: j.url, user_id: j.user_id, claimed_at: j.claimed_at }));
          },
          run: async (job, onStart) => {
            await onStart();
            const h = plan.find((x) => x.host === hostOf(job.url))!;
            if (inFlight.has(job.id)) overlap++;
            inFlight.add(job.id);
            if (Date.now() + 5 < (notBefore.get(job.id) ?? 0)) early.push(`${job.id} started ${notBefore.get(job.id)! - Date.now()} ms before its time`);
            engine.set(job.id, (engine.get(job.id) ?? 0) + 1);
            const tried = (attempts.get(h.host) ?? 0) + 1;
            attempts.set(h.host, tried);
            await new Promise((r) => setTimeout(r, 5));
            inFlight.delete(job.id);
            if (tried <= h.refuse) {
              const retry = h.b === "rl_date" ? retryAfterSeconds(httpDate(Date.now() + 2000, "imf"), Date.now()) : retryAfterSeconds("1", Date.now());
              return { state: "refused", reason: "HOST_RATE_LIMITED", requeue: true, status: h.b === "busy_503" ? 503 : 429, retry_after_s: retry, recorded: false };
            }
            const res = h.b === "captcha" ? { state: "needs_user", reason: "bot_check" } : h.b === "timeout" ? { state: "unknown_outcome", reason: "the engine gave no result after it started; not retried" }
              : { state: "submitted_unconfirmed", reason: "acknowledged" };
            const f = await svc.rpc("career_apply_finish", { p_id: job.id, p_lease: job.lease_token, p_state: res.state, p_evidence: { reason: res.reason } });
            if (f.error) fail(`G: finish ${job.id}: ${f.error.message}`);
            return { ...res, recorded: !f.error, ...(h.b === "captcha" ? { reason: "CAPTCHA_AT_SUBMIT" } : {}) };
          },
          requeue: async (job, q) => {
            const r = await svc.rpc("career_apply_requeue_refused_for", { p_id: job.id, p_lease: job.lease_token, p_reason: q.reason, p_retry_after_s: q.retryAfterS, p_until: new Date(q.until).toISOString() });
            if (r.error) { fail(`G: requeue ${job.id}: ${r.error.message}`); return { state: "unrecorded", recorded: false }; }
            const nb = Date.parse(r.data.not_before);
            notBefore.set(job.id, nb);
            return { state: "queued", recorded: true, not_before: nb };
          },
          unstarted: async (job, why) => { const f = await svc.rpc("career_apply_finish", { p_id: job.id, p_lease: job.lease_token, p_state: "not_submitted", p_evidence: { reason: why } }); return { state: "not_submitted", reason: why, recorded: !f.error }; },
          orphaned: async () => ({ state: "unknown_outcome", recorded: true }),
          pacing: pacingFrom(() => undefined, { concurrency: 2 + w }), stop: () => stop || Date.now() > deadline,
          gate: dbHostGate(svc, { log: () => {}, cacheMs: 0 }), drain: false, idleMs: 100, log: () => {},
        });
        await Promise.all([worker(0), worker(1), worker(2)]);
        clearInterval(watch);
        if (Date.now() > deadline) fail("G: the workers did not finish the queue in time");
        if (overlap) fail(`G: ${overlap} job(s) driven twice at once`);
        for (const e of early) fail(`G: ${e}`);
        const rows = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'job_id', job_id, 'url', url, 'state', state, 'refusals', host_refusals, 'hash', payload_hash || '/' || approval_hash)), '[]') from public.career_apply_jobs where job_id like 'g:%'`));
        if (rows.length !== total) fail(`G: ${rows.length} rows of ${total} (one row per posting)`);
        const perHost = new Map<string, number>();
        for (const r of rows) {
          const h = plan.find((x) => x.host === hostOf(r.url))!, n = engine.get(r.id) ?? 0;
          perHost.set(h.host, (perHost.get(h.host) ?? 0) + r.refusals);
          if (r.hash !== approved[r.id]) fail(`G ${h.host}: ${r.job_id} its approval or hash changed`);
          if (h.refuse) {
            if (r.state !== "submitted_unconfirmed" || n !== r.refusals + 1) fail(`G ${h.host}: ${r.job_id} ${r.state}, engine x${n}, refused ${r.refusals}: not run again and submitted once`);
          } else {
            const want = ({ ok: "submitted_unconfirmed", captcha: "needs_user", timeout: "unknown_outcome" } as Record<string, string>)[h.b];
            if (r.state !== want || n !== 1 || r.refusals !== 0) fail(`G ${h.host}: ${r.job_id} ${r.state} engine x${n} refused ${r.refusals}, expected ${want} once`);
          }
        }
        for (const h of plan.filter((x) => x.refuse)) if (perHost.get(h.host) !== h.refuse) fail(`G ${h.host}: ${perHost.get(h.host)} refusals recorded, ${h.refuse} given`);
        // The person's own computer (approve-first.ts runLoop over career_apply_claim_own and career_apply_requeue_refused_own).
        const U = P(73);
        await person(pg, U, "confirmed");
        for (let i = 0; i < 3; i++) if (await enqueue(pg, payload(U, `g:own:${i}`, `G Own ${i}`, `https://g-own.example.test/jobs/${i}`)) !== "queued") fail(`G own: setup ${i}`);
        const ownEngine = new Map<string, number>();
        await runLoop({
          log: () => {}, sleep: async () => {}, idleMs: 50, writeFacts: async () => "/tmp/TEST-facts.json", resume: { path: "/tmp/TEST-resume.pdf", sha256: RESUME_SHA },
          queue: ownQueue(pg.asPerson(U)), stop: () => Date.now() > deadline + 30_000, drain: true, pacing: pacingFrom(() => undefined, { concurrency: 2 }),
          runEngine: async (args) => {
            const id = args[args.indexOf("--application-id") + 1], n = (ownEngine.get(id) ?? 0) + 1;
            ownEngine.set(id, n);
            return n === 1 ? { result: { state: "not_submitted", reason: "HOST_RATE_LIMITED", status: 429, retry_after_s: 1 } as any, evidence: null }
              : { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
          },
        });
        const own = JSON.parse(await pg.sql(`select jsonb_agg(jsonb_build_object('id', id, 'state', state, 'refusals', host_refusals)) from public.career_apply_jobs where user_id = '${U}'`));
        for (const r of own) if (r.state !== "submitted_unconfirmed" || r.refusals !== 1 || ownEngine.get(r.id) !== 2) fail(`G own: ${r.id} ${r.state} refused ${r.refusals} engine x${ownEngine.get(r.id) ?? 0}`);
        counts.G += own.length;
        // What the person is told while one waits, from the record: approved and waiting, nothing sent; approving the same
        // posting again adds nothing and is never called a duplicate or "already applied".
        const W = P(74);
        await person(pg, W, "confirmed");
        const wurl = "https://jobs.lever.co/gwaitco/5f1c2d3e-0000-4000-8000-00000000a001";
        const wp = payload(W, postingKey(wurl)!, "Waiting Co", wurl);
        if (await enqueue(pg, wp) !== "queued") fail("G wait: setup");
        const c = await svc.rpc("career_apply_claim_fair", { p_now: new Date().toISOString(), p_limit: 50, p_per_person: 50 });
        const mine = (c.data ?? []).find((j: any) => j.user_id === W);
        if (!mine) { fail("G wait: not claimed"); return; }
        const rq = await svc.rpc("career_apply_requeue_refused_for", { p_id: mine.id, p_lease: mine.lease_token, p_reason: "rate_limited", p_retry_after_s: 600, p_until: null });
        if (rq.error) fail(`G wait: requeue: ${rq.error.message}`);
        const row = JSON.parse(await pg.sql(`select to_jsonb(x) from (select id, company, state, reason, confirmation_id, email_confirmed_at, created_at, updated_at from public.career_apply_jobs where id = '${mine.id}') x`));
        const line = statusLine(row);
        if (!/^Waiting Co: approved, not sent yet; waiting: the employer's site asked us to slow down \(too many requests\); nothing was sent, and it goes again by itself after \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/.test(line)) fail(`G wait: the status line: ${line}`);
        const again = await enqueue(pg, wp);
        if (!/duplicate_job/.test(again)) fail(`G wait: approving it again: ${again}`);
        const card = answerText([{ n: 1, company: "Waiting Co", result: "duplicate" } as any]);
        if (/duplicate|already applied/i.test(card)) fail(`G wait: the card says ${card}`);
        const q = await queueWants(supabaseWantStore(adminShim(pg)), W, [{ url: wp.url, job_id: wp.job_id, company: wp.company, title: "TEST" }], Date.now());
        const said = q.refused.map((x) => x.said).join(" | ");
        if (q.queued !== 0 || !/already in your applications/.test(said) || /duplicate|already applied/i.test(said)) fail(`G wait: the chat's queue: queued ${q.queued}: ${said}`);
        if (Number(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${W}'`)) !== 1) fail("G wait: more than one row for the posting");
        counts.G += 1;
        console.log(`[apply e2e] G: ${total} cloud + ${own.length} own applications, ${[...engine.values()].reduce((a, b) => a + b, 0)} engine starts, every refused job submitted once`);
      });

      // ------------------------------------------------------------------------------------------------ H claimed, never started
      await t.step("H unstarted: cloud workers stopped mid-batch and out of their lease budget, beside hosts that answer, check, time out or answer a 503 with no Retry-After, and the person's computer stopped mid-batch: every claim let go before its engine started is the same row queued again with its hash and is submitted once later; nothing started is put back", async () => {
        await pg.sql(`update public.career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before H' where state = 'queued'`);
        const plan = [
          { host: "h-ok1.example.test", b: "ok", n: 4 }, { host: "h-ok2.example.test", b: "ok", n: 3 }, { host: "h-503.example.test", b: "busy_503_none", n: 2 },
          { host: "h-check.example.test", b: "captcha", n: 1 }, { host: "h-slow.example.test", b: "timeout", n: 1 },
        ];
        const people = [P(80), P(81)];
        for (const u of people) await person(pg, u, "confirmed");
        let k = 0;
        for (const h of plan) for (let i = 0; i < h.n; i++, k++) {
          const r = await enqueue(pg, payload(people[k % people.length], `h:${h.host}:${i}`, `H Co ${k}`, `https://${h.host}/jobs/${i}`));
          if (r !== "queued") fail(`H: setup enqueue ${h.host} ${i}: ${r}`);
        }
        const total = k;
        counts.H = total;
        const approved = JSON.parse(await pg.sql(`select jsonb_object_agg(id, payload_hash || '/' || approval_hash) from public.career_apply_jobs where job_id like 'h:%'`));
        const svc = pg.asService();
        const engine = new Map<string, number>(), refused = new Set<string>(), inFlight = new Set<string>(), back: Record<string, number> = {}, putBackOf = new Map<string, number>();
        let overlap = 0;
        // The hosts' refusals held a few milliseconds here (the gate's real waits are the scenario battery's).
        const holds = new Map<string, number>();
        const gate: HostGate = { shared: true, async until(hosts) { return new Map(hosts.map((h) => [h, holds.get(h) ?? 0])); },
          async refused(host, _why, _s, at) { const u = at + 40; holds.set(host, u); return u; }, async ok() {} };
        const deadline = Date.now() + 60_000;
        const worker = (o: { stopAfter?: number; budgetMs?: number; until: () => boolean }) => {
          let starts = 0;
          return massRun<MassJob & { user_id: string }>({
            claim: async (n) => {
              const c = await svc.rpc("career_apply_claim_fair", { p_now: new Date().toISOString(), p_limit: n, p_per_person: 10 });
              if (c.error) { fail(`H: the claim: ${c.error.message}`); throw Error(c.error.message); }
              return (c.data ?? []).filter((j: any) => String(j.job_id).startsWith("h:")).map((j: any) => ({ id: j.id, lease_token: j.lease_token, url: j.url, user_id: j.user_id, claimed_at: j.claimed_at }));
            },
            run: async (job, onStart) => {
              await onStart();
              starts++;
              const h = plan.find((x) => x.host === hostOf(job.url))!;
              if (inFlight.has(job.id)) overlap++;
              inFlight.add(job.id);
              engine.set(job.id, (engine.get(job.id) ?? 0) + 1);
              await new Promise((r) => setTimeout(r, 5));
              inFlight.delete(job.id);
              if (h.b === "busy_503_none" && !refused.has(job.id)) {
                refused.add(job.id);
                return { state: "refused", reason: "HOST_RATE_LIMITED", requeue: true, status: 503, retry_after_s: null, recorded: false };
              }
              const res = h.b === "captcha" ? { state: "needs_user", reason: "bot_check" } : h.b === "timeout" ? { state: "unknown_outcome", reason: "the engine gave no result after it started; not retried" }
                : { state: "submitted_unconfirmed", reason: "acknowledged" };
              const f = await svc.rpc("career_apply_finish", { p_id: job.id, p_lease: job.lease_token, p_state: res.state, p_evidence: { reason: res.reason } });
              if (f.error) fail(`H: finish ${job.id}: ${f.error.message}`);
              return { ...res, recorded: !f.error, ...(h.b === "captcha" ? { reason: "CAPTCHA_AT_SUBMIT" } : {}) };
            },
            requeue: async (job, q) => {
              const r = await svc.rpc("career_apply_requeue_refused_for", { p_id: job.id, p_lease: job.lease_token, p_reason: q.reason, p_retry_after_s: q.retryAfterS, p_until: new Date(q.until).toISOString() });
              if (r.error) { fail(`H: requeue ${job.id}: ${r.error.message}`); return { state: "unrecorded", recorded: false }; }
              return { state: "queued", recorded: true, not_before: Date.parse(r.data.not_before) };
            },
            // The cloud worker's put-back (restQueue.putBack): career_apply_requeue_unstarted_for.
            putBack: async (job, why, until) => {
              const r = await svc.rpc("career_apply_requeue_unstarted_for", { p_id: job.id, p_lease: job.lease_token, p_why: why.split(":")[0].toLowerCase(), p_until: new Date(until).toISOString() });
              if (r.error) { fail(`H: put back ${job.id} (${why}): ${r.error.message}`); return { state: "unrecorded", recorded: false }; }
              back[why] = (back[why] ?? 0) + 1;
              putBackOf.set(job.id, (putBackOf.get(job.id) ?? 0) + 1);
              // The same row, as before its claim, with its approval: queued, no lease, its hash.
              const row = JSON.parse(await pg.sql(`select jsonb_build_object('state', state, 'lease', lease_token, 'source', source, 'hash', payload_hash || '/' || approval_hash) from public.career_apply_jobs where id = '${job.id}'`));
              if (row.state !== "queued" || row.lease !== null || row.source !== null || row.hash !== approved[job.id]) fail(`H: put back ${job.id}: ${JSON.stringify(row)}`);
              if ((engine.get(job.id) ?? 0) > (refused.has(job.id) ? 1 : 0)) fail(`H: ${job.id} put back after its engine started`);
              return { state: "queued", reason: why, recorded: true, not_before: Date.parse(r.data.not_before) };
            },
            unstarted: async (job, why) => { fail(`H: ${job.id} ended unsent (${why})`); const f = await svc.rpc("career_apply_finish", { p_id: job.id, p_lease: job.lease_token, p_state: "not_submitted", p_evidence: { reason: why } }); return { state: "not_submitted", reason: why, recorded: !f.error }; },
            orphaned: async () => ({ state: "unknown_outcome", recorded: true }),
            // Spacing between starts on one host keeps claims waiting, so a stop or a short budget finds some unstarted.
            pacing: { ...pacingFrom(() => undefined, { concurrency: 3, hostSpacingMs: o.budgetMs ? 2 * o.budgetMs : 30 }), ...(o.budgetMs ? { startBudgetMs: o.budgetMs } : {}) },
            stop: () => (o.stopAfter !== undefined && starts >= o.stopAfter) || o.until() || Date.now() > deadline,
            gate, drain: true, idleMs: 20, log: () => {},
          });
        };
        const open = async () => Number(await pg.sql(`select count(*) from public.career_apply_jobs where job_id like 'h:%' and state in ('queued', 'driving')`));
        // 1. Stopped after two engine starts: what it claimed and had not started goes back.
        await worker({ stopAfter: 2, until: () => false });
        // 2. A lease budget (80 ms, above a claim's round trip) shorter than the spacing between starts on one host: what
        //    waits too long goes back (stopped after a few, so a slow machine never stalls the step on its own budget).
        await worker({ budgetMs: 80, until: () => (back.NOT_STARTED_IN_LEASE ?? 0) >= 4 });
        // 3. A plain worker drains whatever is left (a job waiting on its host's hold).
        for (let i = 0; i < 50 && await open() > 0 && Date.now() < deadline; i++) await worker({ until: () => false });
        if (Date.now() > deadline) fail("H: the workers did not finish the queue in time");
        if (overlap) fail(`H: ${overlap} job(s) driven twice at once`);
        if (!(back.WORKER_STOPPING > 0)) fail(`H: no claim was put back when the worker stopped: ${JSON.stringify(back)}`);
        if (!(back.NOT_STARTED_IN_LEASE > 0)) fail(`H: no claim was put back for its lease budget: ${JSON.stringify(back)}`);
        const rows = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'job_id', job_id, 'url', url, 'state', state, 'refusals', host_refusals,
          'hash', payload_hash || '/' || approval_hash)), '[]') from public.career_apply_jobs where job_id like 'h:%'`));
        if (rows.length !== total) fail(`H: ${rows.length} rows of ${total} (one row per posting)`);
        for (const r of rows) {
          const h = plan.find((x) => x.host === hostOf(r.url))!, n = engine.get(r.id) ?? 0;
          if (r.hash !== approved[r.id]) fail(`H ${h.host}: ${r.job_id} its approval or hash changed`);
          const want = ({ ok: "submitted_unconfirmed", busy_503_none: "submitted_unconfirmed", captcha: "needs_user", timeout: "unknown_outcome" } as Record<string, string>)[h.b];
          const runs = h.b === "busy_503_none" ? 2 : 1;
          if (r.state !== want || n !== runs) fail(`H ${h.host}: ${r.job_id} ${r.state}, engine x${n} (put back ${putBackOf.get(r.id) ?? 0}, refused ${r.refusals}): expected ${want}, engine x${runs}`);
          if (h.b === "busy_503_none" && r.refusals !== 1) fail(`H ${h.host}: ${r.job_id} a 503 with no Retry-After not recorded as a refusal for load (${r.refusals})`);
        }
        // The person's own computer (approve-first.ts runLoop over career_apply_requeue_unstarted_own), stopped mid-batch.
        const U = P(82);
        await person(pg, U, "confirmed");
        for (let i = 0; i < 4; i++) if (await enqueue(pg, payload(U, `h:own:${i}`, `H Own ${i}`, `https://h-own.example.test/jobs/${i}`)) !== "queued") fail(`H own: setup ${i}`);
        const ownEngine = new Map<string, number>();
        let ownStarts = 0, ownStop = false;
        const ownRun = () => runLoop({
          log: () => {}, sleep: async () => {}, idleMs: 20, writeFacts: async () => "/tmp/TEST-facts.json", resume: { path: "/tmp/TEST-resume.pdf", sha256: RESUME_SHA },
          queue: ownQueue(pg.asPerson(U)), stop: () => ownStop || Date.now() > deadline + 30_000, drain: true, pacing: pacingFrom(() => undefined, { concurrency: 2, hostSpacingMs: 30 }),
          runEngine: async (args) => {
            const id = args[args.indexOf("--application-id") + 1];
            ownEngine.set(id, (ownEngine.get(id) ?? 0) + 1);
            if (++ownStarts >= 1) ownStop = true;
            return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
          },
        });
        await ownRun();
        const waiting = Number(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${U}' and state = 'queued' and evidence ? 'unstarted'`));
        if (waiting < 1) fail(`H own: the person's computer stopped and put nothing back (${waiting})`);
        ownStop = false; ownStarts = -1e9;
        await ownRun();
        const own = JSON.parse(await pg.sql(`select jsonb_agg(jsonb_build_object('id', id, 'state', state)) from public.career_apply_jobs where user_id = '${U}'`));
        for (const r of own) if (r.state !== "submitted_unconfirmed" || ownEngine.get(r.id) !== 1) fail(`H own: ${r.id} ${r.state} engine x${ownEngine.get(r.id) ?? 0}`);
        counts.H += own.length;
        console.log(`[apply e2e] H: ${total} cloud + ${own.length} own applications; put back ${JSON.stringify(back)} (cloud), ${waiting} (own, stopped); each submitted once`);
      });
    } finally {
      await pg.stop();
    }
    const n = Object.entries(counts).filter(([k]) => k !== "A_keys").reduce((a, [, v]) => a + v, 0);
    console.log(`[apply e2e] ${n} scenarios end to end (${JSON.stringify(counts)}), ${fails.length} failures${fails.length ? "\n  " + fails.slice(0, 30).join("\n  ") : ""}`);
    eq(fails, [], fails.join("\n"));
  },
});
