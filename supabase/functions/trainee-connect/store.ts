// The connect page's store and connectors over Supabase: the framework's statuses and disconnect (_shared/connectors.ts), a
// consent URL per provider that records the link first (so the callback tells the person in the chat they came from, as the
// chat's own link does), and the single-use take of a link token id.
// deno-lint-ignore-file no-explicit-any
import { CONNECTORS, disconnectConnector, statuses, type ConnectorId, type Deps } from "../_shared/connectors.ts";
import { outlookConsentFor } from "../_shared/outlook_connector.ts";
import { SCOPES as MS_SCOPES } from "../_shared/outlook_graph.ts";
import { googleConsentUrl, issueState, redirectUriFrom, requestScopesFor } from "../gmail-oauth/career.ts";
import type { ConnectDeps, ProviderId, ProviderInfo, ProviderState } from "./handler.ts";

const CONNECTOR: Record<ProviderId, ConnectorId> = { google: "gmail", microsoft: "outlook" };
const at = (ms: number) => new Date(ms).toISOString();
const must = (r: any, what: string) => { if (r?.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r?.data; };

export function supabaseConnectDeps(admin: any, env: { get(k: string): string | undefined }, f: typeof fetch = fetch, now: () => number = Date.now): ConnectDeps {
  const base: Deps = { admin, env, fetch: f, now };
  // The scopes each consent URL asks for, from the code that builds it (never copy written on the page).
  const googleScopes = () => requestScopesFor("career", env.get("GOOGLE_APPROVED_EXTRA_SCOPES")).scopes;
  return {
    env, now,
    providers: () => ({
      google: { configured: CONNECTORS.gmail.wired(env), scopes: googleScopes() },
      microsoft: { configured: CONNECTORS.outlook.wired(env), scopes: [...MS_SCOPES] },
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
    async start(provider, userId, channel) {
      if (provider === "microsoft") return await outlookConsentFor(admin, env, now(), { userId, channel });
      const clientId = env.get("GOOGLE_OAUTH_CLIENT_ID") || "", stateSecret = env.get("OAUTH_STATE_SECRET") || "";
      if (!clientId || !stateSecret) return null;
      const nonce = must(await admin.rpc("career_connector_link_issue", { p_user: userId, p_connector: "gmail", p_channel: channel, p_thread: null, p_now: at(now()) }), "make the Gmail link");
      const opened = must(await admin.rpc("career_connector_link_open", { p_nonce: String(nonce), p_now: at(now()) }), "open the Gmail link");
      if (!opened || opened.error) return null;
      return googleConsentUrl({ clientId, redirectUri: redirectUriFrom(env), state: await issueState(userId, "career", stateSecret), scopes: googleScopes() });
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
