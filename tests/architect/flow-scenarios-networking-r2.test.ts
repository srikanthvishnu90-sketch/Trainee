// NETWORKING ROUND 2 END TO END (owner rules, 2026-10-30): 80 flows through the real RPCs on real Postgres (every
// migration), the replies and provider stores over the PostgREST double, the sending rail's worker and reply check, a fake
// Gmail (and a fake Outlook) at the HTTP boundary. The pure battery is tests/architect/scenarios-networking-r2.test.ts;
// this reads the database's rows and what each mailbox received.
//   A  "stop emailing X" (career_send_stop_address): every email of this person's to X that has not gone is stopped (the
//      rail's queued rows, one a worker holds, approved and shown drafts, follow-ups shown or approved), follow-ups off; X's
//      other senders and this person's other addresses are untouched; the worker then sends nothing to X from them.
//   B  follow-up approvals bound to the batch shown in the chat, on the real tables: the batch the run pushed (the
//      delivered text, career_outbox_to_thread) or the one "show outreach approvals" showed; a newer batch never.
//   C  Gmail never answers a send: the worker gives up inside the lease; the next run checks Sent; each email exactly once.
//   D  answers in other languages on the thread: an opt-out (Spanish, French, German, Italian, Portuguese, Dutch, Japanese,
//      Russian) opts out for everyone and stops the follow-up; an auto-reply (Japanese, Chinese, Russian, Polish, Turkish,
//      Danish, Spanish or German body) does not.
//   E  a follow-up of cold outreach carries List-Unsubscribe; an application's does not.
//   F  people discovery never counts an opted-out or bounced address as usable (career_provider_candidates.blocked).
//   G  one person queues 2,000 emails: no Trainee limit; Gmail's quota backs the account off; each goes exactly once.
//   H  Gmail and Outlook both connected: each email goes from the mailbox it was approved for; a Gmail disconnect stops only
//      Gmail's.
//   I  across people: an opt-out in another language or a hard bounce to person A holds for person B; a delay notice does not.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { rng } from "./scenarios-fixture.ts";
import { approvedDrafts, CI, draftsReader, FakeGmail, haveDb, person, railDb, railDeps, rows, uid as uidOf } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { serviceRpc } from "../flow/pgwire.ts";
import { payloadHash, supabaseOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { queueApproved, queueApprovedOutreach, runReplyCheck, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";
import { ACTIONS_INTENT, actionHash, repliesTurn, STOP_INTENT, supabaseRepliesStore } from "../../supabase/functions/_shared/career_outreach_replies.ts";
import { findTargets, supabaseProviderStore } from "../../supabase/functions/_shared/career_people_provider.ts";
import { companyKey } from "../../supabase/functions/_shared/career_people_import.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const RUN = crypto.randomUUID().slice(0, 3);
const at = (local: string) => `${local}.${RUN}@example.test`;
let nextUser = 1;
const uid = () => uidOf(nextUser++, `7${RUN}`.slice(0, 3));
const HOUR = 3600_000, DAY = 86_400_000;
const R = rng(20261031);
const problems: string[] = [];
const check = (cond: unknown, what: string) => { if (!cond) problems.push(what); };
let flows = 0;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

Deno.test({ name: "networking r2 end to end: 80 flows through the real RPCs, the stores, the rail and fake mailboxes on real Postgres", sanitizeResources: false, sanitizeOps: false, async fn(t) {
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
    const replies = supabaseRepliesStore(admin);
    const drain = async (d: WorkerDeps, worker: string, passes = 60, o: { sendTimeoutMs?: number } = {}) => {
      let n = 0;
      for (let i = 0; i < passes; i++) { const s = await runSendWorker(d, { worker, deadlineMs: 120_000, perAccount: 500, ...o }); n += s.sent + s.already_sent; if (!s.claims) break; }
      return n;
    };
    const general = async (u: string, to: string, subject: string, text: string, extra: Record<string, unknown> = {}) => {
      const m = { to, subject, text };
      const [r] = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m, ...extra } as any]);
      return r;
    };
    // A conversation the replies lane watches, with one follow-up action (shown, or approved).
    const thread = async (u: string, to: string, name: string, approved: boolean, sentAt = Date.now() - 5 * DAY) => {
      const tid = await replies.track({ user_id: u, draft_id: null, provider: "gmail", provider_thread: `th-${crypto.randomUUID().slice(0, 8)}`, email: to, name, firm: "Acme", subject: "Coffee chat?", sent_at: new Date(sentAt).toISOString() });
      const payload = { to, subject: "Re: Coffee chat?", text: `Following up (${name}).`, thread: null, provider: "gmail", step: 1 };
      const [a] = await replies.saveActions(u, [{ thread_id: tid, kind: "followup", step: 1, payload, hash: await actionHash("followup", payload) }], Date.now());
      if (approved) await replies.approve(u, a.batch_id, [{ n: a.n, hash: a.hash }], Date.now());
      return { tid, a };
    };

    await t.step("A. stop emailing X: everything of this person's to X that has not gone, and nothing else (12 flows)", async () => {
      for (let f = 0; f < 12; f++) {
        flows++;
        const u = uid(), other = uid(), x = at(`a${f}-x`), y = at(`a${f}-y`), name = "Dana Kim";
        await person(db, u); await person(db, other);
        const gmail = new FakeGmail();
        // Already sent to X (the first email), then waiting: two approved outreach drafts on the rail, one shown draft,
        // a follow-up of the first email on the rail, two replies-lane follow-ups (one shown, one approved).
        const first = await general(u, x, "Coffee chat?", `Hi, would you have 15 minutes? (${f})`);
        await drain(railDeps(db, conn, gmail), `w-a0-${f}`);
        const rail = await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [x, y]));
        await db.sql.query(`insert into public.career_outreach_drafts(user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status)
          values (${q(u)}, gen_random_uuid(), 1, '{}', ${q(x)}, 'S', 'B', 'F', repeat('e', 64), 'shown')`);
        const fu = await general(u, x, "Re: Coffee chat?", `Following up (${f}).`, { followUpOf: first.id, sendAt: new Date(Date.now() + 2 * DAY).toISOString() });
        await thread(u, x, name, false); await thread(u, x, name, true); await thread(u, y, "Lee Park", true);
        // Another person's email to X, and this person's to Y: never touched.
        await general(other, x, "Introduction", `A separate note (${f}).`);
        const holdsOne = f % 3 === 2;
        let r: Awaited<ReturnType<typeof repliesTurn>> = null;
        const say = f % 4 === 1 ? `stop emailing ${name}` : f % 4 === 3 ? `don't email ${x.toUpperCase()} anymore` : `stop emailing ${x}`;
        if (holdsOne) {
          // A worker already holds X's email when the person says stop: it asks career_send_go before Gmail and stops.
          const base = railDeps(db, conn, gmail);
          let said = false;
          const d: WorkerDeps = { ...base, rpc: async (n: string, a: any) => { if (n === "career_send_go" && !said) { said = true; r = await repliesTurn({ message: say, userId: u, chatThreadId: crypto.randomUUID(), now: Date.now(), store: replies }); } return base.rpc(n, a); } };
          await runSendWorker(d, { worker: `w-a1-${f}`, deadlineMs: 60_000, perAccount: 1, accounts: 1 }).catch(() => null);
          if (!said) r = await repliesTurn({ message: say, userId: u, chatThreadId: crypto.randomUUID(), now: Date.now(), store: replies });
        } else r = await repliesTurn({ message: say, userId: u, chatThreadId: crypto.randomUUID(), now: Date.now(), store: replies });
        check(r?.intent === STOP_INTENT && r.status === "stopped", `A${f}: "${say}" is the stop command (${r?.status}: ${r?.reply?.slice(0, 160)})`);
        const sentBefore = gmail.to(x).filter((m) => m.account === u).length;
        await drain(railDeps(db, conn, gmail, { now: () => Date.now() + 3 * DAY }), `w-a2-${f}`);
        const mine = await rows(db, `select recipient_email, state, result from public.career_send_queue where user_id = ${q(u)} and recipient_email = ${q(x)} and id <> ${q(first.id!)}`);
        check(mine.length >= 2 && mine.every((m: any) => m.state === "cancelled" && m.result === "stopped by you"), `A${f}: every waiting rail email to X is cancelled (${JSON.stringify(mine)})`);
        check(gmail.to(x).filter((m) => m.account === u).length === sentBefore && sentBefore <= 1, `A${f}: nothing more goes to X from this person (${gmail.to(x).length})`);
        const drafts = await rows(db, `select status, result from public.career_outreach_drafts where user_id = ${q(u)} and recipient_email = ${q(x)}`);
        check(drafts.every((d: any) => d.status === "skipped" && d.result === "stopped by you"), `A${f}: the drafts to X are skipped (${JSON.stringify(drafts)})`);
        const acts = await rows(db, `select a.status, t.recipient_email from public.career_outreach_actions a join public.career_outreach_threads t on t.id = a.thread_id where a.user_id = ${q(u)}`);
        check(acts.filter((a: any) => a.recipient_email === x).every((a: any) => a.status === "cancelled") && acts.filter((a: any) => a.recipient_email === y).every((a: any) => a.status === "approved"), `A${f}: X's follow-ups cancelled, Y's untouched (${JSON.stringify(acts)})`);
        const ths = await rows(db, `select recipient_email, followup_state from public.career_outreach_threads where user_id = ${q(u)}`);
        check(ths.filter((x2: any) => x2.recipient_email === x).every((x2: any) => x2.followup_state === "off") && ths.filter((x2: any) => x2.recipient_email === y).every((x2: any) => x2.followup_state !== "off"), `A${f}: follow-ups to X are off, Y's are not (${JSON.stringify(ths)})`);
        check(gmail.to(y).length === 1, `A${f}: this person's email to Y still goes (${gmail.to(y).length})`);
        check(gmail.to(x).some((m) => m.account === other), `A${f}: another person's email to X still goes`);
        check(/already went/.test(r?.reply ?? "") && /won't be sent/.test(r?.reply ?? ""), `A${f}: the reply says what was stopped and what had gone (${r?.reply})`);
        check(fu.status === "queued", `A${f}: setup`);
        check(rail.every((x2) => x2.status === "queued"), `A${f}: setup rail`);
      }
    });

    await t.step("B. follow-up approvals bound to the batch shown in the chat (10 flows)", async () => {
      for (let f = 0; f < 10; f++) {
        flows++;
        const u = uid(), chat = crypto.randomUUID();
        await person(db, u);
        await db.sql.query(`insert into public.agent_threads (id, user_id, title) values (${q(chat)}, ${q(u)}, 'TEST')`);
        // One batch of n follow-ups (one saveActions, as the scheduled run drafts them), each on its own conversation.
        const mk = async (n: number) => {
          const items = [];
          for (let i = 0; i < n; i++) {
            const to = at(`b${f}-${crypto.randomUUID().slice(0, 4)}`);
            const tid = await replies.track({ user_id: u, draft_id: null, provider: "gmail", provider_thread: `th-${crypto.randomUUID().slice(0, 8)}`, email: to, name: `P ${i}`, firm: "Acme", subject: "Coffee chat?", sent_at: new Date(Date.now() - 5 * DAY).toISOString() });
            const payload = { to, subject: "Re: Coffee chat?", text: `Following up (${i}).`, thread: null, provider: "gmail", step: 1 };
            items.push({ thread_id: tid, kind: "followup" as const, step: 1, payload, hash: await actionHash("followup", payload) });
          }
          return await replies.saveActions(u, items, Date.now());
        };
        const A = await mk(R.int(1, 3));
        const batchA = A[0].batch_id;
        const pushed = f % 2 === 0;
        if (pushed) {
          // The scheduled run's message, delivered into this chat (career_outbox_to_thread writes it).
          await db.sql.query(`insert into public.agent_messages (thread_id, role, content, meta) values (${q(chat)}, 'assistant', 'waiting for your yes',
            ${q(JSON.stringify({ career: true, intent: "career_proactive", kind: "followup", outbox_key: `followup:outreach-actions:${batchA}`, proactive: true }))}::jsonb)`);
        } else {
          const s = await repliesTurn({ message: "show outreach approvals", userId: u, chatThreadId: chat, now: Date.now(), store: replies });
          check(s?.status === "shown", `B${f}: shown`);
          await db.sql.query(`insert into public.agent_messages (thread_id, role, content, meta) values (${q(chat)}, 'assistant', ${q(s?.reply ?? "")}, ${q(JSON.stringify({ intent: ACTIONS_INTENT }))}::jsonb)`);
        }
        // The run drafts another batch before the person answers.
        const newer = await mk(R.int(1, 3));
        const answer = R.pick(["send all", "yes", "approve all", "send 1"]);
        const r = await repliesTurn({ message: answer, userId: u, chatThreadId: chat, now: Date.now(), store: replies });
        const st = await rows(db, `select batch_id, n, status from public.career_outreach_actions where user_id = ${q(u)} order by created_at, n`);
        const a = st.filter((x: any) => x.batch_id === batchA), b = st.filter((x: any) => x.batch_id === newer[0].batch_id);
        const want = answer === "send 1" ? [1] : a.map((x: any) => x.n);
        check(r?.status === "approved", `B${f} ${pushed ? "pushed" : "shown"}: "${answer}" is read (${r?.status})`);
        check(JSON.stringify(a.filter((x: any) => x.status === "approved").map((x: any) => x.n)) === JSON.stringify(want), `B${f}: exactly the shown batch's ${JSON.stringify(want)} approved (${JSON.stringify(a)})`);
        check(b.every((x: any) => x.status === "shown"), `B${f}: the newer batch is not approved (${JSON.stringify(b)})`);
        check(/more drafted since/.test(r?.reply ?? ""), `B${f}: the reply says newer ones wait (${r?.reply})`);
      }
    });

    await t.step("C. Gmail never answers a send: bounded inside the lease, Sent checked next, exactly once (10 flows)", async () => {
      for (let f = 0; f < 10; f++) {
        flows++;
        const u = uid(), n = R.int(1, 3), accepted = f % 2 === 0;
        await person(db, u);
        const addrs = Array.from({ length: n }, (_, i) => at(`c${f}-${i}`));
        await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, addrs));
        const gmail = new FakeGmail();
        let hung = 0;
        const hanging = (async (input: Request | URL | string, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);
          if (!hung && /\/messages\/send$/.test(url)) {
            hung++;
            // Gmail takes it (or not) and never answers; only the worker's bound ends the wait.
            if (accepted) await gmail.fetch(input, { ...init, signal: undefined });
            return await new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(new DOMException("aborted", "AbortError")), { once: true }));
          }
          return await gmail.fetch(input, init);
        }) as typeof fetch;
        const started = performance.now();
        const s = await runSendWorker({ ...railDeps(db, conn, gmail), fetch: hanging }, { worker: `w-c-${f}`, deadlineMs: 30_000, leaseSeconds: 120, sendTimeoutMs: 200 });
        const took = performance.now() - started;
        check(took < 20_000, `C${f}: the worker did not wait out the lease (${Math.round(took)} ms)`);
        const q0 = await rows(db, `select state, attempts, result from public.career_send_queue where user_id = ${q(u)} order by recipient_email`);
        check(q0.some((x: any) => x.state === "queued" && x.attempts === 1 && /did not answer/.test(x.result ?? "")), `C${f}: the unanswered send is an attempt, back in the queue (${JSON.stringify(q0)}, ${JSON.stringify(s)})`);
        await drain(railDeps(db, conn, gmail, { now: () => Date.now() + 2 * HOUR }), `w-c2-${f}`);
        for (const a of addrs) check(gmail.to(a).length === 1, `C${f} (${accepted ? "Gmail took it" : "never reached Gmail"}): ${a} got ${gmail.to(a).length} emails, wanted exactly 1`);
        const q1 = await rows(db, `select state from public.career_send_queue where user_id = ${q(u)}`);
        check(q1.every((x: any) => x.state === "sent"), `C${f}: every email ends sent (${JSON.stringify(q1)})`);
      }
    });

    await t.step("D. answers in other languages on the thread (16 flows)", async () => {
      const cases: [string, string, string, "stop" | "auto"][] = [
        ["es", "Re: Coffee chat?", "Por favor, no me escriba más.", "stop"], ["fr", "Re: Coffee chat?", "Merci de ne plus me contacter.", "stop"], ["de", "AW: Coffee chat?", "Bitte kontaktieren Sie mich nicht mehr.", "stop"],
        ["it", "R: Coffee chat?", "Non mi interessa, grazie.", "stop"], ["pt", "Re: Coffee chat?", "Não tenho interesse, obrigado.", "stop"], ["nl", "Re: Coffee chat?", "Geen interesse, bedankt.", "stop"],
        ["ja", "Re: Coffee chat?", "配信停止をお願いします。", "stop"], ["ru", "Re: Coffee chat?", "Пожалуйста, больше не пишите.", "stop"],
        ["ja", "自動返信: Coffee chat?", "現在不在にしております。", "auto"], ["zh", "自动回复: Coffee chat?", "我目前不在办公室。", "auto"], ["ru", "Автоответ: Coffee chat?", "Я в отпуске до 10 ноября.", "auto"],
        ["pl", "Automatyczna odpowiedź: Coffee chat?", "Jestem poza biurem.", "auto"], ["tr", "Otomatik yanıt: Coffee chat?", "Ofis dışındayım.", "auto"], ["da", "Fraværende: Coffee chat?", "Jeg er på ferie.", "auto"],
        ["es", "Re: Coffee chat?", "Estoy fuera de la oficina hasta el lunes.", "auto"], ["de", "AW: Coffee chat?", "Vielen Dank, ich bin derzeit im Urlaub.", "auto"],
      ];
      for (const [f, [lang, subject, text, kind]] of cases.entries()) {
        flows++;
        const u = uid(), x = at(`d${f}`);
        await person(db, u);
        const gmail = new FakeGmail();
        const first = await general(u, x, "Coffee chat?", `Hi, would you have 15 minutes? (${f})`);
        await drain(railDeps(db, conn, gmail), `w-d0-${f}`);
        await general(u, x, "Re: Coffee chat?", `Following up (${f}).`, { followUpOf: first.id });
        gmail.reply(gmail.to(x)[0].threadId, `Dana <${x}>`, subject, text);
        const before = gmail.sent.length;
        await drain(railDeps(db, conn, gmail), `w-d1-${f}`);
        await runReplyCheck(railDeps(db, conn, gmail), { limit: 20_000, recheckSeconds: 0 });
        const went = gmail.sent.length - before;
        const dnc = (await rows(db, `select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash(${q(x)})`)).length;
        if (kind === "stop") check(went === 0 && dnc === 1, `D${f} ${lang} opt-out "${text}": the follow-up is not sent and the address is opted out for everyone (went ${went}, dnc ${dnc})`);
        else check(went === 1 && dnc === 0, `D${f} ${lang} auto-reply "${subject}": not an answer; the follow-up goes (went ${went}, dnc ${dnc})`);
      }
    });

    await t.step("E. a follow-up of cold outreach carries List-Unsubscribe; an application or a one-off email does not (6 flows)", async () => {
      const unsub = (m: any) => (m?.headers ?? []).some((l: string) => /^List-Unsubscribe: <mailto:me@example\.test\?subject=unsubscribe>/.test(l));
      for (let f = 0; f < 6; f++) {
        flows++;
        const u = uid(), x = at(`e${f}`), plain = f >= 4;
        await person(db, u);
        const gmail = new FakeGmail();
        if (plain) {
          // An application sent by email and a one-off email the person approved: neither is cold outreach.
          const m = { to: x, subject: "Application: Analyst", text: `Please find my application (${f}).` };
          await queueApproved(rpc, u, [{ kind: "application", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m }]);
          await general(u, at(`e${f}-one`), "Thank you", `Thanks for your time (${f}).`);
          await drain(railDeps(db, conn, gmail), `w-e0-${f}`);
          check(gmail.sent.length === 2 && gmail.sent.every((m2) => !unsub(m2)), `E${f}: an application and a one-off email carry no List-Unsubscribe`);
          continue;
        }
        const [r0] = await queueApprovedOutreach(outreachDeps, u, await approvedDrafts(db, u, [x]));
        await drain(railDeps(db, conn, gmail), `w-e0-${f}`);
        // The replies lane's follow-up: kind general, following the outreach email (railRoot only ever names an outreach row).
        await general(u, x, "Re: A quick question 1", `Following up (${f}).`, { followUpOf: r0.id });
        await drain(railDeps(db, conn, gmail), `w-e1-${f}`);
        const [firstMail, follow] = gmail.to(x);
        check(follow && unsub(firstMail) && unsub(follow), `E${f}: the cold email and its follow-up both carry List-Unsubscribe (${JSON.stringify(follow?.headers)})`);
      }
    });

    await t.step("F. people discovery never counts an opted-out or bounced address as usable (8 flows)", async () => {
      const pstore = supabaseProviderStore(admin as any);
      for (let f = 0; f < 8; f++) {
        flows++;
        const firm = `Acmetest${RUN}${f}`, u = uid(), key = companyKey(firm), n = 4;
        await person(db, u);
        const emails = Array.from({ length: n }, (_, i) => at(`f${f}-${i}`));
        for (const [i, e] of emails.entries()) {
          await db.sql.query(`insert into public.career_people (user_id, source, name, email, company, company_key, position, source_ref, source_url, dedupe_key, provider, provider_id, domain, email_status, mx, sendable, fetched_at)
            values (${q(u)}, 'provider', ${q(`Person ${i}`)}, ${q(e)}, 'Acme', ${q(key)}, 'Recruiter', 'public page', 'https://acme.example.com/team', ${q(`p:web:${f}-${i}-${RUN}`)}, 'web', ${q(`${f}-${i}`)}, 'example.test', 'published', 'pass', true, now())`);
        }
        const other = uid();
        await person(db, other);
        // One opted out with someone else; one bounced for someone else.
        await db.sql.query(`insert into public.career_outreach_dnc (user_id, email_hash, reason) values (${q(other)}, public.career_outreach_email_hash(${q(emails[0])}), 'recipient asked to stop');
          insert into public.career_send_bad_addresses (email_hash, reason) values (public.career_send_email_hash(${q(emails[1])}), 'bounced') on conflict do nothing`);
        const got = await pstore.candidates(u, [key], 0, 100);
        check(got.length === n && got.filter((c) => c.blocked).map((c) => c.email).sort().join() === [emails[0], emails[1]].sort().join(), `F${f}: the opted-out and bounced addresses are marked (${JSON.stringify(got.map((c) => [c.email, c.blocked]))})`);
        const res = await findTargets(u, { kind: "role_at", titles: ["recruiter"], seniority: [], company: firm }, { store: pstore, config: { provider: null, apiKey: null, model: "", cacheSeconds: 0, leaseSeconds: 60, switchedOn: false }, provider: null, now: () => Date.now() });
        check(res.candidates.filter((c) => c.sendable).length === n - 2 && /, 2 with an address I could use/.test(res.reply), `F${f}: only the two clean addresses count as usable (${res.reply})`);
        check(res.candidates.filter((c) => c.blocked).every((c) => /asked not to be contacted, or their address bounced/.test(c.reason)), `F${f}: the reason says why an address is not used`);
      }
    });

    await t.step("H. Gmail and Outlook both connected: each email from the mailbox it was approved for (8 flows)", async () => {
      for (let f = 0; f < 8; f++) {
        flows++;
        const u = uid(), disconnect = f >= 4;
        await person(db, u, { outlook: true });
        const gmail = new FakeGmail();
        const viaOutlook: string[] = [];
        const want: { to: string; provider: "gmail" | "outlook" }[] = [];
        for (let i = 0; i < 4; i++) {
          const provider = i % 2 ? "outlook" : "gmail";
          const m = { to: at(`h${f}-${i}`), subject: `Hello ${i}`, text: `A note (${i}).` };
          const [r0] = await queueApproved(rpc, u, [{ kind: "general", provider, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m }]);
          check(r0.status === "queued", `H${f}: queued from ${provider} (${JSON.stringify(r0)})`);
          want.push({ to: m.to, provider });
        }
        if (disconnect) await db.sql.query(`delete from public.user_oauth_connections where user_id = ${q(u)} and provider = 'google_career'`);
        const deps: WorkerDeps = { ...railDeps(db, conn, gmail), providers: { outlook: { send: async (_u, m) => { viaOutlook.push(m.to); return { status: "sent", id: `o-${viaOutlook.length}` }; } } } };
        await drain(deps, `w-h-${f}`);
        for (const w of want) {
          const g = gmail.to(w.to).length, o = viaOutlook.filter((x) => x === w.to).length;
          if (w.provider === "outlook") check(o === 1 && g === 0, `H${f}: ${w.to} went once from Outlook (outlook ${o}, gmail ${g})`);
          else if (disconnect) check(o === 0 && g === 0, `H${f}: after the Gmail disconnect nothing went from Gmail, and it never moved to Outlook (outlook ${o}, gmail ${g})`);
          else check(g === 1 && o === 0, `H${f}: ${w.to} went once from Gmail (outlook ${o}, gmail ${g})`);
        }
      }
    });

    const ostore = supabaseOutreachStore(admin);
    await t.step("I. across people: an opt-out in another language or a hard bounce holds for everyone; a delay does not (8 flows)", async () => {
      const kinds: ["stop_es" | "stop_de" | "bounce" | "delay", string, string, string][] = [
        ["stop_es", "Dana <X>", "Re: Coffee chat?", "No me interesa, por favor no me escriba más."], ["stop_de", "Dana <X>", "AW: Coffee chat?", "Bitte nicht mehr anschreiben."],
        ["bounce", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found. 550 5.1.1 The email account that you tried to reach does not exist."],
        ["delay", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Delay)", "There was a temporary problem delivering your message. Gmail will retry for 46 more hours."],
      ];
      for (let f = 0; f < 8; f++) {
        flows++;
        const [kind, from, subject, text] = kinds[f % kinds.length];
        const a = uid(), b = uid(), x = at(`i${f}`);
        await person(db, a); await person(db, b);
        const gmail = new FakeGmail();
        await general(a, x, "Coffee chat?", `Hi (${f}).`);
        await general(b, x, "Introduction", `A separate note (${f}).`, { sendAt: new Date(Date.now() + 5 * DAY).toISOString() });
        await drain(railDeps(db, conn, gmail), `w-i-${f}`);
        gmail.reply(gmail.to(x)[0].threadId, from.replace("X", x), subject, text);
        await runReplyCheck(railDeps(db, conn, gmail), { limit: 20_000, recheckSeconds: 0 });
        const bRow = (await rows(db, `select state from public.career_send_queue where user_id = ${q(b)}`))[0];
        const blocked = await ostore.blocked!([x]);
        if (kind === "delay") check(bRow.state === "queued" && !blocked.has(x), `I${f} delay: nothing changes for anyone (${bRow.state}, ${[...blocked]})`);
        else {
          check(bRow.state === "cancelled", `I${f} ${kind}: another person's queued email is cancelled (${bRow.state})`);
          const m = { to: x, subject: "One more", text: `Hello again (${f}).` };
          const [r] = await queueApproved(rpc, b, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m }]);
          check(r.status === "refused", `I${f} ${kind}: their new email is refused (${JSON.stringify(r)})`);
          check(blocked.get(x) === (kind === "bounce" ? "bounced" : "opted_out"), `I${f} ${kind}: drafting sees it blocked for everyone (${JSON.stringify([...blocked])})`);
        }
      }
    });

    // Last: its 4,000 sent rows would sit ahead of every other flow's in the reply check's order.
    await t.step("G. one person queues 2,000 emails: no limit of Trainee's own; Gmail's quota backs off (2 flows)", async () => {
      for (const [f, quotaAt] of [[0, null], [1, 700]] as const) {
        flows++;
        const u = uid(), N = 2000;
        await person(db, u);
        const items = [];
        for (let i = 0; i < N; i++) { const m = { to: at(`g${f}-${i}`), subject: `Hello ${i}`, text: `A short note (${i}).` }; items.push({ kind: "general" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m }); }
        for (let k = 0; k < N; k += 500) await queueApproved(rpc, u, items.slice(k, k + 500));
        const gmail = new FakeGmail();
        if (quotaAt) gmail.script = (_a, k) => (k === quotaAt + 1 ? new Response(JSON.stringify({ error: { code: 429, message: "Too many requests" } }), { status: 429, headers: { "retry-after": "60" } }) : null);
        await drain(railDeps(db, conn, gmail), `w-g0-${f}`);
        if (quotaAt) {
          const acct = await rows(db, `select state from public.career_send_accounts where user_id = ${q(u)}`);
          check(gmail.sent.length === quotaAt && acct[0]?.state === "backoff", `G${f}: Gmail's quota pauses the account after ${quotaAt} (${gmail.sent.length}, ${acct[0]?.state})`);
          await drain(railDeps(db, conn, gmail, { now: () => Date.now() + 2 * HOUR }), `w-g1-${f}`);
        }
        const q1 = await rows(db, `select state, count(*)::int as n from public.career_send_queue where user_id = ${q(u)} group by state`);
        check(gmail.sent.length === N && new Set(gmail.sent.map((m) => m.to)).size === N, `G${f}: all ${N} went, each once (${gmail.sent.length})`);
        check(q1.length === 1 && q1[0].state === "sent" && q1[0].n === N, `G${f}: every row ends sent (${JSON.stringify(q1)})`);
      }
    });

    await t.step("nothing left the machine; every problem found is listed", () => {
      console.log(`[networking-r2 e2e] ${flows} flows, ${problems.length} problems, ${outside} outside requests`);
      eq(outside, 0, "no request left the machine");
      for (const p of problems) console.log(`  PROBLEM ${p}`);
      eq(problems, [], `${problems.length} of ${flows} flows found a problem; first: ${problems.slice(0, 3).join(" | ").slice(0, 1500)}`);
      ok(flows >= 80, `${flows} flows`);
    });
  } finally {
    globalThis.fetch = realFetch;
    await db.stop();
  }
} });
