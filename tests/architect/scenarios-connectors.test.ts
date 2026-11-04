// Connectors, disconnect and erase at scale (owner rules, 2026-10-29), fed ~10,000 generated scenarios
// (tests/architect/scenarios/connectors-generator.ts, seeded):
//   - a disconnect revokes at the provider where it can (Google; Microsoft has no such endpoint and the reply says where to
//     remove the app), deletes the tokens and the rows, erases the mail read from that account, cancels EVERY pending send
//     (approved emails, the rail's queued emails to N people, follow-ups, emails a worker holds, the replies lane's
//     approved follow-ups), and reads back what was done: the reply says only what the read-back shows, and never that
//     Google confirmed a revoke it did not confirm;
//   - "connect gmail" / "link my outlook" from any channel gets a one-time link; "what's connected" one plain answer; a
//     task that needs a connector not connected is asked once with the link, parked, and resumed by the connect callback;
//   - never a password or one-time code through chat; erase deletes the person's data but keeps the global opt-out and
//     bounce lists (hashes); nobody else is touched.
// Part 1 runs the real pure functions over every scenario: the words (connectorAsk / outlookAsk on 6,000 asks), the
// revoke (revokeAtGoogle on 1,500 stored grants and Google answers, no wait between tries), and the whole connector turn
// (connectorChatTurn: "disconnect gmail|outlook", "what's connected") over an in-memory store that answers like the
// database (its triggers included) on 2,500 account states, with one database step failing in some. Part 2
// (flow-scenarios-connectors.test.ts) runs a seeded sample end to end on real Postgres through the real handler.
// No model, no provider, no network.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { type Account, type Answer, accounts, asks, ASKS_SECRET, type Revoke, revokes, type Route } from "./scenarios/connectors-generator.ts";
import { connectorAsk, connectorChatTurn, say } from "../../supabase/functions/_shared/connectors.ts";
import { outlookAsk } from "../../supabase/functions/_shared/outlook_connector.ts";
import { GOOGLE_REVOKE, revokeAtGoogle } from "../../supabase/functions/_shared/google_disconnect.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261029;
export const ASKS = asks(SEED, 6000);
export const REVOKES = revokes(SEED + 1, 1500);
export const ACCOUNTS = accounts(SEED + 2, 2500);

// ------------------------------------------------------------------------------------------------ the report
type Failure = { k: string; input: string; got: string; why: string };
class Report {
  total = 0; fam: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public path: string) {}
  grade(family: string, input: string, why: string | null, got: string) {
    this.total++;
    const top = family.split("/")[0];
    this.fam[top] = (this.fam[top] ?? 0) + 1;
    if (!why) return;
    const k = family.split("/").slice(0, 3).join("/");
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ k, input, got, why });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[connectors] ${this.path}: ${this.total} scenarios (${Object.entries(this.fam).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${JSON.stringify(x.input).slice(0, 160)} -> ${x.got.slice(0, 220)} (${x.why})`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | ${JSON.stringify(xs[0].input).slice(0, 120)} -> ${xs[0].got.slice(0, 160)}`).join(" || ");
    eq(failed, 0, `${this.path}: ${failed} scenarios went wrong: ${first}`);
  }
}

// ------------------------------------------------------------------------------------------------ 1. the words
// What the handler acts on: the connector turn first (connectorAsk), then Outlook's own (outlookAsk), as handler-career.ts.
export function routeOf(message: string): Route {
  const a = connectorAsk(message);
  if (a) return a.kind === "check" ? { kind: "check", need: a.need } : a.kind === "whats_connected" ? { kind: "whats_connected" } : { kind: a.kind, id: a.id };
  const o = outlookAsk(message);
  return o === "connect" ? { kind: "connect", id: "outlook" } : o === "disconnect" ? { kind: "disconnect", id: "outlook" } : o === "status" ? { kind: "status", id: "outlook" } : null;
}
Deno.test(`connectors at scale, the words (connectorAsk, outlookAsk): ${ASKS.length} asks`, () => {
  const rep = new Report("words");
  for (const a of ASKS) {
    const got = routeOf(a.input);
    rep.grade(a.family, a.input, JSON.stringify(got) === JSON.stringify(a.expect) ? null : `must be ${JSON.stringify(a.expect)}`, JSON.stringify(got));
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 2. the revoke
// Google's revoke endpoint per OAuth: 200 revoked; 400 a token it does not accept (not a confirmation); another 4xx
// final; 429, 5xx, a timeout or a network failure tried again, three tries at most per token. The refresh token first,
// then the access token; the first 200 stops.
export function expectedRevoke(v: Revoke): { outcome: string; calls: string[] } {
  if (!v.tokens.length) return { outcome: "no_token", calls: [] };
  const calls: string[] = [];
  let refused = false;
  for (const t of v.tokens) {
    for (let i = 0; i < 3; i++) {
      const a = v.answers[t][i];
      calls.push(t);
      if (a === 200) return { outcome: "revoked", calls };
      if (a === 400) { refused = true; break; }
      if (typeof a === "number" && a !== 429 && a < 500) break;
    }
  }
  return { outcome: refused ? "refused" : "not_confirmed", calls };
}
export function googleFetch(answerOf: (token: string, n: number) => Answer, log: string[]) {
  const tries = new Map<string, number>();
  return (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_REVOKE) throw new Error(`a call left the fake Google: ${url}`);
    const token = new URLSearchParams(String(init?.body ?? "")).get("token") ?? "";
    log.push(token);
    const n = tries.get(token) ?? 0;
    tries.set(token, n + 1);
    const a = answerOf(token, n);
    if (a === "timeout") throw new DOMException("The signal has been aborted", "TimeoutError");
    if (a === "network") throw new TypeError("error sending request: connection reset");
    return new Response(a === 400 ? JSON.stringify({ error: "invalid_token" }) : "", { status: a });
  }) as typeof fetch;
}
Deno.test(`connectors at scale, the revoke (revokeAtGoogle): ${REVOKES.length} stored grants and Google answers`, async () => {
  const rep = new Report("revoke");
  for (const v of REVOKES) {
    const log: string[] = [];
    const sleeps: number[] = [];
    const got = await revokeAtGoogle({ fetch: googleFetch((t, n) => v.answers[t]?.[n] ?? 503, log), sleep: async (ms) => { sleeps.push(ms); } }, v.secret);
    const want = expectedRevoke(v);
    const why = got !== want.outcome ? `must be ${want.outcome}` : JSON.stringify(log) !== JSON.stringify(want.calls) ? `calls must be ${JSON.stringify(want.calls)}` : null;
    rep.grade(`revoke/${v.family}`, String(v.secret), why, `${got} ${JSON.stringify(log)}`);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 3. the connector turn
// An in-memory store that answers the supabase-js calls connectors.ts, google_disconnect.ts and outlook_connector.ts make
// (select/eq/in/limit/order/maybeSingle, update, delete, rpc), with the database's triggers on a connection row's delete
// (20261012060000 Vault, 20261026200011 Gmail mail, 20261027230000 Outlook mail, 20261028110000 + 20261029200000 approved
// and queued emails) and career_connector_waiting. One step can be made to fail (fail), as a network or database error.
const MAIL = ["career_mail_events", "career_mail_drafts", "career_mail_cursors"];
export type Mem = ReturnType<typeof memStore>;
export function memStore(a: Account, U: string) {
  const t: Record<string, any[]> = {
    user_oauth_connections: [], career_mail_events: [], career_mail_drafts: [], career_mail_cursors: [], career_outlook_messages: [], career_outlook_state: [],
    career_outreach_drafts: [], career_send_queue: [], career_send_accounts: [], career_outreach_actions: [], career_parked_tasks: [],
  };
  const vault = new Map<string, string>();
  const tok = (p: string) => JSON.stringify({ refresh_token: `1//FAKErefresh-${p}-${a.id}`, access_token: `ya29.FAKEaccess-${p}-${a.id}`, expires_at: a.token === "expired" ? 1 : 4102444800000 });
  const grant = (provider: string, has: boolean, v: boolean, scopes: string) => {
    if (!has) return;
    t.user_oauth_connections.push({ user_id: U, provider, vault_name: `oauth_${provider}_${U}`, email: `${provider}-${a.id}@example.test`, scopes });
    if (v) vault.set(`oauth_${provider}_${U}`, tok(provider));
  };
  grant("google_career", a.gmail, a.vault.gmail, "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
  grant("gmail", a.legacy, a.vault.legacy, "https://www.googleapis.com/auth/gmail.readonly");
  grant("microsoft", a.outlook, a.vault.outlook, "Mail.Read Mail.Send");
  const refused = a.token === "revoked_at_provider" || a.token === "refresh_failing";
  if (a.gmail && refused) t.career_send_accounts.push({ user_id: U, provider: "gmail", state: "needs_reconnect" });
  if (a.outlook) t.career_outlook_state.push({ user_id: U, needs_reconnect_at: refused ? "2026-10-29T12:00:00Z" : null });
  for (let i = 0; i < a.mail.events; i++) t.career_mail_events.push({ user_id: U, id: i });
  for (let i = 0; i < a.mail.drafts; i++) t.career_mail_drafts.push({ user_id: U, id: i });
  if (a.mail.cursor) t.career_mail_cursors.push({ user_id: U });
  for (let i = 0; i < a.mail.outlook; i++) t.career_outlook_messages.push({ user_id: U, message_hash: `h${i}` });
  let n = 0;
  const draft = (status: string) => { const id = `d${++n}`; t.career_outreach_drafts.push({ id, user_id: U, status, result: null }); return id; };
  for (let i = 0; i < a.approved; i++) draft("approved");
  const q = (provider: string, kind: string, state: string, source_id: string, lease_owner: string | null = null) =>
    t.career_send_queue.push({ id: `q${++n}`, user_id: U, provider, kind, source_id, state, lease_owner, result: null });
  for (const mb of ["gmail", "outlook"] as const) for (let i = 0; i < a.queued[mb]; i++) q(mb, "general", "queued", `s${++n}`);
  if (a.queuedOutreachOn) q(a.queuedOutreachOn, "outreach", "queued", draft("approved"));
  for (let i = 0; i < a.followups; i++) q("gmail", "general", "queued", `f${++n}`);
  if (a.inFlight !== "none") q(a.gmail ? "gmail" : "outlook", "general", "sending", `w${++n}`, "worker-1");
  for (let i = 0; i < a.actions; i++) t.career_outreach_actions.push({ id: `x${++n}`, user_id: U, provider: a.gmail ? "gmail" : "outlook", status: "approved" });
  for (const need of a.parked) t.career_parked_tasks.push({ user_id: U, need, ask: need === "outlook" ? "check my outlook" : need === "gmail" ? "check my gmail" : "check my email", status: "waiting", created_at: "2026-10-29T10:00:00Z" });
  // Some other person's rows, never to be touched.
  const OTHER = "00000000-0000-4000-8000-0000000000ff";
  t.user_oauth_connections.push({ user_id: OTHER, provider: "google_career", vault_name: `oauth_google_career_${OTHER}`, email: "other@example.test", scopes: "openid" });
  vault.set(`oauth_google_career_${OTHER}`, tok("other"));
  t.career_outreach_drafts.push({ id: "other-d", user_id: OTHER, status: "approved", result: null });
  t.career_send_queue.push({ id: "other-q", user_id: OTHER, provider: "gmail", kind: "general", source_id: "o", state: "queued", lease_owner: null, result: null });
  t.career_mail_events.push({ user_id: OTHER, id: 0 });

  let deleted = false, injected = false;
  const err = (what: string) => { injected = true; return { data: null, error: { message: `injected: ${what}` } }; };
  const mb = (provider: string) => (provider === "google_career" ? "gmail" : provider === "microsoft" ? "outlook" : null);
  // The database's triggers on a connection row's delete.
  const onDelete = (row: any) => {
    vault.delete(`oauth_${row.provider}_${row.user_id}`);
    const box = mb(row.provider);
    if (row.provider === "google_career") for (const m of MAIL) t[m] = t[m].filter((r) => r.user_id !== row.user_id);
    if (row.provider === "microsoft") { t.career_outlook_messages = t.career_outlook_messages.filter((r) => r.user_id !== row.user_id); t.career_outlook_state = t.career_outlook_state.filter((r) => r.user_id !== row.user_id); }
    if (!box) return;
    let left = a.fail === "drafts_update" ? 1 : 0; // the database left one approved email (an older schema, a failure)
    const elsewhere = new Set(t.career_send_queue.filter((x) => x.user_id === row.user_id && x.kind === "outreach" && ["queued", "sending"].includes(x.state) && x.provider !== box).map((x) => x.source_id));
    for (const d of t.career_outreach_drafts) if (d.user_id === row.user_id && d.status === "approved" && !elsewhere.has(d.id)) { if (left > 0) { left--; injected = true; continue; } d.status = "skipped"; d.result = `cancelled: ${box} disconnected`; }
    for (const x of t.career_send_queue) if (x.user_id === row.user_id && x.provider === box && ["queued", "sending"].includes(x.state)) { x.state = "cancelled"; x.result = `${box} disconnected`; if (x.lease_owner === null) x.lease_owner = null; }
    for (const x of t.career_outreach_actions) if (x.user_id === row.user_id && x.provider === box && ["shown", "approved", "running"].includes(x.status)) x.status = "cancelled";
    for (const s of t.career_send_accounts) if (s.user_id === row.user_id && s.provider === box) s.state = "disconnected";
  };
  let waitingCalls = 0;
  const waiting = (user: string, box: string) => {
    const elsewhere = new Set(t.career_send_queue.filter((x) => x.user_id === user && x.kind === "outreach" && ["queued", "sending"].includes(x.state) && x.provider !== box).map((x) => x.source_id));
    const approvedIds = new Set(t.career_outreach_drafts.filter((d) => d.user_id === user && d.status === "approved").map((d) => d.id));
    return {
      approved: t.career_outreach_drafts.filter((d) => d.user_id === user && d.status === "approved" && !elsewhere.has(d.id)).length,
      queued: t.career_send_queue.filter((x) => x.user_id === user && x.provider === box && x.state === "queued" && !(x.kind === "outreach" && approvedIds.has(x.source_id))).length,
      actions: t.career_outreach_actions.filter((x) => x.user_id === user && x.provider === box && ["approved", "running"].includes(x.status)).length,
      sending: t.career_send_queue.filter((x) => x.user_id === user && x.provider === box && x.state === "sending").length,
    };
  };
  class Q {
    op: "select" | "update" | "delete" = "select"; preds: ((r: any) => boolean)[] = []; lim = Infinity; single = false; patch: any = null; cols = "*";
    constructor(public table: string) { if (!t[table]) throw new Error(`memory store: no table ${table}`); }
    select(c = "*") { this.cols = c; return this; }
    eq(c: string, v: unknown) { this.preds.push((r) => r[c] === v); return this; }
    in(c: string, vs: unknown[]) { this.preds.push((r) => vs.includes(r[c])); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }
    maybeSingle() { this.single = true; return this; }
    update(p: any) { this.op = "update"; this.patch = p; return this; }
    delete() { this.op = "delete"; return this; }
    exec(): { data: any; error: any } {
      const tb = this.table, match = (r: any) => this.preds.every((p) => p(r));
      if (this.op === "select") {
        if (tb === "user_oauth_connections" && (a.fail === "read_connections" || (a.fail === "readback" && deleted))) return err("read the connections");
        if (MAIL.includes(tb) && (a.fail === "mail_read" || (a.fail === "readback" && deleted))) return err("read the mail rows");
        if (tb === "career_outlook_messages" && a.fail === "readback" && deleted) return err("read the Outlook mail");
        const rows = t[tb].filter(match).slice(0, this.lim).map((r) => ({ ...r }));
        return { data: this.single ? rows[0] ?? null : rows, error: null };
      }
      if (this.op === "update") { for (const r of t[tb]) if (match(r)) Object.assign(r, this.patch); return { data: null, error: null }; }
      if (tb === "user_oauth_connections") {
        if (a.fail === "row_delete") return err("delete the connection");
        deleted = true;
        if (a.fail === "row_delete_noop") return { data: null, error: null };
        const gone = t[tb].filter(match);
        t[tb] = t[tb].filter((r) => !match(r));
        gone.forEach(onDelete);
        return { data: null, error: null };
      }
      if ((MAIL.includes(tb) || tb === "career_outlook_messages") && a.fail === "mail_delete") return err("delete the mail rows");
      t[tb] = t[tb].filter((r) => !match(r));
      return { data: null, error: null };
    }
    then<T>(ok: (r: any) => T, bad?: (e: unknown) => T) { return Promise.resolve().then(() => this.exec()).then(ok, bad); }
  }
  const admin = {
    from: (tb: string) => new Q(tb),
    rpc: async (name: string, args: any) => {
      if (name === "oauth_vault_read") {
        if (a.fail === "vault_read" || (a.fail === "readback" && deleted)) return err("read the Vault");
        return { data: vault.get(args.p_name) ?? null, error: null };
      }
      if (name === "oauth_vault_delete") {
        if (a.fail === "vault_delete") return err("delete from the Vault");
        vault.delete(args.p_name);
        return { data: null, error: null };
      }
      if (name === "career_connector_waiting") {
        waitingCalls++;
        if (a.fail === "drafts_read" || (a.fail === "queue_read" && waitingCalls > 1)) return err("count what waits");
        return { data: waiting(args.p_user, args.p_mailbox), error: null };
      }
      throw new Error(`memory store: no rpc ${name}`);
    },
  };
  return { admin, t, vault, injected: () => injected, waiting };
}

const U = "00000000-0000-4000-8000-0000000000a1";
const ENV = { get: (_k: string): string | undefined => undefined };
// Google's answer for a person: one answer for every try; a grant revoked at Google is a token Google no longer accepts.
const revokeAnswer = (a: Account): Answer => (a.token === "revoked_at_provider" ? 400 : a.revoke);
const pend = (mem: Mem, box: string) => mem.waiting(U, box);

export function turnViolation(a: Account, o: { reply: string; resultStatus: string; intent: string }, before: Mem["t"] & { vault: Map<string, string>; wait: Record<string, ReturnType<Mem["waiting"]>> }, mem: Mem, revokeLog: string[]): string | null {
  const r = o.reply;
  if (say(r, () => {}) !== r) return "the reply carries a token or an internal code";
  if (ASKS_SECRET.test(r)) return "a connector reply never asks for a password or a code";
  // Nobody else is touched.
  const OTHER = "00000000-0000-4000-8000-0000000000ff";
  if (!mem.t.user_oauth_connections.some((x) => x.user_id === OTHER) || !mem.vault.has(`oauth_google_career_${OTHER}`) || mem.t.career_outreach_drafts.find((d) => d.id === "other-d")?.status !== "approved"
    || mem.t.career_send_queue.find((q) => q.id === "other-q")?.state !== "queued" || !mem.t.career_mail_events.some((x) => x.user_id === OTHER)) return "another person's rows changed";
  const mine = (tb: string) => mem.t[tb].filter((x: any) => x.user_id === U);
  if (a.ask === "whats_connected") {
    if (o.intent !== "career_connectors_status") return "the status turn";
    for (const [label, prov] of [["Gmail", "google_career"], ["Outlook", "microsoft"]] as const) {
      const has = before.user_oauth_connections.some((x) => x.user_id === U && x.provider === prov);
      const refused = a.token === "revoked_at_provider" || a.token === "refresh_failing";
      const want = !has ? `${label}: not connected.` : refused ? `${label}: needs reconnecting.` : `${label}: connected (`;
      if (!r.split("\n").some((l) => l.startsWith(want))) return `must say "${want}"`;
    }
    for (const p of a.parked) if (!r.includes(`Waiting for ${p === "mail" ? "Gmail or Outlook" : p === "gmail" ? "Gmail" : "Outlook"}:`)) return "every waiting task is said";
    return null;
  }
  const label = a.ask === "gmail" ? "Gmail" : "Outlook";
  const provs = a.ask === "gmail" ? ["google_career", "gmail"] : ["microsoft"];
  const had = before.user_oauth_connections.filter((x) => x.user_id === U && provs.includes(x.provider)).map((x) => x.provider);
  const rowsLeft = mine("user_oauth_connections").filter((x) => provs.includes(x.provider)).length;
  const vaultLeft = provs.filter((p) => mem.vault.has(`oauth_${p}_${U}`)).length;
  const mailBefore = a.ask === "gmail" ? MAIL.some((m) => before[m].some((x: any) => x.user_id === U)) : before.career_outlook_messages.some((x: any) => x.user_id === U);
  const mailLeft = a.ask === "gmail" ? MAIL.some((m) => mine(m).length) : mine("career_outlook_messages").length > 0;
  const box = a.ask;
  const w0 = before.wait[box], w1 = pend(mem, box);
  const success = new RegExp(`^${label} is disconnected\\.`).test(r);
  const failure = /^I couldn't finish disconnecting|^I disconnected .*, but I couldn't|^I couldn't /.test(r);
  const nothing = /there was nothing to disconnect/.test(r);
  const erasedOnly = /^No Google account is connected to Trainee, but I deleted the application updates, drafts and read time still saved from an earlier connection\.|^Outlook isn't connected to Trainee, but I deleted the mail still saved from an earlier connection\./.test(r);
  if ([success, failure, nothing, erasedOnly].filter(Boolean).length !== 1) return "exactly one of: disconnected, couldn't finish, nothing to disconnect, nothing connected but erased";
  if (erasedOnly && (had.length || !mailBefore || mailLeft)) return "said it erased what an earlier connection saved: only when nothing was connected, mail was saved and none is left";
  if (success && (rowsLeft || vaultLeft || mailLeft)) return "said disconnected, but the read-back shows a row, a token or mail left";
  if (success && w1.approved + w1.queued + w1.actions + w1.sending > 0 && had.some((p) => p !== "gmail")) return "said disconnected, but an email still waits to go";
  if (nothing && (had.length || mailBefore)) return "said nothing to disconnect, but something was connected or saved";
  if (failure && !mem.injected() && !rowsLeft && !vaultLeft && !mailLeft) return "said it couldn't finish, but nothing failed and nothing is left";
  if (o.resultStatus === "completed" && !success && !erasedOnly) return "completed only when disconnected (or what an earlier connection saved was erased)";
  if (o.resultStatus === "failed" && !failure) return "failed only when it says so";
  // Google's confirmation: only when every Google grant held was revoked with Google's 200.
  if (a.ask === "gmail" && had.length) {
    const ans = revokeAnswer(a);
    // Confirmed: Google answered 200 to a token of every grant the person held (the fake answers one way per person).
    const confirmed = ans === 200 && had.every((p) => revokeLog.some((tk) => tk.includes(`-${p}-${a.id}`)));
    if (/Google confirmed Trainee's access is revoked/.test(r) !== confirmed) return confirmed ? "Google confirmed the revoke: say so" : "never say Google confirmed a revoke it did not confirm";
    if (!confirmed && (success || failure) && !/myaccount\.google\.com\/permissions/.test(r)) return "an unconfirmed revoke says where to remove access by hand";
    for (const tk of revokeLog) if (!/^(?:1\/\/FAKErefresh|ya29\.FAKEaccess)-(?:google_career|gmail)-/.test(tk)) return "revoked a token that is not this person's";
  }
  if (a.ask === "outlook" && /Microsoft confirmed|revoked/i.test(r)) return "Microsoft has no revoke: never say it was revoked";
  if (a.ask === "outlook" && success && !/account\.live\.com\/consent\/Manage/.test(r)) return "Outlook says where to remove the app";
  if (a.ask === "gmail" && success) {
    const erasedSaid = /the application updates I had read from your Gmail/.test(r), noneSaid = /No application updates had been saved from your Gmail/.test(r);
    const mailChecked = had.includes("google_career");
    if (mailChecked && (erasedSaid !== mailBefore || noneSaid === mailBefore)) return "what was erased is said exactly";
  }
  // The emails cancelled: exactly what the read-back shows.
  const m = /I also cancelled (\d+) approved emails? that hadn't gone yet/.exec(r);
  const cancelled = Math.max(0, w0.approved - w1.approved) + Math.max(0, w0.queued - w1.queued) + Math.max(0, w0.actions - w1.actions);
  const sender = had.includes(a.ask === "gmail" ? "google_career" : "microsoft");
  if (success && sender && Number(m?.[1] ?? 0) !== cancelled) return `the reply's count must be the read-back's: ${cancelled}`;
  if (!sender && m) return "no sending grant: nothing waited on it";
  const f = /(\d+) emails? (?:was|were) already being sent/.exec(r);
  if (success && sender && Number(f?.[1] ?? 0) !== w0.sending) return `an email a worker held is said as such: ${w0.sending}`;
  if (m && w0.sending && Number(m[1]) > cancelled) return "an email in flight is never counted as cancelled";
  return null;
}

Deno.test(`connectors at scale, the connector turn (connectorChatTurn over the store, "disconnect" and "what's connected"): ${ACCOUNTS.length} account states`, async () => {
  const rep = new Report("connector turn");
  for (const a of ACCOUNTS) {
    const mem = memStore(a, U);
    const before = Object.assign(structuredClone(mem.t), { vault: new Map(mem.vault), wait: { gmail: pend(mem, "gmail"), outlook: pend(mem, "outlook") } });
    const revokeLog: string[] = [];
    let got: any = null, why: string | null = null;
    try {
      got = await connectorChatTurn({ admin: mem.admin, env: ENV, fetch: googleFetch(() => revokeAnswer(a), revokeLog), now: () => Date.parse("2026-10-29T15:00:00Z"), sleep: async () => {},
        message: a.phrase, userId: U, threadId: "00000000-0000-4000-9000-0000000000a1", bridge: false, log: () => {} });
      if (!got) why = "the ask was not taken";
      else why = turnViolation(a, got, before, mem, revokeLog);
    } catch (e) {
      // The handler answers a thrown turn with connectorFailure: allowed only when a step failed.
      why = a.fail === "none" ? `threw: ${(e as Error).message}` : null;
      got = { reply: `threw: ${(e as Error).message}` };
    }
    rep.grade(`${a.ask}/${a.fail}/${a.gmail ? "g" : ""}${a.legacy ? "l" : ""}${a.outlook ? "o" : ""}`, a.phrase, why, String(got?.reply ?? "").replace(/\s+/g, " "));
  }
  rep.assertClean();
});

Deno.test("the generators are deterministic and cover what the owner listed", () => {
  eq(asks(SEED, 6000).map((x) => x.input), ASKS.map((x) => x.input));
  eq(accounts(SEED + 2, 2500).map((x) => x.phrase), ACCOUNTS.map((x) => x.phrase));
  const fam = (p: string) => ASKS.filter((x) => x.family.startsWith(p)).length;
  for (const p of ["disconnect/gmail/typo", "disconnect/outlook/typo", "disconnect/gmail/access", "disconnect/gmail/remove", "disconnect/outlook/unlink", "connect/gmail", "connect/outlook",
    "whats_connected/what-can-you", "whats_connected/is-gmail", "status/outlook", "check/", "mixed", "control"]) assertNode.ok(fam(p) > 20, p);
  for (const m of ["connect gmail", "link my outlook", "disconnect google", "remove gmail access", "unlink outlook", "what's connected", "what can you see"]) assertNode.ok(routeOf(m), m);
  const n = (f: (a: Account) => boolean) => ACCOUNTS.filter(f).length;
  for (const [k, f] of Object.entries({
    none: (a: Account) => !a.gmail && !a.outlook && !a.legacy, gmailOnly: (a: Account) => a.gmail && !a.outlook, outlookOnly: (a: Account) => a.outlook && !a.gmail, both: (a: Account) => a.gmail && a.outlook,
    expired: (a: Account) => a.token === "expired", revoked: (a: Account) => a.token === "revoked_at_provider", refreshFailing: (a: Account) => a.token === "refresh_failing",
    queued: (a: Account) => a.queued.gmail + a.queued.outlook > 0, inFlight: (a: Account) => a.inFlight !== "none", parked: (a: Account) => a.parked.length > 0, actions: (a: Account) => a.actions > 0,
    r200: (a: Account) => a.revoke === 200, r400: (a: Account) => a.revoke === 400, r5xx: (a: Account) => typeof a.revoke === "number" && a.revoke >= 500, timeout: (a: Account) => a.revoke === "timeout", network: (a: Account) => a.revoke === "network",
    failing: (a: Account) => a.fail !== "none",
  })) assertNode.ok(n(f) > 30, k);
  assertNode.ok(ASKS.length + REVOKES.length + ACCOUNTS.length >= 10_000);
});
