// Erase scenarios, round 2, end to end (owner rules, 2026-10-30): ~80 generated people (tests/architect/scenarios/
// erase-r2-generator.ts people()), each with their own data on real Postgres 16 with every migration, and another person
// who is never touched. Each asks for one thing, some while something of theirs is running:
//   delete my account   delete-account's own steps (_shared/account_delete.ts restDeps, the edge function's wiring) over the
//                       PostgREST double (tests/flow/postgrest.ts), GoTrue's admin API and Storage on the same database,
//                       Google's revoke endpoint faked at the HTTP boundary (Microsoft has none; any other host is refused);
//   forget everything   the account's erase (career_watch_kv epoch raised and paused, as career_host_commit writes it);
//   disconnect one      "disconnect gmail" / "disconnect outlook" (disconnectGoogle, disconnectOutlook);
//   another account     connecting a different Google or Microsoft account over the one connected (the callback's upsert);
//   nothing             nothing changes.
// What runs while they ask: a send worker holding one of their emails (before it read the token, after, after Gmail
// accepted it), a token refresh at Google, a delivery run that has claimed their job alert or their answer, two deletions
// at once. Then, read from the database:
//   - a deleted person: the whole schema is scanned (every table of every schema, every column) for their id, any id of a
//     row they owned, their email, phone and Telegram id: nothing is left; their Vault entries and resume files are gone;
//     their Google grants were revoked at Google before anything was erased, and the reply says only what is true; the
//     deletion is recorded with nothing that names them; the opt-out and bounce hashes stay and still refuse anyone;
//   - each other ask did exactly its scope: forget-everything empties the career records and keeps the account, its
//     connections, tokens, chats and sign-ins; a disconnect removes that mailbox only; another account cancels what waited
//     on the old one; nothing else of theirs changes, and nothing of the other person's;
//   - nothing is sent after the ask committed (except an email Gmail had already accepted, once), a refresh that raced the
//     ask leaves no token behind and is not used, a delivery run sends them nothing;
//   - signing up again with the same email, phone and Telegram gives a fresh, empty account;
//   - every send worker then runs until nothing is due: nothing that waited on a removed mailbox goes; the other person's do.
// No model, no provider, no network. Time: about 80 people, well under a minute.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { PgConn, serviceRpc } from "../flow/pgwire.ts";
import { SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { FakeGmail } from "../flow/send-rail-fixture.ts";
import { type Person, people } from "./scenarios/erase-r2-generator.ts";
import { wordsWhy } from "./scenarios/erase-r2-check.ts";
import { deleteAccount, deletionWords, restDeps } from "../../supabase/functions/_shared/account_delete.ts";
import { disconnectGoogle, GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { disconnectOutlook } from "../../supabase/functions/_shared/outlook_connector.ts";
import { CAREER_SEND_SCOPE, careerTokenFor } from "../../supabase/functions/_shared/career_mail_gmail.ts";
import { vaultRefreshWrite } from "../../supabase/functions/_shared/oauth_vault_refresh.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { type MailProviderLike, queueApproved, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";

const CI = Deno.env.get("CI") === "true";
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const N = 80;
const DAY = 86_400_000;
const PEOPLE = people(20261030 + 21, N);
const OTHER: Person = { ...people(20261030 + 22, 1)[0], id: 999, uid: "5e2a0c1d-7b3f-4c8e-9a10-fff000000999", email: "other-999@example.test", phone: "+15559990999", telegram: "889999999",
  action: "none", mid: "none", gmail: true, outlook: true, legacy: false, queued: { gmail: 2, outlook: 1 }, outbox: { alerts: 1, replies: 1 },
  linked: { telegram: true, session: true, login: true, linkRequest: true }, chat: 2, files: 2, dnc: true, execRef: true, mail: { events: 2, cursor: true, outlook: 2 }, resignup: false, family: "other" };
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const SEND = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

type Failure = { p: Person; why: string; got: string };
class Report {
  total = 0; failures = new Map<string, Failure[]>();
  constructor(public path: string) {}
  grade(p: Person, why: string | null, got: string) {
    this.total++;
    if (!why) return;
    if (!this.failures.has(p.family)) this.failures.set(p.family, []);
    this.failures.get(p.family)!.push({ p, why, got });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((x, y) => x + y.length, 0);
    const lines = [`[erase r2 e2e] ${this.path}: ${this.total} people, ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((x, y) => y[1].length - x[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    #${x.p.id} -> ${x.got.slice(0, 300)} (${x.why})`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | #${xs[0].p.id} -> ${xs[0].got.slice(0, 200)}`).join(" || ");
    eq(failed, 0, `${this.path}: ${failed} people went wrong: ${first}`);
  }
}

// Read-only helpers created in the throwaway database: a person's footprint (rows per table and column holding their id,
// their Vault entries, their files), the ids of the rows they own, and a scan of every column of every table.
const HELPERS = `
create schema if not exists er2test;
create or replace function er2test.fp(p uuid) returns jsonb language plpgsql as $$
declare r record; n bigint; out jsonb := '{}';
begin
  for r in select c.table_schema s, c.table_name t, c.column_name col from information_schema.columns c
      join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
      where x.table_type = 'BASE TABLE' and c.data_type = 'uuid' and c.table_schema not in ('pg_catalog', 'information_schema', 'er2test', 'auth') loop
    execute format('select count(*) from %I.%I where %I = $1', r.s, r.t, r.col) into n using p;
    if n > 0 then out := out || jsonb_build_object(r.s || '.' || r.t || '.' || r.col, n); end if;
  end loop;
  select count(*) into n from vault.secrets where name like '%' || p::text || '%';
  if n > 0 then out := out || jsonb_build_object('vault', n); end if;
  select count(*) into n from storage.objects where name like p::text || '/%';
  if n > 0 then out := out || jsonb_build_object('storage', n); end if;
  return out;
end $$;
-- The ids of every row the person owns (a uuid id beside their user id), so a row that points at one is found too.
create or replace function er2test.owned(p uuid) returns uuid[] language plpgsql as $$
declare r record; got uuid[]; out uuid[] := array[p];
begin
  for r in select c.table_schema s, c.table_name t, u.column_name ucol from information_schema.columns c
      join information_schema.columns u on u.table_schema = c.table_schema and u.table_name = c.table_name and u.data_type = 'uuid' and u.column_name <> 'id'
      join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
      where x.table_type = 'BASE TABLE' and c.column_name = 'id' and c.data_type = 'uuid' and c.table_schema not in ('pg_catalog', 'information_schema', 'er2test', 'auth') loop
    execute format('select array_agg(id) from %I.%I where %I = $1', r.s, r.t, r.ucol) into got using p;
    if got is not null then out := out || got; end if;
  end loop;
  return out;
end $$;
-- Every column of every table: a uuid column holding one of the ids, any other column whose text matches the pattern.
create or replace function er2test.tied(ids uuid[], pat text) returns jsonb language plpgsql as $$
declare r record; n bigint; out jsonb := '{}';
begin
  for r in select c.table_schema s, c.table_name t, c.column_name col, c.data_type dt from information_schema.columns c
      join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
      where x.table_type = 'BASE TABLE' and c.table_schema not in ('pg_catalog', 'information_schema', 'er2test', 'pg_toast')
        and not (c.table_schema = 'vault' and c.column_name in ('secret', 'nonce', 'key_id')) loop
    if r.dt = 'uuid' then
      execute format('select count(*) from %I.%I where %I = any($1)', r.s, r.t, r.col) into n using ids;
    elsif r.dt in ('text', 'character varying', 'jsonb', 'json', 'ARRAY', 'USER-DEFINED') then
      execute format('select count(*) from %I.%I where %I::text ~ $1', r.s, r.t, r.col) into n using pat;
    else n := 0; end if;
    if n > 0 then out := out || jsonb_build_object(r.s || '.' || r.t || '.' || r.col, n); end if;
  end loop;
  return out;
end $$;`;

Deno.test({ name: `erase r2 end to end on Postgres: ${N} people delete their account, forget everything, disconnect or switch accounts mid-activity; the whole schema scanned`, sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const started = Date.now();
  const ENV: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: "fake-google-client-0000", GOOGLE_OAUTH_CLIENT_SECRET: "fake-google-secret-0000" };
  const realFetch = globalThis.fetch;
  const pg: Pg = await startPg();
  const conn = await PgConn.connect({ host: pg.host, port: pg.port });
  const conn2 = await PgConn.connect({ host: pg.host, port: pg.port });
  const conn3 = await PgConn.connect({ host: pg.host, port: pg.port });
  const step = async (name: string, fn: () => Promise<void>) => {
    const ok = await t.step(name, async () => { try { await fn(); } catch (e) { console.log(`STEP FAILED: ${name}\n${(e as Error)?.stack ?? e}`.slice(0, 4000)); throw e; } });
    if (!ok) throw new Error(`step failed: ${name}`);
  };
  try {
    await supabaseParity(pg);
    await pg.sql(`grant select, insert, update on public.agent_threads, public.agent_messages to service_role; grant usage, select on all sequences in schema public to service_role;`);
    await conn.query(HELPERS);
    const rows = async (sql: string): Promise<any[]> => JSON.parse((await conn.query(`select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (${sql}) x`))[0][0] ?? "[]");
    const one = async (sql: string) => (await rows(sql))[0];
    const rpc = serviceRpc(conn3);
    const double = postgrestDouble(pg, { url: SUPABASE_URL, serviceKey: SERVICE_KEY, users: {} });
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const all = [...PEOPLE, OTHER];
    const byToken = (tok: string) => all.find((p) => tok.endsWith(`-${p.id}`)) ?? null;

    // ---------------------------------------------------------------------------------------------- the providers, faked
    // Google's revoke (each person's answer), Google's token endpoint (gated for the refresh race), GoTrue's admin API and
    // Storage over the database, PostgREST through the double. Anything else is refused and logged.
    let seq = 0;
    const events: { at: number; what: string; user: string }[] = [];
    const revokes: { token: string; answer: string; at: number }[] = [];
    const outbound: string[] = [];
    let tokenGate: { arrived: () => void; release: Promise<void> } | null = null;
    const projectFetch = (async (input: any, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input, init);
      const u = new URL(req.url);
      if (req.url === GOOGLE_REVOKE) {
        const token = new URLSearchParams(await req.text()).get("token") ?? "";
        const p = byToken(token);
        const a = p ? p.revoke : 400;
        revokes.push({ token, answer: String(a), at: ++seq });
        if (a === "timeout") throw new DOMException("The signal has been aborted", "TimeoutError");
        if (a === "network") throw new TypeError("error sending request: connection reset");
        return new Response(a === 400 ? '{"error":"invalid_token"}' : "", { status: a as number });
      }
      if (req.url === "https://oauth2.googleapis.com/token") {
        const g = tokenGate;
        if (g) { tokenGate = null; g.arrived(); await g.release; }
        const rt = new URLSearchParams(await req.text()).get("refresh_token") ?? "";
        return new Response(JSON.stringify({ access_token: `ya29.FAKEnew-${rt.slice(-12)}`, expires_in: 3600 }), { status: 200 });
      }
      if (u.origin === SUPABASE_URL) {
        const m = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
        if (m && req.method === "DELETE") {
          const gone = (await conn.query(`with d as (delete from auth.users where id = ${q(m[1])} returning id) select id from d`)).filter((r) => r[0]);
          events.push({ at: ++seq, what: "deleted", user: m[1] });
          return gone.length ? new Response("{}", { status: 200 }) : new Response('{"msg":"User not found"}', { status: 404 });
        }
        if (m && req.method === "GET") {
          const has = await one(`select exists (select 1 from auth.users where id = ${q(m[1])}) as ok`);
          return has.ok ? new Response(JSON.stringify({ id: m[1] }), { status: 200 }) : new Response('{"msg":"User not found"}', { status: 404 });
        }
        if (u.pathname === "/storage/v1/object/list/career-resumes") {
          const b = await req.json();
          if (!/^[0-9a-f-]{36}\/$/.test(String(b.prefix))) return new Response("{}", { status: 400 });
          const objs = await rows(`select substr(name, ${String(b.prefix).length + 1}) as name from storage.objects where bucket_id = 'career-resumes' and name like ${q(`${b.prefix}%`)} order by name limit ${Number(b.limit) || 100}`);
          return new Response(JSON.stringify(objs), { status: 200 });
        }
        if (u.pathname === "/storage/v1/object/career-resumes" && req.method === "DELETE") {
          const b = await req.json();
          for (const name of b.prefixes ?? []) await conn.query(`delete from storage.objects where bucket_id = 'career-resumes' and name = ${q(name)}`);
          return new Response("[]", { status: 200 });
        }
        return double.fetch(req);
      }
      outbound.push(`${req.method} ${u.host}`);
      throw new Error(`a call left the test: ${u.host}`);
    }) as typeof fetch;
    globalThis.fetch = projectFetch; // nothing reaches a network: every call goes through the fakes above

    // The send worker (as #292's flow): Gmail faked; the token is the person's own only while their grant is there.
    const gmail = new FakeGmail();
    const outlookSent: { user: string; key: string; at: number }[] = [];
    let gate: { at: string; user: string; arrived: () => void; release: Promise<void> } | null = null;
    const pause = async (at: string, user: string) => { if (gate && gate.at === at && gate.user === user) { const g = gate; gate = null; g.arrived(); await g.release; } };
    const outlook: MailProviderLike = {
      async send(userId, _mail, o) {
        const c = await one(`select exists (select 1 from public.user_oauth_connections where user_id = ${q(userId)} and provider = 'microsoft') as ok`);
        if (!c.ok) return { status: "NOT_WIRED", reason: "Outlook is not connected" };
        outlookSent.push({ user: userId, key: o.idemKey, at: ++seq });
        return { status: "sent", id: null, thread_id: null };
      },
    };
    const vaultHas = async (u: string, p: string) => !!(await one(`select public.oauth_vault_read(${q(`oauth_${p}_${u}`)}) is not null and exists (select 1 from public.user_oauth_connections where user_id = ${q(u)} and provider = ${q(p)}) as ok`)).ok;
    const workerDeps = (now: () => number): WorkerDeps => ({
      rpc: serviceRpc(conn2).rpc, now, providers: { outlook },
      fetch: (async (i: any, init?: RequestInit) => {
        const res = await gmail.fetch(i, init);
        if (/messages\/send/.test(String(i?.url ?? i)) && res.ok) {
          const acct = String((i instanceof Request ? i.headers.get("authorization") : new Headers(init?.headers).get("authorization")) ?? "").replace(/^Bearer tok-send-/, "");
          events.push({ at: ++seq, what: "gmail-sent", user: acct });
          await pause("gmail-accepted", acct);
        }
        return res;
      }) as typeof fetch,
      token: async (u, scope) => {
        await pause("before-token", u);
        const ok = await vaultHas(u, "google_career");
        await pause("after-token", u);
        return ok ? `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}` : null;
      },
      drafts: async (u, ids) => ids.length ? await rows(`select * from public.career_outreach_drafts where user_id = ${q(u)} and id in (${ids.map(q).join(",")})`) : [],
    });

    // ---------------------------------------------------------------------------------------------- 1. the people
    const NOW = Date.now();
    const later = new Date(NOW + 30 * DAY).toISOString();
    const addr = (p: Person, k: string) => `p${p.id}-${k}@contacts.example`;
    const secret = (prov: string, p: Person, email: string, expired = false) => JSON.stringify({ refresh_token: `1//FAKErefresh-${prov}-${p.id}`, access_token: `ya29.FAKEaccess-${prov}-${p.id}`,
      expires_at: expired ? NOW - 3600e3 : NOW + 3600e3, email, scopes: SEND });
    const grant = async (p: Person, prov: string, scopes: string, email = `${prov}-${p.id}@example.test`) => {
      await conn.query(`select public.oauth_vault_store(${q(`oauth_${prov}_${p.uid}`)}, ${q(secret(prov, p, email, p.mid === "refresh"))});
        insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values (${q(p.uid)}, ${q(prov)}, ${q(`oauth_${prov}_${p.uid}`)}, ${q(email)}, ${q(scopes)})`);
    };
    const general = async (u: string, provider: "gmail" | "outlook", to: string, sendAt = later) => {
      const m = { to, subject: `Hello ${crypto.randomUUID().slice(0, 6)}`, text: "Would you have 15 minutes this week?" };
      const [r] = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m, provider, sendAt }]);
      if (r.status !== "queued") throw new Error(`setup: not queued ${JSON.stringify(r)}`);
      return r.id!;
    };
    const signUp = async (p: Person, u: string) => {
      await conn.query(`insert into auth.users (id, email) values (${q(u)}, ${q(p.email)}); insert into public.profiles (id) values (${q(u)});
        insert into public.career_watch_kv (user_id, key, value) values (${q(u)}, 'career:account', '{"epoch":0,"version":0,"paused":false}')`);
    };
    const hex = (s: string, n: number) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(n, "0").slice(0, n);
    const setup = async (p: Person) => {
      const u = p.uid;
      await signUp(p, u);
      if (p.gmail) await grant(p, "google_career", SEND);
      if (p.legacy) await grant(p, "gmail", "https://www.googleapis.com/auth/gmail.readonly");
      if (p.outlook) {
        await grant(p, "microsoft", "Mail.Read Mail.Send");
        await conn.query(`insert into public.career_outlook_state (user_id, email) values (${q(u)}, ${q(`microsoft-${p.id}@example.test`)})`);
      }
      for (let i = 0; i < p.approved; i++) {
        await conn.query(`insert into public.career_outreach_drafts (id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at)
          values (gen_random_uuid(), ${q(u)}, gen_random_uuid(), 1, '{"name":"Contact"}'::jsonb, ${q(addr(p, `a${i}`))}, 'A question', 'Hi', 'Sam', repeat('b', 64), 'approved', repeat('b', 64), now())`);
      }
      for (const mb of ["gmail", "outlook"] as const) for (let i = 0; i < p.queued[mb]; i++) await general(u, mb, addr(p, `${mb}${i}`));
      for (const mb of [p.gmail ? "gmail" : null, p.outlook ? "outlook" : null].filter(Boolean) as string[]) {
        const th = crypto.randomUUID();
        await conn.query(`insert into public.career_outreach_threads (id, user_id, provider, provider_thread, recipient_email, subject, sent_at, turns) values (${q(th)}, ${q(u)}, ${q(mb)}, ${q(`pt-${th}`)}, ${q(addr(p, `t${mb}`))}, 'Hello', now() - interval '3 days', ${1 + p.turns});
          insert into public.career_outreach_turns (thread_id, provider_msg, user_id, who, class, summary) values (${q(th)}, 'sent-1', ${q(u)}, 'person', 'sent', 'our note');
          ${Array.from({ length: p.turns }, (_, i) => `insert into public.career_outreach_turns (thread_id, provider_msg, user_id, who, class, summary) values (${q(th)}, 'in-${i}', ${q(u)}, 'contact', 'interested', 'they replied');`).join("\n")}`);
      }
      for (let i = 0; i < p.mail.events; i++) await conn.query(`insert into public.career_mail_events (user_id, application_ref, kind, company, stage, evidence, message_hash, mail_at) values (${q(u)}, 'mail:acme', 'received', 'Acme', 'Submitted', 'Acme: received', encode(sha256(convert_to(${q(`${u}-${i}`)}, 'UTF8')), 'hex'), now())`);
      if (p.mail.cursor) await conn.query(`insert into public.career_mail_cursors (user_id, read_through) values (${q(u)}, now())`);
      for (let i = 0; i < p.mail.outlook; i++) await conn.query(`insert into public.career_outlook_messages (user_id, message_hash, from_address, subject, received_at) values (${q(u)}, encode(sha256(convert_to(${q(`o-${u}-${i}`)}, 'UTF8')), 'hex'), 'maya@acme.example', 'Re: hi', now())`);
      if (p.parked) await conn.query(`select public.career_parked_park(${q(u)}, 'gmail', 'check my gmail', null, 'web', now())`);
      if (p.linked.telegram) await conn.query(`insert into public.channel_contacts (contact, user_id, created_at, updated_at) values (${q(`tg:${p.telegram}`)}, ${q(u)}, now(), now())`);
      for (let i = 0; i < p.outbox.alerts; i++) await conn.query(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`alert:job-${p.id}-${i}`)}, 'alert', 'A new role at Acme', now() - interval '1 minute')`);
      for (let i = 0; i < p.outbox.replies; i++) await conn.query(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`reply:msg-${p.id}-${i}`)}, 'reply', 'Here is what I found.', now() - interval '1 minute')`);
      if (p.linked.session) await conn.query(`insert into public.trainee_file_sessions (id_hash, user_id, via, phone, list, expires_at) values (${q(hex(`s${p.id}`, 64))}, ${q(u)}, 'phone', ${q(p.phone)}, ${q(hex(`l${p.id}`, 10))}, now() + interval '1 hour')`);
      if (p.linked.login) await conn.query(`insert into public.trainee_file_logins (jti, user_id, list, phone, expires_at) values (${q(hex(`j${p.id}`, 16))}, ${q(u)}, ${q(hex(`l${p.id}`, 10))}, ${q(p.phone)}, now() + interval '1 hour')`);
      if (p.linked.linkRequest) await conn.query(`insert into public.channel_link_requests (user_id, contact, phone, asked_on, created_at, expires_at) values (${q(u)}, ${q(p.phone)}, ${q(p.phone)}, ${q(`tg:${p.telegram}`)}, now(), now() + interval '1 hour')`);
      for (let i = 0; i < p.chat; i++) {
        const th = String((await conn.query(`with i as (insert into public.agent_threads (user_id, title) values (${q(u)}, 'Career') returning id) select id from i`))[0][0]);
        if (i === 0 && p.linked.telegram) await conn.query(`insert into public.channel_threads (channel, sender_key, thread_id) values ('telegram', ${q(p.telegram)}, ${q(th)});
          insert into public.channel_artifacts (user_id, thread_id, filename, mime, bytes_b64, expires_at) values (${q(u)}, ${q(th)}, 'resume.pdf', 'application/pdf', 'JVBERi0xLjQK', now() + interval '1 day')`);
      }
      for (let i = 0; i < p.files; i++) await conn.query(`insert into storage.objects (bucket_id, name) values ('career-resumes', ${q(`${u}/${hex(`f${p.id}-${i}`, 64)}.pdf`)})`);
      if (p.dnc) await conn.query(`insert into public.career_outreach_dnc (user_id, email_hash) values (${q(u)}, public.career_send_email_hash(${q(addr(p, "stop"))}));
        insert into public.career_send_bad_addresses (email_hash) values (public.career_send_email_hash(${q(addr(p, "bounced"))})) on conflict do nothing`);
      if (p.execRef) await conn.query(`select vault.create_secret('{}', ${q(`exec_cred_${u}_shop`)}, 'merchant credential'); insert into public.exec_credential_refs (user_id, merchant_key, vault_name) values (${q(u)}, 'shop', ${q(`exec_cred_${u}_shop`)})`);
    };
    const fp = async (u: string) => (await one(`select er2test.fp(${q(u)}) as f`)).f as Record<string, number>;
    const queueStates = async (u: string) => (await rows(`select provider, state, count(*)::int n from public.career_send_queue where user_id = ${q(u)} group by 1, 2 order by 1, 2`));

    const ownedBefore = new Map<string, string[]>();
    const fpBefore = new Map<string, Record<string, number>>();
    await step(`setup: ${N} people with what the generator gave them, and another person never touched`, async () => {
      for (const p of all) await setup(p);
      for (const p of all) ownedBefore.set(p.uid, (await one(`select to_jsonb(er2test.owned(${q(p.uid)})) as o`)).o);
      fpBefore.set(OTHER.uid, await fp(OTHER.uid));
      console.log(`[erase r2 e2e] ${all.length} people set up: ${PEOPLE.filter((p) => p.action === "delete_account").length} delete, ${PEOPLE.filter((p) => p.mid !== "none").length} with something running`);
    });

    // ---------------------------------------------------------------------------------------------- 2. the asks
    type Done = { p: Person; result?: any; words?: string; results?: any[]; at: number; fpBefore: Record<string, number>; qBefore: any[]; vaultBefore: string[]; mid?: any };
    const done = new Map<string, Done>();
    const vaultNames = async (u: string) => (await rows(`select name from vault.secrets where name like ${q(`%${u}%`)} order by name`)).map((r) => r.name);
    const ask = async (p: Person): Promise<Omit<Done, "fpBefore" | "qBefore" | "vaultBefore">> => {
      const u = p.uid;
      if (p.action === "delete_account") {
        const deps = () => restDeps(SUPABASE_URL, SERVICE_KEY, projectFetch, { sleep: async () => {} });
        if (p.mid === "twice_at_once") {
          const rs = await Promise.all([deleteAccount(deps(), u), deleteAccount(deps(), u)]);
          return { p, results: rs, result: rs[0], words: deletionWords(rs[0]), at: ++seq };
        }
        const r = await deleteAccount(deps(), u);
        return { p, result: r, words: deletionWords(r), at: ++seq };
      }
      if (p.action === "forget_everything") await conn.query(`update public.career_watch_kv set value = jsonb_build_object('epoch', 1, 'version', 9, 'paused', true) where user_id = ${q(u)} and key = 'career:account'`);
      else if (p.action === "disconnect_gmail") return { p, result: await disconnectGoogle(admin, u, { fetch: projectFetch, sleep: async () => {} }), at: ++seq };
      else if (p.action === "disconnect_outlook") return { p, result: await disconnectOutlook(admin as any, u), at: ++seq };
      else if (p.action === "switch_gmail" || p.action === "switch_outlook") {
        // The callback for another account: the new tokens, then the connection row upserted with the new address.
        const prov = p.action === "switch_gmail" ? "google_career" : "microsoft";
        const email = `${prov}-${p.id}-new@example.test`;
        await admin.rpc("oauth_vault_store", { p_name: `oauth_${prov}_${u}`, p_secret: JSON.stringify({ refresh_token: `1//FAKErefresh-new-${p.id}`, access_token: `ya29.FAKEaccess-new-${p.id}`, expires_at: NOW + 3600e3, email }) });
        const up = await admin.from("user_oauth_connections").upsert({ user_id: u, provider: prov, vault_name: `oauth_${prov}_${u}`, email, scopes: prov === "google_career" ? SEND : "Mail.Read Mail.Send", connected_at: new Date(NOW).toISOString() }, { onConflict: "user_id,provider" });
        if (up.error) throw new Error(`switch: ${up.error.message}`);
        if (prov === "microsoft") await admin.from("career_outlook_state").upsert({ user_id: u, email, needs_reconnect_at: null }, { onConflict: "user_id" });
      }
      return { p, at: ++seq };
    };
    const record = async (p: Person, run: () => Promise<Omit<Done, "fpBefore" | "qBefore" | "vaultBefore">>) => {
      const before = { fpBefore: await fp(p.uid), qBefore: await queueStates(p.uid), vaultBefore: await vaultNames(p.uid) };
      const d = await run();
      done.set(p.uid, { ...before, ...d });
    };

    await step("2a. the asks made while something of the person's is running (one at a time)", async () => {
      for (const p of PEOPLE.filter((x) => x.mid !== "none" && x.mid !== "twice_at_once")) {
        const u = p.uid;
        if (p.mid.startsWith("send")) {
          // A worker holds one email that is due now, and is paused before the token, after it, or after Gmail accepted it.
          const due = await general(u, "gmail", addr(p, "flying"), new Date(NOW - 60_000).toISOString());
          const mode = p.mid === "send_before_token" ? "before-token" : p.mid === "send_after_token" ? "after-token" : "gmail-accepted";
          let arrived!: () => void, release!: () => void;
          const there = new Promise<void>((r) => { arrived = r; });
          gate = { at: mode, user: u, arrived, release: new Promise<void>((r) => { release = r; }) };
          const worker = runSendWorker(workerDeps(() => NOW + 60_000), { worker: `w-${p.id}`, accounts: 1000, perAccount: 1, deadlineMs: 30_000 });
          await Promise.race([there, worker.then((st) => { throw new Error(`the worker finished without reaching ${mode} (#${p.id}): ${JSON.stringify(st)}`); })]);
          await record(p, () => ask(p));
          release();
          const st = await worker;
          done.get(u)!.mid = { due, mode, st };
        } else if (p.mid === "refresh") {
          // A token refresh is at Google (the stored access token expired) when the person asks.
          let arrived!: () => void, release!: () => void;
          const there = new Promise<void>((r) => { arrived = r; });
          tokenGate = { arrived, release: new Promise<void>((r) => { release = r; }) };
          const tok = careerTokenFor({ fetch: projectFetch, env: { get: (k: string) => ENV[k] }, now: () => NOW,
            connection: async (x) => (await admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", x).eq("provider", "google_career").maybeSingle()).data,
            readVault: async (n) => { const v = await admin.rpc("oauth_vault_read", { p_name: n }); return v.data ? String(v.data) : null; },
            writeVault: (n, s) => vaultRefreshWrite(admin, n, s, "save the refreshed career grant") }, CAREER_SEND_SCOPE)(u);
          await Promise.race([there, tok.then((x) => { throw new Error(`the refresh finished before reaching Google (#${p.id}): ${x}`); })]);
          await record(p, () => ask(p));
          release();
          const token = await tok.catch((e) => `threw: ${e?.message ?? e}`);
          done.get(u)!.mid = { token };
        } else if (p.mid === "delivery_alert" || p.mid === "delivery_reply") {
          // A delivery run has claimed the person's rows (job alerts and answers) when the deletion commits.
          if (p.mid === "delivery_reply") await conn.query(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`reply:late-${p.id}`)}, 'reply', 'Done.', now() - interval '1 minute') on conflict do nothing`);
          else await conn.query(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`alert:late-${p.id}`)}, 'alert', 'A new role.', now() - interval '1 minute') on conflict do nothing`);
          const base: any = supabaseChannelStore(admin, { user: u });
          const sent: string[] = [];
          const store = { ...base, alertWanted: undefined, due: async (now: number, limit: number) => { const got = await base.due(now, limit); await record(p, () => ask(p)); return got; } };
          const adapter = { channel: "telegram", limits: {}, render: (x: string) => [x], send: async (a: string) => { sent.push(a); events.push({ at: ++seq, what: "telegram", user: u }); return { ok: true, id: `m${seq}` }; } };
          const r = await deliverDue({ store, adapters: { telegram: adapter as any }, now: NOW + 1000 });
          await base.release?.().catch(() => 0);
          done.get(u)!.mid = { sent, r };
        }
      }
    });

    await step("2b. everyone else asks (in parallel, as people do)", async () => {
      const rest = PEOPLE.filter((p) => !done.has(p.uid));
      for (let i = 0; i < rest.length; i += 8) await Promise.all(rest.slice(i, i + 8).map((p) => record(p, () => ask(p))));
      eq(done.size, PEOPLE.length);
    });

    // ---------------------------------------------------------------------------------------------- 3. read back
    await step("3. each ask did exactly its scope, the replies are true, nothing went out after, nothing of a deleted person is left anywhere", async () => {
      const rep = new Report("scope and truth");
      const eraseTables = new Set(((await one(`select to_jsonb(public.career_erase_tables()) as k`)).k as string[]).map((x) => x.replace(/^public\./, "")));
      const deleted = PEOPLE.filter((p) => p.action === "delete_account");
      const esc = (s: string) => s.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&");
      const sorted = (o: Record<string, string>) => JSON.stringify(Object.entries(o ?? {}).sort());
      const hasLog = (await one(`select to_regclass('public.account_deletion_log') is not null as k`)).k; // read below; absent only on a schema before 20261030050000
      const logRows = hasLog ? (await one(`select count(*)::int n from public.account_deletion_log`)).n : -1;
      const logText = hasLog ? JSON.stringify(await rows(`select * from public.account_deletion_log`)) : "";
      for (const p of PEOPLE) {
        const d = done.get(p.uid)!, u = p.uid;
        const after = await fp(u);
        const changed = [...new Set([...Object.keys(d.fpBefore), ...Object.keys(after)])].filter((k) => (d.fpBefore[k] ?? 0) !== (after[k] ?? 0)).map((k) => k.split(".").slice(0, 2).join(".")).sort();
        const qAfter = await queueStates(u);
        const vAfter = await vaultNames(u);
        let why: string | null = null;
        const myRevokes = revokes.filter((r) => byToken(r.token)?.id === p.id);
        const wentAfter = events.filter((e) => e.user === u && e.at > d.at && (e.what === "gmail-sent" || e.what === "telegram"));
        const allowedSend = d.mid?.mode === "gmail-accepted" ? 0 : 0; // an email Gmail accepted was sent before the ask: its event is earlier
        if (p.action === "delete_account") {
          const tied = (await one(`select er2test.tied((select array_agg(x::uuid) from jsonb_array_elements_text(${q(JSON.stringify(ownedBefore.get(u)))}::jsonb) x), ${q(`${esc(u)}|${esc(p.email)}|${esc(p.phone)}|${esc(p.phone.slice(1))}|\\m${p.telegram}\\M`)}) as t`)).t;
          const results = d.results ?? [d.result];
          if (Object.keys(tied).length) why = `rows still tied to the person: ${JSON.stringify(tied)}`;
          else if (results.some((r: any) => !r.deleted)) why = `said not deleted: ${JSON.stringify(results.map((r: any) => r.failures))}`;
          else if ((why = results.map((r: any) => wordsWhy(r, deletionWords(r), { gone: true })).find(Boolean) ?? null)) { /* the words */ }
          else if ((p.gmail || p.legacy) && !myRevokes.length) why = "the Google grant was never revoked at Google";
          else if (myRevokes.some((r) => r.at > d.at)) why = "a revoke after the deletion";
          else if (myRevokes.some((r) => !new RegExp(`-(google_career|gmail)-${p.id}$`).test(r.token))) why = "only the person's own Google tokens are revoked";
          else if (sorted(results[0].google) !== sorted(Object.fromEntries([p.gmail ? "google_career" : null, p.legacy ? "gmail" : null].filter(Boolean).map((k) => [k, p.revoke === 200 ? "revoked" : p.revoke === 400 ? "refused" : "not_confirmed"])))) why = `Google outcomes: ${JSON.stringify(results[0].google)}`;
          else if (results[0].outlook !== p.outlook) why = "an Outlook grant is said";
          else if (wentAfter.length > allowedSend) why = `${wentAfter.length} message(s) went after the deletion: ${JSON.stringify(wentAfter)}`;
          else if (p.mid === "refresh" && d.mid?.token !== null) why = `the refresh that raced the deletion returned a token: ${d.mid?.token}`;
          else if (p.mid.startsWith("delivery") && d.mid?.sent?.length) why = `the delivery run sent ${d.mid.sent.length} to a deleted account`;
          else if (p.dnc && !(await one(`select exists (select 1 from public.career_outreach_dnc where user_id is null and email_hash = public.career_send_email_hash(${q(addr(p, "stop"))})) as k`)).k) why = "the opt-out hash is kept, with no owner";
          else if (p.dnc && !(await one(`select exists (select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash(${q(addr(p, "bounced"))})) as k`)).k) why = "the bounce hash is kept";
          if (!why && /ya29|FAKE|example\.test|5e2a0c1d/.test(logText)) why = "the deletion record names someone or holds a token";
          rep.grade(p, why, `${d.words ?? ""} ${JSON.stringify(results.map((r: any) => ({ g: r.google, f: r.failures })))}`);
          continue;
        }
        if (myRevokes.length && p.action !== "disconnect_gmail") why = "only a deletion or a Gmail disconnect revokes at Google";
        else if (p.action === "forget_everything") {
          const left = Object.keys(after).filter((k) => eraseTables.has(k.split(".")[1]) && k.startsWith("public."));
          const kept = ["public.user_oauth_connections", "public.agent_threads", "public.trainee_file_sessions", "public.trainee_file_logins", "public.channel_contacts", "vault", "storage"];
          const lost = kept.filter((k) => Object.keys(d.fpBefore).some((x) => x === k || x.startsWith(`${k}.`)) && !Object.keys(after).some((x) => x === k || x.startsWith(`${k}.`)));
          if (left.length) why = `forget everything left career records: ${left.join(", ")}`;
          else if (lost.length) why = `forget everything is not account deletion: it removed ${lost.join(", ")}`;
          else if (JSON.stringify(vAfter) !== JSON.stringify(d.vaultBefore)) why = "forget everything keeps the connections' tokens";
          else if (!(await one(`select exists (select 1 from auth.users where id = ${q(u)}) as k`)).k) why = "the account stays";
        } else if (p.action === "disconnect_gmail" || p.action === "switch_gmail" || p.action === "disconnect_outlook" || p.action === "switch_outlook") {
          const gm = /gmail/.test(p.action), mb = gm ? "gmail" : "outlook";
          const allowed = new Set(gm ? ["public.user_oauth_connections", "public.career_mail_events", "public.career_mail_drafts", "public.career_mail_cursors", "public.career_outreach_turns", "vault"]
            : ["public.user_oauth_connections", "public.career_outlook_messages", "public.career_outlook_state", "public.career_outreach_turns", "vault"]);
          if (/switch/.test(p.action)) allowed.delete("vault");
          const extra = changed.filter((k) => !allowed.has(k) && !(k === "public.career_send_queue" && p.mid.startsWith("send")));
          const otherBox = (x: any[]) => JSON.stringify(x.filter((r) => r.provider !== mb));
          const open = qAfter.filter((r) => r.provider === mb && (r.state === "queued" || r.state === "sending"));
          if (extra.length) why = `${p.action} changed more than its mailbox: ${extra.join(", ")}`;
          else if (otherBox(qAfter) !== otherBox(d.qBefore)) why = "the other mailbox's emails changed";
          else if (open.length) why = `emails still wait on the ${p.action.startsWith("switch") ? "old account" : "disconnected mailbox"}: ${JSON.stringify(open)}`;
          else if (wentAfter.length) why = `${wentAfter.length} message(s) went after the ask`;
          else if (p.action.startsWith("disconnect") && vAfter.some((n) => (gm ? /^oauth_(google_career|gmail)_/ : /^oauth_microsoft_/).test(n))) why = "the disconnected mailbox's token is left";
          else if (p.action.startsWith("disconnect") && JSON.stringify(vAfter.filter((n) => !(gm ? /^oauth_(google_career|gmail)_/ : /^oauth_microsoft_/).test(n))) !== JSON.stringify(d.vaultBefore.filter((n) => !(gm ? /^oauth_(google_career|gmail)_/ : /^oauth_microsoft_/).test(n)))) why = "another mailbox's token changed";
          else if (p.action.startsWith("switch")) {
            const prov = gm ? "google_career" : "microsoft";
            const v = await one(`select public.oauth_vault_read(${q(`oauth_${prov}_${u}`)}) as s`);
            const email = (() => { try { return JSON.parse(v.s).email; } catch { return null; } })();
            if (email !== `${prov}-${p.id}-new@example.test`) why = `the new account's tokens were overwritten (Vault holds ${email})`;
          }
          if (!why && p.mid === "refresh" && d.mid?.token !== null) why = `the refresh that raced ${p.action} returned a token: ${d.mid?.token}`;
          if (!why && p.action === "disconnect_gmail" && p.mid === "refresh" && vAfter.some((n) => /^oauth_google_career_/.test(n))) why = "the refresh wrote the token back after the disconnect";
        } else if (p.action === "none") {
          if (changed.length) why = `nothing was asked, yet ${changed.join(", ")} changed`;
        }
        if (!why && p.action === "forget_everything" && wentAfter.length) why = `${wentAfter.length} message(s) went after forget everything`;
        rep.grade(p, why, `${p.action} changed=${JSON.stringify(changed)} q=${JSON.stringify(qAfter)} v=${JSON.stringify(vAfter)} mid=${JSON.stringify(d.mid ?? null)}`);
      }
      const otherAfter = await fp(OTHER.uid);
      rep.assertClean();
      eq(otherAfter, fpBefore.get(OTHER.uid), "the other person's records are exactly as they were");
      eq(logRows, deleted.reduce((n, p) => n + (p.mid === "twice_at_once" ? 2 : 1), 0), "one deletion record per request");
      eq(outbound, [], "nothing left the test");
    });

    // ---------------------------------------------------------------------------------------------- 4. sign up again
    await step("4. signing up again with the same email, phone and Telegram gives a fresh, empty account; the opt-outs still refuse", async () => {
      const rep = new Report("sign up again");
      for (const p of PEOPLE.filter((x) => x.resignup)) {
        const fresh = crypto.randomUUID();
        await signUp(p, fresh);
        await conn.query(`insert into public.channel_contacts (contact, user_id, created_at, updated_at) values (${q(`tg:${p.telegram}`)}, ${q(fresh)}, now(), now());
          insert into public.trainee_file_logins (jti, user_id, list, phone, expires_at) values (${q(hex(`k${p.id}`, 16))}, ${q(fresh)}, ${q(hex(`m${p.id}`, 10))}, ${q(p.phone)}, now() + interval '1 hour')`);
        const f = await fp(fresh);
        const want = { "public.career_watch_kv.user_id": 1, "public.channel_contacts.user_id": 1, "public.profiles.id": 1, "public.trainee_file_logins.user_id": 1 };
        const quiet = (await one(`select public.career_user_quiet(${q(fresh)}) as k`)).k;
        const m = { to: addr(p, "stop"), subject: "Hello again", text: "One more note." };
        // The opt-out is global: anyone's new email to that address is refused (the other person, who has Gmail connected).
        const [r] = p.dnc ? await queueApproved(rpc, OTHER.uid, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m, provider: "gmail" }]) : [{ status: "refused", reason: "opted_out" }];
        const why = JSON.stringify(Object.entries(f).sort()) !== JSON.stringify(Object.entries(want).sort()) ? `the new account starts with more than its sign-up: ${JSON.stringify(f)}`
          : quiet ? "the new account inherits a pause" : `${r.status}:${(r as any).reason ?? ""}` !== "refused:opted_out" ? `the opt-out still refuses: ${JSON.stringify(r)}` : null;
        rep.grade(p, why, JSON.stringify(f));
      }
      rep.assertClean();
    });

    // ---------------------------------------------------------------------------------------------- 5. the send workers
    await step("5. every send worker runs until nothing is due (forty days on): nothing that waited on a removed mailbox goes; the other person's all go", async () => {
      const pending = new Map<string, Set<string>>();
      for (const p of PEOPLE) {
        const mb = p.action === "delete_account" || p.action === "forget_everything" ? null : /gmail/.test(p.action) ? "gmail" : /outlook/.test(p.action) ? "outlook" : null;
        if (mb) pending.set(p.uid, new Set((await rows(`select id from public.career_send_queue where user_id = ${q(p.uid)} and provider = ${q(mb)}`)).map((r) => r.id)));
      }
      let clock = NOW + 40 * DAY;
      const deps = workerDeps(() => (clock += 1000));
      for (let i = 0; i < 10; i++) { const st = await runSendWorker(deps, { worker: `final-${i}`, accounts: 50, perAccount: 50, deadlineMs: 900_000 }); if (!st.claims) break; }
      const rep = new Report("send workers");
      const sentRows = await rows(`select id, user_id, provider, result from public.career_send_queue where state = 'sent' and sent_at > now() - interval '1 hour'`);
      for (const p of PEOPLE) {
        const bad = sentRows.filter((r) => r.user_id === p.uid && (pending.get(p.uid)?.has(r.id) ?? false) && !/^sent before/.test(String(r.result ?? "")));
        const gone = (p.action === "delete_account" || p.action === "forget_everything") && events.some((e) => e.user === p.uid && e.what === "gmail-sent" && e.at > done.get(p.uid)!.at);
        rep.grade(p, bad.length ? `${bad.length} email(s) that waited on a removed mailbox went` : gone ? "an email went after the person's data was erased" : null, JSON.stringify(bad.slice(0, 2)));
      }
      rep.assertClean();
      const theirs = await one(`select count(*) filter (where state = 'sent')::int as sent, count(*)::int as n from public.career_send_queue where user_id = ${q(OTHER.uid)}`);
      eq(theirs.sent, theirs.n, "the other person's emails all went");
      eq(outbound, [], "nothing left the test");
      console.log(`[erase r2 e2e] Gmail ${gmail.sent.length}, Outlook ${outlookSent.length}, revokes ${revokes.length}; ${((Date.now() - started) / 1000).toFixed(1)} s`);
    });
  } finally {
    globalThis.fetch = realFetch;
    conn.close(); conn2.close(); conn3.close();
    await pg.stop();
  }
} });
