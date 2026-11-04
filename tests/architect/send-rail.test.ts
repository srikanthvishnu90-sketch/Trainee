// Mass networking, lane M1: the sending rail end to end on real Postgres (every migration, the rail's own SQL) with Gmail
// faked at the HTTP boundary. Every assertion reads state: queue rows, drafts, the opt-out and bad-address lists, the
// outbox notice, and exactly what "Gmail" received. No real email is ever sent.
import assertNode from "node:assert/strict";
import {
  buildMime, cancelQueued, outreachSendStatus, queueApproved, queueApprovedOutreach, resumeSending, runReplyCheck, runSendWorker,
} from "../../supabase/functions/_shared/career_send_rail.ts";
import { payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { approvedDrafts, CI, draftsReader, FakeGmail, haveDb, person, railDb, railDeps, rows, uid as uidOf } from "../flow/send-rail-fixture.ts";
import { serviceRpc } from "../flow/pgwire.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
// Every run uses its own people and addresses (opt-outs and bad addresses are global and kept forever).
const RUN = crypto.randomUUID().slice(0, 3);
const at = (local: string) => `${local}.${RUN}@example.test`;
const addrs = (tag: string, n: number) => Array.from({ length: n }, (_, i) => at(`${tag}${i + 1}`));
const uid = (n: number) => uidOf(n, RUN);
const states = async (db: any, u: string) => Object.fromEntries((await rows(db, `select state, count(*)::int n from public.career_send_queue where user_id = '${u}' group by state`)).map((r: any) => [r.state, r.n]));

Deno.test({ name: "M1 send rail: exactly once, crash-safe, hash-bound, opt-out, bounce, disconnect, injection, 401, Gmail's quota, erase", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  try {
    const c1 = await db.conn(), c2 = await db.conn();
    const rpc = serviceRpc(await db.conn());
    const outreachDeps = { ...rpc, drafts: draftsReader(db) };

    await t.step("40 approved emails: 40 sends, each exactly once, from one account one at a time, no spacing of Trainee's own", async () => {
      const u = uid(1);
      await person(db, u);
      const items = await approvedDrafts(db, u, addrs("forty", 40));
      const q = await queueApprovedOutreach(outreachDeps, u, items);
      eq(q.map((r) => r.status), Array(40).fill("queued"));
      // The same approval handed over again (a retry of the chat turn): the same rows, never a second one.
      const again = await queueApprovedOutreach(outreachDeps, u, items);
      eq(again.map((r) => r.status), Array(40).fill("already_queued"));
      const gmail = new FakeGmail();
      const started = Date.now();
      // Two sender instances at once, each claiming in small slices so they really race for the same account.
      const [a, b] = await Promise.all([
        runSendWorker(railDeps(db, c1, gmail), { worker: "w-a", accounts: 5, perAccount: 7 }),
        runSendWorker(railDeps(db, c2, gmail), { worker: "w-b", accounts: 5, perAccount: 7 }),
      ]);
      eq(a.sent + b.sent, 40, JSON.stringify({ a, b }));
      eq(gmail.sent.length, 40);
      eq(new Set(gmail.sent.map((m) => m.to)).size, 40, "each recipient exactly once");
      eq(gmail.maxInFlight.get(u), 1, "one account sends one message at a time (its lease)");
      ok(Date.now() - started < 20_000, "no spacing of Trainee's own: 40 sends do not wait 90 seconds apart");
      eq(await states(db, u), { sent: 40 });
      const drafts = await rows(db, `select status, gmail_id is not null as has_id from public.career_outreach_drafts where user_id = '${u}'`);
      ok(drafts.every((d: any) => d.status === "sent" && d.has_id), "every draft is sent with Gmail's message id");
      // Each message: one To, the approved subject and text, no Cc, no Bcc, nothing else.
      for (const m of gmail.sent) {
        eq(m.headers.filter((h) => /^to:/i.test(h)).length, 1);
        ok(!m.headers.some((h) => /^(cc|bcc|reply-to|from):/i.test(h)), m.headers.join(" | "));
        // Cold outreach carries List-Unsubscribe: a mailto to the person's own address.
        ok(m.headers.includes("List-Unsubscribe: <mailto:me@example.test?subject=unsubscribe>"), m.headers.join(" | "));
      }
      const st = await outreachSendStatus(rpc, u);
      eq([st.sent, st.waiting], [40, 0]);
      ok(/40 emails sent from your Gmail\./.test(st.line), st.line);
    });

    await t.step("a worker that dies after Gmail accepted a send: the next worker finds it in Sent, sends the rest, no duplicate", async () => {
      const u = uid(2);
      await person(db, u);
      const items = await approvedDrafts(db, u, addrs("crash", 12));
      await queueApprovedOutreach(outreachDeps, u, items);
      const gmail = new FakeGmail();
      let dead = false;
      gmail.afterAccept = (m) => { if (m.account === u && gmail.to(m.to).length === 1 && gmail.sent.filter((x) => x.account === u).length === 5) dead = true; };
      const live = railDeps(db, c1, gmail);
      const dying = { ...live, rpc: async (name: string, args: { p: unknown }) => { if (dead) throw new Error("worker process died"); return live.rpc(name, args); },
        fetch: async (i: any, init?: any) => { if (dead) throw new Error("worker process died"); return gmail.fetch(i, init); } };
      // The process dies mid-batch: whatever it was doing throws, nothing after that point reaches the database.
      const a = await runSendWorker(dying, { worker: "w-dies", accounts: 5, perAccount: 12 }).catch((e) => String(e));
      eq(gmail.sent.length, 5, JSON.stringify(a));
      eq((await states(db, u)).sending, 12, "5 reached Gmail, none recorded yet (outcomes are recorded in batches), all still leased");
      // Three minutes later the lease has lapsed; another instance resumes.
      const later = Date.now() + 180_000;
      const b = await runSendWorker(railDeps(db, c2, gmail, { now: () => later }), { worker: "w-next", accounts: 5, perAccount: 12 });
      eq(gmail.sent.length, 12, JSON.stringify(b));
      eq(new Set(gmail.sent.map((m) => m.to)).size, 12, "nobody got two");
      eq(b.already_sent, 5, "the 5 that reached Gmail were found in Sent, not sent again");
      eq(await states(db, u), { sent: 12 });
      const found = await rows(db, `select result from public.career_send_queue where user_id = '${u}' and result like 'found in Sent%'`);
      eq(found.length, 5);
    });

    await t.step("a 5xx (may have been sent): retried only after Sent shows it did not go", async () => {
      const u = uid(3);
      await person(db, u);
      await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, addrs("five", 2)));
      const gmail = new FakeGmail();
      gmail.script = (acct, n) => (acct === u && n === 1 ? new Response('{"error":{"message":"backend"}}', { status: 503 }) : null);
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-5xx" });
      const later = Date.now() + 120_000;
      await runSendWorker(railDeps(db, c1, gmail, { now: () => later }), { worker: "w-5xx-2" });
      eq(gmail.sent.filter((m) => m.account === u).length, 2);
      ok(gmail.calls.some((c) => c.method === "GET" && c.path === "/messages" && c.account === u), "Sent was checked before the second try");
      eq(await states(db, u), { sent: 2 });
    });

    await t.step("a draft changed after approval is never sent; a payload whose hash is not its approval is refused", async () => {
      const u = uid(4);
      await person(db, u);
      const items = await approvedDrafts(db, u, addrs("chg", 3));
      await queueApprovedOutreach(outreachDeps, u, items);
      // After the approval and the queueing, the stored text changes (an edit, a bug, anything).
      await db.sql.query(`update public.career_outreach_drafts set body = body || ' P.S. I also worked at Google.' where id = '${items[1].draftId}'`);
      // And one changed before the hand-off: refused at the door.
      await db.sql.query(`update public.career_outreach_drafts set subject = 'Changed' where id = '${items[2].draftId}'`);
      // And one the person takes back after queueing ("cancel 4" leaves the draft skipped, its approval cleared).
      const [took] = await approvedDrafts(db, u, [at("chg4")]);
      await queueApprovedOutreach(outreachDeps, u, [took]);
      await db.sql.query(`update public.career_outreach_drafts set status = 'skipped', approved_hash = null, approved_at = null, result = 'cancelled' where id = '${took.draftId}'`);
      const gmail = new FakeGmail();
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-chg" });
      eq(gmail.sent.filter((m) => m.account === u).map((m) => m.to), [at("chg1")], "only the unchanged one");
      eq((await rows(db, `select state, result from public.career_send_queue where source_id = '${took.draftId}'`))[0], { state: "cancelled", result: "approval withdrawn" });
      const q = await rows(db, `select source_id, state, result from public.career_send_queue where user_id = '${u}' order by created_at`);
      eq(q.find((r: any) => r.source_id === items[1].draftId).state, "refused");
      const d = await rows(db, `select status, approved_hash from public.career_outreach_drafts where id = '${items[1].draftId}'`);
      eq([d[0].status, d[0].approved_hash], ["shown", null], "the changed draft needs a fresh approval");
      const fresh = await approvedDrafts(db, u, [at("chg9")]);
      const r = await queueApprovedOutreach(outreachDeps, u, [{ draftId: fresh[0].draftId, approvalHash: "0".repeat(64) }]);
      eq([r[0].status, r[0].reason], ["refused", "changed"]);
      const g = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash({ to: "x@example.test", subject: "Hello", text: "One" }), to: "x@example.test", subject: "Hello", text: "Two" }]);
      eq([g[0].status, g[0].reason], ["refused", "changed"]);
    });

    await t.step("header injection, a second recipient, Cc/Bcc, a display name: refused before the queue and by the database", async () => {
      const u = uid(5);
      await person(db, u);
      const item = async (to: string, subject: string, extra: Record<string, unknown> = {}) =>
        ({ kind: "general" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash({ to, subject, text: "Hi" }), to, subject, text: "Hi", ...extra });
      const res = await queueApproved(rpc, u, [
        await item("a@example.test\r\nBcc: spy@example.test", "Hello"),
        await item("a@example.test", "Hello\r\nBcc: spy@example.test"),
        await item("a@example.test", "Hello\nX-Evil: 1"),
        await item("Jane <a@example.test>", "Hello"),
        await item("a@example.test, b@example.test", "Hello"),
        await item("a@example.test;b@example.test", "Hello"),
        await item("a@example.test", "Hello", { cc: "b@example.test" }),
        await item("a@example.test", "Hello", { bcc: ["b@example.test"] }),
      ]);
      eq(res.map((r) => r.status), Array(8).fill("refused"));
      eq(res.map((r) => r.reason), ["unsafe_header", "unsafe_header", "unsafe_header", "unsafe_header", "unsafe_header", "unsafe_header", "cc_bcc_not_approved", "cc_bcc_not_approved"]);
      // Straight at the database (no TypeScript in front): its own checks refuse the same.
      const direct = await rpc.rpc("career_send_enqueue", { p: { user: u, items: [
        { kind: "general", source_id: crypto.randomUUID(), approval_hash: "a".repeat(64), to: "a@example.test", subject: "Hi\r\nBcc: spy@example.test", body: "x" },
        { kind: "general", source_id: crypto.randomUUID(), approval_hash: "a".repeat(64), to: "a@example.test, b@example.test", subject: "Hi", body: "x" },
        { kind: "general", source_id: crypto.randomUUID(), approval_hash: "a".repeat(64), to: "a@example.test", subject: "Hi", body: "x", bcc: "spy@example.test" },
      ] } });
      eq(direct.data.map((r: any) => r.status), ["refused", "refused", "refused"], JSON.stringify(direct));
      eq((await rows(db, `select 1 from public.career_send_queue where user_id = '${u}'`)).length, 0, "nothing queued");
      assertNode.throws(() => buildMime({ to: "a@example.test", subject: "x\r\nBcc: y@example.test", text: "b" }));
      // A body line that looks like a header stays in the body (base64), never a header.
      const mime = buildMime({ to: "a@example.test", subject: "Hello", text: "Bcc: spy@example.test\r\n\r\nhi" });
      eq(mime.split("\r\n\r\n")[0].split("\r\n").map((l) => l.split(":")[0]), ["To", "Subject", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
    });

    await t.step("a reply saying \"not interested\" opts them out forever: no follow-up, nobody else's queued email to them goes", async () => {
      const u = uid(6), other = uid(7);
      await person(db, u); await person(db, other);
      const [d] = await approvedDrafts(db, u, [at("optout")]);
      await queueApprovedOutreach(outreachDeps, u, [d]);
      const [od] = await approvedDrafts(db, other, [at("optout")]);
      const gmail = new FakeGmail();
      for (let i = 0; i < 10 && !gmail.to(at("optout")).length; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-opt-${i}`, accounts: 1, perAccount: 1 });
      eq(gmail.to(at("optout")).length, 1);
      await queueApprovedOutreach(outreachDeps, other, [od]); // queued before the answer comes back
      const sent = gmail.to(at("optout"))[0];
      gmail.reply(sent.threadId, `Person <${at("optout")}>`, "Re: " + sent.subject, "Thanks, but I'm not interested.");
      const r = await runReplyCheck(railDeps(db, c1, gmail), { limit: 100000 });
      eq(r.stops, 1, JSON.stringify(r));
      eq((await rows(db, `select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash('${at("optout")}')`)).length, 1);
      const [first] = await rows(db, `select id, state from public.career_send_queue where user_id = '${u}'`);
      eq(first.state, "replied");
      // A follow-up the person approves now: refused. The other person's queued email: cancelled, never sent.
      const fuText = { to: at("optout"), subject: "Following up", text: "Just following up." };
      const fu = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(fuText), ...fuText, followUpOf: first.id }]);
      eq([fu[0].status, fu[0].reason], ["refused", "opted_out"]);
      await runSendWorker(railDeps(db, c2, gmail), { worker: "w-opt-2" });
      eq(gmail.to(at("optout")).length, 1, "never a second email to someone who opted out");
      eq((await rows(db, `select state, result from public.career_send_queue where user_id = '${other}'`))[0], { state: "cancelled", result: "opted_out" });
    });

    await t.step("a sequence of follow-ups (any length, each approved) goes in order after the first email; a reply stops the rest; an out-of-office does not", async () => {
      const u = uid(8);
      await person(db, u);
      const ds = await approvedDrafts(db, u, [at("replies"), at("ooo")]);
      await queueApprovedOutreach(outreachDeps, u, ds);
      const gmail = new FakeGmail();
      for (let i = 0; i < 10 && gmail.sent.filter((m) => m.account === u).length < 2; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-rep-${i}` });
      const sentRows = await rows(db, `select id, recipient_email from public.career_send_queue where user_id = '${u}' order by recipient_email`);
      const byTo = Object.fromEntries(sentRows.map((r: any) => [r.recipient_email, r.id]));
      const fuOf = async (to: string) => { const x = { to, subject: "Following up", text: "Following up on my note." }; return { kind: "general" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(x), ...x, followUpOf: byTo[to] }; };
      // Three follow-ups to "replies", a day apart; two to "ooo". Each is approved (queued) like any email.
      const day = 86400_000;
      for (const n of [1, 2, 3]) eq((await queueApproved(rpc, u, [{ ...(await fuOf(at("replies"))), sourceId: crypto.randomUUID(), sendAt: new Date(Date.now() + n * day).toISOString() }]))[0].status, "queued");
      for (const n of [1, 2]) eq((await queueApproved(rpc, u, [{ ...(await fuOf(at("ooo"))), subject: `Following up ${n}`, approvalHash: await payloadHash({ to: at("ooo"), subject: `Following up ${n}`, text: "Following up on my note." }), sendAt: new Date(Date.now() + n * day).toISOString() }]))[0].status, "queued");
      // Not before their time.
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-rep-early" });
      eq(gmail.sent.filter((m) => m.account === u).length, 2, "follow-ups wait for their own time");
      gmail.reply(gmail.to(at("replies"))[0].threadId, at("replies"), "Re: hi", "Sure, happy to chat Thursday.");
      gmail.reply(gmail.to(at("ooo"))[0].threadId, at("ooo"), "Automatic reply: Out of office", "I am away until Monday.");
      const r = await runReplyCheck(railDeps(db, c1, gmail), { limit: 100000 });
      eq([r.replies, r.stops, r.bounces], [1, 0, 0]);
      const fus = await rows(db, `select recipient_email, state, count(*)::int n from public.career_send_queue where user_id = '${u}' and follow_up_of is not null group by 1, 2 order by 1`);
      eq(fus, [{ recipient_email: at("ooo"), state: "queued", n: 2 }, { recipient_email: at("replies"), state: "cancelled", n: 3 }], "a reply stops the whole sequence");
      // Two days on, the out-of-office sequence goes, in order; the answered one never does.
      await runSendWorker(railDeps(db, c1, gmail, { now: () => Date.now() + 2 * day + 60_000 }), { worker: "w-rep-later" });
      eq(gmail.to(at("ooo")).map((m) => m.subject), ["A quick question 2", "Following up 1", "Following up 2"]);
      eq(gmail.to(at("replies")).length, 1);
      eq((await queueApproved(rpc, u, [await fuOf(at("replies"))]))[0].reason, "replied", "nothing more to someone who answered");
    });

    await t.step("a sequence goes one step at a time: follow-ups due together are never claimed together, and go in order", async () => {
      const u = uid(22);
      await person(db, u);
      await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [at("steps")]));
      const gmail = new FakeGmail();
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-steps" });
      const first = (await rows(db, `select id from public.career_send_queue where user_id = '${u}'`))[0].id;
      const fu = async (n: number) => { const x = { to: at("steps"), subject: `Step ${n}`, text: `Following up, step ${n}.` }; return { kind: "general" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(x), ...x, followUpOf: first }; };
      // Three approved in one call, all due now (no sendAt): the same next_at and created_at.
      eq((await queueApproved(rpc, u, [await fu(1), await fu(2), await fu(3)])).map((r) => r.status), ["queued", "queued", "queued"]);
      const { data, error } = await rpc.rpc("career_send_claim", { p: { worker: "w-steps-claim", accounts: 50, per_account: 50, lease_seconds: 60 } });
      ok(!error, error?.message);
      const mine = (data.accounts as any[]).filter((a) => a.user_id === u).flatMap((a) => a.items);
      eq(mine.length, 1, `one step of the sequence per claim, never the whole sequence at once: ${mine.map((i: any) => i.subject)}`);
      // Hand back everything that claim took (from any account), as if it had never run.
      await db.sql.query(`update public.career_send_queue set state = 'queued', lease_owner = null, lease_until = null, attempts = greatest(0, attempts - 1),
          first_claimed_at = case when attempts <= 1 then null else first_claimed_at end where state = 'sending' and lease_owner = 'w-steps-claim';
        update public.career_send_accounts set lease_owner = null, lease_until = null where lease_owner = 'w-steps-claim'`);
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-steps-2" });
      eq(gmail.to(at("steps")).map((m) => m.subject).slice(1).length, 3, "all three go, each once");
      eq(new Set(gmail.to(at("steps")).map((m) => m.subject)).size, 4);
    });

    await t.step("an inferred address is sent after approval, labelled; its bounce marks it bad forever, for anyone, and tells the format learner", async () => {
      const u = uid(9), other = uid(10);
      await person(db, u); await person(db, other);
      const q = await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [at("gone")], { recipient: { address_type: "inferred", address_format: "first.last" } }));
      eq(q[0].status, "queued");
      eq((await rows(db, `select address_type, address_format from public.career_send_queue where user_id = '${u}'`))[0], { address_type: "inferred", address_format: "first.last" }, "the card's label rides with the email");
      const bad = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash({ to: at("x"), subject: "Hi", text: "B" }), to: at("x"), subject: "Hi", text: "B", addressType: "guessed" as any }]);
      eq(bad[0].reason, "invalid", "only published, known or inferred");
      const gmail = new FakeGmail();
      for (let i = 0; i < 10 && !gmail.to(at("gone")).length; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-b-${i}` });
      eq(gmail.to(at("gone")).length, 1, "inferred, approved: sent");
      gmail.reply(gmail.to(at("gone"))[0].threadId, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", `Address not found: Your message wasn't delivered to ${at("gone")}`);
      const learned: unknown[] = [];
      const withLearner = { ...railDeps(db, c1, gmail), recordBounce: async (domain: string, fmt: string | null, o: { addressType: string | null }) => { learned.push([domain, fmt, o.addressType]); } };
      eq((await runReplyCheck(withLearner, { limit: 100000 })).bounces, 1);
      eq(learned, [["example.test", "first.last", "inferred"]], "the domain format learner hears of the bounce");
      eq((await rows(db, `select state from public.career_send_queue where user_id = '${u}'`))[0].state, "bounced");
      eq((await rows(db, `select status from public.career_outreach_drafts where user_id = '${u}'`))[0].status, "bounced");
      eq((await rows(db, `select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash('${at("gone")}')`)).length, 1);
      const r = await queueApprovedOutreach(outreachDeps, other, await approvedDrafts(db, other, [at("gone")]));
      eq([r[0].status, r[0].reason], ["refused", "bad_address"]);
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-b2" });
      eq(gmail.to(at("gone")).length, 1);
    });

    await t.step("the List-Unsubscribe mailto, arriving as a new email \"unsubscribe\", opts them out forever", async () => {
      const u = uid(16);
      await person(db, u);
      const ds = await approvedDrafts(db, u, [at("unsub")]);
      await queueApprovedOutreach(outreachDeps, u, ds);
      const gmail = new FakeGmail();
      // Other steps' people share this database and the claim is fair across people: run until this one's email went.
      for (let i = 0; i < 10 && !gmail.to(at("unsub")).length; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-u-${i}` });
      ok(gmail.to(at("unsub"))[0].headers.includes("List-Unsubscribe: <mailto:me@example.test?subject=unsubscribe>"));
      gmail.received(u, `Someone <${at("unsub")}>`, "unsubscribe");
      eq((await runReplyCheck(railDeps(db, c1, gmail), { limit: 100000 })).stops, 1);
      eq((await rows(db, `select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash('${at("unsub")}')`)).length, 1);
      // An application email carries no List-Unsubscribe (it is not cold outreach).
      const app = { to: at("jobs"), subject: "Application", text: "Please find my application below." };
      await queueApproved(rpc, u, [{ kind: "application", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(app), ...app }]);
      for (let i = 0; i < 10 && !gmail.to(at("jobs")).length; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-u2-${i}` });
      ok(!gmail.to(at("jobs"))[0].headers.some((h) => /^List-Unsubscribe/i.test(h)));
    });

    await t.step("mailbox protection: rising bounces pause that account, told with the numbers; it resumes when the person says so", async () => {
      const u = uid(17), fine = uid(18);
      await person(db, u); await person(db, fine);
      await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, addrs("bnc", 10)));
      const gmail = new FakeGmail();
      for (let i = 0; i < 10 && gmail.sent.filter((m) => m.account === u).length < 10; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-p-${i}` });
      eq(gmail.sent.filter((m) => m.account === u).length, 10);
      for (const n of [1, 2, 3, 4, 5]) gmail.reply(gmail.to(at(`bnc${n}`))[0].threadId, "mailer-daemon@googlemail.com", "Delivery Status Notification (Failure)", "Address not found");
      // Loop: one pass takes the oldest unchecked sends first, which may be other steps' under a slow runner.
      let bounced = 0;
      for (let i = 0; i < 20 && bounced < 5; i++) bounced += (await runReplyCheck(railDeps(db, c1, gmail), { limit: 1000, pause: { window: 50, bounces: 5, rate: 0.1 } })).bounces;
      eq(bounced, 5);
      eq((await rows(db, `select state, reason from public.career_send_accounts where user_id = '${u}'`))[0], { state: "paused", reason: "5 of the last 10 emails bounced" });
      const note = await rows(db, `select text from public.career_outbox where user_id = '${u}' and key like 'status:send-bounces:%'`);
      eq(note.length, 1);
      ok(/paused sending from your Gmail: 5 of your last 10 emails bounced \(50%\).*say "resume sending"/.test(note[0].text), note[0].text);
      // Paused: approved email waits; another person's goes.
      await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [at("bnc-later")]));
      await queueApprovedOutreach(outreachDeps, fine, await approvedDrafts(db, fine, [at("fine-p")]));
      for (let i = 0; i < 10 && gmail.to(at("fine-p")).length < 1; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-p2-${i}` });
      eq([gmail.to(at("bnc-later")).length, gmail.to(at("fine-p")).length], [0, 1]);
      ok(/paused \(5 of the last 10 emails bounced\)/.test((await outreachSendStatus(rpc, u)).line));
      eq(await resumeSending(rpc, u), "resumed");
      for (let i = 0; i < 10 && gmail.to(at("bnc-later")).length < 1; i++) await runSendWorker(railDeps(db, c1, gmail), { worker: `w-p3-${i}` });
      eq(gmail.to(at("bnc-later")).length, 1, "the person said resume: it goes");
    });

    await t.step("Gmail refuses an email as spam or policy: that account pauses at once, told plainly; others keep sending", async () => {
      const u = uid(19), fine = uid(20);
      await person(db, u); await person(db, fine);
      await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, addrs("pol", 4)));
      await queueApprovedOutreach(outreachDeps, fine, await approvedDrafts(db, fine, addrs("polfine", 2)));
      const gmail = new FakeGmail();
      gmail.script = (acct, n) => (acct === u && n === 2 ? new Response('{"error":{"code":400,"message":"Message rejected. This message was blocked because its content presents a potential spam risk."}}', { status: 400 }) : null);
      const s = await runSendWorker(railDeps(db, c1, gmail), { worker: "w-pol" });
      eq(s.policy, 1);
      eq(gmail.calls.filter((c) => c.method === "POST" && c.account === u).length, 2, "nothing more tried after the refusal");
      eq(gmail.sent.filter((m) => m.account === fine).length, 2);
      eq((await rows(db, `select state from public.career_send_accounts where user_id = '${u}'`))[0].state, "paused");
      const note = await rows(db, `select text from public.career_outbox where user_id = '${u}' and key like 'status:send-policy:%'`);
      ok(note.length === 1 && /possible spam or against its sending policy\. 3 approved emails are waiting/.test(note[0].text), JSON.stringify(note));
      gmail.script = null;
      eq(await resumeSending(rpc, u), "resumed");
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-pol2" });
      eq(gmail.sent.filter((m) => m.account === u).length, 4);
    });

    await t.step("Outlook (#226 mail_providers): a person whose sending mailbox is Outlook sends through its provider, once", async () => {
      const u = uid(21);
      await person(db, u, { connected: false, outlook: true });
      const mail = { to: at("viaoutlook"), subject: "Hello from Outlook", text: "One note." };
      const r = await queueApproved({ ...rpc, which: async () => [{ id: "outlook" as const }] }, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(mail), ...mail }]);
      eq(r[0].status, "queued");
      eq((await rows(db, `select provider from public.career_send_queue where user_id = '${u}'`))[0].provider, "outlook");
      const gmail = new FakeGmail();
      // Not wired in this deployment: it waits, nothing is sent, nothing is lost.
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-o0" });
      eq((await states(db, u)), { queued: 1 });
      const calls: unknown[] = [];
      const outlook = { send: async (userId: string, m: { to: string; subject: string; text: string }, o: { idemKey: string; purpose: string }) => { calls.push([userId, m, o.purpose]); return { status: "sent" as const, id: null, thread_id: null }; } };
      await runSendWorker({ ...railDeps(db, c1, gmail, { now: () => Date.now() + 3700_000 }), providers: { outlook } }, { worker: "w-o1" });
      eq(calls, [[u, mail, "general"]]);
      eq(gmail.sent.filter((m) => m.account === u).length, 0, "never through Gmail");
      eq(await states(db, u), { sent: 1 });
      await runSendWorker({ ...railDeps(db, c1, gmail, { now: () => Date.now() + 7400_000 }), providers: { outlook } }, { worker: "w-o2" });
      eq(calls.length, 1, "once");
    });

    await t.step("disconnect Gmail: every pending send is cancelled and nothing more goes", async () => {
      const u = uid(11);
      await person(db, u);
      const items = await approvedDrafts(db, u, addrs("disc", 6));
      await queueApprovedOutreach(outreachDeps, u, items);
      await db.sql.query(`delete from public.user_oauth_connections where user_id = '${u}' and provider = 'google_career'`);
      eq(await states(db, u), { cancelled: 6 });
      const gmail = new FakeGmail();
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-d" });
      eq(gmail.sent.filter((m) => m.account === u).length, 0);
      eq((await rows(db, `select distinct status from public.career_outreach_drafts where user_id = '${u}'`)).map((r: any) => r.status), ["skipped"]);
      eq((await rows(db, `select state from public.career_send_accounts where user_id = '${u}'`))[0].state, "disconnected");
      ok(/Gmail is disconnected/.test((await outreachSendStatus(rpc, u)).line));
      const again = await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [at("disc9")]));
      eq([again[0].status, again[0].reason], ["refused", "not_connected"]);
    });

    await t.step("Gmail answers 401: that person's queue stops (needs_reconnect, told once, plainly); others keep sending; a reconnect resumes", async () => {
      const u = uid(12), fine = uid(13);
      await person(db, u); await person(db, fine);
      await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, addrs("auth", 5)));
      await queueApprovedOutreach(outreachDeps, fine, await approvedDrafts(db, fine, addrs("fine", 5)));
      const gmail = new FakeGmail();
      gmail.script = (acct) => (acct === u ? new Response('{"error":{"code":401,"message":"Invalid Credentials"}}', { status: 401 }) : null);
      const s = await runSendWorker(railDeps(db, c1, gmail), { worker: "w-401" });
      eq(s.reconnect, 1, "one refusal stops the account: no hammering");
      eq(gmail.calls.filter((c) => c.method === "POST" && c.account === u).length, 1);
      eq(gmail.sent.filter((m) => m.account === fine).length, 5, "the other person is unaffected");
      eq(await states(db, u), { queued: 5 });
      eq((await rows(db, `select state from public.career_send_accounts where user_id = '${u}'`))[0].state, "needs_reconnect");
      const notes = await rows(db, `select kind, text from public.career_outbox where user_id = '${u}' and key like 'status:send-reconnect:%'`);
      eq(notes.length, 1);
      ok(/Say "connect gmail" to reconnect\. 5 approved emails wait/.test(notes[0].text), notes[0].text);
      ok(!/401|HTTP|needs_reconnect/.test(notes[0].text), "plain words, no codes");
      ok(/connect gmail/.test((await outreachSendStatus(rpc, u)).line));
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-401b" });
      eq(gmail.calls.filter((c) => c.method === "POST" && c.account === u).length, 1, "nothing tried while it needs a reconnect");
      // The person reconnects (gmail-oauth replaces the row): what was waiting goes out, once each.
      gmail.script = null;
      await db.sql.query(`update public.user_oauth_connections set connected_at = now() where user_id = '${u}' and provider = 'google_career'`);
      await runSendWorker(railDeps(db, c1, gmail), { worker: "w-401c" });
      eq(gmail.sent.filter((m) => m.account === u).length, 5);
      eq(await states(db, u), { sent: 5 });
    });

    await t.step("Gmail's own quota (429 + Retry-After): that account waits exactly until Gmail allows, told once; nothing lost or doubled", async () => {
      const u = uid(14);
      await person(db, u);
      await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, addrs("quota", 8)));
      const gmail = new FakeGmail();
      gmail.script = (acct, n) => (acct === u && n === 4 ? new Response('{"error":{"code":429,"message":"User-rate limit exceeded","errors":[{"reason":"rateLimitExceeded"}]}}', { status: 429, headers: { "retry-after": "3600" } }) : null);
      const s1 = await runSendWorker(railDeps(db, c1, gmail), { worker: "w-q" });
      eq([s1.sent, s1.quota], [3, 1]);
      const acct = (await rows(db, `select state, extract(epoch from resume_at - now())::int s from public.career_send_accounts where user_id = '${u}'`))[0];
      eq(acct.state, "backoff");
      ok(acct.s > 3500 && acct.s <= 3600, `resume in Gmail's hour (${acct.s} s)`);
      const note = await rows(db, `select text from public.career_outbox where user_id = '${u}' and key like 'status:send-paused:%'`);
      eq(note.length, 1);
      ok(/Gmail has paused sending from your account for now.*5 approved emails are waiting.*carries on automatically/.test(note[0].text), note[0].text);
      // Before Gmail's time: nothing. After it: the rest, each once.
      await runSendWorker(railDeps(db, c1, gmail, { now: () => Date.now() + 1800_000 }), { worker: "w-q2" });
      eq(gmail.sent.filter((m) => m.account === u).length, 3);
      await runSendWorker(railDeps(db, c1, gmail, { now: () => Date.now() + 3700_000 }), { worker: "w-q3" });
      eq(gmail.sent.filter((m) => m.account === u).length, 8);
      eq(new Set(gmail.sent.filter((m) => m.account === u).map((m) => m.to)).size, 8);
      ok(!gmail.calls.some((c) => c.account === u && c.method === "GET" && c.path === "/messages"), "a refused send is known unsent: no Sent check needed");
    });

    await t.step("the person cancels what is still queued; an erase deletes the queue and keeps the opt-out and bounce lists", async () => {
      const u = uid(15);
      await person(db, u);
      const items = await approvedDrafts(db, u, addrs("erase", 4));
      await queueApprovedOutreach(outreachDeps, u, items);
      eq(await cancelQueued(rpc, u, [items[0].draftId]), 1);
      eq(await states(db, u), { cancelled: 1, queued: 3 });
      const before = (await rows(db, `select count(*)::int n from public.career_outreach_dnc`))[0].n;
      await db.sql.query(`select public.career_erase_person('${u}')`);
      eq((await rows(db, `select 1 from public.career_send_queue where user_id = '${u}' union all select 1 from public.career_send_accounts where user_id = '${u}'`)).length, 0);
      eq((await rows(db, `select count(*)::int n from public.career_outreach_dnc`))[0].n, before, "opt-outs survive an erase");
      ok((await rows(db, `select 1 from public.career_send_bad_addresses`)).length >= 1, "bad addresses survive (a hash, naming nobody)");
    });
  } finally {
    await db.stop();
  }
} });
