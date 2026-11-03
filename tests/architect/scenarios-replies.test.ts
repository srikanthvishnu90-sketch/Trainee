// What comes back after an outreach email is sent, at scale (owner rules, 2026-10-29), fed ~10,000 generated messages
// (tests/architect/scenarios/replies-generator.ts, seeded):
//   - honor opt-outs forever: "stop", "unsubscribe", "please remove me", "take me off your list", "not interested,
//     thanks", "no thank you", in any case, after a greeting or not -> opted out; every email still queued to that address
//     cancelled (anyone's); never emailed again. Only the reply's own new words count: a "stop" in the quoted history
//     below it never does.
//   - never retry a bounce: a failure notice from any mail system marks the address bad forever (a full mailbox that the
//     mail system gave up on included: decided conservatively, career_send_rail.ts deliveryNotice); a DELAY warning is not
//     a bounce and marks nothing.
//   - an out-of-office is not a reply: the sequence goes on, after the return date when one is given.
//   - a real reply (interested, a time, a question, a referral, "not hiring now but keep in touch", a colleague in CC,
//     another address at the same domain, a signature only, HTML only, the original quoted below) stops the sequence.
//   - nothing is sent without the person's approval: reading what came back sends nothing; what goes afterwards is only
//     what was approved, and only where the rules above allow.
// Part 1 runs the real reading code of both lanes over every scenario: the sending rail's classifyIncoming (on Gmail's
// snippet, as runReplyCheck reads it) and the replies lane's recordMessage (on the message as Gmail's API serves it,
// through gmailMsg) over its in-memory store. Part 2 runs a seeded sample of 240 end to end on real Postgres with every
// migration: sent by the rail, a follow-up approved and queued, the message delivered to the thread, both lanes run
// (runReplyCheck and runReplySync), and the database's own rows read back. No model is called and nothing leaves the
// machine: Gmail is faked at the HTTP boundary.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { type Cls, generate, gmailMessage, gmailSnippet, NOW, sample, type Scenario } from "./scenarios/replies-generator.ts";
import { approvedDrafts, CI, FakeGmail, haveDb, person as railPerson, railDb, railDeps, rows, uid } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { classifyIncoming, queueApproved, queueApprovedOutreach, runReplyCheck, runSendWorker } from "../../supabase/functions/_shared/career_send_rail.ts";
import { actionHash, gmailMailbox, gmailMsg, memoryRepliesStore, recordMessage, runOutreachActions, runReplySync, sendRailReplyRail, supabaseRepliesStore } from "../../supabase/functions/_shared/career_outreach_replies.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261029, count: 10_000 });
const DAY = 86_400_000;

// ------------------------------------------------------------------------------------------------ the report
type Failure = { s: Scenario; got: string; why: string };
class Report {
  total = 0; byCls: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public path: string) {}
  grade(s: Scenario, why: string | null, got: string) {
    this.total++;
    this.byCls[s.cls] = (this.byCls[s.cls] ?? 0) + 1;
    if (!why) return;
    const k = s.category.split("/").slice(0, 2).join("/");
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ s, got, why });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[replies] ${this.path}: ${this.total} scenarios (${Object.entries(this.byCls).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    #${x.s.id} from ${JSON.stringify(x.s.from).slice(0, 60)} subject ${JSON.stringify(x.s.subject).slice(0, 60)} text ${JSON.stringify(x.s.text).slice(0, 110)} -> ${x.got} (${x.why})`);
    }
    console.log(lines.join("\n"));
    // The first few by category ride in the message itself: CI shows an assertion's message, not the console report.
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why ?? ""} | got ${String(xs[0].got).slice(0, 160)} | ${JSON.stringify(xs[0].s).slice(0, 220)}`).join(" || ");
    eq(failed, 0, `${this.path}: ${failed} scenarios were read wrong: ${first}`);
  }
}

// ------------------------------------------------------------------------------------------------ part 1: the rail
// What the sending rail must record for each class (career_send_record kinds; "other" records nothing).
const RAIL: Record<Cls, string> = { bounce: "bounce", delay: "other", receipt: "other", ooo: "other", opt_out: "stop", reply: "reply" };
Deno.test(`replies at scale, the sending rail (classifyIncoming on Gmail's snippet): ${SCENARIOS.length} scenarios`, () => {
  const rep = new Report("rail classifyIncoming");
  for (const s of SCENARIOS) {
    const got = classifyIncoming({ from: s.from, subject: s.subject, snippet: gmailSnippet(s) }, s.recipient);
    rep.grade(s, got === RAIL[s.cls] ? null : `must be ${RAIL[s.cls]}`, got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ part 1: the replies lane
// The thread the outreach email started (awaiting a reply, a follow-up drafted and waiting for the person's yes), the
// message read as Gmail serves it, recorded by the lane's own code without a model. What the thread says afterwards.
async function lane(s: Scenario) {
  const store = memoryRepliesStore();
  const id = await store.track({ user_id: "U", draft_id: "D", provider: "gmail", provider_thread: "GT", email: s.recipient, name: "Contact", firm: "Firm", subject: s.ourSubject, sent_at: new Date(NOW - 3 * DAY).toISOString() });
  const payload = { to: s.recipient, subject: `Re: ${s.ourSubject}`, text: "Following up on my note.", thread: "GT", provider: "gmail", step: 1 };
  await store.saveActions("U", [{ thread_id: id, kind: "followup", payload, hash: await actionHash("followup", payload), step: 1 }], NOW - DAY);
  const msg = gmailMsg(gmailMessage(s, { id: `m${s.id}`, threadId: "GT", at: NOW - 60_000 }));
  const res = await recordMessage({ store, userId: "U", thread: (await store.thread("U", id))!, msg, model: null, now: NOW, tz: "America/Chicago" });
  const d = store.dump();
  return { res, t: d.threads[0], action: d.actions[0], dnc: d.dnc.includes(s.recipient), turns: d.turns.length };
}
export function laneViolation(s: Scenario, o: Awaited<ReturnType<typeof lane>>): string | null {
  const { t, action, dnc } = o;
  switch (s.cls) {
    case "bounce":
      return t.status === "bounced" && dnc && action.status === "cancelled" ? null : "a bounce: thread bounced, address never contacted again, the follow-up cancelled";
    case "delay": case "receipt":
      return o.res === "ignored" && t.status === "awaiting" && t.followup_state === "none" && o.turns === 0 && !dnc && action.status === "shown" ? null : "not an answer: nothing recorded, nothing changed";
    case "ooo":
      if (t.status !== "out_of_office" || t.followup_state !== "none" || dnc || action.status !== "shown") return "an auto-reply: not a reply, the sequence goes on";
      return t.ooo_until === s.returnAt ? null : `return date ${s.returnAt} expected`;
    case "opt_out":
      return t.status === "not_interested" && dnc && action.status === "cancelled" && t.followup_state === "off" ? null : "an opt-out: not_interested, on the do-not-contact list, the follow-up cancelled";
    case "reply":
      return !["awaiting", "out_of_office", "not_interested", "bounced"].includes(t.status) && t.followup_state === "off" && action.status === "cancelled" && !dnc ? null
        : "a real reply: the sequence stops, nobody is opted out";
  }
}
Deno.test(`replies at scale, the replies lane (gmailMsg + recordMessage, no model): ${SCENARIOS.length} scenarios`, async () => {
  const rep = new Report("replies lane recordMessage");
  for (const s of SCENARIOS) {
    const o = await lane(s);
    rep.grade(s, laneViolation(s, o), `${o.res}: status ${o.t.status}, followup ${o.t.followup_state}, ooo_until ${o.t.ooo_until}, dnc ${o.dnc}, action ${o.action.status}`);
  }
  rep.assertClean();
});

Deno.test("the generator is deterministic and covers every class and the asked-for forms", () => {
  const again = generate({ seed: 20261029, count: 10_000 });
  eq(again.map((s) => `${s.from}|${s.subject}|${s.text}`), SCENARIOS.map((s) => `${s.from}|${s.subject}|${s.text}`));
  const by = (f: (s: Scenario) => boolean) => SCENARIOS.filter(f).length;
  for (const c of ["bounce", "delay", "ooo", "opt_out", "reply", "receipt"]) assertNode.ok(by((s) => s.cls === c) > 200, c);
  for (const c of ["bounce/gmail", "bounce/outlook.com", "bounce/exchange", "bounce/yahoo", "bounce/sendmail", "bounce/postfix", "bounce/soft-final", "delay/gmail", "delay/outlook.com", "delay/postfix", "delay/sendmail", "delay/exim",
    "ooo/de", "ooo/fr", "ooo/es", "ooo/body-only", "reply/cc-colleague", "reply/same-domain-alias", "reply/forwarded", "reply/signature-only", "reply/keep-in-touch", "reply/colleague-asks-removal", "receipt"]) {
    assertNode.ok(by((s) => s.category.startsWith(c)) > 20, c);
  }
  assertNode.ok(by((s) => s.htmlOnly) > 300, "HTML-only bodies");
  assertNode.ok(by((s) => s.cls === "opt_out" && /quoted-/.test(s.category)) > 500, "opt-outs with the original quoted below");
  assertNode.ok(by((s) => s.cls === "reply" && /quoted-/.test(s.category) && /\b(?:stop|unsubscribe|remove me|not interested)\b/i.test(s.text)) > 500, "real replies whose QUOTED history says stop");
  assertNode.ok(by((s) => s.cls === "ooo" && !!s.returnAt) > 500, "auto-replies with a return date");
  assertNode.ok(SCENARIOS.length >= 10_000);
});

// ------------------------------------------------------------------------------------------------ part 2: end to end
const E2E = 240;
const READ = "https://www.googleapis.com/auth/gmail.readonly";
// Gmail at the HTTP boundary: FakeGmail (the rail's fixture) takes sends and answers the rail's Sent search and thread
// reads (with each message's snippet); this adds the mailbox the replies lane reads (profile, history, a message or a
// thread in full), per account, over one log.
function fakeMailbox(gmail: FakeGmail) {
  let hid = 1000, seq = 0;
  const log: { account: string; id: string; threadId: string; hid: number; json: any }[] = [];
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_");
  gmail.afterAccept = (m) => log.push({ account: m.account, id: m.id, threadId: m.threadId, hid: ++hid, json: { id: m.id, threadId: m.threadId, labelIds: ["SENT"], internalDate: String(Date.now()), snippet: m.text.slice(0, 100),
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Sam Lee <me@example.test>" }, { name: "To", value: m.to }, { name: "Subject", value: m.subject }], body: { data: b64(m.text) } } } });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.host !== "gmail.googleapis.com") throw new Error(`unexpected host ${url.host}`);
    const account = (new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? "").replace(/^Bearer tok-(send|read)-/, "");
    const p = url.pathname.replace("/gmail/v1/users/me", "");
    const mine = log.filter((m) => m.account === account);
    if (method === "GET" && p === "/profile") return json({ historyId: String(hid) });
    if (method === "GET" && p === "/history") {
      const from = Number(url.searchParams.get("startHistoryId"));
      return json({ historyId: String(hid), history: mine.filter((m) => m.hid > from).map((m) => ({ messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(p), th = /^\/threads\/([^/]+)$/.exec(p);
    if (method === "GET" && url.searchParams.get("format") === "full" && one) { const m = mine.find((x) => x.id === one[1]); return m ? json(m.json) : json({}, 404); }
    if (method === "GET" && url.searchParams.get("format") === "full" && th) return json({ id: th[1], messages: mine.filter((x) => x.threadId === th[1]).map((x) => x.json) });
    return gmail.fetch(input, init);
  };
  // A message from the outside world on a sent email's thread, in the person's mailbox and on FakeGmail's thread.
  const receive = (account: string, threadId: string, s: Scenario) => {
    const id = `in${++seq}-${s.id}`;
    log.push({ account, id, threadId, hid: ++hid, json: gmailMessage(s, { id, threadId, at: Date.now() }) });
    gmail.reply(threadId, s.from, s.subject, gmailSnippet(s));
  };
  return { fetch, receive, log };
}

Deno.test({ name: `replies at scale, end to end on Postgres: ${E2E} sampled scenarios through both lanes, read back from the database`, sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  for (const k of ["ANTHROPIC_API_KEY"]) Deno.env.delete(k);
  const started = Date.now();
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    // The schema under test carries 20261029100000's rules (a CI-only failure looked like the older functions).
    const live = await rows(db, `select proname, (prosrc like '%(2) A follow-up of this person''s already queued%') as reply_rule,
        (prosrc like '%(3) What the rail itself already cancelled%') as takeback_rule
      from pg_proc where proname in ('career_outreach_reply_apply', 'career_outreach_rail_takeback') order by proname`);
    eq(live.map((r: any) => [r.proname, r.proname === "career_outreach_reply_apply" ? r.reply_rule : r.takeback_rule]),
      [["career_outreach_rail_takeback", true], ["career_outreach_reply_apply", true]], `the reply rules migration is applied: ${JSON.stringify(live)}`);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const gmail = new FakeGmail(), box = fakeMailbox(gmail);
    const conn = await db.conn();
    const deps = { ...railDeps(db, conn, gmail), fetch: box.fetch as typeof fetch };
    const rpc = { rpc: (n: string, a: any) => admin.rpc(n, a) as any };
    const store = supabaseRepliesStore(admin);
    const readers = { gmail: gmailMailbox({ fetch: box.fetch as typeof fetch, token: async (u, scope) => (scope === READ ? `tok-read-${u}` : null) }) };
    let clock = Date.now();
    // One clock for the whole run: the lane's "now" moves at least a second a pass and never falls behind the real time the
    // mailbox stamps messages with (a slow runner took minutes, and a message "from the future" was skipped as not yet arrived).
    const sync = () => runReplySync({ store, readers, model: null, now: (clock = Math.max(clock + 1000, Date.now())), worker: "r1", tz: async () => "America/Chicago", mailboxes: 1000 });
    // The return dates of the end-to-end scenarios are counted from the day this run starts, so each one is in the future of
    // the clock that sends: the follow-up of an auto-reply with a date waits past it on whatever day the test runs. Part 1's
    // scenarios keep their fixed dates and the fixed NOW they are read at. (This was Nov 2..27, 2026, read at the real
    // clock: from 2026-11-03 00:00 UTC "until Nov 2" was past and the follow-up rightly went at once.)
    const base = Date.UTC(new Date(started).getUTCFullYear(), new Date(started).getUTCMonth(), new Date(started).getUTCDate()) + DAY;
    const picked = sample(generate({ seed: 20261029, count: 10_000, base }), E2E, 2026);
    assertNode.ok(picked.every((s) => !s.returnAt || Date.parse(s.returnAt) > started + DAY), "every return date is still ahead of the clock that sends");
    const P = new Map(picked.map((s, i) => [s.id, uid(i + 1, "7a")]));
    const Q = uid(1, "7b"), R = uid(2, "7b"); // two other people who also have email queued to (or try) the same addresses
    for (const u of [...P.values(), Q, R]) await railPerson(db, u);
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

    await t.step(`setup: ${E2E} outreach emails sent by the rail, each with an approved follow-up queued behind it, and another person's email queued to the same address`, async () => {
      for (const s of picked) {
        const items = await approvedDrafts(db, P.get(s.id)!, [s.recipient], { subject: () => s.ourSubject });
        const r = await queueApprovedOutreach(deps, P.get(s.id)!, items);
        eq(r.map((x) => x.status), ["queued"], JSON.stringify(r));
      }
      let sent = 0;
      for (let i = 0; i < 10 && sent < E2E; i++) sent += (await runSendWorker(deps, { worker: "s1", deadlineMs: 60_000 })).sent;
      eq([sent, gmail.sent.length], [E2E, E2E]);
      eq((await sync()).errors, 0, "the first sync adopts each sent email's thread");
      eq((await rows(db, `select id from public.career_outreach_threads`)).length, E2E);
      // Each person's own sequence: two follow-ups, a day and then 30 days apart (the second is never due in this test).
      await db.sql.query(`insert into public.career_outreach_followup_prefs (user_id, steps, off) select id, array[1, 30], false from unnest(array[${[...P.values()].map(q).join(",")}]::uuid[]) id`);
      // Follow-up 1 on each thread, approved by the person (status approved, bound to the hash of its exact payload), handed
      // to the rail by the lane's own worker (career_outreach_actions -> career_send_queue, follow_up_of the first email).
      const ths = await rows(db, `select id, user_id, recipient_email, subject, provider_thread from public.career_outreach_threads`);
      const vals: string[] = [];
      for (const th of ths) {
        const payload = { to: th.recipient_email, subject: `Re: ${th.subject}`, text: `Hi, following up on my note about ${th.subject.toLowerCase()}.`, thread: th.provider_thread, provider: "gmail", step: 1 };
        const h = await actionHash("followup", payload);
        vals.push(`(${q(th.user_id)}, ${q(th.id)}, 'followup', 1, gen_random_uuid(), 1, ${q(JSON.stringify(payload))}::jsonb, '${h}', 'approved', '${h}', now())`);
      }
      await db.sql.query(`insert into public.career_outreach_actions (user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at) values ${vals.join(",")}`);
      const rail = sendRailReplyRail(rpc);
      let handed = 0;
      for (let i = 0; i < 10; i++) { const st = await runOutreachActions({ store, rail, calendars: {}, now: (clock = Math.max(clock + 1000, Date.now())), worker: "a1", limit: 500, perUser: 5 }); handed += st.sent; if (!st.claimed) break; }
      eq(handed, E2E);
      const fus = await rows(db, `select f.state, f.follow_up_of = o.id as of_root from public.career_send_queue f join public.career_send_queue o on o.user_id = f.user_id and o.kind = 'outreach' where f.kind = 'general'`);
      eq([fus.length, fus.every((f) => f.state === "queued" && f.of_root)], [E2E, true], "every follow-up waits on the rail as a step of its sequence");
      // Another person's approved email to the same address, due in 30 days (an opt-out or a bounce must cancel it now).
      const others = [];
      for (const s of picked) {
        const m = { to: s.recipient, subject: "Introduction", text: `Hello, a separate note to ${s.recipient}.` };
        others.push({ kind: "general" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m, sendAt: new Date(Date.now() + 30 * DAY).toISOString() });
      }
      const qr = await queueApproved(rpc, Q, others);
      eq(qr.filter((x) => x.status === "queued").length, E2E);
    });

    const before = new Map((await rows(db, `select recipient_email, next_at from public.career_send_queue where kind = 'general' and user_id <> '${Q}'`)).map((r) => [r.recipient_email, Date.parse(r.next_at)]));
    const sendsBefore = gmail.sent.length;
    await t.step(`each message arrives on its thread; both lanes read it (the rail's reply check, then the replies sync); nothing is sent`, async () => {
      const roots = new Map((await rows(db, `select user_id, gmail_thread from public.career_send_queue where kind = 'outreach'`)).map((r) => [r.user_id, r.gmail_thread]));
      for (const s of picked) box.receive(P.get(s.id)!, roots.get(P.get(s.id)!)!, s);
      const rc = await runReplyCheck(deps, { limit: 1000 });
      eq([rc.checked, rc.errors], [E2E, 0], JSON.stringify(rc));
      // The next scheduled read: every mailbox is due now (production reads each one every few minutes). Without this the
      // second read depended on how long the steps above took against the interval the first read scheduled (CI-only, 202
      // of 240 read nothing: the lane never saw the answers).
      await db.sql.query(`update public.career_outreach_sync set next_at = '2000-01-01T00:00:00Z', lease_owner = null, lease_until = null`);
      const st = await sync();
      eq(st.mailboxes, E2E, `every mailbox read: ${JSON.stringify(st)}`);
      eq(st.errors, 0, JSON.stringify(st));
      eq(gmail.sent.length, sendsBefore, "reading what came back sends nothing");
    });

    await t.step("every scenario's rows: the address, the first email, the follow-up, the other person's email, the thread", async () => {
      const rep = new Report("end to end (rail + replies lane + Postgres)");
      const got = new Map((await rows(db, `select o.recipient_email as email, o.state as root, o.result as root_result,
          (select f.state from public.career_send_queue f where f.follow_up_of = o.id) as fu, (select f.next_at from public.career_send_queue f where f.follow_up_of = o.id) as fu_at,
          (select x.state from public.career_send_queue x where x.user_id = '${Q}' and x.recipient_email = o.recipient_email) as other,
          exists (select 1 from public.career_outreach_dnc d where d.email_hash = public.career_send_email_hash(o.recipient_email)) as dnc,
          exists (select 1 from public.career_send_bad_addresses b where b.email_hash = public.career_send_email_hash(o.recipient_email)) as bad,
          t.status, t.followup_state, t.ooo_until, t.followups_sent, (select a.status from public.career_outreach_actions a where a.thread_id = t.id and a.kind = 'followup') as action, (select count(*) from public.career_outreach_turns u where u.thread_id = t.id and u.who <> 'person')::int as their_turns
        from public.career_send_queue o join public.career_outreach_threads t on t.user_id = o.user_id where o.kind = 'outreach'`)).map((r) => [r.email, r]));
      for (const s of picked) {
        const r = got.get(s.recipient);
        const fuAt = Date.parse(r.fu_at), was = before.get(s.recipient)!;
        let why: string | null = null;
        // The follow-up that never went is never counted as sent, whichever lane read the answer first.
        const stopped = s.cls === "bounce" || s.cls === "opt_out" || s.cls === "reply";
        if (stopped ? r.followups_sent !== 0 || r.action !== "cancelled" : r.followups_sent !== 1 || r.action !== "done") why = stopped ? "the cancelled follow-up is not counted as sent" : "the queued follow-up stays counted";
        if (!why) switch (s.cls) {
          case "bounce":
            if (!(r.bad && r.root === "bounced" && r.fu === "cancelled" && r.other === "cancelled" && r.status === "bounced")) why = "bounce: address bad forever, every queued email to it cancelled, the thread bounced";
            break;
          case "delay": case "receipt":
            if (r.bad || r.dnc || r.root !== "sent" || r.fu !== "queued" || fuAt !== was || r.other !== "queued" || r.status !== "awaiting" || r.followup_state !== "none" || r.their_turns !== 0) why = "not an answer: nothing marked, nothing stopped, nothing recorded";
            break;
          case "ooo": {
            if (r.bad || r.dnc || r.root !== "sent" || r.fu !== "queued" || r.other !== "queued" || r.status !== "out_of_office" || r.followup_state !== "none") { why = "auto-reply: the sequence goes on"; break; }
            const back = s.returnAt ? Date.parse(s.returnAt) : null;
            if ((r.ooo_until ? Date.parse(r.ooo_until) : null) !== back) why = `ooo_until must be ${s.returnAt}`;
            else if (back !== null && fuAt < back + DAY) why = "the queued follow-up waits past the return date";
            else if (back === null && fuAt !== was) why = "no return date: the follow-up keeps its time";
            break;
          }
          case "opt_out":
            if (!(r.dnc && !r.bad && r.root === "replied" && r.root_result === "stop" && r.fu === "cancelled" && r.other === "cancelled" && r.status === "not_interested")) why = "opt-out: on the list forever, every queued email to it cancelled";
            break;
          case "reply":
            if (r.dnc || r.bad || r.root !== "replied" || r.root_result !== "reply" || r.fu !== "cancelled" || r.other !== "queued" || ["awaiting", "out_of_office", "not_interested", "bounced"].includes(r.status) || r.followup_state !== "off") why = "a real reply: the sequence stops, nobody is opted out";
            break;
        }
        // The fields that decide first: CI cuts an assertion message short.
        rep.grade(s, why, JSON.stringify({ sent: r.followups_sent, action: r.action, fu: r.fu, status: r.status, state: r.followup_state, ...r, fu_at: fuAt === was ? "unchanged" : r.fu_at }));
      }
      rep.assertClean();
    });

    await t.step("never emailed again: anyone's new approved email to an opted-out or bounced address is refused", async () => {
      const gone = picked.filter((s) => s.cls === "opt_out" || s.cls === "bounce");
      const items = [];
      for (const s of gone) { const m = { to: s.recipient, subject: "One more thing", text: "Hello again." }; items.push({ kind: "general" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m }); }
      const res = await queueApproved(rpc, R, items);
      // A bounced address is on both lists (bad forever, and do-not-contact): either reason refuses it.
      const bad = res.map((r, i) => [gone[i], r] as const).filter(([s, r]) => !(r.status === "refused" && (s.cls === "bounce" ? ["bad_address", "opted_out"] : ["opted_out"]).includes(String(r.reason))));
      eq(bad.map(([s, r]) => `${s.category}: ${JSON.stringify(r)}`), []);
    });

    await t.step("what goes afterwards is only what was approved: the follow-ups whose sequence goes on now, exactly as approved; nothing else", async () => {
      let sent = 0;
      for (let i = 0; i < 10; i++) { const st = await runSendWorker(deps, { worker: "s2", deadlineMs: 60_000 }); sent += st.sent; if (!st.sent) break; }
      const went = gmail.sent.slice(sendsBefore);
      const want = picked.filter((s) => s.cls === "delay" || s.cls === "receipt" || (s.cls === "ooo" && !s.returnAt)).map((s) => s.recipient).sort();
      eq(went.map((m) => m.to).sort(), want, "only sequences still going and not waiting past a return date");
      const approved = new Map((await rows(db, `select payload from public.career_outreach_actions where kind = 'followup'`)).map((a) => [a.payload.to, a.payload]));
      for (const m of went) eq([m.subject, m.text], [approved.get(m.to).subject, approved.get(m.to).text], "exactly the approved payload");
      eq(sent, want.length);
    });
    console.log(`[replies] end to end: ${E2E} scenarios in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    await db.stop();
  }
} });
