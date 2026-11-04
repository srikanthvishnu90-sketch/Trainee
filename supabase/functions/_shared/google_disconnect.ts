// Google verification (2026-10-26, review of PR #196): "disconnect gmail" really disconnects. One implementation for the
// chat ("disconnect gmail" in agent-chat, any channel) and for gmail-oauth's disconnect action:
//   1. every Google grant the person holds (provider google_career, and the legacy finance grant gmail) is revoked at
//      Google with its refresh token (else its access token): a 5-second timeout per call, up to 3 tries on a network
//      failure, a timeout, a 429 or a 5xx; only Google's 200 counts as revoked;
//   2. the stored tokens (Vault oauth_<provider>_<uid>) and the connection rows are deleted, every result checked;
//      the mail rows read from that Gmail (events, drafts, read cursor) are deleted by the google_career row's delete
//      (trigger 20261026200011) and again here, so the order the code and the migration are deployed in does not matter;
//   3. the state is read back: no Google connection row and no mail-tracking row is left, or the result says what is.
// What the person is told (disconnectReply) is only what that read-back shows, in plain words; a revoke Google did not
// confirm is said so, with where to remove access by hand.
// deno-lint-ignore-file no-explicit-any
import { disconnectOf } from "./connector_words.ts";

export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_PROVIDERS = ["google_career", "gmail"] as const;
export const REVOKE_TIMEOUT_MS = 5000;
export const REVOKE_TRIES = 3;

// revoked: Google answered 200. refused: Google answered 400 (its error for a token it does not accept, which includes one
// already revoked; not a confirmation). not_confirmed: no answer after every try, or another status. no_token: nothing to send.
export type RevokeOutcome = "revoked" | "refused" | "not_confirmed" | "no_token";

export interface RevokeDeps {
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  tries?: number;
}

async function postRevoke(d: RevokeDeps, token: string): Promise<"ok" | "refused" | "failed"> {
  const tries = Math.max(1, d.tries ?? REVOKE_TRIES);
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(500 * 2 ** (i - 1));
    try {
      const r = await d.fetch(GOOGLE_REVOKE, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }), signal: AbortSignal.timeout(d.timeoutMs ?? REVOKE_TIMEOUT_MS),
      });
      await r.body?.cancel().catch(() => {});
      if (r.status === 200) return "ok";
      if (r.status === 400) return "refused";
      if (r.status !== 429 && r.status < 500) return "failed"; // another 4xx: trying again will not change it
    } catch { /* a network failure or the timeout: try again */ }
  }
  return "failed";
}

// The stored secret is the vault JSON {access_token, refresh_token, ...}. The refresh token revokes the whole grant; if
// Google refuses it, the access token is tried (revoking it also revokes its refresh token, per Google's OAuth docs).
export async function revokeAtGoogle(d: RevokeDeps, storedSecret: string | null | undefined): Promise<RevokeOutcome> {
  let tok: any = null;
  try { tok = JSON.parse(String(storedSecret ?? "")); } catch { return "no_token"; }
  const tokens = [tok?.refresh_token, tok?.access_token].filter((t) => typeof t === "string" && t.length > 0) as string[];
  if (!tokens.length) return "no_token";
  let refused = false;
  for (const t of tokens) {
    const r = await postRevoke(d, t);
    if (r === "ok") return "revoked";
    if (r === "refused") refused = true;
  }
  return refused ? "refused" : "not_confirmed";
}

// Everything mail tracking keeps from a person's Gmail (20261020100000_career_mail_tracking.sql): the status events, the
// follow-up and thank-you drafts made from them, and the read cursor.
export const MAIL_TABLES = ["career_mail_events", "career_mail_drafts", "career_mail_cursors"] as const;
const MAIL_SAID = "delete the application updates, drafts and read time saved from your Gmail";

export interface DisconnectResult {
  ok: boolean; // every Google row and token is gone and no mail-tracking row is left
  had: string[]; // the providers the person had connected
  mailChecked: boolean; // the career grant was in scope, so the mail rows were judged
  mailErased: boolean; // mail rows existed before and none is left
  revoke: Record<string, RevokeOutcome>;
  failures: string[]; // what could not be done, in plain words
}

// admin: a service-role supabase-js client.
export async function disconnectGoogle(admin: any, userId: string, d: RevokeDeps, providers: readonly string[] = GOOGLE_PROVIDERS): Promise<DisconnectResult> {
  const failures: string[] = [], revoke: Record<string, RevokeOutcome> = {};
  // Mail tracking reads only through the career grant, so its rows are judged when that grant was asked to go.
  const mailChecked = providers.includes("google_career");
  const rows = await admin.from("user_oauth_connections").select("provider").eq("user_id", userId).in("provider", [...providers]);
  if (rows.error) return { ok: false, had: [], mailChecked, mailErased: false, revoke, failures: ["read which Google accounts are connected"] };
  const had: string[] = (rows.data ?? []).map((r: any) => String(r.provider));
  // Do mail rows exist? A person can have them with no connection left: a mail check that was running when they
  // disconnected, or a disconnect made before the migration that erases them (20261026200011).
  const mailLeft = async (): Promise<boolean | null> => {
    let any = false, unknown = false;
    for (const t of MAIL_TABLES) { // every table is read, so one that cannot be read does not hide another that has rows
      const r = await admin.from(t).select("user_id").eq("user_id", userId).limit(1);
      if (r.error) unknown = true;
      else if ((r.data ?? []).length) any = true;
    }
    return any ? true : unknown ? null : false;
  };
  const mailBefore = mailChecked ? await mailLeft() : false;
  if (mailBefore === null) failures.push("check that everything was deleted");
  for (const p of had) {
    const name = `oauth_${p}_${userId}`;
    const v = await admin.rpc("oauth_vault_read", { p_name: name });
    revoke[p] = v.error ? "not_confirmed" : await revokeAtGoogle(d, typeof v.data === "string" ? v.data : null);
    if (v.error) failures.push("read the stored Google access to revoke it");
  }
  for (const p of had) {
    const del = await admin.rpc("oauth_vault_delete", { p_name: `oauth_${p}_${userId}` });
    if (del.error) failures.push("delete the stored Google tokens");
  }
  if (had.length) {
    const del = await admin.from("user_oauth_connections").delete().eq("user_id", userId).in("provider", had);
    if (del.error) failures.push("delete the Google connection");
  }
  // The migration's trigger deletes these with the career row; deleting them here too means a disconnect does not depend on
  // the order the code and the migration were deployed in, and clears what a mail check left after the connection was gone.
  if (mailChecked) {
    for (const t of MAIL_TABLES) {
      const del = await admin.from(t).delete().eq("user_id", userId);
      if (del.error) failures.push(MAIL_SAID);
    }
  }
  // Read back what is left: the person is told what is true, not what was attempted.
  const left = await admin.from("user_oauth_connections").select("provider").eq("user_id", userId).in("provider", [...providers]);
  const mailAfter = mailChecked ? await mailLeft() : false;
  if (left.error || mailAfter === null) failures.push("check that everything was deleted");
  else {
    if ((left.data ?? []).length) failures.push("delete the Google connection");
    if (mailAfter) failures.push(MAIL_SAID);
  }
  for (const p of had) {
    const still = await admin.rpc("oauth_vault_read", { p_name: `oauth_${p}_${userId}` });
    if (still.error) failures.push("check that everything was deleted");
    else if (still.data) failures.push("delete the stored Google tokens");
  }
  return { ok: failures.length === 0, had, mailChecked, mailErased: mailBefore === true && mailAfter === false, revoke, failures: [...new Set(failures)] };
}

const PERMISSIONS = "myaccount.google.com/permissions";
// What Google said to the revoke, in plain words: confirmed only when Google answered 200 for every grant.
export function revokeWords(r: DisconnectResult): string {
  const outcomes = Object.values(r.revoke);
  return outcomes.length && outcomes.every((o) => o === "revoked")
    ? "Google confirmed Trainee's access is revoked."
    : `Google didn't confirm that Trainee's access is revoked, so please remove Trainee at ${PERMISSIONS} to be sure.`;
}
export function disconnectReply(r: DisconnectResult): string {
  if (!r.had.length && r.ok && !r.mailErased) return "No Google account is connected to Trainee, so there was nothing to disconnect.";
  if (!r.had.length && r.ok) return "No Google account is connected to Trainee, but I deleted the application updates, drafts and read time still saved from an earlier connection. Your application tracker and this chat keep their history.";
  const google = revokeWords(r);
  if (!r.ok) {
    return `I couldn't finish disconnecting Gmail: I wasn't able to ${r.failures.join(", or ")}. ${google} Say "disconnect gmail" again to retry.`;
  }
  const deleted = !r.mailChecked ? "I deleted the stored access."
    : r.mailErased ? "I deleted the stored access and the application updates I had read from your Gmail."
    : "I deleted the stored access. No application updates had been saved from your Gmail.";
  return `Gmail is disconnected. ${google} ${deleted} Your application tracker and this chat keep their history. Say "connect gmail" any time to connect it again.`;
}

// The chat's ask: "disconnect gmail", "disconnect my google account", "remove access to gmail", "revoke gmail".
export const GOOGLE_DISCONNECT_RE = /^\s*(?:please\s+)?(?:disconnect|unlink|revoke|remove)\s+(?:access\s+to\s+|trainee\s+from\s+)?(?:my\s+)?(?:gmail|google(?:\s+account)?|google\s+mail)\b[\s.!]*$/i;
// CONNECTOR SCENARIOS (2026-10-29): read by connector_words.ts (lead-ins, "remove gmail access", typos; never "remove Google").
export function isGoogleDisconnect(text: string): boolean {
  return disconnectOf(text) === "gmail";
}
