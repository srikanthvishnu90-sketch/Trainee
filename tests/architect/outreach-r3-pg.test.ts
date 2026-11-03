// OUTREACH R3 END TO END (2026-10-31): sampled flows on real Postgres 16 (every migration) through the sending rail's own
// functions, the outreach store over the PostgREST double with the chat's own hand-off (agent-chat handler-career.ts:
// outreachTurn -> onApproved -> queueApprovedOutreach), the worker and the reply check, and a fake Gmail at the HTTP
// boundary. The pure battery is tests/architect/scenarios-outreach-r3.test.ts; this reads the database's rows and what
// "Gmail" received. Nothing leaves the machine; no model is called.
//   A  two approvals of the same address at once (two batches, two chats, two sessions): one email.
//   B  a draft approved, edited, approved again before the worker ran: exactly the new version goes, once.
//   C  an approval the rail refuses for good (opted out with anyone, bounced for anyone, already emailed): the chat says
//      so and the draft says why; nothing goes to them.
//   D  a stop, a bounce, or an answer on a follow-up's sequence recorded after the claim and before the send: never sent;
//      the email ends cancelled with the reason; the rest of the claim goes once each.
//   E  a retried email whose approval passed 7 days: not sent (lapsed, draft lapses) unless the earlier try went (then
//      recorded as sent, once).
//   F  an opt-out after Gmail's snippet, read by the reply check: the address is on the do-not-contact list and another
//      person's email to it is cancelled.
//   G  every final state has a readable reason, and one person's actions never touch another's rows.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { approvedDrafts, CI, draftsReader, FakeGmail, haveDb, person, railDb, railDeps, rows, uid as uidOf } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { serviceRpc } from "../flow/pgwire.ts";
import { footerOf, messageOf, OUTREACH_INTENT, outreachTurn, payloadHash, supabaseOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { queueApproved, queueApprovedOutreach, runReplyCheck, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const RUN = crypto.randomUUID().slice(0, 3);
const at = (local: string) => `${local}.${RUN}@example.test`;
let nextUser = 1;
const uid = () => uidOf(nextUser++, `7${RUN}`.slice(0, 3));
const HOUR = 3600_000, DAY = 86_400_000;
const problems: string[] = [];
const check = (cond: unknown, what: string) => { if (!cond) problems.push(what); };
let flows = 0;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

Deno.test({ name: "outreach r3 end to end: ~45 flows on real Postgres through the hand-off, the rail and a fake Gmail", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]) Deno.env.delete(k);
  const db = await railDb();
  const realFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async (input: Request | URL | string) => { outside++; throw new Error(`network refused in this test: ${String(input instanceof Request ? input.url : input)}`); }) as typeof fetch;
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const conn = await db.conn();
    const rpc = serviceRpc(conn);
    const outreachDeps = { ...rpc, drafts: draftsReader(db) };
    const intents = new Map<string, string>();
    const store = { ...supabaseOutreachStore(admin), lastAssistantIntent: async (tid: string) => intents.get(tid) ?? null };
    // The chat's own hand-off (handler-career.ts): exactly the drafts the answer approved, refusals handed back.
    const onApproved = async (u: string, items: { draftId: string; approvalHash: string }[]) =>
      (await queueApprovedOutreach(outreachDeps, u, items)).filter((r) => r.status === "refused").map((r) => ({ draftId: r.sourceId, reason: String(r.reason ?? "") }));
    const drain = async (d: WorkerDeps, worker: string) => { for (let i = 0; i < 20; i++) { const s = await runSendWorker(d, { worker, deadlineMs: 60_000 }); if (!s.claims) break; } };
    const batch = async (u: string, chat: string, tos: string[], tag: string) => {
      const ds = [];
      for (const [i, to] of tos.entries()) {
        const d = { n: i + 1, recipient: { name: `Person ${tag}${i + 1}`, firm: "Acme", title: "", school: "", email: to, source: "contacts.csv" }, subject: `Hello ${tag}${i + 1}`, body: "Would you have 15 minutes?", footer: footerOf("Sam"),
          shared: [], status: "shown" as const, hash: "", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date().toISOString() };
        d.hash = await payloadHash(messageOf(d));
        ds.push(d);
      }
      const saved = await store.saveBatch(u, chat, ds, Date.now());
      intents.set(chat, OUTREACH_INTENT);
      return saved;
    };
    // Every queue row and draft of these people ends with words, never an empty reason.
    const readable = async (users: string[], tag: string) => {
      const list = users.map(q).join(",");
      const bad = await rows(db, `select id, state, result from public.career_send_queue where user_id in (${list}) and state not in ('queued', 'sending') and coalesce(btrim(result), '') = ''
        union all select id, status, result from public.career_outreach_drafts where user_id in (${list}) and status in ('skipped', 'failed') and coalesce(btrim(result), '') = ''`);
      check(bad.length === 0, `${tag}: final states without a reason: ${JSON.stringify(bad)}`);
    };

    await t.step("A. two approvals of the same address at once, two chats, two sessions (6 flows)", async () => {
      for (let f = 0; f < 6; f++) {
        flows++;
        const u = uid(), other = uid(), x = at(`a${f}`);
        await person(db, u); await person(db, other);
        // Another person emails the same contact: their own choice, never touched by this person's hand-offs.
        const theirs = await approvedDrafts(db, other, [x]);
        await queueApprovedOutreach(outreachDeps, other, theirs);
        const one = await approvedDrafts(db, u, [x], { subject: () => `First ${f}` });
        const two = await approvedDrafts(db, u, [x], { subject: () => `Second ${f}` });
        const s1 = await db.conn(), s2 = await db.conn();
        const m1 = messageOf((await draftsReader(db)(u, [one[0].draftId]))[0]);
        await s1.query(`begin; set local role service_role; select public.career_send_enqueue(${q(JSON.stringify({ user: u, items: [{ kind: "outreach", source_id: one[0].draftId, approval_hash: one[0].approvalHash, to: x, subject: m1.subject, body: m1.text }] }))}::jsonb)`);
        let second: unknown = null;
        const p2 = queueApprovedOutreach({ ...serviceRpc(s2), drafts: draftsReader(db) }, u, two).then((r) => { second = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        check(second === null, `A${f}: the second hand-off waits for the first (it answered ${JSON.stringify(second)} while the first was open)`);
        await s1.query("commit");
        const r2 = await p2;
        check(r2[0]?.status === "refused" && r2[0]?.reason === "already_emailed", `A${f}: the second approval of the same address is refused (${JSON.stringify(r2)})`);
        const gmail = new FakeGmail();
        await drain(railDeps(db, conn, gmail), `w-a-${f}`);
        const mine = gmail.sent.filter((m) => m.to === x && m.account === u);
        check(mine.length === 1, `A${f}: ${x} got ${mine.length} emails from this person, wanted 1`);
        check(gmail.sent.filter((m) => m.to === x && m.account === other).length === 1, `A${f}: the other person's own email to them went, once`);
        const d2 = (await rows(db, `select status, result from public.career_outreach_drafts where id = ${q(two[0].draftId)}`))[0];
        check(d2?.status === "skipped" && d2?.result === "already_emailed", `A${f}: the refused draft says why (${JSON.stringify(d2)})`);
        await readable([u, other], `A${f}`);
      }
    });

    await t.step("B. approved, edited, approved again before the worker ran (6 flows)", async () => {
      for (let f = 0; f < 6; f++) {
        flows++;
        const u = uid(), chat = crypto.randomUUID(), n = 1 + (f % 3);
        await person(db, u);
        const tos = Array.from({ length: n + 1 }, (_, i) => at(`b${f}-${i}`));
        await batch(u, chat, tos, "b");
        const r1 = await outreachTurn({ message: "send all", userId: u, threadId: chat, now: Date.now(), store, onApproved, gmailConnected: async () => true });
        check(r1?.status === "approved", `B${f}: send all approves (${r1?.status})`);
        intents.set(chat, OUTREACH_INTENT);
        const k = 1 + (f % (n + 1));
        const words = `Hi there, a shorter note (${f}): could we talk for 10 minutes?`;
        const e = await outreachTurn({ message: `edit ${k}: ${words}`, userId: u, threadId: chat, now: Date.now(), store, onApproved });
        check(e?.status === "edit", `B${f}: the edit of an approved draft is taken (${e?.status})`);
        intents.set(chat, OUTREACH_INTENT);
        const r2 = await outreachTurn({ message: `send ${k}`, userId: u, threadId: chat, now: Date.now(), store, onApproved, gmailConnected: async () => true });
        check(r2?.status === "approved" && !/Won't be sent/.test(r2.reply), `B${f}: the new version is approved and said to go (${r2?.reply})`);
        const gmail = new FakeGmail();
        await drain(railDeps(db, conn, gmail), `w-b-${f}`);
        for (const [i, to] of tos.entries()) {
          const got = gmail.to(to);
          check(got.length === 1, `B${f}: ${to} got ${got.length} emails, wanted 1`);
          if (i + 1 === k) check(got[0]?.text.startsWith(words), `B${f}: the edited draft went as edited (${JSON.stringify(got[0]?.text.slice(0, 60))})`);
        }
        const rail = await rows(db, `select state, result from public.career_send_queue where user_id = ${q(u)} and state = 'cancelled'`);
        check(rail.length === 1 && rail[0].result === "replaced by a newer approval of the same draft", `B${f}: the older approval is replaced, saying so (${JSON.stringify(rail)})`);
        await readable([u], `B${f}`);
      }
    });

    await t.step("C. approvals the rail refuses for good are never said to be going (6 flows)", async () => {
      for (let f = 0; f < 6; f++) {
        flows++;
        const u = uid(), other = uid(), chat = crypto.randomUUID();
        await person(db, u); await person(db, other);
        const opted = at(`c${f}-opted`), bounced = at(`c${f}-bounced`), already = at(`c${f}-already`), fine = at(`c${f}-fine`);
        await db.sql.query(`insert into public.career_outreach_dnc(user_id, email_hash, reason) values (${q(other)}, public.career_send_email_hash(${q(opted)}), 'test');
          insert into public.career_send_bad_addresses(email_hash) values (public.career_send_email_hash(${q(bounced)})) on conflict do nothing`);
        await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [already]));
        const tos = f % 2 ? [opted, bounced, already, fine] : [opted, bounced, already];
        await batch(u, chat, tos, "c");
        const r = await outreachTurn({ message: "send all", userId: u, threadId: chat, now: Date.now(), store, onApproved, gmailConnected: async () => true });
        check(/Won't be sent: 1 \(Person c1: they asked not to be contacted\), 2 \(Person c2: that address bounced before[^)]*\), 3 \(Person c3: you already emailed them/.test(r?.reply ?? ""), `C${f}: the reply names each refusal (${r?.reply})`);
        check((f % 2 === 1) === /They go from your Gmail/.test(r?.reply ?? ""), `C${f}: "they go" only when one does (${r?.reply})`);
        const ds = await rows(db, `select recipient_email, status, result from public.career_outreach_drafts where user_id = ${q(u)} and thread_id = ${q(chat)} order by n`);
        check(JSON.stringify(ds.slice(0, 3).map((d: any) => `${d.status}|${d.result}`)) === JSON.stringify(["skipped|opted_out", "skipped|bad_address", "skipped|already_emailed"]), `C${f}: each refused draft says why (${JSON.stringify(ds)})`);
        const gmail = new FakeGmail();
        await drain(railDeps(db, conn, gmail), `w-c-${f}`);
        check(gmail.to(opted).length === 0 && gmail.to(bounced).length === 0 && gmail.to(already).length === 1, `C${f}: nothing to the refused addresses, one to the one already emailed`);
        if (f % 2) check(gmail.to(fine).length === 1, `C${f}: the fine one went once`);
        await readable([u], `C${f}`);
      }
    });

    await t.step("D. a stop, a bounce or an answer between the claim and the send (9 flows)", async () => {
      for (let f = 0; f < 9; f++) {
        flows++;
        const kind = (["stop", "bounce", "answer"] as const)[f % 3];
        const u = uid(), someone = uid();
        await person(db, u); await person(db, someone);
        const tos = [at(`d${f}-0`), at(`d${f}-1`), at(`d${f}-2`)];
        let target: string;
        let watchId: string;
        let rootId = "";
        if (kind === "answer") {
          // A sequence: the first email went (its thread th-...), a follow-up is due now; the contact answers in between.
          const [root] = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash({ to: tos[1], subject: "Hello", text: "First" }), to: tos[1], subject: "Hello", text: "First" }]);
          await db.sql.query(`update public.career_send_queue set state = 'sent', sent_at = now() - interval '5 days', gmail_id = 'g-${RUN}-${f}', gmail_thread = 'nothread-${RUN}-${f}' where id = ${q(root.id!)}`);
          const [fu] = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash({ to: tos[1], subject: "Re: Hello", text: "Following up" }), to: tos[1], subject: "Re: Hello", text: "Following up", followUpOf: root.id! }]);
          watchId = fu.id!;
          target = tos[1];
          await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [tos[0], tos[2]]));
          rootId = root.id!;
        } else {
          const items = await approvedDrafts(db, u, tos);
          await queueApprovedOutreach(outreachDeps, u, items);
          watchId = (await rows(db, `select id from public.career_send_queue where user_id = ${q(u)} and recipient_email = ${q(tos[1])}`))[0].id;
          target = tos[1];
        }
        const gmail = new FakeGmail();
        // The sequence's thread exists in Gmail only as our email: the last look before the follow-up finds no answer yet.
        const base = railDeps(db, conn, gmail);
        let fired = false;
        const deps: WorkerDeps = { ...base, fetch: (async (i: any, init?: any) => {
            const url = new URL(String(i instanceof Request ? i.url : i));
            if (/\/threads\/nothread-/.test(url.pathname)) return Response.json({ messages: [] });
            return gmail.fetch(i, init);
          }) as typeof fetch,
          rpc: async (name: string, a: any) => {
            if (name === "career_send_go" && a.p.id === watchId && !fired) {
              fired = true;
              // What the reply check records meanwhile, on its own session.
              if (kind === "stop") await db.sql.query(`insert into public.career_outreach_dnc(user_id, email_hash, reason) values (${q(someone)}, public.career_send_email_hash(${q(target)}), 'recipient asked to stop')`);
              else if (kind === "bounce") await db.sql.query(`insert into public.career_send_bad_addresses(email_hash) values (public.career_send_email_hash(${q(target)})) on conflict do nothing`);
              else await db.sql.query(`select public.career_send_record(${q(JSON.stringify({ id: rootId, kind: "reply" }))}::jsonb)`);
            }
            return base.rpc(name, a);
          } };
        await runSendWorker(deps, { worker: `w-d-${f}`, perAccount: 25, deadlineMs: 30_000 });
        await drain(railDeps(db, conn, gmail, { now: () => Date.now() + 2 * HOUR }), `w-d2-${f}`);
        check(fired, `D${f} ${kind}: the email reached the last check`);
        check(gmail.to(target).length === 0, `D${f} ${kind}: nothing went to ${target} after the ${kind} (got ${gmail.to(target).length})`);
        for (const other of tos.filter((x) => x !== target)) check(gmail.to(other).length === 1, `D${f} ${kind}: ${other} got ${gmail.to(other).length}, wanted 1`);
        const row = (await rows(db, `select state, result from public.career_send_queue where id = ${q(watchId)}`))[0];
        const want = kind === "stop" ? "opted_out" : kind === "bounce" ? "bad_address" : "sequence stopped";
        check(row?.state === "cancelled" && row?.result === want, `D${f} ${kind}: the email ends cancelled, saying ${want} (${JSON.stringify(row)})`);
        await readable([u], `D${f}`);
      }
    });

    await t.step("E. a retried email whose approval passed 7 days (6 flows)", async () => {
      for (let f = 0; f < 6; f++) {
        flows++;
        const went = f % 2 === 1;
        const u = uid(), to = at(`e${f}`);
        await person(db, u);
        const items = await approvedDrafts(db, u, [to]);
        await queueApprovedOutreach(outreachDeps, u, items);
        const gmail = new FakeGmail();
        // The first try: Gmail answers 500 (it did not take it), or takes it and the answer is lost (it went).
        let first = true;
        if (went) gmail.afterAccept = () => { if (first) { first = false; throw new TypeError("connection reset after Gmail took it"); } };
        else gmail.script = (_a, k) => (k === 1 ? new Response("{}", { status: 500 }) : null);
        await runSendWorker(railDeps(db, conn, gmail), { worker: `w-e-${f}`, deadlineMs: 10_000 });
        const mid = (await rows(db, `select state, attempts from public.career_send_queue where user_id = ${q(u)}`))[0];
        check(mid?.state === "queued" && mid?.attempts === 1, `E${f}: the first try is retried later (${JSON.stringify(mid)})`);
        // Eight days on (the account was paused, Gmail kept failing): the approval is now older than 7 days.
        await db.sql.query(`update public.career_outreach_drafts set approved_at = now() - interval '8 days', created_at = now() - interval '8 days' where user_id = ${q(u)}`);
        await drain(railDeps(db, conn, gmail, { now: () => Date.now() + HOUR }), `w-e2-${f}`);
        check(gmail.to(to).length === (went ? 1 : 0), `E${f}: ${went ? "the try that went is the only email" : "nothing goes on the lapsed approval"} (got ${gmail.to(to).length})`);
        const q2 = (await rows(db, `select state, result from public.career_send_queue where user_id = ${q(u)}`))[0];
        const d = (await rows(db, `select status, result from public.career_outreach_drafts where user_id = ${q(u)}`))[0];
        if (went) check(q2?.state === "sent" && d?.status === "sent", `E${f}: recorded as sent, the truth (${JSON.stringify([q2, d])})`);
        else check(q2?.state === "cancelled" && q2?.result === "approval lapsed (more than 7 days)" && d?.status === "skipped" && d?.result === "expired", `E${f}: lapsed with a reason, the draft lapses (${JSON.stringify([q2, d])})`);
        await readable([u], `E${f}`);
      }
    });

    await t.step("F. an opt-out after Gmail's snippet, read by the reply check (4 flows)", async () => {
      for (let f = 0; f < 4; f++) {
        flows++;
        const u = uid(), other = uid(), to = at(`f${f}`);
        await person(db, u); await person(db, other);
        await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [to]));
        const gmail = new FakeGmail();
        await drain(railDeps(db, conn, gmail), `w-f-${f}`);
        const sent = gmail.to(to)[0];
        const long = `Hi Sam,\n\n${"Thanks so much for reaching out and for the kind words about our team; it was a pleasure to meet so many students. ".repeat(3)}\n\n${["Please take me off your list.", "Merci de me désabonner.", "Bitte entfernen Sie mich aus Ihrem Verteiler.", "请不要再给我发邮件。"][f]}\n\nMaya`;
        gmail.reply(sent.threadId, `Maya <${to}>`, `Re: ${sent.subject}`, long.slice(0, 200));
        // Another person's email to the same contact waits on the rail.
        await queueApprovedOutreach(outreachDeps, other, await approvedDrafts(db, other, [to]));
        const replyId = gmail.threads.get(sent.threadId)!.at(-1)!.id;
        const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_");
        const deps: WorkerDeps = { ...railDeps(db, conn, gmail), fetch: (async (i: any, init?: any) => {
          const url = new URL(String(i instanceof Request ? i.url : i));
          if (url.pathname.endsWith(`/messages/${replyId}`) && url.searchParams.get("format") === "full") return Response.json({ id: replyId, payload: { mimeType: "text/plain", body: { data: b64(long) } } });
          return gmail.fetch(i, init);
        }) as typeof fetch };
        await runReplyCheck(deps, { recheckSeconds: 0 });
        const dnc = await rows(db, `select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash(${q(to)})`);
        check(dnc.length === 1, `F${f}: the opt-out is on the do-not-contact list`);
        const theirs = (await rows(db, `select state, result from public.career_send_queue where user_id = ${q(other)}`))[0];
        check(theirs?.state === "cancelled" && theirs?.result === "opted_out", `F${f}: another person's email to them is cancelled (${JSON.stringify(theirs)})`);
        await readable([u, other], `F${f}`);
      }
    });

    await t.step("G. no SECURITY DEFINER rail function a signed-in caller can run", async () => {
      flows++;
      const r = await rows(db, `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        and p.proname in ('career_send_enqueue', 'career_send_go', 'career_send_claim', 'career_send_complete_one') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`);
      check(r.length === 0, `G: callable by a signed-in caller: ${JSON.stringify(r)}`);
    });

    console.log(`[outreach r3 pg] ${flows} flows, ${problems.length} problems${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`);
    ok(outside === 0, `${outside} requests tried to leave the machine`);
    assertNode.deepStrictEqual(problems, [], "every flow holds (see the list above)");
  } finally {
    globalThis.fetch = realFetch;
    await db.stop();
  }
} });
