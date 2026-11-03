// MASS NETWORKING M5 on real Postgres 16 with every migration, through M1's sending rail: replies read from the person's
// Gmail (gmail.readonly) and understood, the person's own follow-up sequence (each approved by its exact hash and handed
// to career_send_queue), a reply that cancels a follow-up still waiting on the rail, a bounce that marks the address bad
// for everyone, a "stop" that is final, a call proposed from Google Calendar free/busy, and the invite created only after
// the person approves that exact event, once. Google (Gmail, Calendar) is faked at the HTTP boundary; the model is a
// scripted stand-in (no model call); the service client is the real supabase-js over tests/flow/postgrest.ts. Every
// assertion reads database rows, the outbox, or what "Google" received; nothing reaches Google or the live project.
// Run: deno test -A --no-check tests/architect/m5-replies-rail-pg.test.ts (where esm.sh is unreachable, add
// --import-map=tests/flow/supabase-npm.json: the same supabase-js from npm).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { approvedDrafts, CI, FakeGmail, haveDb, person as railPerson, railDb, railDeps, rows, uid } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { queueApproved, queueApprovedOutreach, runSendWorker } from "../../supabase/functions/_shared/career_send_rail.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { googleCalendar } from "../../supabase/functions/_shared/career_calendar.ts";
import {
  gmailMailbox, repliesTurn, runFollowupDrafts, runOutreachActions, runReplySync, runScheduling, sendRailReplyRail, supabaseRepliesStore,
} from "../../supabase/functions/_shared/career_outreach_replies.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const DAY = 86_400_000;
const FACTS = [{ id: "F-1", kind: "education", text: "BS Economics, NYU", status: "confirmed" }];

// ------------------------------------------------------------------------------------------------ fake Google
// FakeGmail (the rail's fixture) takes the sends and answers the rail's Sent search and reply check; this adds what the
// mailbox reader asks (profile, history, a message or a thread in full) over one log of every message, and Calendar.
function fakeGoogle(gmail: FakeGmail) {
  let hid = 1000, seq = 0;
  const log: { id: string; threadId: string; from: string; subject: string; text: string; at: number; sent: boolean; hid: number; headers: Record<string, string> }[] = [];
  const events = new Map<string, any>(), eventPosts: { url: string; body: any }[] = [];
  const blocked = new Set<string>(); // mailbox tokens Google refuses (an account not on the unverified app's test list)
  gmail.afterAccept = (m) => { log.push({ id: m.id, threadId: m.threadId, from: "Sam Lee <me@example.test>", subject: m.subject, text: m.text, at: Date.now(), sent: true, hid: ++hid, headers: {} }); };
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_");
  const full = (m: (typeof log)[number]) => ({ id: m.id, threadId: m.threadId, labelIds: [m.sent ? "SENT" : "INBOX"], internalDate: String(m.at), snippet: m.text.slice(0, 100),
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, ...Object.entries(m.headers).map(([name, value]) => ({ name, value }))], body: { data: b64(m.text) } } });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? "";
    if (url.host === "gmail.googleapis.com") {
      if (blocked.has(auth.replace(/^Bearer /, ""))) return json({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, 403);
      const p = url.pathname.replace("/gmail/v1/users/me", "");
      if (method === "GET" && p === "/profile") return json({ historyId: String(hid) });
      if (method === "GET" && p === "/history") {
        const from = Number(url.searchParams.get("startHistoryId"));
        return json({ historyId: String(hid), history: log.filter((m) => m.hid > from).map((m) => ({ messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })) });
      }
      const one = /^\/messages\/([^/]+)$/.exec(p), th = /^\/threads\/([^/]+)$/.exec(p);
      if (method === "GET" && url.searchParams.get("format") === "full" && one) { const m = log.find((x) => x.id === one[1]); return m ? json(full(m)) : json({}, 404); }
      if (method === "GET" && url.searchParams.get("format") === "full" && th) return json({ id: th[1], messages: log.filter((x) => x.threadId === th[1]).map(full) });
      return gmail.fetch(input, init);
    }
    if (url.host === "www.googleapis.com" && url.pathname === "/calendar/v3/freeBusy") return json({ calendars: { primary: { busy: [] } } });
    if (url.host === "www.googleapis.com" && url.pathname === "/calendar/v3/calendars/primary/events" && method === "POST") {
      const body = JSON.parse(String(init!.body));
      eventPosts.push({ url: url.toString(), body });
      if (events.has(body.id)) return json({ error: { code: 409 } }, 409);
      const ev = { ...body, hangoutLink: "https://meet.google.com/abc-defg-hij", htmlLink: "https://calendar.google.com/e" };
      events.set(body.id, ev);
      return json(ev);
    }
    return json({ error: `unexpected ${method} ${url}` }, 500);
  };
  // A message from someone else on a thread: in the mailbox log and in FakeGmail's thread (the rail's reply check).
  const receive = (threadId: string, from: string, subject: string, text: string, headers: Record<string, string> = {}) => {
    log.push({ id: `x${++seq}`, threadId, from, subject, text, at: Date.now(), sent: false, hid: ++hid, headers });
    if (gmail.threads.has(threadId)) gmail.reply(threadId, from, subject, text.slice(0, 100));
  };
  return { fetch, receive, log, events, eventPosts, blocked };
}

// The scripted model: reads the quoted email by its words, and drafts short fact-clean text. No model is called.
const model = async (p: any) => {
  const sys = String(p.system ?? ""), user = typeof p.messages[0].content === "string" ? p.messages[0].content : "";
  if (/follow-up to an earlier networking email/.test(sys)) return { stop_reason: "end_turn", content: [{ type: "text", text: `Hi ${/Recipient: (\w+)/.exec(user)![1]},\n\nI wanted to follow up on my earlier note. Would you have a few minutes to talk?` }] };
  if (/opening of a short reply/.test(sys)) return { stop_reason: "end_turn", content: [{ type: "text", text: `Hi ${/first name: (\w+)/.exec(user)![1]},\n\nThank you for being open to a call. A few times that work for me are below.` }] };
  const email = /<<<EMAIL\n([\s\S]*)\nEMAIL>>>/.exec(user)![1];
  const input: any = { class: "other", summary: "They replied." };
  const time = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))/.exec(email)?.[1];
  if (/works for me/i.test(email)) Object.assign(input, { class: "confirms_time", summary: "Confirmed a time.", times: time ? [time] : [] });
  else if (/happy to chat/i.test(email)) Object.assign(input, { class: "wants_call", summary: "Happy to talk; asked for times.", asks: ["share a few times"] });
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "x1", name: "record_email", input }] };
};
const person = async () => ({ facts: FACTS, signature: "Sam Lee", name: "Sam Lee" });
const tz = async () => "America/Chicago";

Deno.test({ name: "M5 on Postgres: replies, follow-ups and calls through the sending rail", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const gmail = new FakeGmail(), google = fakeGoogle(gmail);
    const conn = await db.conn();
    const deps = { ...railDeps(db, conn, gmail), fetch: google.fetch as typeof fetch };
    const store = supabaseRepliesStore(admin);
    const outbox = supabaseAlertStore(admin);
    const mailboxToken = async (u: string) => (u === BLOCKED ? "tok-blocked" : `tok-read-${u}`);
    const readers = { gmail: gmailMailbox({ fetch: google.fetch as typeof fetch, token: (u) => mailboxToken(u) }) };
    const calendars = { gmail: googleCalendar({ fetch: google.fetch as typeof fetch, token: async () => "tok-cal" }) };
    const rail = sendRailReplyRail({ rpc: (n, a) => admin.rpc(n, a) as any });
    let clock = Date.now() + 1000; // the lane's own "now" moves forward; the database and the rail keep the real one
    const sync = (dt = 600_000) => runReplySync({ store, readers, model, now: (clock += dt), worker: "r1", tz });
    const actions = () => runOutreachActions({ store, rail, calendars, now: (clock += 60_000), worker: "a1" });
    const send = () => runSendWorker(deps, { worker: "s1", deadlineMs: 10_000 });
    const chatThread = async (u: string) => (await db.sql.query(`insert into public.agent_threads(user_id) values ('${u}') returning id`))[0][0] as string;
    // The thread's last word is the approvals message (what the outbox delivery leaves), so "send all" answers it.
    const said = (chat: string, intent: string) => db.sql.query(`insert into public.agent_messages(thread_id, role, content, meta) values ('${chat}', 'assistant', 'approvals', '{"intent":"${intent}"}')`);
    const say = (u: string, chat: string, message: string) => repliesTurn({ message, userId: u, chatThreadId: chat, now: clock, store, tz: "America/Chicago" });
    const P = uid(1, "5f"), Q = uid(2, "5f"), R = uid(3, "5f"), BLOCKED = uid(4, "5f");
    for (const u of [P, Q, R, BLOCKED]) await railPerson(db, u);
    const sentOutreach = async (u: string, tos: string[]) => {
      const items = await approvedDrafts(db, u, tos);
      const q = await queueApprovedOutreach(deps, u, items);
      assert(q.every((x) => x.status === "queued"), JSON.stringify(q));
      await send();
    };
    const thread = async (u: string, email: string) => (await rows(db, `select * from public.career_outreach_threads where user_id = '${u}' and recipient_email = '${email}'`))[0];
    const P_CHAT = await chatThread(P);

    await t.step("a sent outreach email is watched, and the first sync reads its thread", async () => {
      await sentOutreach(P, ["avery@beta.example"]);
      eq(gmail.to("avery@beta.example").length, 1);
      const st = await sync();
      eq([st.mailboxes, st.errors], [1, 0], JSON.stringify(st));
      const th = await thread(P, "avery@beta.example");
      eq([th.status, th.provider, th.turns, th.followups_sent], ["awaiting", "gmail", 1, 0]);
      eq(th.provider_thread, gmail.to("avery@beta.example")[0].threadId);
      const [s] = await rows(db, `select cursor, last_error from public.career_outreach_sync where user_id = '${P}'`);
      assert(s.cursor && !s.last_error, JSON.stringify(s));
    });

    await t.step("the person's own sequence, any length, from chat", async () => {
      eq((await say(P, P_CHAT, "follow up after 3 and 4 days"))?.status, "sequence");
      eq((await rows(db, `select steps, off from public.career_outreach_followup_prefs where user_id = '${P}'`))[0], { steps: [3, 1], off: false });
    });

    let first: any;
    await t.step("follow-up 1 is drafted for approval, shown in the outbox, and bound to the hash of its exact payload", async () => {
      clock += 3 * DAY;
      eq((await runFollowupDrafts({ store, outbox, model, person, now: clock, worker: "f1" })).drafted, 1);
      [first] = await rows(db, `select * from public.career_outreach_actions where user_id = '${P}'`);
      eq([first.kind, first.step, first.status, first.payload.to], ["followup", 1, "shown", "avery@beta.example"]);
      eq(first.hash, await payloadHash({ to: first.payload.to, subject: first.payload.subject, text: first.payload.text }));
      const ob = await rows(db, `select key, kind, text from public.career_outbox where user_id = '${P}' and key like 'followup:outreach-actions:%'`);
      eq(ob.length, 1);
      assert(ob[0].text.includes(first.payload.text), "the exact text is what is shown");
      eq((await actions()).claimed, 0, "nothing goes before the yes");
      eq((await rows(db, `select id from public.career_send_queue where user_id = '${P}' and kind = 'general'`)).length, 0);
    });

    await t.step("fail first: a yes for another hash approves nothing; an ambiguous yes approves nothing", async () => {
      eq(await store.approve(P, first.batch_id, [{ n: 1, hash: "0".repeat(64) }], clock), []);
      await said(P_CHAT, "career_outreach_actions");
      eq((await say(P, P_CHAT, "yes maybe"))?.status, "ambiguous");
      eq((await rows(db, `select status from public.career_outreach_actions where id = '${first.id}'`))[0].status, "shown");
    });

    let firstQueue: any;
    await t.step("\"send all\" approves exactly it; the worker hands it to the rail once; the rail sends it once", async () => {
      await said(P_CHAT, "career_outreach_actions");
      eq((await say(P, P_CHAT, "send all"))?.status, "approved");
      eq((await actions()).sent, 1);
      eq((await actions()).claimed, 0, "never twice");
      const q = await rows(db, `select * from public.career_send_queue where user_id = '${P}' and kind = 'general'`);
      eq(q.map((x) => [x.source_id, x.approval_hash, x.recipient_email, x.state]), [[first.id, first.hash, "avery@beta.example", "queued"]]);
      firstQueue = q[0];
      const [root] = await rows(db, `select id from public.career_send_queue where user_id = '${P}' and kind = 'outreach'`);
      eq(firstQueue.follow_up_of, root.id, "a step of the sequence that began with the outreach email (the rail keeps it in order and stops it on a reply)");
      const [a] = await rows(db, `select status, provider_ref from public.career_outreach_actions where id = '${first.id}'`);
      eq([a.status, a.provider_ref], ["done", firstQueue.id]);
      eq((await thread(P, "avery@beta.example")).followups_sent, 1);
      eq((await send()).sent, 1);
      eq(gmail.to("avery@beta.example").map((m) => m.text), [gmail.to("avery@beta.example")[0].text, first.payload.text]);
      eq((await send()).sent, 0, "the rail sends it once");
    });

    await t.step("the rail's new thread becomes the conversation's (alias)", async () => {
      await sync();
      const [q] = await rows(db, `select gmail_thread from public.career_send_queue where id = '${firstQueue.id}'`);
      const al = await rows(db, `select provider_thread, thread_id from public.career_outreach_thread_aliases where user_id = '${P}'`);
      eq(al, [{ provider_thread: q.gmail_thread, thread_id: (await thread(P, "avery@beta.example")).id }]);
    });

    let secondQueue: any;
    await t.step("follow-up 2, approved and queued; their reply on the follow-up's thread cancels it on the rail before it goes", async () => {
      clock += 2 * DAY;
      eq((await runFollowupDrafts({ store, outbox, model, person, now: clock, worker: "f1" })).drafted, 1);
      const [second] = await rows(db, `select * from public.career_outreach_actions where user_id = '${P}' and step = 2`);
      await said(P_CHAT, "career_outreach_actions");
      eq((await say(P, P_CHAT, "send 1"))?.status, "approved");
      eq((await actions()).sent, 1);
      [secondQueue] = await rows(db, `select * from public.career_send_queue where source_id = '${second.id}'`);
      eq(secondQueue.state, "queued");
      const [q1] = await rows(db, `select gmail_thread from public.career_send_queue where id = '${firstQueue.id}'`);
      google.receive(q1.gmail_thread, "Avery Park <avery@beta.example>", "Re: A quick question 1", "Thanks for following up. Happy to chat next week.");
      const st = await sync();
      eq(st.classes, { wants_call: 1 }, JSON.stringify(st));
      const th = await thread(P, "avery@beta.example");
      eq([th.status, th.followup_state, !!th.replied_at], ["wants_call", "off", true]);
      eq((await rows(db, `select state, result from public.career_send_queue where id = '${secondQueue.id}'`))[0], { state: "cancelled", result: "they replied" });
      eq((await rows(db, `select status, result from public.career_outreach_actions where id = '${second.id}'`))[0], { status: "cancelled", result: "not sent: they replied" });
      eq(th.followups_sent, 1, "only what went is counted");
      eq((await send()).sent, 0);
      eq(gmail.to("avery@beta.example").length, 2, "follow-up 2 never went");
      const turns = await rows(db, `select who, class from public.career_outreach_turns where thread_id = '${th.id}' and who <> 'person'`);
      eq(turns, [{ who: "contact", class: "wants_call" }], "the contact's turn, once; the rail's own sends are the person's turns");
    });

    let slots: any[] = [];
    await t.step("a call: three free times from Google Calendar, the reply approved and sent through the rail", async () => {
      const st = await runScheduling({ store, outbox, calendars, model, person, tz, now: (clock += 60_000) });
      eq(st, { drafted: 1 });
      const [a] = await rows(db, `select * from public.career_outreach_actions where user_id = '${P}' and kind = 'schedule_reply'`);
      slots = a.payload.slots;
      eq([a.status, slots.length], ["shown", 3]);
      await said(P_CHAT, "career_outreach_actions");
      eq((await say(P, P_CHAT, "send all"))?.status, "approved");
      eq((await actions()).sent, 1);
      eq((await send()).sent, 1);
      const th = await thread(P, "avery@beta.example");
      eq([th.status, th.offered.length], ["call_proposed", 3]);
      assert(gmail.to("avery@beta.example").at(-1)!.text.includes(slots[0].contact), "the times went as shown");
    });

    await t.step("they confirm a time: the exact invite waits for its own yes; a wrong hash creates nothing; the right yes creates it once", async () => {
      await sync(); // the scheduling reply's own thread becomes an alias
      const [q] = await rows(db, `select q.gmail_thread from public.career_send_queue q join public.career_outreach_actions a on a.provider_ref = q.id::text where a.kind = 'schedule_reply' and a.user_id = '${P}'`);
      google.receive(q.gmail_thread, "Avery Park <avery@beta.example>", "Re: A quick question 1", `That time works for me: ${slots[1].start}. See you then.`);
      await sync();
      const [ev] = await rows(db, `select * from public.career_outreach_actions where user_id = '${P}' and kind = 'calendar_event'`);
      eq([ev.status, ev.payload.start, ev.payload.attendees], ["shown", slots[1].start, ["avery@beta.example"]]);
      eq(await store.approve(P, ev.batch_id, [{ n: ev.n, hash: "f".repeat(64) }], clock), [], "fail first: another hash approves nothing");
      eq((await actions()).events, 0);
      eq(google.eventPosts.length, 0, "no invite without the person's yes");
      await said(P_CHAT, "career_outreach_actions");
      eq((await say(P, P_CHAT, "send all"))?.status, "approved");
      eq((await actions()).events, 1);
      eq((await actions()).events, 0, "once");
      eq(google.eventPosts.length, 1);
      eq([google.eventPosts[0].body.attendees, google.eventPosts[0].body.start.dateTime], [[{ email: "avery@beta.example" }], slots[1].start]);
      assert(/sendUpdates=all/.test(google.eventPosts[0].url));
      const th = await thread(P, "avery@beta.example");
      eq([th.status, th.event.link], ["call_scheduled", "https://meet.google.com/abc-defg-hij"]);
    });

    await t.step("fail first: a payload changed after the yes is refused by the worker and never reaches the rail; the hash itself cannot be swapped", async () => {
      const chat = await chatThread(Q);
      await sentOutreach(Q, ["blake@beta.example"]);
      await sync();
      await store.setPrefs(Q, { steps: [1] });
      clock += 2 * DAY;
      await runFollowupDrafts({ store, outbox, model, person, now: clock, worker: "f1" });
      const [a] = await rows(db, `select * from public.career_outreach_actions where user_id = '${Q}'`);
      await said(chat, "career_outreach_actions");
      eq((await say(Q, chat, "send all"))?.status, "approved");
      await db.sql.query(`update public.career_outreach_actions set payload = jsonb_set(payload, '{text}', '"Send me your bank details."') where id = '${a.id}'`);
      await assertNode.rejects(db.sql.query(`update public.career_outreach_actions set hash = '${"1".repeat(64)}' where id = '${a.id}'`), /approved_is_exact/);
      const st = await actions();
      eq([st.sent, st.refused], [0, 1]);
      eq((await rows(db, `select status, result from public.career_outreach_actions where id = '${a.id}'`))[0], { status: "failed", result: "refused: changed" });
      eq((await rows(db, `select id from public.career_send_queue where user_id = '${Q}' and kind = 'general'`)).length, 0);
      // And the rail itself refuses a text that does not hash to the approval it is given.
      const m = { to: "blake@beta.example", subject: "Re: hi", text: "Hi Blake" };
      eq((await queueApproved({ rpc: (n, x) => admin.rpc(n, x) as any }, Q, [{ kind: "general", sourceId: a.id, approvalHash: await payloadHash({ ...m, text: "other" }), ...m }]))[0].reason, "changed");
      eq(gmail.to("blake@beta.example").length, 1);
    });

    await t.step("a bounce marks the address bad for everyone, forever; a stop is final; neither is ever emailed again", async () => {
      await sentOutreach(R, ["ghost@gamma.example", "nope@gamma.example"]);
      await sync();
      const ghost = await thread(R, "ghost@gamma.example"), nope = await thread(R, "nope@gamma.example");
      google.receive(ghost.provider_thread, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found");
      google.receive(nope.provider_thread, "Nope Person <nope@gamma.example>", "Re: A quick question 2", "Please stop emailing me.");
      await sync();
      eq([(await thread(R, "ghost@gamma.example")).status, (await thread(R, "nope@gamma.example")).status], ["bounced", "not_interested"]);
      eq((await rows(db, `select reason from public.career_send_bad_addresses where email_hash = public.career_send_email_hash('ghost@gamma.example')`)).length, 1);
      eq((await rows(db, `select reason from public.career_outreach_dnc where email_hash = public.career_send_email_hash('nope@gamma.example')`)).length, 1);
      await store.setPrefs(R, { steps: [1, 1, 1] });
      eq((await runFollowupDrafts({ store, outbox, model, person, now: clock + 30 * DAY, worker: "f1" })).drafted, 0);
      const rpc = { rpc: (n: string, x: any) => admin.rpc(n, x) as any };
      for (const to of ["ghost@gamma.example", "nope@gamma.example"]) {
        const m = { to, subject: "Hello again", text: "Hi" };
        const [r] = await queueApproved(rpc, Q, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m }]);
        assert(r.status === "refused" && ["bad_address", "opted_out"].includes(String(r.reason)), `${to}: another person cannot email it either (${JSON.stringify(r)})`);
      }
    });

    await t.step("Gmail refused (the app is unverified and this account is not a test user): said plainly, nothing worked around", async () => {
      await sentOutreach(BLOCKED, ["casey@delta.example"]);
      google.blocked.add("tok-blocked");
      await sync();
      const [s] = await rows(db, `select last_error from public.career_outreach_sync where user_id = '${BLOCKED}'`);
      assert(/^not_wired/.test(s.last_error), s.last_error);
      const chat = await chatThread(BLOCKED);
      const r = await say(BLOCKED, chat, "what's happened with my outreach");
      assert(r && /100 people/.test(r.reply) && /isn't verified/.test(r.reply), r?.reply);
      eq((await thread(BLOCKED, "casey@delta.example")).turns, 0, "nothing of this mailbox was read");
    });
  } finally {
    await db.stop();
  }
} });
