// Connectors, disconnect and erase, round 4, end to end (owner rules, 2026-11-05): a seeded sample of the generated scenarios
// (tests/architect/scenarios/connectors-r4-generator.ts, the same families scenarios-connectors-r4.test.ts runs in memory),
// each person of their own on real Postgres 16 with every migration, through the real code: the scheduled Gmail run (runMail
// over supabaseMailStore and supabaseAlertStore), the delivery run (deliverDue over supabaseChannelStore), "disconnect
// gmail" (disconnectGoogle), "disconnect outlook" (disconnectOutlook), a connect (oauth_connect_commit, as the callbacks
// call it), the token readers (careerTokenFor, outlookToken over vaultRefreshWrite) and delete-account (deleteAccount over
// restDeps). Google's token and revoke endpoints, GoTrue's admin API and Storage are faked at the HTTP boundary; anything else
// is refused. No model, no network.
//   1. Mail runs: a person disconnects or connects another Google account at the k-th request the run makes to the
//      database; read back: nothing read from that mailbox is queued, recorded or kept as a read position after it; the
//      person was told "Gmail is disconnected" only when the row and tokens are gone; the people beside are whole.
//      Outlook's sync, the same, read back from career_outlook_messages.
//   2. Deliveries: the person disconnects, switches, reconnects the same account, disconnects Outlook or deletes their
//      account while the run holds their row k: no text made from that mailbox, and nothing at all to a deleted account,
//      goes after it; every other row is delivered once; nothing is left claimed.
//   3. Refreshes: the person disconnects, reconnects the same account, consents again, switches or deletes their account
//      while a refresh is at Google's (or Microsoft's) token endpoint: the refreshed token is not used, the new grant's Vault
//      entry is exactly what its connect stored, a gone connection has no Vault entry.
//   4. Erase and retry: an account deletion whose first attempt fails (the ledger purge, the auth delete, Storage) and is asked
//      again; another person's approved outreach to this person's address: every answer true when given, the last leaves no
//      row, Vault entry or file of the person, and the other person's outreach is exactly as it was.
// Every check is read from the database. Time: well under a minute.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { approvedDrafts, CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { deliveries, fakeTok, fromMailbox, GMAIL_READ, hexOf, keyOf, type KeyKind, mailruns, refreshes, uidOf } from "./scenarios/connectors-r4-generator.ts";
import { wordsWhy } from "./scenarios/erase-r2-check.ts";
import { deliverDue, mailboxText } from "../../supabase/functions/_shared/channel.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { disconnectGoogle, disconnectReply, GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { disconnectOutlook, syncInbox, tokenDeps } from "../../supabase/functions/_shared/outlook_connector.ts";
import { careerTokenFor } from "../../supabase/functions/_shared/career_mail_gmail.ts";
import { outlookToken } from "../../supabase/functions/_shared/outlook_graph.ts";
import { vaultRefreshWrite } from "../../supabase/functions/_shared/oauth_vault_refresh.ts";
import { deleteAccount, deletionWords, restDeps } from "../../supabase/functions/_shared/account_delete.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261105;
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();
const ENV: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: "fake-google-client-0004", GOOGLE_OAUTH_CLIENT_SECRET: ["fake", "google", "secret", "0004"].join("-"),
  MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client-0004", MICROSOFT_OAUTH_CLIENT_SECRET: ["fake", "ms", "secret", "0004"].join("-") };
const env = { get: (k: string) => ENV[k] };
const MS_SCOPES = "openid email offline_access User.Read Mail.Read Mail.Send";
const AUTH = ["mx.google.com; dkim=pass header.i=@greenhouse.io header.s=s1; spf=pass smtp.mailfrom=greenhouse.io; dmarc=pass (p=REJECT) header.from=greenhouse.io"];
const APP = { ref: "track:a1", company: "Asana", role: "Account Manager", stage: "Submitted", source: "tracker" as const, applied_at: iso(NOW - 864e6), events: [] };
const rejection = (tag: string, i: number) => ({ hash: hexOf(`${tag}-mail-${i}`), from: "Asana <no-reply@greenhouse.io>", subject: "Your Asana application",
  snippet: "Unfortunately, we have decided not to move forward with your application.", date: iso(NOW - 120_000 - i * 1000), auth: AUTH });
// The e2e delivery uses the kinds whose delivery needs no other settings (alerts and receipts read the alert settings, a chat
// reminder its zone's quiet hours): every kind made from mail, and these.
const E2E_OTHER: KeyKind[] = ["connect_status", "outlook_status", "outreach_followup", "reply", "digest", "daily_brief"];

Deno.test({ name: "connectors r4 end to end on Postgres: mail runs and deliveries racing a disconnect, a switch or a deletion; refreshes landing after a reconnect; an erase retried", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const started = Date.now();
  const db = await railDb();
  const failures: string[] = [];
  let graded = 0;
  const grade = (label: string, why: string | null) => { graded++; if (why) failures.push(`${label}: ${why}`); };
  const step = async (name: string, fn: () => Promise<void>) => {
    const ok = await t.step(name, async () => { try { await fn(); } catch (e) { console.log(`STEP FAILED: ${name}\n${(e as Error)?.stack ?? e}`.slice(0, 4000)); throw e; } });
    if (!ok) throw new Error(`step failed: ${name}`);
  };
  const realFetch = globalThis.fetch;
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: SUPABASE_URL, serviceKey: SERVICE_KEY, users: {} });
    // The run under test reaches the database through `hooked` (a hook may fire an event before a request goes); the event
    // itself, and every check, through `plain`.
    let hook: (() => Promise<void>) | null = null;
    const hooked = (async (i: any, init?: RequestInit) => { if (hook) await hook(); return double.fetch(i, init); }) as typeof fetch;
    const client = (f: typeof fetch) => createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: f }, auth: { persistSession: false, autoRefreshToken: false } });
    const admin: any = client(hooked), plain: any = client(double.fetch as typeof fetch);
    const one = async (sql: string) => (await rows(db, sql))[0];
    const revokes: string[] = [];
    const googleFake = (async (i: any, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i.url;
      if (url === GOOGLE_REVOKE) { revokes.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? ""); return new Response("", { status: 200 }); }
      throw new Error(`a call left the test: ${url}`);
    }) as typeof fetch;
    globalThis.fetch = (async (i: any) => { throw new Error(`a call left the test: ${typeof i === "string" ? i : i?.url}`); }) as typeof fetch;
    const addPerson = async (u: string, phone: string) => {
      await db.sql.query(`insert into auth.users(id, email) values (${q(u)}, ${q(`${u.slice(-6)}@users.example.test`)});
        insert into public.profiles(id) values (${q(u)}) on conflict do nothing;
        insert into public.channel_contacts(contact, user_id, home) values (${q(phone)}, ${q(u)}, true);`);
    };
    const connect = async (u: string, provider: "google_career" | "microsoft", email: string, tag: string, expired = false) => {
      const scopes = provider === "microsoft" ? MS_SCOPES : `openid email ${GMAIL_READ}`;
      const r = await plain.rpc("oauth_connect_commit", { p_user: u, p_provider: provider, p_email: email, p_scopes: scopes, p_now: iso(NOW),
        p_secret: JSON.stringify({ access_token: fakeTok("access", tag), refresh_token: fakeTok("refresh", tag), expires_at: expired ? NOW - 3_600_000 : NOW + 3_600_000, email, scopes }) });
      if (r.error || r.data !== "connected") throw new Error(`setup: connect ${u} ${provider}: ${r.error?.message ?? r.data}`);
      if (provider === "microsoft") await db.sql.query(`insert into public.career_outlook_state(user_id) values (${q(u)}) on conflict do nothing`);
    };
    const disconnectG = async (u: string) => {
      const r = await disconnectGoogle(plain, u, { fetch: googleFake, sleep: async () => {} });
      const words = disconnectReply(r);
      const left = await one(`select (select count(*) from public.user_oauth_connections where user_id = ${q(u)} and provider in ('google_career','gmail'))::int as rows,
        (public.oauth_vault_read(${q(`oauth_google_career_${u}`)}) is not null) as vault`);
      grade(`disconnect ${u.slice(-6)}`, /Gmail is disconnected/.test(words) !== (left.rows === 0 && !left.vault) ? `said "${words.slice(0, 80)}" with ${JSON.stringify(left)}` : null);
    };
    const pendingMailbox = async (u: string) => (await rows(db, `select key from public.career_outbox where user_id = ${q(u)} and delivered_at is null`)).map((r: any) => String(r.key)).filter(mailboxText);

    // ---------------------------------------------------------------------------------------------- 1. mail runs
    await step("1. mail runs: a disconnect or a switch at any request the run makes", async () => {
      const sample = mailruns(SEED + 52, 14);
      const people = sample.map((x, i) => ({ ...x, phone: `+1557${String(i).padStart(7, "0")}` }));
      const bystanders = [uidOf(250_001), uidOf(250_002)];
      for (const [i, p] of people.entries()) { await addPerson(p.uid, p.phone); await connect(p.uid, "google_career", `${p.uid.slice(-6)}@example.test`, `m${i}`); }
      for (const [i, u] of bystanders.entries()) { await addPerson(u, `+1558000000${i}`); await connect(u, "google_career", `${u.slice(-6)}@example.test`, `mb${i}`); }
      let running: string | null = null, calls = 0;
      const fired = new Set<string>();
      hook = async () => {
        const p = people.find((x) => x.uid === running);
        if (!p || p.event === "none" || fired.has(p.uid)) return;
        if (++calls !== p.at) return;
        fired.add(p.uid);
        if (p.event === "disconnect") await disconnectG(p.uid);
        else await connect(p.uid, "google_career", `${p.uid.slice(-6)}.work@example.test`, `${p.id}-2`);
      };
      const base = supabaseMailStore(admin);
      await runMail({ outbox: supabaseAlertStore(admin), now: NOW, store: { ...base, applications: async () => [structuredClone(APP)] }, batch: 1, read: async (u) => {
        running = u; calls = 0;
        const n = people.find((x) => x.uid === u)?.mails ?? 2;
        return { status: "ok", mails: Array.from({ length: n }, (_, i) => rejection(u.slice(-6), i)), readThrough: NOW, listed: n };
      } });
      hook = null;
      for (const p of people) {
        const left = await pendingMailbox(p.uid);
        const ev = Number((await one(`select count(*)::int as n from public.career_mail_events where user_id = ${q(p.uid)}`)).n);
        const cur = await one(`select read_through from public.career_mail_cursors where user_id = ${q(p.uid)}`);
        let why: string | null = null;
        if (fired.has(p.uid)) {
          if (left.length) why = `${left.length} text(s) read from the mailbox queued after "${p.event}": ${left.join(",").slice(0, 80)}`;
          else if (ev) why = `${ev} status event(s) from the mailbox kept after "${p.event}"`;
          else if (cur && p.event === "switch") why = "the old mailbox's read position was saved for the new account";
        } else if (!left.length || !ev) why = "a run with nothing withdrawn did not record and say what it read";
        grade(`mailrun #${p.id} ${p.event} at ${p.at}${fired.has(p.uid) ? "" : " (not reached)"}`, why);
      }
      for (const u of bystanders) grade(`mailrun bystander ${u.slice(-6)}`, (await pendingMailbox(u)).length ? null : "the person beside lost their texts");
      grade("mailrun sample reaches the events", [...fired].length >= 4 ? null : `only ${fired.size} events fired`);
    });

    await step("1b. Outlook's sync: a disconnect or another Microsoft account at any request it makes", async () => {
      const graph = (tag: string) => (async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (!url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta")) throw new Error(`a call left the test: ${url}`);
        const value = Array.from({ length: 2 }, (_, i) => ({ id: `m-${tag}-${i}`, subject: "Re: your application", bodyPreview: "Thanks for applying", receivedDateTime: iso(NOW - 60_000 * (i + 1)),
          from: { emailAddress: { address: `recruiter-${i}@acme.example` } } }));
        return new Response(JSON.stringify({ value, "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=r4" }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const cases = [{ event: "switch", at: 3 }, { event: "switch", at: 5 }, { event: "disconnect", at: 4 }, { event: "none", at: 0 }] as const;
      for (const [i, c] of cases.entries()) {
        const u = uidOf(255_000 + i);
        await addPerson(u, `+1564${String(i).padStart(7, "0")}`);
        await connect(u, "microsoft", `${u.slice(-6)}@contoso.example`, `ob${i}`);
        let calls = 0, fired = false;
        hook = async () => {
          if (c.event === "none" || fired || ++calls !== c.at) return;
          fired = true;
          if (c.event === "disconnect") await disconnectOutlook(plain, u);
          else await connect(u, "microsoft", `${u.slice(-6)}.work@contoso.example`, `ob${i}-2`);
        };
        const g = graph(u.slice(-6));
        const td = tokenDeps(admin, env, g, () => NOW);
        const r = await syncInbox(admin, { fetch: g, now: () => NOW, token: (uu: string, sc: string) => outlookToken(td, uu, sc), waitMs: 1 }, u, NOW);
        hook = null;
        const kept = Number((await one(`select count(*)::int as n from public.career_outlook_messages where user_id = ${q(u)}`)).n);
        grade(`outlook sync ${c.event} at ${c.at}${fired ? "" : " (not reached)"}`,
          fired ? (kept ? `${kept} message(s) read from the old mailbox kept after "${c.event}" (${r.status})` : null) : (kept === 2 && r.status === "ok" ? null : `a sync with nothing withdrawn kept ${kept} (${r.status})`));
      }
    });

    // ---------------------------------------------------------------------------------------------- 2. deliveries
    await step("2. deliveries: a disconnect, a switch, a reconnect, Outlook, a deletion while the run holds a row", async () => {
      const sample = deliveries(SEED + 51, 16).map((x, i) => ({ ...x, phone: `+1559${String(i).padStart(7, "0")}`,
        rows: [...new Set([...x.rows.map((k) => (fromMailbox(k) || E2E_OTHER.includes(k) ? k : E2E_OTHER[i % E2E_OTHER.length])), "status" as KeyKind, "outreach_followup" as KeyKind])] }));
      const bystander = uidOf(260_001), bphone = "+15600000001";
      for (const [i, p] of sample.entries()) { await addPerson(p.uid, p.phone); await connect(p.uid, "google_career", `${p.uid.slice(-6)}@example.test`, `d${i}`); await connect(p.uid, "microsoft", `${p.uid.slice(-6)}@contoso.example`, `dm${i}`); }
      await addPerson(bystander, bphone); await connect(bystander, "google_career", "bystander@example.test", "dby");
      const text = (u: string, k: string) => `TEST ${k} for ${u.slice(-6)}`;
      const queue = async (u: string, kinds: KeyKind[]) => {
        for (const k of kinds) {
          const { key, kind } = keyOf(k, `${u.slice(-6)}-${k}`);
          await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(key)}, ${q(kind)}, ${q(text(u, k))}, ${q(iso(NOW - 60_000))})`);
        }
      };
      for (const p of sample) await queue(p.uid, p.rows);
      await queue(bystander, ["status", "brief", "digest", "outreach_followup"]);
      const sent: { to: string; text: string; after: boolean }[] = [];
      const fired = new Set<string>();
      const seen = new Map<string, number>();
      const fire = async (p: typeof sample[number]) => {
        fired.add(p.uid);
        if (p.event === "disconnect") await disconnectG(p.uid);
        else if (p.event === "switch") await connect(p.uid, "google_career", `${p.uid.slice(-6)}.work@example.test`, `${p.id}-2`);
        else if (p.event === "same_reconnect") await connect(p.uid, "google_career", `${p.uid.slice(-6).toUpperCase()}@example.test`, `${p.id}-3`);
        else if (p.event === "outlook_disconnect") { const r = await disconnectOutlook(plain, p.uid); grade(`outlook ${p.id}`, r.ok ? null : `disconnectOutlook: ${r.failures.join(", ")}`); }
        else if (p.event === "delete") await db.sql.query(`delete from auth.users where id = ${q(p.uid)}`);
      };
      for (const p of sample) if (p.event !== "none" && p.at < 0) await fire(p);
      const base = supabaseChannelStore(plain);
      const store = { ...base, async optedOut(contact: string) {
        const p = sample.find((x) => x.phone === contact);
        if (p && p.event !== "none" && !fired.has(p.uid)) { const n = seen.get(p.uid) ?? 0; seen.set(p.uid, n + 1); if (n === p.at) await fire(p); }
        return base.optedOut(contact);
      } };
      for (let round = 0; round < 4; round++) {
        const r = await deliverDue({ store, now: Date.now(), limit: 200, concurrency: round % 2 ? 4 : 1, send: async (to, bubbles) => {
          const p = sample.find((x) => x.phone === to);
          sent.push({ to, text: bubbles.join(" "), after: !!p && fired.has(p.uid) });
          return { ok: true, id: `loop-${sent.length}` };
        } });
        if (!r.delivered && !r.skipped_opt_out) break;
      }
      await base.release();
      for (const p of sample) {
        let why: string | null = null;
        const mailbox = p.event === "disconnect" || p.event === "switch";
        for (const k of p.rows) {
          const s = sent.filter((x) => x.to === p.phone && x.text === text(p.uid, k));
          const affected = (mailbox && fromMailbox(k)) || p.event === "delete";
          if (s.length > 1) why = `${k} went twice`;
          else if (affected && s.some((x) => x.after)) why = `${k} went after "${p.event}"`;
          else if (affected && p.at < 0 && s.length) why = `${k} went although "${p.event}" came before the run`;
          else if (!affected && s.length !== 1) why = `${k} was not delivered`;
          if (why) break;
        }
        if (!why && p.event !== "delete") {
          const claimed = Number((await one(`select count(*)::int as n from public.career_outbox where user_id = ${q(p.uid)} and status = 'sending'`)).n);
          if (claimed) why = `${claimed} row(s) left claimed`;
          else if (mailbox && (await pendingMailbox(p.uid)).length) why = "an undelivered text made from the mailbox survived it";
        }
        if (!why && p.event === "delete" && Number((await one(`select count(*)::int as n from public.career_outbox where user_id = ${q(p.uid)}`)).n)) why = "outbox rows of a deleted account are left";
        grade(`delivery #${p.id} ${p.event} at ${p.at} rows=${p.rows.join(",")}`, why);
      }
      grade("delivery bystander", sent.filter((x) => x.to === bphone).length === 4 ? null : `the person beside got ${sent.filter((x) => x.to === bphone).length} of 4`);
    });

    // ---------------------------------------------------------------------------------------------- 3. refreshes
    await step("3. refreshes landing after a disconnect, a reconnect, a new consent, a switch or a deletion", async () => {
      const sample = refreshes(SEED + 53, 14).map((x) => ({ ...x, legacy: false }));
      for (const [i, x] of sample.entries()) {
        await addPerson(x.uid, `+1561${String(i).padStart(7, "0")}`);
        const email = `${x.uid.slice(-6)}@${x.provider === "microsoft" ? "contoso.example" : "example.test"}`, name = `oauth_${x.provider}_${x.uid}`;
        await connect(x.uid, x.provider, email, `${x.id}-old`, true);
        let after: string | null = null;
        const event = async () => {
          if (x.event === "disconnect") x.provider === "microsoft" ? await disconnectOutlook(plain, x.uid) : await disconnectG(x.uid);
          else if (x.event === "reconnect_same") { x.provider === "microsoft" ? await disconnectOutlook(plain, x.uid) : await disconnectG(x.uid); await connect(x.uid, x.provider, email, `${x.id}-new`); }
          else if (x.event === "consent_same") await connect(x.uid, x.provider, email.toUpperCase(), `${x.id}-new`);
          else if (x.event === "switch") await connect(x.uid, x.provider, `other.${email}`, `${x.id}-new`);
          else if (x.event === "delete") await db.sql.query(`delete from auth.users where id = ${q(x.uid)}`);
          after = (await one(`select public.oauth_vault_read(${q(name)}) as s`)).s ?? null;
        };
        const tokenFake = (async (input: any, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.url;
          if (url === GOOGLE_REVOKE) return googleFake(input, init);
          if (!/oauth2\.googleapis\.com\/token|login\.microsoftonline\.com\/.+\/token/.test(url)) throw new Error(`a call left the test: ${url}`);
          if (x.event !== "none") await event();
          return new Response(JSON.stringify({ access_token: fakeTok("access", `${x.id}-refreshed`), expires_in: 3600, ...(x.rotate ? { refresh_token: fakeTok("refresh", `${x.id}-rotated`) } : {}) }), { status: 200 });
        }) as typeof fetch;
        let token: string | null = null;
        if (x.provider === "google_career") {
          token = await careerTokenFor({ fetch: tokenFake, env, now: () => NOW,
            connection: async (u) => (await plain.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", "google_career").maybeSingle()).data,
            readVault: async (n) => { const v = await plain.rpc("oauth_vault_read", { p_name: n }); return v.data ? String(v.data) : null; },
            writeVault: (n, s) => vaultRefreshWrite(plain, n, s, "save the refreshed career grant") }, GMAIL_READ)(x.uid);
        } else {
          const r = await outlookToken(tokenDeps(plain, env, tokenFake, () => NOW), x.uid, "Mail.Read");
          token = r.status === "ok" ? r.token : null;
        }
        const stored = (await one(`select public.oauth_vault_read(${q(name)}) as s`)).s ?? null;
        const refreshed = fakeTok("access", `${x.id}-refreshed`);
        let why: string | null = null;
        if (x.event === "none") why = token === refreshed && stored && JSON.parse(stored).access_token === refreshed ? null : "a plain refresh did not return and store the new token";
        else if (token === refreshed) why = `the refreshed token of the grant before "${x.event}" was used`;
        else if (x.event === "disconnect" || x.event === "delete") why = stored === null ? null : "a Vault entry for a connection that is gone";
        else why = stored === after ? null : `the earlier grant's refresh was written over the grant "${x.event}" made`;
        grade(`refresh #${x.id} ${x.provider} ${x.event}`, why);
      }
    });

    // ---------------------------------------------------------------------------------------------- 4. erase and retry
    await step("4. an account deletion that fails, asked again; another person's outreach to this person", async () => {
      const SEEDS: { fail: "ledger" | "user" | "files" }[] = [{ fail: "ledger" }, { fail: "user" }, { fail: "files" }, { fail: "ledger" }];
      for (const [i, s] of SEEDS.entries()) {
        const B = uidOf(270_000 + i), A = uidOf(271_000 + i), bAddr = `${B.slice(-6)}@users.example.test`;
        await addPerson(B, `+1562${String(i).padStart(7, "0")}`); await addPerson(A, `+1563${String(i).padStart(7, "0")}`);
        await connect(B, "google_career", `${B.slice(-6)}@example.test`, `e${i}`);
        if (i % 2) await connect(B, "microsoft", `${B.slice(-6)}@contoso.example`, `em${i}`);
        await db.sql.query(`insert into storage.objects(bucket_id, name) values ('career-resumes', ${q(`${B}/r1.pdf`)}), ('career-resumes', ${q(`${B}/r2.pdf`)});
          insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(B)}, ${q(`status:${hexOf(`${B}-s`)}`)}, 'status', 'TEST B status', now() + interval '8 hours');`);
        await approvedDrafts(db, A, [bAddr]);
        const aBefore = JSON.stringify(await rows(db, `select id, status, recipient_email, subject, body, approved_hash from public.career_outreach_drafts where user_id = ${q(A)} order by id`));
        let attempt = 0;
        const project = (async (input: any, init?: RequestInit) => {
          const req = input instanceof Request && !init ? input : new Request(input, init);
          const u = new URL(req.url);
          if (req.url === GOOGLE_REVOKE) return googleFake(req.url, { body: await req.text() });
          if (u.origin !== SUPABASE_URL) throw new Error(`a call left the test: ${u.host}`);
          const m = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
          if (m && req.method === "DELETE") {
            if (attempt === 1 && s.fail === "user") return new Response('{"msg":"Database error deleting user"}', { status: 500 });
            const gone = (await db.sql.query(`delete from auth.users where id = ${q(m[1])} returning id`)).filter((x: any) => x[0]).length;
            return gone ? new Response("{}", { status: 200 }) : new Response('{"msg":"User not found"}', { status: 404 });
          }
          if (m && req.method === "GET") return (await one(`select exists (select 1 from auth.users where id = ${q(m[1])}) as ok`)).ok ? new Response(JSON.stringify({ id: m[1] }), { status: 200 }) : new Response('{"msg":"User not found"}', { status: 404 });
          if (u.pathname === "/storage/v1/object/list/career-resumes") {
            if (attempt === 1 && s.fail === "files") return new Response('{"error":"unavailable"}', { status: 503 });
            const b = await req.json();
            const objs = await rows(db, `select substr(name, ${String(b.prefix).length + 1}) as name from storage.objects where bucket_id = 'career-resumes' and name like ${q(`${b.prefix}%`)} order by name limit ${Number(b.limit) || 100}`);
            return new Response(JSON.stringify(objs), { status: 200 });
          }
          if (u.pathname === "/storage/v1/object/career-resumes" && req.method === "DELETE") {
            for (const n of (await req.json()).prefixes ?? []) await db.sql.query(`delete from storage.objects where bucket_id = 'career-resumes' and name = ${q(n)}`);
            return new Response("[]", { status: 200 });
          }
          if (u.pathname === "/rest/v1/rpc/purge_user_action_ledger" && attempt === 1 && s.fail === "ledger") return new Response('{"message":"ledger busy"}', { status: 503 });
          return double.fetch(req);
        }) as typeof fetch;
        const said: string[] = [];
        for (attempt = 1; attempt <= 3; attempt++) {
          const r = await deleteAccount(restDeps(SUPABASE_URL, SERVICE_KEY, project, { sleep: async () => {} }), B);
          const words = deletionWords(r);
          said.push(words);
          const gone = !(await one(`select exists (select 1 from auth.users where id = ${q(B)}) as ok`)).ok;
          const why = wordsWhy(r, words, { gone });
          grade(`erase #${i} ${s.fail} attempt ${attempt}`, why);
          if (gone) break;
        }
        const left = await one(`select (select count(*) from public.user_oauth_connections where user_id = ${q(B)})::int as conns,
          (select count(*) from vault.secrets where name like ${q(`oauth_%${B}`)})::int as vault,
          (select count(*) from public.career_outbox where user_id = ${q(B)})::int as outbox,
          (select count(*) from storage.objects where name like ${q(`${B}/%`)})::int as files,
          exists (select 1 from auth.users where id = ${q(B)}) as user`);
        const aAfter = JSON.stringify(await rows(db, `select id, status, recipient_email, subject, body, approved_hash from public.career_outreach_drafts where user_id = ${q(A)} order by id`));
        let why: string | null = null;
        if (left.user) why = `not deleted after ${said.length} attempts: ${said.at(-1)!.slice(0, 120)}`;
        else if (left.conns || left.vault || left.outbox) why = `left after the deletion: ${JSON.stringify(left)}`;
        else if (left.files && !/couldn't confirm: .*delete your saved resume files/.test(said.at(-1)!)) why = "resume files left and not said";
        else if (aAfter !== aBefore) why = "another person's outreach to this person's address changed";
        grade(`erase #${i} ${s.fail} final`, why);
        grade(`erase #${i} retried`, said.length >= 2 || s.fail === "files" ? null : `the first attempt was expected to fail (${s.fail}), ${said.length} attempt(s)`);
      }
    });

    console.log(`[connectors r4 e2e] ${graded} checks, ${failures.length} failures, ${Math.round((Date.now() - started) / 1000)} s`);
    for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f}`);
    eq(failures, [], `connectors r4 e2e: ${failures.length} failures: ${failures.slice(0, 4).join(" || ")}`);
  } finally {
    globalThis.fetch = realFetch;
    await db.stop();
  }
} });
