// Connectors, disconnect and erase, round 4 (owner rules, 2026-11-05), fed ~10,000 generated scenarios
// (tests/architect/scenarios/connectors-r4-generator.ts, seeded; fresh seeds and categories rounds 1 to 3 did not have):
//   - a delivery run holding a person's texts when they say "disconnect gmail", connect another Google account, connect the
//     same one again, disconnect Outlook or delete their account: no text made from that mailbox (a status read from an
//     email, a deadline, a confirmation, a "which application?" ask, an interview brief, a draft's offer) goes out after the
//     disconnect; nothing goes to a deleted account; everything else, and another person's, goes;
//   - the scheduled Gmail run reading a person's mail when they disconnect or switch at any call it makes: nothing read from
//     that mailbox is left queued after it;
//   - a token refresh in flight when the person disconnects, connects the same account again (a new grant), gives the send
//     consent again, connects another account or deletes their account: the refreshed token is not used and never written
//     over the new grant (or for a connection that is gone);
//   - an account deletion that fails part way and is asked again: every answer is true when it is given ("deleted" only when
//     it is, "Google confirmed" only on Google's 200, "disconnected" only when the rows are gone), a plan not cancelled
//     deletes nothing, the last answer leaves nothing of the person (rows, Vault, files), the person is told where to remove
//     a Google grant Google never confirmed revoked, and another person's outreach that names this person is untouched.
// Part 1 (this file) runs the real functions (deliverDue with the store's stillQueued, runMail over supabaseMailStore and
// supabaseAlertStore, careerTokenFor and outlookToken over vaultRefreshWrite, deleteAccount and deletionWords) over an
// in-memory project answering as 20261105130000_connectors_r4.sql does (scenarios/connectors-r4-memdb.ts). R4_PREFIX=1 runs
// it against the project as it was before round 4 (it fails). Part 2 (flow-scenarios-connectors-r4.test.ts) runs a seeded
// sample end to end on real Postgres. No model, no provider, no network.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { deliveries, type Erasure, erasures, fakeTok, fromMailbox, GMAIL_READ, hexOf, keyOf, type MailRun, mailruns, refreshes } from "./scenarios/connectors-r4-generator.ts";
import { MemDb4, PREFIX } from "./scenarios/connectors-r4-memdb.ts";
import { type ChannelStore, deliverDue, mailboxText, mailTextKey, type OutboxRow } from "../../supabase/functions/_shared/channel.ts";
import { runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { careerTokenFor } from "../../supabase/functions/_shared/career_mail_gmail.ts";
import { outlookToken } from "../../supabase/functions/_shared/outlook_graph.ts";
import { syncInbox, tokenDeps } from "../../supabase/functions/_shared/outlook_connector.ts";
import { vaultRefreshWrite } from "../../supabase/functions/_shared/oauth_vault_refresh.ts";
import { type AccountDeleteDeps, deleteAccount, deletionWords, GOOGLE_PERMISSIONS } from "../../supabase/functions/_shared/account_delete.ts";
import { GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261105;
export const DELIVERIES = deliveries(SEED + 41, 4000);
export const MAILRUNS = mailruns(SEED + 42, 1500);
export const REFRESHES = refreshes(SEED + 43, 2500);
export const ERASURES = erasures(SEED + 44, 2000);
const NOW = Date.UTC(2026, 10, 5, 15, 0, 0);
const TOKENISH = /ya29\.|1\/\/|refresh_token|access_token|client_secret/;
const ENV: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: "fake-google-client-0004", GOOGLE_OAUTH_CLIENT_SECRET: ["fake", "google", "secret", "0004"].join("-"),
  MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client-0004", MICROSOFT_OAUTH_CLIENT_SECRET: ["fake", "ms", "secret", "0004"].join("-") };
const env = { get: (k: string) => ENV[k] };

type Failure = { k: string; input: string; got: string; why: string };
export class Report {
  total = 0; failures = new Map<string, Failure[]>();
  constructor(public path: string) {}
  grade(family: string, input: string, why: string | null, got: string) {
    this.total++;
    if (!why) return;
    if (!this.failures.has(family)) this.failures.set(family, []);
    this.failures.get(family)!.push({ k: family, input, got, why });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((x, y) => x + y.length, 0);
    const lines = [`[connectors r4${PREFIX ? " PREFIX" : ""}] ${this.path}: ${this.total} scenarios, ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((x, y) => y[1].length - x[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${x.input} -> ${x.got.slice(0, 240)} (${x.why})`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | ${xs[0].input} -> ${xs[0].got.slice(0, 160)}`).join(" || ");
    eq(failed, 0, `${this.path}: ${failed} scenarios went wrong: ${first}`);
  }
}

const connect = (db: MemDb4, uid: string, provider: "google_career" | "microsoft", email: string, tag: string, expired = false) => {
  const r = db.rpcs.oauth_connect_commit({ p_user: uid, p_provider: provider, p_email: email, p_now: new Date(NOW).toISOString(),
    p_scopes: provider === "microsoft" ? "openid email offline_access User.Read Mail.Read Mail.Send" : `openid email ${GMAIL_READ}`,
    p_secret: JSON.stringify({ access_token: fakeTok("access", tag), refresh_token: fakeTok("refresh", tag), expires_at: expired ? NOW - 3_600_000 : NOW + 3_600_000, email,
      scopes: provider === "microsoft" ? "openid email offline_access User.Read Mail.Read Mail.Send" : `openid email ${GMAIL_READ}` }) });
  if (r !== "connected") throw new Error(`setup: connect ${r}`);
};

// ------------------------------------------------------------------------------------------------ 1. deliveries
// A delivery store over the in-memory outbox, answering as channel_store.ts does (claims mark rows sending; stillQueued
// reads the row again; quiet and gone for an account that no longer exists). The event fires while the run holds the
// person's row `at` (as the run starts on it), or before the claim.
function deliveryStore(db: MemDb4, fire: (uid: string) => void, contacts: Map<string, string>): ChannelStore {
  const owner = new Map([...contacts].map(([u, c]) => [c, u]));
  const store: ChannelStore = {
    async due(now, limit) {
      const rows = db.outbox().filter((r) => (r.status === "queued" || r.status === "failed") && Date.parse(r.deliver_at) <= now).sort((a, b) => Number(a.id) - Number(b.id)).slice(0, limit);
      for (const r of rows) r.status = "sending";
      return rows.map((r): OutboxRow => ({ id: r.id, userId: r.user_id, contact: contacts.get(r.user_id)!, key: r.key, text: r.text, deliver_at: Date.parse(r.deliver_at), attempts: r.attempts }));
    },
    async optedOut(contact) { fire(owner.get(contact)!); return false; },
    async quiet(u) { return !db.users.has(u); },
    async gone(u) { return !db.users.has(u); },
    async mark(id, m) {
      const r = db.outbox().find((x) => x.id === id);
      if (!r) return; // deleted while the run held it: the update finds no row
      r.status = m.status; r.attempts++;
      if (m.status === "delivered") r.delivered_at = new Date(m.at).toISOString();
    },
    async contactsSentOn() { return 0; },
    async sentTo() { return true; },
    async setOptOut() {},
  };
  if (!PREFIX) store.stillQueued = async (m) => db.outbox().some((x) => x.id === m.id);
  return store;
}
Deno.test(`connectors r4, a delivery run holding a person's texts when they disconnect, switch, reconnect or delete their account (deliverDue): ${DELIVERIES.length} runs`, async () => {
  const rep = new Report("deliveries");
  for (const x of DELIVERIES) {
    const db = new MemDb4();
    const contacts = new Map([[x.uid, `+1555${String(x.id).padStart(7, "0")}`], [x.other, `+1556${String(x.id).padStart(7, "0")}`]]);
    for (const u of [x.uid, x.other]) { db.users.add(u); connect(db, u, "google_career", `${u.slice(-6)}@example.test`, u.slice(-6)); connect(db, u, "microsoft", `${u.slice(-6)}@contoso.example`, `ms-${u.slice(-6)}`); }
    const queue = (u: string, kinds: readonly string[]) => kinds.map((k) => {
      const { key, kind } = keyOf(k as any, `${u.slice(-6)}-${k}`);
      db.outboxInsert({ user_id: u, key, kind, text: `TEST ${k} for ${u.slice(-6)}`, deliver_at: new Date(NOW - 60_000).toISOString() });
      return { key, k };
    });
    const mine = queue(x.uid, x.rows), theirs = queue(x.other, x.otherRows);
    for (const u of [x.uid, x.other]) db.rows("career_watch_kv").push({ user_id: u, key: `career:confirm-ask:${hexOf(`${u}-ask`)}`, value: { state: "pending", text: "TEST which" } });
    let fired = false, seen = 0;
    const event = () => {
      fired = true;
      if (x.event === "disconnect") db.disconnect(x.uid, "google_career");
      else if (x.event === "switch") connect(db, x.uid, "google_career", `${x.uid.slice(-6)}.work@example.test`, `${x.uid.slice(-6)}-2`);
      else if (x.event === "same_reconnect") connect(db, x.uid, "google_career", ` ${x.uid.slice(-6).toUpperCase()}@Example.test`, `${x.uid.slice(-6)}-3`);
      else if (x.event === "outlook_disconnect") db.disconnect(x.uid, "microsoft");
      else if (x.event === "delete") db.deleteUser(x.uid);
    };
    if (x.event !== "none" && x.at < 0) event();
    const fire = (u: string) => { if (u !== x.uid || fired || x.event === "none") return; if (seen++ === x.at) event(); };
    const sent: { to: string; text: string; after: boolean }[] = [];
    await deliverDue({ store: deliveryStore(db, fire, contacts), now: NOW, concurrency: x.lanes, send: async (to, bubbles) => { sent.push({ to, text: bubbles.join(" "), after: fired }); return { ok: true, id: `m-${sent.length}` }; } });
    const wentMine = (k: string) => sent.filter((s) => s.to === contacts.get(x.uid) && s.text === `TEST ${k} for ${x.uid.slice(-6)}`);
    let why: string | null = null;
    const mailbox = x.event === "disconnect" || x.event === "switch";
    for (const { k } of mine) {
      const s = wentMine(k);
      if (s.length > 1) { why = `${k} went twice`; break; }
      if (mailbox && fromMailbox(k as any) && s.some((y) => y.after)) { why = `a text made from the mailbox (${k}) went after "${x.event}"`; break; }
      if (x.event === "delete" && s.some((y) => y.after)) { why = `${k} went to an account deleted while the run held it`; break; }
      const affected = (mailbox && fromMailbox(k as any)) || x.event === "delete";
      if (!affected && !s.length) { why = `${k} was not delivered (nothing about it was withdrawn)`; break; }
      if (affected && x.at < 0 && s.length) { why = `${k} went although the ${x.event} came before the run`; break; }
    }
    if (!why) for (const { k } of theirs) if (sent.filter((s) => s.to === contacts.get(x.other) && s.text === `TEST ${k} for ${x.other.slice(-6)}`).length !== 1) { why = `the other person's ${k} was not delivered once`; break; }
    if (!why && db.outbox().some((r) => r.status === "sending")) why = "a row was left claimed";
    if (!why && mailbox && db.rows("career_watch_kv").some((r) => r.user_id === x.uid && /^career:confirm-ask:/.test(r.key) && r.value?.state === "pending")) why = "a pending ask made from the mailbox survived the disconnect";
    if (!why && !db.rows("career_watch_kv").some((r) => r.user_id === x.other && /^career:confirm-ask:/.test(r.key))) why = "the other person's ask was touched";
    rep.grade(x.family, `#${x.id} ${x.event} at=${x.at} lanes=${x.lanes} rows=${x.rows.join(",")}`, why, JSON.stringify(sent.map((s) => `${s.to.slice(-3)}:${s.text.slice(5, 30)}${s.after ? "*" : ""}`)));
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 2. mail runs
const AUTH = ["mx.google.com; dkim=pass header.i=@greenhouse.io header.s=s1; spf=pass smtp.mailfrom=greenhouse.io; dmarc=pass (p=REJECT) header.from=greenhouse.io"];
const rejection = (tag: string, i: number) => ({ hash: hexOf(`${tag}-mail-${i}`), from: "Asana <no-reply@greenhouse.io>", subject: "Your Asana application",
  snippet: "Unfortunately, we have decided not to move forward with your application.", date: new Date(NOW - 120_000 - i * 1000).toISOString(), auth: AUTH });
const APP = { ref: "track:a1", company: "Asana", role: "Account Manager", stage: "Submitted", source: "tracker" as const, applied_at: new Date(NOW - 864e6).toISOString(), events: [] };
// Counts the calls the run makes to the database while it runs the person, and fires the event before the k-th.
function counted(db: MemDb4, hook: () => void) {
  const rpc = db.rpc.bind(db), from = db.from.bind(db);
  return new Proxy(db, { get(t, p) {
    if (p === "rpc") return (n: string, a: any) => { hook(); return rpc(n, a); };
    if (p === "from") return (n: string) => { hook(); return from(n); };
    return (t as any)[p];
  } });
}
const DELTA = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-r4";
const fakeGraph = (tag: string, mails: number) => (async (input: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta")) throw new Error(`a call left the test: ${url}`);
  const value = Array.from({ length: mails }, (_, i) => ({ id: `m-${tag}-${i}`, subject: "Re: your application", bodyPreview: "Thanks for applying", receivedDateTime: new Date(NOW - 60_000 * (i + 1)).toISOString(),
    from: { emailAddress: { address: `recruiter-${i}@acme.example` } } }));
  return new Response(JSON.stringify({ value, "@odata.deltaLink": DELTA }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
async function outlookRun(x: MailRun): Promise<{ why: string | null; got: string }> {
  const db = new MemDb4();
  for (const u of [x.uid, x.other]) {
    db.users.add(u);
    connect(db, u, "microsoft", `${u.slice(-6)}@contoso.example`, `o-${u.slice(-6)}`);
    db.rows("career_outlook_state").push({ user_id: u, needs_reconnect_at: null, delta_link: null, synced_at: null });
  }
  let running: string | null = null, calls = 0, fired = false;
  const admin = counted(db, () => {
    if (running !== x.uid || fired || x.event === "none") return;
    if (++calls === x.at) {
      fired = true;
      if (x.event === "disconnect") db.disconnect(x.uid, "microsoft");
      else connect(db, x.uid, "microsoft", `${x.uid.slice(-6)}.work@contoso.example`, `o2-${x.uid.slice(-6)}`);
    }
  });
  const sync = async (u: string) => {
    running = u;
    const g = fakeGraph(u.slice(-6), x.mails);
    const td = tokenDeps(admin as any, env, g, () => NOW);
    return await syncInbox(admin as any, { fetch: g, now: () => NOW, token: (uu: string, sc: string) => outlookToken(td, uu, sc), waitMs: 1 }, u, NOW);
  };
  const mine = await sync(x.uid), theirs = await sync(x.other);
  const kept = (u: string) => db.rows("career_outlook_messages").filter((r) => r.user_id === u).length;
  const got = JSON.stringify({ fired, calls, mine: { status: mine.status, stored: mine.stored }, kept: kept(x.uid), theirs: theirs.status });
  // The sync's second request reads the connection: a switch before it is a sync of the new mailbox, kept as such.
  const newMailbox = fired && x.event === "switch" && x.at <= 2;
  if (newMailbox) { if (kept(x.uid) !== x.mails || mine.status !== "ok") return { why: "a sync of the account connected before it began did not keep what it read", got }; }
  else if (fired && kept(x.uid)) return { why: `${kept(x.uid)} message(s) read from the Outlook mailbox kept after "${x.event}"`, got };
  else if (fired && mine.status === "ok" && Object.keys(mine.patch ?? {}).length) return { why: "the old mailbox's read position was kept", got };
  else if (!fired && (kept(x.uid) !== x.mails || mine.status !== "ok")) return { why: "a sync with nothing withdrawn did not keep what it read", got };
  if (kept(x.other) !== x.mails || theirs.status !== "ok") return { why: "the other person's sync was touched", got };
  return { why: null, got };
}
Deno.test(`connectors r4, the scheduled Gmail run (and Outlook's sync) when the person disconnects or switches at any call it makes (runMail over supabaseMailStore and supabaseAlertStore, syncInbox): ${MAILRUNS.length} runs`, async () => {
  const rep = new Report("mail runs");
  for (const x of MAILRUNS) {
    if (x.provider === "outlook") { const o = await outlookRun(x); rep.grade(x.family, `#${x.id} outlook ${x.event} at call ${x.at} mails=${x.mails}`, o.why, o.got); continue; }
    const db = new MemDb4();
    for (const [i, u] of [x.uid, x.other].entries()) {
      db.users.add(u);
      connect(db, u, "google_career", `${u.slice(-6)}@example.test`, u.slice(-6));
      db.rows("career_mail_cursors").push({ user_id: u, read_through: new Date(NOW - 3_600_000 + i * 1000).toISOString() });
    }
    let running: string | null = null, calls = 0, fired = false;
    const hook = () => {
      if (running !== x.uid || fired || x.event === "none") return;
      if (++calls === x.at) {
        fired = true;
        if (x.event === "disconnect") db.disconnect(x.uid, "google_career");
        else connect(db, x.uid, "google_career", `${x.uid.slice(-6)}.work@example.test`, `${x.uid.slice(-6)}-2`);
      }
    };
    const admin = counted(db, hook);
    const base = supabaseMailStore(admin);
    const store = { ...base, applications: async () => [structuredClone(APP)] };
    let why: string | null = null, got = "";
    try {
      const stats = await runMail({ outbox: supabaseAlertStore(admin), now: NOW, store, batch: 1, read: async (u) => {
        running = u;
        return { status: "ok", mails: Array.from({ length: x.mails }, (_, i) => rejection(u.slice(-6), i)), readThrough: NOW, listed: x.mails };
      } });
      const left = (u: string) => db.outbox().filter((r) => r.user_id === u && r.delivered_at === null && mailboxText(r.key));
      got = JSON.stringify({ fired, calls, mine: left(x.uid).map((r) => r.key.slice(0, 14)), theirs: left(x.other).length, stats });
      if (fired && left(x.uid).length) why = `${left(x.uid).length} text(s) read from the mailbox left queued after "${x.event}"`;
      else if (fired && db.rows("career_mail_events").some((r) => r.user_id === x.uid)) why = "status events read from the mailbox were kept after it";
      else if (!fired && !left(x.uid).length) why = "a run with nothing withdrawn said nothing";
      else if (!left(x.other).length) why = "the other person's run was touched";
    } catch (e) { why = `the run threw: ${(e as Error).message}`; }
    rep.grade(x.family, `#${x.id} ${x.event} at call ${x.at} mails=${x.mails}`, why, got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 3. refreshes
Deno.test(`connectors r4, a token refresh in flight when the person disconnects, reconnects, consents again, switches or deletes their account (careerTokenFor, outlookToken over vaultRefreshWrite): ${REFRESHES.length} refreshes`, async () => {
  const rep = new Report("refreshes");
  for (const x of REFRESHES) {
    const db = new MemDb4();
    db.users.add(x.uid);
    const email = `${x.uid.slice(-6)}@${x.provider === "microsoft" ? "contoso.example" : "example.test"}`, name = `oauth_${x.provider}_${x.uid}`;
    const scopes = x.provider === "microsoft" ? "openid email offline_access User.Read Mail.Read Mail.Send" : `openid email ${GMAIL_READ}`;
    if (x.legacy) {
      // a grant stored before round 4 (no stamp), through the old two writes
      db.vault.set(name, JSON.stringify({ access_token: fakeTok("access", `${x.id}-old`), refresh_token: fakeTok("refresh", `${x.id}-old`), expires_at: NOW - 3_600_000, email, scopes }));
      db.rows("user_oauth_connections").push({ user_id: x.uid, provider: x.provider, vault_name: name, email, scopes, connected_at: new Date(NOW - 864e5).toISOString() });
    } else connect(db, x.uid, x.provider, email, `${x.id}-old`, true);
    if (x.provider === "microsoft") db.rows("career_outlook_state").push({ user_id: x.uid, needs_reconnect_at: null, delta_link: null, synced_at: null });
    let after: string | null = null; // the Vault entry the event left
    const event = () => {
      if (x.event === "disconnect") db.disconnect(x.uid, x.provider);
      else if (x.event === "reconnect_same") { db.disconnect(x.uid, x.provider); connect(db, x.uid, x.provider, email, `${x.id}-new`); }
      else if (x.event === "consent_same") connect(db, x.uid, x.provider, email.toUpperCase(), `${x.id}-new`);
      else if (x.event === "switch") connect(db, x.uid, x.provider, `other.${email}`, `${x.id}-new`);
      else if (x.event === "delete") db.deleteUser(x.uid);
      after = db.vault.get(name) ?? null;
    };
    const fetchFake = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (!/oauth2\.googleapis\.com\/token|login\.microsoftonline\.com\/.+\/token/.test(url)) throw new Error(`a call left the test: ${url}`);
      const rt = new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "";
      if (rt !== fakeTok("refresh", `${x.id}-old`)) return new Response('{"error":"invalid_grant"}', { status: 400 });
      if (x.event !== "none") event();
      return new Response(JSON.stringify({ access_token: fakeTok("access", `${x.id}-refreshed`), expires_in: 3600, ...(x.rotate ? { refresh_token: fakeTok("refresh", `${x.id}-rotated`) } : {}) }), { status: 200 });
    }) as typeof fetch;
    let token: string | null = null, why: string | null = null;
    try {
      if (x.provider === "google_career") {
        token = await careerTokenFor({ fetch: fetchFake, env, now: () => NOW,
          connection: async (u) => (await db.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", "google_career").maybeSingle()).data,
          readVault: async (n) => { const v = await db.rpc("oauth_vault_read", { p_name: n }); return v.data ? String(v.data) : null; },
          writeVault: (n, s) => vaultRefreshWrite(db, n, s, "save the refreshed career grant") }, GMAIL_READ)(x.uid);
      } else {
        const r = await outlookToken(tokenDeps(db as any, env, fetchFake, () => NOW), x.uid, "Mail.Read");
        token = r.status === "ok" ? r.token : null;
      }
    } catch (e) { why = `the refresh threw: ${(e as Error).message}`; }
    const stored = db.vault.get(name) ?? null;
    const refreshed = fakeTok("access", `${x.id}-refreshed`);
    if (!why) {
      if (x.event === "none") {
        if (token !== refreshed) why = "a refresh with nothing in its way returned no token";
        else if (!stored || JSON.parse(stored).access_token !== refreshed) why = "the refreshed token was not stored";
      } else if (token === refreshed) why = `the refreshed token of the grant before "${x.event}" was used`;
      else if (x.event === "disconnect" || x.event === "delete") { if (stored !== null) why = "a Vault entry was written for a connection that is gone"; }
      else if (stored !== after) why = `the refresh of the earlier grant was written over the grant "${x.event}" made`;
    }
    rep.grade(x.family, `#${x.id} ${x.provider} ${x.event} rotate=${x.rotate} legacy=${x.legacy}`, why, JSON.stringify({ token: token ? token.slice(-12) : null, stored: stored ? JSON.parse(stored).access_token.slice(-14) : null }));
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 4. erasures
// An account deletion over an in-memory project: the steps deleteAccount takes, each failing on the attempt the generator
// says, with the database's own effects (the connection rows' delete removes their Vault entries; the auth user's delete
// cascades every row and needs the ledger purged; Storage has no cascade), Stripe, and Google's revoke endpoint (a token
// revoked once is refused with 400 after). Another person's outreach names this person's address.
function eraseProject(x: Erasure) {
  const U = x.uid;
  const st = {
    user: true, plan: x.plan, ledger: true, files: x.files,
    conns: new Set(x.grants as string[]),
    vault: new Map<string, string>(),
    other: { drafts: [{ user_id: x.other, to: `${U.slice(-6)}@example.test`, text: "TEST hello" }], contacts: [{ user_id: x.other, email: `${U.slice(-6)}@example.test` }] },
    revoked: new Set<string>(), revokes: [] as { token: string; answer: number | string }[],
  };
  for (const p of x.grants) st.vault.set(`oauth_${p}_${U}`, JSON.stringify(p === "microsoft" ? { access_token: `EwB-FAKE4-${x.id}`, refresh_token: `M.FAKE4-${x.id}` } : { access_token: fakeTok("access", `${x.id}-${p}`), refresh_token: fakeTok("refresh", `${x.id}-${p}`) }));
  st.vault.set(`simplefin_access_url_${U}`, "https://user:pass@bridge.example.test/simplefin");
  let fail: string | null = null;
  const google = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url !== GOOGLE_REVOKE) throw new Error(`a call left the test: ${url}`);
    const token = new URLSearchParams(String(init?.body ?? "")).get("token") ?? "";
    if (!token.includes(`-${x.id}-`)) { st.revokes.push({ token, answer: "foreign" }); return new Response("", { status: 400 }); }
    if (st.revoked.has(token)) { st.revokes.push({ token, answer: 400 }); return new Response('{"error":"invalid_token"}', { status: 400 }); }
    st.revokes.push({ token, answer: x.revoke });
    if (x.revoke === "network") throw new TypeError("error sending request: connection reset");
    if (x.revoke === 200) { st.revoked.add(token); const t = JSON.parse([...st.vault.values()].find((v) => v.includes(token)) ?? "{}"); for (const k of [t.access_token, t.refresh_token]) if (k) st.revoked.add(k); }
    return new Response("", { status: x.revoke });
  }) as typeof fetch;
  const dropConns = () => { for (const p of st.conns) st.vault.delete(`oauth_${p}_${U}`); st.conns.clear(); };
  const deps: AccountDeleteDeps = {
    fetch: google, sleep: async () => {}, tries: 2,
    async endBilling() { if (fail === "billing") return "failed"; if (!st.plan) return "none"; st.plan = false; return "cancelled"; },
    async grants() { if (fail === "grants") throw new Error("read failed"); return [...st.conns]; },
    async vaultRead(n) { if (fail === "vault") return { ok: false, secret: null }; return { ok: true, secret: st.vault.get(n) ?? null }; },
    async disconnect() { if (fail === "disconnect") return false; dropConns(); return true; },
    async purgeSecrets() { if (fail === "secrets") return false; for (const k of [...st.vault.keys()]) if (k.endsWith(U)) st.vault.delete(k); dropConns(); return true; },
    async removeFiles() { if (fail === "files") return false; st.files = 0; return true; },
    async purgeRows() { return true; },
    async purgeLedger() { if (fail === "ledger") return { ok: false, detail: "ledger" }; st.ledger = false; return { ok: true }; },
    async deleteUser() { if (fail === "user" || st.ledger) return { ok: false, status: 500 }; if (!st.user) return { ok: false, status: 404 }; st.user = false; dropConns(); return { ok: true, status: 200 }; },
    async userExists() { if (fail === "readback") throw new Error("read-back failed"); return st.user; },
    async secretsLeft() { if (fail === "readback") return null; return [...st.conns].filter((p) => st.vault.has(`oauth_${p}_${U}`)).map((p) => `oauth_${p}`); },
    async record() { return fail !== "record"; },
  };
  return { st, deps, setFail: (f: string | null) => { fail = f; } };
}
Deno.test(`connectors r4, an account deletion that fails part way and is asked again (deleteAccount, deletionWords): ${ERASURES.length} people`, async () => {
  const rep = new Report("erasures");
  for (const x of ERASURES) {
    const { st, deps, setFail } = eraseProject(x);
    const otherBefore = JSON.stringify(st.other);
    const said: string[] = [];
    let why: string | null = null;
    const hadGoogle = x.grants.some((p) => p !== "microsoft");
    for (const [i, f] of x.fails.entries()) {
      setFail(f);
      const before = { user: st.user, conns: st.conns.size, vault: st.vault.size, files: st.files };
      const revokesBefore = st.revokes.length;
      let res: any, words = "";
      try { res = await deleteAccount(deps, x.uid); words = deletionWords(res); } catch (e) { why = `attempt ${i + 1} threw: ${(e as Error).message}`; break; }
      said.push(words);
      const saysDeleted = /^Your Trainee account is deleted/.test(words), saysNot = /^Your Trainee account was not deleted/.test(words);
      const revokedNow = st.revokes.slice(revokesBefore);
      if (res.deleted !== !st.user) why = `attempt ${i + 1}: deleted=${res.deleted} but the account ${st.user ? "is still there" : "is gone"}`;
      else if (saysDeleted !== !st.user || saysNot !== st.user) why = `attempt ${i + 1}: the words do not match the account (${st.user ? "there" : "gone"})`;
      else if (/Google confirmed/.test(words) && !(revokedNow.length && revokedNow.some((r) => r.answer === 200))) why = `attempt ${i + 1}: "Google confirmed" with no 200 from Google`;
      else if (/I had already disconnected your connected mail/.test(words) && st.conns.size) why = `attempt ${i + 1}: "already disconnected" while connection rows are left`;
      else if (f === "billing" && x.plan && i === 0 && (st.user !== before.user || st.conns.size !== before.conns || st.vault.size !== before.vault || st.files !== before.files)) why = "a plan Stripe did not cancel, and something was deleted";
      else if (TOKENISH.test(words)) why = "a token in the words";
      else if (st.revokes.some((r) => r.answer === "foreign")) why = "a revoke sent a token that is not the person's";
      if (why) break;
      if (!st.user) break;
    }
    if (!why) {
      if (st.user) why = "the last attempt (nothing failing) did not delete the account";
      // What the deleting attempt could not remove (Storage has no cascade; the finance secrets have none) is left only when
      // that attempt's answer said so and how it is finished (the account is gone, so the person cannot ask again). An OAuth
      // token never is: the connection rows' delete takes it.
      else if ([...st.vault.keys()].some((k) => k.startsWith("oauth_") && k.endsWith(x.uid))) why = "an OAuth token is left after the account is gone";
      else if ([...st.vault.keys()].some((k) => k.endsWith(x.uid)) && !/couldn't confirm: .*delete the stored access tokens.*privacy contact/.test(said.at(-1)!)) why = "a secret is left and the last answer did not say so";
      else if (st.files && !/couldn't confirm: .*delete your saved resume files.*privacy contact/.test(said.at(-1)!)) why = `${st.files} saved resume file(s) left and the last answer did not say so`;
      else if (st.conns.size) why = "a connection row is left";
      else if (hadGoogle && !st.revokes.some((r) => r.answer === 200) && !said.some((w) => w.includes(GOOGLE_PERMISSIONS))) why = "a Google grant Google never confirmed revoked, and the person was never told where to remove it";
      else if (x.grants.includes("microsoft") && !said.some((w) => /account\.live\.com|myapps\.microsoft\.com/.test(w))) {
        // An Outlook grant is said when the deletion read it; a first attempt that could not read the grants says to check both.
        if (!said.some((w) => /Microsoft account if you had connected them/.test(w))) why = "an Outlook grant was never said";
      }
      else if (JSON.stringify(st.other) !== otherBefore) why = "another person's outreach naming this person changed";
    }
    rep.grade(x.family, `#${x.id} grants=${x.grants.join("+") || "none"} revoke=${x.revoke} plan=${x.plan} fails=${x.fails.join(">")}`, why, said.map((w) => w.slice(0, 120)).join(" | "));
  }
  rep.assertClean();
});

Deno.test("connectors r4, the keys: what is made from mail is told apart from what is not, as the database does", () => {
  for (const k of ["status", "deadline", "confirmed", "which", "brief", "brief_moved"] as const) eq(mailTextKey(keyOf(k, "t").key), true, k);
  for (const k of ["offer_followup", "offer_thanks"] as const) { eq(mailTextKey(keyOf(k, "t").key), false, k); eq(mailboxText(keyOf(k, "t").key), true, k); }
  for (const k of ["alert", "receipt", "daily_brief", "chat_reminder", "connect_status", "outlook_status", "outreach_followup", "reply", "digest"] as const) eq(mailboxText(keyOf(k, "t").key), false, k);
  const sql = Deno.readTextFileSync(new URL("../../supabase/migrations/20261105130000_connectors_r4.sql", import.meta.url));
  const re = /p_key ~ '([^']+)'/.exec(sql)?.[1];
  eq(re, String(/^(status:([0-9a-f]{64}|deadline:[0-9a-f]{64}|confirmed:[^:]+|which:[0-9a-f]{64})|brief:[0-9a-f]{64}:[^:]+)$/).slice(1, -1), "channel.ts and the migration name the same keys");
});

Deno.test("connectors r4, the generators are deterministic and cover every category", () => {
  eq(JSON.stringify(deliveries(SEED + 41, 50)), JSON.stringify(DELIVERIES.slice(0, 50)), "deliveries are seeded");
  const fams = (xs: { family: string }[]) => new Set(xs.map((x) => x.family));
  for (const e of ["none", "disconnect", "switch", "same_reconnect", "outlook_disconnect", "delete"]) for (const w of ["before_claim", "while_held"]) eq(fams(DELIVERIES).has(`delivery/${e}/${w}`), true, `delivery/${e}/${w}`);
  for (const p of ["gmail", "outlook"]) for (const e of ["none", "disconnect", "switch"]) eq(fams(MAILRUNS).has(`mailrun/${p}/${e}`), true, `${p}/${e}`);
  for (const p of ["google_career", "microsoft"]) for (const e of ["none", "disconnect", "reconnect_same", "switch", "consent_same", "delete"]) eq(fams(REFRESHES).has(`refresh/${p}/${e}`), true, `${p}/${e}`);
  for (const f of ["first_try", "retry_after_billing", "retry_after_grants", "retry_after_vault", "retry_after_disconnect", "retry_after_secrets", "retry_after_files", "retry_after_ledger", "retry_after_user", "retry_after_readback", "retry_after_record"]) eq(fams(ERASURES).has(`erase/${f}`), true, f);
  eq(DELIVERIES.length + MAILRUNS.length + REFRESHES.length + ERASURES.length, 10_000, "ten thousand scenarios");
});
