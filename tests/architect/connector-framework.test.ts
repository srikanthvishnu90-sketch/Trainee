// Task 3 (2026-10-28): one connector framework (_shared/connectors.ts), judged by the database's state on a real Postgres 16
// with every migration (tests/flow/pg.ts), Google and Microsoft faked at the HTTP boundary (outlook-fixture.ts and the
// google fake below). Nothing reaches a provider, no model is called, no email is sent.
//   registry       Gmail and Outlook plug into one shape (id, provider, scopes, link, token, disconnect, status)
//   what's conn.   one plain answer, the same on web, Telegram, iMessage and WhatsApp: each connector, its state, its use,
//                  and what waits on it
//   gmail link     "connect gmail" from Telegram: a one-time link bound to the person, channel and thread (hash only), a
//                  peek that uses nothing, the tap goes to Google once, the callback tells the person on Telegram
//   ask once       a task that needs Outlook asks once with the link; asking again (same or another task) never sends a
//                  second link and never loses a task
//   resume         connecting Outlook (the real callback) resumes every waiting task exactly once, with Outlook's inbox
//                  read through faked Graph; a replayed callback or a second resume runs nothing again
//   mail need      "check my email" asks for Gmail (with Outlook as the alternative); connecting Gmail resumes the mail and
//                  Gmail tasks on Telegram and leaves the Outlook task waiting
//   failure        a resume that fails keeps the task, says so once, and the sweeper finishes it; concurrent resumes run
//                  each task once
//   disconnect     Gmail: revoked at Google, tokens, row, mail rows gone, approved emails cancelled, links burned, said
//                  plainly; Outlook: tokens, row, mail gone, pending sends and approved emails cancelled
// Run: deno test -A --no-check tests/architect/connector-framework.test.ts (needs Postgres 16 binaries).
// deno-lint-ignore-file no-explicit-any
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { admin as adminOf, fakeIdToken, json, microsoft } from "./outlook-fixture.ts";
import {
  afterConnect, CONNECTORS, connectorAsk, connectorChatTurn, handleConnectorLink, resumeDue, say, type TurnResult,
} from "../../supabase/functions/_shared/connectors.ts";
import { handleOutlookOAuth } from "../../supabase/functions/_shared/outlook_connector.ts";
import { SCOPES } from "../../supabase/functions/_shared/outlook_graph.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const T0 = Date.UTC(2026, 9, 28, 15, 0, 0);
const MS_BASE = "https://proj.example.test/functions/v1/outlook-oauth", G_BASE = "https://proj.example.test/functions/v1/gmail-oauth";
const ENV: Record<string, string> = {
  MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client-0000", MICROSOFT_OAUTH_CLIENT_SECRET: "fake-ms-secret-0000", OAUTH_STATE_SECRET: "fake-state-secret-0000-xxxxxxxxxxxxxxxx",
  OUTLOOK_LINK_BASE: MS_BASE, GOOGLE_OAUTH_CLIENT_ID: "fake-google-client-0000", GOOGLE_OAUTH_CLIENT_SECRET: "fake-google-secret-0000", GMAIL_LINK_BASE: G_BASE,
};
const env = { get: (k: string) => ENV[k] };
const q1 = async (pg: Pg, sql: string) => (await pg.sql(sql)).split("\n").at(-1) ?? "";
const n = async (pg: Pg, sql: string) => Number(await q1(pg, sql));
const id = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const thread = (k: number) => `00000000-0000-4000-9000-${String(k).padStart(12, "0")}`;
const linkOf = (reply: string) => /\?t=([A-Za-z0-9_-]{32})/.exec(reply)?.[1] ?? null;
const CODE = /\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/;

// Google, faked: revoke, token refresh and nothing else.
function googleFake() {
  const calls: { url: string; body: string }[] = [];
  let revoke = 200;
  const f = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    if (!/^https:\/\/oauth2\.googleapis\.com\//.test(url)) throw new Error(`a call left the fake Google: ${url}`);
    calls.push({ url, body });
    if (url.endsWith("/revoke")) return new Response("", { status: revoke });
    return json({ error: "not_faked" }, 400);
  }) as typeof fetch;
  return { fetch: f, calls, setRevoke: (s: number) => { revoke = s; } };
}

async function person(pg: Pg, k: number, channel: "web" | "telegram" | "imessage" | "whatsapp") {
  const u = id(k), t = thread(k);
  await pg.sql(`insert into auth.users (id, email) values ('${u}', 'p${k}@example.test') on conflict do nothing; insert into public.profiles (id) values ('${u}') on conflict do nothing;
    insert into public.agent_threads (id, user_id) values ('${t}', '${u}') on conflict do nothing;`);
  const contact = channel === "telegram" ? `tg:${7000 + k}` : channel === "whatsapp" ? `wa:1555000${String(k).padStart(4, "0")}` : channel === "imessage" ? `+1555100${String(k).padStart(4, "0")}` : null;
  if (contact) await pg.sql(`insert into public.channel_contacts (contact, user_id, thread_id) values ('${contact}', '${u}', '${t}') on conflict do nothing;`);
  return { u, t, bridge: channel !== "web" };
}
// A Gmail grant exactly as gmail-oauth's callback writes it.
async function gmailGrant(pg: Pg, u: string, scopes = "openid email https://www.googleapis.com/auth/gmail.readonly") {
  await pg.sql(`select public.oauth_vault_store('oauth_google_career_${u}', '{"access_token":"ya29.FAKEaccess${u.slice(-4)}","refresh_token":"1//FAKErefresh${u.slice(-4)}","expires_at":${T0 + 3600e3}}');
    insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes, connected_at) values ('${u}', 'google_career', 'oauth_google_career_${u}', 'g${u.slice(-4)}@gmail.example', '${scopes}', now())
    on conflict (user_id, provider) do update set scopes = excluded.scopes;`);
}

Deno.test({ name: "Task 3 connector framework on a real Postgres", ignore: !pgBinDir() && !CI, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  const pg = await startPg();
  const ad = adminOf(pg);
  await pg.sql(`grant select, insert, update on public.agent_threads, public.agent_messages to service_role; grant usage, select on all sequences in schema public to service_role;`);
  const deps = (f: typeof fetch, now = T0) => ({ admin: ad, env, fetch: f, now: () => now });
  const replies: string[] = [];
  const turn = async (p: { u: string; t: string; bridge: boolean }, message: string, f: typeof fetch = microsoft().fetch, x: Record<string, unknown> = {}) => {
    const r = await connectorChatTurn({ ...deps(f), message, userId: p.u, threadId: p.t, bridge: p.bridge, ...x });
    if (r) replies.push(r.reply);
    return r;
  };
  try {
    await t.step("registry: Gmail and Outlook plug into one shape", () => {
      eq(Object.keys(CONNECTORS), ["gmail", "outlook"], "two connectors");
      for (const c of Object.values(CONNECTORS)) {
        for (const k of ["id", "label", "provider", "connectAsk", "disconnectAsk", "scopes", "uses", "wired", "issueLink", "token", "needsReconnect", "disconnect"]) assert(k in c, `${c.id}.${k}`);
        assert(c.wired(env), `${c.id} is wired with the fake env`);
        eq(c.wired({ get: () => undefined }), false, `${c.id} is not wired without its client`);
      }
      eq([CONNECTORS.gmail.provider, CONNECTORS.outlook.provider], ["google_career", "microsoft"], "the providers user_oauth_connections keeps");
      eq(CONNECTORS.gmail.uses(["https://www.googleapis.com/auth/gmail.readonly"]).length, 1, "read only: one use");
      eq(CONNECTORS.outlook.uses(["Mail.Read", "Mail.Send", "Calendars.ReadWrite"]).length, 3, "Outlook's three uses");
      for (const m of ["what's connected", "What's connected?", "what accounts are connected", "what do you have access to", "show my connections", "what have I connected"]) eq(connectorAsk(m)?.kind, "whats_connected", m);
      for (const m of ["what's next", "what is my status", "connect me with Maya"]) eq(connectorAsk(m), null, m);
      eq(connectorAsk("check my outlook"), { kind: "check", need: "outlook" }, "outlook need");
      eq(connectorAsk("can you check my email for replies"), { kind: "check", need: "mail" }, "mail need");
      eq(connectorAsk("connect gmail"), { kind: "connect", id: "gmail" }, "gmail connect");
      eq(connectorAsk("disconnect outlook"), { kind: "disconnect", id: "outlook" }, "outlook disconnect");
    });

    await t.step("what's connected: one plain answer, the same on web, Telegram, iMessage and WhatsApp", async () => {
      const chans = ["web", "telegram", "imessage", "whatsapp"] as const;
      const seen: string[] = [];
      for (const [i, ch] of chans.entries()) {
        const p = await person(pg, 100 + i, ch);
        await gmailGrant(pg, p.u, "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
        await pg.sql(`select public.oauth_vault_store('oauth_microsoft_${p.u}', '{"access_token":"EwBFAKEaccessTOKENvalue0000000000","refresh_token":"M.FAKE"}');
          insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${p.u}', 'microsoft', 'oauth_microsoft_${p.u}', 'w@contoso.example', 'Mail.Read Mail.Send');
          insert into public.career_outlook_state (user_id, needs_reconnect_at, needs_reconnect_reason) values ('${p.u}', now(), 'invalid_grant');
          select public.career_parked_park('${p.u}', 'outlook', 'check my outlook', '${p.t}', '${ch}', now());`);
        const r = await turn(p, "what's connected?");
        assert(r, `${ch}: answered`);
        eq([r.intent, r.resultStatus], ["career_connectors_status", "shown"], `${ch}: the status turn`);
        const lines = r.reply.split("\n");
        assert(lines.some((l) => l.startsWith(`Gmail: connected (g${p.u.slice(-4)}@gmail.example). I use it to read employers' replies`) && /send emails you approve word for word/.test(l)), `${ch}: Gmail and its uses: ${r.reply}`);
        assert(lines.some((l) => l.startsWith("Outlook: needs reconnecting.") && /Text "connect my outlook"/.test(l)), `${ch}: Outlook needs reconnecting: ${r.reply}`);
        assert(lines.some((l) => l === "Waiting for Outlook: I'll check your Outlook as soon as you connect it."), `${ch}: what waits: ${r.reply}`);
        assert(!CODE.test(r.reply) && !/ya29|1\/\/|EwB/.test(r.reply), `${ch}: no code, no token: ${r.reply}`);
        seen.push(r.reply.replace(/g\d{4}@gmail\.example/, "<gmail>"));
      }
      eq(new Set(seen).size, 1, "the same answer on every channel");
      // Nothing connected at all: each connector said, with how to connect it.
      const p = await person(pg, 110, "telegram");
      const r = await turn(p, "what's connected");
      eq(r!.reply, ["Here's what's connected to Trainee:", 'Gmail: not connected. Text "connect gmail" to connect it.', 'Outlook: not connected. Text "connect my outlook" to connect it.'].join("\n"), "nothing connected");
    });

    await t.step("Gmail link from Telegram: bound to the person and thread, peek uses nothing, the tap goes to Google once, the callback tells them on Telegram", async () => {
      const p = await person(pg, 200, "telegram");
      const r = await turn(p, "connect my gmail");
      eq([r!.intent, r!.resultStatus], ["career_gmail_connect", "link"], "a link");
      const tok = linkOf(r!.reply)!;
      assert(tok && r!.reply.includes(`${G_BASE}?t=${tok}`), r!.reply);
      assert(/Google's sign-in may not work inside Telegram's own browser/.test(r!.reply), "Telegram's in-app browser note names Google");
      eq((r!.meta as any)?.link_button?.text, "Connect Gmail", "Telegram button");
      eq(await q1(pg, `select count(*) || ':' || bool_and(user_id = '${p.u}') || ':' || bool_and(channel = 'telegram') || ':' || bool_and(thread_id = '${p.t}') || ':' || bool_and(nonce_hash = encode(sha256(convert_to('${tok}', 'UTF8')), 'hex')) from public.career_connector_links where user_id = '${p.u}'`), "1:true:true:true:true", "one row, hash only, bound");
      const consented: string[] = [];
      const ld = { admin: ad, env, now: () => T0, consentUrl: async (u: string) => { consented.push(u); return `https://accounts.google.com/o/oauth2/v2/auth?state=fake-for-${u}`; } };
      const peek = await handleConnectorLink(new Request(`${G_BASE}?t=${tok}`), ld);
      eq(peek!.status, 200, "peek page");
      const html = await peek!.text();
      assert(html.includes("p•••@example.test") && html.includes("Continue to Google") && html.includes("disconnect gmail"), "the page says whose account, what is read and how to undo");
      eq(await q1(pg, `select opened_at is null from public.career_connector_links where user_id = '${p.u}'`), "t", "a peek does not open the link");
      const tap = await handleConnectorLink(new Request(G_BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: tok }) }), ld);
      eq(tap!.status, 303, "the tap goes to Google");
      eq(consented, [p.u], "the consent is signed for the link's own person");
      const again = await handleConnectorLink(new Request(G_BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: tok }) }), ld);
      eq(again!.status, 400, "the link works once");
      eq(await handleConnectorLink(new Request(G_BASE, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), ld), null, "gmail-oauth's JSON actions are not link requests");
      // gmail-oauth's verified callback stores the grant, then calls afterConnect.
      await gmailGrant(pg, p.u);
      const ran: string[] = [];
      await afterConnect({ ...deps(googleFake().fetch, T0 + 60e3), runTurn: async (x) => { ran.push(x.message); return { reply: "x" }; } }, p.u, "gmail", { email: "p200@gmail.example", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
      eq(await q1(pg, `select outcome from public.career_connector_links where user_id = '${p.u}'`), "connected", "the link finished connected");
      const told = await q1(pg, `select channel || '|' || text from public.career_outbox where user_id = '${p.u}' and key like 'status:connect:%'`);
      assert(told.startsWith("telegram|Gmail connected: p200@gmail.example. You allowed me to read employers' replies"), `told on Telegram: ${told}`);
      eq(ran, [], "nothing was waiting, nothing ran");
      const already = await turn(p, "connect gmail");
      eq(already!.resultStatus, "already", "connected already");
    });

    await t.step("ask once, then resume: Outlook connected through the real callback resumes each waiting task exactly once", async () => {
      const p = await person(pg, 300, "web");
      const ms = microsoft();
      const first = await turn(p, "check my outlook", ms.fetch);
      eq([first!.intent, first!.resultStatus], ["career_connector_need", "asked"], "asked");
      assert(linkOf(first!.reply) && /As soon as you connect, I'll check your Outlook and tell you here; you don't need to ask again\./.test(first!.reply), first!.reply);
      const second = await turn(p, "check my outlook now", ms.fetch);
      eq(second!.resultStatus, "waiting", "the second task waits, no new ask");
      eq(linkOf(second!.reply), null, "no second link");
      assert(/along with what you asked before/.test(second!.reply), second!.reply);
      const same = await turn(p, "Check my Outlook", ms.fetch);
      eq([same!.resultStatus, linkOf(same!.reply)], ["waiting", null], "the same ask again: still one ask");
      eq(await n(pg, `select count(*) from public.career_outlook_links where user_id = '${p.u}'`), 1, "one link was ever issued");
      eq(await n(pg, `select count(*) from public.career_parked_tasks where user_id = '${p.u}' and status = 'waiting'`), 2, "two tasks kept (the repeat is the same task)");
      // The person taps the link; Microsoft is faked; the real callback runs with the framework's afterConnect.
      ms.on((c) => c.url.endsWith("/oauth2/v2.0/token") ? json({ access_token: "EwBFAKEaccessTOKEN300xxxxxxxxxxxxxx", refresh_token: "M.FAKErefresh300", expires_in: 3600, scope: SCOPES.slice(3).join(" "), id_token: fakeIdToken("p300@contoso.example") }) : null);
      ms.on((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta") ? json({ value: [
        { id: "m1", conversationId: "c1", subject: "Re: coffee", bodyPreview: "Sure, Tuesday works", receivedDateTime: "2026-10-28T14:00:00Z", from: { emailAddress: { address: "maya@acme.example", name: "Maya" } } },
        { id: "m2", conversationId: "c2", subject: "Your application", bodyPreview: "Thanks for applying", receivedDateTime: "2026-10-28T14:05:00Z", from: { emailAddress: { address: "jobs@globex.example", name: "Globex" } } },
      ], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake1" }) : null);
      const runs: { message: string; turnKey: string }[] = [];
      const runTurn = async (x: { userId: string; threadId: string | null; message: string; turnKey: string }): Promise<TurnResult> => {
        runs.push({ message: x.message, turnKey: x.turnKey });
        const r = await connectorChatTurn({ ...deps(ms.fetch, T0 + 2000), message: x.message, userId: x.userId, threadId: x.threadId ?? p.t, bridge: false });
        return { reply: r?.reply ?? "", persisted: false };
      };
      const od = { admin: ad, env, fetch: ms.fetch, now: () => T0 + 1000, afterConnect: (a: any) => afterConnect({ ...deps(ms.fetch, T0 + 2000), runTurn }, a.userId, "outlook", a) };
      const token = linkOf(first!.reply)!;
      const post = await handleOutlookOAuth(new Request(MS_BASE, { method: "POST", body: new URLSearchParams({ t: token }) }), od);
      const state = new URL(post.headers.get("location")!).searchParams.get("state")!;
      const cb = await handleOutlookOAuth(new Request(`${MS_BASE}?code=fake-code-300&state=${encodeURIComponent(state)}`), od);
      eq(cb.status, 200, "connected");
      eq(runs.map((r) => r.message).sort(), ["check my outlook", "check my outlook now"], "each waiting task ran once, as the person asked it");
      assert(runs.every((r) => /^resume:[0-9a-f-]{36}$/.test(r.turnKey)), "a stable turn key per task");
      eq(await q1(pg, `select string_agg(status || ':' || attempts, ',' order by created_at) from public.career_parked_tasks where user_id = '${p.u}'`), "resumed:1,resumed:1", "both resumed, once each");
      eq(await n(pg, `select count(*) from public.career_outlook_messages where user_id = '${p.u}'`), 2, "the resumed task really read the inbox (faked Graph)");
      const msgs = (await pg.sql(`select content from public.agent_messages where thread_id = '${p.t}' order by id`)).split("\n");
      assert(msgs.some((m) => m.startsWith("Outlook connected: p300@contoso.example.")), "told it connected, in the web thread");
      eq(msgs.filter((m) => m.startsWith("I read your Outlook:")).length, 2, `each task's answer in the thread: ${msgs.join(" / ")}`);
      // A replayed callback, or the resume called again, runs nothing twice.
      const replay = await handleOutlookOAuth(new Request(`${MS_BASE}?code=fake-code-300b&state=${encodeURIComponent(state)}`), od);
      eq(replay.status, 400, "the callback works once");
      const again = await afterConnect({ ...deps(ms.fetch, T0 + 9000), runTurn }, p.u, "outlook");
      eq([again.resumed, runs.length], [0, 2], "nothing to resume again");
      const after = await turn(p, "what's connected", ms.fetch);
      assert(/^Outlook: connected \(p300@contoso\.example\)/m.test(after!.reply) && !/Waiting for/.test(after!.reply), after!.reply);
      assert(replies.every((x) => say(x) === x), "every reply so far is plain words");
    });

    await t.step("the mail need: one Gmail ask (Outlook as the alternative) covers later mail asks; connecting Gmail resumes them on Telegram", async () => {
      const p = await person(pg, 400, "telegram");
      const a = await turn(p, "can you check my email for replies");
      eq(a!.resultStatus, "asked", "asked once");
      assert(a!.reply.includes(`${G_BASE}?t=`) && /Use Outlook instead\? Text "connect my outlook"\./.test(a!.reply), a!.reply);
      const b = await turn(p, "check my gmail");
      eq([b!.resultStatus, linkOf(b!.reply)], ["waiting", null], "a Gmail ask while a mail ask waits: no second link");
      const c = await turn(p, "check my outlook");
      eq([c!.resultStatus, linkOf(c!.reply)], ["waiting", null], "an Outlook ask while a mail ask waits: kept, not asked");
      eq(await n(pg, `select count(*) from public.career_connector_links where user_id = '${p.u}'`), 1, "one Gmail link");
      eq(await n(pg, `select count(*) from public.career_outlook_links where user_id = '${p.u}'`), 0, "no Outlook link");
      await gmailGrant(pg, p.u);
      const ran: string[] = [];
      const r = await afterConnect({ ...deps(googleFake().fetch, T0 + 5000), runTurn: async (x) => { ran.push(x.message); return { reply: `Done: ${x.message}.`, persisted: true }; } }, p.u, "gmail", { email: "p400@gmail.example", scopes: [] });
      eq([r.resumed, ran.sort()], [2, ["can you check my email for replies", "check my gmail"]], "the mail and Gmail tasks resumed");
      eq(await q1(pg, `select string_agg(need || ':' || status, ',' order by need) from public.career_parked_tasks where user_id = '${p.u}'`), "gmail:resumed,mail:resumed,outlook:waiting", "the Outlook task still waits");
      eq(await n(pg, `select count(*) from public.career_outbox where user_id = '${p.u}' and key like 'status:resume:%' and channel = 'telegram'`), 2, "each answer queued for Telegram (a channel turn's reply is delivered by the outbox)");
    });

    await t.step("a resume that fails keeps the task and says so once; the sweeper finishes it; concurrent resumes run each task once", async () => {
      const p = await person(pg, 500, "web");
      await turn(p, "check my gmail");
      await gmailGrant(pg, p.u);
      const boom = await afterConnect({ ...deps(googleFake().fetch, T0), runTurn: async () => { throw new Error("agent-chat HTTP 503"); } }, p.u, "gmail");
      eq([boom.resumed, boom.kept], [0, 1], "kept");
      eq(await q1(pg, `select status || ':' || attempts from public.career_parked_tasks where user_id = '${p.u}'`), "waiting:1", "still waiting, one attempt");
      assert((await q1(pg, `select content from public.agent_messages where thread_id = '${p.t}' order by id desc limit 1`)).startsWith("I couldn't check your Gmail just now. I kept it"), "said once, plainly");
      const ran: string[] = [];
      const ok = async (x: any) => { ran.push(x.userId); await new Promise((r) => setTimeout(r, 20)); return { reply: "ok", persisted: true }; };
      // Ten more people wait on Gmail and are connected; three sweepers and a callback race.
      const many: string[] = [];
      for (let i = 0; i < 10; i++) {
        const q = await person(pg, 510 + i, "web");
        await pg.sql(`select public.career_parked_park('${q.u}', 'gmail', 'check my gmail', '${q.t}', 'web', now());`);
        await gmailGrant(pg, q.u);
        many.push(q.u);
      }
      const d = { ...deps(googleFake().fetch, T0 + 60e3), runTurn: ok };
      await Promise.all([resumeDue(d, 4), resumeDue(d, 4), resumeDue(d, 4), afterConnect(d, many[0], "gmail"), resumeDue(d, 4)]);
      await resumeDue(d, 50);
      eq(ran.length, 11, "eleven tasks, eleven runs");
      eq(new Set(ran).size, 11, "each person's task ran once");
      eq(await n(pg, `select count(*) from public.career_parked_tasks where user_id in ('${[p.u, ...many].join("','")}') and status <> 'resumed'`), 0, "all resumed");
      eq((await resumeDue(d, 50)).resumed, 0, "nothing left");
      eq(await n(pg, `select count(*) from public.career_parked_tasks where user_id in ('${[100, 101, 102, 103].map(id).join("','")}') and status = 'waiting'`), 4,
        "an Outlook that needs reconnecting is not connected: those tasks still wait");
    });

    await t.step("disconnect gmail: revoked at Google, tokens, row and mail gone, approved emails cancelled, links burned, said plainly", async () => {
      const p = await person(pg, 600, "whatsapp");
      await gmailGrant(pg, p.u);
      await pg.sql(`insert into public.career_mail_events (user_id, application_ref, kind, company, stage, evidence, message_hash, mail_at) values ('${p.u}', 'mail:acme', 'received', 'Acme', 'Submitted', 'Acme: received', repeat('6', 64), now());
        insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at) values
          ('${p.u}', gen_random_uuid(), 1, '{"name":"Maya"}', 'maya@acme.example', 'Hello', 'Hi Maya', 'Sent by me', repeat('a', 64), 'approved', repeat('a', 64), now()),
          ('${p.u}', gen_random_uuid(), 1, '{"name":"Ben"}', 'ben@acme.example', 'Hello', 'Hi Ben', 'Sent by me', repeat('b', 64), 'shown', null, null);
        select public.career_connector_link_issue('${p.u}', 'gmail', 'whatsapp', '${p.t}', now());`);
      const g = googleFake();
      const r = await turn(p, "disconnect gmail", g.fetch);
      eq([r!.intent, r!.resultStatus], ["career_google_disconnect", "completed"], "done");
      eq(g.calls.map((c) => c.body), [`token=${encodeURIComponent(`1//FAKErefresh${p.u.slice(-4)}`)}`], "revoked at Google with the refresh token, once");
      eq(await q1(pg, `select (select count(*) from public.user_oauth_connections where user_id = '${p.u}') || ':' || (select count(*) from vault.secrets where name = 'oauth_google_career_${p.u}') || ':' || (select count(*) from public.career_mail_events where user_id = '${p.u}')`), "0:0:0", "row, tokens and mail rows gone");
      eq(await q1(pg, `select string_agg(status || ':' || coalesce(result, '-'), ',' order by recipient_email) from public.career_outreach_drafts where user_id = '${p.u}'`), "shown:-,skipped:cancelled: Gmail disconnected", "the approved email was cancelled; the unapproved one untouched");
      eq(await q1(pg, `select bool_and(finished_at is not null) from public.career_connector_links where user_id = '${p.u}'`), "t", "the live link was burned");
      assert(/^Gmail is disconnected\. Google confirmed Trainee's access is revoked\./.test(r!.reply) && /I also cancelled 1 approved email that hadn't gone yet; approve it again if you still want it sent\./.test(r!.reply), r!.reply);
      g.setRevoke(503);
      const none = await turn(p, "disconnect gmail", g.fetch);
      eq(none!.resultStatus, "nothing", "nothing left to disconnect");
      assert(!CODE.test(r!.reply + none!.reply), "no codes");
    });

    await t.step("disconnect outlook: tokens, row and mail gone, pending sends and approved emails cancelled, told where to remove the app", async () => {
      const p = await person(pg, 700, "imessage");
      await pg.sql(`select public.oauth_vault_store('oauth_microsoft_${p.u}', '{"access_token":"EwBFAKE700xxxxxxxxxxxxxxxxxxxxxx","refresh_token":"M.FAKE700"}');
        insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${p.u}', 'microsoft', 'oauth_microsoft_${p.u}', 'p700@contoso.example', 'Mail.Read Mail.Send');
        insert into public.career_outlook_state (user_id) values ('${p.u}');
        insert into public.career_outlook_messages (user_id, message_hash, from_address, subject, received_at) values ('${p.u}', repeat('7', 64), 'maya@acme.example', 'Re: hi', now());
        insert into public.career_outlook_sends (user_id, idem_key, payload_hash, purpose, recipient_hash, status, created_at, updated_at) values ('${p.u}', 'outreach:pending-700', repeat('c', 64), 'outreach', repeat('d', 64), 'rate_limited', now(), now());
        insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at) values
          ('${p.u}', gen_random_uuid(), 1, '{"name":"Maya"}', 'maya@acme.example', 'Hello', 'Hi Maya', 'Sent by me', repeat('e', 64), 'approved', repeat('e', 64), now());`);
      const r = await turn(p, "disconnect outlook");
      eq([r!.intent, r!.resultStatus], ["career_outlook_disconnect", "completed"], "done");
      eq(await q1(pg, `select (select count(*) from public.user_oauth_connections where user_id = '${p.u}') || ':' || (select count(*) from vault.secrets where name = 'oauth_microsoft_${p.u}') || ':' || (select count(*) from public.career_outlook_messages where user_id = '${p.u}') || ':' || (select status from public.career_outlook_sends where user_id = '${p.u}') || ':' || (select status from public.career_outreach_drafts where user_id = '${p.u}')`), "0:0:0:cancelled:skipped", "row, tokens, mail gone; the pending send and the approved email cancelled");
      assert(/^Outlook is disconnected\./.test(r!.reply) && /account\.live\.com\/consent\/Manage/.test(r!.reply) && /I also cancelled 1 approved email/.test(r!.reply), r!.reply);
    });
  } finally { await pg.stop(); }
});
