// M4 (2026-10-27): Outlook connected from any channel, as a peer of Gmail. Built on outlook_graph.ts (Microsoft at the HTTP
// boundary) and the service-role supabase-js client `admin` (the edge functions' role); tests run it over a real Postgres.
//   outlookChatTurn       "connect my outlook", "use my work email", "disconnect outlook", "is my outlook connected"
//   handleOutlookOAuth    the outlook-oauth edge function: the link (GET peeks, POST goes to Microsoft), Microsoft's
//                         callback (GET ?state&code), and the leased batch run (POST {action:"run"} with its secret)
//   outlookFor            the rails other lanes call: sendMail (outreach, applications by email, any approved email),
//                         readInbox (reply tracking, delta), outlookFreeBusy and outlookCreateEvent (M5, scheduling)
//   disconnectOutlook     tokens deleted, the row deleted (the trigger erases Outlook data, cancels pending sends, burns
//                         links), read back; the reply says only what the read-back shows
//   runOutlookBatch       one worker's leased batch of token refreshes or inbox syncs; many run in parallel
// No token, code or secret is logged, returned or shown. No volume limit of Trainee's own.
// deno-lint-ignore-file no-explicit-any
import {
  authorizeUrl, createEvent, ENV, exchangeCode, freeBusy, hasScope, issueState, type NewEvent, type OutMail, outlookToken,
  pkceChallenge, pkceVerifier, PROVIDER, type Purpose, readInboxDelta, sendOutlook, type SendStatus, type TokenDeps,
  type TokenResult, vaultNameOf, verifyState, type Window,
} from "./outlook_graph.ts";
import { disconnectOf, outlookConnectOf, outlookStatusOf } from "./connector_words.ts";
import { FONT_CSP, systemPage } from "./brand.ts";
import { vaultRefreshWrite } from "./oauth_vault_refresh.ts";
import { commitGrant, missingWords, TAKEN_WORDS } from "./oauth_connect.ts";

type Admin = any;
type Env = { get(k: string): string | undefined };
const must = (r: any, what: string) => { if (r?.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r?.data; };
const at = (ms: number) => new Date(ms).toISOString();

// ------------------------------------------------------------------------------------------------ store-backed deps
export function tokenDeps(admin: Admin, env: Env, f: typeof fetch, now: () => number = Date.now): TokenDeps {
  return {
    fetch: f, env, now,
    connection: async (u) => must(await admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", PROVIDER).maybeSingle(), "read the Outlook connection") ?? null,
    readVault: async (name) => { const d = must(await admin.rpc("oauth_vault_read", { p_name: name }), "read the Outlook access"); return d ? String(d) : null; },
    writeVault: (name, secret) => vaultRefreshWrite(admin, name, secret, "save the refreshed Outlook access"),
    markReconnect: (u, reason) => markReconnect(admin, u, reason, now()),
    noteExpiry: async (u, exp) => { must(await admin.from("career_outlook_state").update({ token_expires_at: at(exp), updated_at: at(now()) }).eq("user_id", u), "record the token expiry"); },
    isReconnect: async (u) => {
      const r = must(await admin.from("career_outlook_state").select("needs_reconnect_at").eq("user_id", u).maybeSingle(), "read the Outlook state");
      return !!r?.needs_reconnect_at;
    },
  };
}
export async function markReconnect(admin: Admin, userId: string, reason: string, now: number) {
  must(await admin.from("career_outlook_state").update({ needs_reconnect_at: at(now), needs_reconnect_reason: reason.slice(0, 200), updated_at: at(now) }).eq("user_id", userId), "mark Outlook to reconnect");
}
export function ledgerOf(admin: Admin) {
  return {
    async begin(u: string, key: string, hash: string, purpose: string, rh: string, now: number) {
      return String(must(await admin.rpc("career_outlook_send_begin", { p_user: u, p_key: key, p_hash: hash, p_purpose: purpose, p_recipient_hash: rh, p_now: at(now) }), "start the send"));
    },
    async finish(u: string, key: string, status: string, detail: string | null, now: number) {
      must(await admin.rpc("career_outlook_send_finish", { p_user: u, p_key: key, p_status: status, p_detail: detail, p_now: at(now) }), "record the send");
    },
  };
}

// The words a person reads when Outlook needs them; plain, no codes.
export const RECONNECT_REPLY = 'Microsoft stopped accepting Trainee\'s access to your Outlook (it was revoked, or your password or your organization\'s policy changed), so nothing was sent or read. Text "connect my outlook" for a new link.';
export function sendWords(r: SendStatus): string {
  switch (r.status) {
    case "sent": return "Sent from your Outlook.";
    case "already_sent": return "That message was already sent from your Outlook, so it wasn't sent again.";
    case "NOT_WIRED": return 'Outlook isn\'t connected, so nothing was sent. Text "connect my outlook" to connect it.';
    case "NEEDS_RECONNECT": return RECONNECT_REPLY;
    case "CHANGED": return "That message changed after you approved it, so it wasn't sent. Approve the new text to send it.";
    case "CANCELLED": return "Outlook was disconnected before that message went, so it wasn't sent.";
    case "OPTED_OUT": return "That person asked not to be contacted, so it wasn't sent, and it never will be.";
    case "BOUNCED": return "That address bounced before, so it wasn't sent; I never write to a bounced address again.";
    case "RATE_LIMITED": return `Microsoft asked Trainee to wait before sending more from your Outlook; it goes in about ${Math.max(1, Math.ceil(r.retryAfterMs / 60000))} minute(s).`;
    case "REFUSED": return "Microsoft refused that message, so it wasn't sent.";
    case "UNKNOWN": return "I couldn't confirm that message went. It may have, so I won't send it again; check your Outlook Sent Items.";
  }
}

// ------------------------------------------------------------------------------------------------ the rails (outlookFor)
export interface OutlookRails {
  sendMail(userId: string, m: OutMail, o: { idemKey: string; purpose: Purpose }): Promise<SendStatus>;
  readInbox(userId: string): Promise<{ status: string; stored: number; detail?: string }>;
  outlookFreeBusy(userId: string, window: Window): ReturnType<typeof freeBusy>;
  outlookCreateEvent(userId: string, event: NewEvent, approvedHash: string): ReturnType<typeof createEvent>;
  token(userId: string, scope: string): Promise<TokenResult>;
}
export function outlookFor(admin: Admin, env: Env, f: typeof fetch, o: { now?: () => number; sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): OutlookRails {
  const now = o.now ?? Date.now;
  const td = tokenDeps(admin, env, f, now);
  const token = (u: string, s: string) => outlookToken(td, u, s);
  const call = { fetch: f, sleep: o.sleep, now, token, waitMs: o.waitMs };
  return {
    token,
    sendMail: (u, m, x) => sendOutlook({ ...call, ledger: ledgerOf(admin) as any, markReconnect: td.markReconnect }, u, m, x),
    outlookFreeBusy: (u, w) => freeBusy(call, u, w),
    outlookCreateEvent: (u, e, h) => createEvent(call, u, e, h),
    readInbox: (u) => syncInbox(admin, call, u, now()),
  };
}

// One inbox round for a person: the stored delta link (or the connect time), every page, rows stored once by hash, the new
// delta link kept. A rate limit keeps the place it reached and the time Microsoft asked to wait.
export async function syncInbox(admin: Admin, call: any, userId: string, now: number): Promise<{ status: string; stored: number; detail?: string; patch: Record<string, unknown> }> {
  const st = must(await admin.from("career_outlook_state").select("delta_link,synced_at").eq("user_id", userId).maybeSingle(), "read the Outlook state");
  const conn = must(await admin.from("user_oauth_connections").select("connected_at").eq("user_id", userId).eq("provider", PROVIDER).maybeSingle(), "read the Outlook connection");
  if (!conn) return { status: "NOT_WIRED", stored: 0, patch: {} };
  // CONNECTORS ROUND 3 (2026-10-31): the erase epoch before the mail is read. What was read is written only while the
  // connection is there and no "forget everything" came since (career_outlook_store_messages, 20261031060000); before, a
  // sync that read the inbox before "disconnect outlook" or an erase committed wrote the messages after it.
  const epoch = await eraseEpoch(admin, userId);
  const since = st?.synced_at ?? conn.connected_at ?? at(now);
  const r = await readInboxDelta(call, userId, { deltaLink: st?.delta_link ?? null, sinceIso: new Date(since).toISOString() });
  let withdrawn = false;
  const store = async (mails: any[]) => {
    if (!mails.length) return 0;
    const rows = mails.map((m) => ({ message_hash: m.hash, conversation_hash: m.conversationHash ?? null, from_address: String(m.fromAddress ?? "").slice(0, 320),
      subject: m.subject ?? null, preview: m.snippet ?? null, received_at: m.date }));
    const ins = await admin.rpc("career_outlook_store_messages", { p_user: userId, p_rows: rows, p_epoch: epoch });
    if (ins.error && missingFn(ins.error, "career_outlook_store_messages")) {
      // A project without 20261031060000: the old writes.
      for (const row of rows) must(await admin.from("career_outlook_messages").upsert({ user_id: userId, ...row }, { onConflict: "user_id,message_hash" }), "store an Outlook message");
      return rows.length;
    }
    const n = Number(must(ins, "store the Outlook messages"));
    if (n < 0) { withdrawn = true; return 0; }
    return n;
  };
  // Disconnected or erased while the inbox was read: nothing was written, and nothing about it is kept.
  const gone = { status: "NOT_WIRED", stored: 0, patch: {} };
  if (r.status === "ok") {
    const n = await store(r.mails);
    if (withdrawn) return gone;
    return { status: "ok", stored: n, patch: { delta_link: r.deltaLink, synced_at: at(now), next_sync_at: at(now + 5 * 60_000) } };
  }
  if (r.status === "RATE_LIMITED") {
    const n = await store(r.mails);
    if (withdrawn) return gone;
    return { status: "RATE_LIMITED", stored: n, patch: { retry_after: at(now + r.retryAfterMs), ...(r.resumeLink ? { delta_link: r.resumeLink } : {}) } };
  }
  if (r.status === "NEEDS_RECONNECT") return { status: r.status, stored: 0, patch: { needs_reconnect_reason: r.reason } };
  if (r.status === "NOT_WIRED") return { status: r.status, stored: 0, detail: r.reason, patch: {} };
  const n = await store(r.mails);
  if (withdrawn) return gone;
  return { status: "ERROR", stored: n, detail: r.detail, patch: { last_error: r.detail, next_sync_at: at(now + 5 * 60_000) } };
}

// The account's erase epoch ("forget everything" raises it); null when it cannot be read (the write then checks only the
// connection).
export async function eraseEpoch(admin: Admin, userId: string): Promise<number | null> {
  const r = await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", "career:account").maybeSingle();
  if (r?.error) return null;
  const e = Number(r?.data?.value?.epoch ?? 0);
  return Number.isFinite(e) ? e : null;
}
export const missingFn = (e: any, fn: string) => {
  const s = `${e?.code ?? ""} ${e?.message ?? ""}`;
  return (s.includes(fn) || /PGRST202/.test(s)) && /exist|find|no function|PGRST202/i.test(s);
};

// ------------------------------------------------------------------------------------------------ leased batches
// One worker's batch: claim (skip locked, expired leases reclaimed), work each person, release with what was learned. Many
// workers call this at once; each person is in at most one worker's batch per kind. A failure for one person never stops
// the next. Microsoft's Retry-After is recorded per person; the claim skips that person until then.
export async function runOutlookBatch(o: { admin: Admin; env: Env; fetch: typeof fetch; kind: "refresh" | "sync"; worker: string; batch: number; leaseSeconds?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
  const now = o.now ?? Date.now;
  const ids: string[] = (must(await o.admin.rpc("career_outlook_claim", { p_kind: o.kind, p_worker: o.worker, p_now: at(now()), p_lease_seconds: o.leaseSeconds ?? 300, p_batch: o.batch }), "claim a batch") ?? []).map((x: any) => String(x?.career_outlook_claim ?? x));
  const td = tokenDeps(o.admin, o.env, o.fetch, now);
  const stats = { claimed: ids.length, ok: 0, rate_limited: 0, reconnect: 0, errors: 0 };
  for (const u of ids) {
    let patch: Record<string, unknown> = {};
    try {
      if (o.kind === "refresh") {
        const t = await outlookToken(td, u, "User.Read", true);
        if (t.status === "ok") stats.ok++;
        else if (t.status === "RATE_LIMITED") { stats.rate_limited++; patch = { retry_after: at(now() + t.retryAfterMs) }; }
        else if (t.status === "NEEDS_RECONNECT") { stats.reconnect++; patch = { needs_reconnect_reason: t.reason }; }
        else { stats.errors++; patch = { last_error: t.status === "ERROR" ? t.detail : t.reason }; }
      } else {
        const r = await syncInbox(o.admin, { fetch: o.fetch, sleep: o.sleep, now, token: (x: string, s: string) => outlookToken(td, x, s), waitMs: 30_000 }, u, now());
        patch = r.patch;
        if (r.status === "ok") stats.ok++; else if (r.status === "RATE_LIMITED") stats.rate_limited++; else if (r.status === "NEEDS_RECONNECT") stats.reconnect++; else stats.errors++;
      }
    } catch (e) {
      stats.errors++;
      patch = { last_error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    await o.admin.rpc("career_outlook_release", { p_kind: o.kind, p_user: u, p_worker: o.worker, p_now: at(now()), p_patch: patch });
  }
  return stats;
}

// ------------------------------------------------------------------------------------------------ disconnect
// erased: Outlook mail saved from an earlier connection was deleted although nothing was connected.
export interface DisconnectResult { ok: boolean; had: boolean; failures: string[]; erased?: boolean }
// Microsoft has no endpoint that revokes one app's refresh token (revokeSignInSessions would sign the person out of every
// app and needs an admin-grade permission), so Trainee deletes what it holds and tells the person where to remove the app.
export async function disconnectOutlook(admin: Admin, userId: string): Promise<DisconnectResult> {
  const failures: string[] = [];
  const rows = await admin.from("user_oauth_connections").select("provider").eq("user_id", userId).eq("provider", PROVIDER);
  if (rows.error) return { ok: false, had: false, failures: ["read whether Outlook is connected"] };
  const had = (rows.data ?? []).length > 0;
  // CONNECTOR SCENARIOS (2026-10-29): mail read from Outlook can outlive its connection (a sync that was running when the
  // row went, a disconnect made before 20261027230000's trigger). It is deleted here too, as Gmail's disconnect does, and
  // the person is told; before, the reply said it couldn't delete it, without ever trying.
  const mailBefore = await admin.from("career_outlook_messages").select("message_hash").eq("user_id", userId).limit(1);
  const del = await admin.rpc("oauth_vault_delete", { p_name: vaultNameOf(userId) });
  if (del.error) failures.push("delete the stored Outlook access");
  if (had) {
    const d = await admin.from("user_oauth_connections").delete().eq("user_id", userId).eq("provider", PROVIDER);
    if (d.error) failures.push("delete the Outlook connection");
  }
  const wipe = await admin.from("career_outlook_messages").delete().eq("user_id", userId);
  if (wipe.error) failures.push("delete the mail I had read from your Outlook");
  const left = await admin.from("user_oauth_connections").select("provider").eq("user_id", userId).eq("provider", PROVIDER);
  const mail = await admin.from("career_outlook_messages").select("message_hash").eq("user_id", userId).limit(1);
  const vault = await admin.rpc("oauth_vault_read", { p_name: vaultNameOf(userId) });
  if (left.error || mail.error || vault.error) failures.push("check that everything was deleted");
  else {
    if ((left.data ?? []).length) failures.push("delete the Outlook connection");
    if ((mail.data ?? []).length) failures.push("delete the mail I had read from your Outlook");
    if (vault.data) failures.push("delete the stored Outlook access");
  }
  const erased = !mailBefore.error && (mailBefore.data ?? []).length > 0 && !mail.error && !(mail.data ?? []).length;
  return { ok: failures.length === 0, had, failures: [...new Set(failures)], erased };
}
export function disconnectWords(r: DisconnectResult): string {
  if (!r.had && r.ok && r.erased) return "Outlook isn't connected to Trainee, but I deleted the mail still saved from an earlier connection.";
  if (!r.had && r.ok) return "Outlook isn't connected to Trainee, so there was nothing to disconnect.";
  if (!r.ok) return `I couldn't finish disconnecting Outlook: I wasn't able to ${r.failures.join(", or ")}. Say "disconnect outlook" again to retry.`;
  return `Outlook is disconnected. I deleted the stored access and the mail I had read from it, and any email still waiting to go from your Outlook won't be sent. ${MICROSOFT_NOTE} ` +
    'Say "connect my outlook" any time to connect it again.';
}
export const MICROSOFT_NOTE = "Microsoft doesn't let an app revoke its own access, so to be sure remove Trainee at account.live.com/consent/Manage (personal account) or myapps.microsoft.com (work or school account).";

// ------------------------------------------------------------------------------------------------ the chat
export const OUTLOOK_CONNECT_RE = /^\s*(?:please\s+|can you\s+|i want to\s+|i'?d like to\s+|let'?s\s+)?(?:connect|link|add|hook up|set up|use)\s+(?:my\s+|an?\s+)?(?:outlook|hotmail|live|msn|office\s*365|o365|microsoft\s*365|microsoft|exchange|work|school|university|college)(?:\s+(?:email|e-mail|mail|account|inbox|calendar|address))*(?:\s+(?:account|instead|too|as well|to send))?[\s.!?]*$/i;
export const OUTLOOK_DISCONNECT_RE = /^\s*(?:please\s+)?(?:disconnect|unlink|revoke|remove)\s+(?:access\s+to\s+|trainee\s+from\s+)?(?:my\s+)?(?:outlook|hotmail|microsoft|office\s*365|work\s+email)(?:\s+(?:account|email|mail))?[\s.!]*$/i;
export const OUTLOOK_STATUS_RE = /^\s*(?:is|are)\s+(?:my\s+)?(?:outlook|hotmail|microsoft|work\s+email)(?:\s+(?:account|email|mail))?\s+(?:still\s+)?connected\s*[?.!]*\s*$/i;
export type OutlookAsk = "connect" | "disconnect" | "status";
// CONNECTOR SCENARIOS (2026-10-29): read by connector_words.ts, the same words connectorAsk reads (lead-ins, typos, and
// "remove Microsoft" / "add Microsoft" as an employer, never the mailbox). The regexes above stay for reference.
export function outlookAsk(message: string): OutlookAsk | null {
  if (disconnectOf(message) === "outlook") return "disconnect";
  if (outlookStatusOf(message)) return "status";
  if (outlookConnectOf(message)) return "connect";
  return null;
}
export async function channelOf(admin: Admin, userId: string, threadId: string, bridge: boolean): Promise<string> {
  if (!bridge) return "web";
  const { data } = await admin.from("channel_contacts").select("channel").eq("user_id", userId).eq("thread_id", threadId).limit(1);
  const ch = Array.isArray(data) && data[0]?.channel ? String(data[0].channel) : "";
  return ["telegram", "imessage", "whatsapp"].includes(ch) ? ch : "home";
}
export const linkBase = (env: Env) => {
  const u = env.get("OUTLOOK_LINK_BASE") || (env.get("SUPABASE_URL") ? `${env.get("SUPABASE_URL")}/functions/v1/outlook-oauth` : "");
  return u ? u.replace(/\/$/, "") : null;
};
export const TELEGRAM_BROWSER = "Open it in your phone's browser (Safari or Chrome): Microsoft's sign-in may not work inside Telegram's own browser.";
export interface ChatOut { reply: string; intent: string; resultStatus: string; handler: "outlook"; meta?: Record<string, unknown> | null }
export async function outlookChatTurn(d: { admin: Admin; message: string; userId: string; threadId: string; bridge: boolean; now: number; env: Env }): Promise<ChatOut | null> {
  const ask = outlookAsk(d.message);
  if (!ask) return null;
  if (ask === "disconnect") {
    const r = await disconnectOutlook(d.admin, d.userId);
    return { reply: disconnectWords(r), intent: "career_outlook_disconnect", resultStatus: r.ok ? (r.had ? "completed" : "nothing") : "failed", handler: "outlook" };
  }
  const conn = must(await d.admin.from("user_oauth_connections").select("email,scopes").eq("user_id", d.userId).eq("provider", PROVIDER).maybeSingle(), "read the Outlook connection");
  const st = conn ? must(await d.admin.from("career_outlook_state").select("needs_reconnect_at").eq("user_id", d.userId).maybeSingle(), "read the Outlook state") : null;
  if (ask === "status") {
    const reply = !conn ? 'Outlook isn\'t connected. Text "connect my outlook" to connect it.'
      : st?.needs_reconnect_at ? RECONNECT_REPLY
      : `Outlook is connected: ${conn.email ?? "your account"}. I can ${[hasScope(conn.scopes, "Mail.Read") && "read your mail for replies", hasScope(conn.scopes, "Mail.Send") && "send emails you approve word for word", hasScope(conn.scopes, "Calendars.ReadWrite") && "check your calendar and add invites you approve"].filter(Boolean).join(", ")}.`;
    return { reply, intent: "career_outlook_status", resultStatus: conn ? (st?.needs_reconnect_at ? "needs_reconnect" : "connected") : "not_connected", handler: "outlook" };
  }
  if (conn && !st?.needs_reconnect_at) {
    return { reply: `Outlook is already connected: ${conn.email ?? "your account"}. Say "disconnect outlook" to remove it.`, intent: "career_outlook_connect", resultStatus: "already", handler: "outlook" };
  }
  const base = linkBase(d.env);
  if (!d.env.get(ENV.clientId) || !base) {
    return { reply: "Connecting Outlook isn't switched on in Trainee yet, so I can't make a link. Nothing was connected.", intent: "career_outlook_connect", resultStatus: "not_wired", handler: "outlook" };
  }
  const channel = await channelOf(d.admin, d.userId, d.threadId, d.bridge);
  const token = must(await d.admin.rpc("career_outlook_link_issue", { p_user: d.userId, p_channel: channel, p_thread: d.threadId, p_purpose: "connect", p_now: at(d.now) }), "make the link");
  const url = `${base}?t=${encodeURIComponent(String(token))}`;
  const reply = [
    "Here's a one-time link to connect your Outlook (work, school or personal Microsoft account). It works once and lasts 15 minutes.",
    "With it, Trainee reads your inbox's sender, subject and preview to spot replies, sends only emails you approve word for word, and reads your calendar's busy times and adds invites you approve. It never sends anything you haven't approved.",
    ...(channel === "telegram" ? [TELEGRAM_BROWSER] : []),
    url,
  ].join("\n\n");
  return { reply, intent: "career_outlook_connect", resultStatus: "link", handler: "outlook", meta: channel === "telegram" ? { link_button: { text: "Connect Outlook", url } } : null };
}

// ------------------------------------------------------------------------------------------------ the edge function
export interface OAuthDeps {
  admin: Admin; env: Env; fetch: typeof fetch; now?: () => number; log?: (l: string) => void; deliver?: (a: { userId: string; key: string; now: number }) => Promise<unknown>;
  // The connector framework (connectors.ts afterConnect): once the grant is stored and the person told, the tasks that
  // were waiting for Outlook resume. Its failure never undoes the connection.
  afterConnect?: (a: { userId: string; email: string | null; scopes: string[] }) => Promise<unknown>;
  // The connect page's calm done state, once the owner has switched that page on; absent: this function's own plain pages.
  landing?: (o: { ok: boolean; denied: boolean; email: string | null }) => Response | Promise<Response> | null;
}
const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline' ${FONT_CSP.style}; font-src ${FONT_CSP.font}; img-src data:; form-action 'self' https://login.microsoftonline.com; frame-ancestors 'none'` };
// On the shared Trainee shell (brand.ts systemPage): ink text on the warm ground, plum only on the one button (Q564, Q575).
export function page(title: string, body: string[], status = 200, form?: { action: string; token: string }): Response {
  const html = systemPage(title, body, form ? { ...form, label: "Continue to Microsoft" } : undefined);
  return new Response(html, { status, headers: HEADERS });
}
const GONE: Record<string, string> = {
  used: 'This link was already used. Links work once: text "connect my outlook" for a new one.',
  expired: 'This link expired. Links last 15 minutes: text "connect my outlook" for a new one.',
  invalid: 'This link isn\'t valid. Text "connect my outlook" for a new one.',
};
async function tell(d: OAuthDeps, link: any, linkId: string, text: string, now: number) {
  if (link.channel === "web") {
    if (!link.thread_id) return;
    const r = await d.admin.from("agent_messages").insert({ thread_id: link.thread_id, role: "assistant", content: text, meta: { career: true, intent: "career_outlook_connected", link: linkId } });
    if (r.error) d.log?.(`outlook-oauth: the chat message was not written: ${r.error.message}`);
    return;
  }
  const key = `status:outlook:${linkId}`;
  const r = await d.admin.from("career_outbox").insert({ user_id: link.user_id, key, kind: "status", text, deliver_at: at(now), channel: link.channel === "home" ? null : link.channel });
  if (r.error) { d.log?.(`outlook-oauth: the channel message was not queued: ${r.error.message}`); return; }
  await d.deliver?.({ userId: link.user_id, key, now }).catch(() => {});
}
export async function handleOutlookOAuth(req: Request, d: OAuthDeps): Promise<Response> {
  const now = (d.now ?? Date.now)();
  const url = new URL(req.url);
  const self = linkBase(d.env) ?? `${url.origin}${url.pathname}`;
  const secret = d.env.get(ENV.stateSecret) || "";
  const clientId = d.env.get(ENV.clientId) || "", clientSecret = d.env.get(ENV.clientSecret) || "";

  // The leased batch run (a scheduler or a worker instance): its own secret, never a person's.
  if (req.method === "POST" && (req.headers.get("content-type") ?? "").includes("application/json")) {
    const jobs = d.env.get("OUTLOOK_JOBS_SECRET") || "";
    if (!jobs || req.headers.get("x-outlook-jobs-secret") !== jobs) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const body = await req.json().catch(() => ({}));
    const kind = body.kind === "refresh" ? "refresh" : body.kind === "sync" ? "sync" : null;
    const batch = Number(body.batch);
    if (!kind || !Number.isInteger(batch) || batch < 1) return new Response(JSON.stringify({ error: "kind and batch are required" }), { status: 400 });
    const stats = await runOutlookBatch({ admin: d.admin, env: d.env, fetch: d.fetch, kind, batch, worker: String(body.worker ?? crypto.randomUUID()).slice(0, 80), now: d.now });
    return new Response(JSON.stringify(stats), { status: 200, headers: { "content-type": "application/json" } });
  }

  // Microsoft's callback.
  if (req.method === "GET" && url.searchParams.has("state")) {
    const linkId = await verifyState(url.searchParams.get("state") ?? "", secret, now);
    if (!linkId) return page("This didn't work", ['The sign-in came back without a valid link, so nothing was connected. Text "connect my outlook" for a new link.'], 400);
    const declined = url.searchParams.has("error") || !url.searchParams.get("code");
    const fin = await d.admin.rpc("career_outlook_link_finish", { p_link: linkId, p_outcome: declined ? "declined" : "connected", p_now: at(now) });
    const link = fin.error ? null : fin.data;
    if (!link || link.error) return page("This link was already used", [GONE[link?.error] ?? GONE.invalid], 400);
    if (declined) {
      await tell(d, link, linkId, 'Outlook wasn\'t connected: Microsoft\'s page was closed or declined, so nothing changed. Text "connect my outlook" for a new link.', now);
      return (await d.landing?.({ ok: false, denied: true, email: null })) ?? page("Outlook wasn't connected", ["Nothing changed. You can close this tab and go back to the chat."]);
    }
    try {
      if (!clientId || !clientSecret) throw new Error("not configured");
      const tok = await exchangeCode(d.fetch, { code: url.searchParams.get("code")!, verifier: await pkceVerifier(linkId, secret), clientId, clientSecret, redirectUri: self, now });
      const userId = String(link.user_id);
      // CONNECTORS ROUND 3 (2026-10-31, oauth_connect.ts): the Vault entry and the row in one transaction holding the
      // account. An account deleted while the person was at Microsoft stores nothing (Microsoft has no revoke to call); an
      // address another Trainee account holds stores nothing and is said plainly.
      const c = await commitGrant(d.admin, { userId, provider: PROVIDER, secret: JSON.stringify(tok), email: tok.email ?? null, scopes: String(tok.scopes ?? ""), now });
      if (c === "gone") {
        d.log?.("outlook-oauth: the account was deleted before the callback; nothing stored");
        return (await d.landing?.({ ok: false, denied: false, email: null })) ?? page("Outlook wasn't connected", ["This Trainee account no longer exists, so nothing was saved."], 410);
      }
      if (c === "taken") {
        await d.admin.from("career_outlook_links").update({ outcome: "error" }).eq("id", linkId);
        await tell(d, link, linkId, TAKEN_WORDS("Outlook", tok.email ?? null), now);
        return (await d.landing?.({ ok: false, denied: false, email: null })) ?? page("Outlook wasn't connected", [TAKEN_WORDS("Outlook", tok.email ?? null)], 409);
      }
      must(await d.admin.from("career_outlook_state").upsert({ user_id: userId, email: tok.email, token_expires_at: at(tok.expires_at), needs_reconnect_at: null, needs_reconnect_reason: null,
        next_sync_at: at(now), retry_after: null, updated_at: at(now) }, { onConflict: "user_id" }), "record the Outlook state");
      const can = [hasScope(tok.scopes, "Mail.Read") && "read your mail for replies", hasScope(tok.scopes, "Mail.Send") && "send emails you approve word for word",
        hasScope(tok.scopes, "Calendars.ReadWrite") && "check your calendar and add invites you approve"].filter(Boolean);
      // CONNECTORS ROUND 3: a permission left unticked is said now, with how to give it (missingWords).
      const text = [`Outlook connected: ${tok.email ?? "your account"}.${can.length ? ` You allowed me to ${can.join(", ")}.` : ""}`,
        missingWords("outlook", String(tok.scopes ?? "").split(/\s+/).filter(Boolean)), 'Say "disconnect outlook" any time to remove it.'].filter(Boolean).join(" ");
      await tell(d, link, linkId, text, now);
      await d.afterConnect?.({ userId, email: tok.email, scopes: String(tok.scopes ?? "").split(/\s+/).filter(Boolean) })
        .catch((e) => d.log?.(`outlook-oauth: resuming waiting tasks failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
      return (await d.landing?.({ ok: true, denied: false, email: tok.email })) ?? page(`Outlook connected${tok.email ? `: ${tok.email}` : ""}`, ["You can close this tab and go back to the chat."]);
    } catch (e) {
      d.log?.(`outlook-oauth callback failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      await d.admin.from("career_outlook_links").update({ outcome: "error" }).eq("id", linkId);
      await tell(d, link, linkId, 'Outlook wasn\'t connected: something went wrong on the way back from Microsoft, so nothing was saved. Text "connect my outlook" for a new link.', now);
      return (await d.landing?.({ ok: false, denied: false, email: null })) ?? page("Outlook wasn't connected", ["Something went wrong on the way back from Microsoft, so nothing was saved."], 502);
    }
  }

  // The person's tap: the token used once, then Microsoft's consent page with PKCE.
  if (req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const token = String(form?.get("t") ?? "");
    if (!clientId || !clientSecret || !secret) return page("Not available yet", ["Connecting Outlook isn't switched on yet, so nothing was connected."], 503);
    const r = await d.admin.rpc("career_outlook_link_open", { p_nonce: token, p_now: at(now) });
    if (r.error || !r.data || r.data.error) return page("This link can't be used", [GONE[r.data?.error] ?? GONE.invalid], 400);
    const linkId = String(r.data.link_id);
    const to = authorizeUrl({ clientId, redirectUri: self, state: await issueState(linkId, secret, now), challenge: await pkceChallenge(await pkceVerifier(linkId, secret)) });
    return new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }

  // The link opened (or fetched by a message preview): peek only.
  if (req.method === "GET" && url.searchParams.has("t")) {
    const token = url.searchParams.get("t") ?? "";
    const r = await d.admin.rpc("career_outlook_link_peek", { p_nonce: token, p_now: at(now) });
    const p = r.error ? { status: "invalid" } : r.data ?? { status: "invalid" };
    if (p.status !== "ok") return page("This link can't be used", [GONE[p.status] ?? GONE.invalid], 410);
    const whose = p.hint ? `the Trainee account ${p.hint}` : "the Trainee account you're chatting with";
    return page("Connect Outlook to Trainee", [
      `This connects your Outlook to ${whose}. Continue only if you asked Trainee for this link in the last 15 minutes.`,
      "Trainee reads your inbox's sender, subject and preview to spot replies; sends only emails you approve word for word; reads your calendar's busy times and adds invites you approve.",
      'Say "disconnect outlook" any time: Trainee deletes the access and what it read.',
    ], 200, { action: self, token });
  }
  return page("Nothing here", ['Text "connect my outlook" to Trainee for a link.'], 404);
}

// The page's "Continue with Microsoft": a link row bound to the person and the channel the page was opened from (so the callback tells
// them there, as it does for the chat's link), opened at once, then Microsoft's consent URL with PKCE. Null when not configured.
export async function outlookConsentFor(admin: Admin, env: Env, now: number, o: { userId: string; channel: string }): Promise<string | null> {
  const secret = env.get(ENV.stateSecret) || "", clientId = env.get(ENV.clientId) || "", clientSecret = env.get(ENV.clientSecret) || "";
  const redirectUri = linkBase(env);
  if (!secret || !clientId || !clientSecret || !redirectUri) return null;
  const nonce = must(await admin.rpc("career_outlook_link_issue", { p_user: o.userId, p_channel: o.channel, p_thread: null, p_purpose: "connect", p_now: at(now) }), "make the Outlook link");
  const r = must(await admin.rpc("career_outlook_link_open", { p_nonce: String(nonce), p_now: at(now) }), "open the Outlook link");
  if (!r || r.error) return null;
  const linkId = String(r.link_id);
  return authorizeUrl({ clientId, redirectUri, state: await issueState(linkId, secret, now), challenge: await pkceChallenge(await pkceVerifier(linkId, secret)) });
}
