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
import { STALE_UNCHECKED_LINE, staleFactChanges, staleFactLines, stopStaleFacts } from "../../supabase/functions/_shared/career_apply_stale_facts.ts";

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

Deno.test("the changes the stop is given, and the sentences the reply carries (a failed stop is said, never silent)", async () => {
  eq(staleFactChanges({ set_aside: [{ id: "F-1", text: "GPA: 3.9" }] }), [{ id: "F-1", was: "GPA: 3.9", now: null }]);
  eq(staleFactChanges({ corrected: [{ id: "F-2", was: "Senior data analyst role in Austin", text: "Senior data analyst role in Denver" }] }), [{ id: "F-2", was: "Senior data analyst role in Austin", now: "Senior data analyst role in Denver" }]);
  eq(staleFactChanges({ corrected: [{ id: "F-4", was: "GPA: 3.9", text: "gpa: 3.9" }] }), [], "nothing changed, nothing to stop");
  eq(staleFactChanges({}), []);
  eq(staleFactLines("failed"), [STALE_UNCHECKED_LINE]);
  assertNode.match(STALE_UNCHECKED_LINE, /couldn't check your approved applications.*can't confirm/);
  const none = { cancelled: [], waiting: [], stopped_preparing: [], discarded: [], started: [], being_sent: [] };
  eq(staleFactLines(none), [], "nothing stopped, nothing claimed");
  const lines = staleFactLines({ cancelled: [{ id: "1", company: "Acme" }], stopped_preparing: [{ id: "6", company: "Fern" }], waiting: [{ id: "7", company: "Gale" }], discarded: [{ id: "2", company: "Bolt" }, { id: "3", company: "Core" }], started: [{ id: "4", company: "Dune" }], being_sent: [{ id: "5", company: "Echo" }] });
  eq(lines.length, 5);
  assertNode.match(lines[0], /^2 approved applications that hadn't gone out yet state that answer, so they are stopped and not sent \(Acme, Fern\): they need your approval again/);
  assertNode.match(lines[1], /^1 application waiting on you states that answer, so it is stopped too \(Gale\): it needs a fresh look/);
  assertNode.match(lines[2], /^2 prepared applications stating that answer are discarded \(Bolt, Core\)/);
  assertNode.match(lines[3], /^1 approved application stating that answer was already tried once .*\(Dune\): it is not started again with that answer\.$/);
  assertNode.match(lines[4], /^1 application stating that answer is being sent right now \(Echo\) and can't be stopped midway/);
  // The call: an error, a thrown error and an unreadable answer are all "failed".
  const ch = [{ id: "F-1", was: "GPA: 3.9", now: null }];
  const quiet = console.error; console.error = () => {};
  try {
    eq(await stopStaleFacts({ rpc: () => Promise.resolve({ error: { message: "no function" }, data: null }) }, "u", ch, "set_aside"), "failed");
    eq(await stopStaleFacts({ rpc: () => Promise.reject(new Error("down")) }, "u", ch, "set_aside"), "failed");
    eq(await stopStaleFacts({ rpc: () => Promise.resolve({ error: null, data: { cancelled: 1 } }) }, "u", ch, "set_aside"), "failed");
  } finally { console.error = quiet; }
  const seen: unknown[] = [];
  const ok = await stopStaleFacts({ rpc: (f: string, a: unknown) => { seen.push([f, a]); return Promise.resolve({ error: null, data: { ...none, cancelled: [{ id: "1", company: "Acme" }] } }); } }, "u", ch, "corrected");
  eq(seen, [["career_apply_stop_stale_facts", { p_user: "u", p_changes: ch, p_reason: "corrected" }]]);
  eq(ok, { ...none, cancelled: [{ id: "1", company: "Acme" }] });
});

Deno.test({ name: "database: the stop closes only that person's unstarted rows stating the value; the claim refuses a row the stop did not reach; the rollback leaves nothing", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg({ includeBridge: true });
  try {
    const A = "00000000-0000-4000-8000-0000000e0901", B = "00000000-0000-4000-8000-0000000e0902", C = "00000000-0000-4000-8000-0000000e0903", D = "00000000-0000-4000-8000-0000000e0904";
    const RESUME_HEX = Array.from(new TextEncoder().encode("%PDF-1.4\n% TEST resume for stale facts\n")).map((b) => b.toString(16).padStart(2, "0")).join("");
    for (const [k, v] of [["APPLY_VM", "on"], ["APPLY_VM_USER_IDS", "*"], ["APPLY_VM_ALLOW_LOCAL", "on"]]) await pg.sql(`insert into career_cloud_settings(key,value) values ('${k}','${v}') on conflict (key) do update set value=excluded.value`);
    const sha = (await pg.sql(`select encode(sha256(decode('${RESUME_HEX}','hex')),'hex')`)).trim();
    for (const u of [A, B, C, D]) {
      await pg.sql(`insert into auth.users(id,email) values ('${u}','${u}@example.test') on conflict do nothing;
        insert into profiles(id) values ('${u}') on conflict do nothing;
        insert into career_watch_kv(user_id,key,value) values ('${u}','career:account','{"epoch":1,"version":1,"paused":false}') on conflict do nothing;
        insert into career_apply_cloud_optin(user_id,enabled,terms,terms_sha256,privacy_epoch,turned_on_at) values ('${u}',true,'test terms',repeat('a',64),1,now()) on conflict do nothing;
        insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch) values ('${u}','${sha}','resume.pdf',decode('${RESUME_HEX}','hex'),1) on conflict do nothing;
        insert into career_message_approval_private.test_users(user_id) values ('${u}') on conflict do nothing;
        select public.career_resume_put('${u}'::uuid,'${sha}','file','test:stale','resume.pdf',decode('${RESUME_HEX}','hex'),'seed:stale');`);
    }
    const link = (jid: string) => `http://127.0.0.1:9/greenhouse/${jid}/1`; // never opened: this test drives no browser
    const payloadOf = (u: string, jid: string, co: string, fields: string) => `jsonb_build_object('version',1,'user_id','${u}','job_id','${jid}','company','${co}','url','${link(jid)}','fields','${fields}'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at','2099-01-01T00:00:00Z'::text,'engine_approval',repeat('e',64),'resume_sha256','${sha}','destination','${link(jid)}')`;
    const approveFields = async (u: string, jid: string, co: string, fields: string) => {
      const p = payloadOf(u, jid, co, fields);
      await pg.sql(`with a as (insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at)
          values ('${u}','${jid}',public.career_apply_payload_hash(${p}),${p},now(),now()) returning id, user_id, batch_hash)
        insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
          select a.id, a.user_id, gen_random_uuid(), 0, a.batch_hash, now(), now() + interval '23 hours' from a;
        insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
          values ('${u}','${jid}','${co}','${link(jid)}',${p},public.career_apply_payload_hash(${p}),public.career_apply_payload_hash(${p}));`);
    };
    const payload = (u: string, jid: string, co: string, gpa: string) => `jsonb_build_object('version',1,'user_id','${u}','job_id','${jid}','company','${co}','url','${link(jid)}','fields','[{"label":"First Name","value":"Test","factId":"f1"},{"label":"GPA","value":"${gpa}","factId":"F-GPA-${gpa}"}]'::jsonb,'privacy_epoch',1,'account_version',1,'expires_at','2099-01-01T00:00:00Z'::text,'engine_approval',repeat('e',64),'resume_sha256','${sha}','destination','${link(jid)}')`;
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

    await t.step("which payloads state a fact: by its id whatever the value says; without an id, by normalised value (numbers, month-year dates, phrases of four or more characters, never one common word)", async () => {
      const stale = async (p: string, ids: string[], was: string, now: string | null = null) => (await pg.sql(`select public.career_apply_payload_stale('${p}'::jsonb, array[${ids.map((x) => `'${x}'`).join(",")}]::text[], public.career_apply_changed_keys('${was}', null, ${now === null ? "null" : `'${now}'`}, null))`)).trim();
      eq(await stale('{"fields":[{"label":"Authorized to work?","value":"Yes","factId":"F0"}]}', ["F0"], "Work authorization: US citizen"), "t", "a derived Yes, by fact id");
      eq(await stale('{"fields":[{"label":"GPA","value":"3.9","factId":"F9"}]}', ["F0"], "GPA: 3.9"), "f", "a field from another fact is that fact's: never matched by value");
      eq(await stale('{"answers":[{"label":"GPA","value":"3.90"}]}', [], "GPA: 3.9"), "t", "3.90 = 3.9");
      eq(await stale('{"answers":[{"label":"GPA","value":"3.9/4.0"}]}', [], "GPA 3.9"), "t", "the leading number of 3.9/4.0, a fact with no label");
      eq(await stale('{"answers":[{"label":"Graduation","value":"05/2026"}]}', [], "Graduating in May 2026", "Graduating in December 2026"), "t", "May 2026 = 05/2026");
      eq(await stale('{"answers":[{"label":"Graduation","value":"2026-05"}]}', [], "Graduating in May 2026", "Graduating in December 2026"), "t", "May 2026 = 2026-05");
      eq(await stale('{"answers":[{"label":"Graduation","value":"December 2026"}]}', [], "Graduating in May 2026", "Graduating in December 2026"), "f", "the year the correction kept stops nothing");
      eq(await stale('{"cover":{"text":"My GPA is 3.9, and I live in austin."}}', [], "Austin"), "t", "nested, another case");
      eq(await stale('{"answers":[{"value":"3.95"},{"value":"13.9"},{"value":"Austinville"}]}', [], "GPA: 3.9"), "f");
      eq(await stale('{"answers":[{"value":"Yes"},{"value":"No"},{"value":"May"}]}', [], "Yes"), "f", "yes alone stops nothing by value");
      eq(await stale('{"answers":[{"value":"May"}]}', [], "May"), "f", "May alone stops nothing by value");
      eq(await stale('{"answers":[{"value":"No"}]}', [], "No"), "f");
      eq(await stale('{"answers":[{"value":"none"}]}', [], "none"), "f", "a common word");
      eq(await stale('{"url":"http://127.0.0.1:9/x/3/1","expires_at":"2099-01-01T00:00:00Z","resume_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fields":[]}', [], "Years of experience: 1"), "f", "where it goes, its hashes and times state no fact");
      eq(await stale('{"body":"I have 1 year of experience."}', [], "Years of experience: 1"), "t", "free text without a fact id is compared");
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
      eq((await pg.sql(`select has_function_privilege('service_role','public.career_apply_stop_stale_facts(uuid,jsonb,text)','EXECUTE') and not has_function_privilege('authenticated','public.career_apply_stop_stale_facts(uuid,jsonb,text)','EXECUTE')
        and not has_function_privilege('anon','public.career_apply_stop_stale_facts(uuid,jsonb,text)','EXECUTE') and not has_table_privilege('authenticated','public.career_apply_fact_changes','SELECT') and not has_table_privilege('anon','public.career_apply_fact_changes','SELECT')
        and (select relrowsecurity from pg_class where oid = 'public.career_apply_fact_changes'::regclass)
        and (select bool_and(proconfig::text like '%search_path=public, pg_temp%') from pg_proc where proname in ('career_apply_stop_stale_facts','career_apply_facts_claim_guard','career_apply_facts_at_stamp','career_apply_fact_changed_close','career_apply_payload_stale','career_apply_facts_email_guard','career_apply_fact_hit','career_apply_facts_write_record','career_apply_facts_diff','career_apply_value_key','career_apply_value_keys','career_apply_changed_keys'))`)).trim(), "t");
      const GPA39 = `'[{"id":"F-GPA-3.9","was":"GPA: 3.9","now":null}]'::jsonb`;
      for (const bad of [`null, ${GPA39}, 'set_aside'`, `'${A}', '[{"id":"","was":"No","now":null}]'::jsonb, 'set_aside'`, `'${A}', '[]'::jsonb, 'set_aside'`, `'${A}', '{}'::jsonb, 'set_aside'`, `'${A}', ${GPA39}, 'Not A Reason'`]) {
        await assertNode.rejects(() => pg.sql(`select public.career_apply_stop_stale_facts(${bad})`), /invalid fact change/);
      }
    });

    await t.step("the stop: the unstarted row is closed unsent; the tried row and the one being sent are reported, untouched; the other value, the other person: untouched", async () => {
      const r = await json(`public.career_apply_stop_stale_facts('${A}'::uuid, '[{"id":"F-GPA-3.9","was":"GPA: 3.9","now":null}]'::jsonb, 'set_aside')`);
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
      const again = await json(`public.career_apply_stop_stale_facts('${A}'::uuid, '[{"id":"F-GPA-3.9","was":"GPA: 3.9","now":null}]'::jsonb, 'set_aside')`);
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
      const r = await json(`public.career_apply_stop_stale_facts('${C}'::uuid, '[{"id":"F-GPA-3.9","was":"GPA: 3.9","now":"GPA: 3.7"}]'::jsonb, 'corrected')`);
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

    await t.step("an emailed application (started at the yes to its card, never queued): a card shown before the change is refused, fact_changed; one shown after is not", async () => {
      const p = payload(C, "STALE-12", "TEST Email", "3.9");
      const start = () => pg.sql(`insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash,state,attempts,claimed_at,lease_token,source)
        values ('${C}','STALE-12','TEST Email','${link("STALE-12")}',${p},public.career_apply_payload_hash(${p}),public.career_apply_payload_hash(${p}),'driving',1,now(),gen_random_uuid(),'email')`);
      await pg.sql(`insert into career_watch_kv(user_id,key,value) values ('${C}','career:email-card', jsonb_build_object('state','shown','shown_at', (select min(at) - interval '1 minute' from career_apply_fact_changes where user_id='${C}')))`);
      await assertNode.rejects(start, /fact_changed/);
      eq(await job(C, "STALE-12"), null, "nothing was started");
      // A card shown after the change (drafted from the facts as they are now): this guard lets it through.
      await pg.sql(`update career_watch_kv set value = jsonb_build_object('state','shown','shown_at', clock_timestamp()) where user_id='${C}' and key='career:email-card'`);
      const err = await start().then(() => "", (e) => String(e?.message ?? e));
      assertNode.doesNotMatch(err, /fact_changed/);
    });

    await t.step("review round 2 (#822): a derived answer, 3.90, a fact with no label: stopped by fact id; a row the VM is filling in is stopped before its submit point; a row waiting on the person is stopped", async () => {
      await approveFields(D, "R-1", "TEST Derived", '[{"label":"Are you legally authorized to work in the United States?","value":"Yes","factId":"F0"}]');
      await approveFields(D, "R-2", "TEST Trailing Zero", '[{"label":"GPA","value":"3.90","factId":"F1"}]');
      await approveFields(D, "R-3", "TEST No Colon", '[{"label":"GPA","value":"3.9","factId":"F2"}]');
      await approveFields(D, "R-6", "TEST Waiting", '[{"label":"City","value":"Austin","factId":"F4"}]');
      await pg.sql(`set session_replication_role = replica; update career_apply_jobs set state='needs_user', reason='login_required', evidence = evidence || '{"nothing_sent":true,"handoff":{"step":"sign in","link":"https://example.invalid/x"}}' where user_id='${D}' and job_id='R-6'; set session_replication_role = origin;`);
      const r = await json(`public.career_apply_stop_stale_facts('${D}'::uuid, '[{"id":"F0","was":"Work authorization: US citizen","now":null},{"id":"F1","was":"GPA: 3.9","now":null},{"id":"F2","was":"GPA 3.9","now":null},{"id":"F4","was":"Austin, TX","now":"Denver, CO"}]'::jsonb, 'set_aside')`);
      eq([names(r.cancelled), names(r.waiting), r.being_sent], [["TEST Derived", "TEST No Colon", "TEST Trailing Zero"], ["TEST Waiting"], []]);
      eq((await pg.sql(`select string_agg(job_id || ':' || state || ':' || (evidence->>'reason'), ',' order by job_id) from career_apply_jobs where user_id='${D}'`)).trim(),
        "R-1:not_submitted:fact_changed,R-2:not_submitted:fact_changed,R-3:not_submitted:fact_changed,R-6:not_submitted:fact_changed");
      // A row the apply VM claimed and is filling in ('preparing'): stopped, its lease taken; the submit check finds no lease.
      await approveFields(D, "R-4", "TEST Preparing", '[{"label":"GPA","value":"3.7","factId":"F3"}]');
      const c4 = (await json(`public.career_apply_vm_claim('vm-test', 10, 5, '{}')`) as any[]).find((x) => x.job_id === "R-4");
      assertNode.ok(c4, "R-4 claimed");
      eq(await json(`public.career_apply_vm_heartbeat('${c4.id}','${c4.lease_token}','vm-test','preparing')`), { ok: true });
      const r4 = await json(`public.career_apply_stop_stale_facts('${D}'::uuid, '[{"id":"F3","was":"GPA: 3.7","now":"GPA: 3.8"}]'::jsonb, 'corrected')`);
      eq([names(r4.stopped_preparing), r4.being_sent], [["TEST Preparing"], []], "not 'being sent': it had not reached its submit point");
      eq(await json(`public.career_apply_vm_heartbeat('${c4.id}','${c4.lease_token}','vm-test','submitting')`), { ok: false, why: "lease_lost" });
      const j4 = await job(D, "R-4");
      eq([j4.state, j4.vm_phase === "submitting", j4.evidence.reason, j4.evidence.stopped_by], ["not_submitted", false, "fact_changed", "chat"]);
    });

    await t.step("no stop call at all: the fact write itself records the change (account record), and the submit check refuses a row being filled in", async () => {
      const facts = (f: string) => `jsonb_set(value, '{memory}', jsonb_build_object('v',1,'profile',jsonb_build_object('facts','${f}'::jsonb)))`;
      await pg.sql(`update career_watch_kv set value = ${facts('[{"id":"F5","kind":"other","text":"GPA: 3.8","status":"confirmed","needs_confirmation":false}]')} where user_id='${D}' and key='career:account'`);
      const before = Number((await pg.sql(`select count(*) from career_apply_fact_changes where user_id='${D}' and reason='fact_write'`)).trim());
      await approveFields(D, "R-5", "TEST Submit Check", '[{"label":"GPA","value":"3.8","factId":"F5"}]');
      const c5 = (await json(`public.career_apply_vm_claim('vm-test', 10, 5, '{}')`) as any[]).find((x) => x.job_id === "R-5");
      assertNode.ok(c5, "R-5 claimed");
      eq(await json(`public.career_apply_vm_heartbeat('${c5.id}','${c5.lease_token}','vm-test','preparing')`), { ok: true });
      // The person sets the fact aside: the commit writes the account record (no chat stop runs here).
      await pg.sql(`update career_watch_kv set value = ${facts('[{"id":"F5","kind":"other","text":"GPA: 3.8","status":"draft","needs_confirmation":true,"withdrawn_by_owner":{"at":"2026-11-13T00:00:00Z"}}]')} where user_id='${D}' and key='career:account'`);
      eq((await pg.sql(`select count(*) - ${before} || ':' || (array_agg(fact_ids::text order by id desc))[1] from career_apply_fact_changes where user_id='${D}' and reason='fact_write'`)).trim(), "1:{F5}");
      eq(await json(`public.career_apply_vm_heartbeat('${c5.id}','${c5.lease_token}','vm-test','submitting')`), { ok: false, why: "fact_changed" });
      const j5 = await job(D, "R-5");
      eq([j5.state, j5.vm_phase, j5.evidence.reason, j5.evidence.stopped_by, j5.lease_token], ["not_submitted", "preparing", "fact_changed", "submit_check", null]);
      // Putting the fact back is not a change; nothing is re-queued.
      await pg.sql(`update career_watch_kv set value = ${facts('[{"id":"F5","kind":"other","text":"GPA: 3.8","status":"confirmed","needs_confirmation":false}]')} where user_id='${D}' and key='career:account'`);
      eq((await pg.sql(`select count(*) - ${before} from career_apply_fact_changes where user_id='${D}' and reason='fact_write'`)).trim(), "1");
      eq((await job(D, "R-5")).state, "not_submitted");
      // A screening answer replacing the fact (a new id; saveScreenFact) and a correction of its words are changes too.
      await pg.sql(`update career_watch_kv set value = ${facts('[{"id":"F7","kind":"eligibility","text":"Needs sponsorship: no","value":"no","status":"confirmed","needs_confirmation":false}]')} where user_id='${D}' and key='career:account'`);
      await pg.sql(`update career_watch_kv set value = ${facts('[{"id":"F8","kind":"eligibility","text":"Needs sponsorship: yes","value":"yes","status":"confirmed","needs_confirmation":false}]')} where user_id='${D}' and key='career:account'`);
      assertNode.match((await pg.sql(`select (array_agg(fact_ids::text order by id desc))[1] from career_apply_fact_changes where user_id='${D}' and reason='fact_write'`)).trim(), /F7/);
    });

    await t.step("the cloud runner's authorization refuses a row stating a changed fact; facts_at moves only with a new approval", async () => {
      await approveFields(D, "R-8", "TEST Cloud", '[{"label":"School","value":"Lakeshore","factId":"F9"}]');
      const j8 = await job(D, "R-8");
      await pg.sql(`set session_replication_role = replica; update career_apply_jobs set state='driving', attempts=1, claimed_at=now(), lease_token=gen_random_uuid(), source='cloud' where id='${j8.id}'; set session_replication_role = origin;`);
      const r8 = await json(`public.career_apply_stop_stale_facts('${D}'::uuid, '[{"id":"F9","was":"School: Lakeshore","now":null}]'::jsonb, 'set_aside')`);
      eq(names(r8.being_sent), ["TEST Cloud"], "the cloud runner's row is not ours to close: reported, and refused at its authorization");
      const lease = (await job(D, "R-8")).lease_token;
      await assertNode.rejects(() => pg.sql(`select public.career_apply_cloud_authorize_any('${j8.id}','${lease}','${j8.payload_hash}',repeat('a',64))`), /fact_changed/);
      // facts_at: a stopped row put back in the queue without a new approval keeps its facts_at, so the claim closes it again.
      const j1 = await job(D, "R-1");
      await pg.sql(`update career_apply_jobs set state='queued', reason=null where id='${j1.id}'`).catch(() => {});
      const back = await job(D, "R-1");
      eq(back.facts_at, j1.facts_at, "facts_at is not moved by not_submitted -> queued");
      if (back.state === "queued") {
        await pg.sql(`update career_apply_claim_turns set queued = true where user_id = '${D}'`).catch(() => {});
        await json(`public.career_apply_vm_claim('vm-test', 10, 5, '{}')`);
        eq((await job(D, "R-1")).state, "not_submitted", "the claim closes it again");
      }
    });

    await t.step("nothing stopped comes back by itself: no row of A, B or C went back to the queue", async () => {
      eq((await pg.sql(`select string_agg(job_id || ':' || state, ',' order by length(job_id), job_id) from career_apply_jobs where evidence->>'reason' = 'fact_changed' and user_id in ('${A}','${B}','${C}')`)).trim(), "STALE-1:not_submitted,STALE-2:not_submitted,STALE-9:not_submitted");
    });

    await t.step("erase: the record of changed values goes with the person", async () => {
      assertNode.ok((await pg.sql(`select public.career_erase_tables()::text`)).includes("career_apply_fact_changes"));
    });

    await t.step("rollback: no function, trigger, column or table is left; stopped rows stay closed; it runs twice; the migration applies again, twice", async () => {
      const down = await Deno.readTextFile(ROLLBACK), up = await Deno.readTextFile(MIGRATION);
      const left = () => pg.sql(`select (select count(*) from pg_proc where proname like 'career_apply_fact%' or proname in ('career_apply_stop_stale_facts','career_apply_payload_states','career_apply_payload_stale','career_apply_value_key','career_apply_value_keys','career_apply_changed_keys')
          or (proname in ('career_apply_vm_heartbeat','career_apply_cloud_authorize_any') and prosrc like '%fact_changed%'))
        || '/' || (select count(*) from pg_trigger where tgname like 'career_apply_facts_%')
        || '/' || (select count(*) from information_schema.columns where table_schema='public' and column_name='facts_at')
        || '/' || (to_regclass('public.career_apply_fact_changes') is not null)::text`);
      eq((await left()).trim(), "14/6/2/true");
      await pg.sql(down);
      eq((await left()).trim(), "0/0/0/false");
      eq((await job(A, "STALE-1")).state, "not_submitted", "a stopped row is not put back by the rollback");
      eq((await pg.sql(`select count(*) from pg_proc where proname in ('career_apply_vm_heartbeat','career_apply_cloud_authorize_any')`)).trim(), "2", "the heartbeat and the cloud authorization are back as they were");
      await pg.sql(down);
      await pg.sql(up); await pg.sql(up);
      eq((await left()).trim(), "14/6/2/true");
      eq((await job(A, "STALE-1")).state, "not_submitted");
    });
  } finally { await pg.stop(); }
} });

// The chat, end to end on a real Postgres: a correction through correct_profile_fact stops the application stating the old value
// and the reply names it; putting a set-aside fact back (code's own question, the person's yes) re-queues nothing; when the stop
// cannot run the reply says the approved applications could not be checked.
Deno.test({ name: "chat: a correction stops the approved application and says so; restoring the fact re-queues nothing; a stop that cannot run is said", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const WHO2 = "7b0f8f8e-6a43-4a49-9d2c-00000b0d0c02";
  const pg: Pg = await startPg(), realFetch = globalThis.fetch;
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  // The scripted model: the next tool call it makes (once), then plain text.
  let next: { name: string; input: Record<string, unknown> } | null = null;
  const model = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    if (new URL(req.url).hostname !== "api.anthropic.com") return new Response("no", { status: 404 });
    return anthropicWire(req, async (body: any) => {
      const call = next && Array.isArray(body.tools) && body.tools.some((t: any) => (t.function?.name ?? t.name) === next!.name) ? next : null;
      if (call) next = null;
      const message = call ? { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: "assistant", content: "Okay." };
      return new Response(JSON.stringify({ id: "f", model: body.model, choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
  };
  const seed = (jid: string, co: string, gpa: string) => pg.sql(`set session_replication_role = replica; insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at)
    values ('${WHO2}', '${jid}', '${co}', 'https://boards.greenhouse.io/x/jobs/1', '{"answers":[{"label":"GPA","value":"${gpa}"}]}', repeat('b', 64), repeat('b', 64), 'queued', now()); set session_replication_role = origin;`);
  const state = async (jid: string) => (await pg.sql(`select state from public.career_apply_jobs where user_id = '${WHO2}' and job_id = '${jid}'`)).trim();
  const gpa = async () => JSON.parse((await pg.sql(`select jsonb_path_query_first(state, 'strict $.** ? (@.type() == "object" && exists(@.id) && exists(@.text) && @.text like_regex "^GPA: ")')::text from public.agent_flow_state where user_id = '${WHO2}'`)).trim() || "null");
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into auth.users (id, email) values ('${WHO2}', '${WHO2}@example.test'); insert into public.profiles (id) values ('${WHO2}'); insert into public.career_watch_kv (user_id, key, value) values ('${WHO2}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_REPLY_WRITER"]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-not-a-key"); globalThis.fetch = model as typeof fetch;
    handler = await careerHandler(pg, { "tok-s2": WHO2 });
    const chat = handler.chat("tok-s2");
    await chat.say(PERSONA.setup[0]); await chat.say(PERSONA.setup[1]);
    const fact = await gpa();
    assertNode.equal(fact?.text, "GPA: 3.9", "the confirmed GPA fact is on file");

    // 1. Set aside: stopped, and the reply says which application.
    await seed("greenhouse:acme:1", "Acme", "3.9"); await seed("greenhouse:bolt:1", "Bolt", "3.95");
    const aside = await chat.say("the 3.9 gpa is outdated");
    assertNode.match(aside.reply, /Set aside, not deleted[^\n]*GPA: 3\.9/);
    assertNode.match(aside.reply, /1 approved application that hadn't gone out yet states that answer, so it is stopped and not sent \(Acme\)/, `the reply names what was stopped: ${aside.reply}`);
    assertNode.deepStrictEqual([await state("greenhouse:acme:1"), await state("greenhouse:bolt:1")], ["not_submitted", "queued"], "only the application stating 3.9");

    // 2. Put back: code asks its own question, the person says yes, the fact is theirs again; the stopped application stays stopped.
    next = { name: "confirm_profile_fact", input: { id: fact.id } };
    const ask = await chat.say("please put my GPA back on my profile");
    assertNode.equal(next, null, `the model's confirm_profile_fact call ran: ${ask.reply}`);
    assertNode.ok((await gpa()).withdrawn_by_owner, "still set aside until their yes");
    next = { name: "confirm_profile_fact", input: { id: fact.id } };
    const yes = await chat.say("yes");
    const back = await gpa();
    assertNode.ok(!back.withdrawn_by_owner && back.restored_by_owner, `the fact is back: ${yes.reply}`);
    assertNode.equal(await state("greenhouse:acme:1"), "not_submitted", "putting the fact back re-queues nothing: the person approves again");
    assertNode.equal((await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${WHO2}' and state = 'queued'`)).trim(), "1");
    assertNode.doesNotMatch(yes.reply, /stopped and not sent/);

    // 3. A correction through correct_profile_fact: the application stating the old value is stopped and named.
    await seed("greenhouse:core:1", "Core", "3.9");
    next = { name: "correct_profile_fact", input: { id: fact.id, text: "GPA: 3.7" } };
    const fixed = await chat.say("my GPA is 3.7 now");
    assertNode.equal(next, null, `the model's correct_profile_fact call ran: ${fixed.reply}`);
    assertNode.equal((await gpa()).text, "GPA: 3.7");
    assertNode.match(fixed.reply, /1 approved application that hadn't gone out yet states that answer, so it is stopped and not sent \(Core\)/, `the reply names what the correction stopped: ${fixed.reply}`);
    assertNode.equal(await state("greenhouse:core:1"), "not_submitted");
    assertNode.equal((await pg.sql(`select string_agg(reason, ',' order by id) from public.career_apply_fact_changes where user_id = '${WHO2}' and reason <> 'fact_write'`)).trim(), "set_aside,corrected");
    // The fact writes themselves (the thread's commit) recorded the set-aside and the correction too, by fact id.
    assertNode.equal((await pg.sql(`select count(*) from public.career_apply_fact_changes where user_id = '${WHO2}' and reason = 'fact_write' and '${fact.id}' = any(fact_ids)`)).trim(), "2");

    // 4. The stop cannot run (the function is gone): the reply says the approved applications could not be checked.
    await pg.sql(await Deno.readTextFile(ROLLBACK));
    await seed("greenhouse:dune:1", "Dune", "3.7");
    next = { name: "correct_profile_fact", input: { id: fact.id, text: "GPA: 3.6" } };
    const quiet = console.error; console.error = () => {};
    let unchecked: Awaited<ReturnType<typeof chat.say>>;
    try { unchecked = await chat.say("my GPA is 3.6 now"); } finally { console.error = quiet; }
    assertNode.equal((await gpa()).text, "GPA: 3.6");
    assertNode.ok(unchecked.reply.includes(STALE_UNCHECKED_LINE), `a stop that could not run is said: ${unchecked.reply}`);
    assertNode.doesNotMatch(unchecked.reply, /stopped and not sent/);
  } finally { handler?.restore(); globalThis.fetch = realFetch; await pg.stop(); }
} });
