// Backend gap map G3, executor side, on a real Postgres (tests/flow/pg.ts: CI's migration order, never the draft bridge).
// 1. A claim re-checks that what it hands to a drive is still exactly what the person approved: the approved columns
//    of a queued application cannot change, and a row whose payload no longer hashes to its approval is never claimed
//    (it is closed as not sent, with the reason).
// 2. One cap: the person's own daily limit is the database's, whatever a caller passes, and every path counts the same
//    states (TS and SQL from one list).
// 3. One ledger: an application counts wherever it was recorded (the queue, the extension's employer-confirmation
//    reports, the old batch stack's ledger), at approval and again at claim. Since D-MS-3 (owner, 2026-10-27,
//    20261027140000) what it refuses is the exact same posting, not the company: two roles at one employer both go.
// 4. Unique confirmation IDs (D-024): an ID another employer's application already carries is never kept as proof.
// Nothing here reaches the live project.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { admitApplication, COUNTED_STATES, normCompany } from "../../supabase/functions/_shared/career_apply.ts";

const CI = Deno.env.get("CI") === "true";
const DAY = 86400000;
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

Deno.test("G3/ts one list of counted states: a drive in progress or an unknown outcome counts in TS as in SQL", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  const url = "https://jobs.lever.co/acme/j0";
  for (const state of ["driving", "unknown_outcome"]) {
    const log = [{ user_id: "u", job_id: "j0", company: "Acme", at: now - 3 * DAY, state, url }];
    const r = admitApplication(log, { user_id: "u", job_id: "j1", company: "Acme Inc", url: "https://www.jobs.lever.co/acme/j0/apply" }, now);
    assertNode.equal(r.reason, "duplicate_job", `${state}: the same posting under another id`);
    assertNode.equal(admitApplication(log, { user_id: "u", job_id: "j2", company: "Acme Inc", url: "https://jobs.lever.co/acme/j2" }, now).ok, true,
      `${state}: another role at the employer (D-MS-3)`);
  }
  for (const state of ["failed", "not_submitted"]) {
    const log = [{ user_id: "u", job_id: "j0", company: "Acme", at: now - 3 * DAY, state, url }];
    assertNode.equal(admitApplication(log, { user_id: "u", job_id: "j0", company: "Acme", url }, now).ok, true, state);
  }
});

Deno.test({
  name: "G3 approval and ledger on a real Postgres",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("G3 needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    const pg = await startPg();
    try {
      const svc = pg.asService();
      const person = async (account: Record<string, unknown> = {}) => {
        const u = uid();
        await pg.sql(`insert into auth.users (id) values ('${u}');
          insert into public.profiles (id) values ('${u}') on conflict do nothing;
          insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '${JSON.stringify({ epoch: 0, version: 0, paused: false, ...account })}');`);
          // OWNER RULE 2026-10-26 (20261026210016, review of PR #194): a confirmed resume on file and the stored resume the payloads bind.
          await pg.sql(`with t as (insert into public.agent_threads (user_id) values ('${u}') returning id)
            insert into public.agent_flow_state (thread_id, user_id, state) select id, '${u}', '{"career":{"stores":{"profile":{"facts":[{"id":"seed","kind":"experience","status":"confirmed","needs_confirmation":false,"confirmation_event_id":"seed-ev","text":"TEST Analyst"}]}}}}' from t;
            insert into public.career_events (user_id, kind, subject, detail) values ('${u}', 'fact_confirmed', 'TEST Analyst', '{"confirmation_event_id":"seed-ev"}');
            insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/' || repeat('d', 64) || '.pdf');`);
        return u;
      };
      const payload = (u: string, job: string, company: string, extra: Record<string, unknown> = {}) => ({
        version: 1, user_id: u, job_id: job, company, url: `https://boards.greenhouse.io/${company.toLowerCase().replace(/\W+/g, "")}/jobs/${job}`,
        fields: [{ name: "first_name", value: "Ada" }], privacy_epoch: 0, account_version: 0,
        expires_at: new Date(Date.now() + DAY).toISOString(),
        resume_sha256: "d".repeat(64), // OWNER RULE 2026-10-26 (20261026210016): an approved application binds its resume
        ...extra,
      });
      const hashOf = async (p: unknown) =>
        await pg.sql(`select encode(sha256(convert_to(public.career_apply_canonical($j$${JSON.stringify(p)}$j$::jsonb),'UTF8')),'hex')`);
      const enqueue = async (p: any, daily = 25) => {
        const h = await hashOf(p);
        return await svc.rpc("career_apply_enqueue", { p_payload: p, p_hash: h, p_approval: h, p_daily: daily });
      };
      const state = async (u: string, job: string) =>
        await pg.sql(`select state || '|' || coalesce(reason, '') from public.career_apply_jobs where user_id = '${u}' and job_id = '${job}'`);
      // A corrupted or tampered row, written past every trigger (as a superuser restoring data could).
      const tamper = async (u: string, job: string) =>
        await pg.sql(`set session_replication_role = replica;
          update public.career_apply_jobs set payload = jsonb_set(payload, '{fields,0,value}', '"Someone Else"') where user_id = '${u}' and job_id = '${job}';
          set session_replication_role = origin;`);

      await t.step("1a the approved columns of an application cannot be changed after the approval", async () => {
        const u = await person();
        assertNode.equal((await enqueue(payload(u, "a1", "Acme"))).error, null);
        for (const set of [`payload = jsonb_set(payload, '{fields,0,value}', '"Someone Else"')`, `payload_hash = repeat('0', 64)`,
          `approval_hash = repeat('0', 64)`, `url = 'https://evil.example/jobs/1'`, `company = 'Globex'`, `job_id = 'other'`]) {
          await assertNode.rejects(
            () => pg.sql(`update public.career_apply_jobs set ${set} where user_id = '${u}' and job_id = 'a1'`),
            /approval_fixed/, set,
          );
        }
      });

      await t.step("1b a row whose payload no longer matches its approval is never claimed, and is closed as not sent", async () => {
        const u = await person();
        assertNode.equal((await enqueue(payload(u, "b1", "Acme"))).error, null);
        await tamper(u, "b1");
        const got = await pg.asPerson(u).rpc("career_apply_claim_own", { p_limit: 3, p_source: "own_computer" });
        assertNode.equal(got.error, null, JSON.stringify(got.error));
        assertNode.deepEqual(got.data, [], "nothing handed to a drive");
        assertNode.match(await state(u, "b1"), /^not_submitted\|.*changed after (it was|you) approved/);
        const u2 = await person();
        assertNode.equal((await enqueue(payload(u2, "b2", "Initech"))).error, null);
        await tamper(u2, "b2");
        // The cloud's queue claim (not granted to any API role; its worker calls it as the owner).
        const handed = await pg.sql(`select count(*) from public.career_apply_claim(now(), 6) x where x.job_id = 'b2'`);
        assertNode.equal(handed, "0", "the queue claim does not hand it out either");
        assertNode.match(await state(u2, "b2"), /^not_submitted\|/);
      });

      await t.step("1c the cloud refuses a row whose payload no longer matches its approval before any other check", async () => {
        const u = await person();
        const p = payload(u, "c1", "Hooli", { engine_approval: "a".repeat(64), destination: "https://boards.greenhouse.io/hooli/jobs/c1" });
        assertNode.equal((await enqueue(p)).error, null);
        await tamper(u, "c1");
        const r = await pg.sql(`select public.career_apply_cloud_refusal(j, now()) from public.career_apply_jobs j where user_id = '${u}' and job_id = 'c1'`);
        assertNode.equal(r, "not_approved");
      });

      await t.step("1d a refused application may be approved again only with a payload that matches its new approval", async () => {
        const u = await person();
        assertNode.equal((await enqueue(payload(u, "d1", "Vandelay"))).error, null);
        await pg.sql(`update public.career_apply_jobs set state = 'not_submitted' where user_id = '${u}' and job_id = 'd1'`);
        const p2 = payload(u, "d1", "Vandelay", { fields: [{ name: "first_name", value: "Ada L." }] });
        const h2 = await hashOf(p2);
        await pg.sql(`update public.career_apply_jobs set payload = $j$${JSON.stringify(p2)}$j$::jsonb, payload_hash = '${h2}', approval_hash = '${h2}'
          where user_id = '${u}' and job_id = 'd1'`);
        await assertNode.rejects(
          () => pg.sql(`update public.career_apply_jobs set payload = jsonb_set(payload, '{fields,0,value}', '"X"') where user_id = '${u}' and job_id = 'd1'`),
          /approval_fixed/,
        );
      });

      await t.step("2a the person's own daily limit holds whatever limit a caller passes", async () => {
        const u = await person({ daily_limit: "2" });
        assertNode.equal((await enqueue(payload(u, "e1", "Acme"), 50)).error, null);
        assertNode.equal((await enqueue(payload(u, "e2", "Globex"), 50)).error, null);
        const third = await enqueue(payload(u, "e3", "Initech"), 50);
        assertNode.match(String(third.error?.message), /daily_cap/);
      });

      await t.step("2b TS and SQL count the same states", async () => {
        const sqlStates = (await pg.sql(`select array_to_string(public.career_apply_counted_states(), ',')`)).split(",").sort();
        for (const s of sqlStates) assertNode.ok(COUNTED_STATES.has(s), `${s} counted in SQL but not in TS`);
      });

      await t.step("3a an application the extension reported counts for its posting and the day", async () => {
        const u = await person();
        await pg.sql(`insert into public.extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, tracker_record, observed_at)
          values ('${u}', 'Acme, Inc.', 'Analyst', 'https://boards.greenhouse.io/acme/jobs/f1', 'Thanks for applying', '{}', now() - interval '5 days')`);
        const r = await enqueue(payload(u, "f1", "Acme"));
        assertNode.match(String(r.error?.message), /duplicate_job/, "the posting the extension reported");
        assertNode.equal((await enqueue(payload(u, "f1b", "Acme"))).error, null, "another role at that employer goes (D-MS-3)");
        const u2 = await person({ daily_limit: "1" });
        await pg.sql(`insert into public.extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, tracker_record, observed_at)
          values ('${u2}', 'Umbrella', 'Analyst', 'https://jobs.lever.co/umbrella/1', 'Thanks for applying', '{}', now() - interval '2 hours')`);
        assertNode.match(String((await enqueue(payload(u2, "f2", "Globex"))).error?.message), /daily_cap/);
      });

      await t.step("3b an application the old batch stack recorded counts for its posting", async () => {
        const u = await person();
        await pg.sql(`insert into public.career_batch_ledgers_v1 (user_id, records) values ('${u}',
          $j$[{"userId":"${u}","canonicalKey":"greenhouse:globex:9","status":"submitted","timestamp":"${new Date(Date.now() - 3 * DAY).toISOString()}","company":"Globex Corporation"}]$j$::jsonb)`);
        assertNode.match(String((await enqueue(payload(u, "greenhouse:globex:9", "Globex"))).error?.message), /duplicate_job/);
        assertNode.equal((await enqueue(payload(u, "g1", "Globex"))).error, null, "another role at the employer is not held (D-MS-3)");
      });

      await t.step("3c an application approved before another path sent the same posting is not sent; another role still goes", async () => {
        const u = await person();
        assertNode.equal((await enqueue(payload(u, "h1", "Acme"))).error, null);
        assertNode.equal((await enqueue(payload(u, "h2", "Acme"))).error, null);
        await pg.sql(`insert into public.extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, tracker_record, observed_at)
          values ('${u}', 'ACME', 'Analyst', 'https://boards.greenhouse.io/acme/jobs/h1', 'Thanks for applying', '{}', now())`);
        const got = await pg.asPerson(u).rpc("career_apply_claim_own", { p_limit: 3, p_source: "own_computer" });
        assertNode.deepEqual((got.data as { job_id: string }[]).map((j) => j.job_id), ["h2"], JSON.stringify(got));
        assertNode.match(await state(u, "h1"), /^not_submitted\|.*already sent/);
      });

      await t.step("3e apply-by-email reads the same ledger: a posting the extension already sent is not emailed", async () => {
        const u = await person();
        await pg.sql(`insert into public.extension_submission_reports (user_id, employer, role, posting_url, confirmation_text, tracker_record, observed_at)
          values ('${u}', 'Acme Corporation', 'Analyst', 'https://example.org/x1', 'Thanks for applying', '{}', now() - interval '1 day')`);
        const email = (job: string, company: string) => ({
          kind: "email", version: 1, user_id: u, job_id: job, company, url: `https://example.org/${job}`, to: "jobs@example.org",
          // OWNER RULE (20261026210016): an emailed application goes into driving only with the person's resume, stored for them.
          subject: "Application", body: "TEST application body", attachment: { sha256: "d".repeat(64) }, resume_sha256: "d".repeat(64),
        });
        const reserve = async (p: any) => {
          const h = await hashOf(p);
          await pg.sql(`insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:email-card',
            jsonb_build_object('state', 'shown', 'payload_hash', '${h}', 'shown_at', now()))
            on conflict (user_id, key) do update set value = excluded.value`);
          return await pg.sql(`select state || '|' || source from public.career_apply_email_reserve_for('${u}', $j$${JSON.stringify(p)}$j$::jsonb, '${h}', now())`);
        };
        await assertNode.rejects(() => reserve(email("x1", "Acme")), /duplicate_job/);
        assertNode.equal(await reserve(email("x2", "Acme")), "driving|email", "another role at the employer is emailed (D-MS-3)");
      });

      await t.step("3f D-MS-3: an application sent 5 days ago refuses its own posting, never the company", async () => {
        const u = await person();
        assertNode.equal((await enqueue(payload(u, "s1", "Acme"))).error, null);
        // Dated as an old approval that was sent recently (written past every trigger: only the dates are the subject).
        await pg.sql(`set session_replication_role = replica;
          update public.career_apply_jobs set state = 'confirmed', source = 'own_computer', attempts = 1,
           created_at = now() - interval '40 days', claimed_at = now() - interval '5 days' where user_id = '${u}' and job_id = 's1';
          set session_replication_role = origin;`);
        assertNode.equal((await enqueue(payload(u, "s2", "Acme Inc"))).error, null, "another role at the employer goes");
        const same = payload(u, "s1-again", "Acme", { url: "https://boards.greenhouse.io/acme/jobs/s1" });
        assertNode.match(String((await enqueue(same)).error?.message), /duplicate_job/, "the same posting under another id does not");
      });

      await t.step("3d TS and SQL read a company's name the same way", async () => {
        for (const name of ["Acme, Inc.", "The Coca-Cola Company", "AT&T", "Procter & Gamble Co.", "  Globex   Corp ", "Ünïcode Labs LLC", "co-op"]) {
          const s = await pg.sql(`select public.career_apply_company_key($n$${name}$n$)`);
          assertNode.equal(normCompany(name), s, name);
        }
      });

      await t.step("4a a confirmation ID another employer's application carries is not kept as proof", async () => {
        const u = await person();
        assertNode.equal((await enqueue(payload(u, "k1", "Acme"))).error, null);
        assertNode.equal((await enqueue(payload(u, "k2", "Globex"))).error, null);
        const me = pg.asPerson(u);
        const jobs = (await me.rpc("career_apply_claim_own", { p_limit: 3, p_source: "own_computer" })).data;
        assertNode.equal(jobs.length, 2);
        const [a, b] = ["k1", "k2"].map((k) => jobs.find((j: any) => j.job_id === k));
        await me.rpc("career_apply_finish_own", { p_id: a.id, p_lease: a.lease_token, p_state: "confirmed", p_evidence: { confirmation_id: "ABC-12345" } });
        const fb = await me.rpc("career_apply_finish_own", { p_id: b.id, p_lease: b.lease_token, p_state: "confirmed", p_evidence: { confirmation_id: "abc 12345" } });
        assertNode.equal(fb.error, null, JSON.stringify(fb.error));
        const row = JSON.parse(await pg.sql(`select to_jsonb(j) from public.career_apply_jobs j where id = '${b.id}'`));
        assertNode.equal(row.confirmation_id, null, "not kept");
        assertNode.equal(row.evidence.confirmation_id_conflict, "abc 12345", "what the page said is kept as evidence");
        assertNode.equal(row.state, "submitted_unconfirmed");
        const first = await pg.sql(`select confirmation_id from public.career_apply_jobs where id = '${a.id}'`);
        assertNode.equal(first, "ABC-12345", "the first employer's keeps it");
      });

      await t.step("4b an ID another person's report gives a different employer is not kept either; the same employer's is", async () => {
        const other = await person();
        await pg.sql(`insert into public.extension_submission_reports (user_id, employer, role, posting_url, confirmation_id, confirmation_text, tracker_record)
          values ('${other}', 'Umbrella', 'Analyst', 'https://jobs.lever.co/umbrella/2', 'UMB-777', 'Received', '{}')`);
        const u = await person();
        assertNode.equal((await enqueue(payload(u, "m1", "Initech"))).error, null);
        assertNode.equal((await enqueue(payload(u, "m2", "Umbrella"))).error, null);
        const me = pg.asPerson(u);
        const jobs = (await me.rpc("career_apply_claim_own", { p_limit: 3, p_source: "own_computer" })).data;
        for (const j of jobs) {
          await me.rpc("career_apply_finish_own", { p_id: j.id, p_lease: j.lease_token, p_state: "confirmed", p_evidence: { confirmation_id: "umb 777" } });
        }
        assertNode.equal(await pg.sql(`select coalesce(confirmation_id, '-') from public.career_apply_jobs where user_id = '${u}' and job_id = 'm1'`), "-");
        assertNode.equal(await pg.sql(`select coalesce(confirmation_id, '-') from public.career_apply_jobs where user_id = '${u}' and job_id = 'm2'`), "umb 777");
      });
    } finally {
      await pg.stop();
    }
  },
});
