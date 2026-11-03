// Connectors, disconnect and erase, round 3, end to end (owner rules, 2026-10-31): a seeded sample of the generated scenarios
// (tests/architect/scenarios/connectors-r3-generator.ts, the same ones scenarios-connectors-r3.test.ts runs in memory), each
// person of their own on real Postgres 16 with every migration, through the real code: Gmail's callback (googleCallback,
// gmail-oauth's), Outlook's (handleOutlookOAuth, the outlook-oauth edge function's), afterConnect, the chat's connector turn,
// Outlook's sync (syncInbox), Gmail's scheduled mail run (runMail over supabaseMailStore), disconnectGoogle,
// disconnectOutlook and the erase trigger ("forget everything"). Google and Microsoft are faked at the HTTP boundary; any
// other host is refused. No model, no network.
//   1. Gmail callbacks: an account deleted while the person was at Google (nothing in the Vault or the table, the new
//      grant revoked); the same state twice (the second exchanges nothing); an address another account holds (refused in
//      plain words in the chat the link came from, nothing stored, nothing revoked, the other account untouched); a box
//      left unticked (the confirmation says what is missing and how to give it).
//   2. Outlook, the same: an account deleted while Microsoft exchanged the code; an address another account holds; Mail.Read
//      left unticked ("check my outlook" says so); the link replayed.
//   3. Inbox runs: a person says "disconnect gmail|outlook" or "forget everything" before the run reads, while it reads, or
//      after its last check and before its write; another person in the same run never asks. Read back from the database:
//      nothing read before the ask is in any table after it, nothing about it was queued, the other person's run is whole.
// Every check is read from the database. Time: well under a minute.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { PgConn } from "../flow/pgwire.ts";
import { SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { fakeIdToken, json, microsoft } from "./outlook-fixture.ts";
import { callbacks, fakeTok, GMAIL_READ, type Inbox, inboxes } from "./scenarios/connectors-r3-generator.ts";
import { googleCallback, PARTIAL_WORDS, TAKEN_WORDS } from "../../supabase/functions/_shared/oauth_connect.ts";
import { afterConnect, connectorChatTurn, refusedConnect } from "../../supabase/functions/_shared/connectors.ts";
import { disconnectGoogle, GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { disconnectOutlook, handleOutlookOAuth, outlookChatTurn, syncInbox, tokenDeps } from "../../supabase/functions/_shared/outlook_connector.ts";
import { outlookToken } from "../../supabase/functions/_shared/outlook_graph.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";

const CI = Deno.env.get("CI") === "true";
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261031;
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const BASE = "https://proj.example.test/functions/v1/outlook-oauth";
const ENV: Record<string, string> = {
  MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client-0000", MICROSOFT_OAUTH_CLIENT_SECRET: "fake-ms-secret-0000", OAUTH_STATE_SECRET: "fake-state-secret-0000-xxxxxxxxxxxxxxxx",
  OUTLOOK_LINK_BASE: BASE, GOOGLE_OAUTH_CLIENT_ID: "fake-google-client-0000", GOOGLE_OAUTH_CLIENT_SECRET: "fake-google-secret-0000",
};
const env = { get: (k: string) => ENV[k] };
const MS_ALL = "openid email offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite";
const AUTH = ["mx.google.com; dkim=pass header.i=@greenhouse.io header.s=s1; spf=pass smtp.mailfrom=greenhouse.io; dmarc=pass (p=REJECT) header.from=greenhouse.io"];
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);

Deno.test({ name: "connectors r3 end to end on Postgres: callbacks bound to their account and used once, partial grants said, inbox runs racing a disconnect or an erase", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const started = Date.now();
  const pg: Pg = await startPg();
  const conn = await PgConn.connect({ host: pg.host, port: pg.port });
  const failures: string[] = [];
  let graded = 0;
  const grade = (label: string, why: string | null) => { graded++; if (why) failures.push(`${label}: ${why}`); };
  const step = async (name: string, fn: () => Promise<void>) => {
    const ok = await t.step(name, async () => { try { await fn(); } catch (e) { console.log(`STEP FAILED: ${name}\n${(e as Error)?.stack ?? e}`.slice(0, 4000)); throw e; } });
    if (!ok) throw new Error(`step failed: ${name}`);
  };
  try {
    await supabaseParity(pg);
    await pg.sql(`grant select, insert, update on public.agent_threads, public.agent_messages to service_role; grant usage, select on all sequences in schema public to service_role;`);
    const rows = async (sql: string): Promise<any[]> => JSON.parse((await conn.query(`select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (${sql}) x`))[0][0] ?? "[]");
    const one = async (sql: string) => (await rows(sql))[0];
    const n = async (sql: string) => Number((await one(`select (${sql})::int as n`)).n);
    const double = postgrestDouble(pg, { url: SUPABASE_URL, serviceKey: SERVICE_KEY, users: {} });
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const person = async (uid: string, email: string) => {
      await conn.query(`insert into auth.users (id, email) values (${q(uid)}, ${q(email)}) on conflict do nothing;
        insert into public.agent_threads (id, user_id) values (${q(threadOf(uid))}, ${q(uid)}) on conflict do nothing`);
    };
    const threadOf = (uid: string) => `a${uid.slice(1)}`; // one thread per person
    const vaultOf = async (uid: string) => (await rows(`select name from vault.secrets where name like ${q(`%${uid}%`)} order by name`)).map((r) => r.name);
    const connOf = async (uid: string) => await rows(`select provider, email, scopes from public.user_oauth_connections where user_id = ${q(uid)} order by provider`);
    const outbound: string[] = [];

    // ------------------------------------------------------------------------------------------------ 1. Gmail callbacks
    await step("1. Gmail callbacks: gone, replayed, taken, a box left unticked, and a plain connect", async () => {
      const sample = callbacks(SEED + 31, 3500).filter((c) => c.token === "ok" && c.email).slice(0, 400);
      const picked = ["gone", "replayed", "taken", "connect"].flatMap((f) => sample.filter((c) => c.family === f).slice(0, 7));
      for (const c of picked) {
        const revokes: string[] = [];
        let tokenCalls = 0;
        const google = (async (input: any, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.url;
          if (url === "https://oauth2.googleapis.com/token") {
            tokenCalls++;
            return json({ access_token: fakeTok("access", `${c.id}-${tokenCalls}`), refresh_token: fakeTok("refresh", `${c.id}-${tokenCalls}`), expires_in: 3600, ...(c.scopes.length ? { scope: c.scopes.join(" ") } : {}) });
          }
          if (url === "https://www.googleapis.com/oauth2/v2/userinfo") return json({ email: c.email });
          if (url === GOOGLE_REVOKE) { revokes.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? ""); return new Response("", { status: 200 }); }
          outbound.push(url);
          throw new Error(`refused: ${url}`);
        }) as typeof fetch;
        await person(c.other, `other-${c.id}@example.test`);
        await person(c.uid, `person-${c.id}@example.test`);
        if (c.family === "taken") {
          const prov = c.holder === "other_legacy" ? "gmail" : "google_career";
          eq((await admin.rpc("oauth_connect_commit", { p_user: c.other, p_provider: prov, p_secret: JSON.stringify({ access_token: fakeTok("access", `held-${c.id}`) }), p_email: c.addrVariant === "upper" ? c.email!.toUpperCase() : c.email, p_scopes: "openid email" })).data, "connected");
        }
        // The chat's link, opened: where the person is told.
        const nonce = (await admin.rpc("career_connector_link_issue", { p_user: c.uid, p_connector: "gmail", p_channel: "web", p_thread: threadOf(c.uid), p_now: new Date().toISOString() })).data;
        await admin.rpc("career_connector_link_open", { p_nonce: nonce, p_now: new Date().toISOString() });
        if (c.family === "gone") await conn.query(`delete from auth.users where id = ${q(c.uid)}`);
        const otherBefore = JSON.stringify([await connOf(c.other), await vaultOf(c.other)]);
        const state = `${c.uid}.${Date.now() + 600_000}.career.${"s".repeat(43)}${c.id}`;
        const deps = { admin, fetch: google, now: Date.now, clientId: ENV.GOOGLE_OAUTH_CLIENT_ID, clientSecret: ENV.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: "https://proj.example.test/functions/v1/gmail-oauth",
          grantedFallback: () => `openid email ${GMAIL_READ}`, sleep: async () => {} };
        const outs: any[] = [];
        for (let k = 0; k < c.uses; k++) outs.push(await googleCallback(deps as any, { code: `fake-code-${c.id}-${k}`, state, userId: c.uid, provider: "google_career" }));
        const first = outs[0];
        const after = { conns: (await connOf(c.uid)).filter((r) => r.provider === "google_career"), vault: (await vaultOf(c.uid)).filter((x) => x.startsWith("oauth_google_career")) };
        const otherAfter = JSON.stringify([await connOf(c.other), await vaultOf(c.other)]);
        let why: string | null = null;
        if (otherAfter !== otherBefore) why = "the other account's connection or Vault changed";
        else if (outs.slice(1).some((o) => o.ok || o.why !== "replayed")) why = "a replayed state was not refused";
        else if (tokenCalls !== 1) why = `${tokenCalls} codes were exchanged for one state`;
        else if (c.family === "gone") {
          if (first.why !== "gone") why = `gone: ${JSON.stringify(first)}`;
          else if (after.vault.length || after.conns.length || (await vaultOf(c.uid)).length) why = "a Vault entry or row was left for an account that no longer exists";
          else if (!revokes.length || revokes.some((x) => !x.endsWith(`-${c.id}-1`))) why = "the new grant was not revoked at Google (or another token was)";
        } else if (c.family === "taken") {
          if (first.why !== "taken") why = `taken: ${JSON.stringify(first)}`;
          else if (after.vault.length || after.conns.length) why = "an address another account holds was stored here";
          else if (revokes.length) why = "the shared grant was revoked";
          else {
            await refusedConnect({ admin, env, fetch: google, now: Date.now, log: () => {} } as any, c.uid, "gmail", TAKEN_WORDS("Gmail", first.email));
            const said = await one(`select content from public.agent_messages where thread_id = ${q(threadOf(c.uid))} order by id desc limit 1`);
            if (!said || !String(said.content).includes("already connected to another Trainee account")) why = `the person was not told in their chat: ${JSON.stringify(said)}`;
          }
        } else {
          if (!first.ok) why = `a good callback was refused: ${JSON.stringify(first)}`;
          else if (after.conns.length !== 1 || after.vault.length !== 1) why = "a good callback stored nothing";
          else {
            await afterConnect({ admin, env, fetch: google, now: Date.now, log: () => {}, runTurn: async () => ({ reply: "ok", persisted: true }) } as any, c.uid, "gmail", { email: first.email, scopes: first.scopes.split(" ") });
            const said = String((await one(`select content from public.agent_messages where thread_id = ${q(threadOf(c.uid))} order by id desc limit 1`))?.content ?? "");
            const reads = first.scopes.split(" ").includes(GMAIL_READ);
            if (!said.startsWith("Gmail connected")) why = `not told it connected: ${said}`;
            else if (/didn't allow me to read your mail/.test(said) === reads) why = reads ? "a grant that reads is told it may not" : `a grant without read access is not told so: ${said}`;
          }
        }
        grade(`gmail #${c.id} ${c.family}`, why);
      }
    });

    // ------------------------------------------------------------------------------------------------ 2. Outlook callbacks
    await step("2. Outlook callbacks (parity): gone during the exchange, taken, Mail.Read left unticked, a replayed link", async () => {
      const cases = [
        ...Array.from({ length: 5 }, (_, i) => ({ k: "gone", i })), ...Array.from({ length: 5 }, (_, i) => ({ k: "taken", i })),
        ...Array.from({ length: 5 }, (_, i) => ({ k: "no_read", i })), ...Array.from({ length: 5 }, (_, i) => ({ k: "connect", i })),
      ];
      for (const c of cases) {
        const id = 70_000 + cases.indexOf(c), uid = `6f3b1d2e-8c40-4d9f-8b21-${String(id).padStart(12, "0")}`, other = `6f3b1d2e-8c40-4d9f-8b21-${String(id + 1000).padStart(12, "0")}`;
        await person(uid, `p-${id}@example.test`);
        await person(other, `o-${id}@example.test`);
        const email = `outlook-${id}@contoso.example`;
        if (c.k === "taken") eq((await admin.rpc("oauth_connect_commit", { p_user: other, p_provider: "microsoft", p_secret: "{}", p_email: email.toUpperCase(), p_scopes: MS_ALL })).data, "connected");
        const otherBefore = JSON.stringify([await connOf(other), await vaultOf(other)]);
        const ms = microsoft();
        const now = Date.now();
        const turn = await outlookChatTurn({ admin, message: "connect my outlook", userId: uid, threadId: threadOf(uid), bridge: false, now, env });
        const token = /\?t=([A-Za-z0-9_-]{32})/.exec(turn!.reply)![1];
        const post = await handleOutlookOAuth(new Request(BASE, { method: "POST", body: new URLSearchParams({ t: token }) }), { admin, env, fetch: ms.fetch, now: () => now });
        const st = new URL(post.headers.get("location")!).searchParams.get("state")!;
        const scopes = c.k === "no_read" ? "openid email offline_access User.Read Mail.Send" : MS_ALL;
        ms.on(async (x) => {
          if (!x.url.endsWith("/oauth2/v2.0/token")) return null;
          if (c.k === "gone") await conn.query(`delete from auth.users where id = ${q(uid)}`); // deleted while Microsoft exchanged the code
          return json({ access_token: fakeTok("access", id), refresh_token: fakeTok("refresh", id), expires_in: 3600, scope: scopes, id_token: fakeIdToken(email) });
        });
        ms.on((x) => x.url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta") ? json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-d1" }) : null);
        const cb = await handleOutlookOAuth(new Request(`${BASE}?code=fake-code-${id}&state=${encodeURIComponent(st)}`), { admin, env, fetch: ms.fetch, now: () => now + 1000, log: () => {} });
        const replay = await handleOutlookOAuth(new Request(`${BASE}?code=fake-code-${id}-b&state=${encodeURIComponent(st)}`), { admin, env, fetch: ms.fetch, now: () => now + 2000, log: () => {} });
        const tokenCalls = ms.calls.filter((x) => x.url.endsWith("/oauth2/v2.0/token")).length;
        const mine = { conns: (await connOf(uid)).filter((r) => r.provider === "microsoft"), vault: (await vaultOf(uid)).filter((x) => x.startsWith("oauth_microsoft")) };
        const said = String((await one(`select content from public.agent_messages where thread_id = ${q(threadOf(uid))} order by id desc limit 1`))?.content ?? "");
        let why: string | null = null;
        if (JSON.stringify([await connOf(other), await vaultOf(other)]) !== otherBefore) why = "the other account changed";
        else if (replay.status !== 400 || tokenCalls !== 1) why = `a replayed link was not refused before Microsoft (${replay.status}, ${tokenCalls} exchanges)`;
        else if (c.k === "gone") { if (mine.conns.length || (await vaultOf(uid)).length) why = "a Vault entry or row was left for an account deleted during the exchange"; else if (cb.status === 200) why = "a deleted account's connect was called connected"; }
        else if (c.k === "taken") {
          if (mine.conns.length || mine.vault.length) why = "an address another account holds was stored here";
          else if (!said.includes("already connected to another Trainee account")) why = `not told in plain words: ${said}`;
        } else {
          if (cb.status !== 200 || mine.conns.length !== 1 || mine.vault.length !== 1) why = `a good connect was not stored (${cb.status})`;
          else if (c.k === "no_read" && !/didn't allow me to read your mail/.test(said)) why = `Mail.Read left unticked is not said: ${said}`;
          else if (c.k === "connect" && /didn't allow/.test(said)) why = "a full grant is told something is missing";
          else if (c.k === "no_read") {
            const r = await connectorChatTurn({ admin, env, fetch: ms.fetch, now: () => now + 3000, message: "check my outlook", userId: uid, threadId: threadOf(uid), bridge: false, log: () => {} } as any);
            if (r?.reply !== PARTIAL_WORDS.outlook.read) why = `"check my outlook" without Mail.Read: ${r?.reply}`;
          }
        }
        grade(`outlook #${id} ${c.k}`, why);
      }
    });

    // ------------------------------------------------------------------------------------------------ 3. inbox runs
    await step("3. inbox runs racing a disconnect or a forget-everything, for Gmail and Outlook", async () => {
      const all = inboxes(SEED + 33, 2500);
      const picked = [...new Set(all.map((x) => x.family))].sort().flatMap((f) => all.filter((x) => x.family === f).slice(0, 3));
      const googleOk = (async (input: any) => { const url = typeof input === "string" ? input : input.url; if (url === GOOGLE_REVOKE) return new Response("", { status: 200 }); outbound.push(url); throw new Error(`refused: ${url}`); }) as typeof fetch;
      for (const x of picked) {
        for (const u of [x.uid, x.other]) {
          await person(u, `${u.slice(-6)}@example.test`);
          if (x.priorEpoch) await conn.query(`insert into public.career_watch_kv (user_id, key, value) values (${q(u)}, 'career:account', jsonb_build_object('epoch', ${x.priorEpoch}, 'paused', false)) on conflict (user_id, key) do update set value = excluded.value`);
          if (x.provider === "gmail") {
            eq((await admin.rpc("oauth_connect_commit", { p_user: u, p_provider: "google_career", p_secret: JSON.stringify({ access_token: fakeTok("access", u.slice(-6)), refresh_token: fakeTok("refresh", u.slice(-6)) }), p_email: `g-${u.slice(-8)}@example.test`, p_scopes: `openid email ${GMAIL_READ}` })).data, "connected");
            await conn.query(`insert into public.career_mail_cursors (user_id, read_through) values (${q(u)}, now() - interval '1 hour') on conflict (user_id) do nothing`);
          } else {
            eq((await admin.rpc("oauth_connect_commit", { p_user: u, p_provider: "microsoft", p_secret: JSON.stringify({ access_token: fakeTok("access", u.slice(-6)), refresh_token: fakeTok("refresh", u.slice(-6)), expires_at: Date.now() + 3_600_000 }), p_email: `m-${u.slice(-8)}@contoso.example`, p_scopes: MS_ALL })).data, "connected");
            await conn.query(`insert into public.career_outlook_state (user_id, email, next_sync_at) values (${q(u)}, 'x@contoso.example', now()) on conflict (user_id) do nothing`);
          }
        }
        const ask = async () => {
          if (x.what === "erase") {
            await conn.query(`insert into public.career_watch_kv (user_id, key, value) values (${q(x.uid)}, 'career:account', jsonb_build_object('epoch', ${x.priorEpoch + 1}, 'version', 9, 'paused', true))
              on conflict (user_id, key) do update set value = excluded.value`);
          } else if (x.provider === "gmail") { const r = await disconnectGoogle(admin, x.uid, { fetch: googleOk, sleep: async () => {} }); if (!r.ok) throw new Error(`disconnect: ${JSON.stringify(r)}`); }
          else { const r = await disconnectOutlook(admin as any, x.uid); if (!r.ok) throw new Error(`disconnect: ${JSON.stringify(r)}`); }
        };
        if (x.when === "before_read") await ask();
        const stored = x.when === "none" || (x.when === "before_read" && x.what === "erase");
        let why: string | null = null;
        if (x.provider === "outlook") {
          const run = async (u: string, mine: boolean) => {
            const ms = microsoft();
            ms.on(async (c) => {
              if (!c.url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta")) return null;
              if (mine && (x.when === "during_read" || x.when === "after_check")) await ask();
              return json({ value: Array.from({ length: x.mails }, (_, i) => ({ id: `m-${u.slice(-6)}-${i}`, subject: "Re: your application", bodyPreview: "Thanks", receivedDateTime: new Date(Date.now() - 60_000).toISOString(),
                from: { emailAddress: { address: `r${i}@acme.example` } } })), "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-d1" });
            });
            const td = tokenDeps(admin, env, ms.fetch);
            return await syncInbox(admin, { fetch: ms.fetch, now: Date.now, token: (uu: string, s: string) => outlookToken(td, uu, s), waitMs: 1 }, u, Date.now());
          };
          const mine = await run(x.uid, true), theirs = await run(x.other, false);
          const kept = await n(`select count(*) from public.career_outlook_messages where user_id = ${q(x.uid)}`);
          if (stored ? kept !== x.mails : kept > 0) why = stored ? `kept ${kept} of ${x.mails}` : `${kept} message(s) read before the ask are in the table after it (${mine.status})`;
          else if ((await n(`select count(*) from public.career_outlook_messages where user_id = ${q(x.other)}`)) !== x.mails || theirs.status !== "ok") why = "the other person's sync was touched";
        } else {
          const base = supabaseMailStore(admin);
          let checks = 0;
          const store = { ...base, people: async (lim: number) => (await base.people(lim)).filter((p) => p.user_id === x.uid || p.user_id === x.other),
            applications: async () => [{ ref: "track:a1", company: "Asana", role: "Account Manager", stage: "Submitted", source: "tracker" as const, applied_at: new Date(Date.now() - 864e6).toISOString(), events: [] }],
            async stillConnected(u: string) { const r = await base.stillConnected!(u); if (u === x.uid && x.when === "after_check" && ++checks === 1) await ask(); return r; } };
          const outbox = memoryAlertStore();
          await runMail({ outbox, now: Date.now(), store, read: async (u) => {
            if (u === x.uid && x.when === "during_read") await ask();
            return { status: "ok", mails: Array.from({ length: x.mails }, (_, i) => ({ hash: hex(`${u}-${i}`), from: "Asana <no-reply@greenhouse.io>", subject: "Your Asana application",
              snippet: "Unfortunately, we have decided not to move forward with your application.", date: new Date(Date.now() - 120_000 - i * 1000).toISOString(), auth: AUTH })), readThrough: Date.now(), listed: x.mails };
          } });
          const ev = await n(`select count(*) from public.career_mail_events where user_id = ${q(x.uid)}`);
          const drafts = await n(`select count(*) from public.career_mail_drafts where user_id = ${q(x.uid)}`);
          const cursor = await n(`select count(*) from public.career_mail_cursors where user_id = ${q(x.uid)}`);
          const said = outbox.dump().outbox.filter((o: any) => o.userId === x.uid).length;
          if (stored) { if (!ev || !said) why = "a run with nothing withdrawn did not keep or say what it read"; }
          else if (ev || drafts) why = `${ev} event(s) and ${drafts} draft(s) read before the ask are in the tables after it`;
          else if (said) why = "what was read before the ask was said after it";
          else if (x.what === "disconnect" && cursor) why = "a disconnected mailbox's read position was written again";
          if (!why && (!(await n(`select count(*) from public.career_mail_events where user_id = ${q(x.other)}`)) || !outbox.dump().outbox.some((o: any) => o.userId === x.other))) why = "the other person's run was touched";
        }
        grade(`inbox #${x.id} ${x.family}`, why);
      }
    });

    console.log(`[connectors r3 e2e] ${graded} people, ${failures.length} failures; ${((Date.now() - started) / 1000).toFixed(1)} s`);
    for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f}`);
    eq(failures, [], `${failures.length} of ${graded} went wrong`);
    eq(outbound, [], "nothing left the test");
  } finally {
    conn.close();
    await pg.stop();
  }
} });
