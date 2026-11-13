// Review of #800 (D-072 item 4, round 2): the hand-off fails closed. Nothing is sent without the person's yes to the exact card.
//   A  database: a row the person said "done" on (handoff_done_at) is never an ordinary approved row. Every claim but the
//      hand-off's own leaves it queued, untouched (the VM build from before 20261112160000, the person's own engine, any direct
//      claim): the release order "migration and chat first, VM build later" cannot press Submit. The hand-off claim
//      (career_apply_vm_claim_handoff) hands it out with its state in the same answer.
//   D  rollback: it closes, unsent, every hand-off row in the queue AND every one a worker holds that has not recorded the click
//      (the dead-worker sweep would otherwise put it back as an ordinary row); it runs twice; the migration applies again.
//   C  chat: the hand-off turn is held exactly as any other card's yes (after "don't apply"), and records neither a done nor a
//      yes on a turn another reply answers.
// The worker's side of A (apply-vm.cjs) and B are tests/career-apply-vm-handoff-failclosed.test.cjs.
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { handoffTurn, type HandoffRow, type HandoffStore } from "../../supabase/functions/_shared/career_apply_handoff.ts";
import { holdsCardApproval } from "../../supabase/functions/_shared/career_resume_task.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const MIGRATION = `${ROOT}/supabase/migrations/20261112160000_career_apply_handoff_recheck.sql`;
const ROLLBACK = `${ROOT}/supabase/rollbacks/20261112160000_career_apply_handoff_recheck.down.sql`;
const RESUME_HEX = Array.from(new TextEncoder().encode("%PDF-1.4\n% TEST resume for the hand-off\n")).map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.test("C: the hand-off turn on hold reads nothing and records nothing (no done, no yes); a bare yes after \"don't apply\" is held", async () => {
  const HASH = "c".repeat(64);
  const card: HandoffRow = { id: "row-1", company: "TEST Employer", state: "needs_user", reason: "ready_for_yes", handoff_done_at: "2026-11-13T10:00:00Z",
    evidence: { answers_card: { hash: HASH, answers: [{ field: "Email", value: "test.person@example.invalid" }] } } };
  const wall: HandoffRow = { id: "row-2", company: "TEST Wall", state: "needs_user", reason: "login_required", handoff_done_at: null, evidence: { handoff: { step: "sign in", link: "https://example.invalid/x" } } };
  const store = (rows: HandoffRow[]) => {
    const calls: string[] = [];
    const s: HandoffStore = {
      rows: () => { calls.push("rows"); return Promise.resolve(rows); },
      done: (_u, id) => { calls.push(`done:${id}`); return Promise.resolve({ ok: true }); },
      yes: (_u, id, h) => { calls.push(`yes:${id}:${h}`); return Promise.resolve({ ok: true }); },
      lastShown: () => { calls.push("lastShown"); return Promise.resolve({ id: "row-1", hash: HASH }); },
    };
    return { s, calls };
  };
  // Not held: the yes to the card this thread showed is recorded, with that card's hash (the behaviour the hold stops).
  const open = store([card]);
  const y = await handoffTurn({ message: "yes", userId: "u", threadId: "t", store: open.s });
  assertEquals(y?.status, "queued");
  assertEquals(open.calls.filter((c) => c.startsWith("yes:")), [`yes:row-1:${HASH}`]);
  // Held: the same yes, and a done, return before anything is read or written.
  for (const [message, rows] of [["yes", [card]], ["Yes", [card]], ["done", [wall]], ["done", [card]]] as const) {
    const held = store([...rows]);
    assertEquals(await handoffTurn({ message, userId: "u", threadId: "t", store: held.s, hold: true }), null, message);
    assertEquals(held.calls, [], `${message}: nothing read, no done, no yes`);
  }
  // The hold the handler passes is the card's own (career_resume_task.ts holdsCardApproval): "don't apply" is the limit, a bare yes is held.
  const profile = { _resumeTask: { at: new Date().toISOString(), limits: ["no_apply"] } };
  assert(holdsCardApproval(profile, "yes", Date.now()), "a bare yes after \"don't apply\" is held");
  assert(!holdsCardApproval({}, "yes", Date.now()), "no limit, no hold");
  // The handler's wiring: the hand-off turn gets the card's hold, the Outlook answer and crisis text as its hold, and nothing
  // else supplies the reply once it has answered (every reply before it in the order is in its guard or its hold).
  const src = await Deno.readTextFile(`${ROOT}/supabase/functions/agent-chat/handler-career.ts`);
  const held = /const handoffHeld = cardHold \|\| !!outlookAns\s*\|\| \(brainMode\(Deno\.env\) === "staged" && !tapIn && !careerTask && !careerBatch && !host\.isHostControlled\(message, ctx\) && !!crisisReply\(message\)\);/.exec(src);
  assert(held, "handoffHeld = the card's hold, the Outlook answer, crisis text");
  const turn = /const handoffAns = !tapIn && !connAns && !siteNo && !careerTask && !careerBatch && !host\.isHostControlled\(message, ctx\)\s*\? await handoffTurn\(\{ message, userId: user\.id, threadId: tid, store: supabaseHandoffStore\(admin\), hold: handoffHeld \}\)/.exec(src);
  assert(turn, "the hand-off turn is called with hold: handoffHeld, behind the connector and site-refusal answers");
  assert(src.indexOf("const cardHold = holdsCardApproval(") < held!.index && src.indexOf("const outlookAns =") < held!.index && held!.index < turn!.index, "the holds are known before the turn runs");
});

Deno.test({
  name: "A, D: a hand-off row leaves the queue only through the hand-off claim (never an ordinary drive, whatever the release order); the rollback closes queued and held hand-off rows unsent and runs twice",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the hand-off fail-closed test needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    const pg = await startPg({ includeBridge: true });
    try {
      const U = ["00000000-0000-4000-8000-0000000d0801", "00000000-0000-4000-8000-0000000d0802", "00000000-0000-4000-8000-0000000d0803", "00000000-0000-4000-8000-0000000d0804"];
      const link = (n: number) => `http://127.0.0.1:9/greenhouse/F${n}/1`; // never opened: this test drives no browser
      for (const [k, v] of [["APPLY_VM", "on"], ["APPLY_VM_USER_IDS", "*"], ["APPLY_VM_ALLOW_LOCAL", "on"]]) {
        await pg.sql(`insert into career_cloud_settings(key,value) values ('${k}','${v}') on conflict (key) do update set value=excluded.value`);
      }
      const sha = (await pg.sql(`select encode(sha256(decode('${RESUME_HEX}','hex')),'hex')`)).trim();
      for (const u of U) {
        await pg.sql(`insert into auth.users(id,email) values ('${u}','${u}@example.test') on conflict do nothing;
          insert into profiles(id) values ('${u}') on conflict do nothing;
          insert into career_watch_kv(user_id,key,value) values ('${u}','career:account','{"epoch":1,"version":1,"paused":false}') on conflict do nothing;
          insert into career_apply_cloud_optin(user_id,enabled,terms,terms_sha256,privacy_epoch,turned_on_at) values ('${u}',true,'test terms',repeat('a',64),1,now()) on conflict do nothing;
          insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch) values ('${u}','${sha}','resume.pdf',decode('${RESUME_HEX}','hex'),1) on conflict do nothing;
          insert into career_message_approval_private.test_users(user_id) values ('${u}') on conflict do nothing;
          select public.career_resume_put('${u}'::uuid,'${sha}','file','test:handoff','resume.pdf',decode('${RESUME_HEX}','hex'),'seed:handoff');`);
      }
      // One approved application each, with a real stored approval for exactly its payload (as a tapped card leaves it).
      const fields = `'[{"label":"First Name","value":"Test","factId":"f1"},{"label":"Email","value":"test.person@example.invalid","factId":"f3"}]'::jsonb`;
      const vals = U.map((u, i) => `('${u}','FAILCLOSED-${i + 1}','TEST Employer ${i + 1}','${link(i + 1)}')`).join(", ");
      const rows = `select x.u, x.jid, x.co, x.url, jsonb_build_object('version',1,'user_id',x.u,'job_id',x.jid,'company',x.co,'url',x.url,'fields',${fields},'privacy_epoch',1,'account_version',1,'expires_at','2099-01-01T00:00:00Z'::text,'engine_approval',repeat('e',64),'resume_sha256','${sha}','destination',x.url) as p
        from (values ${vals}) as x(u,jid,co,url)`;
      await pg.sql(`with s as (${rows}), a as (insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at)
          select s.u::uuid, s.jid, public.career_apply_payload_hash(s.p), s.p, now(), now() from s returning id, user_id, job_id, batch_hash)
        insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
          select a.id, a.user_id, gen_random_uuid(), 0, a.batch_hash, now(), now() + interval '23 hours' from a;
        with s as (${rows}) insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
          select s.u::uuid, s.jid, s.co, s.url, s.p, public.career_apply_payload_hash(s.p), public.career_apply_payload_hash(s.p) from s;`);
      type Row = { id: string; state: string; reason: string | null; source: string | null; attempts: number; lease_token: string | null; vm_worker: string | null; vm_phase: string | null; evidence: Record<string, any>; handoff_done_at?: string | null; handoff_yes?: { card_hash: string } | null };
      const row = async (u: string): Promise<Row> => JSON.parse(await pg.sql(`select row_to_json(j) from (select * from career_apply_jobs where user_id='${u}') j`));
      const json = async (q: string) => JSON.parse(await pg.sql(`select (${q})::text`));
      const plainClaim = (w: string) => json(`public.career_apply_vm_claim('${w}', 10, 1, '{}')`) as Promise<any[]>;
      const handoffClaim = (w: string) => json(`public.career_apply_vm_claim_handoff('${w}', 10, 1, '{}')`) as Promise<any[]>;
      const complete = (c: any, w: string, state: string, reason: string, ev: unknown) =>
        json(`public.career_apply_vm_complete('${c.id}'::uuid, '${c.lease_token}'::uuid, '${w}', '${state}', '${reason}', $e$${JSON.stringify(ev)}$e$::jsonb)`);
      const byUser = (claimed: any[]) => Object.fromEntries(claimed.map((c) => [c.user_id, c]));
      const CARD = "c".repeat(64);

      await t.step("ordinary rows: both claims hand them out as before; the hand-off claim says they are ordinary ({done_at: null, yes: null})", async () => {
        const first = await handoffClaim("vm-new");
        assertEquals(first.map((c) => c.user_id).sort(), [...U].sort());
        for (const c of first) {
          assertEquals(c.handoff, { done_at: null, yes: null });
          assert(c.lease_token && c.payload && c.payload_hash && c.approval_id, "the plain claim's own row, whole");
        }
        // Every one stops at a sign-in wall, nothing sent, with its hand-off (what the worker records, apply-vm.cjs settle).
        for (const c of first) {
          const done = await complete(c, "vm-new", "needs_user", "login_required", { nothing_sent: true, link: c.url, handoff: { reason: "login_required", link: c.url, step: "sign in yourself" } });
          assertEquals(done.state, "needs_user");
        }
      });

      await t.step("the person says done: the rows go back to the queue as hand-off rows", async () => {
        for (const u of U) {
          const r = await row(u);
          assertEquals(await json(`public.career_apply_handoff_done_as('${u}'::uuid, '${r.id}'::uuid)`), { ok: true, state: "queued", recheck: true });
          const q = await row(u);
          assertEquals([q.state, q.source, q.attempts, q.lease_token], ["queued", null, 0, null]);
          assert(q.handoff_done_at, "handoff_done_at set");
        }
      });

      await t.step("A (release order: migration and chat live, the VM build still the old one): the plain claim never hands a hand-off row out, and no other claim can start a drive on it", async () => {
        assertEquals(await plainClaim("vm-old"), [], "the old build is handed nothing: no ordinary drive, no Submit");
        assertEquals(await plainClaim("vm-old"), []);
        for (const u of U) {
          const q = await row(u);
          assertEquals([q.state, q.source, q.attempts, q.lease_token, q.vm_worker], ["queued", null, 0, null, null], "left exactly as the done left it");
        }
        // Any other claim's own write (the person's engine, the cloud runner: queued -> driving) is skipped for such a row.
        const id = (await row(U[0])).id;
        const n = await pg.sql(`with u as (update career_apply_jobs set state='driving', attempts=1, claimed_at=now(), lease_token=gen_random_uuid(), source='own_computer' where id='${id}' returning 1) select count(*) from u`);
        assertEquals(n.trim(), "0");
        assertEquals((await row(U[0])).state, "queued");
        // The setting that opens the guard is the hand-off claim's own and does not outlive it.
        assertEquals((await pg.sql(`select coalesce(current_setting('career.apply_handoff_claim', true), '')`)).trim(), "");
      });

      let held: Record<string, any> = {};
      await t.step("A: the hand-off claim hands them out with their state in the same answer; a re-check records the card; the yes rides the next claim", async () => {
        const got = await handoffClaim("vm-new");
        assertEquals(got.map((c) => c.user_id).sort(), [...U].sort());
        for (const c of got) { assert(typeof c.handoff?.done_at === "string" && c.handoff.done_at, "done_at with the row"); assertEquals(c.handoff.yes, null); }
        held = byUser(got);
        // U[1], U[2], U[3]: the re-check found the form; the exact-answers card is recorded, nothing sent. U[0] is still being re-checked.
        for (const u of [U[1], U[2], U[3]]) {
          await complete(held[u], "vm-new", "needs_user", "ready_for_yes", { nothing_sent: true, link: held[u].url, answers_card: { url: held[u].url, payload_hash: held[u].payload_hash, answers: [{ field: "Email", value: "test.person@example.invalid" }], hash: CARD } });
        }
        // U[1] and U[2] say yes to that card; U[3] has not answered.
        for (const u of [U[1], U[2]]) {
          const r = await row(u);
          assertEquals(await json(`public.career_apply_handoff_yes_as('${u}'::uuid, '${r.id}'::uuid, '${CARD}')`), { ok: true, state: "queued", card_hash: CARD });
        }
        assertEquals(await plainClaim("vm-old"), [], "a yes row is a hand-off row too: never the plain claim's");
        // U[2]'s yes run is claimed and has recorded the click (the last heartbeat before Submit); U[1]'s waits in the queue.
        await pg.sql(`update career_apply_claim_turns set queued = false where user_id = '${U[1]}'`);
        const yesRun = await handoffClaim("vm-new");
        assertEquals(yesRun.map((c) => c.user_id), [U[2]]);
        assertEquals(yesRun[0].handoff.yes?.card_hash, CARD, "the yes, with the row");
        held[U[2]] = yesRun[0];
        assertEquals(await json(`public.career_apply_vm_heartbeat('${yesRun[0].id}'::uuid, '${yesRun[0].lease_token}'::uuid, 'vm-new', 'submitting')`), { ok: true });
        await pg.sql(`update career_apply_claim_turns set queued = true where user_id = '${U[1]}'`);
        const st = await Promise.all(U.map(row));
        assertEquals(st.map((r) => [r.state, r.state === "driving" ? r.vm_phase : null, r.reason]), [["driving", "preparing", null], ["queued", null, null], ["driving", "submitting", null], ["needs_user", null, "ready_for_yes"]]);
      });

      await t.step("the constraint is validated", async () => {
        assertEquals((await pg.sql(`select convalidated from pg_constraint where conname = 'career_apply_jobs_handoff_yes_shape'`)).trim(), "t");
      });

      await t.step("D: the rollback closes the queued row AND the held re-check, unsent; the recorded click and the unanswered card are left; it runs twice", async () => {
        const down = await Deno.readTextFile(ROLLBACK);
        await pg.sql(down);
        const st = await Promise.all(U.map(row));
        assertEquals([st[0].state, st[0].reason, st[0].evidence.nothing_sent, st[0].evidence.closed], ["not_submitted", "handoff_rolled_back", true, "handoff_rolled_back"], "the held re-check (driving, no click recorded)");
        assertEquals([st[1].state, st[1].reason, st[1].evidence.nothing_sent], ["not_submitted", "handoff_rolled_back", true], "the queued yes row");
        assertEquals([st[2].state, st[2].vm_phase], ["driving", "submitting"], "a recorded click is never called not sent: its worker reports the outcome");
        assertEquals([st[3].state, st[3].reason], ["needs_user", "ready_for_yes"], "a card nobody answered stays a stop; nothing can queue it now");
        assert(!("handoff_done_at" in st[0]) && !("handoff_yes" in st[0]), "the columns are gone");
        assertEquals((await pg.sql(`select count(*) from pg_proc where proname in ('career_apply_vm_claim_handoff','career_apply_handoff_done_as','career_apply_handoff_yes_as','career_apply_vm_handoff_state','career_apply_handoff_requeue','career_apply_handoff_refusal','career_apply_handoff_claim_guard')`)).trim(), "0");
        assertEquals((await pg.sql(`select count(*) from pg_trigger where tgname = 'career_apply_handoff_claim_guard'`)).trim(), "0");
        // The worker that held the re-check finds no lease at its next check (the one before Submit): it stops unsent.
        assertEquals(await json(`public.career_apply_vm_heartbeat('${held[U[0]].id}'::uuid, '${held[U[0]].lease_token}'::uuid, 'vm-new', 'submitting')`), { ok: false, why: "lease_lost" });
        // Nothing of the hand-off is left for any claim or for the dead-worker sweep to drive as an ordinary row.
        await pg.sql(`update career_apply_jobs set vm_heartbeat_at = now() - interval '1 hour' where user_id in ('${U[0]}','${U[1]}')`);
        await json(`public.career_apply_vm_reap(30)`);
        assertEquals(await plainClaim("vm-old"), []);
        assertEquals((await Promise.all([U[0], U[1]].map(row))).map((r) => r.state), ["not_submitted", "not_submitted"]);
        await pg.sql(down); // re-runnable: the columns its first statement read are gone
        await pg.sql(down);
      });

      await t.step("the migration applies again after the rollback, and twice", async () => {
        const up = await Deno.readTextFile(MIGRATION);
        await pg.sql(up);
        await pg.sql(up);
        assertEquals((await pg.sql(`select to_regprocedure('public.career_apply_vm_claim_handoff(text,integer,integer,text[])') is not null and exists (select 1 from pg_trigger where tgname = 'career_apply_handoff_claim_guard')
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_apply_jobs' and column_name = 'handoff_done_at')`)).trim(), "t");
        assertEquals((await pg.sql(`select convalidated from pg_constraint where conname = 'career_apply_jobs_handoff_yes_shape'`)).trim(), "t");
        assertEquals((await pg.sql(`select has_function_privilege('apply_vm_worker', 'public.career_apply_vm_claim_handoff(text,integer,integer,text[])', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.career_apply_vm_claim_handoff(text,integer,integer,text[])', 'EXECUTE')
          and not has_function_privilege('anon', 'public.career_apply_vm_claim_handoff(text,integer,integer,text[])', 'EXECUTE')`)).trim(), "t", "the worker's role and the service role only");
        assertEquals(await handoffClaim("vm-new"), []);
      });
    } finally {
      await pg.stop();
    }
  },
});
