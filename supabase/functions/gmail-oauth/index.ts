// Upmore gmail-oauth edge function (2026-09-28; career grant added 2026-10-12, ACCS-001/002; Google verification
// changes 2026-10-26). Since the verification submission (docs/launch/GOOGLE-VERIFICATION-2026-10-26.md):
//   - a consent asks Google only for openid, email and gmail.readonly (career.ts requestScopesFor); gmail.send only once
//     the owner sets GOOGLE_APPROVED_EXTRA_SCOPES after Google approves it; Calendar never;
//   - the legacy read-only grant for Upmore's finance agent ("start") is off unless UPMORE_LEGACY_GMAIL_CONNECT=on;
//   - the career grant's callback lands on its own page, not the Upmore app; GOOGLE_OAUTH_REDIRECT_URI moves the callback
//     to Trainee's own domain;
//   - disconnect revokes at Google and deletes, checked and read back (_shared/google_disconnect.ts).
// Trainee's verified app needs its own Google Cloud client; the founder's shared client (the one Ring uses) must not be
// the one submitted.
//
// Routes:
//   POST {action:"start"}        (JWT) -> 410 unless UPMORE_LEGACY_GMAIL_CONNECT=on; then {url}, legacy consent,
//       gmail.readonly, stored as provider "gmail" / oauth_gmail_<uid>.
//   POST {action:"start_career"} (JWT) -> {url}  career consent: openid email gmail.readonly (send only once approved),
//       stored separately as provider "google_career" / oauth_google_career_<uid>. The signed state's purpose routes
//       the callback; the two grants never overwrite each other.
//   GET ?code=..&state=..                Google callback -> exchange, store
//       tokens in Supabase Vault under the purpose's name, upsert that
//       purpose's connection row, redirect to the app. Tokens NEVER touch
//       the client.
//   POST {action:"status"}       (JWT) -> legacy {connected, email} plus
//       per-source detail (gmail scope set, calendar connected, granted
//       scope list, connected email) — see career.ts buildStatus.
//   POST {action:"disconnect"}   (JWT) -> legacy behaviour (gmail row only).
//   POST {action:"disconnect", source}   per source: "gmail" | "calendar" |
//       "google_career"/"career" | "all" — see career.ts disconnectPlan for
//       the atomic-grant notes returned to the caller.
//
// Pure helpers (scopes, state, status, disconnect plans) live in ./career.ts
// so they are unit-tested without starting the server (tests/edge/gmail-oauth-career.test.ts).

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import {
  buildStatus,
  disconnectPlan,
  GMAIL_SCOPE,
  providerForPurpose,
  purposeForAction,
  vaultNameFor,
  verifyState,
  issueState,
  careerLanding,
  googleConsentUrl,
  LEGACY_OFF_MESSAGE,
  redirectUriFrom,
  requestScopesFor,
  startAllowed,
} from "./career.ts";
import { disconnectGoogle, disconnectReply } from "../_shared/google_disconnect.ts";
// Task 3 (2026-10-28): the connector framework. "connect gmail" from any channel sends a one-time link served here
// (GET ?t= peeks, a form POST is the person's tap, then Google's consent with this function's own signed state), so the
// OAuth client's redirect URI does not change; after a career grant is stored, the person is told in the chat the link
// came from and the tasks that waited for Gmail resume (_shared/connectors.ts).
import { afterConnect, handleConnectorLink, refusedConnect } from "../_shared/connectors.ts";
import { googleCallback, REPLAYED_WORDS, TAKEN_WORDS } from "../_shared/oauth_connect.ts";
import { chatThroughAgent, deliverer } from "../_shared/channel_runtime.ts";
import { connectLanding, connectPageOn } from "../_shared/connect_landing.ts";

// deno-lint-ignore no-explicit-any
const later = (p: Promise<unknown>) => { const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(p); };

// Google's consent URL for a purpose, with a state signed for this person (career.ts issueState) and only the scopes the
// verification submission allows (requestScopesFor).
async function consentUrlFor(userId: string, purpose: "gmail" | "career", clientId: string, stateSecret: string): Promise<string> {
  const state = await issueState(userId, purpose, stateSecret);
  const asked = requestScopesFor(purpose, Deno.env.get("GOOGLE_APPROVED_EXTRA_SCOPES"));
  return googleConsentUrl({ clientId, redirectUri: redirectUri(), state, scopes: asked.scopes });
}

const APP_URL = "https://upmore-srikanthvishnu90-sketchs-projects.vercel.app";
const ALLOWED_ORIGINS = new Set([
  APP_URL,
  "http://localhost:3000",
  "http://localhost:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:8080",
]);

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// Google verification (2026-10-26): GOOGLE_OAUTH_REDIRECT_URI routes the callback through Trainee's own verified domain.
function redirectUri(): string {
  return redirectUriFrom(Deno.env);
}

serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "";
    const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "";
    const stateSecret = Deno.env.get("OAUTH_STATE_SECRET") || "";

    // ---- Task 3: the one-time link "connect gmail" sends from any channel (no JWT: the hashed, once-only token is the
    // authentication; the consent's state is signed for the link's own person) ----
    const linked = await handleConnectorLink(req, {
      admin: createClient(supabaseUrl, serviceKey), env: Deno.env,
      consentUrl: async (userId) => (clientId && stateSecret ? await consentUrlFor(userId, "career", clientId, stateSecret) : null),
    });
    if (linked) return linked;

    // ---- Google callback (GET, no JWT — trust comes from signed state) ----
    const url = new URL(req.url);
    if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
      // Legacy landings keep the Upmore app's ?gmail=..; a career grant lands on careerLanding (career.ts).
      let purpose: "gmail" | "career" = "gmail";
      // The career (Trainee) grant lands on its own plain page, never on the Upmore app; the legacy grant keeps Upmore's.
      const doneBase = (ok: boolean) =>
        purpose === "career" ? careerLanding(ok) : Response.redirect(`${APP_URL}/#you?gmail=${ok ? "connected" : "error"}`, 302);
      // The connect page's calm done state ("Connected as <email>", a way back to Telegram) once the owner has switched that page on.
      let landEmail: string | null = null, denied = false;
      const done = (ok: boolean) => (purpose === "career" ? connectLanding(Deno.env, { provider: "google", ok, denied, email: landEmail }) : null) ?? doneBase(ok);
      try {
        if (url.searchParams.get("error")) {
          denied = url.searchParams.get("error") === "access_denied";
          // Which grant this was: the signed state says; an unreadable state is the legacy landing, as before.
          // Only with the connect page switched on: off, a denied consent lands exactly where it always did.
          if (connectPageOn(Deno.env)) try { purpose = (await verifyState(url.searchParams.get("state") || "", stateSecret)).purpose; } catch { /* legacy landing */ }
          return done(false);
        }
        const code = url.searchParams.get("code") || "";
        const state = url.searchParams.get("state") || "";
        const verified = await verifyState(state, stateSecret);
        purpose = verified.purpose;
        const userId = verified.userId;
        // A legacy consent started before the legacy path was switched off is not stored either.
        if (!startAllowed(purpose, Deno.env)) throw new Error("legacy Gmail connect is off");
        if (!clientId || !clientSecret) throw new Error("OAuth not configured");
        // CONNECTORS ROUND 3 (2026-10-31, _shared/oauth_connect.ts): the state is spent once, then the code exchanged; the
        // Vault entry and the row are written in one transaction holding the account. A gone account stores nothing (the new
        // grant is revoked at Google); an address another Trainee account holds stores nothing and is said plainly.
        const admin = createClient(supabaseUrl, serviceKey);
        // The Vault entry follows the state's purpose (oauth_connect_commit derives the same name from the provider).
        const provider = providerForPurpose(purpose) as "google_career" | "gmail";
        if (vaultNameFor(userId, purpose) !== `oauth_${provider}_${userId}`) throw new Error("vault name");
        const fallbackScopes = !purpose ? "" : requestScopesFor(purpose, Deno.env.get("GOOGLE_APPROVED_EXTRA_SCOPES")).scopes.join(" ");
        const got = await googleCallback({ admin, fetch, now: Date.now, clientId, clientSecret, redirectUri: redirectUri(),
          grantedFallback: () => fallbackScopes }, { code, state, userId, provider });
        landEmail = got.email ?? null;
        if (!got.ok) {
          console.error("[gmail-oauth] callback refused:", got.why);
          if (got.why === "taken" && purpose === "career") {
            await refusedConnect({ admin, env: Deno.env, fetch, now: Date.now, deliver: deliverer(admin, Deno.env), log: (l) => console.log(l) }, userId, "gmail", TAKEN_WORDS("Gmail", got.email ?? null)).catch(() => {});
          }
          if (purpose === "career" && (got.why === "taken" || got.why === "replayed")) return careerLanding(false, got.why === "taken" ? TAKEN_WORDS("Gmail", got.email ?? null) : REPLAYED_WORDS);
          return done(false);
        }
        const email = got.email;
        const grantedScopes = got.scopes;
        if (purpose === "career") {
          // Task 3: told where the link came from, then the tasks that waited for Gmail resume, after the response.
          const run = chatThroughAgent(supabaseUrl, serviceKey);
          const deliver = deliverer(admin, Deno.env);
          later(afterConnect({ admin, env: Deno.env, fetch, now: Date.now, deliver, log: (l) => console.log(l),
            runTurn: async (t) => ({ reply: (await run(t)).reply, persisted: true }) }, userId, "gmail", { email, scopes: grantedScopes.split(" ") })
            .catch((e) => console.error("[gmail-oauth] resume failed:", String((e as Error)?.message || e).slice(0, 120))));
        }
        return done(true);
      } catch (e) {
        console.error("[gmail-oauth] callback failed:", String((e as Error)?.message || e));
        return done(false);
      }
    }

    // ---- Authed JSON actions ----
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Sign in required" }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser(jwt);
    if (authErr || !user) return json({ error: "Invalid session" }, 401);
    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    const startPurpose = purposeForAction(action);
    if (startPurpose) {
      if (!startAllowed(startPurpose, Deno.env)) return json({ error: LEGACY_OFF_MESSAGE }, 410);
      if (!clientId) return json({ error: startPurpose === "career" ? "Google connect is not configured yet" : "Gmail connect is not configured yet" }, 503);
      const state = await issueState(user.id, startPurpose, stateSecret);
      // Only scopes in the Google verification submission (or approved since): never calendar, and gmail.send only once
      // the owner sets GOOGLE_APPROVED_EXTRA_SCOPES (career.ts requestScopesFor, in lockstep with _shared/google_scopes.ts);
      // openid + email so the userinfo call below can name the address.
      const asked = requestScopesFor(startPurpose, Deno.env.get("GOOGLE_APPROVED_EXTRA_SCOPES"));
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri(),
        response_type: "code",
        scope: asked.scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
      });
      return json({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString() });
    }

    if (action === "status") {
      const { data } = await admin.from("user_oauth_connections")
        .select("provider, email, scopes, connected_at").eq("user_id", user.id)
        .in("provider", ["gmail", "google_career"]);
      return json(buildStatus(data || []));
    }

    if (action === "disconnect") {
      // Google verification (2026-10-26): one implementation with the chat's "disconnect gmail" (_shared/google_disconnect.ts):
      // each grant revoked at Google (timeout, retries, only a 200 counts), its tokens and row deleted with every result
      // checked, then read back. A partial failure is ok:false with what is left, never ok:true.
      const plan = disconnectPlan(user.id, typeof body.source === "string" ? body.source : undefined);
      const r = await disconnectGoogle(admin, user.id, { fetch }, plan.providers);
      return json({
        ok: r.ok, disconnected: r.ok, source: plan.source, removed_providers: r.ok ? r.had : [],
        also_affects: plan.also_affects, note: plan.note, revoked_at_google: r.revoke, failures: r.failures, reply: disconnectReply(r),
      }, r.ok ? 200 : 500);
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// Re-exported for tests / future callers; GMAIL_SCOPE keeps its pre-career meaning (the legacy grant).
export { GMAIL_SCOPE };
