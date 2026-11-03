// M4 (2026-10-27): Outlook (Microsoft Graph) as a peer of Gmail, judged by the database's state on a real Postgres 16 with
// every migration (tests/flow/pg.ts), Microsoft faked at the HTTP boundary (tests/architect/outlook-fixture.ts). Nothing
// reaches Microsoft, no model is called, no real email is sent.
//   connect      the chat link bound to the person (hash only), GET peeks, POST goes to Microsoft with PKCE S256 and the
//                exact scopes, the callback stores tokens in the person's Vault entry and the connection row; a replayed,
//                forged or other person's state never connects anyone
//   tokens       an expired token is refreshed and the new refresh token replaces the old; invalid_grant or a 401 marks
//                needs_reconnect and the person reads it plainly
//   send         exactly once per key; header injection, a second address, a changed payload refused; a 429's Retry-After
//                waited out, or recorded and resumed; an unknown outcome never retried
//   disconnect   tokens, row, Outlook mail and state gone, pending sends cancelled, live links burned
//   inbox/cal    delta pages and the delta link kept; free/busy from calendarView; event create with or without Teams
//   scale        leased batches: concurrent workers claim each person exactly once; an expired lease is taken over
//   rail         one send rail dispatching by the connected provider; an unapproved text is never sent
// Run: deno test -A --no-check tests/architect/m4-outlook-connector.test.ts (needs Postgres 16 binaries).
// deno-lint-ignore-file no-explicit-any
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { admin as adminOf, fakeIdToken, json, microsoft } from "./outlook-fixture.ts";
import {
  disconnectOutlook, handleOutlookOAuth, outlookAsk, outlookChatTurn, outlookFor, RECONNECT_REPLY, runOutlookBatch,
} from "../../supabase/functions/_shared/outlook_connector.ts";
import { eventHashOf, issueState, pkceChallenge, SCOPES } from "../../supabase/functions/_shared/outlook_graph.ts";
import { approvalHashOf, mailRail, outlookProvider, outreachSenderOf, sendProviders } from "../../supabase/functions/_shared/mail_providers.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2";
const T0 = Date.UTC(2026, 9, 28, 1, 0, 0);
const BASE = "https://proj.example.test/functions/v1/outlook-oauth";
const ENV: Record<string, string> = {
  MICROSOFT_OAUTH_CLIENT_ID: "fake-client-id-0000", MICROSOFT_OAUTH_CLIENT_SECRET: "fake-client-secret-0000",
  OAUTH_STATE_SECRET: "fake-state-secret-0000-xxxxxxxxxxxxxxxx", OUTLOOK_LINK_BASE: BASE, OUTLOOK_JOBS_SECRET: "fake-jobs-secret-0000",
};
const env = { get: (k: string) => ENV[k] };
const q1 = async (pg: Pg, sql: string) => (await pg.sql(sql)).split("\n").at(-1) ?? "";

async function seed(pg: Pg) {
  // Supabase parity (setup): the platform grants the service role the chat tables the stubs create before default grants.
  await pg.sql(`grant select, insert, update on public.agent_threads, public.agent_messages to service_role; grant usage, select on all sequences in schema public to service_role;`);
  await pg.sql(`insert into auth.users (id, email) values ('${A}', 'ana@example.test'), ('${B}', 'ben@example.test') on conflict do nothing;
    insert into public.agent_threads (id, user_id) values ('${A.replace("a1", "f1")}', '${A}'), ('${B.replace("b2", "f2")}', '${B}') on conflict do nothing;`);
}
const threadOf = (u: string) => (u === A ? A.replace("a1", "f1") : B.replace("b2", "f2"));

// A full connect for person u, through the chat link and the callback, with Microsoft faked. Returns the fake.
async function connect(pg: Pg, ad: any, ms: ReturnType<typeof microsoft>, u: string, email: string, now = T0) {
  const turn = await outlookChatTurn({ admin: ad, message: "connect my outlook", userId: u, threadId: threadOf(u), bridge: false, now, env });
  assert(turn?.resultStatus === "link", `a link: ${JSON.stringify(turn)}`);
  const token = /\?t=([A-Za-z0-9_-]{32})/.exec(turn!.reply)![1];
  const post = await handleOutlookOAuth(new Request(BASE, { method: "POST", body: new URLSearchParams({ t: token }) }), { admin: ad, env, fetch: ms.fetch, now: () => now });
  const loc = new URL(post.headers.get("location")!);
  ms.on((c) => c.url.endsWith("/oauth2/v2.0/token") && new URLSearchParams(c.body).get("grant_type") === "authorization_code"
    ? json({ access_token: `fake-at-${u}`, refresh_token: `fake-rt-${u}`, expires_in: 3600, scope: SCOPES.slice(3).join(" "), id_token: fakeIdToken(email) }) : null);
  const cb = await handleOutlookOAuth(new Request(`${BASE}?code=fake-code-${u}&state=${encodeURIComponent(loc.searchParams.get("state")!)}`), { admin: ad, env, fetch: ms.fetch, now: () => now + 1000 });
  assert(cb.status === 200, `callback ${cb.status}`);
  return { turn, token, loc, post };
}

Deno.test({ name: "M4 Outlook connector on a real Postgres", ignore: !pgBinDir() && !CI, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  const pg = await startPg();
  const ad = adminOf(pg);
  try {
    await seed(pg);

    await t.step("the chat recognizes the messy ways people ask, and nothing else", () => {
      for (const m of ["connect my outlook", "Connect Outlook", "use my work email", "can you connect my hotmail account", "link my office 365 email", "connect my microsoft account", "use my school email instead"]) eq(outlookAsk(m), "connect", m);
      for (const m of ["disconnect outlook", "remove my outlook account", "revoke my microsoft email"]) eq(outlookAsk(m), "disconnect", m);
      eq(outlookAsk("is my outlook connected?"), "status", "status");
      for (const m of ["connect gmail", "email Maya at Acme", "what's my work email", "my outlook is full of rejections"]) eq(outlookAsk(m), null, m);
    });

    await t.step("connect: a link bound to the person (hash only), a peek that uses nothing, PKCE and the exact scopes, tokens only in the Vault", async () => {
      const ms = microsoft();
      const turn = await outlookChatTurn({ admin: ad, message: "use my work email", userId: A, threadId: threadOf(A), bridge: false, now: T0, env });
      const token = /\?t=([A-Za-z0-9_-]{32})/.exec(turn!.reply)![1];
      eq(await q1(pg, `select count(*) || ':' || bool_and(user_id = '${A}') || ':' || bool_and(nonce_hash = encode(sha256(convert_to('${token}', 'UTF8')), 'hex')) || ':' || bool_and(thread_id = '${threadOf(A)}') from public.career_outlook_links`), "1:true:true:true", "one link row, A's, hash only, A's thread");
      eq(await q1(pg, `select count(*) from public.career_outlook_links where nonce_hash = '${token}'`), "0", "the token itself is never stored");
      // A message preview fetches the link: it peeks, it never uses it.
      const peek = await handleOutlookOAuth(new Request(`${BASE}?t=${token}`), { admin: ad, env, fetch: ms.fetch, now: () => T0 });
      eq(peek.status, 200, "peek page");
      assert((await peek.text()).includes("a•••@example.test"), "the peek names whose account, masked");
      eq(await q1(pg, `select opened_at is null from public.career_outlook_links`), "t", "a peek does not open the link");
      const post = await handleOutlookOAuth(new Request(BASE, { method: "POST", body: new URLSearchParams({ t: token }) }), { admin: ad, env, fetch: ms.fetch, now: () => T0 });
      eq(post.status, 303, "the tap goes to Microsoft");
      const loc = new URL(post.headers.get("location")!);
      eq(`${loc.origin}${loc.pathname}`, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "the common authorize endpoint (work, school and personal accounts)");
      eq(loc.searchParams.get("scope"), "openid email profile offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite", "exactly these scopes");
      eq(loc.searchParams.get("code_challenge_method"), "S256", "PKCE S256");
      eq(loc.searchParams.get("redirect_uri"), BASE, "redirect URI is the function");
      const again = await handleOutlookOAuth(new Request(BASE, { method: "POST", body: new URLSearchParams({ t: token }) }), { admin: ad, env, fetch: ms.fetch, now: () => T0 });
      eq(again.status, 400, "the link works once");
      let verifier = "";
      ms.on((c) => {
        if (!c.url.endsWith("/oauth2/v2.0/token")) return null;
        const p = new URLSearchParams(c.body);
        verifier = p.get("code_verifier") ?? "";
        eq(p.get("grant_type"), "authorization_code", "code grant");
        eq(p.get("redirect_uri"), BASE, "same redirect");
        return json({ access_token: "fake-at-A1", refresh_token: "fake-rt-A1", expires_in: 3600, scope: SCOPES.slice(3).join(" "), id_token: fakeIdToken("ana@contoso.example") });
      });
      const cb = await handleOutlookOAuth(new Request(`${BASE}?code=fake-code&state=${encodeURIComponent(loc.searchParams.get("state")!)}`), { admin: ad, env, fetch: ms.fetch, now: () => T0 + 5000 });
      eq(cb.status, 200, "connected page");
      eq(await pkceChallenge(verifier), loc.searchParams.get("code_challenge"), "the verifier sent matches the challenge");
      eq(await q1(pg, `select provider || '|' || vault_name || '|' || email from public.user_oauth_connections where user_id = '${A}'`), `microsoft|oauth_microsoft_${A}|ana@contoso.example`, "A's connection row");
      const vault = JSON.parse(await q1(pg, `select secret from vault.secrets where name = 'oauth_microsoft_${A}'`));
      eq([vault.access_token, vault.refresh_token], ["fake-at-A1", "fake-rt-A1"], "tokens in A's Vault entry");
      eq(await q1(pg, `select count(*) from public.user_oauth_connections where user_id = '${B}'`), "0", "nothing for B");
      eq(await q1(pg, `select outcome from public.career_outlook_links`), "connected", "the link finished connected");
      assert((await q1(pg, `select content from public.agent_messages where thread_id = '${threadOf(A)}' order by id desc limit 1`)).startsWith("Outlook connected: ana@contoso.example."), "told in A's web thread");
      // A replay of the same callback connects nothing again.
      const replay = await handleOutlookOAuth(new Request(`${BASE}?code=fake-code-2&state=${encodeURIComponent(loc.searchParams.get("state")!)}`), { admin: ad, env, fetch: ms.fetch, now: () => T0 + 6000 });
      eq(replay.status, 400, "a replayed callback is refused");
    });

    await t.step("another person's link: a state can only ever connect the person its link was made for; forged and unopened states connect no one", async () => {
      const ms = microsoft();
      ms.on((c) => c.url.endsWith("/token") ? json({ access_token: "fake-at-X", refresh_token: "fake-rt-X", expires_in: 3600, scope: "Mail.Send", id_token: fakeIdToken("x@evil.example") }) : null);
      // B's link, issued but never opened: a state signed for it is refused (the open is the person's own tap).
      const tokB = String((await pg.asService().rpc("career_outlook_link_issue", { p_user: B, p_channel: "web", p_thread: threadOf(B), p_purpose: "connect", p_now: new Date(T0).toISOString() })).data);
      const linkB = await q1(pg, `select id from public.career_outlook_links where user_id = '${B}'`);
      const unopened = await handleOutlookOAuth(new Request(`${BASE}?code=c&state=${encodeURIComponent(await issueState(linkB, ENV.OAUTH_STATE_SECRET, T0))}`), { admin: ad, env, fetch: ms.fetch, now: () => T0 });
      eq(unopened.status, 400, "an unopened link's state is refused");
      // A state forged with another secret for B's link, or naming A's link from a different signer: refused.
      const forged = await handleOutlookOAuth(new Request(`${BASE}?code=c&state=${encodeURIComponent(await issueState(linkB, "attacker-secret-fake", T0))}`), { admin: ad, env, fetch: ms.fetch, now: () => T0 });
      eq(forged.status, 400, "a forged state is refused");
      // B opens the link (their own tap): a state forged with another secret for that opened link is still refused, and the
      // link stays usable for B's real callback only.
      await pg.asService().rpc("career_outlook_link_open", { p_nonce: tokB, p_now: new Date(T0).toISOString() });
      const forgedOpen = await handleOutlookOAuth(new Request(`${BASE}?code=c&state=${encodeURIComponent(await issueState(linkB, "attacker-secret-fake", T0))}`), { admin: ad, env, fetch: ms.fetch, now: () => T0 });
      eq(forgedOpen.status, 400, "a forged state for an opened link is refused");
      eq(await q1(pg, `select finished_at is null from public.career_outlook_links where id = '${linkB}'`), "t", "the forged callback did not use B's link");
      // A thread that is not B's is never put on B's link.
      await pg.asService().rpc("career_outlook_link_issue", { p_user: B, p_channel: "web", p_thread: threadOf(A), p_purpose: "connect", p_now: new Date(T0).toISOString() });
      eq(await q1(pg, `select count(*) from public.career_outlook_links where user_id = '${B}' and thread_id = '${threadOf(A)}'`), "0", "another person's thread is dropped from the link");
      eq(await q1(pg, `select count(*) from public.user_oauth_connections where user_id = '${B}'`), "0", "B is not connected");
      eq(ms.calls.length, 0, "Microsoft was never asked for a token");
      void tokB;
    });

    await t.step("an expired access token is refreshed and the new refresh token replaces the old", async () => {
      const ms = microsoft();
      await pg.sql(`update vault.secrets set secret = jsonb_set(secret::jsonb, '{expires_at}', '0')::text where name = 'oauth_microsoft_${A}'`);
      let refreshBody: URLSearchParams | null = null;
      ms.on((c) => {
        if (!c.url.endsWith("/token")) return null;
        refreshBody = new URLSearchParams(c.body);
        return json({ access_token: "fake-at-A2", refresh_token: "fake-rt-A2", expires_in: 3600 });
      });
      let sentWith = "";
      ms.on((c) => c.url.endsWith("/me/sendMail") ? (sentWith = c.headers.authorization, new Response(null, { status: 202 })) : null);
      const rails = outlookFor(ad, env, ms.fetch, { now: () => T0 + 60_000 });
      const r = await rails.sendMail(A, { to: "maya@acme.example", subject: "Hello from Ana", text: "Hi Maya, ..." }, { idemKey: "outreach:refresh-1", purpose: "outreach" });
      eq(r.status, "sent", "sent after the refresh");
      eq([refreshBody!.get("grant_type"), refreshBody!.get("refresh_token")], ["refresh_token", "fake-rt-A1"], "refreshed with the stored refresh token");
      eq(sentWith, "Bearer fake-at-A2", "the new access token sent it");
      const vault = JSON.parse(await q1(pg, `select secret from vault.secrets where name = 'oauth_microsoft_${A}'`));
      eq([vault.access_token, vault.refresh_token], ["fake-at-A2", "fake-rt-A2"], "the rotated tokens are stored");
      assert(Date.parse(await q1(pg, `select token_expires_at from public.career_outlook_state where user_id = '${A}'`)) > T0 + 60_000, "the new expiry is recorded for the refresh batch");
    });

    await t.step("send exactly once: the same key never sends twice; injection, two addresses and a changed text are refused before Microsoft", async () => {
      const ms = microsoft();
      const bodies: any[] = [];
      ms.on((c) => c.url.endsWith("/me/sendMail") ? (bodies.push(JSON.parse(c.body)), new Response(null, { status: 202 })) : null);
      const rails = outlookFor(ad, env, ms.fetch, { now: () => T0 + 120_000 });
      const m = { to: "lee@globex.example", subject: "Data analyst role", text: "Hi Lee, I saw the opening..." };
      eq((await rails.sendMail(A, m, { idemKey: "apply:job-42", purpose: "application" })).status, "sent", "first send");
      eq((await rails.sendMail(A, m, { idemKey: "apply:job-42", purpose: "application" })).status, "already_sent", "second call with the same key");
      eq(bodies.length, 1, "Microsoft got exactly one sendMail");
      const msg = bodies[0].message;
      eq(Object.keys(msg).sort(), ["body", "internetMessageHeaders", "subject", "toRecipients"], "no cc, bcc, replyTo or from");
      eq(msg.toRecipients, [{ emailAddress: { address: "lee@globex.example" } }], "one recipient");
      eq(msg.internetMessageHeaders.map((h: any) => h.name), ["x-trainee-send"], "only Trainee's own x- header");
      eq(await q1(pg, `select status || ':' || purpose || ':' || attempts from public.career_outlook_sends where user_id = '${A}' and idem_key = 'apply:job-42'`), "sent:application:1", "ledger: sent once");
      // The text changed under an approved key: never sent.
      eq((await rails.sendMail(A, { ...m, text: "Hi Lee, something else" }, { idemKey: "apply:job-42", purpose: "application" })).status, "CHANGED", "changed payload");
      for (const bad of [
        { ...m, subject: "Hi\r\nBcc: everyone@example.test" }, { ...m, subject: "Hi\nCc: x@example.test" }, { ...m, subject: "Hi Bcc: y@example.test" },
        { ...m, to: "a@example.test, b@example.test" }, { ...m, to: "Lee <lee@globex.example>" }, { ...m, to: "lee@globex.example\r\nBcc: z@example.test" },
      ]) {
        const r = await rails.sendMail(A, bad, { idemKey: `bad:${crypto.randomUUID()}`, purpose: "general" });
        eq(r.status, "REFUSED", `refused: ${JSON.stringify(bad.subject + bad.to)}`);
      }
      eq(bodies.length, 1, "nothing refused reached Microsoft");
      eq(await q1(pg, `select count(*) from public.career_outlook_sends where idem_key like 'bad:%'`), "0", "a refused message never enters the ledger");
      // A broken connection mid-send may have sent it: unknown, and never sent again.
      ms.on((c) => c.url.endsWith("/me/sendMail") && JSON.parse(c.body).message.subject === "Network" ? Promise.reject(new TypeError("connection reset")) : null);
      eq((await rails.sendMail(A, { ...m, subject: "Network" }, { idemKey: "general:net-1", purpose: "general" })).status, "UNKNOWN", "unknown on a network break");
      eq((await rails.sendMail(A, { ...m, subject: "Network" }, { idemKey: "general:net-1", purpose: "general" })).status, "UNKNOWN", "and never retried");
      eq(await q1(pg, `select status from public.career_outlook_sends where idem_key = 'general:net-1'`), "unknown", "ledger: unknown");
    });

    await t.step("a 429 is waited out for exactly Retry-After; past the run's wait it is recorded and resumes later, sent once", async () => {
      const ms = microsoft();
      let n = 0;
      ms.on((c) => c.url.endsWith("/me/sendMail") ? (++n === 1 ? json({ error: { code: "TooManyRequests" } }, 429, { "retry-after": "7" }) : new Response(null, { status: 202 })) : null);
      const slept: number[] = [];
      const rails = outlookFor(ad, env, ms.fetch, { now: () => T0 + 180_000, sleep: async (ms_) => { slept.push(ms_); } });
      const m = { to: "kim@initech.example", subject: "Quick question", text: "Hi Kim, ..." };
      eq((await rails.sendMail(A, m, { idemKey: "outreach:429-a", purpose: "outreach" })).status, "sent", "sent after the wait");
      eq(slept, [7000], "waited exactly Retry-After (7 s), once");
      eq(n, 2, "one retry");
      // Microsoft asks for longer than this run can wait: recorded, not sent, and the same key goes later.
      const ms2 = microsoft();
      let k = 0;
      ms2.on((c) => c.url.endsWith("/me/sendMail") ? (++k === 1 ? json({}, 429, { "retry-after": "120" }) : new Response(null, { status: 202 })) : null);
      const short = outlookFor(ad, env, ms2.fetch, { now: () => T0 + 190_000, sleep: async () => { throw new Error("must not sleep past the run"); }, waitMs: 5000 });
      const r1 = await short.sendMail(A, { ...m, subject: "Later" }, { idemKey: "outreach:429-b", purpose: "outreach" });
      eq([r1.status, (r1 as any).retryAfterMs], ["RATE_LIMITED", 120000], "rate limited with Microsoft's wait");
      eq(await q1(pg, `select status from public.career_outlook_sends where idem_key = 'outreach:429-b'`), "rate_limited", "ledger keeps it resumable");
      eq((await short.sendMail(A, { ...m, subject: "Later" }, { idemKey: "outreach:429-b", purpose: "outreach" })).status, "sent", "resumed later, sent");
      eq(k, 2, "sent exactly once in total");
    });

    await t.step("a 401 from Microsoft marks needs_reconnect; the person is told plainly and nothing more is sent or read", async () => {
      const ms = microsoft();
      ms.on((c) => c.url.endsWith("/me/sendMail") ? json({ error: { code: "InvalidAuthenticationToken" } }, 401) : null);
      const rails = outlookFor(ad, env, ms.fetch, { now: () => T0 + 200_000 });
      const r = await rails.sendMail(A, { to: "pat@hooli.example", subject: "Hi", text: "Hi Pat" }, { idemKey: "outreach:401", purpose: "outreach" });
      eq(r.status, "NEEDS_RECONNECT", "needs reconnect");
      assert(await q1(pg, `select needs_reconnect_at is not null from public.career_outlook_state where user_id = '${A}'`) === "t", "state marked");
      const st = await outlookChatTurn({ admin: ad, message: "is my outlook connected?", userId: A, threadId: threadOf(A), bridge: false, now: T0, env });
      eq([st!.resultStatus, st!.reply], ["needs_reconnect", RECONNECT_REPLY], "the person reads it plainly");
      const before = ms.calls.length;
      eq((await rails.sendMail(A, { to: "pat@hooli.example", subject: "Hi 2", text: "Hi Pat" }, { idemKey: "outreach:401b", purpose: "outreach" })).status, "NEEDS_RECONNECT", "no send while it needs a reconnect");
      eq(ms.calls.length, before, "Microsoft not called");
      eq((await rails.readInbox(A)).status, "NEEDS_RECONNECT", "no read either");
      // invalid_grant on refresh marks it the same way (person B, connected now).
      const msB = microsoft();
      await connect(pg, ad, msB, B, "ben@fabrikam.example");
      await pg.sql(`update vault.secrets set secret = jsonb_set(secret::jsonb, '{expires_at}', '0')::text where name = 'oauth_microsoft_${B}'`);
      msB.on((c) => c.url.endsWith("/token") ? json({ error: "invalid_grant", error_description: "fake AADSTS70008" }, 400) : null);
      const rb = await outlookFor(ad, env, msB.fetch, { now: () => T0 + 300_000 }).sendMail(B, { to: "a@contoso.example", subject: "s", text: "t" }, { idemKey: "outreach:ig", purpose: "outreach" });
      eq(rb.status, "NEEDS_RECONNECT", "invalid_grant -> needs reconnect");
      eq(await q1(pg, `select needs_reconnect_reason from public.career_outlook_state where user_id = '${B}'`), "invalid_grant", "reason recorded");
      // A reconnect clears it.
      await connect(pg, ad, microsoft(), A, "ana@contoso.example", T0 + 400_000);
      eq(await q1(pg, `select needs_reconnect_at is null from public.career_outlook_state where user_id = '${A}'`), "t", "reconnect clears needs_reconnect");
    });

    await t.step("inbox delta: every page read, rows stored once by hash, the delta link kept and used next time", async () => {
      const ms = microsoft();
      const page1 = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=fake-p2`;
      const delta = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-d1`;
      let first = "";
      ms.on((c) => {
        if (c.url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select")) {
          first = c.url;
          return json({ value: [{ id: "m1", subject: "Re: Data analyst role", bodyPreview: "Happy to chat", receivedDateTime: "2026-10-28T02:00:00Z", conversationId: "c1", from: { emailAddress: { name: "Lee", address: "Lee@Globex.example" } } }], "@odata.nextLink": page1 });
        }
        if (c.url === page1) return json({ value: [{ id: "m2", subject: "Out of office", bodyPreview: "I'm away", receivedDateTime: "2026-10-28T02:05:00Z", from: { emailAddress: { address: "kim@initech.example" } } }, { id: "m0", "@removed": { reason: "deleted" } }], "@odata.deltaLink": delta });
        if (c.url === delta) return json({ value: [{ id: "m1", subject: "Re: Data analyst role", bodyPreview: "Happy to chat", receivedDateTime: "2026-10-28T02:00:00Z", from: { emailAddress: { address: "lee@globex.example" } } }], "@odata.deltaLink": delta });
        return null;
      });
      const rails = outlookFor(ad, env, ms.fetch, { now: () => T0 + 500_000 });
      const r1 = await rails.readInbox(A);
      eq([r1.status, r1.stored], ["ok", 2], "two messages on two pages");
      assert(first.includes("$filter=receivedDateTime+ge+"), "the first round reads only mail since the connection");
      eq(await q1(pg, `select string_agg(from_address || '|' || subject, ',' order by received_at) from public.career_outlook_messages where user_id = '${A}'`), "lee@globex.example|Re: Data analyst role,kim@initech.example|Out of office", "stored: address, subject");
      eq(await q1(pg, `select count(*) from public.career_outlook_messages where message_hash ~ '^[0-9a-f]{64}$'`), "2", "ids only as hashes");
      // The sync batch stores the delta link; the next round starts from it.
      await pg.sql(`update public.career_outlook_state set next_sync_at = '${new Date(T0).toISOString()}', delta_link = null where user_id = '${A}'`);
      await pg.sql(`update public.career_outlook_state set needs_reconnect_at = now() where user_id = '${B}'`);
      const stats = await runOutlookBatch({ admin: ad, env, fetch: ms.fetch, kind: "sync", worker: "w1", batch: 10, now: () => T0 + 600_000 });
      eq([stats.claimed, stats.ok], [1, 1], "A's sync ran (B needs a reconnect, not claimed)");
      eq(await q1(pg, `select delta_link from public.career_outlook_state where user_id = '${A}'`), delta, "delta link kept");
      await pg.sql(`update public.career_outlook_state set next_sync_at = '${new Date(T0).toISOString()}' where user_id = '${A}'`);
      const calls = ms.calls.length;
      await runOutlookBatch({ admin: ad, env, fetch: ms.fetch, kind: "sync", worker: "w1", batch: 10, now: () => T0 + 700_000 });
      eq(ms.calls.slice(calls).map((c) => c.url), [delta], "next round starts from the delta link");
      eq(await q1(pg, `select count(*) from public.career_outlook_messages where user_id = '${A}'`), "2", "a message seen again is stored once");
      // A 429 in the batch: Microsoft's wait recorded; the person is not claimed again until then.
      ms.on((c) => c.url === delta ? json({}, 429, { "retry-after": "3600" }) : null);
      await pg.sql(`update public.career_outlook_state set next_sync_at = '${new Date(T0).toISOString()}' where user_id = '${A}'`);
      const s429 = await runOutlookBatch({ admin: ad, env, fetch: ms.fetch, kind: "sync", worker: "w1", batch: 10, now: () => T0 + 800_000, sleep: async () => {} });
      eq(s429.rate_limited, 1, "rate limited");
      eq(Date.parse(await q1(pg, `select retry_after from public.career_outlook_state where user_id = '${A}'`)), T0 + 800_000 + 3_600_000, "retry_after = now + Retry-After");
      eq((await runOutlookBatch({ admin: ad, env, fetch: ms.fetch, kind: "sync", worker: "w2", batch: 10, now: () => T0 + 900_000 })).claimed, 0, "not claimed before Microsoft's time");
      eq((await runOutlookBatch({ admin: ad, env, fetch: microsoft().fetch, kind: "sync", worker: "w2", batch: 10, now: () => T0 + 800_000 + 3_600_001 })).claimed, 1, "claimed after it");
    });

    await t.step("calendar: free/busy from calendarView (busy, tentative, away; free and cancelled left out) and event create with or without Teams", async () => {
      const ms = microsoft();
      ms.on((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView?") ? json({ value: [
        { showAs: "busy", start: { dateTime: "2026-10-29T15:00:00.0000000" }, end: { dateTime: "2026-10-29T16:00:00.0000000" } },
        { showAs: "free", start: { dateTime: "2026-10-29T17:00:00.0000000" }, end: { dateTime: "2026-10-29T18:00:00.0000000" } },
        { showAs: "tentative", start: { dateTime: "2026-10-29T13:00:00.0000000" }, end: { dateTime: "2026-10-29T13:30:00.0000000" } },
        { showAs: "busy", isCancelled: true, start: { dateTime: "2026-10-29T19:00:00.0000000" }, end: { dateTime: "2026-10-29T20:00:00.0000000" } },
        { showAs: "oof", start: { dateTime: "2026-10-30T00:00:00.0000000" }, end: { dateTime: "2026-10-31T00:00:00.0000000" } },
      ] }) : null);
      const rails = outlookFor(ad, env, ms.fetch, { now: () => T0 });
      const fb = await rails.outlookFreeBusy(A, { start: "2026-10-29T00:00:00Z", end: "2026-10-31T00:00:00Z" });
      eq(fb, { status: "ok", busy: [
        { start: "2026-10-29T13:00:00.000Z", end: "2026-10-29T13:30:00.000Z", status: "tentative" },
        { start: "2026-10-29T15:00:00.000Z", end: "2026-10-29T16:00:00.000Z", status: "busy" },
        { start: "2026-10-30T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z", status: "oof" }], source: "calendarView" } as any, "busy intervals, sorted, UTC");
      eq(ms.calls[0].headers.prefer, 'outlook.timezone="UTC"', "times asked in UTC");
      const ev = { subject: "Coffee chat: Ana / Lee", start: "2026-10-29T16:00:00Z", end: "2026-10-29T16:30:00Z", attendees: ["lee@globex.example"], body: "Looking forward to it.", online: true, idemKey: "call:lee-1" };
      const posted: any[] = [];
      ms.on((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/me/calendar?") ? json({ allowedOnlineMeetingProviders: ["teamsForBusiness"] }) : null);
      ms.on((c) => c.url === "https://graph.microsoft.com/v1.0/me/events" ? (posted.push(JSON.parse(c.body)), json({ id: "fake-ev-1", onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/fake" } }, 201)) : null);
      const wrong = await rails.outlookCreateEvent(A, { ...ev, start: "2026-10-29T17:00:00Z" }, await eventHashOf(ev));
      eq([wrong.status, posted.length], ["REFUSED", 0], "an event that differs from the approved one is never created");
      const ok = await rails.outlookCreateEvent(A, ev, await eventHashOf(ev));
      eq(ok, { status: "created", id: "fake-ev-1", joinUrl: "https://teams.microsoft.com/l/meetup-join/fake", teams: true, note: null }, "created with a Teams link");
      eq([posted[0].isOnlineMeeting, posted[0].onlineMeetingProvider, posted[0].attendees, posted[0].start], [true, "teamsForBusiness", [{ emailAddress: { address: "lee@globex.example" }, type: "required" }], { dateTime: "2026-10-29T16:00:00.000", timeZone: "UTC" }], "the event body");
      assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(posted[0].transactionId), "a transactionId from the key (a retried POST is the same event)");
      ms.on((c) => c.url.startsWith("https://graph.microsoft.com/v1.0/me/calendar?") ? json({ allowedOnlineMeetingProviders: [] }) : null);
      const noTeams = await rails.outlookCreateEvent(A, { ...ev, idemKey: "call:lee-2" }, await eventHashOf({ ...ev, idemKey: "call:lee-2" }));
      eq([noTeams.status, (noTeams as any).teams, (noTeams as any).joinUrl !== undefined, "isOnlineMeeting" in posted[1]], ["created", false, true, false], "no Teams on a calendar that can't");
      assert(/can't add a Teams link/.test((noTeams as any).note), "and the note says so");
    });

    await t.step("one send rail: dispatch by the connected provider; an unapproved text is never sent; the outreach Sender shape", async () => {
      const ms = microsoft();
      let sends = 0;
      ms.on((c) => c.url.endsWith("/me/sendMail") ? (sends++, new Response(null, { status: 202 })) : null);
      const rails = outlookFor(ad, env, ms.fetch, { now: () => T0 + 1_000_000 });
      const rail = mailRail({ providers: { outlook: outlookProvider(rails) }, which: (u) => sendProviders(ad, u) });
      eq((await sendProviders(ad, A)).map((p) => p.id), ["outlook"], "A sends through Outlook");
      eq((await sendProviders(ad, B)).map((p) => p.id), [], "B needs a reconnect: no provider");
      const mail = { to: "sam@umbrella.example", subject: "Intro", text: "Hi Sam" };
      const approved = await approvalHashOf(mail);
      eq((await rail.send({ userId: A, mail: { ...mail, text: "Hi Sam!!" }, idemKey: "general:1", purpose: "general", approvedHash: approved })).status, "CHANGED", "not what was approved");
      eq(sends, 0, "nothing sent");
      const r = await rail.send({ userId: A, mail, idemKey: "general:1", purpose: "general", approvedHash: approved });
      eq([r.status, (r as any).provider], ["sent", "outlook"], "sent through Outlook");
      eq((await rail.send({ userId: B, mail, idemKey: "general:1", purpose: "general", approvedHash: approved })).status, "NO_PROVIDER", "B: no provider, nothing sent");
      const sender = outreachSenderOf(rail);
      const s1 = await sender.send(A, { to: "ola@stark.example", subject: "Hello", text: "Hi Ola" });
      const s2 = await sender.send(A, { to: "ola@stark.example", subject: "Hello", text: "Hi Ola" });
      eq([s1.status, s2.status, sends], ["sent", "sent", 2], "the outreach Sender sends the same message once");
    });

    await t.step("disconnect: tokens, row, Outlook mail and state gone; pending sends cancelled; live links burned; told where to remove the app", async () => {
      await pg.sql(`insert into public.career_outlook_sends (user_id, idem_key, payload_hash, purpose, recipient_hash, status, created_at, updated_at)
        values ('${A}', 'outreach:pending-1', repeat('a', 64), 'outreach', repeat('b', 64), 'rate_limited', now(), now())`);
      await pg.asService().rpc("career_outlook_link_issue", { p_user: A, p_channel: "telegram", p_thread: null, p_purpose: "connect", p_now: new Date().toISOString() });
      const r = await outlookChatTurn({ admin: ad, message: "disconnect outlook", userId: A, threadId: threadOf(A), bridge: false, now: T0, env });
      eq(r!.resultStatus, "completed", "completed");
      assert(/account\.live\.com\/consent\/Manage/.test(r!.reply) && /myapps\.microsoft\.com/.test(r!.reply), "says where to remove the app");
      eq(await q1(pg, `select count(*) from public.user_oauth_connections where user_id = '${A}' and provider = 'microsoft'`), "0", "row gone");
      eq(await q1(pg, `select count(*) from vault.secrets where name = 'oauth_microsoft_${A}'`), "0", "tokens gone");
      eq(await q1(pg, `select count(*) from public.career_outlook_messages where user_id = '${A}'`), "0", "Outlook mail erased");
      eq(await q1(pg, `select count(*) from public.career_outlook_state where user_id = '${A}'`), "0", "state erased");
      eq(await q1(pg, `select status from public.career_outlook_sends where idem_key = 'outreach:pending-1'`), "cancelled", "pending send cancelled");
      eq(await q1(pg, `select count(*) from public.career_outlook_sends where user_id = '${A}' and status = 'sent'`) !== "0", true, "what was sent stays the person's history");
      eq(await q1(pg, `select count(*) from public.career_outlook_links where user_id = '${A}' and finished_at is null`), "0", "every live link burned");
      eq(await q1(pg, `select count(*) from public.user_oauth_connections where user_id = '${B}' and provider = 'microsoft'`), "1", "B untouched");
      const after = await outlookFor(ad, env, microsoft().fetch).sendMail(A, { to: "x@example.test", subject: "s", text: "t" }, { idemKey: "outreach:after", purpose: "outreach" });
      eq(after.status, "NOT_WIRED", "nothing can be sent after a disconnect");
      eq((await disconnectOutlook(ad, A)).had, false, "a second disconnect finds nothing");
    });

    await t.step("scale: 600 people, 12 concurrent workers, leased refresh batches: each person claimed exactly once; an expired lease is taken over", async () => {
      await pg.sql(`insert into auth.users (id) select ('00000000-0000-4000-9000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 600) i on conflict do nothing;
        insert into public.career_outlook_state (user_id, token_expires_at) select ('00000000-0000-4000-9000-' || lpad(i::text, 12, '0'))::uuid, '${new Date(T0).toISOString()}' from generate_series(1, 600) i on conflict do nothing;`);
      const svc = pg.asService();
      const now = new Date(T0 + 1000).toISOString();
      const started = performance.now();
      const claimed: string[][] = await Promise.all(Array.from({ length: 12 }, async (_, w) => {
        const mine: string[] = [];
        for (;;) {
          const r = await svc.rpc("career_outlook_claim", { p_kind: "refresh", p_worker: `w${w}`, p_now: now, p_lease_seconds: 300, p_batch: 20 });
          if (r.error) throw new Error(r.error.message);
          if (!r.data?.length) return mine;
          mine.push(...r.data.map(String));
        }
      }));
      const ms = performance.now() - started;
      const all = claimed.flat();
      eq(all.length, 600, "600 claims");
      eq(new Set(all).size, 600, "each person exactly once");
      assert(claimed.filter((c) => c.length > 0).length > 1, "spread across workers");
      console.log(`  scale: 600 refresh claims by 12 concurrent workers in ${ms.toFixed(0)} ms (${(600 / (ms / 1000)).toFixed(0)} claims/s); per worker ${claimed.map((c) => c.length).join(",")}`);
      const later = new Date(T0 + 1000 + 301_000).toISOString();
      const again = await svc.rpc("career_outlook_claim", { p_kind: "refresh", p_worker: "w-late", p_now: later, p_lease_seconds: 300, p_batch: 5 });
      eq(again.data?.length, 5, "an expired lease is taken over");
      const stale = await svc.rpc("career_outlook_release", { p_kind: "refresh", p_user: all[0], p_worker: "w-nobody", p_now: later, p_patch: {} });
      eq(stale.data, false, "a worker that does not hold the lease cannot release it");
    });
  } finally {
    await pg.stop();
  }
});
