// MASS APPLY (2026-11-01, architect decision (B)): an application the form stopped for a question added after the
// approval (not_submitted, needs_answers) is prepared again and goes only on a NEW card with a NEW approval; the old row is
// immutable history. On a real Postgres 16 with every migration (card-cloud bridge included) and the launch reconcile:
//   R1  the job ending needs_answers puts the posting back in the queue (waiting) and asks for a preparation
//   R2  the candidates offer it again; a prepared row older than the stop does not hold it back
//   R3  a new card's approval of the NEW payload makes a NEW row; the old row is unchanged (payload, hash, state, source)
//   R4  at most ONE live row per person and posting, by the index: two concurrent approvals make one row
//   R5  duplicate_job still holds for every other state (queued, driving, submitted_unconfirmed, needs_user, failed,
//       not_submitted for any other reason)
//   R6  readers: status lists the new row, not the superseded history; posting_sent ignores it; the per-ATS waiver
//       (D-010) still counts every cloud drive that ran, history included
//   R7  reconcile (scripts/launch/verify-claim-guards.sql) keeps every rewrite
//   R9  waiver: max_sends=1 and one drive that ended needs_answers leave 0; the re-preparation is asked with the person's
//       own pace (career_apply_daily_limit), not null
//   R10 readers by job_id (as the SQL): the jobs page's appRow (supabase-js over the PostgREST double) and the chat's
//       liveRows pick the live row of a history+live pair whose links differ
// Red on the parent (#384): R1-R4 and R6 fail without the migration.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000a0b01";
const JOB = "greenhouse:reprep:5100001", URL_ = "https://boards.greenhouse.io/reprep/jobs/5100001";
const JOB2 = "greenhouse:reprep:5100002", URL2 = "https://boards.greenhouse.io/reprep/jobs/5100002";

Deno.test({
  name: "(B) needs_answers: re-queued, re-prepared, a NEW row on a NEW approval; one live row per posting; readers and guards hold",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg = await startPg({ includeBridge: true });
    const q = (s: string) => pg.sql(s);
    const json = async (s: string) => JSON.parse((await q(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
    let ok = true;
    const step = async (name: string, fn: () => Promise<void>) => { if (ok) ok = await t.step(name, fn); };
    try {
      await q(Deno.readTextFileSync(`${ROOT}/scripts/launch/verify-claim-guards.sql`).replace(/^\\.*$/gm, ""));
      await q(`insert into auth.users (id, email) values ('${U}', 'reprep@example.test'); insert into public.profiles (id) values ('${U}');
        insert into public.career_watch_kv (user_id, key, value) values ('${U}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${confirmedResumeSql(U)}
        insert into storage.objects (bucket_id, name) values ('career-resumes', '${U}/' || repeat('a', 64) || '.pdf') on conflict do nothing;
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
        values ('${JOB}', 'greenhouse', 'reprep', 'TEST Reprep', 'Frontend Engineering Intern', 'Chicago, IL', '${URL_}', 'Build UI.', now(), now());`);
      // A prepared application, shown on a card and approved (the database's own functions, as the card path calls them).
      // via "prepare_for": stored the way the preparation stores it (career_apply_prepare_for, with its duplicate_job check);
      // via "insert": written straight in, to show the card path's own guards while a live row already exists.
      const prepareAndApprove = async (why: string, o: { via?: "prepare_for" | "insert"; job?: string; url?: string } = {}) => {
        const job = o.job ?? JOB, url = o.url ?? URL_;
        const pl = `jsonb_build_object('version',1,'user_id','${U}','job_id','${job}','company','TEST Reprep','url','${url}','title','Frontend Engineering Intern',
          'fields',jsonb_build_array(jsonb_build_object('name','first_name','label','First name','value','Alex'),jsonb_build_object('name','why','label','Why?','value',${`'${why}'`})),
          'privacy_epoch',0,'account_version',0,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64))`;
        const lines = `array['TEST Reprep: Frontend Engineering Intern', 'Why?: ${why}']`;
        const p = JSON.parse(o.via === "prepare_for"
          ? await q(`select json_build_object('id', r.id, 'hash', r.payload_hash) from public.career_apply_prepare_for('${U}', '${job}', ${pl}, ${lines}) r`)
          : await q(`with p as (select ${pl} as pl) insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines)
          select '${U}', '${job}', 'TEST Reprep', '${url}', pl, public.career_apply_payload_hash(pl), ${lines} from p
          returning json_build_object('id', id, 'hash', payload_hash)`));
        const card = JSON.parse(await q(`select row_to_json(c) from public.career_apply_card_open_for('${U}', array['${p.id}']::uuid[], now()) c`));
        const res = JSON.parse(await q(`select public.career_apply_card_answer_for('${U}', '${card.id}', '{1}', now())::text`));
        return { prepared: p, card, res };
      };
      const rows = (job = JOB) => json(`select id, state, reason, payload_hash, source, attempts from public.career_apply_jobs where user_id = '${U}' and job_id = '${job}' order by created_at`);
      const driveToNeedsAnswers = async (id: string) => {
        await q(`update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = gen_random_uuid(), source = 'cloud' where id = '${id}'`);
        const lease = await q(`select lease_token from public.career_apply_jobs where id = '${id}'`);
        await q(`select public.career_apply_finish('${id}', '${lease}', 'not_submitted', '{"reason":"needs_answers","nothing_sent":true}'::jsonb)`);
      };
      let first: any;

      await step("the first approval queues one row; the cloud drives it and the form stops it: needs_answers (nothing sent)", async () => {
        const a = await prepareAndApprove("first answer");
        eq(a.res.map((r: any) => r.result), ["queued"]);
        first = (await rows())[0];
        await q(`update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = gen_random_uuid(), source = 'cloud' where id = '${first.id}'`);
        const lease = await q(`select lease_token from public.career_apply_jobs where id = '${first.id}'`);
        await q(`select public.career_apply_finish('${first.id}', '${lease}', 'not_submitted', '{"reason":"needs_answers","nothing_sent":true}'::jsonb)`);
        first = (await rows())[0];
        eq([first.state, first.reason], ["not_submitted", "needs_answers"]);
      });

      await step("R1/R2: back in the queue, a preparation asked for, and a candidate again (the old prepared row does not hold it)", async () => {
        eq(await q(`select state from public.career_apply_wanted where user_id = '${U}' and posting_key = '${JOB}'`), "waiting");
        eq(await q(`select count(*) from public.career_apply_prepare_requests where user_id = '${U}' and '${JOB}' = any(job_ids) and state = 'queued'`), "1");
        const c = await json(`select job_id from public.career_apply_prepare_candidates(now(), 25, 500) where user_id = '${U}'`);
        eq(c.map((x: any) => x.job_id), [JOB]);
        eq(await q(`select count(*) from public.career_apply_prepare_requests where user_id = '${U}' and '${JOB}' = any(job_ids) and outcome ? 'waiting_for'`), "0",
          "no pace set: nothing waits");
      });

      let second: any;
      await step("R3: the re-prepared application is shown on a NEW card; its approval makes a NEW row; the old row is unchanged", async () => {
        const before = JSON.stringify(first);
        // Stored through career_apply_prepare_for, as the preparation stores it: the history row does not make it a duplicate.
        const b = await prepareAndApprove("second answer, with the new question", { via: "prepare_for" });
        eq(b.res.map((r: any) => r.result), ["queued"], JSON.stringify(b.res));
        const all = await rows();
        eq(all.length, 2);
        eq(JSON.stringify(all[0]), before, "the history row is exactly as it was");
        second = all[1];
        eq([second.state, second.payload_hash], ["queued", b.prepared.hash]);
        assert(second.payload_hash !== first.payload_hash, "a new payload, a new approval");
      });

      await step("R4: one live row per posting, by the index: a third approval (and two at once) is a duplicate", async () => {
        const c = await prepareAndApprove("third");
        eq(c.res.map((r: any) => r.result), ["duplicate"]);
        let refused = 0;
        try { await q(`insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash)
          select user_id, job_id, company, url, payload, payload_hash, approval_hash from public.career_apply_jobs where id = '${second.id}'`); } catch { refused++; }
        eq(refused, 1, "the index refuses a second live row, whatever the code says");
        // Two concurrent approvals of two fresh cards after a second needs_answers: one row.
        await q(`update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = now(), lease_token = gen_random_uuid(), source = 'cloud' where id = '${second.id}'`);
        const lease = await q(`select lease_token from public.career_apply_jobs where id = '${second.id}'`);
        await q(`select public.career_apply_finish('${second.id}', '${lease}', 'not_submitted', '{"reason":"needs_answers"}'::jsonb)`);
        const [x, y] = await Promise.all([prepareAndApprove("race one"), prepareAndApprove("race two")].map((p) => p.catch((e) => ({ res: [{ result: String(e) }] }))));
        const results = [...x.res, ...y.res].map((r: any) => r.result).sort();
        eq(results.filter((r) => r === "queued").length, 1, `exactly one of two concurrent approvals queues: ${results}`);
        eq((await rows()).filter((r: any) => !(r.state === "not_submitted" && r.reason === "needs_answers")).length, 1, "one live row");
      });

      await step("R5: duplicate_job still holds for every other state", async () => {
        const live = (await rows()).find((r: any) => r.state === "queued")!;
        for (const [state, reason] of [["queued", null], ["submitted_unconfirmed", null], ["needs_user", "bot_check"], ["failed", "x"], ["not_submitted", "posting_closed"], ["not_submitted", "FACTS_EXPIRED"]]) {
          await q(`set session_replication_role = replica; update public.career_apply_jobs set state = '${state}', reason = ${reason ? `'${reason}'` : "null"} where id = '${live.id}'; set session_replication_role = origin;`);
          let refused = "";
          try { await prepareAndApprove(`dup-pf ${state} ${reason}`, { via: "prepare_for" }); } catch (e) { refused = String((e as Error).message); }
          assert(/duplicate_job/.test(refused), `${state}/${reason}: career_apply_prepare_for still refuses a live row: ${refused.slice(0, 200)}`);
          const d = await prepareAndApprove(`dup ${state} ${reason}`);
          eq(d.res.map((r: any) => r.result), ["duplicate"], `${state}/${reason}: no second row`);
        }
        await q(`set session_replication_role = replica; update public.career_apply_jobs set state = 'queued', reason = null where id = '${live.id}'; set session_replication_role = origin;`);
      });

      await step("R6: readers pick the live row: status, pending, waiver, cap, posting_sent", async () => {
        const st = JSON.parse(await q(`select public.career_apply_status_for('${U}', null)::text`));
        eq(st.length, 1, `status lists the live row, not the superseded history: ${JSON.stringify(st).slice(0, 300)}`);
        eq(await q(`select public.career_apply_posting_sent('${U}', '${JOB}', '${URL_}', null, false)`), "f", "history is not sent");
        // D-010: every cloud drive that ran counts against the waiver, a history row included (the drive opened the form).
        await q(`insert into public.career_apply_cloud_gate_waivers (user_id, portal, max_sends, expires_at, note, created_at) values ('${U}', 'greenhouse', 3, now() + interval '1 day', 'TEST', now() - interval '1 day')`);
        eq(await q(`select public.career_apply_cloud_waiver_left('${U}', 'greenhouse', now() + interval '1 minute')`), "1", "two drives that ended needs_answers used two of three");
        await q(`delete from public.career_apply_cloud_gate_waivers where user_id = '${U}'`);
      });

      await step("R7: the launch reconcile keeps every rewrite", async () => {
        await q(`select public.career_apply_reconcile_bridge()`);
        for (const f of ["career_apply_enqueue(jsonb,text,text,integer)", "career_apply_prepare_own(jsonb,text[])", "career_apply_record_own(text,text,text,text)",
          "career_apply_email_reserve_for(uuid,jsonb,text,timestamptz)", "career_apply_pending_for(uuid)", "career_apply_status_for(uuid,text)", "career_apply_prepare_for(uuid,text,jsonb,text[])"]) {
          eq(await q(`select position('career_apply_job_history' in pg_get_functiondef('public.${f}'::regprocedure)) > 0`), "t", f);
        }
        eq(await q(`select position('career_apply_job_history' in pg_get_functiondef('public.career_apply_cloud_waiver_left(uuid,text,timestamptz)'::regprocedure)) > 0`), "f",
          "the waiver is never rewritten: it counts every drive");
      });
      await step("R9: waiver max_sends=1 and one drive that ended needs_answers leave 0; the re-preparation is asked at the person's own pace", async () => {
        await q(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
          values ('${JOB2}', 'greenhouse', 'reprep', 'TEST Reprep', 'Frontend Engineering Intern', 'Chicago, IL', '${URL2}', 'Build UI.', now(), now())`);
        await q(`insert into public.career_apply_cloud_gate_waivers (user_id, portal, max_sends, expires_at, note) values ('${U}', 'greenhouse', 1, now() + interval '1 day', 'TEST one')`);
        const left = () => q(`select public.career_apply_cloud_waiver_left('${U}', 'greenhouse', now() + interval '1 minute')`);
        eq(await left(), "1");
        const a = await prepareAndApprove("job two", { via: "prepare_for", job: JOB2, url: URL2 });
        eq(a.res.map((r: any) => r.result), ["queued"], JSON.stringify(a.res));
        // The person's pace is 1 a day and one posting was already started today: the re-preparation waits for the day.
        await q(`update public.career_watch_kv set value = value || '{"daily_limit":"1"}' where user_id = '${U}' and key = 'career:account';
          update public.career_apply_prepare_requests set state = 'running', claimed_at = now() where user_id = '${U}' and '${JOB}' = any(job_ids)`);
        eq(await q(`select public.career_apply_daily_limit('${U}')`), "1");
        await driveToNeedsAnswers((await rows(JOB2))[0].id);
        eq((await rows(JOB2)).map((r: any) => [r.state, r.reason]), [["not_submitted", "needs_answers"]]);
        eq(await left(), "0", "the one drive the waiver allowed ran: none left, though it ended needs_answers");
        eq(await q(`select string_agg(outcome->>'waiting_for', ',') from public.career_apply_prepare_requests where user_id = '${U}' and '${JOB2}' = any(job_ids)`),
          "per_person_day", "asked with the person's own pace (1), not null");
      });

      await step("R10: readers match by job_id: a history+live pair whose links differ shows the live row", async () => {
        const { postgrestDouble } = await import("../flow/postgrest.ts");
        const { SUPABASE_URL, SERVICE_KEY } = await import("../flow/handler.ts");
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
        const { supabaseFileStore } = await import("../../supabase/functions/trainee-file/store.ts");
        const { supabaseApplications, liveRows } = await import("../../supabase/functions/_shared/career_apply_status.ts");
        // The live row of JOB moves to another link (the board's form link): same posting, different url.
        const live = (await rows()).find((r: any) => !(r.state === "not_submitted" && r.reason === "needs_answers"))!;
        await q(`set session_replication_role = replica; update public.career_apply_jobs set url = '${URL_}?gh_src=form', updated_at = now() - interval '1 hour' where id = '${live.id}';
          update public.career_apply_jobs set updated_at = now() where user_id = '${U}' and job_id = '${JOB}' and id <> '${live.id}'; set session_replication_role = origin;`);
        const double = postgrestDouble(pg, { url: SUPABASE_URL, serviceKey: SERVICE_KEY, users: {} });
        const admin: any = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false } });
        const app = await supabaseFileStore(admin).appRow(U, JOB, URL_);
        eq(app?.id, live.id, "the jobs page reads the live (newest) row, not a history row");
        const mine = (await supabaseApplications(admin)(U)).filter((r: any) => r.job_id === JOB);
        assert(mine.length >= 2, `history and live rows read: ${mine.length}`);
        eq(liveRows(mine).map((r: any) => r.id), [live.id], "the chat's status says only the live row, matched by job_id");
      });

      await step("R8: the rollback refuses while a posting has a history row and a live row (nothing half-undone)", async () => {
        let msg = "";
        try { await q(Deno.readTextFileSync(`${ROOT}/supabase/rollbacks/20261101130000_career_apply_reprepare_needs_answers.down.sql`)); } catch (e) { msg = String((e as Error).message); }
        assert(/rollback refused/.test(msg), msg.slice(0, 300));
        eq(await q(`select count(*) from pg_indexes where indexname = 'career_apply_jobs_live_posting'`), "1", "still installed");
      });
    } finally { await pg.stop(); }
  },
});
