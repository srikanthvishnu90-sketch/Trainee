// NETWORKING OUTREACH END TO END (owner rules, 2026-10-30): a seeded sample of ~80 flows through the rail's own functions
// (career_send_enqueue / _claim / _go / _complete / _record / _replies_due, every migration) on real Postgres, the
// outreach and replies stores over the PostgREST double, and a fake Gmail at the HTTP boundary that keeps each account's
// Sent mail and threads. The pure battery is tests/architect/scenarios-outreach.test.ts; this reads the database's rows.
//   A  exactly once under failure: a lost answer, a break before Gmail took it, a 5xx, a 429, Gmail's quota in its own words,
//      a worker that died after Gmail took it; then the next runs: each address gets exactly one email, exactly as approved.
//   B  several sender instances at once over many people: each email exactly once.
//   C  an approval lives 7 days: queued behind a pause, then resumed; inside 7 days it goes, after it lapses (cancelled on
//      the rail, the draft skipped/'expired' so "show lapsed" finds it).
//   D  a follow-up due while an answer (a reply, a stop, a bounce) already sits on its sequence's threads, not yet read by
//      the reply check: never sent, the sequence stops; an out-of-office or a delay notice does not stop it.
//   E  an opt-out or a bounce to one person holds for everyone: another person's queued email is cancelled, their new one
//      refused, and the drafting store reports the address as blocked.
//   F  approvals bound to the chat that showed the batch, on the real drafts table (supabaseOutreachStore).
//   G  the card's address label rides on the queue row.
//   H  the replies lane drafts nothing for a paused person (career_quiet_users).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { rng } from "./scenarios-fixture.ts";
import { approvedDrafts, CI, draftsReader, FakeGmail, haveDb, person, railDb, railDeps, rows, uid as uidOf } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { serviceRpc } from "../flow/pgwire.ts";
import { emailHash, footerOf, messageOf, type OutreachDraft, OUTREACH_INTENT, outreachTurn, payloadHash, supabaseOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { queueApproved, queueApprovedOutreach, runReplyCheck, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";
import { runFollowupDrafts, supabaseRepliesStore } from "../../supabase/functions/_shared/career_outreach_replies.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const RUN = crypto.randomUUID().slice(0, 3);
const at = (local: string) => `${local}.${RUN}@example.test`;
let nextUser = 1;
const uid = () => uidOf(nextUser++, `9${RUN}`.slice(0, 3));
const HOUR = 3600_000, DAY = 86_400_000;
const R = rng(20261030);
const problems: string[] = [];
const check = (cond: unknown, what: string) => { if (!cond) problems.push(what); };
let flows = 0;

Deno.test({ name: "outreach end to end: ~80 flows through the rail's functions, the stores and a fake Gmail on real Postgres", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  for (const k of ["ANTHROPIC_API_KEY"]) Deno.env.delete(k);
  const db = await railDb();
  // Nothing may leave the machine: every fetch that is not the PostgREST double or the fake Gmail is refused and counted.
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
    const sentTo = (g: FakeGmail, addr: string) => g.sent.filter((m) => m.to === addr);
    // Workers run until nothing is due at `now` (each pass claims again); the clock is passed, never read here.
    // Until nothing is left to claim (a slow CI runner can end a pass on its deadline with work still due), bounded.
    const drain = async (d: WorkerDeps, worker: string, passes = 40) => { let n = 0; for (let i = 0; i < passes; i++) { const s = await runSendWorker(d, { worker, deadlineMs: 120_000 }); n += s.sent + s.already_sent; if (!s.claims) break; } return n; };
    // The first email to an address, or a failure that says what the queue holds instead of a TypeError.
    const firstTo = async (gmail: FakeGmail, addr: string, u: string) => {
      const m = gmail.to(addr)[0];
      if (!m) throw new Error(`nothing was sent to ${addr}; queue: ${JSON.stringify(await rows(db, `select state, attempts, result, next_at, lease_owner, lease_until, now() as db_now from public.career_send_queue where user_id = '${u}'`))}; account: ${JSON.stringify(await rows(db, `select * from public.career_send_accounts where user_id = '${u}'`))}; gmail sent ${gmail.sent.length}`);
      return m;
    };

    await t.step("A. exactly once under failure (12 flows)", async () => {
      const modes = ["lost_answer", "throw_before", "500", "429", "403_daily_words", "died_after_accept"] as const;
      for (let f = 0; f < 12; f++) {
        flows++;
        const mode = modes[f % modes.length], u = uid(), n = R.int(1, 3);
        await person(db, u);
        const addrs = Array.from({ length: n }, (_, i) => at(`a${f}-${i}`));
        const items = await approvedDrafts(db, u, addrs);
        await queueApprovedOutreach(outreachDeps, u, items);
        const gmail = new FakeGmail();
        let first = true;
        if (mode === "lost_answer") gmail.afterAccept = () => { if (first) { first = false; throw new TypeError("connection reset after Gmail took it"); } };
        if (mode !== "lost_answer" && mode !== "died_after_accept") gmail.script = (_a, k) => k !== 1 ? null : mode === "throw_before" ? "throw" : mode === "500" ? new Response("{}", { status: 500 })
          : mode === "429" ? new Response(JSON.stringify({ error: { code: 429, message: "Too many requests" } }), { status: 429, headers: { "retry-after": "60" } })
          : new Response(JSON.stringify({ error: { code: 403, message: "Daily user sending quota exceeded." } }), { status: 403 });
        const base = railDeps(db, conn, gmail);
        if (mode === "died_after_accept") {
          // The worker dies after Gmail took the first email and before anything is recorded: its lease lapses.
          const dying: WorkerDeps = { ...base, rpc: async (name: string, a: any) => { if (name === "career_send_complete") throw new Error("worker died"); return base.rpc(name, a); } };
          await runSendWorker(dying, { worker: `w-die-${f}`, perAccount: 1, deadlineMs: 5_000 }).catch(() => null);
        } else {
          await runSendWorker(base, { worker: `w-a-${f}`, deadlineMs: 30_000 });
        }
        if (mode === "403_daily_words") {
          const acct = await rows(db, `select state from public.career_send_accounts where user_id = '${u}'`);
          check(acct[0]?.state === "backoff", `A${f} ${mode}: Gmail's quota in its own words backs the account off (got ${acct[0]?.state})`);
        }
        // Later runs (the lease lapsed, the backoff passed).
        const later = railDeps(db, conn, gmail, { now: () => Date.now() + 2 * HOUR });
        await drain(later, `w-b-${f}`);
        const q = await rows(db, `select recipient_email, state from public.career_send_queue where user_id = '${u}' order by recipient_email`);
        check(q.every((r: any) => r.state === "sent"), `A${f} ${mode}: every email ends sent (${JSON.stringify(q)})`);
        for (const [i, a] of addrs.entries()) {
          const got = sentTo(gmail, a);
          check(got.length === 1, `A${f} ${mode}: ${a} got ${got.length} emails, wanted exactly 1`);
          const d = (await rows(db, `select recipient, subject, body, footer from public.career_outreach_drafts where id = '${items[i].draftId}'`))[0];
          const m = messageOf(d);
          check(got[0] && got[0].subject === m.subject && got[0].text === m.text, `A${f} ${mode}: exactly the approved payload`);
        }
      }
    });

    await t.step("B. three sender instances at once over many people (8 flows)", async () => {
      for (let f = 0; f < 8; f++) {
        flows++;
        const people = Array.from({ length: R.int(2, 4) }, () => uid());
        const gmail = new FakeGmail();
        const want: string[] = [];
        for (const [k, u] of people.entries()) {
          await person(db, u);
          const addrs = Array.from({ length: R.int(3, 8) }, (_, i) => at(`b${f}-${k}-${i}`));
          want.push(...addrs);
          await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, addrs));
        }
        const cs = [await db.conn(), await db.conn(), await db.conn()];
        await Promise.all(cs.map((c, i) => runSendWorker(railDeps(db, c, gmail), { worker: `w-b${f}-${i}`, accounts: 2, perAccount: 3 })));
        for (const c of cs) c.close();
        for (const a of want) check(sentTo(gmail, a).length === 1, `B${f}: ${a} got ${sentTo(gmail, a).length} emails`);
        check(gmail.sent.length === want.length, `B${f}: ${gmail.sent.length} sends for ${want.length} approved`);
      }
    });

    await t.step("C. an approval lives 7 days (10 flows)", async () => {
      for (const [f, days] of [0, 1, 3, 6, 6.9, 7.1, 8, 10, 14, 30].entries()) {
        flows++;
        const u = uid(), a = at(`c${f}`);
        await person(db, u);
        const [it] = await approvedDrafts(db, u, [a]);
        await queueApprovedOutreach(outreachDeps, u, [it]);
        // It waited behind a pause; the approval (and the draft) are this old when the person resumes.
        await db.sql.query(`update public.career_outreach_drafts set approved_at = now() - interval '${days * 24} hours', created_at = now() - interval '${days * 24} hours' where id = '${it.draftId}';
          update public.career_send_accounts set state = 'paused', reason = 'test pause' where user_id = '${u}'`);
        const gmail = new FakeGmail();
        await drain(railDeps(db, conn, gmail), `w-c-${f}`);
        check(gmail.sent.length === 0, `C${f}: nothing goes while paused`);
        await rpc.rpc("career_send_resume", { p: { user: u } });
        await drain(railDeps(db, conn, gmail), `w-c2-${f}`);
        const q = (await rows(db, `select state, result from public.career_send_queue where user_id = '${u}'`))[0];
        const d = (await rows(db, `select status, result, approved_hash from public.career_outreach_drafts where id = '${it.draftId}'`))[0];
        if (days <= 7) check(gmail.sent.length === 1 && q.state === "sent" && d.status === "sent", `C${f} (${days} days): inside its 7 days it goes (${JSON.stringify({ q, d, n: gmail.sent.length })})`);
        else check(gmail.sent.length === 0 && q.state === "cancelled" && d.status === "skipped" && d.result === "expired" && d.approved_hash === null, `C${f} (${days} days): a lapsed approval never sends; the draft lapses (${JSON.stringify({ q, d, n: gmail.sent.length })})`);
      }
    });

    await t.step("D. a follow-up never goes over an answer already on its sequence's threads (16 flows)", async () => {
      const kinds = ["reply", "stop", "bounce", "ooo", "delay", "none"] as const;
      for (let f = 0; f < 16; f++) {
        flows++;
        const kind = kinds[f % kinds.length], onSecond = f >= 12;
        const u = uid(), a = at(`d${f}`);
        await person(db, u);
        const gmail = new FakeGmail();
        const deps = railDeps(db, conn, gmail);
        const msg = (subject: string, text: string) => ({ to: a, subject, text });
        const first = msg("Coffee chat?", `Hi, would you have 15 minutes? (${f})`);
        const [r0] = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(first), ...first }]);
        await drain(deps, `w-d0-${f}`);
        let threadOf = (await firstTo(gmail, a, u)).threadId;
        if (onSecond) {
          const fu1 = msg("Re: Coffee chat?", `Following up once (${f}).`);
          await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(fu1), ...fu1, followUpOf: r0.id }]);
          await drain(deps, `w-d1-${f}`);
          threadOf = gmail.to(a).at(-1)!.threadId;
        }
        const fu = msg("Re: Coffee chat?", `Following up (${f}): any chance this week?`);
        await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(fu), ...fu, followUpOf: r0.id }]);
        const before = gmail.sent.length;
        if (kind === "reply") gmail.reply(threadOf, `Dana <${a}>`, "Re: Coffee chat?", "Thanks, happy to talk. Does Thursday work?");
        if (kind === "stop") gmail.reply(threadOf, `Dana <${a}>`, "Re: Coffee chat?", "Please stop emailing me.");
        if (kind === "bounce") gmail.reply(threadOf, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found. Your message wasn't delivered.");
        if (kind === "ooo") gmail.reply(threadOf, `Dana <${a}>`, "Automatic reply: Coffee chat?", "I am out of the office with limited access to email.");
        if (kind === "delay") gmail.reply(threadOf, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Delay)", "This is a warning message only. You do not need to resend your message.");
        // The follow-up is due now; the reply check has not looked at the thread since the answer landed.
        await drain(deps, `w-d2-${f}`);
        const went = gmail.sent.length - before;
        const fuRow = (await rows(db, `select state, result from public.career_send_queue where user_id = '${u}' and body = '${fu.text.replace(/'/g, "''")}'`))[0];
        const stopped = kind === "reply" || kind === "stop" || kind === "bounce";
        if (stopped) {
          check(went === 0 && fuRow.state === "cancelled", `D${f} ${kind}${onSecond ? " (on the first follow-up's thread)" : ""}: the follow-up is not sent and is cancelled (went ${went}, ${JSON.stringify(fuRow)})`);
          if (kind === "stop") check((await rows(db, `select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash('${a}')`)).length === 1, `D${f}: the stop is recorded for everyone`);
          if (kind === "bounce") check((await rows(db, `select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash('${a}')`)).length === 1, `D${f}: the bounce is recorded for everyone`);
        } else {
          check(went === 1 && fuRow.state === "sent", `D${f} ${kind}: not an answer; the follow-up goes once (went ${went}, ${JSON.stringify(fuRow)})`);
        }
      }
    });

    const store = supabaseOutreachStore(admin);
    await t.step("E. an opt-out or a bounce to one person holds for everyone (8 flows)", async () => {
      for (let f = 0; f < 8; f++) {
        flows++;
        const kind = f % 2 ? "bounce" : "stop";
        const a = uid(), b = uid(), x = at(`e${f}`);
        await person(db, a); await person(db, b);
        const gmail = new FakeGmail();
        await queueApprovedOutreach(outreachDeps, a, await approvedDrafts(db, a, [x]));
        // B's own email to the same address, approved and due later.
        const later = { to: x, subject: "Introduction", text: `A separate note (${f}).` };
        await queueApproved(rpc, b, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(later), ...later, sendAt: new Date(Date.now() + 5 * DAY).toISOString() }]);
        await drain(railDeps(db, conn, gmail), `w-e-${f}`);
        const th = (await firstTo(gmail, x, a)).threadId;
        if (kind === "stop") gmail.reply(th, x, "Re: A quick question 1", "Not interested, please remove me.");
        else gmail.reply(th, "postmaster@example.test", "Undeliverable: A quick question 1", "Delivery has failed to these recipients.");
        await runReplyCheck(railDeps(db, conn, gmail), { limit: 1000, recheckSeconds: 0 });
        const bRow = (await rows(db, `select state, result from public.career_send_queue where user_id = '${b}'`))[0];
        check(bRow.state === "cancelled", `E${f} ${kind}: another person's queued email is cancelled (${JSON.stringify(bRow)})`);
        const again = { to: x, subject: "One more", text: `Hello again (${f}).` };
        const [r] = await queueApproved(rpc, b, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(again), ...again }]);
        check(r.status === "refused", `E${f} ${kind}: their new email is refused (${JSON.stringify(r)})`);
        const blocked = await store.blocked!([x, at(`e${f}-clean`)]);
        check(blocked.get(x) === (kind === "stop" ? "opted_out" : "bounced") && !blocked.has(at(`e${f}-clean`)), `E${f} ${kind}: drafting sees the address as blocked for everyone (${JSON.stringify([...blocked])})`);
      }
    });

    await t.step("F. approvals bound to the chat that showed the batch, on the real drafts table (10 flows)", async () => {
      for (let f = 0; f < 10; f++) {
        flows++;
        const u = uid(), A = crypto.randomUUID(), B = crypto.randomUUID();
        await person(db, u);
        const intents = new Map<string, string>([[A, OUTREACH_INTENT], [B, OUTREACH_INTENT]]);
        const s = { ...store, lastAssistantIntent: async (tid: string) => intents.get(tid) ?? null };
        const mk = async (tag: string, n: number, when: number) => {
          const out = [];
          for (let i = 1; i <= n; i++) {
            const d = { n: i, recipient: { name: `P ${tag}${i}`, firm: "Acme", title: "", school: "", email: at(`f${f}${tag}${i}`), source: "contacts.csv" }, subject: `Hello ${tag}${i}`, body: "Would you have 15 minutes?", footer: footerOf("Sam"),
              shared: [], status: "shown" as const, hash: "", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(when).toISOString() };
            d.hash = await payloadHash(messageOf(d));
            out.push(d);
          }
          return out;
        };
        const now = Date.now();
        await s.saveBatch(u, A, await mk("a", R.int(1, 4), now - 60_000), now - 60_000);
        const nb = R.int(1, 4);
        await s.saveBatch(u, B, await mk("b", nb, now - 30_000), now - 30_000);
        const answer = R.pick(["send all", "yes", "yes to all", "send 1"]);
        const r1 = await outreachTurn({ message: answer, userId: u, threadId: A, now, store: s });
        const approved1 = await rows(db, `select n from public.career_outreach_drafts where user_id = '${u}' and status = 'approved'`);
        check(approved1.length === 0, `F${f}: "${answer}" in the chat that did not show the newest batch approves nothing (${r1?.status}, ${approved1.length} approved)`);
        const shown = await outreachTurn({ message: "show drafts", userId: u, threadId: A, now, store: s });
        check(shown?.status === "shown", `F${f}: "show drafts" shows the newest batch here`);
        const r2 = await outreachTurn({ message: "send all", userId: u, threadId: A, now, store: s });
        const approved2 = await rows(db, `select n, thread_id from public.career_outreach_drafts where user_id = '${u}' and status = 'approved' order by n`);
        check(approved2.length === nb && approved2.every((d: any) => d.thread_id === A), `F${f}: once shown here, "send all" here approves exactly that batch (${r2?.status}, ${JSON.stringify(approved2)})`);
        const r3 = await outreachTurn({ message: "send all", userId: u, threadId: B, now, store: s });
        check(r3?.status === "other_chat", `F${f}: the chat it was first shown in no longer answers it (${r3?.status})`);
      }
    });

    await t.step("G. the card's address label rides on the queue row (6 flows)", async () => {
      for (const [f, label] of (["inferred", "published", null, "inferred", "published", null] as const).entries()) {
        flows++;
        const u = uid(), a = at(`g${f}`);
        await person(db, u);
        const items = await approvedDrafts(db, u, [a], { recipient: label ? { address: label } : {} });
        await queueApprovedOutreach(outreachDeps, u, items);
        const q = (await rows(db, `select address_type from public.career_send_queue where user_id = '${u}'`))[0];
        check((q?.address_type ?? null) === label, `G${f}: the queue row says ${label} (got ${q?.address_type})`);
      }
    });

    await t.step("H. the replies lane drafts nothing for a paused person (6 flows)", async () => {
      const rstore = supabaseRepliesStore(admin);
      const quiet = async (ids: string[]) => {
        const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids });
        if (error) throw new Error(error.message);
        return new Set<string>((data ?? []).map((r: any) => String(r?.user_id ?? r)));
      };
      for (let f = 0; f < 6; f++) {
        flows++;
        const u = uid(), paused = f % 2 === 0;
        await person(db, u);
        await db.sql.query(`insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":${paused}}') on conflict (user_id, key) do update set value = excluded.value;
          insert into public.career_outreach_followup_prefs (user_id, steps, off) values ('${u}', array[3], false) on conflict (user_id) do update set steps = excluded.steps;
          insert into public.career_outreach_threads (user_id, provider, provider_thread, recipient_email, recipient_name, recipient_firm, subject, sent_at, status, followup_state)
            values ('${u}', 'gmail', 'th-h${f}-${RUN}', '${at(`h${f}`)}', 'Dana Kim', 'Acme', 'Coffee chat?', now() - interval '5 days', 'awaiting', 'none')`);
        let calls = 0;
        const model = async () => { calls++; return { content: [{ type: "text", text: "Hi Dana, just following up on my earlier note. Would you have a few minutes this week?" }], stop_reason: "end_turn" }; };
        const outbox: string[] = [];
        const box = { enqueue: async (uu: string, m: { key: string }) => { if (uu === u) outbox.push(m.key); return true; } };
        const person_ = async () => ({ facts: [{ id: "f1", kind: "education", school: "TEST University", status: "confirmed" }], signature: "Sam", name: "Sam" });
        await runFollowupDrafts({ store: rstore, outbox: box, model, person: person_, now: Date.now(), worker: `w-h-${f}`, quiet });
        const acts = await rows(db, `select status from public.career_outreach_actions where user_id = '${u}'`);
        if (paused) check(acts.length === 0 && calls === 0 && outbox.length === 0, `H${f}: a paused person gets nothing drafted or queued (${acts.length} drafted, ${calls} model calls, ${outbox.length} messages)`);
        else check(acts.length === 1 && outbox.length === 1, `H${f}: an active person's due follow-up is drafted and shown (${acts.length}, ${outbox.length})`);
      }
    });

    await t.step("nothing left the machine; every problem found is listed", () => {
      console.log(`[outreach e2e] ${flows} flows, ${problems.length} problems, ${outside} outside requests`);
      eq(outside, 0, "no request left the machine");
      for (const p of problems) console.log(`  PROBLEM ${p}`);
      eq(problems, [], `${problems.length} of ${flows} flows found a problem; first: ${problems.slice(0, 3).join(" | ").slice(0, 1500)}`);
      ok(flows >= 60, `${flows} flows`);
    });
  } finally {
    globalThis.fetch = realFetch;
    await db.stop();
  }
} });
