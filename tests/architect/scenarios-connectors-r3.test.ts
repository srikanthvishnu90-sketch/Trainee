// Connectors, disconnect and erase, round 3 (owner rules, 2026-10-31), fed ~10,000 generated scenarios
// (tests/architect/scenarios/connectors-r3-generator.ts, seeded; fresh seeds and categories rounds 1 and 2 did not have):
//   - a connect callback is bound to its account and used once: a state replayed exchanges nothing; an account deleted
//     while the person was at Google keeps nothing (no Vault entry, no row) and the new grant is revoked at Google; an
//     address another Trainee account holds is refused in plain words, nothing stored and nothing revoked (that would cut
//     the other account off); nothing of another account changes;
//   - a grant missing a permission (a box left unticked) is said when it connects, and every feature that needs it stops
//     and says which permission and how to give it (Gmail and Outlook alike), never "try again in a minute" or a code;
//   - an inbox run (Gmail's mail run, Outlook's sync) for a person who disconnects or erases everything while it runs
//     writes nothing it read after that and says nothing about it; another person in the same run is unaffected;
//   - a deletion's words say exactly what is kept.
// Part 1 (this file) runs the real functions (googleCallback, missingWords, followupTurn, connectorChatTurn with the real
// Outlook sync, syncInbox, runMail over supabaseMailStore, deletionWords) over an in-memory project whose round-3 RPCs answer
// as 20261031060000_connectors_r3.sql does (scenarios/connectors-r3-memdb.ts). Part 2 (flow-scenarios-connectors-r3.test.ts)
// runs a seeded sample end to end on real Postgres. No model, no provider, no network.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { type Callback, callbacks, deletionWords as deletionCases, fakeTok, GMAIL_READ, GMAIL_SEND, type Inbox, inboxes, partials, type Partial } from "./scenarios/connectors-r3-generator.ts";
import { MemDb } from "./scenarios/connectors-r3-memdb.ts";
import { wordsWhy } from "./scenarios/erase-r2-check.ts";
import { googleCallback, missingWords, PARTIAL_WORDS, REPLAYED_WORDS, TAKEN_WORDS } from "../../supabase/functions/_shared/oauth_connect.ts";
import { GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { followupTurn } from "../../supabase/functions/_shared/career_inbox_followups.ts";
import { connectorChatTurn } from "../../supabase/functions/_shared/connectors.ts";
import { syncInbox, tokenDeps } from "../../supabase/functions/_shared/outlook_connector.ts";
import { outlookToken } from "../../supabase/functions/_shared/outlook_graph.ts";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { deletionWords, KEPT } from "../../supabase/functions/_shared/account_delete.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261031;
export const CALLBACKS = callbacks(SEED + 31, 3500);
export const PARTIALS = partials(SEED + 32, 2500);
export const INBOXES = inboxes(SEED + 33, 2500);
export const DELETIONS = deletionCases(SEED + 34, 1500);
const NOW = Date.UTC(2026, 9, 31, 15, 0, 0);
const CODEISH = /\b[A-Z]{2,}(?:_[A-Z]{2,})+\b|undefined|\bnull\b|\[object/;
const TOKENISH = /ya29\.|1\/\/|refresh_token|access_token|client_secret/;

type Failure = { k: string; input: string; got: string; why: string };
class Report {
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
    const lines = [`[connectors r3] ${this.path}: ${this.total} scenarios, ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((x, y) => y[1].length - x[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${x.input} -> ${x.got.slice(0, 240)} (${x.why})`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | ${xs[0].input} -> ${xs[0].got.slice(0, 160)}`).join(" || ");
    eq(failed, 0, `${this.path}: ${failed} scenarios went wrong: ${first}`);
  }
}

// ------------------------------------------------------------------------------------------------ 1. callbacks
// Google, faked at the HTTP boundary: the token endpoint (per scenario), userinfo, the revoke. Anything else is refused.
function fakeGoogle(c: Callback) {
  const calls: { url: string; body: string }[] = [];
  let n = 0;
  const f = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init?.body == null ? "" : String(init.body);
    calls.push({ url, body });
    if (url === "https://oauth2.googleapis.com/token") {
      n++;
      if (c.token === 400) return new Response('{"error":"invalid_grant"}', { status: 400 });
      if (c.token === 500) return new Response("", { status: 500 });
      if (c.token === "no_access") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ access_token: fakeTok("access", `${c.id}-${n}`), ...(c.refresh ? { refresh_token: fakeTok("refresh", `${c.id}-${n}`) } : {}), expires_in: 3600,
        ...(c.scopes.length ? { scope: c.scopes.join(" ") } : {}) }), { status: 200 });
    }
    if (url === "https://www.googleapis.com/oauth2/v2/userinfo") return new Response(JSON.stringify(c.email ? { email: c.email } : {}), { status: 200 });
    if (url === GOOGLE_REVOKE) {
      if (c.revoke === "network") throw new TypeError("error sending request: connection reset");
      return new Response(c.revoke === 400 ? '{"error":"invalid_token"}' : "", { status: c.revoke });
    }
    throw new Error(`a call left the fake Google: ${url}`);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const variant = (email: string, v: Callback["addrVariant"]) => v === "upper" ? email.toUpperCase() : v === "spaced" ? ` ${email} ` : email;

Deno.test(`connectors r3, the connect callback (googleCallback): ${CALLBACKS.length} callbacks (gone, replayed, taken, partial, Google's answers)`, async () => {
  const rep = new Report("callbacks");
  for (const c of CALLBACKS) {
    const db = new MemDb();
    db.users.add(c.other);
    if (!c.gone) db.users.add(c.uid);
    const held = c.email ? variant(c.email, c.addrVariant) : "someone@example.test";
    const holderRow = c.holder === "other_career" ? { user_id: c.other, provider: "google_career" } : c.holder === "other_legacy" ? { user_id: c.other, provider: "gmail" }
      : c.holder === "other_microsoft" ? { user_id: c.other, provider: "microsoft" } : c.holder === "self_legacy" && !c.gone ? { user_id: c.uid, provider: "gmail" } : null;
    if (holderRow) {
      const name = `oauth_${holderRow.provider}_${holderRow.user_id}`;
      db.rows("user_oauth_connections").push({ ...holderRow, vault_name: name, email: held, scopes: "openid email", connected_at: "2026-10-01T00:00:00Z" });
      db.vault.set(name, JSON.stringify({ access_token: fakeTok("access", `held-${c.id}`), refresh_token: fakeTok("refresh", `held-${c.id}`) }));
    }
    const before = { rows: JSON.stringify(db.rows("user_oauth_connections").filter((r) => r.user_id !== c.uid || r.provider !== "google_career")), vault: JSON.stringify([...db.vault].filter(([k]) => k !== `oauth_google_career_${c.uid}`)) };
    const g = fakeGoogle(c);
    const state = `${c.uid}.${NOW + 600_000}.career.${"s".repeat(43)}${c.id}`;
    const outs: any[] = [];
    for (let k = 0; k < c.uses; k++) {
      const callsBefore = g.calls.length;
      const out = await googleCallback({ admin: db as any, fetch: g.fetch, now: () => NOW, clientId: "fake-client-0000", clientSecret: "fake-secret-0000", redirectUri: "https://proj.example.test/functions/v1/gmail-oauth",
        grantedFallback: () => `openid email ${GMAIL_READ}`, sleep: async () => {} }, { code: `fake-code-${c.id}-${k}`, state, userId: c.uid, provider: "google_career" });
      outs.push({ out, calls: g.calls.slice(callsBefore) });
    }
    const why = (() => {
      const first = outs[0];
      for (const [k, o] of outs.entries()) {
        if (k > 0) {
          if (o.out.ok || o.out.why !== "replayed") return `use ${k + 1} of the same state was not refused as replayed (${JSON.stringify(o.out)})`;
          if (o.calls.length) return "a replayed state reached Google";
        }
      }
      const tokenCalls = first.calls.filter((x: any) => x.url === "https://oauth2.googleapis.com/token").length;
      if (tokenCalls !== 1) return `the first use exchanged ${tokenCalls} codes`;
      const revokes = first.calls.filter((x: any) => x.url === GOOGLE_REVOKE);
      const mine = db.vault.get(`oauth_google_career_${c.uid}`);
      const row = db.rows("user_oauth_connections").find((r) => r.user_id === c.uid && r.provider === "google_career");
      const after = { rows: JSON.stringify(db.rows("user_oauth_connections").filter((r) => r.user_id !== c.uid || r.provider !== "google_career")), vault: JSON.stringify([...db.vault].filter(([k]) => k !== `oauth_google_career_${c.uid}`)) };
      if (after.rows !== before.rows || after.vault !== before.vault) return "another connection (another account's, or this account's other grant) changed";
      if (c.token !== "ok") {
        if (first.out.ok || first.out.why !== "exchange") return `a failed exchange was ${JSON.stringify(first.out)}`;
        if (mine || row || revokes.length) return "a failed exchange stored or revoked something";
        return null;
      }
      const taken = !!c.email && (c.holder === "other_career" || c.holder === "other_legacy");
      if (taken) {
        if (first.out.ok || first.out.why !== "taken") return `an address another account holds was ${JSON.stringify(first.out)}`;
        if (mine || row) return "an address another account holds was stored here";
        if (revokes.length) return "the shared Google grant was revoked (the other account would be cut off)";
        const w = TAKEN_WORDS("Gmail", first.out.email ?? null);
        if (CODEISH.test(w) || TOKENISH.test(w) || !w.includes("another Trainee account") || (c.email && !w.includes(c.email))) return `the refusal is not plain: ${w}`;
        return null;
      }
      if (c.gone) {
        if (first.out.ok || first.out.why !== "gone") return `a deleted account's callback was ${JSON.stringify(first.out)}`;
        if (mine || row) return "a Vault entry or a row was stored for an account that no longer exists";
        if (!revokes.length) return "the new grant of a deleted account was not revoked at Google";
        const said = revokes.map((x: any) => new URLSearchParams(x.body).get("token"));
        if (said.some((t: any) => !String(t).endsWith(`-${c.id}-1`))) return "a revoke sent a token that was not this callback's";
        if (first.out.revoke === "revoked" && c.revoke !== 200) return "a revoke Google did not confirm is called revoked";
        return null;
      }
      if (!first.out.ok) return `a good callback was refused: ${JSON.stringify(first.out)}`;
      if (revokes.length) return "a good callback revoked something";
      if (!mine || !row) return "a good callback stored nothing";
      const s = JSON.parse(mine);
      if (s.access_token !== fakeTok("access", `${c.id}-1`)) return "the stored access token is not this callback's";
      const scopes = c.scopes.length ? c.scopes.join(" ") : `openid email ${GMAIL_READ}`;
      if (row.scopes !== scopes) return `the row's scopes ${row.scopes} are not what Google granted (${scopes})`;
      if ((row.email ?? null) !== c.email) return "the row's address is not Google's";
      return null;
    })();
    rep.grade(c.family, `#${c.id} gone=${c.gone} uses=${c.uses} holder=${c.holder} token=${c.token} email=${c.email ? "yes" : "no"}`, why, JSON.stringify(outs.map((o) => o.out)));
  }
  eq(REPLAYED_WORDS.includes("already used") && !CODEISH.test(REPLAYED_WORDS), true, "the replay page is plain");
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 2. partial grants
const MS_ENV = new Map(Object.entries({ MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client-0000", MICROSOFT_OAUTH_CLIENT_SECRET: "fake-ms-secret-0000" }));
const env = { get: (k: string) => MS_ENV.get(k) };
const DELTA_LINK = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-d1";
function fakeGraph(o: { mails?: number; tag?: string | number; onRead?: () => void; onRespond?: () => void } = {}) {
  const calls: string[] = [];
  const f = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (!url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta")) throw new Error(`a call left the fake Microsoft: ${url}`);
    o.onRead?.();
    const value = Array.from({ length: o.mails ?? 0 }, (_, i) => ({ id: `m-${o.tag}-${i}`, subject: "Re: your application", bodyPreview: "Thanks for applying", receivedDateTime: new Date(NOW - 60_000 * (i + 1)).toISOString(),
      from: { emailAddress: { address: `recruiter-${i}@acme.example` } } }));
    o.onRespond?.();
    return new Response(JSON.stringify({ value, "@odata.deltaLink": DELTA_LINK }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
function outlookPerson(db: MemDb, uid: string, scopes: string) {
  db.users.add(uid);
  db.rows("user_oauth_connections").push({ user_id: uid, provider: "microsoft", vault_name: `oauth_microsoft_${uid}`, email: `${uid.slice(-6)}@contoso.example`, scopes, connected_at: new Date(NOW - 86_400_000).toISOString() });
  db.vault.set(`oauth_microsoft_${uid}`, JSON.stringify({ access_token: fakeTok("access", uid.slice(-6)), refresh_token: fakeTok("refresh", uid.slice(-6)), expires_at: NOW + 3_600_000 }));
  db.rows("career_outlook_state").push({ user_id: uid, needs_reconnect_at: null, delta_link: null, synced_at: null });
}

Deno.test(`connectors r3, a grant missing a permission (missingWords, "check my email", "check my outlook"): ${PARTIALS.length} grants`, async () => {
  const rep = new Report("partials");
  for (const p of PARTIALS) {
    const reads = p.provider === "gmail" ? p.granted.includes(GMAIL_READ) : p.granted.includes("Mail.Read");
    const sends = p.provider === "gmail" ? p.granted.includes(GMAIL_SEND) : p.granted.includes("Mail.Send");
    let got = "", why: string | null = null;
    if (p.ask === "confirm") {
      got = missingWords(p.provider, p.granted, { sendAsked: p.sendAsked });
      const sendMissing = !sends && (p.provider === "outlook" || p.sendAsked);
      if (/read your mail/.test(got) !== !reads) why = reads ? "a grant that may read is told it may not" : "a grant that may not read mail is not told so";
      else if (/send email/.test(got) !== sendMissing) why = sendMissing ? "a grant that may not send is not told so" : "send is said missing when it was granted or never asked";
      else if ((got === "") !== (reads && !sendMissing)) why = "something is said missing when nothing is (or the reverse)";
      else if (got && !got.includes(p.provider === "gmail" ? '"connect gmail"' : '"connect my outlook"')) why = "a missing permission does not say how to give it";
      else if (CODEISH.test(got)) why = "an internal code in the words";
    } else if (p.provider === "gmail") {
      const r = await followupTurn({ message: "check my email", userId: p.uid, threadId: "T", now: NOW, deps: {
        mailOn: true, connectAsk: 'Text "connect gmail" for a link.',
        readNow: async () => reads ? { status: "ok", read: 0, statuses: [], offers: [], read_through: null } : { status: "NOT_WIRED" },
        readGrant: async () => (reads ? "ok" : "not_allowed"),
      } as any });
      got = r?.reply ?? "(no answer)";
      if (CODEISH.test(got)) why = "an internal code in the reply";
      else if (!reads && got !== PARTIAL_WORDS.gmail.read) why = "a Gmail grant without read access is not told which permission and how to give it";
      else if (reads && /didn't allow/.test(got)) why = "a grant that reads is told it may not";
    } else {
      const db = new MemDb();
      outlookPerson(db, p.uid, p.granted.join(" "));
      const g = fakeGraph({ mails: 0, tag: p.id });
      const r = await connectorChatTurn({ admin: db, env, fetch: g.fetch, now: () => NOW, message: "check my outlook", userId: p.uid, threadId: "T", bridge: false, log: () => {} } as any);
      got = r?.reply ?? "(no answer)";
      if (CODEISH.test(got)) why = "an internal code in the reply";
      else if (!reads && got !== PARTIAL_WORDS.outlook.read) why = "an Outlook grant without Mail.Read is not told which permission and how to give it";
      else if (!reads && g.calls.length) why = "Microsoft was asked for mail the grant may not read";
      else if (reads && !/^I read your Outlook/.test(got)) why = "a grant that reads was not read";
    }
    rep.grade(p.family, `#${p.id} ${p.provider} ${p.ask} granted=${p.granted.filter((s) => !/openid|email|offline|User\.Read/.test(s)).map((s) => s.replace(/^.*\//, "")).join(",") || "nothing"}`, why, got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 3. inbox runs racing an ask
const AUTH = ["mx.google.com; dkim=pass header.i=@greenhouse.io header.s=s1; spf=pass smtp.mailfrom=greenhouse.io; dmarc=pass (p=REJECT) header.from=greenhouse.io"];
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
const rejection = (tag: string, i: number) => ({ hash: hex(`${tag}-${i}`), from: "Asana <no-reply@greenhouse.io>", subject: "Your Asana application",
  snippet: "Unfortunately, we have decided not to move forward with your application.", date: new Date(NOW - 120_000 - i * 1000).toISOString(), auth: AUTH });
const APP = { ref: "track:a1", company: "Asana", role: "Account Manager", stage: "Submitted", source: "tracker" as const, applied_at: new Date(NOW - 864e6).toISOString(), events: [] };
function gmailPerson(db: MemDb, uid: string, epoch: number) {
  db.users.add(uid);
  db.rows("user_oauth_connections").push({ user_id: uid, provider: "google_career", vault_name: `oauth_google_career_${uid}`, email: `${uid.slice(-6)}@example.test`, scopes: `openid email ${GMAIL_READ}` });
  db.rows("career_mail_cursors").push({ user_id: uid, read_through: new Date(NOW - 3_600_000).toISOString() });
  if (epoch) db.rows("career_watch_kv").push({ user_id: uid, key: "career:account", value: { epoch, paused: false } });
}
// Expected: the run writes (and says) what it read only when the ask came before the run began and kept the mailbox (an
// erase before the run: what the run reads after it is new), or never came.
const expectStored = (x: Inbox) => x.when === "none" || (x.when === "before_read" && x.what === "erase");

Deno.test(`connectors r3, an inbox run racing a disconnect or an erase (runMail over supabaseMailStore, syncInbox): ${INBOXES.length} runs`, async () => {
  const rep = new Report("inbox");
  for (const x of INBOXES) {
    const db = new MemDb();
    const ask = () => (x.what === "disconnect" ? db.disconnect(x.uid, x.provider === "gmail" ? "google_career" : "microsoft") : db.erase(x.uid));
    let why: string | null = null, got = "";
    if (x.provider === "outlook") {
      for (const u of [x.uid, x.other]) { outlookPerson(db, u, "openid email offline_access User.Read Mail.Read"); if (x.priorEpoch) db.rows("career_watch_kv").push({ user_id: u, key: "career:account", value: { epoch: x.priorEpoch } }); }
      if (x.when === "before_read") ask();
      const run = async (u: string, mine: boolean) => {
        const g = fakeGraph({ mails: x.mails, tag: u.slice(-6), onRead: mine && x.when === "during_read" ? ask : undefined, onRespond: mine && x.when === "after_check" ? ask : undefined });
        const td = tokenDeps(db, env, g.fetch, () => NOW);
        return await syncInbox(db, { fetch: g.fetch, now: () => NOW, token: (uu: string, s: string) => outlookToken(td, uu, s), waitMs: 1 }, u, NOW);
      };
      const mine = await run(x.uid, true), theirs = await run(x.other, false);
      const kept = db.rows("career_outlook_messages").filter((r) => r.user_id === x.uid).length;
      const keptOther = db.rows("career_outlook_messages").filter((r) => r.user_id === x.other).length;
      got = JSON.stringify({ mine, kept, keptOther });
      if (expectStored(x)) { if (kept !== x.mails || mine.status !== "ok") why = "a run with nothing withdrawn did not keep what it read"; }
      else if (kept) why = `${kept} message(s) read before the ask were written after it`;
      else if (mine.status === "ok" && Object.keys(mine.patch ?? {}).length) why = "a withdrawn mailbox's read position was kept";
      if (!why && (keptOther !== x.mails || theirs.status !== "ok")) why = "the other person's sync was touched";
    } else {
      for (const u of [x.uid, x.other]) gmailPerson(db, u, x.priorEpoch);
      if (x.when === "before_read") ask();
      const base = supabaseMailStore(db);
      let checks = 0;
      const store = { ...base, applications: async () => [APP],
        async stillConnected(u: string) { const r = await base.stillConnected!(u); if (u === x.uid && x.when === "after_check" && ++checks === 1) ask(); return r; } };
      const outbox = memoryAlertStore();
      const stats = await runMail({ outbox, now: NOW, store, read: async (u) => {
        if (u === x.uid && x.when === "during_read") ask();
        return { status: "ok", mails: Array.from({ length: x.mails }, (_, i) => rejection(u.slice(-6), i)), readThrough: NOW, listed: x.mails };
      } });
      const ev = (u: string) => db.rows("career_mail_events").filter((r) => r.user_id === u).length;
      const said = (u: string) => outbox.dump().outbox.filter((o: any) => o.userId === u).length;
      got = JSON.stringify({ events: ev(x.uid), said: said(x.uid), drafts: db.rows("career_mail_drafts").filter((r) => r.user_id === x.uid).length, stats });
      if (expectStored(x)) { if (!ev(x.uid) || !said(x.uid)) why = "a run with nothing withdrawn did not keep or say what it read"; }
      else if (ev(x.uid)) why = `${ev(x.uid)} status event(s) read before the ask were written after it`;
      else if (said(x.uid)) why = "what was read before the ask was said after it";
      else if (db.rows("career_mail_drafts").some((r) => r.user_id === x.uid)) why = "a draft made from mail read before the ask was kept";
      else if (x.what === "disconnect" && db.rows("career_mail_cursors").some((r) => r.user_id === x.uid)) why = "a disconnected mailbox's read position was written again";
      if (!why && (!ev(x.other) || !said(x.other))) why = "the other person's run was touched";
    }
    rep.grade(x.family, `#${x.id} ${x.provider} ${x.what} ${x.when} mails=${x.mails} epoch=${x.priorEpoch}`, why, got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 4. what a deletion keeps
Deno.test(`connectors r3, what the person is told a deletion kept (deletionWords): ${DELETIONS.length} outcomes`, () => {
  const rep = new Report("deletion words");
  for (const d of DELETIONS) {
    const r = { deleted: d.deleted, google: d.google, outlook: d.outlook, failures: d.failures, had: d.had, disconnected: d.disconnected, grantsRead: d.grantsRead, recorded: d.recorded, billing: d.billing } as any;
    const x = deletionWords(r);
    let why = wordsWhy(r, x);
    if (!why && d.deleted) {
      if (!x.includes(KEPT.hashes)) why = "the opt-out and bounce hashes kept are not said";
      else if (x.includes(KEPT.record) !== d.recorded) why = d.recorded ? "the deletion's own record is kept and not said" : "a record is said kept when none was written";
      else if (x.includes(KEPT.stripe) !== (d.billing === "cancelled")) why = d.billing === "cancelled" ? "Stripe's payment record is not said" : "Stripe is said to keep a record for a person who had no plan";
    }
    if (!why && !d.deleted && x.includes("What is kept")) why = "an account not deleted is told what a deletion kept";
    rep.grade(d.family, `#${d.id} ${d.family}`, why, x);
  }
  rep.assertClean();
});

Deno.test("connectors r3, the generators are deterministic and cover every category", () => {
  eq(JSON.stringify(callbacks(SEED + 31, 50)), JSON.stringify(CALLBACKS.slice(0, 50)), "callbacks are seeded");
  const fams = (xs: { family: string }[]) => new Set(xs.map((x) => x.family));
  for (const f of ["gone", "replayed", "taken", "connect", "exchange_400", "exchange_500", "exchange_no_access"]) eq(fams(CALLBACKS).has(f), true, `callbacks: ${f}`);
  for (const f of ["gmail/check/no_read", "gmail/check/reads", "outlook/check/no_read", "outlook/check/reads", "gmail/confirm/no_read", "outlook/confirm/reads"]) eq(fams(PARTIALS).has(f), true, `partials: ${f}`);
  for (const p of ["gmail", "outlook"]) for (const w of ["disconnect_during_read", "disconnect_after_check", "erase_during_read", "erase_after_check", "erase_before_read", "none"]) eq(fams(INBOXES).has(`${p}/${w}`), true, `inbox: ${p}/${w}`);
  eq(CALLBACKS.length + PARTIALS.length + INBOXES.length + DELETIONS.length, 10_000, "about ten thousand scenarios");
});
