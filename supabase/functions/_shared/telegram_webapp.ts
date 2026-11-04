// Telegram Mini App login: the page is opened by a web_app button and Telegram hands it signed initData (in the URL hash as
// tgWebAppData). Documented algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
// data-check string = every field except `hash`, sorted by name, "name=value" joined by "\n"; secret = HMAC-SHA-256(key
// "WebAppData", message bot token); hash = hex HMAC-SHA-256(key secret, message data-check string). Taken only when the hash
// matches (constant time) and auth_date is at most MAX_AGE_S old and not in the future. The user is `user.id`.
export const INITDATA_MAX_AGE_S = 3600;
export type InitCheck =
  | { ok: true; telegramId: string; authDate: number }
  | { ok: false; why: "missing" | "bad_hash" | "stale" | "future" | "not_configured" };
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function initDataHash(raw: string, botToken: string): Promise<string> {
  const p = new URLSearchParams(raw);
  const check = [...p.entries()].filter(([k]) => k !== "hash").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  return hex(await hmac(await hmac(enc.encode("WebAppData"), botToken), check));
}
export async function verifyInitData(raw: unknown, botToken: string | undefined, nowMs: number, maxAgeS = INITDATA_MAX_AGE_S): Promise<InitCheck> {
  if (!botToken) return { ok: false, why: "not_configured" };
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 4096) return { ok: false, why: "missing" };
  const p = new URLSearchParams(raw);
  const hash = p.get("hash") ?? "", auth = p.get("auth_date") ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash) || !/^[0-9]{1,12}$/.test(auth)) return { ok: false, why: "missing" };
  if (!same(await initDataHash(raw, botToken), hash)) return { ok: false, why: "bad_hash" };
  const authDate = Number(auth), now = Math.floor(nowMs / 1000);
  if (authDate > now + 60) return { ok: false, why: "future" };
  if (now - authDate > maxAgeS) return { ok: false, why: "stale" };
  let id = "";
  try { id = String(JSON.parse(p.get("user") ?? "{}").id ?? ""); } catch { /* no user */ }
  if (!/^[1-9][0-9]{0,19}$/.test(id)) return { ok: false, why: "missing" };
  return { ok: true, telegramId: id, authDate };
}
