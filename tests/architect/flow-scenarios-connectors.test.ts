// Connectors, disconnect and erase end to end (owner rules, 2026-10-29): a seeded sample of the generated account states
// (tests/architect/scenarios/connectors-generator.ts, the same ones scenarios-connectors.test.ts runs over the store), each
// a person of their own on real Postgres 16 with every migration, through the REAL handler (handler-career.ts handleChat;
// harness tests/flow/handler.ts: real supabase-js over tests/flow/postgrest.ts). No model (CAREER_BRAIN and ANTHROPIC_API_KEY
// unset); Google's revoke endpoint, Gmail and Outlook are faked at the HTTP boundary; every other host is refused.
//   1. Each person has what the generator gave them: grants (Gmail, Outlook, the legacy finance grant) and their Vault
//      entries, a token state, approved emails, emails queued on the sending rail to N people from either mailbox (the
//      sequence's follow-ups included), the replies lane's approved follow-ups, threads with the contacts' turns and a
//      scheduled reply sync, mail read (Gmail events and cursor, Outlook messages), tasks parked on a connector; some have
//      a send worker holding one email when they disconnect (before it read the token, after, after Gmail accepted it, or
//      a worker that died). Another person emails the same addresses.
//   2. The person texts the generated ask ("disconnect google", "remove gmail access", "unlink outlook", "what's connected").
//      Google answers the revoke as generated (200, 400 invalid_token, 5xx, a timeout, a network failure). Read back from
//      the database: the reply says exactly what is true (Google's confirmation only on its 200; the cancelled count is
//      what waited before minus what waits after; an email in flight said as such); tokens, rows and mail read are gone;
//      nothing waits on that mailbox; the replies lane's mail and read position are erased; nobody else is touched.
//   3. Some connect again ("connect gmail" / "link my outlook": a one-time link; then the callback): every task parked on
//      that connector resumes exactly once (a replayed callback and the sweeper run nothing again); "check my gmail" while
//      disconnected is asked once with the link, then waits without a second link.
//   4. Some delete their account or say "forget everything": no personal row is left, the opt-out and bounce hashes stay
//      and still refuse anyone's new email to those addresses.
//   5. Every send worker runs until nothing is due (forty days on): nothing that waited on a disconnected mailbox is ever
//      sent, the email Gmail had already accepted went exactly once, and the other person's emails all go.
// Time: about 150 people, well under two minutes. Each step's outcome is decided by explicit instants, never by elapsed time.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { PgConn, serviceRpc } from "../flow/pgwire.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { FakeGmail } from "../flow/send-rail-fixture.ts";
import { admin as adminOf } from "./outlook-fixture.ts";
import { type Account, accounts, ASKS_SECRET, sampleAccounts } from "./scenarios/connectors-generator.ts";
import { messageOf, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { type MailProviderLike, queueApproved, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";
import { afterConnect, resumeDue } from "../../supabase/functions/_shared/connectors.ts";
import { GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";

const CI = Deno.env.get("CI") === "true";
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SAMPLE = 150;
const DAY = 86_400_000;
const ALL = accounts(20261029 + 2, 2500);
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const uidOf = (a: Account) => `7c0f8f8e-6a43-4a49-9d2c-${String(a.id).padStart(12, "0")}`;
const OTHER = "7c0f8f8e-6a43-4a49-9d2c-ffff00000001", LATE = "7c0f8f8e-6a43-4a49-9d2c-ffff00000002";
const SEND = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

type Failure = { a: Account; why: string; got: string };
class Report {
  total = 0; failures = new Map<string, Failure[]>();
  constructor(public path: string) {}
  grade(a: Account, why: string | null, got: string) {
    this.total++;
    if (!why) return;
    const k = `${a.ask}/${a.inFlight}/${a.gmail ? "g" : ""}${a.legacy ? "l" : ""}${a.outlook ? "o" : ""}`;
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ a, why, got });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((x, y) => x + y.length, 0);
    const lines = [`[connectors e2e] ${this.path}: ${this.total} people, ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((x, y) => y[1].length - x[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    #${x.a.id} ${JSON.stringify(x.a.phrase)} -> ${x.got.slice(0, 260)} (${x.why})`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | #${xs[0].a.id} ${JSON.stringify(xs[0].a.phrase)} -> ${xs[0].got.slice(0, 200)}`).join(" || ");
    eq(failed, 0, `${this.path}: ${failed} people went wrong: ${first}`);
  }
}

Deno.test({ name: `connectors end to end on Postgres through the real handler: ${SAMPLE} sampled people (disconnect, connect again, erase, send workers)`, sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const started = Date.now();
  const ENV: Record<string, string> = {
    GOOGLE_OAUTH_CLIENT_ID: "fake-google-client-0000", OAUTH_STATE_SECRET: "fake-state-secret-0000-xxxxxxxxxxxxxxxx", GMAIL_LINK_BASE: "https://proj.example.test/functions/v1/gmail-oauth",
    MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client-0000", MICROSOFT_OAUTH_CLIENT_SECRET: "fake-ms-secret-0000", OUTLOOK_LINK_BASE: "https://proj.example.test/functions/v1/outlook-oauth",
  };
  const UNSET = ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY"];
  const saved = Object.fromEntries([...Object.keys(ENV), ...UNSET].map((k) => [k, Deno.env.get(k)]));
  for (const k of UNSET) Deno.env.delete(k);
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
  const realFetch = globalThis.fetch;
  const pg: Pg = await startPg();
  const sessions = Array.from({ length: 4 }, () => psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! }));
  let rr = 0;
  const fast: Pg = { ...pg, sql: async (text: string) => (await sessions[rr++ % sessions.length].q(text)).join("\n").trim() };
  const conn = await PgConn.connect({ host: pg.host, port: pg.port });
  const conn2 = await PgConn.connect({ host: pg.host, port: pg.port });
  const conn3 = await PgConn.connect({ host: pg.host, port: pg.port }); // serviceRpc sets its session's role: raw reads stay on conn
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  // A step that fails stops the run (the later steps read what it should have left), and says why at once.
  const step = async (name: string, fn: () => Promise<void>) => {
    const ok = await t.step(name, async () => { try { await fn(); } catch (e) { console.log(`STEP FAILED: ${name}\n${(e as Error)?.stack ?? e}`.slice(0, 4000)); throw e; } });
    if (!ok) throw new Error(`step failed: ${name}`);
  };
  try {
    await supabaseParity(pg);
    await pg.sql(`grant select, insert, update on public.agent_threads, public.agent_messages to service_role; grant usage, select on all sequences in schema public to service_role;`);
    const rows = async (sql: string): Promise<any[]> => JSON.parse((await conn.query(`select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (${sql}) x`))[0][0] ?? "[]");
    const one = async (sql: string) => (await rows(sql))[0];
    const rpc = serviceRpc(conn3);
    const picked = sampleAccounts(ALL, SAMPLE, 2026);
    const people = new Map(picked.map((a) => [uidOf(a), a]));

    // ---------------------------------------------------------------------------------------------- the providers, faked
    const revokes: { token: string; answer: string }[] = [];
    const answerFor = (token: string): number | "timeout" | "network" => {
      const m = /-(\d+)$/.exec(token);
      const a = m ? picked.find((x) => x.id === Number(m[1])) : null;
      if (!a) return 400;
      return a.token === "revoked_at_provider" ? 400 : a.revoke;
    };
    const gmail = new FakeGmail();
    const outlookSent: { user: string; to: string; subject: string; key: string }[] = [];
    let gate: { at: string; user: string; arrived: () => void; release: Promise<void> } | null = null;
    const pause = async (at: string, user: string) => { if (gate && gate.at === at && gate.user === user) { const g = gate; gate = null; g.arrived(); await g.release; } };
    const outlook: MailProviderLike = {
      async send(userId, mail, o) {
        const c = await one(`select exists (select 1 from public.user_oauth_connections where user_id = ${q(userId)} and provider = 'microsoft') as ok`);
        if (!c.ok) return { status: "NOT_WIRED", reason: "Outlook is not connected" };
        outlookSent.push({ user: userId, to: mail.to, subject: mail.subject, key: o.idemKey });
        await pause("outlook-accepted", userId);
        return { status: "sent", id: null, thread_id: null };
      },
    };
    const vaultHas = async (u: string, p: string) => !!(await one(`select public.oauth_vault_read(${q(`oauth_${p}_${u}`)}) is not null and exists (select 1 from public.user_oauth_connections where user_id = ${q(u)} and provider = ${q(p)}) as ok`)).ok;
    // The worker's token: the person's own Vault entry while the grant is there (as careerTokenFor reads it), never otherwise.
    const workerDeps = (now: () => number): WorkerDeps => ({
      rpc: serviceRpc(conn2).rpc, fetch: gmail.fetch as typeof fetch, now, providers: { outlook },
      token: async (u, scope) => {
        await pause("before-token", u);
        const ok = await vaultHas(u, "google_career");
        await pause("after-token", u);
        return ok ? `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}` : null;
      },
      drafts: async (u, ids) => ids.length ? await rows(`select * from public.career_outreach_drafts where user_id = ${q(u)} and id in (${ids.map(q).join(",")})`) : [],
    });

    h = await careerHandler(fast, { ...Object.fromEntries(picked.map((a) => [`tok-${a.id}`, uidOf(a)])), "tok-other": OTHER });
    const viaDouble = globalThis.fetch;
    const outbound: string[] = [];
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (req.url === GOOGLE_REVOKE) {
        const token = new URLSearchParams(await req.text()).get("token") ?? "";
        const a = answerFor(token);
        revokes.push({ token, answer: String(a) });
        if (a === "timeout") throw new DOMException("The signal has been aborted", "TimeoutError");
        if (a === "network") throw new TypeError("error sending request: connection reset");
        return new Response(a === 400 ? '{"error":"invalid_token"}' : "", { status: a });
      }
      if (u.host === "supabase.test") return viaDouble(input, init);
      outbound.push(`${req.method} ${u.host}`);
      throw new Error(`a call left the test: ${u.host}`);
    }) as typeof fetch;

    // ---------------------------------------------------------------------------------------------- 1. the people
    const pendingRail = new Map<string, Set<string>>(); // person -> queue ids waiting on the mailbox they disconnect
    const NOW = Date.now();
    const later = new Date(NOW + 30 * DAY).toISOString();
    const tok = (p: string, a: Account) => JSON.stringify({ refresh_token: `1//FAKErefresh-${p}-${a.id}`, access_token: `ya29.FAKEaccess-${p}-${a.id}`, expires_at: a.token === "expired" ? NOW - 3600e3 : NOW + 3600e3 });
    const grant = async (u: string, a: Account, p: string, scopes: string, vault = true) => {
      if (vault) await conn.query(`select public.oauth_vault_store(${q(`oauth_${p}_${u}`)}, ${q(tok(p, a))})`);
      await conn.query(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values (${q(u)}, ${q(p)}, ${q(`oauth_${p}_${u}`)}, ${q(`${p}-${a.id}@example.test`)}, ${q(scopes)})
        on conflict (user_id, provider) do update set scopes = excluded.scopes`);
    };
    const addr = (a: Account, k: string) => `p${a.id}-${k}@contacts.example`;
    const general = async (u: string, provider: "gmail" | "outlook", to: string, o: { sendAt?: string; followUpOf?: string; subject?: string } = {}) => {
      const m = { to, subject: o.subject ?? `Hello from ${u.slice(-4)} ${crypto.randomUUID().slice(0, 6)}`, text: "Would you have 15 minutes this week?" };
      const [r] = await queueApproved(rpc, u, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m, provider, sendAt: o.sendAt ?? later, followUpOf: o.followUpOf ?? null }]);
      if (r.status !== "queued") throw new Error(`setup: not queued ${JSON.stringify(r)}`);
      return r.id!;
    };
    const draft = async (u: string, to: string, status = "approved") => {
      const d = { recipient: { name: "Contact", firm: "Example Co", email: to }, subject: `A question ${to.slice(0, 8)}`, body: "Hi,\n\nWould you have 15 minutes?", footer: "Sam\n\nReply stop and I won't write again." };
      const hash = await payloadHash(messageOf(d as any));
      const id = crypto.randomUUID();
      await conn.query(`insert into public.career_outreach_drafts (id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at)
        values (${q(id)}, ${q(u)}, gen_random_uuid(), 1, ${q(JSON.stringify(d.recipient))}::jsonb, ${q(to)}, ${q(d.subject)}, ${q(d.body)}, ${q(d.footer)}, ${q(hash)}, ${q(status)}, ${status === "approved" ? q(hash) : "null"}, ${status === "approved" ? "now()" : "null"})`);
      return { id, d, hash };
    };

    await step(`setup: ${picked.length} people with what the generator gave them, and another person emailing the same addresses`, async () => {
      for (const u of [OTHER, LATE, ...people.keys()]) {
        await conn.query(`insert into auth.users (id, email) values (${q(u)}, ${q(`${u.slice(-6)}@example.test`)}); insert into public.profiles (id) values (${q(u)});
          insert into public.career_watch_kv (user_id, key, value) values (${q(u)}, 'career:account', '{"epoch":0,"version":0,"paused":false}')`);
      }
      await grant(OTHER, picked[0], "google_career", SEND);
      await grant(LATE, picked[0], "google_career", SEND);
      for (const a of picked) {
        const u = uidOf(a);
        if (a.gmail) await grant(u, a, "google_career", SEND, a.vault.gmail);
        if (a.legacy) await grant(u, a, "gmail", "https://www.googleapis.com/auth/gmail.readonly", a.vault.legacy);
        if (a.outlook) await grant(u, a, "microsoft", "Mail.Read Mail.Send", a.vault.outlook);
        const refused = a.token === "revoked_at_provider" || a.token === "refresh_failing";
        if (a.outlook) await conn.query(`insert into public.career_outlook_state (user_id, needs_reconnect_at, needs_reconnect_reason) values (${q(u)}, ${refused ? "now()" : "null"}, ${refused ? "'invalid_grant'" : "null"})`);
        for (let i = 0; i < a.approved; i++) await draft(u, addr(a, `a${i}`));
        for (const mb of ["gmail", "outlook"] as const) for (let i = 0; i < a.queued[mb]; i++) await general(u, mb, addr(a, `${mb}${i}`));
        if (a.queuedOutreachOn) {
          const d = await draft(u, addr(a, "o"));
          const m = messageOf(d.d as any);
          const [r] = await queueApproved(rpc, u, [{ kind: "outreach", sourceId: d.id, approvalHash: d.hash, ...m, provider: a.queuedOutreachOn, sendAt: later }]);
          if (r.status !== "queued") throw new Error(`setup outreach: ${JSON.stringify(r)}`);
        }
        if (a.followups && a.gmail) {
          const root = crypto.randomUUID();
          await conn.query(`insert into public.career_send_queue (id, user_id, kind, source_id, approval_hash, idem_key, provider, recipient_email, subject, body, state, attempts, sent_at, gmail_id, gmail_thread)
            values (${q(root)}, ${q(u)}, 'general', gen_random_uuid(), repeat('a', 64), ${q(`general:root:${root}`)}, 'gmail', ${q(addr(a, "f"))}, 'First note', 'Hi', 'sent', 1, now(), ${q(`m-${root}`)}, ${q(`t-${root}`)})`);
          for (let i = 0; i < a.followups; i++) await general(u, "gmail", addr(a, "f"), { followUpOf: root, subject: `Re: First note ${i + 1}` });
        }
        // The replies lane: a thread on each mailbox the person has, the contact's turn read from it, an approved follow-up, the read position.
        for (const mb of [a.gmail ? "gmail" : null, a.outlook ? "outlook" : null].filter(Boolean) as ("gmail" | "outlook")[]) {
          const th = crypto.randomUUID();
          await conn.query(`insert into public.career_outreach_threads (id, user_id, provider, provider_thread, recipient_email, subject, sent_at, turns) values (${q(th)}, ${q(u)}, ${q(mb)}, ${q(`pt-${th}`)}, ${q(addr(a, `t${mb}`))}, 'Hello', now() - interval '3 days', ${a.mail.turns ? 1 + a.mail.turns : 1});
            insert into public.career_outreach_turns (thread_id, provider_msg, user_id, who, class, summary) values (${q(th)}, 'sent-1', ${q(u)}, 'person', 'sent', 'our note');
            ${Array.from({ length: a.mail.turns }, (_, i) => `insert into public.career_outreach_turns (thread_id, provider_msg, user_id, who, class, summary) values (${q(th)}, 'in-${i}', ${q(u)}, 'contact', 'interested', 'they replied');`).join("\n")}
            ${a.sync ? `insert into public.career_outreach_sync (user_id, provider, cursor, next_at) values (${q(u)}, ${q(mb)}, 'h-12345', now()) on conflict do nothing;` : ""}`);
          // One open follow-up per thread (career_outreach_actions_one_followup): each approved one on its own thread.
          for (let i = 0; i < a.actions; i++) {
            const th2 = crypto.randomUUID(), to = addr(a, `x${mb}${i}`);
            await conn.query(`insert into public.career_outreach_threads (id, user_id, provider, provider_thread, recipient_email, subject, sent_at) values (${q(th2)}, ${q(u)}, ${q(mb)}, ${q(`pt-${th2}`)}, ${q(to)}, 'Hello', now() - interval '3 days')`);
            const payload = { to, subject: "Re: Hello", text: `Following up ${i + 1}.`, thread: `pt-${th2}`, provider: mb, step: 1 };
            const hsh = await payloadHash({ to: payload.to, subject: payload.subject, text: payload.text });
            await conn.query(`insert into public.career_outreach_actions (user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at) values (${q(u)}, ${q(th2)}, 'followup', 1, gen_random_uuid(), 1, ${q(JSON.stringify(payload))}::jsonb, ${q(hsh)}, 'approved', ${q(hsh)}, now())`);
          }
        }
        if (a.gmail && refused) await conn.query(`insert into public.career_send_accounts (user_id, provider, state) values (${q(u)}, 'gmail', 'needs_reconnect') on conflict (user_id, provider) do update set state = 'needs_reconnect'`);
        for (let i = 0; i < a.mail.events; i++) await conn.query(`insert into public.career_mail_events (user_id, application_ref, kind, company, stage, evidence, message_hash, mail_at) values (${q(u)}, 'mail:acme', 'received', 'Acme', 'Submitted', 'Acme: received', encode(sha256(convert_to(${q(`${u}-${i}`)}, 'UTF8')), 'hex'), now())`);
        if (a.mail.cursor) await conn.query(`insert into public.career_mail_cursors (user_id, read_through) values (${q(u)}, now())`);
        for (let i = 0; i < a.mail.outlook; i++) await conn.query(`insert into public.career_outlook_messages (user_id, message_hash, from_address, subject, received_at) values (${q(u)}, encode(sha256(convert_to(${q(`o-${u}-${i}`)}, 'UTF8')), 'hex'), 'maya@acme.example', 'Re: hi', now())`);
        for (const need of a.parked) await conn.query(`select public.career_parked_park(${q(u)}, ${q(need)}, ${q(need === "outlook" ? "check my outlook" : need === "gmail" ? "check my gmail" : "check my email")}, null, 'web', now())`);
        // An erase keeps the opt-out and bounce lists: this person's contact said stop, another address bounced.
        if (a.erase !== "none") await conn.query(`insert into public.career_outreach_dnc (user_id, email_hash) values (${q(u)}, public.career_send_email_hash(${q(addr(a, "stop"))}));
          insert into public.career_send_bad_addresses (email_hash) values (public.career_send_email_hash(${q(addr(a, "bounced"))})) on conflict do nothing`);
        // The other person emails this person's first queued address too (in 30 days): never cancelled by this person's disconnect.
        await general(OTHER, "gmail", addr(a, "shared"));
      }
      eq((await one(`select count(*)::int n from public.career_send_queue where user_id = ${q(OTHER)} and state = 'queued'`)).n, picked.length);
    });

    // ---------------------------------------------------------------------------------------------- 2. the ask
    const waitingOf = async (u: string, mb: string) => one(`select
      (select count(*) from public.career_outreach_drafts d where d.user_id = ${q(u)} and d.status = 'approved' and not exists (select 1 from public.career_send_queue x
         where x.user_id = ${q(u)} and x.kind = 'outreach' and x.source_id = d.id and x.state in ('queued', 'sending') and x.provider <> ${q(mb)}))::int as approved,
      (select count(*) from public.career_send_queue x where x.user_id = ${q(u)} and x.provider = ${q(mb)} and x.state = 'queued'
         and not (x.kind = 'outreach' and exists (select 1 from public.career_outreach_drafts d where d.id = x.source_id and d.status = 'approved')))::int as queued,
      (select count(*) from public.career_outreach_actions x join public.career_outreach_threads h on h.id = x.thread_id where x.user_id = ${q(u)} and h.provider = ${q(mb)} and x.status in ('approved', 'running'))::int as actions,
      (select count(*) from public.career_send_queue x where x.user_id = ${q(u)} and x.provider = ${q(mb)} and x.state = 'sending')::int as sending`);
    const stateOf = async (u: string) => one(`select
      (select coalesce(jsonb_agg(provider order by provider), '[]') from public.user_oauth_connections where user_id = ${q(u)}) as providers,
      (select count(*) from vault.secrets where name like ${q(`oauth_%_${u}`)})::int as vault,
      (select count(*) from public.career_mail_events where user_id = ${q(u)})::int + (select count(*) from public.career_mail_cursors where user_id = ${q(u)})::int + (select count(*) from public.career_mail_drafts where user_id = ${q(u)})::int as gmail_mail,
      (select count(*) from public.career_outlook_messages where user_id = ${q(u)})::int as outlook_mail`);
    const accepted = new Map<string, string>(); // person -> the queue id Gmail (or Outlook) accepted while they disconnected
    const replies = new Map<string, any>();
    const rep = new Report("disconnect / what's connected");
    const judge = async (a: Account, r: { status: number; reply: string; intent: string | null; resultStatus: string | null }, before: any, w0: any) => {
      const u = uidOf(a), x = r.reply;
      if (r.status !== 200) return `HTTP ${r.status}`;
      if (ASKS_SECRET.test(x)) return "never asks for a password or a code";
      if (/\bya29\.|1\/\/FAKE|refresh_token|access_token|\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/.test(x)) return "a token or an internal code in the reply";
      const after = await stateOf(u);
      if (a.ask === "whats_connected") {
        if (r.intent !== "career_connectors_status") return `intent ${r.intent}`;
        const refused = a.token === "revoked_at_provider" || a.token === "refresh_failing";
        for (const [label, p] of [["Gmail", "google_career"], ["Outlook", "microsoft"]] as const) {
          const has = before.providers.includes(p);
          const want = !has ? `${label}: not connected.` : refused ? `${label}: needs reconnecting.` : `${label}: connected (`;
          if (!x.split("\n").some((l) => l.startsWith(want))) return `must say "${want}"`;
        }
        return JSON.stringify(after) === JSON.stringify(before) ? null : "\"what's connected\" changes nothing";
      }
      const label = a.ask === "gmail" ? "Gmail" : "Outlook";
      const provs = a.ask === "gmail" ? ["google_career", "gmail"] : ["microsoft"];
      const had = before.providers.filter((p: string) => provs.includes(p));
      const sender = had.includes(a.ask === "gmail" ? "google_career" : "microsoft");
      if (r.intent !== (a.ask === "gmail" ? "career_google_disconnect" : "career_outlook_disconnect")) return `intent ${r.intent}`;
      const success = new RegExp(`^${label} is disconnected\\.`).test(x), nothing = /there was nothing to disconnect/.test(x);
      const erasedOnly = /^No Google account is connected to Trainee, but I deleted|^Outlook isn't connected to Trainee, but I deleted the mail/.test(x);
      if (!(success || nothing || erasedOnly)) return "no database step fails here: disconnected, nothing to disconnect, or erased what an earlier connection saved";
      const left = after.providers.filter((p: string) => provs.includes(p));
      const mailLeft = a.ask === "gmail" ? after.gmail_mail : after.outlook_mail;
      const vaultLeft = (await one(`select count(*)::int n from vault.secrets where name in (${provs.map((p) => q(`oauth_${p}_${u}`)).join(",")})`)).n;
      if (left.length || vaultLeft || (a.ask === "gmail" && had.includes("google_career") && mailLeft) || (a.ask === "outlook" && mailLeft)) return "the read-back shows a row, a token or mail left";
      if (nothing && (had.length || (a.ask === "gmail" ? before.gmail_mail : before.outlook_mail))) return "said nothing to disconnect, but something was there";
      if (r.resultStatus !== (success || erasedOnly ? "completed" : "nothing")) return `result ${r.resultStatus}`;
      // Every other mailbox's rows stay.
      const others = before.providers.filter((p: string) => !provs.includes(p));
      if (JSON.stringify(after.providers) !== JSON.stringify(others)) return "another mailbox changed";
      if (a.ask === "gmail" && had.length) {
        const mine = revokes.filter((v) => v.token.endsWith(`-${a.id}`));
        const confirmed = had.every((p: string) => mine.some((v) => v.token.includes(`-${p}-`) && v.answer === "200"));
        if (/Google confirmed Trainee's access is revoked/.test(x) !== confirmed) return confirmed ? "Google answered 200: say it confirmed" : "never say Google confirmed a revoke it did not confirm";
        if (!confirmed && !/myaccount\.google\.com\/permissions/.test(x)) return "an unconfirmed revoke says where to remove access by hand";
        if (mine.some((v) => !/^(?:1\/\/FAKErefresh|ya29\.FAKEaccess)-(?:google_career|gmail)-\d+$/.test(v.token))) return "only this person's own tokens are revoked";
      }
      if (a.ask === "outlook" && success && (!/account\.live\.com\/consent\/Manage/.test(x) || /confirmed/i.test(x))) return "Outlook: where to remove the app, never a confirmed revoke";
      const w1 = await waitingOf(u, a.ask);
      if (sender && w1.approved + w1.queued + w1.actions + w1.sending) return `something still waits on the mailbox: ${JSON.stringify(w1)}`;
      const cancelled = Math.max(0, w0.approved - w1.approved) + Math.max(0, w0.queued - w1.queued) + Math.max(0, w0.actions - w1.actions);
      const m = /I also cancelled (\d+) approved emails? that hadn't gone yet/.exec(x);
      if (Number(m?.[1] ?? 0) !== (sender ? cancelled : 0)) return `the cancelled count must be the read-back's: ${sender ? cancelled : 0}`;
      const f = /(\d+) emails? (?:was|were) already being sent/.exec(x);
      if (Number(f?.[1] ?? 0) !== (sender ? w0.sending : 0)) return `an email a worker held is said as such: ${w0.sending}`;
      // The replies lane: what was read from that mailbox is erased; its approved follow-ups cancelled.
      if (sender) {
        const lane = await one(`select (select count(*) from public.career_outreach_turns x join public.career_outreach_threads h on h.id = x.thread_id where h.user_id = ${q(u)} and h.provider = ${q(a.ask)} and x.who <> 'person')::int as theirs,
          (select count(*) from public.career_outreach_sync where user_id = ${q(u)} and provider = ${q(a.ask)} and cursor is not null)::int as cursor,
          (select count(*) from public.career_outreach_actions x join public.career_outreach_threads h on h.id = x.thread_id where h.user_id = ${q(u)} and h.provider = ${q(a.ask)} and x.status not in ('cancelled', 'done', 'failed', 'refused'))::int as open`);
        if (lane.theirs || lane.cursor || lane.open) return `the replies lane keeps what was read or what was approved: ${JSON.stringify(lane)}`;
      }
      // The send rail: every email of this mailbox is cancelled; one Gmail accepted is the only one that may be sent.
      const open = await one(`select count(*)::int n from public.career_send_queue where user_id = ${q(u)} and provider = ${q(a.ask)} and state in ('queued', 'sending')`);
      if (sender && open.n) return "an email of this mailbox is still queued or held";
      return null;
    };

    const runAsk = async (a: Account) => {
      const u = uidOf(a);
      const before = await stateOf(u);
      const mb = a.ask === "whats_connected" ? "gmail" : a.ask;
      // The emails waiting on this mailbox now (any of them sent later is a failure, except one Gmail already accepted).
      // ("what's connected" disconnects nothing: nothing of theirs is held back.)
      if (a.ask !== "whats_connected") pendingRail.set(u, new Set((await rows(`select id from public.career_send_queue where user_id = ${q(u)} and provider = ${q(mb)} and state in ('queued', 'sending')`)).map((r) => r.id)));
      const w0 = await waitingOf(u, mb);
      const r = await h!.chat(`tok-${a.id}`).say(a.phrase);
      replies.set(u, r);
      rep.grade(a, await judge(a, r, before, w0).catch((e) => `judge threw: ${e?.message ?? e}`), `${r.resultStatus} ${r.intent}: ${r.reply.replace(/\s+/g, " ")}`);
    };

    await step("2a. a send worker holds one email when the person disconnects (before the token, after it, after Gmail accepted, or a worker that died)", async () => {
      // A Gmail account Google refused (needs_reconnect) is never claimed: no worker can hold its email.
      const flying = picked.filter((a) => a.inFlight !== "none" && ((a.ask === "gmail" && a.gmail && !["revoked_at_provider", "refresh_failing"].includes(a.token)) || (a.ask === "outlook" && a.outlook)));
      for (const a of flying) {
        const u = uidOf(a), mb = a.ask as "gmail" | "outlook";
        const due = await general(u, mb, addr(a, "flying"), { sendAt: new Date(NOW - 60_000).toISOString() });
        const mode = a.inFlight === "dead_worker" ? "dead" : mb === "outlook" ? "outlook-accepted" : a.inFlight === "before_token" ? "before-token" : a.inFlight === "after_token" ? "after-token" : "gmail-accepted";
        if (mode === "dead") {
          // A worker claims it and dies (its lease runs out later).
          const got = await rpc.rpc("career_send_claim", { p: { worker: "dead-worker", accounts: 1000, per_account: 5, lease_seconds: 120, now: new Date(Date.now() + 60_000).toISOString() } });
          const held = (got.data?.accounts ?? []).flatMap((x: any) => x.items.map((i: any) => i.id));
          eq(held, [due], `setup: the dying worker holds exactly this email (#${a.id})`);
          await runAsk(a);
          continue;
        }
        let arrived!: () => void, release!: () => void;
        const there = new Promise<void>((r) => { arrived = r; });
        gate = { at: mode === "gmail-accepted" ? "gmail-accepted" : mode, user: u, arrived, release: new Promise<void>((r) => { release = r; }) };
        gmail.afterAccept = mode === "gmail-accepted" ? (m) => { if (m.account === u) accepted.set(u, due); } : null;
        if (mode === "outlook-accepted") accepted.set(u, due);
        // Gmail accepted it: the worker is paused right after Gmail's answer, before it records the send.
        const fetchGate = gmail.fetch;
        const at = Date.now() + 60_000; // after the email was queued: it is due, and only it
        const deps = workerDeps(() => at);
        if (mode === "gmail-accepted") deps.fetch = (async (i: any, init?: RequestInit) => { const res = await fetchGate(i, init); if (/messages\/send/.test(String(i?.url ?? i))) await pause("gmail-accepted", u); return res; }) as typeof fetch;
        const worker = runSendWorker(deps, { worker: `w-${a.id}`, accounts: 1000, perAccount: 1, deadlineMs: 30_000 });
        await Promise.race([there, worker.then((st) => { throw new Error(`the worker finished without reaching ${mode} (#${a.id}): ${JSON.stringify(st)}`); })]);
        await runAsk(a);
        release();
        await worker;
        gmail.afterAccept = null;
        const row = await one(`select state, lease_owner from public.career_send_queue where id = ${q(due)}`);
        const went = mode === "gmail-accepted" ? gmail.sent.filter((m) => m.account === u).length : outlookSent.filter((m) => m.key === `send:${due}`).length;
        const wantWent = mode === "gmail-accepted" || mode === "outlook-accepted" ? 1 : 0;
        rep.grade(a, went !== wantWent ? `${mode}: sent ${went}, must be ${wantWent}` : row.state !== (wantWent ? "sent" : "cancelled") || row.lease_owner ? `${mode}: the row must read ${wantWent ? "sent" : "cancelled"} with no holder` : null, JSON.stringify(row));
      }
    });

    await step("2b. everyone else texts their ask (in parallel, as people do)", async () => {
      const rest = picked.filter((a) => !replies.has(uidOf(a)));
      for (let i = 0; i < rest.length; i += 16) await Promise.all(rest.slice(i, i + 16).map(runAsk));
      eq(replies.size, picked.length);
      rep.assertClean();
    });

    // ---------------------------------------------------------------------------------------------- 3. connect again
    const ad = adminOf(fast);
    const resumed: string[] = [];
    const after = { admin: ad, env: { get: (k: string) => ENV[k] }, fetch: globalThis.fetch, now: () => NOW + 60_000,
      runTurn: async (x: { userId: string; turnKey: string }) => { resumed.push(`${x.userId}|${x.turnKey}`); return { reply: "Read your mail: nothing new.", persisted: false }; } };
    await step("3. connect again from a one-time link; every parked task resumes exactly once; while disconnected a task is asked once with the link", async () => {
      const rep3 = new Report("connect again");
      const back = picked.filter((a) => a.reconnect && a.ask !== "whats_connected" && ((a.ask === "gmail" && a.gmail) || (a.ask === "outlook" && a.outlook)) && /is disconnected\./.test(replies.get(uidOf(a))?.reply ?? ""));
      for (const a of back) {
        const u = uidOf(a), chat = h!.chat(`tok-${a.id}`);
        let why: string | null = null;
        // While disconnected: the task asks once, with the link, unless one already waits for the same connector.
        const need = a.ask === "gmail" ? "check my gmail" : "check my outlook";
        const waiting = a.parked.some((p) => p === a.ask || p === "mail");
        const r1 = await chat.say(need), r2 = await chat.say(need);
        const link1 = /\?t=[A-Za-z0-9_-]{32}/.test(r1.reply), link2 = /\?t=[A-Za-z0-9_-]{32}/.test(r2.reply);
        if (r1.intent !== "career_connector_need" || link1 === waiting || r2.resultStatus !== "waiting" || link2) why = `asked once with a link (${waiting ? "a task already waited" : "first ask"}): ${r1.resultStatus}/${link1} then ${r2.resultStatus}/${link2}`;
        if (ASKS_SECRET.test(r1.reply + r2.reply)) why = "never asks for a password or a code";
        // "connect gmail" / "link my outlook": a one-time link from the chat.
        const c = await chat.say(a.ask === "gmail" ? "connect gmail" : "link my outlook");
        const t1 = /\?t=([A-Za-z0-9_-]{32})/.exec(c.reply)?.[1];
        if (!why && !t1) why = `connect gives a one-time link: ${c.reply.slice(0, 120)}`;
        if (!why && ASKS_SECRET.test(c.reply)) why = "the connect link never asks for a password or a code";
        // The callback: the grant stored, then afterConnect resumes what waited (twice: a replayed callback runs nothing).
        if (a.ask === "gmail" && t1) await ad.rpc("career_connector_link_open", { p_nonce: t1, p_now: new Date(NOW + 30_000).toISOString() });
        await grant(u, a, a.ask === "gmail" ? "google_career" : "microsoft", a.ask === "gmail" ? SEND : "Mail.Read Mail.Send");
        if (a.ask === "outlook") await conn.query(`update public.career_outlook_state set needs_reconnect_at = null where user_id = ${q(u)}`);
        const tasks = await rows(`select id, need from public.career_parked_tasks where user_id = ${q(u)} and status in ('waiting', 'resuming')`);
        const due = tasks.filter((x) => x.need === a.ask || x.need === "mail").map((x) => x.id).sort();
        const r = await afterConnect(after as any, u, a.ask as any, { email: `${a.ask}-${a.id}@example.test`, scopes: [] });
        const again = await afterConnect(after as any, u, a.ask as any, { email: `${a.ask}-${a.id}@example.test`, scopes: [] });
        const ran = resumed.filter((x) => x.startsWith(`${u}|`)).map((x) => x.split("|resume:")[1]).sort();
        if (!why && (r.resumed !== due.length || again.resumed !== 0 || JSON.stringify(ran) !== JSON.stringify(due))) why = `every waiting task resumes exactly once: ran ${JSON.stringify(ran)} of ${JSON.stringify(due)}`;
        const left = await one(`select count(*)::int n from public.career_parked_tasks where user_id = ${q(u)} and status in ('waiting', 'resuming') and need in (${q(a.ask)}, 'mail')`);
        if (!why && left.n) why = "a task for this connector still waits";
        rep3.grade(a, why, `${r1.resultStatus} | ${r2.resultStatus} | ${c.resultStatus} | resumed ${r.resumed}+${again.resumed}`);
      }
      const swept = await resumeDue(after as any, 500);
      eq(resumed.length - new Set(resumed).size, 0, "no task ever runs twice (the callbacks, their replays and the sweeper)");
      console.log(`[connectors e2e] connected again: ${back.length} people, ${resumed.length} tasks resumed, sweeper ${swept.resumed}`);
      rep3.assertClean();
    });

    // ---------------------------------------------------------------------------------------------- 4. erase
    await step("4. delete the account, or forget everything: no personal row left; the opt-out and bounce hashes stay and still refuse anyone", async () => {
      const rep4 = new Report("erase");
      const tables = await rows(`select c.table_schema || '.' || c.table_name as t from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
        where x.table_type = 'BASE TABLE' and c.column_name = 'user_id' and c.table_schema in ('public', 'career_message_approval_private') order by 1`);
      const kept = (await one(`select to_jsonb(public.career_erase_kept_tables()) as k`)).k as string[];
      for (const a of picked.filter((x) => x.erase !== "none")) {
        const u = uidOf(a);
        if (a.erase === "account_delete") await conn.query(`delete from auth.users where id = ${q(u)}`);
        else await conn.query(`update public.career_watch_kv set value = jsonb_build_object('epoch', 1, 'version', 9, 'paused', true) where user_id = ${q(u)} and key = 'career:account'`);
        const leftover: string[] = [];
        for (const { t: tb } of tables) {
          const name = tb.split(".")[1];
          if (a.erase === "forget_everything" && (!/^(career_|channel_|extension_)/.test(name) || kept.includes(name))) continue;
          const n = (await one(`select count(*)::int n from ${tb} where user_id = ${q(u)}`)).n;
          if (n) leftover.push(`${name}:${n}`);
        }
        if (a.erase === "account_delete") {
          const v = (await one(`select count(*)::int n from vault.secrets where name like ${q(`%${u}%`)}`)).n;
          if (v) leftover.push(`vault:${v}`);
        }
        const hashes = await one(`select exists (select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash(${q(addr(a, "stop"))})) as stop,
          exists (select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash(${q(addr(a, "bounced"))})) as bounced`);
        const items = [];
        for (const k of ["stop", "bounced"]) { const m = { to: addr(a, k), subject: "Hello again", text: "One more note." }; items.push({ kind: "general" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m, provider: "gmail" as const }); }
        const refused = (await queueApproved(rpc, LATE, items)).map((r) => `${r.status}:${r.reason ?? ""}`);
        const why = leftover.length ? `personal rows left: ${leftover.join(", ")}` : !hashes.stop || !hashes.bounced ? `the opt-out and bounce hashes stay: ${JSON.stringify(hashes)}`
          : JSON.stringify(refused) !== JSON.stringify(["refused:opted_out", "refused:bad_address"]) ? `anyone's new email to them is refused: ${JSON.stringify(refused)}` : null;
        rep4.grade(a, why, `${a.erase}: ${leftover.join(", ")} ${JSON.stringify(hashes)} ${JSON.stringify(refused)}`);
      }
      rep4.assertClean();
    });

    // ---------------------------------------------------------------------------------------------- 5. the send workers
    await step("5. every send worker runs until nothing is due (forty days on): nothing that waited on a disconnected mailbox goes; the other person's all go", async () => {
      // The clock moves a second per reading, from forty days on: every email queued in thirty days is due, a handed-back
      // one comes due again a minute later, and the run is bounded by its own deadline, never by the wall clock.
      let clock = NOW + 40 * DAY;
      const deps = workerDeps(() => (clock += 1000));
      let sent = 0;
      for (let i = 0; i < 10; i++) { const st = await runSendWorker(deps, { worker: `final-${i}`, accounts: 50, perAccount: 50, deadlineMs: 900_000 }); sent += st.sent; if (!st.claims) break; }
      const went = await rows(`select id, user_id, provider, state, result from public.career_send_queue where state = 'sent'`);
      const rep5 = new Report("send workers");
      for (const a of picked) {
        const u = uidOf(a), pend = pendingRail.get(u) ?? new Set<string>();
        const bad = went.filter((r) => r.user_id === u && pend.has(r.id) && r.id !== accepted.get(u));
        rep5.grade(a, bad.length ? `${bad.length} email(s) that waited on the disconnected mailbox went: ${JSON.stringify(bad[0])}` : null, JSON.stringify(bad.slice(0, 2)));
      }
      rep5.assertClean();
      const sends = new Map<string, number>();
      for (const m of gmail.sent) sends.set(`${m.account}|${m.to}|${m.subject}`, (sends.get(`${m.account}|${m.to}|${m.subject}`) ?? 0) + 1);
      for (const m of outlookSent) sends.set(`o|${m.key}`, (sends.get(`o|${m.key}`) ?? 0) + 1);
      eq([...sends.entries()].filter(([, n]) => n > 1), [], "every email at most once");
      const theirs = await one(`select count(*) filter (where state = 'sent')::int as sent, count(*)::int as n from public.career_send_queue where user_id = ${q(OTHER)}`);
      eq(theirs.sent, theirs.n, "the other person's emails to the same addresses all went: nobody else's disconnect touched them");
      eq(outbound, [], "nothing left the test");
      console.log(`[connectors e2e] workers sent ${sent}; Gmail ${gmail.sent.length}, Outlook ${outlookSent.length}; ${((Date.now() - started) / 1000).toFixed(1)} s`);
    });
  } finally {
    h?.restore();
    globalThis.fetch = realFetch;
    for (const s of sessions) await s.close().catch(() => {});
    conn.close(); conn2.close(); conn3.close();
    await pg.stop();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
} });
