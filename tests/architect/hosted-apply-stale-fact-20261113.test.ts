// D-075 (review of #790, round 3, item 5, 2026-11-13). Was tests/architect/pending/ (its first test, unchanged but for import paths).
// An application the person approved carries the answers and the resume it was prepared with (career_apply_jobs.payload, frozen
// under payload_hash at prepare time). Nothing on the hosted path read the person's facts again, so after the person said a fact is
// out of date (code sets it aside) or corrected it (correct_profile_fact), an approved application stating that fact could still be
// claimed and sent. Built (supabase/migrations/20261113140000_career_apply_stop_stale_facts.sql, _shared/career_apply_stale_facts.ts):
//   - career_apply_stop_stale_facts(p_user, p_values, p_reason): that person's queued, never-tried rows stating a value are closed
//     not_submitted (reason, evidence.reason 'fact_changed'); ready/shown prepared rows are discarded and their card closed; a queued
//     row already tried and one being sent are returned as started / being_sent, untouched;
//   - the chat turn calls it after a set-aside or a successful correct_profile_fact and says what was stopped, or that the approved
//     applications could not be checked;
//   - the race is closed where every claim passes (trigger career_apply_facts_claim_guard, queued -> driving): a row whose facts_at
//     is older than a recorded change of a value it states is closed instead of started;
//   - putting the fact back re-queues nothing; the rollback leaves no function, trigger, column or table.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/hosted-apply-stale-fact-20261113.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { STALE_UNCHECKED_LINE, staleFactLines, staleFactValues, stopStaleFacts } from "../../supabase/functions/_shared/career_apply_stale_facts.ts";

const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("../../evals/mirror/instinct-wa-batch1/persona.json", import.meta.url)));
const WHO = "7b0f8f8e-6a43-4a49-9d2c-00000b0d0c01";
const fakeModel = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  if (new URL(req.url).hostname !== "api.anthropic.com") return new Response("no", { status: 404 });
  return anthropicWire(req, async (body: any) => new Response(JSON.stringify({ id: "f", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Okay." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } }));
};

Deno.test({ name: "an application approved before a fact was set aside is not handed to the worker with that fact", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg(), realFetch = globalThis.fetch;
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into auth.users (id, email) values ('${WHO}', '${WHO}@example.test'); insert into public.profiles (id) values ('${WHO}'); insert into public.career_watch_kv (user_id, key, value) values ('${WHO}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_REPLY_WRITER"]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-not-a-key"); globalThis.fetch = fakeModel as typeof fetch;
    handler = await careerHandler(pg, { "tok-s": WHO });
    const chat = handler.chat("tok-s");
    await chat.say(PERSONA.setup[0]); await chat.say(PERSONA.setup[1]);
    // An application they approved, whose answers state the GPA.
    // Seeded past the resume guard (the pasted resume has no stored file; the guard is not what this test is about).
    await pg.sql(`set session_replication_role = replica; insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at)
      values ('${WHO}', 'greenhouse:acme:1', 'Acme', 'https://boards.greenhouse.io/acme/jobs/1', '{"answers":[{"label":"GPA","value":"3.9"}]}', repeat('b', 64), repeat('b', 64), 'queued', now()); set session_replication_role = origin;`);
    const said = await chat.say("the 3.9 gpa is outdated");
    assertNode.ok(/Set aside, not deleted[^\n]*GPA: 3\.9/.test(String(said.reply)), `the fact was set aside: ${said.reply}`);
    // career_apply_claim_fair hands the worker every row still 'queued' with attempts = 0: the row must have left that state.
    const state = (await pg.sql(`select state from public.career_apply_jobs where user_id = '${WHO}'`)).trim();
    assertNode.notEqual(state, "queued", "the approved application stating GPA 3.9 is still queued for the worker after the person set that fact aside");
  } finally { handler?.restore(); globalThis.fetch = realFetch; await pg.stop(); }
} });

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const MIGRATION = `${ROOT}/supabase/migrations/20261113140000_career_apply_stop_stale_facts.sql`;
const ROLLBACK = `${ROOT}/supabase/rollbacks/20261113140000_career_apply_stop_stale_facts.down.sql`;
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

Deno.test("the values an application must not state any more, and the sentences the reply carries (a failed stop is said, never silent)", async () => {
  eq(staleFactValues({ set_aside: [{ id: "F-1", text: "GPA: 3.9" }] }), ["GPA: 3.9", "3.9"]);
  eq(staleFactValues({ corrected: [{ id: "F-2", was: "Senior data analyst role in Austin", text: "Senior data analyst role in Denver" }] }), ["Senior data analyst role in Austin", "Austin"]);
  eq(staleFactValues({ corrected: [{ id: "F-3", was: "GPA: 3.9", text: "GPA: 3.7" }] }), ["GPA: 3.9", "3.9"]);
  eq(staleFactValues({ corrected: [{ id: "F-4", was: "GPA: 3.9", text: "gpa: 3.9" }] }), [], "nothing changed, nothing to stop");
  eq(staleFactValues({}), []);
  eq(staleFactLines("failed"), [STALE_UNCHECKED_LINE]);
  assertNode.match(STALE_UNCHECKED_LINE, /couldn't check your approved applications.*can't confirm/);
  eq(staleFactLines({ cancelled: [], discarded: [], started: [], being_sent: [] }), [], "nothing stopped, nothing claimed");
  const lines = staleFactLines({ cancelled: [{ id: "1", company: "Acme" }], discarded: [{ id: "2", company: "Bolt" }, { id: "3", company: "Core" }], started: [{ id: "4", company: "Dune" }], being_sent: [{ id: "5", company: "Echo" }] });
  eq(lines.length, 4);
  assertNode.match(lines[0], /^1 approved application that hadn't gone out yet states that answer, so it is stopped and not sent \(Acme\): it needs your approval again/);
  assertNode.match(lines[1], /^2 prepared applications stating that answer are discarded \(Bolt, Core\)/);
  assertNode.match(lines[2], /^1 approved application stating that answer was already tried once .*\(Dune\): it is not started again with that answer\.$/);
  assertNode.match(lines[3], /^1 application stating that answer is being sent right now \(Echo\) and can't be stopped midway/);
  // The call: an error, a thrown error and an unreadable answer are all "failed".
  const quiet = console.error; console.error = () => {};
  try {
    eq(await stopStaleFacts({ rpc: () => Promise.resolve({ error: { message: "no function" }, data: null }) }, "u", ["3.9"], "set_aside"), "failed");
    eq(await stopStaleFacts({ rpc: () => Promise.reject(new Error("down")) }, "u", ["3.9"], "set_aside"), "failed");
    eq(await stopStaleFacts({ rpc: () => Promise.resolve({ error: null, data: { cancelled: 1 } }) }, "u", ["3.9"], "set_aside"), "failed");
  } finally { console.error = quiet; }
  const seen: unknown[] = [];
  const ok = await stopStaleFacts({ rpc: (f: string, a: unknown) => { seen.push([f, a]); return Promise.resolve({ error: null, data: { cancelled: [{ id: "1", company: "Acme" }], discarded: [], started: [], being_sent: [] } }); } }, "u", ["3.9"], "corrected");
  eq(seen, [["career_apply_stop_stale_facts", { p_user: "u", p_values: ["3.9"], p_reason: "corrected" }]]);
  eq(ok, { cancelled: [{ id: "1", company: "Acme" }], discarded: [], started: [], being_sent: [] });
});

Deno.test({ name: "database: the stop closes only that person's unstarted rows stating the value; the claim refuses a row the stop did not reach; the rollback leaves nothing", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg({ includeBridge: true });
  try {
    const A = "00000000-0000-4000-8000-0000000e0901", B = "00000000-0000-4000-8000-0000000e0902", C = "00000000-0000-4000-8000-0000000e0903";
    const RESUME_HEX = Array.from(new TextEncoder().encode("%PDF-1.4\n% TEST resume for stale facts\n")).map((b) => b.toString(16).padStart(2, "0")).join("");
    for (const [k, v] of [["APPLY_VM", "on"], ["APPLY_VM_USER_IDS", "*"], ["APPLY_VM_ALLOW_LOCAL", "on"]]) await pg.sql(`insert into career_cloud_settings(key,value) values ('${k}','${v}') on conflict (key) do update set value=excluded.value`);
    const sha = (await pg.sql(`select encode(sha256(decode('${RESUME_HEX}','hex')),'hex')`)).trim();
    for (const u of [A, B, C]) {
      await pg.sql(`insert into auth.users(id,email) values ('${u}','${u}@example.test') on conflict do nothing;
        insert into profiles(id) values ('${u}') on conflict do nothing;
        insert into career_watch_kv(user_id,key,value) values ('${u}','career:account','{"epoch":1,"version":1,"paused":false}') on conflict do nothing;
        insert into career_apply_cloud_optin(user_id,enabled,terms,terms_sha256,privacy_epoch,turned_on_at) values ('${u}',true,'test terms',repeat('a',64),1,now()) on conflict do nothing;
        insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch) values ('${u}','${sha}','resume.pdf',decode('${RESUME_HEX}','hex'),1) on conflict do nothing;
        insert into career_message_approval_private.test_users(user_id) values ('${u}') on conflict do nothing;
        select public.career_resume_put('${u}'::uuid,'${sha}','file','test:stale','resume.pdf',decode('${RESUME_HEX}','hex'),'seed:stale');`);
    }
    const link = (jid: string) => `http://127.0.0.1:9/greenhouse/${jid}/1`; // never opened: this test drives no browser
    const payload = (u: string, jid: string, co: string, gpa: string) => `jsonb_build_object('version',1,'user_id','${u}','job_id','${jid}','company','${co}','url','${link(jid)}','fields','[{"label":"First Name","value":"Test","factId":"f1"},{"label":"GPA","value":"${gpa}","factId":"f2"}]'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at','2099-01-01T00:00:00Z'::text,'engine_approval',repeat('e',64),'resume_sha256','${sha}','destination','${link(jid)}')`;
    // One approved application with a real stored approval for exactly its payload (as a tapped card leaves it).
    const approve = async (u: string, jid: string, co: string, gpa: string) => {
      const p = payload(u, jid, co, gpa);
      await pg.sql(`with a as (insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at)
          values ('${u}','${jid}',public.career_apply_payload_hash(${p}),${p},now(),now()) returning id, user_id, batch_hash)
        insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
          select a.id, a.user_id, gen_random_uuid(), 0, a.batch_hash, now(), now() + interval '23 hours' from a;
        insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
          values ('${u}','${jid}','${co}','${link(jid)}',${p},public.career_apply_payload_hash(${p}),public.career_apply_payload_hash(${p}));`);
    };
    const prepared = (u: string, jid: string, co: string, gpa: string, state: string) => { const p = payload(u, jid, co, gpa);
      return pg.sql(`insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines,state) values ('${u}','${jid}','${co}','${link(jid)}',${p},public.career_apply_payload_hash(${p}),array['GPA: ${gpa}'],'${state}')`); };
    const json = async (q: string) => JSON.parse(await pg.sql(`select (${q})::text`));
    const job = async (u: string, jid: string) => JSON.parse((await pg.sql(`select row_to_json(j) from (select * from career_apply_jobs where user_id='${u}' and job_id='${jid}') j`)) || "null");
    const names = (r: any[]) => r.map((x) => x.company).sort();
    const claim = async () => (await json(`public.career_apply_vm_claim('vm-test', 10, 5, '{}')`) as any[]).map((c) => c.job_id).sort();

    await t.step("which payloads state a value: a whole word anywhere in the payload, any case; never part of another number or word", async () => {
      const states = async (p: string, v: string[]) => (await pg.sql(`select public.career_apply_payload_states('${p}'::jsonb, array[${v.map((x) => `'${x}'`).join(",")}]::text[])`)).trim();
      eq(await states('{"answers":[{"label":"GPA","value":"3.9"}]}', ["3.9"]), "t");
      eq(await states('{"fields":[{"label":"GPA","value":3.9}]}', ["3.9"]), "t", "a number");
      eq(await states('{"cover":{"text":"My GPA is 3.9, and I live in austin."}}', ["Austin"]), "t", "nested, another case");
      eq(await states('{"answers":[{"label":"GPA","value":"3.95"},{"label":"x","value":"13.9"},{"label":"y","value":"Austinville"}]}', ["3.9", "Austin"]), "f");
      eq(await states('{"answers":[{"label":"GPA","value":"3.9"}]}', ["3"]), "f", "a value under two characters matches nothing");
      eq(await states('{"answers":[{"label":"C++ (a.b)","value":"x"}]}', ["C++ (a.b)"]), "t", "punctuation is literal");
      eq(await states('{"answers":[{"label":"GPA","value":"3x9"}]}', ["3.9"]), "f", "the dot is a dot");
    });

    await t.step("seed: A has an unstarted row, a tried row, a row being sent, a row without the value, two prepared rows and an open card; B has an unstarted row with the same value", async () => {
      await approve(A, "STALE-1", "TEST Unstarted", "3.9");
      await approve(A, "STALE-2", "TEST Tried", "3.9");
      await approve(A, "STALE-3", "TEST Sending", "3.9");
      await approve(A, "STALE-4", "TEST Other Value", "3.95");
      await approve(B, "STALE-5", "TEST Someone Else", "3.9");
      await pg.sql(`set session_replication_role = replica;
        update career_apply_jobs set attempts = 1 where user_id='${A}' and job_id='STALE-2';
        update career_apply_jobs set state='driving', attempts=1, claimed_at=now(), lease_token=gen_random_uuid(), source='cloud' where user_id='${A}' and job_id='STALE-3';
        set session_replication_role = origin;`);
      await prepared(A, "STALE-6", "TEST Prepared", "3.9", "shown");
      await prepared(A, "STALE-7", "TEST Prepared Other", "3.95", "ready");
      await prepared(B, "STALE-8", "TEST Prepared Else", "3.9", "ready");
      await pg.sql(`insert into career_apply_cards(user_id,items,state,shown_at) select user_id, jsonb_build_array(jsonb_build_object('prepared_id', id)), 'open', now() from career_apply_prepared where job_id in ('STALE-6','STALE-7')`);
      assertNode.ok((await job(A, "STALE-1")).facts_at, "an approved row carries facts_at");
    });

    await t.step("the stop: service role only; bad input refused", async () => {
      eq((await pg.sql(`select has_function_privilege('service_role','public.career_apply_stop_stale_facts(uuid,text[],text)','EXECUTE') and not has_function_privilege('authenticated','public.career_apply_stop_stale_facts(uuid,text[],text)','EXECUTE')
        and not has_function_privilege('anon','public.career_apply_stop_stale_facts(uuid,text[],text)','EXECUTE') and not has_table_privilege('authenticated','public.career_apply_fact_changes','SELECT') and not has_table_privilege('anon','public.career_apply_fact_changes','SELECT')
        and (select relrowsecurity from pg_class where oid = 'public.career_apply_fact_changes'::regclass)
        and (select bool_and(proconfig::text like '%search_path=public, pg_temp%') from pg_proc where proname in ('career_apply_stop_stale_facts','career_apply_facts_claim_guard','career_apply_facts_at_stamp','career_apply_fact_changed_close','career_apply_payload_states'))`)).trim(), "t");
      for (const bad of [`null, array['3.9'], 'set_aside'`, `'${A}', array['3']::text[], 'set_aside'`, `'${A}', '{}'::text[], 'set_aside'`, `'${A}', array['3.9'], 'Not A Reason'`]) {
        await assertNode.rejects(() => pg.sql(`select public.career_apply_stop_stale_facts(${bad})`), /invalid fact change/);
      }
    });

    await t.step("the stop: the unstarted row is closed unsent; the tried row and the one being sent are reported, untouched; the other value, the other person: untouched", async () => {
      const r = await json(`public.career_apply_stop_stale_facts('${A}'::uuid, array['GPA: 3.9','3.9'], 'set_aside')`);
      eq([names(r.cancelled), names(r.discarded), names(r.started), names(r.being_sent)], [["TEST Unstarted"], ["TEST Prepared"], ["TEST Tried"], ["TEST Sending"]]);
      const j1 = await job(A, "STALE-1");
      eq([j1.state, j1.reason, j1.evidence.reason, j1.evidence.nothing_sent, j1.evidence.stopped_by, j1.lease_token], ["not_submitted", "not sent: a fact it states changed after you approved it", "fact_changed", true, "chat", null]);
      eq([(await job(A, "STALE-2")).state, (await job(A, "STALE-2")).attempts], ["queued", 1], "a row already tried is not cancelled by the stop");
      eq((await job(A, "STALE-3")).state, "driving", "one being sent cannot be stopped");
      eq((await job(A, "STALE-4")).state, "queued", "GPA 3.95 does not state 3.9");
      eq((await job(B, "STALE-5")).state, "queued", "another person's row");
      eq((await pg.sql(`select string_agg(job_id || ':' || state, ',' order by job_id) from career_apply_prepared`)).trim(), "STALE-7:ready,STALE-8:ready", "only A's prepared row stating it is gone");
      eq((await pg.sql(`select string_agg(c.state, ',' order by c.state) from career_apply_cards c`)).trim(), "answered,open", "the card showing the discarded one is closed; the other stays");
      eq((await pg.sql(`select detail->>'cancelled' || '/' || (detail->>'discarded') || '/' || (detail->>'started') || '/' || (detail->>'being_sent') from career_events where user_id='${A}' and subject like 'fact changed:%'`)).trim(), "1/1/1/1");
      eq((await pg.sql(`select count(*) from career_events where user_id='${B}' and subject like 'fact changed:%'`)).trim(), "0");
      // Again: nothing more to stop, the started ones are still reported.
      const again = await json(`public.career_apply_stop_stale_facts('${A}'::uuid, array['3.9'], 'set_aside')`);
      eq([again.cancelled, again.discarded, names(again.started), names(again.being_sent)], [[], [], ["TEST Tried"], ["TEST Sending"]]);
    });

    await t.step("the claim: the tried row is closed instead of started, by any claim's write; rows not stating the value, and another person's, are handed out", async () => {
      const id2 = (await job(A, "STALE-2")).id;
      const n = await pg.sql(`with u as (update career_apply_jobs set state='driving', attempts=2, claimed_at=now(), lease_token=gen_random_uuid(), source='own_computer' where id='${id2}' returning 1) select count(*) from u`);
      eq(n.trim(), "0", "the start of the drive is skipped");
      const j2 = await job(A, "STALE-2");
      eq([j2.state, j2.evidence.reason, j2.evidence.stopped_by, j2.lease_token, j2.source], ["not_submitted", "fact_changed", "claim", null, null]);
      eq(await claim(), ["STALE-4", "STALE-5"], "the real claim hands out the unaffected rows");
    });

    await t.step("the race: prepared before the fact changed, approved after the stop ran (the stop never saw the row): the claim hands nothing out and closes it", async () => {
      // C's application is prepared and its card tapped (prepared row 'approved'), the enqueue has not happened yet.
      await prepared(C, "STALE-9", "TEST Race", "3.9", "approved");
      await prepared(C, "STALE-10", "TEST Race Other", "3.95", "approved");
      const r = await json(`public.career_apply_stop_stale_facts('${C}'::uuid, array['3.9'], 'corrected')`);
      eq([r.cancelled, r.discarded, r.started, r.being_sent], [[], [], [], []], "nothing for the stop to reach");
      await approve(C, "STALE-9", "TEST Race", "3.9");
      await approve(C, "STALE-10", "TEST Race Other", "3.95");
      const before = await job(C, "STALE-9");
      eq(before.state, "queued");
      eq((await pg.sql(`select (select facts_at from career_apply_jobs where id='${before.id}') = (select facts_at from career_apply_prepared where user_id='${C}' and job_id='STALE-9')
        and (select facts_at from career_apply_jobs where id='${before.id}') < (select max(at) from career_apply_fact_changes where user_id='${C}')`)).trim(), "t", "the approved row carries its prepare's time, before the change");
      eq(await claim(), ["STALE-10"], "only the row that does not state the changed value is handed out");
      const after = await job(C, "STALE-9");
      eq([after.state, after.reason, after.evidence.reason, after.evidence.stopped_by, after.attempts, after.lease_token], ["not_submitted", "not sent: a fact it states changed after you approved it", "fact_changed", "claim", 0, null]);
      eq(await claim(), []);
    });

    await t.step("approved again after the change: a row whose facts were read after the change is handed out (the person's new yes), and facts_at cannot be moved by an ordinary update", async () => {
      await approve(C, "STALE-11", "TEST Approved After", "3.9"); // no earlier prepare: facts_at is the approval, after the change
      const j = await job(C, "STALE-11");
      await pg.sql(`update career_apply_jobs set facts_at = now() - interval '1 day' where id = '${j.id}'`);
      eq((await job(C, "STALE-11")).facts_at, j.facts_at, "facts_at is the stamp trigger's alone");
      await pg.sql(`update career_apply_claim_turns set queued = true where user_id = '${C}'`).catch(() => {});
      eq(await claim(), ["STALE-11"]);
    });

    await t.step("nothing stopped comes back by itself: no row of A, B or C went back to the queue", async () => {
      eq((await pg.sql(`select string_agg(job_id || ':' || state, ',' order by length(job_id), job_id) from career_apply_jobs where evidence->>'reason' = 'fact_changed'`)).trim(), "STALE-1:not_submitted,STALE-2:not_submitted,STALE-9:not_submitted");
    });

    await t.step("erase: the record of changed values goes with the person", async () => {
      assertNode.ok((await pg.sql(`select public.career_erase_tables()::text`)).includes("career_apply_fact_changes"));
    });

    await t.step("rollback: no function, trigger, column or table is left; stopped rows stay closed; it runs twice; the migration applies again, twice", async () => {
      const down = await Deno.readTextFile(ROLLBACK), up = await Deno.readTextFile(MIGRATION);
      const left = () => pg.sql(`select (select count(*) from pg_proc where proname in ('career_apply_stop_stale_facts','career_apply_facts_claim_guard','career_apply_facts_at_stamp','career_apply_fact_changed_close','career_apply_payload_states'))
        || '/' || (select count(*) from pg_trigger where tgname in ('career_apply_facts_claim_guard','career_apply_facts_at_stamp'))
        || '/' || (select count(*) from information_schema.columns where table_schema='public' and column_name='facts_at')
        || '/' || (to_regclass('public.career_apply_fact_changes') is not null)::text`);
      eq((await left()).trim(), "5/3/2/true");
      await pg.sql(down);
      eq((await left()).trim(), "0/0/0/false");
      eq((await job(A, "STALE-1")).state, "not_submitted", "a stopped row is not put back by the rollback");
      await pg.sql(down);
      await pg.sql(up); await pg.sql(up);
      eq((await left()).trim(), "5/3/2/true");
      eq((await job(A, "STALE-1")).state, "not_submitted");
    });
  } finally { await pg.stop(); }
} });
