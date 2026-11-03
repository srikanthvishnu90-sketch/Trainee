// FEATURE 16 (owner decision, 2026-10-26, in writing): a Telegram chat is linked to a Trainee account with Telegram's own
// login (the login_url button / Login Widget), never with a code typed into the chat.
//
// Telegram signs what it tells the web page (https://core.telegram.org/widgets/login#checking-authorization, ASSUMED from
// the documented algorithm; the official page did not load from the build environment): the fields it sends (id,
// first_name, last_name, username, photo_url, auth_date) except `hash`, sorted by name, as "name=value" lines joined by
// "\n", are the data-check string; `hash` is the hex HMAC-SHA-256 of that string keyed with SHA-256(bot token). A payload
// is taken only when the hash matches (compared in constant time) and auth_date is at most LOGIN_MAX_AGE_S old and not in
// the future. The database then takes each signed payload once (channel_telegram_link_as, the replay refusal).
export const LOGIN_MAX_AGE_S = 600; // ten minutes from Telegram's sign-in to the link
const FIELDS = new Set(["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"]);

export type LoginCheck =
  | { ok: true; telegramId: string; authDate: number; hash: string; name: string }
  | { ok: false; why: "missing" | "bad_hash" | "stale" | "future" | "not_configured" };

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function loginHash(fields: Record<string, string>, botToken: string): Promise<string> {
  const check = Object.keys(fields).filter((k) => k !== "hash").sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", enc.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(check)));
}

// `raw`: the query the login_url opened the page with (or the widget's object), as given. Unknown fields are not signed
// by Telegram's algorithm here, so a payload carrying one is refused rather than checked over fields it never signed.
export async function verifyTelegramLogin(raw: Record<string, unknown>, botToken: string, nowMs: number, maxAgeS = LOGIN_MAX_AGE_S): Promise<LoginCheck> {
  if (!botToken) return { ok: false, why: "not_configured" };
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (!FIELDS.has(k) || (typeof v !== "string" && typeof v !== "number")) return { ok: false, why: "missing" };
    fields[k] = String(v);
  }
  if (!/^[1-9][0-9]{0,19}$/.test(fields.id ?? "") || !/^[0-9]{1,12}$/.test(fields.auth_date ?? "") || !/^[0-9a-f]{64}$/.test(fields.hash ?? "")) {
    return { ok: false, why: "missing" };
  }
  if (!sameHex(await loginHash(fields, botToken), fields.hash)) return { ok: false, why: "bad_hash" };
  const authDate = Number(fields.auth_date), now = Math.floor(nowMs / 1000);
  if (authDate > now + 60) return { ok: false, why: "future" };
  if (now - authDate > maxAgeS) return { ok: false, why: "stale" };
  return { ok: true, telegramId: fields.id, authDate, hash: fields.hash, name: [fields.first_name, fields.last_name].filter(Boolean).join(" ") };
}

// What the person reads, by outcome.
export const LOGIN_REPLY: Record<string, string> = {
  linked: "Telegram is linked to your Trainee account. Text Trainee there any time.",
  already: "This Telegram account is already linked to your Trainee account. Nothing changed.",
  unlinked: "Telegram is unlinked from your Trainee account. Nothing from that chat reaches your account now.",
  channel_only: "This Trainee account is its Telegram chat, so it can't be unlinked. Nothing changed.",
  not_linked: "No Telegram account is linked to your Trainee account, so there was nothing to unlink.",
  missing: "That sign-in from Telegram is incomplete, so nothing was linked. Tap \"Link your Trainee account\" in Telegram again.",
  bad_hash: "That sign-in could not be verified as coming from Telegram, so nothing was linked. Tap \"Link your Trainee account\" in Telegram again.",
  stale: "That sign-in from Telegram is more than 10 minutes old, so nothing was linked. Tap \"Link your Trainee account\" in Telegram again.",
  future: "That sign-in from Telegram is dated in the future, so nothing was linked. Tap \"Link your Trainee account\" in Telegram again.",
  replay: "That sign-in from Telegram was already used, so nothing changed. Tap \"Link your Trainee account\" in Telegram for a new one.",
  linked_elsewhere: "This Telegram account is already linked to a different Trainee account, so nothing changed. Unlink it there first.",
  account_has_other: "Your Trainee account is already linked to a different Telegram account. Unlink that one first, then link this one.",
  not_configured: "Linking Telegram isn't set up on Trainee's side yet, so nothing was linked.",
  signed_out: "Sign in to Trainee in this browser first, then tap \"Link your Trainee account\" in Telegram again.",
  failed: "Nothing was linked: Trainee couldn't save it just now. Tap the button in Telegram again in a minute.",
};
