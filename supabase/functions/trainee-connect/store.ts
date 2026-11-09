// The connect page's store and connectors over Supabase: the framework's statuses and disconnect (_shared/connectors.ts), a
// consent URL per provider that records the link first (so the callback tells the person in the chat they came from, as the
// chat's own link does), and the single-use take of a link token id.
// deno-lint-ignore-file no-explicit-any
import { CONNECTORS, disconnectConnector, statuses, type ConnectorId, type Deps } from "../_shared/connectors.ts";
import { SEND_CONSENT_SCOPES } from "../_shared/google_scopes.ts"; // D-037: gmail.send only by the send consent
import { outlookConsentFor } from "../_shared/outlook_connector.ts";
import { SCOPES as MS_SCOPES } from "../_shared/outlook_graph.ts";
import { emailBind, googleConsentUrl, issueState, redirectUriFrom, requestScopesFor } from "../gmail-oauth/career.ts";
import type { ConnectDeps, ProviderId, ProviderInfo, ProviderState } from "./handler.ts";

const CONNECTOR: Record<ProviderId, ConnectorId> = { google: "gmail", microsoft: "outlook" };

// R10 WO-F (owner readiness review): the ONE table of what each provider's consent asks for, per purpose. The page (its intro,
// its permission rows and the exact scopes it lists) and the consent URL start() builds both read this, so the screen can
// never say less or more than the request. `connected`: a Gmail is already connected (D-037: a "send" link then asks only
// for gmail.send on top of it, bound to that account); with nothing connected every purpose is the plain connect.
// Microsoft: one consent for every purpose (outlook_graph.ts SCOPES, which authorizeUrl sends).
export function consentScopes(p: ProviderId, purpose: string, connected: boolean, env: { get(k: string): string | undefined }): string[] {
  if (p === "microsoft") return [...MS_SCOPES];
  if (purpose === "send" && connected) return [...SEND_CONSENT_SCOPES];
  return requestScopesFor("career", env.get("GOOGLE_APPROVED_EXTRA_SCOPES")).scopes;
}
const at = (ms: number) => new Date(ms).toISOString();
const must = (r: any, what: string) => { if (r?.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r?.data; };

export function supabaseConnectDeps(admin: any, env: { get(k: string): string | undefined }, f: typeof fetch = fetch, now: () => number = Date.now): ConnectDeps {
  const base: Deps = { admin, env, fetch: f, now };
  // What the page shows for a provider is what its consent URL asks for (consentScopes; never copy written on the page). The
  // page offers a consent only for a provider that is not connected, so it shows the not-connected request for the purpose.
  return {
    env, now,
    providers: (purpose = "replies") => ({
      google: { configured: CONNECTORS.gmail.wired(env), scopes: consentScopes("google", purpose, false, env) },
      microsoft: { configured: CONNECTORS.outlook.wired(env), scopes: consentScopes("microsoft", purpose, false, env) },
    } satisfies Record<ProviderId, ProviderInfo>),
    async status(userId) {
      const s = await statuses(base, userId);
      const out = {} as Record<ProviderId, ProviderState>;
      for (const p of ["google", "microsoft"] as ProviderId[]) {
        const x = s.find((y) => y.id === CONNECTOR[p])!;
        let state = x.state;
        // Google's refusal shows only when a token is asked for: ask (a refresh only if the token is about to expire).
        if (p === "google" && state === "connected") {
          const t = await CONNECTORS.gmail.token(base, userId, "read").catch(() => null);
          if (t?.status === "needs_reconnect") state = "needs_reconnect";
        }
        out[p] = { state, email: x.email };
      }
      return out;
    },
    async start(provider, userId, channel, reason) {
      if (provider === "microsoft") return await outlookConsentFor(admin, env, now(), { userId, channel });
      const clientId = env.get("GOOGLE_OAUTH_CLIENT_ID") || "", stateSecret = env.get("OAUTH_STATE_SECRET") || "";
      if (!clientId || !stateSecret) return null;
      const nonce = must(await admin.rpc("career_connector_link_issue", { p_user: userId, p_connector: "gmail", p_channel: channel, p_thread: null, p_now: at(now()) }), "make the Gmail link");
      const opened = must(await admin.rpc("career_connector_link_open", { p_nonce: String(nonce), p_now: at(now()) }), "open the Gmail link");
      if (!opened || opened.error) return null;
      // D-037: a link made for a send ("allow sending") asks for gmail.send on top of the existing grant, bound to the Google
      // account already connected (its address signed into the state, and named to Google as login_hint); the callback
      // refuses any other account. With no Gmail connected there is nothing to add to: the plain connect. Every other link
      // asks only for the submitted (verified) scopes and any the owner lists as approved.
      const held = reason === "send"
        ? must(await admin.from("user_oauth_connections").select("email").eq("user_id", userId).eq("provider", "google_career").maybeSingle(), "read the Gmail connection")
        : null;
      const bound = typeof held?.email === "string" && held.email.trim() ? held.email.trim() : null;
      const state = await issueState(userId, "career", stateSecret, now(), bound ? await emailBind(bound) : undefined);
      return googleConsentUrl({ clientId, redirectUri: redirectUriFrom(env), state,
        scopes: consentScopes("google", reason ?? "", !!bound, env), incremental: !!bound, ...(bound ? { loginHint: bound } : {}) });
    },
    async disconnect(provider, userId) {
      const r = await disconnectConnector(base, CONNECTORS[CONNECTOR[provider]], userId);
      return { ok: r.ok, reply: r.reply };
    },
    // A link token id is taken once: the insert's unique (user_id, key) refuses a second take. Any other error is surfaced, never treated as unused.
    async claimLink(u, jti, atMs) {
      const r = await admin.from("career_watch_kv").insert({ user_id: u, key: `tc:used:${jti}`, value: { at: at(atMs) }, updated_at: at(atMs) });
      if (!r.error) return true;
      if (r.error.code === "23505") return false;
      throw new Error(`claim link: ${r.error.message}`);
    },
    async userOfTelegram(telegramId) {
      const r = await admin.from("channel_contacts").select("user_id").eq("contact", `tg:${telegramId}`).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return r.data?.user_id ?? null;
    },
  };
}
