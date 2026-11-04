// Mass networking, lane M1 (2026-10-27): the sending rail. Emails the person approved leave from their own Gmail
// (D-MN-1), exactly once each, at whatever volume they approve. One rail for every kind: outreach, applications sent by
// email (APL-12) and any other email the person approves ("general"). The queue, its leases and its guards live in the
// database (20261027200000_career_send_queue.sql); this file builds the message, talks to Gmail at the HTTP boundary and
// reports back.
//
//   queueApprovedOutreach  N2's outreach approval hands over [{draftId, approvalHash}]: each draft is read back, its
//                          exact message re-hashed, and queued only if that hash is still the approval's.
//   queueApproved          the same for any kind: the caller passes the exact payload the person saw; its hash must be
//                          the approval hash, or it is refused.
//   outreachSendStatus     "where are my emails": counts, Gmail's own pause if any, in plain words.
//   runSendWorker          one sender instance: claims whole accounts (skip-locked, round robin), sends each account's
//                          emails one after another, completes each under its lease. Many run at once.
//   runReplyCheck          reads each sent email's thread (gmail.readonly): a bounce marks the address bad forever, a
//                          "stop" / "unsubscribe" / "not interested" opts them out forever, any other answer stops follow-ups.
//
// No volume limit of Trainee's own (owner, 2026-10-27 19:55 CDT): nothing here counts, spaces or caps sends. The only
// thing that slows an account is Gmail refusing (429, or 403 with a rate or quota reason): that account backs off until
// Gmail allows (its Retry-After, the time in its message, or a doubling wait), the person is told once in plain words, and
// every other account keeps sending.
// Message rules (no blast mode): exactly one recipient, a plain address; only To, Subject, MIME-Version, Content-Type and
// Content-Transfer-Encoding are written (Gmail adds From as the signed-in account); no Cc or Bcc ever; a header value
// with a line break or a control character is refused, never cleaned.
import { messageOf, payloadHash, type OutreachDraft } from "./career_outreach.ts";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
// The scopes the career Google grant must carry for this rail: gmail.send to send, gmail.readonly (already in the
// verification submission, _shared/google_scopes.ts) to check Sent after an interrupted try and to read replies and
// bounces. gmail.send reaches the consent screen only once the owner lists it in GOOGLE_APPROVED_EXTRA_SCOPES after
// Google approves it (docs/architect/OUTREACH-SEND-2026-10-27.md).
export const SEND_RAIL_SCOPES = [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE] as const;

export type Kind = "outreach" | "application" | "general";
export interface Rpc { rpc(name: string, args: { p: unknown }): PromiseLike<{ data: any; error: { message: string } | null }> }
const call = async (d: Rpc, name: string, p: unknown) => {
  const r = await d.rpc(name, { p });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return r.data;
};
export const sendRailOn = (env: { get(k: string): string | undefined }) => env.get("CAREER_SEND_RAIL") === "on";

// ------------------------------------------------------------------------------------------------ the message
export interface Mail { to: string; subject: string; text: string }
export const ONE_ADDRESS = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const b64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const utf8 = (s: string) => new TextEncoder().encode(s);
export const encodedWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(utf8(s))}?=`);
// Why a message may not go, or null. The address is compared exactly (lowercase, no spaces): "Jane <j@x.com>", a list,
// a comma, a semicolon or a line break is refused, as is a subject with any control character (CR/LF injection).
export function unsafe(m: Mail): string | null {
  if (typeof m.to !== "string" || !ONE_ADDRESS.test(m.to)) return "one recipient, one plain lowercase address";
  if (typeof m.subject !== "string" || !m.subject.trim() || m.subject.length > 200 || CONTROL.test(m.subject)) return "a subject on one line, without control characters";
  if (typeof m.text !== "string" || !m.text.trim() || m.text.length > 20000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(m.text)) return "a plain text body";
  return null;
}
// Cold outreach carries List-Unsubscribe (RFC 2369): a mailto to the person's own address with the subject
// "unsubscribe" (runReplyCheck reads those into the opt-out list), plus a one-click HTTPS link (RFC 8058) when one is
// given. Both are built only from checked values: a plain address and an https URL without spaces or angle brackets.
export interface Unsubscribe { mailto: string; url?: string | null }
const ONE_CLICK = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~\/?=&%+-]*$/;
export function unsubscribeHeaders(u: Unsubscribe | null | undefined): string[] {
  if (!u || !ONE_ADDRESS.test(u.mailto)) return [];
  const url = u.url && ONE_CLICK.test(u.url) ? u.url : null;
  return [`List-Unsubscribe: <mailto:${u.mailto}?subject=unsubscribe>${url ? `, <${url}>` : ""}`, ...(url ? ["List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : [])];
}
// RFC 2822 / MIME, base64 body (so no body line can ever be read as a header or a boundary).
export function buildMime(m: Mail, o: { unsubscribe?: Unsubscribe | null } = {}): string {
  const why = unsafe(m);
  if (why) throw new Error(`refused: ${why}`);
  const body = m.text.replace(/\r?\n/g, "\r\n");
  const head = [`To: ${m.to}`, `Subject: ${encodedWord(m.subject)}`, ...unsubscribeHeaders(o.unsubscribe), "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"];
  return `${head.join("\r\n")}\r\n\r\n${b64(utf8(body)).replace(/.{1,76}/g, "$&\r\n")}`;
}
export const rawOf = (m: Mail, o: { unsubscribe?: Unsubscribe | null } = {}) => b64(utf8(buildMime(m, o))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// The approval hash of an exact message: the same SHA-256 the outreach approval binds (career_outreach.ts payloadHash).
export const mailHash = (m: Mail) => payloadHash({ to: m.to, subject: m.subject, text: m.text });

// ------------------------------------------------------------------------------------------------ queueing
// Where an address came from (D-MN-3 replaced, 2026-10-27 21:32 CDT), carried so the card can show it: published (on a
// public page), known (the person's own mail) or inferred (the company's email format, named by addressFormat, e.g.
// "first.last"). Inferred addresses may be sent after approval; a bounce reports the format to the learner.
export type AddressType = "published" | "known" | "inferred";
export const ADDRESS_TYPES: readonly AddressType[] = ["published", "known", "inferred"];
export interface SendItem {
  kind: Kind; sourceId: string; approvalHash: string; to: string; subject: string; text: string;
  // followUpOf: the first email of the sequence (or any email in it); sendAt: not before this time (a sequence's spacing,
  // set by the person).
  followUpOf?: string | null; sendAt?: string | null; provider?: "gmail" | "outlook";
  addressType?: AddressType | null; addressFormat?: string | null;
  // Never accepted: present at all, the item is refused (D-MN-2: nothing the person was not shown).
  cc?: unknown; bcc?: unknown;
}
export type QueueResult = { sourceId: string; status: "queued" | "already_queued" | "refused"; reason?: string; id?: string };

// Which mailbox sends an item the caller did not pin: the person's connected one that can send (mail_providers.ts
// sendProviders, most recently connected first), else Gmail. The database refuses one that is not connected.
export interface QueueDeps extends Rpc { which?: (userId: string) => Promise<{ id: "gmail" | "outlook" }[]> }
export async function queueApproved(d: QueueDeps, userId: string, items: SendItem[]): Promise<QueueResult[]> {
  const chosen = items.some((x) => x && !x.provider) && d.which ? (await d.which(userId).catch(() => []))[0]?.id ?? "gmail" : "gmail";
  const out: (QueueResult | null)[] = [];
  const ok: { i: number; p: Record<string, unknown> }[] = [];
  for (const [i, it] of items.entries()) {
    const refuse = (reason: string) => { out[i] = { sourceId: String(it?.sourceId ?? ""), status: "refused", reason }; };
    if (!it || typeof it !== "object") { out.push(null); refuse("invalid"); continue; }
    out.push(null);
    if ("cc" in it || "bcc" in it) { refuse("cc_bcc_not_approved"); continue; }
    if (!["outreach", "application", "general"].includes(it.kind)) { refuse("invalid"); continue; }
    if (it.provider != null && it.provider !== "gmail" && it.provider !== "outlook") { refuse("invalid"); continue; }
    const m: Mail = { to: String(it.to ?? ""), subject: String(it.subject ?? ""), text: String(it.text ?? "") };
    if (unsafe(m)) { refuse("unsafe_header"); continue; }
    if ((await mailHash(m)) !== it.approvalHash) { refuse("changed"); continue; }
    if (it.addressType != null && !ADDRESS_TYPES.includes(it.addressType)) { refuse("invalid"); continue; }
    ok.push({ i, p: { kind: it.kind, source_id: it.sourceId, approval_hash: it.approvalHash, to: m.to, subject: m.subject, body: m.text, provider: it.provider ?? chosen,
      ...(it.followUpOf ? { follow_up_of: it.followUpOf } : {}), ...(it.sendAt ? { send_at: it.sendAt } : {}), ...(it.addressType ? { address_type: it.addressType } : {}), ...(it.addressFormat ? { address_format: String(it.addressFormat).toLowerCase() } : {}) } });
  }
  if (ok.length) {
    const res: any[] = await call(d, "career_send_enqueue", { user: userId, items: ok.map((x) => x.p) });
    ok.forEach((x, k) => {
      const r = res[k] ?? {};
      out[x.i] = { sourceId: String(r.source_id ?? x.p.source_id), status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.id ? { id: r.id } : {}) };
    });
  }
  return out as QueueResult[];
}

// N2's hand-off (career_outreach.ts outreachTurn onApproved): each approved draft read back by id and re-hashed from its
// stored text; a draft that is gone, not approved, or whose text no longer hashes to its approval is refused.
export interface OutreachDeps extends QueueDeps { drafts(userId: string, ids: string[]): Promise<OutreachDraft[]> }
// The address type rides on the draft's recipient row (recipient.address_type / address_format, written by the people
// lanes) or on the item; the draft's own wins.
export async function queueApprovedOutreach(d: OutreachDeps, userId: string, items: { draftId: string; approvalHash: string; addressType?: AddressType | null; addressFormat?: string | null }[]): Promise<QueueResult[]> {
  const rows = new Map((await d.drafts(userId, items.map((x) => x.draftId))).map((r) => [r.id, r]));
  const send: SendItem[] = [], at: number[] = [], out: QueueResult[] = [];
  for (const [i, x] of items.entries()) {
    const r = rows.get(x.draftId);
    if (!r) { out[i] = { sourceId: x.draftId, status: "refused", reason: "not_found" }; continue; }
    if (r.status !== "approved" || r.approved_hash !== x.approvalHash || r.hash !== x.approvalHash) { out[i] = { sourceId: x.draftId, status: "refused", reason: r.status === "approved" ? "changed" : "not_approved" }; continue; }
    const m = messageOf(r);
    const rec = r.recipient as unknown as Record<string, unknown>;
    const addressType = (rec.address_type ?? x.addressType ?? null) as AddressType | null;
    const addressFormat = (rec.address_format ?? x.addressFormat ?? null) as string | null;
    send.push({ kind: "outreach", sourceId: r.id, approvalHash: x.approvalHash, to: m.to, subject: m.subject, text: m.text, addressType, addressFormat });
    at.push(i);
  }
  const got = send.length ? await queueApproved(d, userId, send) : [];
  got.forEach((g, k) => { out[at[k]] = g; });
  return out;
}

// ------------------------------------------------------------------------------------------------ status
export interface SendStatus {
  counts: Record<string, number>; waiting: number; sent: number; nextAt: string | null;
  account: { state: string; resume_at: string | null; reason: string | null } | null; line: string;
}
const at = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
};
const n_ = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export async function outreachSendStatus(d: Rpc, userId: string): Promise<SendStatus> {
  const s = await call(d, "career_send_status", { user: userId });
  const c: Record<string, number> = s?.counts ?? {};
  const waiting = (c.queued ?? 0) + (c.sending ?? 0), sent = (c.sent ?? 0) + (c.replied ?? 0) + (c.bounced ?? 0);
  const account = (s?.accounts ?? []).find((a: any) => a.provider === "gmail") ?? null;
  const parts: string[] = [];
  if (!waiting && !sent && !(c.cancelled ?? 0) && !(c.refused ?? 0) && !(c.failed ?? 0)) parts.push("No approved emails have been queued to send from your Gmail yet.");
  else {
    parts.push(`${n_(sent, "email")} sent from your Gmail${waiting ? `, ${waiting} waiting to go` : ""}.`);
    if (c.replied) parts.push(`${n_(c.replied, "person has", "people have")} replied.`);
    if (c.bounced) parts.push(`${n_(c.bounced, "address")} bounced and won't be emailed again.`);
    if (c.cancelled) parts.push(`${n_(c.cancelled, "email was", "emails were")} not sent: cancelled, or the person had opted out or their address bounced.`);
    if (c.refused) parts.push(`${n_(c.refused, "email was", "emails were")} not sent because ${c.refused === 1 ? "it" : "they"} changed after you approved ${c.refused === 1 ? "it" : "them"}.`);
    if (c.failed) parts.push(`Gmail refused ${n_(c.failed, "email")}.`);
  }
  if (account?.state === "backoff" && account.resume_at && Date.parse(account.resume_at) > Date.now()) parts.push(`Gmail has paused sending from your account for now (it limits how much one account can send); Trainee carries on automatically around ${at(account.resume_at)}.`);
  if (account?.state === "needs_reconnect") parts.push(`Sending is stopped: Google says your Gmail connection no longer allows it. Say "connect gmail" to reconnect, and what's waiting goes out.`);
  if (account?.state === "disconnected") parts.push("Gmail is disconnected, so nothing more will be sent from it.");
  if (account?.state === "paused") parts.push(`Sending from your Gmail is paused${account.reason ? ` (${account.reason})` : ""}. Say "resume sending" when you want what's waiting to go.`);
  return { counts: c, waiting, sent, nextAt: s?.next_at ?? null, account: account ? { state: account.state, resume_at: account.resume_at ?? null, reason: account.reason ?? null } : null, line: parts.join(" ") };
}
// "where are my emails", "what's the status of my emails?", "did my emails go out?": an ask about the emails themselves,
// never one about applications (career_apply_status.ts) or about replies ("who replied", the replies turn).
const EMAIL_WORDS = String.raw`(?:(?:outreach|cold|networking|approved|queued|intro) )?(?:e-?mails?|outreach(?: e-?mails?)?)`;
const EMAIL_STATUS = [
  new RegExp(String.raw`^(?:so |and |ok |okay )?(?:where are|where'?s|how are|what'?s the status (?:of|on)|what is the status (?:of|on)|status (?:of|on)|any updates? on|update on|check on|show me the status of) (?:all )?(?:of )?my ${EMAIL_WORDS}$`),
  new RegExp(String.raw`^(?:did|have|has) (?:all )?(?:of )?(?:my|the) ${EMAIL_WORDS} (?:go out|gone out|been sent|get sent|send|sent)(?: yet)?$`),
  new RegExp(String.raw`^(?:my )?(?:e-?mail|outreach e-?mail|sending) status$`),
];
export function emailStatusAsk(message: string): boolean {
  // ROUTING SCENARIOS (2026-10-29): a greeting before the ask ("hey", "please") or "please" / "thanks" after it.
  const t = String(message ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim()
    .replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(/^(?:(?:hey|hi|hello|ok|okay|pls|please)\b[,!:]?\s+)+/, "").replace(/,? (?:please|pls|thanks|thank you)$/, "").replace(/[?.!]+$/, "");
  return t.length <= 120 && EMAIL_STATUS.some((re) => re.test(t));
}
// The chat's answer to that ask, from the rail's own counts (career_send_status) and, when the caller can read them, the
// approved emails not on the rail (e.g. approved before Gmail was connected). Not this ask: null.
export async function outreachStatusTurn(o: { message: string; userId: string; rail: Rpc; approvedNotQueued?: (userId: string) => Promise<number> }): Promise<{ reply: string; intent: string; status: string } | null> {
  if (!emailStatusAsk(o.message)) return null;
  const s = await outreachSendStatus(o.rail, o.userId);
  const off = o.approvedNotQueued ? await o.approvedNotQueued(o.userId) : 0;
  const more = off > 0 ? ` ${n_(off, "email")} you approved ${off === 1 ? "is" : "are"} not queued to send yet.` : "";
  return { reply: s.line + more, intent: "career_outreach_send_status", status: s.waiting || s.sent || off ? "shown" : "none" };
}
// "resume sending" after a pause (bounces, or Gmail's spam or policy refusal): 'resumed', or the account's state.
export async function resumeSending(d: Rpc, userId: string): Promise<string> {
  return String(await call(d, "career_send_resume", { user: userId }));
}
export async function cancelQueued(d: Rpc, userId: string, sourceIds?: string[]): Promise<number> {
  return Number(await call(d, "career_send_cancel", { user: userId, ...(sourceIds ? { source_ids: sourceIds } : {}) })) || 0;
}

// ------------------------------------------------------------------------------------------------ Gmail's answers
export type GmailAnswer =
  | { kind: "sent"; id: string; threadId: string }
  | { kind: "quota"; resumeAt: number; detail: string }
  | { kind: "reconnect"; detail: string }
  | { kind: "retry"; detail: string }
  | { kind: "policy"; detail: string }
  | { kind: "failed"; detail: string };
const RATE = /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded|sending limit|rate limit/i;
// Gmail refusing a message as spam, abuse or against its policy: the account pauses until the person says so.
const POLICY = /spam|abus|policy|blocked|suspend|message rejected|reputation|phishing/i;
// How long Gmail asked us to wait: Retry-After (seconds or a date), else "Retry after <ISO time>" in its message, else a
// doubling wait from one minute. Never shorter than a second.
export function resumeAfter(r: { headers: Headers }, message: string, attempt: number, now: number): number {
  const ra = r.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0) return now + secs * 1000;
    const when = Date.parse(ra);
    if (Number.isFinite(when) && when > now) return when;
  }
  const m = /retry after\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(message);
  if (m && Date.parse(m[1]) > now) return Date.parse(m[1]);
  return now + Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 6 * 3600_000);
}
export async function classifyGmail(r: Response, attempt: number, now: number): Promise<GmailAnswer> {
  if (r.ok) {
    const j: any = await r.json().catch(() => ({}));
    return j?.id ? { kind: "sent", id: String(j.id), threadId: String(j.threadId ?? "") } : { kind: "retry", detail: "send: no message id in Gmail's answer" };
  }
  const text = await r.text().catch(() => "");
  let msg = text;
  try { const j = JSON.parse(text); msg = [j?.error?.message, ...(j?.error?.errors ?? []).map((e: any) => `${e?.reason ?? ""} ${e?.message ?? ""}`)].filter(Boolean).join("; ") || text; } catch { /* not JSON */ }
  const detail = `HTTP ${r.status}${msg ? `: ${msg.slice(0, 200)}` : ""}`;
  if (r.status === 429 || (r.status === 403 && RATE.test(msg))) return { kind: "quota", resumeAt: resumeAfter(r, msg, attempt, now), detail };
  if ((r.status === 400 || r.status === 403 || r.status === 550) && POLICY.test(msg)) return { kind: "policy", detail };
  if (r.status === 401 || r.status === 403) return { kind: "reconnect", detail };
  if (r.status >= 500) return { kind: "retry", detail };
  return { kind: "failed", detail };
}

// ------------------------------------------------------------------------------------------------ the worker
export interface Claimed {
  id: string; user_id: string; kind: Kind; source_id: string; approval_hash: string; provider: string;
  to: string; subject: string; body: string; attempts: number; first_claimed_at: string; follow_up_of: string | null;
  address_type?: AddressType | null;
  from_email?: string | null; // the person's own address, for List-Unsubscribe
  // Outreach only: the draft as stored when it was claimed (its row locked), re-hashed before the send.
  draft?: Pick<OutreachDraft, "recipient" | "subject" | "body" | "footer"> | null;
}
export interface WorkerDeps extends Rpc {
  fetch: typeof fetch;
  token: (userId: string, scope: string) => Promise<string | null>;
  drafts?: (userId: string, ids: string[]) => Promise<OutreachDraft[]>;
  now?: () => number;
  // The shared domain-format learner (lane M2, Request): told of every bounce and every human reply, with the domain and
  // the local-part format the address was inferred from (null when it was published or known). Absent: not told.
  recordBounce?: RecordBounce;
  recordReply?: RecordBounce;
  // A one-click unsubscribe link for an outreach email (RFC 8058), when Trainee serves one. Absent: the mailto alone.
  unsubscribeUrl?: (it: Claimed) => string | null;
  // Other mailboxes (#226 mail_providers.ts MailProvider: send(userId, mail, {idemKey, purpose}) -> SendStatus). Gmail
  // is sent here directly (its thread ids, the Sent check, List-Unsubscribe); an Outlook item goes to providers.outlook.
  providers?: Partial<Record<"outlook", MailProviderLike>>;
}
// The shape of #226's MailProvider and SendStatus, structurally (that module ships with the Outlook connector).
export interface MailProviderLike {
  send(userId: string, mail: { to: string; subject: string; text: string }, o: { idemKey: string; purpose: "outreach" | "application" | "followup" | "general" }): Promise<
    | { status: "sent"; id?: string | null; thread_id?: string | null } | { status: "already_sent" } | { status: "NOT_WIRED" | "NEEDS_RECONNECT"; reason: string }
    | { status: "REFUSED" | "CHANGED" | "CANCELLED" | "UNKNOWN"; detail: string } | { status: "RATE_LIMITED"; retryAfterMs: number }>;
}
export type RecordBounce = (domain: string, localPartFormat: string | null, o: { addressType: AddressType | null }) => Promise<void>;
export interface WorkerOpts { worker: string; accounts?: number; perAccount?: number; leaseSeconds?: number; deadlineMs?: number; idleStop?: boolean }
export interface WorkerStats { claims: number; sent: number; already_sent: number; retry: number; quota: number; reconnect: number; policy: number; refused: number; failed: number; stale: number; errors: number; error: string | null }

// Was this exact message already sent (an earlier try that reached Gmail before the worker stopped)? Looks in the
// person's Sent mail for this recipient since the first claim, comparing the subject exactly. null: could not look.
async function inSent(d: WorkerDeps, userId: string, it: Claimed): Promise<{ id: string; threadId: string } | false | null> {
  const token = await d.token(userId, GMAIL_READ_SCOPE).catch(() => null);
  if (!token) return null;
  const since = Math.floor(Date.parse(it.first_claimed_at) / 1000) - 300;
  const q = `in:sent to:${it.to} after:${since}`;
  const list = await d.fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(q)}&maxResults=50`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!list || !list.ok) return null;
  const ids = ((await list.json().catch(() => ({})))?.messages ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean);
  for (const id of ids) {
    const r = await d.fetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!r || !r.ok) return null;
    const msg: any = await r.json().catch(() => null);
    const h = (n: string) => String((msg?.payload?.headers ?? []).find((x: any) => String(x?.name ?? "").toLowerCase() === n)?.value ?? "");
    const subj = h("subject"), to = h("to").toLowerCase();
    if ((subj === it.subject || subj === encodedWord(it.subject)) && to.includes(it.to)) return { id: String(msg?.id ?? id), threadId: String(msg?.threadId ?? "") };
  }
  return false;
}

type Outcome = { id: string; outcome: string } & Record<string, unknown>;
// One claimed email: what happened to it. Nothing is written here; the caller records outcomes in small batches.
// CONNECTOR SCENARIOS (2026-10-29): the last check before an email leaves (career_send_go, 20261029200000). A disconnect
// cancels every email of that mailbox, the ones a worker holds included; a worker that has not handed its email to the
// provider yet asks here and stops. Nothing is sent after the cancel commits; one already handed over is recorded as sent.
async function mayGo(d: WorkerDeps, it: Claimed, worker: string, stats: WorkerStats, out: (o: string, x?: Record<string, unknown>) => Outcome): Promise<Outcome | null> {
  const now = d.now ?? Date.now;
  const go = await call(d, "career_send_go", { worker, id: it.id }).catch(() => null);
  if (go === "go") return null;
  stats.stale++;
  return out("retry", { untried: true, detail: go === null ? "could not check the email before sending" : "cancelled before it went", retry_at: new Date(now() + 60_000).toISOString() });
}
async function sendOne(d: WorkerDeps, it: Claimed, stats: WorkerStats, worker: string): Promise<Outcome> {
  const now = d.now ?? Date.now;
  const out = (outcome: string, extra: Record<string, unknown> = {}): Outcome => ({ id: it.id, outcome, ...extra });
  const m: Mail = { to: it.to, subject: it.subject, text: it.body };
  // The payload is exactly what was approved: the queued copy hashes to the approval, and for outreach the draft as it is
  // stored now (read by the claim under its row lock) still says exactly the same thing.
  if (unsafe(m)) { stats.refused++; return out("refused", { detail: "unsafe header" }); }
  if ((await mailHash(m)) !== it.approval_hash) { stats.refused++; return out("refused", { detail: "changed after approval" }); }
  if (it.kind === "outreach") {
    const dr = it.draft ?? (d.drafts ? (await d.drafts(it.user_id, [it.source_id]))[0] : null);
    const cur = dr ? messageOf(dr) : null;
    if (!cur || (await payloadHash(cur)) !== it.approval_hash || cur.to !== m.to || cur.subject !== m.subject || cur.text !== m.text) {
      stats.refused++;
      return out("refused", { detail: "changed after approval" });
    }
  }
  // A second try: only after the person's Sent mail shows the first did not go.
  if (it.attempts > 1 && it.provider !== "outlook") {
    const seen = await inSent(d, it.user_id, it);
    if (seen === null) { stats.retry++; return out("retry", { detail: "could not check Sent before a second try", retry_at: new Date(now() + 60_000).toISOString() }); }
    if (seen) { stats.already_sent++; return out("already_sent", { gmail_id: seen.id, thread_id: seen.threadId }); }
  }
  if (it.provider === "outlook") return (await mayGo(d, it, worker, stats, out)) ?? await viaProvider(d, it, m, stats, out);
  const token = await d.token(it.user_id, GMAIL_SEND_SCOPE).catch(() => null);
  if (!token) { stats.reconnect++; return out("reconnect", { untried: true, detail: "no Google grant that may send" }); }
  const stop = await mayGo(d, it, worker, stats, out);
  if (stop) return stop;
  let ans: GmailAnswer;
  try {
    const unsubscribe = it.kind === "outreach" && it.from_email ? { mailto: it.from_email, url: d.unsubscribeUrl?.(it) ?? null } : null;
    const r = await d.fetch(`${GMAIL_API}/messages/send`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw: rawOf(m, { unsubscribe }) }) });
    ans = await classifyGmail(r, it.attempts, now());
  } catch (e) {
    ans = { kind: "retry", detail: `network: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  if (ans.kind === "sent") { stats.sent++; return out("sent", { gmail_id: ans.id, thread_id: ans.threadId }); }
  if (ans.kind === "quota") { stats.quota++; return out("quota", { untried: true, detail: ans.detail, resume_at: new Date(ans.resumeAt).toISOString() }); }
  if (ans.kind === "reconnect") { stats.reconnect++; return out("reconnect", { untried: true, detail: ans.detail }); }
  if (ans.kind === "policy") { stats.policy++; return out("policy", { untried: true, detail: ans.detail }); }
  if (ans.kind === "retry") {
    stats.retry++;
    return out("retry", { detail: ans.detail, retry_at: new Date(now() + Math.min(30_000 * 2 ** Math.max(0, it.attempts - 1), 3600_000)).toISOString() });
  }
  stats.failed++;
  return out("failed", { detail: ans.detail });
}

// An Outlook item through #226's provider. Its own ledger is exactly-once per idemKey; its UNKNOWN (a 5xx or a break: it
// may have gone) is never retried, so it is recorded as failed and said plainly. Graph returns no message id: the key's
// hash stands in for it.
async function viaProvider(d: WorkerDeps, it: Claimed, m: Mail, stats: WorkerStats, out: (o: string, x?: Record<string, unknown>) => Outcome): Promise<Outcome> {
  const p = d.providers?.outlook;
  const now = d.now ?? Date.now;
  if (!p) { stats.retry++; return out("retry", { untried: true, detail: "Outlook sending is not available yet", retry_at: new Date(now() + 3600_000).toISOString() }); }
  const purpose = it.kind === "application" ? "application" : it.follow_up_of ? "followup" : it.kind === "outreach" ? "outreach" : "general";
  const idemKey = `send:${it.id}`;
  const r = await p.send(it.user_id, m, { idemKey, purpose }).catch((e) => ({ status: "UNKNOWN" as const, detail: String(e) }));
  const keyId = `outlook:${(await payloadHash({ to: idemKey, subject: "", text: "" })).slice(0, 32)}`;
  switch (r.status) {
    case "sent": stats.sent++; return out("sent", { gmail_id: (r as any).id || keyId, thread_id: (r as any).thread_id ?? "" });
    case "already_sent": stats.already_sent++; return out("already_sent", { gmail_id: keyId });
    case "NOT_WIRED": case "NEEDS_RECONNECT": stats.reconnect++; return out("reconnect", { untried: true, detail: `Outlook: ${(r as any).reason}` });
    case "RATE_LIMITED": stats.quota++; return out("quota", { untried: true, detail: "Outlook rate limit", resume_at: new Date(now() + Math.max(1000, r.retryAfterMs)).toISOString() });
    case "CHANGED": stats.refused++; return out("refused", { detail: "changed after approval" });
    case "CANCELLED": stats.refused++; return out("refused", { detail: "outlook disconnected" });
    case "REFUSED":
      if (/spam|abus|policy|blocked|suspend|reputation/i.test(r.detail)) { stats.policy++; return out("policy", { untried: true, detail: `Outlook: ${r.detail}`.slice(0, 200) }); }
      stats.failed++; return out("failed", { detail: `Outlook refused: ${r.detail}`.slice(0, 200) });
    default: stats.failed++; return out("failed", { detail: `Outlook: may have gone, not retried (${(r as any).detail ?? r.status})`.slice(0, 200) });
  }
}

// Outcomes are recorded in batches of up to RECORD_EVERY (one transaction each): a send that reached Gmail and was not yet
// recorded when a worker died is found in Sent before any second try, so batching never sends twice.
export const RECORD_EVERY = 10;

// One sender instance. Claims accounts until nothing is due (or the deadline), sending each account's emails one after
// another and the accounts side by side. An account Gmail paused or that needs a reconnect hands its remaining claimed
// emails straight back (they wait with the account). A failure on one account is counted; the others carry on.
export async function runSendWorker(d: WorkerDeps, o: WorkerOpts): Promise<WorkerStats> {
  const now = d.now ?? Date.now;
  const stats: WorkerStats = { claims: 0, sent: 0, already_sent: 0, retry: 0, quota: 0, reconnect: 0, policy: 0, refused: 0, failed: 0, stale: 0, errors: 0, error: null };
  const end = now() + (o.deadlineMs ?? 100_000);
  while (now() < end) {
    const got = await call(d, "career_send_claim", { worker: o.worker, accounts: o.accounts ?? 20, per_account: o.perAccount ?? 25, lease_seconds: o.leaseSeconds ?? 120, now: new Date(now()).toISOString() });
    const accounts: { user_id: string; provider: string; items: Claimed[] }[] = got?.accounts ?? [];
    if (!accounts.length) break;
    stats.claims++;
    await Promise.all(accounts.map(async (a) => {
      let pending: Outcome[] = [];
      const record = async (release: boolean) => {
        if (!pending.length && !release) return;
        const batch = pending;
        pending = [];
        const r = await call(d, "career_send_complete", { worker: o.worker, results: batch, ...(release ? { release: { user: a.user_id, provider: a.provider } } : {}) });
        stats.stale += (Array.isArray(r) ? r : []).filter((x) => x === "stale").length;
      };
      try {
        let stop = false;
        for (const it of a.items) {
          if (stop || now() >= end + 60_000) {
            // Paused or out of time: hand the rest back untouched (no attempt used: it was never tried).
            pending.push({ id: it.id, outcome: "retry", untried: true, detail: stop ? "account paused" : "worker out of time", retry_at: new Date(now()).toISOString() });
            continue;
          }
          const r = await sendOne(d, it, stats, o.worker);
          pending.push(r);
          stop = r.outcome === "quota" || r.outcome === "reconnect" || r.outcome === "policy";
          if (pending.length >= RECORD_EVERY) await record(false);
        }
        await record(true);
      } catch (e) {
        stats.errors++;
        stats.error ??= (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
    }));
  }
  return stats;
}

// ------------------------------------------------------------------------------------------------ what came back
// The words of what came back, shared with the replies lane (career_outreach_replies.ts rulePass), so the two readers of a
// thread never disagree. REPLY SCENARIOS (2026-10-29, tests/architect/scenarios-replies.test.ts): ~10,000 generated
// messages (bounces from many mail systems, delay warnings, auto-replies in several languages, opt-outs in many forms,
// real replies with the original quoted below, HTML only, from a colleague) decide the rules below.
export interface ThreadMail { from: string; subject: string; snippet: string; headers?: Record<string, string> }
export const MAIL_SYSTEM_FROM = /\b(mailer-daemon|postmaster|mail delivery (?:subsystem|system)|microsoftexchange[0-9a-f]*)\b/i;
const FAILURE_SUBJECT = /(delivery status notification|undeliverable|undelivered mail|delivery has failed|mail delivery failed|returned mail|failure notice|address not found|delivery failure)/i;
// A delay warning: the mail system is still trying ("Delivery Status Notification (Delay)", "Delivery delayed:", Postfix's
// "Delayed Mail (still being retried)", Sendmail's "Warning: could not send message for past 4 hours", Exim's "Warning:
// message ... delayed 24 hours"). Read from the subject's own words (its start, or Gmail's "(Delay)"), else from the
// notice's text when the subject says neither failure nor delay.
const DELAY_SUBJECT = /\(delay\)|^\s*(?:delivery (?:has been |is )?delayed|delayed(?: mail| message| delivery)?\b|message delayed|delivery delay|warning: (?:could not send|message .{0,60}delayed))/i;
const DELAY_TEXT = /\b(?:this is a warning (?:message )?only|you do not need to resend|has (?:been )?delayed|not (?:yet )?been delivered yet|not delivered yet|has not yet been delivered|hasn'?t been delivered yet|will (?:keep trying|retry|be retried)|delivery will continue to be attempted|delivery attempts will continue|still being retried)\b/i;
const FAILURE_WORDS = /\(failure\)|undeliverable|undelivered|failed|failure|returned mail|not found|permanent/i;
// A read receipt ("Read: <subject>", a disposition notification): not an answer.
const RECEIPT_SUBJECT = /^\s*(?:read|not read|gelesen|lu|le[ií]do)\s*:/i;
export type Notice = "bounce" | "delay" | "receipt";
// A message from a mail system about delivery, or a read receipt; null for anything a person or their autoresponder wrote.
// Conservative rule (owner: never retry a bounce; a delay is not a bounce): a failure notice is a bounce whatever its reason,
// a full mailbox or a server that kept refusing included (the mail system has stopped trying, and the address is never
// tried again); only a notice that says it is still trying is a delay, and a delay marks nothing.
export function deliveryNotice(m: { from: string; subject: string; text: string; headers?: Record<string, string> }): Notice | null {
  const h = Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]));
  const subject = String(m.subject ?? ""), text = String(m.text ?? "").slice(0, 3000);
  if (/report-type=disposition-notification/i.test(h["content-type"] ?? "") || (RECEIPT_SUBJECT.test(subject) && /\bwas read\b|\bread on\b|\bdisplayed\b/i.test(text))) return "receipt";
  const system = MAIL_SYSTEM_FROM.test(m.from) || FAILURE_SUBJECT.test(subject) || /report-type=delivery-status/i.test(h["content-type"] ?? "") || "x-failed-recipients" in h;
  if (!system) return null;
  if (DELAY_SUBJECT.test(subject)) return "delay";
  if (!FAILURE_WORDS.test(subject) && !("x-failed-recipients" in h) && DELAY_TEXT.test(text)) return "delay";
  return "bounce";
}
// An automatic reply (out of office, vacation, leave), in English and the common European forms, from its headers, its
// subject, or its first words.
export const AUTO_SUBJECT = new RegExp(String.raw`^\s*\[?\s*(?:(?:re|aw|antw|sv|r)\s*:\s*)?(?:automatic reply|auto(?:matic)?[- ]?(?:reply|response|answer)|autoreply|autoresponder|out of (?:the )?office|ooo\b|away from (?:the |my )?(?:office|desk)|on (?:vacation|leave|holiday)\b|vacation (?:reply|response|message|notice)|abwesenheitsnotiz|automatische antwort|abwesend\b|r[ée]ponse automatique|absence du bureau|absent(?:e)? du bureau|respuesta autom[áa]tica|fuera de la oficina|risposta automatica|fuori (?:sede|ufficio)|automatisch antwoord|afwezig|autosvar|resposta autom[áa]tica|fora do escrit[óo]rio|automaattinen vastaus|odpowied[źz] automatyczna)`, "i");
export const AUTO_TEXT = /\b(?:i am|i'm|i will be|i'll be) (?:currently )?(?:out of (?:the )?office|away|on (?:vacation|leave|holiday|pto|parental leave|maternity leave|paternity leave|annual leave|sabbatical))\b|\bout of (?:the )?office (?:until|through|till)\b|\bwith (?:limited|no) access to (?:my )?e-?mail\b/i;
export function autoReply(m: { subject: string; text: string; headers?: Record<string, string> }): boolean {
  const h = Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]));
  if (/auto-replied|auto-generated/i.test(h["auto-submitted"] ?? "") || "x-autoreply" in h || "x-autorespond" in h || /auto_reply/i.test(h["precedence"] ?? "") || /^(?:oof|autoreply)$/i.test(h["x-auto-response-suppress"] ?? "")) return true;
  return AUTO_SUBJECT.test(String(m.subject ?? "")) || AUTO_TEXT.test(newText(m.text).slice(0, 600));
}
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all);
// The reply's own new words: everything before the quoted history (the "On ... wrote:" line in its English, French,
// German and Spanish forms, wrapped or not, "> " lines, Outlook's "From: ... Sent:" block and its underscore rule,
// "-----Original Message-----", a forwarded message) and before a "-- " signature. Works on a whole body and on Gmail's
// one-line, HTML-escaped snippet. A "stop" in the quoted history is the earlier email's, never this reply's.
const QUOTE_START = [
  /^[ \t]*>/m,
  // "On <date> <name> wrote:" (wrapped onto two lines or not): case as mail programs write it, and never across the end of
  // a sentence, so "On Monday I said stop." in the new text is not taken for the quote header.
  /\bOn\s(?:(?![.?!]\s)[\s\S]){0,240}?\bwrote:/,
  /\bLe\s[^\n]{0,240}?a\s[ée]crit\s?:/, /\bAm\s[^\n]{0,240}?schrieb[^\n]{0,160}?:/, /\bEl\s[^\n]{0,240}?escribi[óo]\s?:/,
  /-{2,}\s*(?:original message|forwarded message|mensaje original|message d'origine|urspr[üu]ngliche nachricht)\s*-*/i,
  /^[ \t]*-{5,}[ \t]*$/m, /_{8,}/,
  /^[ \t]*(?:\*\*)?From:(?:\*\*)?[ \t]+.*\n[ \t]*(?:\*\*)?(?:Sent|Date):/im, /\bFrom:\s[^\n]{0,200}?\b(?:Sent|Date):\s/,
  /^--[ \t]*$/m,
];
export function newText(body: string): string {
  let t = decodeEntities(String(body ?? "")).replace(/\r\n?/g, "\n");
  let cut = t.length;
  for (const re of QUOTE_START) { const m = re.exec(t); if (m && m.index < cut) cut = m.index; }
  t = t.slice(0, cut);
  return t.trim();
}
// "Stop", "unsubscribe", "remove me", "take me off your list", "not interested", "no thank you", "please don't contact me",
// in any case, anywhere in the new text; and a line that starts with stop / remove / unsubscribe / opt out (after a
// greeting or not). "Don't hesitate to email me", "stop by Thursday" in the middle of a sentence, "no thanks needed" are
// not opt-outs.
const OPT_OUT_ANYWHERE = /\b(?:unsubscribe|stop (?:emailing|e-mailing|contacting|writing to|messaging|sending)\b|please stop\b|remove me\b|take me off\b|do not (?:contact|email|e-mail|message|write to) me|don'?t (?:contact|email|e-mail|message|write to) me|opt me out|opt[- ]out\b|not interested|no longer interested|leave me alone|please don'?t reach out|do not reach out|no,? thanks?(?: you)?\b(?![ \t]+(?:needed|necessary|required|for\b))|no thank you\b|thanks,? but no thanks)/i;
const OPT_OUT_LEAD = /^(?:stop|remove|unsubscribe|opt[- ]?out)\b/i;
const GREETING = /^(?:(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening))\b[^,.!:\n]{0,30}|[A-Za-z]{2,20})\s*[,.!:\-–—]+\s*/i;
export function optedOut(fresh: string): boolean {
  const t = decodeEntities(String(fresh ?? "")).replace(/[’‘]/g, "'");
  if (OPT_OUT_ANYWHERE.test(t)) return true;
  for (const line of t.split("\n")) {
    const l = line.trim();
    if (OPT_OUT_LEAD.test(l) || OPT_OUT_LEAD.test(l.replace(GREETING, ""))) return true;
  }
  return false;
}
/** @deprecated the words are optedOut(newText(text)); kept for callers that test a whole string. */
export const OPT_OUT = OPT_OUT_ANYWHERE;
export const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
// What one message on a sent email's thread means for the rail: a bounce (the address is bad forever), a stop (the contact
// opted out forever), a reply (a person answered: the sequence stops), or other (a delay warning, a read receipt, an
// auto-reply: nothing changes). Someone else on the thread who answers (a colleague in CC, another address of the
// contact's) stops the sequence too, but only the contact's own words opt the contact out.
export function classifyIncoming(m: ThreadMail, recipient: string): "bounce" | "stop" | "reply" | "other" {
  const notice = deliveryNotice({ from: m.from, subject: m.subject, text: decodeEntities(m.snippet), headers: m.headers });
  if (notice === "bounce") return "bounce";
  if (notice) return "other"; // a delay is not a bounce (the mail system is still trying); a read receipt is not an answer
  if (autoReply({ subject: m.subject, text: m.snippet, headers: m.headers })) return "other"; // an out-of-office is not an answer
  if (addressOf(m.from) !== recipient.toLowerCase()) return "reply";
  return optedOut(newText(m.snippet)) || optedOut(m.subject.replace(/^\s*(?:re|aw|antw|sv)\s*:\s*/i, "")) ? "stop" : "reply";
}
// pause: mailbox protection after a bounce (career_send_record): the account's last `window` sends, at least `bounces`
// bounced and at least `rate` of them. Defaults 50, 5, 0.1; CAREER_SEND_BOUNCE_WINDOW / _COUNT / _RATE in career-send.
export interface PauseRule { window?: number; bounces?: number; rate?: number }
export async function runReplyCheck(d: WorkerDeps, o: { limit?: number; recheckSeconds?: number; pause?: PauseRule } = {}) {
  const stats = { checked: 0, bounces: 0, stops: 0, replies: 0, not_wired: 0, errors: 0, error: null as string | null };
  const due: { id: string; user_id: string; recipient_email: string; gmail_id: string; gmail_thread: string; address_type: AddressType | null; address_format: string | null; sent_at: string }[] =
    await call(d, "career_send_replies_due", { limit: o.limit ?? 200, recheck_seconds: o.recheckSeconds ?? 900 });
  for (const row of due) {
    try {
      const token = await d.token(row.user_id, GMAIL_READ_SCOPE).catch(() => null);
      if (!token) { stats.not_wired++; continue; }
      const r = await d.fetch(`${GMAIL_API}/threads/${encodeURIComponent(row.gmail_thread)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { stats.errors++; stats.error ??= `read a thread: HTTP ${r.status}`; continue; }
      stats.checked++;
      const j: any = await r.json().catch(() => ({}));
      const h = (m: any, n: string) => String((m?.payload?.headers ?? []).find((x: any) => String(x?.name ?? "").toLowerCase() === n)?.value ?? "");
      const kinds: string[] = (j?.messages ?? []).filter((m: any) => m?.id !== row.gmail_id && !(m?.labelIds ?? []).includes("SENT"))
        .map((m: any) => classifyIncoming({ from: h(m, "from"), subject: h(m, "subject"), snippet: String(m?.snippet ?? "") }, row.recipient_email));
      // The List-Unsubscribe mailto arrives as a new email from the recipient (subject "unsubscribe"), outside the thread.
      if (!kinds.includes("stop") && !kinds.includes("bounce")) {
        const since = Math.floor(Date.parse(row.sent_at) / 1000) - 60;
        const u = await d.fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(`from:${row.recipient_email} subject:unsubscribe after:${since}`)}&maxResults=5`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
        if (u?.ok && ((await u.json().catch(() => ({})))?.messages ?? []).length) kinds.push("stop");
      }
      const k = kinds.includes("bounce") ? "bounce" : kinds.includes("stop") ? "stop" : kinds.includes("reply") ? "reply" : null;
      if (!k) continue;
      await call(d, "career_send_record", { id: row.id, kind: k, ...(o.pause ? { pause: o.pause } : {}) });
      if (k === "bounce") stats.bounces++; else if (k === "stop") stats.stops++; else stats.replies++;
      // The learner hears about it after the address is already marked: a learner failure never un-marks a bounce.
      const hook = k === "bounce" ? d.recordBounce : d.recordReply;
      if (hook) {
        const domain = row.recipient_email.split("@")[1] ?? "";
        await hook(domain, row.address_format ?? null, { addressType: row.address_type ?? null }).catch((e) => { stats.errors++; stats.error ??= `format learner: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300); });
      }
    } catch (e) {
      stats.errors++;
      stats.error ??= (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
  }
  return stats;
}
