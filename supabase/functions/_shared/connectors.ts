// Task 3 (2026-10-28): one connector framework. Gmail and Outlook plug into one registry (CONNECTORS) with the same shape:
// id, scopes, a one-time connect link from any channel bound to the person and thread, a token getter that refreshes,
// a disconnect that revokes where the provider allows it, erases what was read, cancels pending sends and reads back, and
// a status. On top of the registry, the parts every connector shares:
//   connectorChatTurn   "what's connected" (one plain answer: each connector, its state, what it's used for, what waits
//                       on it), "connect gmail" (a link from any channel), "disconnect gmail|outlook", and a task that
//                       needs a connector the person hasn't connected ("check my outlook"): asked ONCE with the link, the
//                       task parked by person and need (career_parked_tasks), never asked again while it waits.
//   afterConnect        called by each connector's OAuth callback once the grant is stored: tells the person in the
//                       chat the link came from (Gmail; Outlook tells itself) and resumes every parked task the
//                       connector satisfies, each exactly once (a claim with a lease, then the task's turn re-run as the
//                       person through agent-chat with a stable turn key).
//   resumeDue           a sweeper's batch: tasks whose connector is connected but whose resume failed or never ran.
//   handleConnectorLink the Gmail link's page (GET peeks, POST is the person's tap, then Google's consent), served by
//                       gmail-oauth so the OAuth client's redirect URI does not change; gmail-oauth's own verified
//                       callback stores the grant, then calls afterConnect.
// Rules kept in code: tokens live only in the person's Vault entry (oauth_<provider>_<uid>); no token, code or secret is
// logged, returned or shown; every reply goes through say(), which refuses a token-shaped string or an internal code.
// Microsoft (outlook_graph.ts) and Google are the only network peers, both faked at the HTTP boundary in tests.
// deno-lint-ignore-file no-explicit-any
import { connectLine, connectUrlsFor } from "./connect_link.ts";
import { FONT_CSP, systemPage } from "./brand.ts";
import { careerTokenFor, CAREER_READ_SCOPE, CAREER_SEND_SCOPE } from "./career_mail_gmail.ts";
import { disconnectGoogle, disconnectReply, revokeWords } from "./google_disconnect.ts";
import { askWords, disconnectOf, gmailConnectOf, whatsConnectedOf } from "./connector_words.ts";
import { consentNotice, GMAIL_READONLY, GMAIL_SEND, requestableScopes } from "./google_scopes.ts";
import { channelOf, disconnectOutlook, disconnectWords, linkBase as outlookLinkBase, MICROSOFT_NOTE, outlookFor, RECONNECT_REPLY, TELEGRAM_BROWSER, tokenDeps as msTokenDeps } from "./outlook_connector.ts";
import { ENV as MS_ENV, hasScope, outlookToken, PROVIDER as MS_PROVIDER } from "./outlook_graph.ts";
import { vaultRefreshWrite } from "./oauth_vault_refresh.ts";
import { missingWords, PARTIAL_WORDS } from "./oauth_connect.ts";
export { missingWords, PARTIAL_WORDS };

type Admin = any;
export interface Env { get(k: string): string | undefined }
// sleep: the wait between a provider's retries (tests pass a no-op; production waits).
export interface Deps { admin: Admin; env: Env; fetch: typeof fetch; now: () => number; sleep?: (ms: number) => Promise<void> }
const at = (ms: number) => new Date(ms).toISOString();
const must = (r: any, what: string) => { if (r?.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r?.data; };
const split = (s: unknown) => (Array.isArray(s) ? s.map(String) : String(s ?? "").split(/[\s,]+/)).filter(Boolean);

// ------------------------------------------------------------------------------------------------ the guard on every reply
// A reply never carries a token (Google ya29./1// tokens, a JWT, a Microsoft EwA/EwB token, a bearer header) or an internal
// status code (NOT_WIRED, NEEDS_RECONNECT, any SHOUTED_SNAKE word). One that would is replaced by a plain sentence that
// says nothing was done with it, and the reason is logged without the text.
const TOKENISH = /(?:\bya29\.[\w-]{6,}|\b1\/\/[\w-]{10,}|\beyJ[\w-]{8,}\.[\w-]{8,}|\bEw[AB][\w+/=-]{20,}|\bbearer\s+[\w.-]{12,}|refresh_token|access_token|client_secret)/i;
const CODEISH = /\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/;
export const GUARDED = "Something went wrong on my side while answering that, so I stopped before saying more. Nothing was sent.";
export function say(text: string, log: (l: string) => void = (l) => console.error(l)): string {
  const t = String(text ?? "");
  // The connect link's own one-time token (?t=) is meant to be shown; everything else in the text is checked.
  const bare = t.replace(/[?&]t=[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g, "");
  if (TOKENISH.test(bare)) { log("connectors: a reply carried a token-shaped string; replaced"); return GUARDED; }
  if (CODEISH.test(bare)) { log("connectors: a reply carried an internal code; replaced"); return GUARDED; }
  return t;
}

// ------------------------------------------------------------------------------------------------ the registry
export type ConnectorId = "gmail" | "outlook";
export type Need = ConnectorId | "mail"; // mail: either mail connector does
export type Cap = "read" | "send" | "calendar";
export type State = "connected" | "not_connected" | "needs_reconnect";
export interface Status { id: ConnectorId; label: string; state: State; email: string | null; uses: string[] }
export type TokenOut =
  | { status: "ok"; token: string }
  | { status: "not_connected" | "needs_reconnect" | "not_allowed" | "not_wired" }
  | { status: "rate_limited"; retryAfterMs: number }
  | { status: "error"; detail: string };
// erased: data kept from an earlier connection was deleted although nothing was connected.
// note: what the provider said to the revoke (or where to remove the app), kept in every reply that says it disconnected.
export interface DisconnectOut { ok: boolean; had: boolean; erased?: boolean; reply: string; failures: string[]; note?: string }
export interface Connector {
  id: ConnectorId;
  label: string;
  provider: string; // user_oauth_connections.provider; the Vault entry is oauth_<provider>_<user>
  connectAsk: string; // what the person texts to connect
  disconnectAsk: string;
  scopes: Record<Cap, string | null>;
  uses(scopes: string[]): string[]; // what it's used for, in plain words, from what was granted
  wired(env: Env): boolean; // the owner has configured it (client id, state secret, link base)
  issueLink(d: Deps, o: { userId: string; threadId: string | null; channel: string }): Promise<string | null>; // the URL, or null when not wired
  token(d: Deps, userId: string, cap: Cap): Promise<TokenOut>; // refreshed when needed; never shown
  needsReconnect(d: Deps, userId: string): Promise<boolean>;
  disconnect(d: Deps, userId: string): Promise<DisconnectOut>;
}

export const vaultNameOf = (c: Connector, userId: string) => `oauth_${c.provider}_${userId}`;
const gmailLinkBase = (env: Env) => {
  const u = env.get("GMAIL_LINK_BASE") || (env.get("SUPABASE_URL") ? `${env.get("SUPABASE_URL")}/functions/v1/gmail-oauth` : "");
  return u ? u.replace(/\/$/, "") : null;
};

const gmail: Connector = {
  id: "gmail", label: "Gmail", provider: "google_career", connectAsk: "connect gmail", disconnectAsk: "disconnect gmail",
  scopes: { read: GMAIL_READONLY, send: GMAIL_SEND, calendar: null },
  uses: (s) => [s.includes(GMAIL_READONLY) && "read employers' replies and application codes (sender, subject and preview only)",
    s.includes(GMAIL_SEND) && "send emails you approve word for word"].filter(Boolean) as string[],
  wired: (env) => !!(env.get("GOOGLE_OAUTH_CLIENT_ID") && env.get("OAUTH_STATE_SECRET") && gmailLinkBase(env)),
  async issueLink(d, o) {
    const base = gmailLinkBase(d.env);
    if (!this.wired(d.env) || !base) return null;
    const t = must(await d.admin.rpc("career_connector_link_issue", { p_user: o.userId, p_connector: "gmail", p_channel: o.channel, p_thread: o.threadId, p_now: at(d.now()) }), "make the Gmail link");
    return `${base}?t=${encodeURIComponent(String(t))}`;
  },
  async token(d, userId, cap) {
    const scope = cap === "send" ? CAREER_SEND_SCOPE : cap === "read" ? CAREER_READ_SCOPE : null;
    if (!scope) return { status: "not_allowed" };
    const conn = must(await d.admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", userId).eq("provider", "google_career").maybeSingle(), "read the Gmail connection");
    // The guard: only the person's own Vault entry, by its one name. A row naming any other entry is no connection.
    if (!conn || conn.vault_name !== vaultNameOf(this, userId)) return { status: "not_connected" };
    if (!split(conn.scopes).includes(scope)) return { status: "not_allowed" };
    if (!d.env.get("GOOGLE_OAUTH_CLIENT_ID")) return { status: "not_wired" };
    try {
      const tok = await careerTokenFor({
        fetch: d.fetch, env: d.env, now: d.now, connection: async () => conn,
        readVault: async (n) => { const v = must(await d.admin.rpc("oauth_vault_read", { p_name: n }), "read the Gmail access"); return v ? String(v) : null; },
        writeVault: (n, s) => vaultRefreshWrite(d.admin, n, s, "save the refreshed Gmail access"),
      }, scope)(userId);
      return tok ? { status: "ok", token: tok } : { status: "needs_reconnect" };
    } catch (e) { return { status: "error", detail: String((e as Error)?.message ?? e).slice(0, 120) }; }
  },
  // Google's refusal shows when a token is asked for. The sending rail records it (career_send_accounts 'needs_reconnect',
  // cleared when the person connects again), so "what's connected" never calls a refused grant connected.
  async needsReconnect(d, userId) {
    const r = must(await d.admin.from("career_send_accounts").select("state").eq("user_id", userId).eq("provider", "gmail").maybeSingle(), "read the Gmail sending state");
    return r?.state === "needs_reconnect";
  },
  async disconnect(d, userId) {
    const r = await disconnectGoogle(d.admin, userId, { fetch: d.fetch, sleep: d.sleep });
    return { ok: r.ok, had: r.had.length > 0, erased: r.mailErased, reply: disconnectReply(r), failures: r.failures, note: revokeWords(r) };
  },
};

const outlook: Connector = {
  id: "outlook", label: "Outlook", provider: MS_PROVIDER, connectAsk: "connect my outlook", disconnectAsk: "disconnect outlook",
  scopes: { read: "Mail.Read", send: "Mail.Send", calendar: "Calendars.ReadWrite" },
  uses: (s) => [hasScope(s, "Mail.Read") && "read your mail for replies (sender, subject and preview only)", hasScope(s, "Mail.Send") && "send emails you approve word for word",
    hasScope(s, "Calendars.ReadWrite") && "check your calendar and add invites you approve"].filter(Boolean) as string[],
  wired: (env) => !!(env.get(MS_ENV.clientId) && env.get(MS_ENV.stateSecret) && outlookLinkBase(env)),
  async issueLink(d, o) {
    const base = outlookLinkBase(d.env);
    if (!this.wired(d.env) || !base) return null;
    const t = must(await d.admin.rpc("career_outlook_link_issue", { p_user: o.userId, p_channel: o.channel, p_thread: o.threadId, p_purpose: "connect", p_now: at(d.now()) }), "make the Outlook link");
    return `${base}?t=${encodeURIComponent(String(t))}`;
  },
  async token(d, userId, cap) {
    const scope = this.scopes[cap];
    if (!scope) return { status: "not_allowed" };
    try {
      const r = await outlookToken(msTokenDeps(d.admin, d.env, d.fetch, d.now), userId, scope);
      if (r.status === "ok") return r;
      if (r.status === "NEEDS_RECONNECT") return { status: "needs_reconnect" };
      if (r.status === "RATE_LIMITED") return { status: "rate_limited", retryAfterMs: r.retryAfterMs };
      if (r.status === "ERROR") return { status: "error", detail: r.detail };
      return { status: /does not allow/.test(r.reason) ? "not_allowed" : /not configured/.test(r.reason) ? "not_wired" : "not_connected" };
    } catch (e) { return { status: "error", detail: String((e as Error)?.message ?? e).slice(0, 120) }; }
  },
  async needsReconnect(d, userId) {
    const r = must(await d.admin.from("career_outlook_state").select("needs_reconnect_at").eq("user_id", userId).maybeSingle(), "read the Outlook state");
    return !!r?.needs_reconnect_at;
  },
  async disconnect(d, userId) {
    const r = await disconnectOutlook(d.admin, userId);
    return { ok: r.ok, had: r.had, erased: r.erased, reply: disconnectWords(r), failures: r.failures, note: MICROSOFT_NOTE };
  },
};

export const CONNECTORS: Record<ConnectorId, Connector> = { gmail, outlook };
export const connectorOf = (id: string | null | undefined): Connector | null => (id && Object.hasOwn(CONNECTORS, id) ? CONNECTORS[id as ConnectorId] : null);
export const needsFor = (c: ConnectorId): Need[] => [c, "mail"];
const satisfies = (need: Need, s: Status[]) => s.some((x) => x.state === "connected" && (need === "mail" || x.id === need));

// Every connector's status for one person: one bounded read of the connection rows, plus Outlook's reconnect flag.
export async function statuses(d: Deps, userId: string): Promise<Status[]> {
  const rows = must(await d.admin.from("user_oauth_connections").select("provider,email,scopes").eq("user_id", userId).in("provider", Object.values(CONNECTORS).map((c) => c.provider)), "read the connections") ?? [];
  const out: Status[] = [];
  for (const c of Object.values(CONNECTORS)) {
    const r = (rows as any[]).find((x) => x.provider === c.provider);
    if (!r) { out.push({ id: c.id, label: c.label, state: "not_connected", email: null, uses: [] }); continue; }
    const scopes = split(r.scopes);
    out.push({ id: c.id, label: c.label, state: await c.needsReconnect(d, userId) ? "needs_reconnect" : "connected", email: r.email ?? null, uses: c.uses(scopes) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ disconnect, for any connector
// The connector's own disconnect (revoke where the provider allows it, tokens and rows deleted, what was read erased, read
// back), then the shared part: every email still waiting to go from that mailbox is cancelled by the database on the
// row's delete (approved outreach emails not queued on the person's other mailbox, the sending rail's queued emails, the
// replies lane's approved follow-ups; 20261028110000, 20261027200000 and 20261029200000), and that is read back.
// CONNECTOR SCENARIOS (2026-10-29, tests/architect/scenarios-connectors.test.ts): the reply's count is what the read-back
// shows (what waited before minus what waits after, at any volume), never the count read before the disconnect; an email
// a worker was already sending is said as such (it may have gone), never counted as cancelled; only the mailbox's own
// sending grant has emails waiting on it (the legacy finance grant has none).
export interface Waiting { approved: number; queued: number; actions: number; sending: number }
async function waiting(d: Deps, userId: string, mailbox: ConnectorId): Promise<Waiting | null> {
  const r = await d.admin.rpc("career_connector_waiting", { p_user: userId, p_mailbox: mailbox });
  if (r?.error || !r?.data || typeof r.data !== "object") return null;
  const n = (k: string) => Math.max(0, Number((r.data as any)[k]) || 0);
  return { approved: n("approved"), queued: n("queued"), actions: n("actions"), sending: n("sending") };
}
const emails = (n: number) => (n === 1 ? "1 approved email" : `${n} approved emails`);
export async function disconnectConnector(d: Deps, c: Connector, userId: string): Promise<DisconnectOut> {
  const grant = await d.admin.from("user_oauth_connections").select("provider").eq("user_id", userId).eq("provider", c.provider);
  const before = await waiting(d, userId, c.id);
  const r = await c.disconnect(d, userId);
  const failures = [...r.failures];
  const sender = !grant.error && (grant.data ?? []).length > 0;
  let cancelled = 0, inFlight = 0;
  if (grant.error || (sender && before === null)) failures.push("check that no email is still waiting to go");
  else if (sender && before) {
    const after = await waiting(d, userId, c.id);
    if (after === null) failures.push("check that no email is still waiting to go");
    else {
      cancelled = Math.max(0, before.approved - after.approved) + Math.max(0, before.queued - after.queued) + Math.max(0, before.actions - after.actions);
      inFlight = before.sending;
      if (after.approved + after.queued + after.actions + after.sending > 0) failures.push("cancel the emails still waiting to go");
    }
  }
  const ok = r.ok && failures.length === r.failures.length;
  let reply = r.reply;
  const extra = failures.filter((f) => !r.failures.includes(f)).join(", or ");
  if (!ok && r.ok) reply = r.had ? `I disconnected ${c.label}, but I couldn't ${extra}.${r.note ? ` ${r.note}` : ""} Say "${c.disconnectAsk}" again to retry.`
    : `I couldn't ${extra} from your ${c.label}. Say "${c.disconnectAsk}" again to retry.`;
  else if (ok && cancelled) reply += ` I also cancelled ${emails(cancelled)} that hadn't gone yet; approve ${cancelled === 1 ? "it" : "them"} again if you still want ${cancelled === 1 ? "it" : "them"} sent.`;
  if (ok && inFlight) reply += ` ${inFlight === 1 ? "1 email was" : `${inFlight} emails were`} already being sent from your ${c.label} when you disconnected, so ${inFlight === 1 ? "it" : "they"} may have gone.`;
  return { ok, had: r.had, erased: r.erased, reply, failures: [...new Set(failures)] };
}

// ------------------------------------------------------------------------------------------------ the chat
// CONNECTOR SCENARIOS (2026-10-29): the words are read by connector_words.ts (lead-ins, typos, "what can you see",
// "is my gmail connected", "remove gmail access"; "remove Google" is an employer, never a disconnect).
export function isWhatsConnected(text: string): boolean {
  return whatsConnectedOf(text);
}
const CHECK_RE = /^\s*(?:(?:please|can you|could you|pls)\s+)?(?:check|read|scan|look through|go through|sync)\s+(?:my\s+|the\s+)?(gmail|outlook|hotmail|e-?mails?|inbox|mail|mailbox)(?:\s+inbox)?(?:\s+(?:now|again|right now|for me|for (?:updates|news|replies|responses)))*(?:\s+please)?\s*[?.!]*$/i;
export type ConnectorAsk = { kind: "whats_connected" } | { kind: "connect"; id: ConnectorId } | { kind: "disconnect"; id: ConnectorId } | { kind: "check"; need: Need };
export function connectorAsk(message: string): ConnectorAsk | null {
  const t = askWords(message);
  if (whatsConnectedOf(t)) return { kind: "whats_connected" };
  const off = disconnectOf(t);
  if (off) return { kind: "disconnect", id: off };
  if (gmailConnectOf(t)) return { kind: "connect", id: "gmail" };
  const m = CHECK_RE.exec(t);
  if (m) {
    const w = m[1].toLowerCase();
    return { kind: "check", need: w === "gmail" ? "gmail" : w === "outlook" || w === "hotmail" ? "outlook" : "mail" };
  }
  return null;
}
// What a parked task is, in the person's words.
export function taskWords(ask: string): string {
  const a = connectorAsk(ask);
  if (a?.kind === "check") return a.need === "gmail" ? "check your Gmail" : a.need === "outlook" ? "check your Outlook" : "check your email";
  return `pick up what you asked ("${String(ask).trim().slice(0, 80)}")`;
}

export interface ChatOut { reply: string; intent: string; resultStatus: string; handler: "connectors"; meta?: Record<string, unknown> | null }
export interface TurnIn extends Deps {
  message: string; userId: string; threadId: string; bridge: boolean;
  // Reads the person's Outlook inbox now (default: outlookFor(...).readInbox). Gmail's read stays career_inbox_followups'.
  readOutlook?: (userId: string) => Promise<{ status: string; stored: number }>;
  log?: (l: string) => void;
}
const out = (d: TurnIn, reply: string, intent: string, resultStatus: string, meta: Record<string, unknown> | null = null): ChatOut =>
  ({ reply: say(reply, d.log), intent, resultStatus, handler: "connectors", meta });

export function whatsConnectedWords(s: Status[], waiting: { need: Need; ask: string }[]): string {
  const lines = ["Here's what's connected to Trainee:"];
  for (const x of s) {
    const c = CONNECTORS[x.id];
    if (x.state === "connected") lines.push(`${x.label}: connected${x.email ? ` (${x.email})` : ""}.${x.uses.length ? ` I use it to ${x.uses.join(", and to ")}.` : " It allows nothing beyond your address yet."}`);
    else if (x.state === "needs_reconnect") lines.push(`${x.label}: needs reconnecting. ${x.label} stopped accepting Trainee's access, so nothing is read or sent through it. Text "${c.connectAsk}" for a new link.`);
    else lines.push(`${x.label}: not connected. Text "${c.connectAsk}" to connect it.`);
  }
  for (const w of waiting) {
    const who = w.need === "mail" ? "Gmail or Outlook" : CONNECTORS[w.need].label;
    lines.push(`Waiting for ${who}: I'll ${taskWords(w.ask)} as soon as you connect it.`);
  }
  if (s.some((x) => x.state !== "not_connected")) lines.push(`Say ${s.filter((x) => x.state !== "not_connected").map((x) => `"${CONNECTORS[x.id].disconnectAsk}"`).join(" or ")} any time to remove it and what I read from it.`);
  return lines.join("\n");
}

function linkReply(c: Connector, url: string, channel: string, lead: string, extra: string[] = []): { reply: string; meta: Record<string, unknown> | null } {
  const reply = [lead, "The link works once and lasts 15 minutes. You sign in on the provider's own page; your password never reaches Trainee.", ...extra,
    ...(channel === "telegram" ? [TELEGRAM_BROWSER.replace("Microsoft's", `${c.id === "gmail" ? "Google" : "Microsoft"}'s`)] : []), url].join("\n\n");
  return { reply, meta: channel === "telegram" ? { link_button: { text: `Connect ${c.label}`, url } } : null };
}


// The account-connect page (trainee-connect): when the owner has switched it on (TRAINEE_CONNECT_BASE_URL), the bot says ONE short
// line and the link to it, whatever the connector; the page lets the person pick Google or Microsoft and does the rest.
async function connectPageReply(d: Deps, o: { userId: string; channel: string; reason: string }): Promise<{ reply: string; meta: Record<string, unknown> | null } | null> {
  const u = await connectUrlsFor(d.env, o.userId, o.reason, d.now(), /^[a-z]{3,16}$/.test(o.channel) ? o.channel : "web");
  if (!u.url) return null;
  return { reply: connectLine(o.reason, u.url), meta: o.channel === "telegram" ? { link_button: { text: "Connect email", url: u.url } } : null };
}

// When the turn itself failed (a database read refused): the person still gets a plain, true answer, never the router's.
export function connectorFailure(message: string): ChatOut | null {
  const a = connectorAsk(message);
  if (!a) return null;
  const what = a.kind === "disconnect" ? `disconnect ${CONNECTORS[a.id].label}; I can't confirm anything was removed yet` : a.kind === "whats_connected" ? "read what's connected" : a.kind === "connect" ? `make a link for ${CONNECTORS[a.id].label}` : "check that";
  return { reply: `I couldn't ${what}. Please ask me again in a minute.`, intent: "career_connectors_error", resultStatus: "failed", handler: "connectors", meta: null };
}

export async function connectorChatTurn(d: TurnIn): Promise<ChatOut | null> {
  const ask = connectorAsk(d.message);
  if (!ask) return null;
  if (ask.kind === "whats_connected") {
    const s = await statuses(d, d.userId);
    const w = must(await d.admin.from("career_parked_tasks").select("need,ask,status").eq("user_id", d.userId).in("status", ["waiting", "resuming"]).order("created_at").limit(10), "read what waits") ?? [];
    return out(d, whatsConnectedWords(s, w as any[]), "career_connectors_status", "shown");
  }
  if (ask.kind === "disconnect") {
    const r = await disconnectConnector(d, CONNECTORS[ask.id], d.userId);
    return out(d, r.reply, ask.id === "gmail" ? "career_google_disconnect" : "career_outlook_disconnect", r.ok ? (r.had || r.erased ? "completed" : "nothing") : "failed");
  }
  const s = await statuses(d, d.userId);
  const channel = await channelOf(d.admin, d.userId, d.threadId, d.bridge);
  if (ask.kind === "connect") {
    const c = CONNECTORS[ask.id], st = s.find((x) => x.id === ask.id)!;
    if (st.state === "connected") return out(d, `${c.label} is already connected${st.email ? `: ${st.email}` : ""}. Say "${c.disconnectAsk}" to remove it.`, `career_${c.id}_connect`, "already");
    const pageReply = c.wired(d.env) ? await connectPageReply(d, { userId: d.userId, channel, reason: "replies" }) : null;
    if (pageReply) return out(d, pageReply.reply, `career_${c.id}_connect`, "link", pageReply.meta);
    const url = await c.issueLink(d, { userId: d.userId, threadId: d.threadId, channel });
    if (!url) return out(d, `Connecting ${c.label} isn't switched on in Trainee yet, so I can't make a link. Nothing was connected.`, `career_${c.id}_connect`, "not_wired");
    const r = linkReply(c, url, channel, `Here's a one-time link to connect your ${c.label}.`,
      ["With it, Trainee reads the codes and replies employers email you (sender, subject and preview only). It never sends anything you haven't approved word for word."]);
    return out(d, r.reply, `career_${c.id}_connect`, "link", r.meta);
  }
  // A task that needs a connector.
  if (satisfies(ask.need, s)) {
    const outlookOnly = ask.need === "outlook" || (ask.need === "mail" && s.find((x) => x.id === "gmail")!.state !== "connected");
    if (!outlookOnly) return null; // Gmail is connected: career_inbox_followups reads it
    const read = d.readOutlook ?? ((u: string) => outlookFor(d.admin, d.env, d.fetch, { now: d.now }).readInbox(u));
    const r: { status: string; stored: number; detail?: string } = await read(d.userId).catch((e) => ({ status: "ERROR", stored: 0, detail: String((e as Error)?.message ?? e) }));
    // CONNECTORS ROUND 3 (2026-10-31): a grant without Mail.Read (the box left unticked at Microsoft) was answered "ask me
    // again in a minute", which never helps; and a disconnect while the inbox was read is not a failure to retry.
    const reply = r.status === "NOT_WIRED" ? (/does not allow/i.test(String(r.detail ?? "")) ? PARTIAL_WORDS.outlook.read : "Outlook isn't connected any more, so nothing was read or kept. Text \"connect my outlook\" to connect it again.")
      : r.status === "ok" ? `I read your Outlook: ${r.stored === 0 ? "no new messages" : r.stored === 1 ? "1 new message" : `${r.stored} new messages`} since I last looked (sender, subject and preview only).`
      : r.status === "NEEDS_RECONNECT" ? RECONNECT_REPLY
      : r.status === "RATE_LIMITED" ? `Microsoft asked Trainee to wait before reading more of your Outlook${r.stored ? `; I read ${r.stored} new message${r.stored === 1 ? "" : "s"} first` : ""}. I'll carry on as soon as it allows.`
      : "I couldn't finish reading your Outlook just now. What I read before is kept; ask me again in a minute.";
    return out(d, reply, "career_outlook_read", String(r.status).toLowerCase());
  }
  const pick: Connector | null = ask.need === "mail" ? ([gmail, outlook].find((c) => c.wired(d.env)) ?? null) : CONNECTORS[ask.need];
  const words = taskWords(d.message);
  if (!pick || !pick.wired(d.env)) {
    return out(d, `To ${words} I need ${ask.need === "mail" ? "your Gmail or Outlook" : `your ${CONNECTORS[ask.need as ConnectorId].label}`} connected, and connecting it isn't switched on in Trainee yet. Nothing was read.`, "career_connector_need", "not_wired");
  }
  const parked = must(await d.admin.rpc("career_parked_park", { p_user: d.userId, p_need: ask.need, p_ask: d.message, p_thread: d.threadId, p_channel: channel, p_now: at(d.now()) }), "keep the task");
  if (!parked?.first) {
    const who = ask.need === "mail" ? "Gmail or Outlook" : pick.label;
    return out(d, `I'm still waiting for ${who} to be connected, and I'll ${words} as soon as it is${parked?.duplicate ? "" : ", along with what you asked before"}. Use the link I sent you, or text "${pick.connectAsk}" if you need a new one.`, "career_connector_need", "waiting");
  }
  const pageReply = await connectPageReply(d, { userId: d.userId, channel, reason: "replies" });
  if (pageReply) return out(d, pageReply.reply, "career_connector_need", "asked", pageReply.meta);
  const url = await pick.issueLink(d, { userId: d.userId, threadId: d.threadId, channel });
  if (!url) return out(d, `Connecting ${pick.label} isn't switched on in Trainee yet, so I can't make a link. Nothing was read.`, "career_connector_need", "not_wired");
  const reconnect = s.find((x) => x.id === pick.id)?.state === "needs_reconnect";
  const alt = ask.need === "mail" && pick.id === "gmail" && outlook.wired(d.env) ? [`Use Outlook instead? Text "${outlook.connectAsk}".`] : [];
  const r = linkReply(pick, url, channel,
    `To ${words} I need your ${pick.label} ${reconnect ? "reconnected" : "connected"}. Here's a one-time link. As soon as you connect, I'll ${words} and tell you here; you don't need to ask again.`, alt);
  return out(d, r.reply, "career_connector_need", "asked", r.meta);
}

// ------------------------------------------------------------------------------------------------ connect, then resume
export interface TurnResult { reply: string; persisted?: boolean }
export interface AfterDeps extends Deps {
  // Re-runs a parked task's ask as the person (agent-chat's service-role path, chatThroughAgent), with a stable turn key,
  // so a retried resume replays instead of acting twice. persisted: the turn wrote its own reply into the thread.
  runTurn: (a: { userId: string; threadId: string | null; message: string; turnKey: string }) => Promise<TurnResult>;
  deliver?: (a: { userId: string; key: string; now: number }) => Promise<unknown>;
  log?: (l: string) => void;
}
// Says something in the place a link or a task came from: the web thread, or the channel's outbox.
async function tell(d: AfterDeps, where: { user_id: string; channel: string; thread_id: string | null }, key: string, text: string) {
  const t = say(text, d.log);
  if (where.channel === "web") {
    if (!where.thread_id) return;
    const r = await d.admin.from("agent_messages").insert({ thread_id: where.thread_id, role: "assistant", content: t, meta: { career: true, intent: "career_connectors", key } });
    if (r.error) d.log?.(`connectors: the chat message was not written: ${r.error.message}`);
    return;
  }
  const r = await d.admin.from("career_outbox").insert({ user_id: where.user_id, key: `status:${key}`, kind: "status", text: t, deliver_at: at(d.now()), channel: where.channel === "home" ? null : where.channel });
  if (r.error) { d.log?.(`connectors: the channel message was not queued: ${r.error.message}`); return; }
  await d.deliver?.({ userId: where.user_id, key: `status:${key}`, now: d.now() }).catch(() => {});
}

async function runClaimed(d: AfterDeps, tasks: any[]): Promise<{ resumed: number; kept: number }> {
  let resumed = 0, kept = 0;
  for (const t of tasks) {
    const where = { user_id: t.user_id, channel: t.channel, thread_id: t.thread_id };
    try {
      const r = await d.runTurn({ userId: t.user_id, threadId: t.thread_id, message: t.ask, turnKey: `resume:${t.id}` });
      if (!r.persisted || where.channel !== "web") await tell(d, where, `resume:${t.id}`, r.reply);
      must(await d.admin.rpc("career_parked_finish", { p_id: t.id, p_status: "resumed", p_result: "resumed", p_now: at(d.now()) }), "finish the task");
      resumed++;
    } catch (e) {
      d.log?.(`connectors: a resume failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      await d.admin.rpc("career_parked_finish", { p_id: t.id, p_status: "waiting", p_result: "resume failed; kept", p_now: at(d.now()) });
      if (Number(t.attempts) <= 1) await tell(d, where, `resume-wait:${t.id}`, `I couldn't ${taskWords(t.ask)} just now. I kept it and will try again shortly; you don't need to ask again.`);
      kept++;
    }
  }
  return { resumed, kept };
}

// Called by a connector's callback after its grant is stored. Gmail's link is finished here and the person told where they
// asked (Outlook's callback finishes and tells on its own link table); then every parked task this connector satisfies runs.
export async function afterConnect(d: AfterDeps, userId: string, id: ConnectorId, o: { email?: string | null; scopes?: string[] } = {}) {
  const c = CONNECTORS[id];
  if (id === "gmail") {
    const link = await d.admin.rpc("career_connector_link_finish", { p_user: userId, p_connector: "gmail", p_outcome: "connected", p_now: at(d.now()) });
    if (!link.error && link.data?.link_id) {
      const uses = c.uses(o.scopes ?? []);
      await tell(d, { user_id: userId, channel: link.data.channel, thread_id: link.data.thread_id }, `connect:${link.data.link_id}`,
        [`Gmail connected: ${o.email ?? "your account"}.${uses.length ? ` You allowed me to ${uses.join(", and to ")}.` : ""}`,
          missingWords("gmail", o.scopes ?? [], { sendAsked: requestableScopes([GMAIL_READONLY, GMAIL_SEND], d.env).scopes.includes(GMAIL_SEND) }),
          `Say "${c.disconnectAsk}" any time to remove it.`].filter(Boolean).join(" "));
    }
  }
  const claimed = must(await d.admin.rpc("career_parked_claim", { p_user: userId, p_needs: needsFor(id), p_now: at(d.now()), p_lease_seconds: 300 }), "claim the waiting tasks") ?? [];
  return await runClaimed(d, claimed as any[]);
}

// CONNECTORS ROUND 3 (2026-10-31): a Gmail connect the database refused (oauth_connect_commit 'taken': the address is
// another Trainee account's). The link is finished and the person told why, in the chat it came from; nothing resumes.
export async function refusedConnect(d: Omit<AfterDeps, "runTurn">, userId: string, id: ConnectorId, words: string): Promise<boolean> {
  if (id !== "gmail") return false; // Outlook's callback finishes and tells on its own link table
  const link = await d.admin.rpc("career_connector_link_finish", { p_user: userId, p_connector: "gmail", p_outcome: "error", p_now: at(d.now()) });
  if (link.error || !link.data?.link_id) return false;
  await tell(d as AfterDeps, { user_id: userId, channel: link.data.channel, thread_id: link.data.thread_id }, `connect:${link.data.link_id}`, words);
  return true;
}

// A sweeper's batch (many run at once): tasks whose connector is connected but whose resume failed or never ran.
export async function resumeDue(d: AfterDeps, batch: number) {
  const claimed = must(await d.admin.rpc("career_parked_due", { p_now: at(d.now()), p_batch: batch, p_lease_seconds: 300 }), "claim due tasks") ?? [];
  return await runClaimed(d, claimed as any[]);
}

// ------------------------------------------------------------------------------------------------ the Gmail link's page
const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline' ${FONT_CSP.style}; font-src ${FONT_CSP.font}; img-src data:; form-action 'self' https://accounts.google.com; frame-ancestors 'none'` };
// On the shared Trainee shell (brand.ts systemPage): ink text on the warm ground, plum only on the one button (Q564, Q575).
export function page(title: string, body: string[], status = 200, form?: { action: string; token: string; label: string }): Response {
  const html = systemPage(title, body, form);
  return new Response(html, { status, headers: HEADERS });
}
const GONE: Record<string, string> = {
  used: 'This link was already used. Links work once: text "connect gmail" for a new one.',
  expired: 'This link expired. Links last 15 minutes: text "connect gmail" for a new one.',
  invalid: 'This link isn\'t valid. Text "connect gmail" for a new one.',
};
export interface LinkDeps { admin: Admin; env: Env; now?: () => number; consentUrl: (userId: string) => Promise<string | null> }
// Returns null when the request is not a link request (gmail-oauth's other routes go on as before).
export async function handleConnectorLink(req: Request, d: LinkDeps): Promise<Response | null> {
  const now = (d.now ?? Date.now)();
  const url = new URL(req.url);
  const self = gmailLinkBase(d.env) ?? `${url.origin}${url.pathname}`;
  if (req.method === "GET" && url.searchParams.has("t") && !url.searchParams.has("state")) {
    const r = await d.admin.rpc("career_connector_link_peek", { p_nonce: url.searchParams.get("t") ?? "", p_now: at(now) });
    const p = r.error ? { status: "invalid" } : r.data ?? { status: "invalid" };
    if (p.status !== "ok") return page("This link can't be used", [GONE[p.status] ?? GONE.invalid], 410);
    const whose = p.hint ? `the Trainee account ${p.hint}` : "the Trainee account you're chatting with";
    const n = consentNotice(requestableScopes([GMAIL_READONLY, GMAIL_SEND], d.env).scopes);
    return page("Connect Gmail to Trainee", [`This connects your Gmail to ${whose}. Continue only if you asked Trainee for this link in the last 15 minutes.`,
      "With it, Trainee reads:", ...n.reads, ...n.never, ...n.undo], 200, { action: self, token: url.searchParams.get("t") ?? "", label: "Continue to Google" });
  }
  if (req.method === "POST" && (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    const form = await req.formData().catch(() => null);
    const token = String(form?.get("t") ?? "");
    if (!gmail.wired(d.env)) return page("Not available yet", ["Connecting Gmail isn't switched on yet, so nothing was connected."], 503);
    const r = await d.admin.rpc("career_connector_link_open", { p_nonce: token, p_now: at(now) });
    if (r.error || !r.data || r.data.error) return page("This link can't be used", [GONE[r.data?.error] ?? GONE.invalid], 400);
    const to = await d.consentUrl(String(r.data.user_id));
    if (!to) return page("Not available yet", ["Connecting Gmail isn't switched on yet, so nothing was connected."], 503);
    return new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  return null;
}
