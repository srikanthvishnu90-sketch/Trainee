// trainee-telegram-link (FEATURE 16, owner decision 2026-10-26): the web side of "Link your Trainee account". Telegram's
// login_url button opens the web page (telegram-link.html) with Telegram's signed fields; the page, signed in as the
// person, posts them here. This verifies Telegram's hash with the bot token and the sign-in's age
// (_shared/telegram_login.ts), then links that Telegram user to this person once (channel_telegram_link_as: a replay,
// a Telegram user already on another account, or an account already holding another Telegram user is refused). It also
// unlinks. The person is whoever the request's own session is; the body never names an account.
import { LOGIN_REPLY, verifyTelegramLogin } from "../_shared/telegram_login.ts";

export interface LinkDeps {
  env: { get(k: string): string | undefined };
  now: () => number;
  userOf: (jwt: string) => Promise<string | null>; // the signed-in person, from their own session token
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
}
const json = (body: unknown, status = 200, cors: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

export async function handleTelegramLink(req: Request, d: LinkDeps): Promise<Response> {
  const origin = d.env.get("TRAINEE_WEB_ORIGIN") || "";
  const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type, apikey", "access-control-allow-methods": "POST, OPTIONS", vary: "origin" } : {};
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
  const say = (outcome: string, status = 200, extra: Record<string, unknown> = {}) => json({ outcome, reply: LOGIN_REPLY[outcome] ?? LOGIN_REPLY.failed, ...extra }, status, cors);
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const user = jwt ? await d.userOf(jwt).catch(() => null) : null;
  if (!user) return say("signed_out", 401);
  const body = await req.json().catch(() => null) as { action?: unknown; auth?: unknown } | null;
  if (body?.action === "unlink") {
    const r = await d.rpc("channel_telegram_unlink_as", { p_user: user, p_now: new Date(d.now()).toISOString() });
    if (r.error) return say("failed", 503);
    return say(Number(r.data) < 0 ? "channel_only" : Number(r.data) > 0 ? "unlinked" : "not_linked", Number(r.data) < 0 ? 409 : 200);
  }
  if (body?.action !== "link" || !body.auth || typeof body.auth !== "object") return say("missing", 400);
  const token = d.env.get("TELEGRAM_BOT_TOKEN") || "";
  const v = await verifyTelegramLogin(body.auth as Record<string, unknown>, token, d.now());
  if (!v.ok) return say(v.why, v.why === "not_configured" ? 503 : 400);
  const r = await d.rpc("channel_telegram_link_as", { p_user: user, p_telegram_id: v.telegramId, p_hash: v.hash, p_auth_date: new Date(v.authDate * 1000).toISOString(), p_now: new Date(d.now()).toISOString() });
  if (r.error || !r.data || typeof r.data !== "object") return say("failed", 503);
  if (typeof r.data.error === "string") return say(r.data.error, 409);
  return say(r.data.outcome === "already" ? "already" : "linked", 200, { telegram_id: v.telegramId });
}
