// Round 2 of the apply flow on real Postgres (architect, 2026-10-30): a seeded sample of the hostile forms of
// scenarios-apply-r2-forms*.test.ts (tests/architect/scenarios/apply-r2-generator.ts) end to end through the deployed queue,
// on Postgres 16 with every migration (tests/flow/pg.ts), judged by the database's own rows and the employer's own record:
//   A  forms      ~70 forms: the card made by the real engine's dry run over the fake browser (approve-first.ts prepare),
//                 approved into the queue with its exact hash (career_apply_enqueue), the world turned against it, and the
//                 person's computer draining the queue (approve-first.ts runLoop over career_apply_claim_own /
//                 career_apply_finish_own) with the real engine: the employer gets the approved body once or nothing; the
//                 row's state is the truth (never not_submitted once the employer took it, so the same posting under
//                 another key is refused as already applied: career_apply_ledger_refusal counts the state); the chat's
//                 status line for the row says the same
//   B  kills      the person's computer killed after the send, after the engine before the record, with a record whose
//                 reply was lost after it committed and with records that cannot be written (the database failing over):
//                 the employer got it once, the row is never re-driven, and it ends as what is known
//   C  boards     the same job on Greenhouse's two boards and an employer through two application systems, approved into
//                 the queue: one posting once, two postings twice
// No model, no network, no Chromium: the employer is the fake browser's site; the engine is scripts/apply.ts in-process.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { type FormCase, formCases, rng, sample, SEED } from "./scenarios/apply-r2-generator.ts";
import { inProcessEngine, type World, world } from "./scenarios/apply-r2-world.ts";
import { expectedAfterSend, FORMS } from "./scenarios-apply-r2-forms.ts";
import { type Job, ownQueue, prepare, runLoop } from "../../workers/career-browser/approve-first.ts";
import { type Journal, type JournalEntry, localHostGate, pacingFrom } from "../../workers/career-browser/mass-run.ts";
import { COUNTED_STATES } from "../../supabase/functions/_shared/career_apply.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const lit = (v: unknown) => `$q$${typeof v === "string" ? v : JSON.stringify(v)}$q$`;
const STOPS = new Set(["rename_label", "add_required", "remove_option", "rename_name", "password", "identity", "hidden_consent", "captcha_open", "captcha_next", "captcha_click",
  "redirect_open", "refuse_open", "click_rewrite", "click_add_field", "click_swap_file", "maxlength", "reformat", "resume_swap"]);

// Setup, not the person acting: an account at epoch 0, a confirmed resume entry, and the resume file the queue keeps.
async function person(pg: Pg, w: World) {
  const id = w.c.person.id, ev = `apply-r2-${id.slice(-8)}`;
  await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test') on conflict do nothing;
    insert into public.profiles (id) values ('${id}') on conflict do nothing;
    insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', ${lit({ epoch: 0, version: 0, paused: false, memory: { profile: { facts: [{ id: "resume-1", kind: "experience", text: "TEST Analyst, TEST Co", confirmation_event_id: ev, status: "confirmed", needs_confirmation: false }] } } })}::jsonb)
      on conflict (user_id, key) do update set value = excluded.value;
    insert into public.career_events (user_id, kind, subject, detail, source) values ('${id}', 'fact_confirmed', 'resume entry', ${lit({ confirmation_event_id: ev })}::jsonb, 'chat');
    insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
      values ('${id}', '${w.resumeSha}', 'resume.pdf', decode('${btoa(String.fromCharCode(...w.resumeBytes))}', 'base64'), 0) on conflict do nothing;`);
}
async function enqueue(pg: Pg, p: unknown) {
  const h = await pg.sql(`select public.career_apply_payload_hash(${lit(p)}::jsonb)`);
  const r = await pg.asService().rpc("career_apply_enqueue", { p_payload: p, p_hash: h, p_approval: h });
  return r.error ? r.error.message : "queued";
}
const row = async (pg: Pg, user: string, jobId: string) =>
  JSON.parse(await pg.sql(`select coalesce((select to_jsonb(x) from (select id, company, state, reason, confirmation_id, url, created_at, updated_at from public.career_apply_jobs where user_id = '${user}' and job_id = ${lit(jobId)}) x), 'null')`));
const quiet = { log: () => {}, sleep: async () => {}, idleMs: 1, gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: 1 }), drain: true, stop: () => false };
const never = <T>() => new Promise<T>(() => {});
// The engine's clock is the database's (real time): the queue's leases and the engine's records agree.
const realNow = Date.now.bind(Date);

Deno.test({
  name: "apply r2 on real Postgres: hostile forms through the queue and the real engine, kills after the send, one job on two boards",
  sanitizeResources: false, sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres"); return; }
    const pg = await startPg();
    const root = await Deno.makeTempDir({ prefix: "apply-r2-pg-" });
    const fails: string[] = [];
    const fail = (m: string) => { fails.push(m); };
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
    try {
      // ------------------------------------------------------------------------------------------------ A forms
      await t.step("A forms: prepared, approved into the queue, turned, drained by the person's computer: the approved body once or nothing, the row the truth", async () => {
        const all = formCases(SEED, FORMS).filter((c) => c.lang === "en" && !["fact_edit", "other_approval", "twice"].includes(c.twist));
        // Every after-page and every twist at least once, then a random sample.
        const pick: FormCase[] = [];
        for (const a of new Set(all.map((c) => c.after))) pick.push(all.find((c) => c.after === a && c.twist === "none")!);
        for (const tw of new Set(all.map((c) => c.twist))) pick.push(all.find((c) => c.twist === tw && !pick.includes(c))!);
        pick.push(...sample(rng(SEED + 300), all.filter((c) => !pick.includes(c)), 70 - pick.length));
        for (const c of pick.filter(Boolean)) {
          const w = await world(c, root);
          await person(pg, w);
          const engine = inProcessEngine(w, () => realNow());
          const name = `#${c.n} ${c.twist}/${c.after}`;
          const prep = await prepare({ url: c.posting, factsPath: w.factsPath, resumePath: w.resumePath, account: { epoch: 0, version: 0 }, now: Date.now(), runEngine: engine });
          bump("A");
          if (!prep.ready) { bump("A_not_ready"); if (c.twist === "none") fail(`A ${name}: a plain form was not prepared: ${JSON.stringify(prep.result).slice(0, 200)}`); continue; }
          const payload: any = prep.payload;
          const q = await enqueue(pg, payload);
          if (q !== "queued") { fail(`A ${name}: the approval was not queued: ${q}`); continue; }
          w.phase = "submit";
          if (c.twist === "resume_swap") await Deno.writeFile(w.resumePath, new TextEncoder().encode("%PDF-1.4 TEST another resume, swapped after the yes"));
          await runLoop({ ...quiet, queue: ownQueue(pg.asPerson(c.person.id)), resume: { path: w.resumePath, sha256: payload.resume_sha256 }, runEngine: engine,
            writeFacts: async (_j, facts) => { const p = `${w.dir}/approved-${crypto.randomUUID()}.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; } });
          const r = await row(pg, c.person.id, payload.job_id);
          const posts = w.posts.length;
          if (posts > 1) fail(`A ${name}: the employer got ${posts} bodies`);
          if (STOPS.has(c.twist) && posts) fail(`A ${name}: sent anyway (${r?.state} ${r?.reason})`);
          if (c.twist === "none" && posts !== 1) fail(`A ${name}: a plain approved application was not sent (${r?.state} ${r?.reason})`);
          if (posts === 1) {
            bump("A_sent");
            // The database keeps a page's thank-you as sent and unconfirmed until the employer's email confirms it (WO-032).
            const want = expectedAfterSend(c).flatMap((x) => (x === "confirmed" ? ["confirmed", "submitted_unconfirmed"] : [x]));
            if (!want.includes(r?.state)) fail(`A ${name}: the row is ${r?.state} (${r?.reason}), expected ${want.join("/")}`);
            if (!COUNTED_STATES.has(r?.state) && r?.state !== "failed") fail(`A ${name}: the employer took it and the row does not count it: ${r?.state}`);
            // (A form the employer answered with validation errors is "failed": the chat's line for it is checked by
            // tests/architect/apply-here.test.ts and left as it is.)
            if (r?.state !== "failed" && /stopped before it was sent|not sent \(/.test(statusLine(r))) fail(`A ${name}: the chat says it was not sent: ${statusLine(r)}`);
            // The same posting approved again under another key (the chat's link key): refused while the row counts it.
            if (r?.state !== "failed") {
              const again = await enqueue(pg, { ...payload, job_id: `${payload.job_id}#again` });
              if (!/duplicate_job/.test(again)) fail(`A ${name}: the same posting approved again after the employer took it -> ${again} (row ${r?.state})`);
            }
          } else if (["confirmed", "submitted_unconfirmed"].includes(r?.state)) fail(`A ${name}: recorded ${r?.state} with nothing received`);
          if (r && ["queued", "driving"].includes(r.state)) fail(`A ${name}: left ${r.state}`);
          await Deno.remove(w.dir, { recursive: true }).catch(() => {});
        }
      });

      // ------------------------------------------------------------------------------------------------ B kills
      await t.step("B kills: after the send, after the engine before the record, a lost reply, a database failing over: once, never re-driven, ends as known", async () => {
        const points = ["engine_after_send", "after_engine_before_record", "record_lost_reply", "record_fails"] as const;
        const base = formCases(SEED + 900, 600).filter((c) => c.lang === "en" && c.twist === "none" && c.pages === 1).map((c) => ({ ...c, after: "thanks" as const }));
        let k = 0;
        for (const point of [...points, ...points, ...points]) {
          const c = { ...base[k], n: 90_000 + k };
          k++;
          const w = await world(c, root);
          await person(pg, w);
          const engine = inProcessEngine(w, () => realNow());
          const prep = await prepare({ url: c.posting, factsPath: w.factsPath, resumePath: w.resumePath, account: { epoch: 0, version: 0 }, now: Date.now(), runEngine: engine });
          if (!prep.ready) { fail(`B ${point}: not prepared: ${JSON.stringify(prep.result).slice(0, 200)}`); continue; }
          const payload: any = prep.payload;
          if (await enqueue(pg, payload) !== "queued") { fail(`B ${point}: not queued`); continue; }
          w.phase = "submit";
          const me = pg.asPerson(c.person.id);
          const entries = new Map<string, JournalEntry<Job>>();
          const lives = [{ dead: false }, { dead: false }];
          let died!: () => void;
          const death = new Promise<void>((res) => { died = res; });
          const die = () => { if (!lives[0].dead) { lives[0].dead = true; died(); } };
          const journal = (wk: number): Journal<Job> => ({
            async put(job, claimedAt) { if (lives[wk].dead) return await never(); entries.set(job.id, { job: structuredClone(job), claimedAt, started: false }); },
            async start(id) { if (lives[wk].dead) return await never(); entries.set(id, { ...entries.get(id)!, started: true }); },
            async done(id) { if (lives[wk].dead) return await never(); entries.delete(id); },
            async list() { return [...entries.values()]; },
          });
          let lost = 0;
          const client = (wk: number) => ({
            rpc: async (name: string, a: any) => {
              if (lives[wk].dead) return await never<any>();
              if (name === "career_apply_finish_own" && wk === 0) {
                if (point === "after_engine_before_record") { die(); return await never<any>(); }
                if (point === "record_fails") return { data: null, error: { code: "08006", message: "connection failure (failover)" } };
              }
              const out = await me.rpc(name, a);
              if (name === "career_apply_finish_own" && point === "record_lost_reply" && lost++ === 0) return { data: null, error: { code: "08006", message: "connection lost after commit" } };
              return out;
            },
          });
          const engineOf = (wk: number) => async (args: string[], env?: Record<string, string>, ctl?: any) => {
            if (lives[wk].dead) return await never<any>();
            const r = await engine(args, env, ctl);
            if (wk === 0 && point === "engine_after_send") { die(); return await never<any>(); }
            return r;
          };
          const writeFacts = async (_j: Job, facts: unknown) => { const p = `${w.dir}/approved-${crypto.randomUUID()}.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; };
          const w1 = runLoop({ ...quiet, queue: ownQueue(client(0)), resume: { path: w.resumePath, sha256: payload.resume_sha256 }, journal: journal(0), runEngine: engineOf(0), writeFacts });
          await Promise.race([death, w1]);
          lives[0].dead = true;
          await runLoop({ ...quiet, queue: ownQueue(client(1)), resume: { path: w.resumePath, sha256: payload.resume_sha256 }, journal: journal(1), runEngine: engineOf(1), writeFacts });
          await pg.asService().rpc("career_apply_sweep", { p_now: new Date(Date.now() + 16 * 60_000).toISOString() });
          const r = await row(pg, c.person.id, payload.job_id);
          bump(`B_${point}`);
          if (w.posts.length !== 1) fail(`B ${point}: the employer got ${w.posts.length} bodies`);
          const want = point === "record_lost_reply" ? ["confirmed", "submitted_unconfirmed"] : ["unknown_outcome"];
          if (!want.includes(r?.state)) fail(`B ${point}: the row is ${r?.state} (${r?.reason}), expected ${want.join("/")}`);
          const again = await enqueue(pg, { ...payload, job_id: `${payload.job_id}#again` });
          if (!/duplicate_job/.test(again)) fail(`B ${point}: the same posting approved again -> ${again}`);
          await Deno.remove(w.dir, { recursive: true }).catch(() => {});
        }
      });

      // ------------------------------------------------------------------------------------------------ C boards
      await t.step("C boards: the same job on two Greenhouse boards is one posting; one employer through Lever and Ashby is two", async () => {
        const c0 = formCases(SEED + 950, 1)[0];
        const w = await world({ ...c0, n: 95_000 }, root);
        await person(pg, w);
        const U = c0.person.id;
        const base = (jobId: string, url: string, company: string) => ({ version: 1, user_id: U, job_id: jobId, company, url, fields: [], privacy_epoch: 0, account_version: 0,
          expires_at: "2099-01-01T00:00:00Z", engine_approval: "e".repeat(64), resume_sha256: w.resumeSha, destination: url });
        const r = rng(SEED + 951);
        for (let i = 0; i < 12; i++) {
          const id = String(7_100_000 + r.int(0, 99_999)), t = r.pick(["acme", "contoso", "northwind"]);
          const a = await enqueue(pg, base(`greenhouse:${t}:${id}`, `https://job-boards.greenhouse.io/${t}/jobs/${id}`, `${t} Co`));
          const b = await enqueue(pg, base(`greenhouse.io/jobs/${id}`, `https://boards.greenhouse.io/${t}/jobs/${id}?gh_src=r2`, `${t} Co`));
          if (a !== "queued" || !/duplicate_job/.test(b)) fail(`C same job on two boards ${id}: ${a} / ${b}`);
          const uuid = `${id}-aaaa-4bbb-8ccc-0000000000${String(i).padStart(2, "0")}`;
          const l = await enqueue(pg, base(`lever:${t}:${uuid}`, `https://jobs.lever.co/${t}/${uuid}`, `${t} Co`));
          const s = await enqueue(pg, base(`ashby:${t}:${uuid}`, `https://jobs.ashbyhq.com/${t}/${uuid}`, `${t} Co`));
          if (l !== "queued" || s !== "queued") fail(`C one employer through two systems ${t}: ${l} / ${s}`);
          bump("C");
        }
        await pg.sql(`update public.career_apply_jobs set state = 'not_submitted', reason = 'TEST closed after C' where user_id = '${U}' and state = 'queued'`);
      });
    } finally {
      await pg.stop();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
    console.log(`[apply r2 e2e] ${JSON.stringify(counts)}`);
    eq(fails, [], fails.slice(0, 20).join("\n"));
  },
});
