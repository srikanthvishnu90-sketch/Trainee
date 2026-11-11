// CONNECTORS ROUND 3 (2026-10-31; tests/architect/scenarios-connectors-r3.test.ts, flow-scenarios-connectors-r3.test.ts):
// how a connect callback stores a grant, for Gmail (gmail-oauth, googleCallback below) and Outlook (outlook_connector.ts).
// Before, each callback wrote the Vault entry (oauth_vault_store), then upserted the connection row, as two steps:
//   - a person who deleted their account between the consent and the callback (a Gmail state lives ten minutes; Outlook's
//     link is finished before Microsoft's code is exchanged) got a Vault entry with a refresh token for an account that no
//     longer exists, then the row's insert failed on its foreign key; nothing ever removed the entry, and the new Google
//     grant was never revoked;
//   - a Gmail state could be used more than once in its ten minutes: paired with another consent's code, it connected another
//     Google account to the state's Trainee account;
//   - one Google or Microsoft address could be connected to two Trainee accounts: Google keeps one grant per person and app,
//     so the first account's disconnect or deletion revoked the second's access at Google, and the same mail was read into
//     both accounts.
// Now: a Gmail state is spent once (oauth_state_use) before any code is exchanged; the Vault entry and the row are written
// in one transaction that holds the account (oauth_connect_commit, 20261031060000): 'gone' stores nothing and the new grant
// is revoked at Google; 'taken' stores nothing and revokes nothing (revoking would cut the other account off), and the
// person is told in plain words. On a project without that migration the old two writes are used, so the code and the
// migration can be deployed in either order.
// deno-lint-ignore-file no-explicit-any
import { revokeAtGoogle, type RevokeOutcome } from "./google_disconnect.ts";
import { commitAddedAccount } from "./career_google_accounts.ts"; // D-062
import { GMAIL_READONLY, GMAIL_SEND } from "./google_scopes.ts";
import { hasScope } from "./outlook_graph.ts";

type Admin = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }>; from(t: string): any };
const missing = (e: any, fn: string) => {
  const s = `${e?.code ?? ""} ${e?.message ?? ""}`;
  return (new RegExp(fn, "i").test(s) || /PGRST202/.test(s)) && /exist|find|no function|PGRST202/i.test(s);
};

export type CommitOutcome = "connected" | "gone" | "taken";
export interface Grant { userId: string; provider: "google_career" | "gmail" | "microsoft"; secret: string; email: string | null; scopes: string; now: number }
export async function commitGrant(admin: Admin, g: Grant): Promise<CommitOutcome> {
  const r = await admin.rpc("oauth_connect_commit", { p_user: g.userId, p_provider: g.provider, p_secret: g.secret, p_email: g.email, p_scopes: g.scopes, p_now: new Date(g.now).toISOString() });
  if (!r.error) {
    if (r.data === "connected" || r.data === "gone" || r.data === "taken") return r.data;
    throw new Error("record the connection");
  }
  if (!missing(r.error, "oauth_connect_commit")) throw new Error("record the connection");
  // The old two writes (a project without 20261031060000).
  const vaultName = `oauth_${g.provider}_${g.userId}`;
  const s = await admin.rpc("oauth_vault_store", { p_name: vaultName, p_secret: g.secret });
  if (s.error) throw new Error("save the access");
  const u = await admin.from("user_oauth_connections").upsert({ user_id: g.userId, provider: g.provider, vault_name: vaultName, email: g.email, scopes: g.scopes,
    connected_at: new Date(g.now).toISOString() }, { onConflict: "user_id,provider" });
  if (u.error) throw new Error("record the connection");
  return "connected";
}

// A Gmail state, spent once. false: it was used before. A project without the function spends nothing (true), as before.
export async function spendState(admin: Admin, state: string): Promise<boolean> {
  const r = await admin.rpc("oauth_state_use", { p_state: state });
  if (!r.error) return r.data === true;
  if (missing(r.error, "oauth_state_use")) return true;
  throw new Error("check the sign-in");
}

// What the person reads when a connect was refused (the chat it came from, and the landing page).
export const TAKEN_WORDS = (label: "Gmail" | "Outlook", email: string | null) =>
  `${label} wasn't connected: ${email ?? "that account"} is already connected to another Trainee account, and one ${label === "Gmail" ? "Google" : "Microsoft"} account can be connected to only one Trainee account. Nothing was saved. Disconnect it from the other Trainee account first (text "disconnect ${label === "Gmail" ? "gmail" : "outlook"}" there), or connect a different account here.`;
// D-037: what the person reads when an "allow sending" consent was refused. Nothing changed on their connection.
export const SEND_REFUSED_WORDS = (why: SendRefusal, connected: string | null) =>
  why === "send_other_account" ? `Sending wasn't allowed: you signed in to a different Google account${connected ? ` than ${connected}` : ""}, the one connected to Trainee. Nothing changed. Open the link again and choose that account.`
  : why === "send_no_connection" ? "Sending wasn't allowed: no Gmail is connected to your Trainee account, so there was nothing to add sending to. Nothing changed. Text \"connect gmail\" first."
  : "Sending wasn't allowed: Google didn't grant sending (or dropped a permission you had given before), so nothing changed. Open the link again and leave every box ticked.";
export const REPLAYED_WORDS = 'This sign-in was already used, so nothing changed. Text "connect gmail" to Trainee for a new link if you need one.';

// ------------------------------------------------------------------------------------------------ Gmail's callback
// GET ?code&state from Google. The caller (gmail-oauth) has verified the state's signature and expiry (career.ts
// verifyState) and passes what it names. Every network call goes through d.fetch.
export interface GoogleCallbackDeps {
  admin: Admin; fetch: typeof fetch; now: () => number;
  clientId: string; clientSecret: string; redirectUri: string;
  grantedFallback: () => string; // the scopes asked, when Google does not echo what it granted
  sleep?: (ms: number) => Promise<void>;
}
export type GoogleCallbackOut =
  | { ok: true; email: string | null; scopes: string; added?: true } // added: another account beside the first (D-062)
  | { ok: false; why: "replayed" | "exchange" | "gone" | "taken" | "store" | "limit" | SendRefusal; email?: string | null; revoke?: RevokeOutcome };
// D-037 (review of #407): why a send consent (a state bound to the connected account) was refused. Nothing is stored and
// the grant Google just made is revoked; the connection the person had is untouched.
export type SendRefusal = "send_no_connection" | "send_other_account" | "send_scopes";
const IDENTITY = new Set(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"]);
async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Whether a refused send consent's grant may be revoked at Google: only when the signed-in address is in NO
// user_oauth_connections row (google_career or gmail) of any person, this person's own included, compared without case
// (ilike: an underscore in an address also matches any one character, which can only make a match, so only fewer revokes).
// Revoking ends the whole grant of that account for Trainee, so an account anyone has connected keeps its grant. A Google
// row stored with no address (oauth_connect_commit keeps a null email when Google's userinfo failed) could be any account,
// so while any exists nothing is revoked. Any doubt (no address, a read error, a thrown query) is a no.
const GOOGLE_PROVIDERS = ["google_career", "gmail"];
export async function sendRevokeAllowed(admin: Admin, email: string | null): Promise<boolean> {
  if (!email || !email.trim()) return false;
  try {
    const unknown = await admin.from("user_oauth_connections").select("user_id").in("provider", GOOGLE_PROVIDERS).is("email", null).limit(1);
    if (unknown.error || !Array.isArray(unknown.data) || unknown.data.length) return false;
    const r = await admin.from("user_oauth_connections").select("user_id").in("provider", GOOGLE_PROVIDERS).ilike("email", email.trim()).limit(1);
    if (r.error || !Array.isArray(r.data)) return false;
    return r.data.length === 0;
  } catch { return false; }
}

// The send consent's checks, before anything is stored: the person has a connection of this provider; the account that
// signed in is that connection's account and the one the state was bound to; the grant keeps every permission the
// connection had and adds gmail.send. null: all hold.
export async function sendConsentRefusal(admin: Admin, o: { userId: string; provider: string; bind: string; email: string | null; scopes: string }): Promise<SendRefusal | null> {
  const r = await admin.from("user_oauth_connections").select("email,scopes").eq("user_id", o.userId).eq("provider", o.provider).maybeSingle();
  if (r.error) throw new Error("read the connection");
  const held = r.data;
  if (!held || typeof held.email !== "string" || !held.email.trim()) return "send_no_connection";
  const norm = (e: string) => e.trim().toLowerCase();
  if (!o.email || norm(o.email) !== norm(held.email) || await sha256Hex(norm(o.email)) !== o.bind) return "send_other_account";
  const granted = new Set(o.scopes.split(/\s+/).filter(Boolean));
  const had = String(held.scopes ?? "").split(/[\s,]+/).filter((s: string) => s && !IDENTITY.has(s));
  if (!granted.has(GMAIL_SEND) || had.some((s: string) => !granted.has(s))) return "send_scopes";
  return null;
}
export async function googleCallback(d: GoogleCallbackDeps, o: { code: string; state: string; userId: string; provider: "google_career" | "gmail"; bind?: string }): Promise<GoogleCallbackOut> {
  // The state is spent before Google sees the code: a replay exchanges nothing.
  if (!(await spendState(d.admin, o.state))) return { ok: false, why: "replayed" };
  const tokRes = await d.fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: o.code, client_id: d.clientId, client_secret: d.clientSecret, redirect_uri: d.redirectUri, grant_type: "authorization_code" }),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tokRes.ok || !tok?.access_token) return { ok: false, why: "exchange" };
  // Which Google address granted access (also validates the token).
  const meRes = await d.fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const me = await meRes.json().catch(() => ({}));
  const email = typeof me?.email === "string" ? me.email : null;
  // Scopes actually granted (Google echoes them on the token response) win over scopes requested.
  const scopes = typeof tok.scope === "string" && tok.scope.trim() ? tok.scope.split(/\s+/).filter(Boolean).join(" ") : d.grantedFallback();
  const secret = JSON.stringify({ access_token: tok.access_token, refresh_token: tok.refresh_token || null, expires_at: d.now() + (Number(tok.expires_in) || 3600) * 1000, email, scopes });
  // D-037: a send consent is bound to the connected account; any other account, no connection, or a grant that drops a
  // permission or lacks gmail.send stores nothing and revokes what Google just granted.
  if (o.bind) {
    let why: SendRefusal | null;
    try { why = await sendConsentRefusal(d.admin, { userId: o.userId, provider: o.provider, bind: o.bind, email, scopes }); } catch { why = "send_no_connection"; }
    // Google keeps ONE grant per person and app: revoking this token ends every token of that account for Trainee. So the
    // new grant is revoked only when no Trainee connection uses that Google account at all (sendRevokeAllowed); otherwise
    // nothing is stored and nothing revoked, and the account's existing grant (this person's or another's) keeps working.
    if (why) return { ok: false, why, email, ...(await sendRevokeAllowed(d.admin, email) ? { revoke: await revokeAtGoogle({ fetch: d.fetch, sleep: d.sleep }, secret) } : {}) };
  }
  // D-062: a career Google grant for another address than the first one is ADDED (career_google_accounts), never swapped in.
  if (o.provider === "google_career" && !o.bind) {
    let added: Awaited<ReturnType<typeof commitAddedAccount>>;
    try { added = await commitAddedAccount(d.admin, { userId: o.userId, secret, email, scopes, now: d.now() }); } catch { return { ok: false, why: "store", email }; }
    if (added === "added") return { ok: true, email, scopes, added: true };
    if (added === "taken") return { ok: false, why: "taken", email };
    if (added === "limit") return { ok: false, why: "limit", email };
    if (added === "gone") return { ok: false, why: "gone", email, revoke: await revokeAtGoogle({ fetch: d.fetch, sleep: d.sleep }, secret) };
    if (added === "invalid") return { ok: false, why: "store", email };
  }
  let c: CommitOutcome;
  try { c = await commitGrant(d.admin, { userId: o.userId, provider: o.provider, secret, email, scopes, now: d.now() }); } catch { return { ok: false, why: "store", email }; }
  // The account is gone: the grant Google just made is revoked, nothing is kept.
  if (c === "gone") return { ok: false, why: "gone", email, revoke: await revokeAtGoogle({ fetch: d.fetch, sleep: d.sleep }, secret) };
  if (c === "taken") return { ok: false, why: "taken", email };
  return { ok: true, email, scopes };
}

// CONNECTORS ROUND 3 (2026-10-31): a partial grant. Google and Microsoft let the person untick a permission on the consent
// page; the grant is stored with what was granted, and every feature that needs a missing permission stops and says which
// one and how to give it, in plain words. Said at connect time too (missingWords), so the person is not left believing
// Trainee watches an inbox it cannot read.
export const PARTIAL_WORDS = {
  gmail: {
    read: 'Your Gmail is connected, but you didn\'t allow Trainee to read your mail, so nothing was read. To fix it, text "disconnect gmail", then "connect gmail" and leave the box for reading your email ticked on Google\'s page.',
    send: 'Your Gmail is connected, but you didn\'t allow Trainee to send email from it, so nothing was sent. To fix it, text "disconnect gmail", then "connect gmail" and leave the box for sending email ticked on Google\'s page.',
  },
  outlook: {
    read: 'Your Outlook is connected, but you didn\'t allow Trainee to read your mail, so nothing was read. To fix it, text "disconnect outlook", then "connect my outlook" and allow reading your mail on Microsoft\'s page.',
    send: 'Your Outlook is connected, but you didn\'t allow Trainee to send email from it, so nothing was sent. To fix it, text "disconnect outlook", then "connect my outlook" and allow sending mail on Microsoft\'s page.',
  },
} as const;
// What a fresh grant does NOT allow that Trainee needs, said once when it connects ("" when nothing is missing). Gmail's
// send permission is asked only once Google approves it (GOOGLE_APPROVED_EXTRA_SCOPES), so it is missing only when asked.
export function missingWords(id: "gmail" | "outlook", scopes: string[], o: { sendAsked?: boolean } = {}): string {
  const has = (s: string) => id === "gmail" ? scopes.includes(s) : hasScope(scopes.join(" "), s);
  const c = id === "gmail" ? { read: GMAIL_READONLY, send: GMAIL_SEND } : { read: "Mail.Read", send: "Mail.Send" };
  const miss: string[] = [];
  if (!has(c.read)) miss.push("read your mail, so I can't spot replies or application codes");
  if ((id === "outlook" || o.sendAsked) && !has(c.send)) miss.push("send email, so nothing can be sent from it");
  if (!miss.length) return "";
  return `You didn't allow me to ${miss.join(", or to ")}. To change that, text "${id === "gmail" ? "disconnect gmail" : "disconnect outlook"}", then "${id === "gmail" ? "connect gmail" : "connect my outlook"}" and leave ${miss.length > 1 ? "those boxes" : "that box"} ticked.`;
}
