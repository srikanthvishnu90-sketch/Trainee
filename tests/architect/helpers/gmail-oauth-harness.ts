// The gmail-oauth wrapper harness (tests/architect/gmail-oauth-wrapper-ci.test.ts runs it in a subprocess with an import
// map that sends std's serve to ./capture-serve.ts). It imports the real supabase/functions/gmail-oauth/index.ts (every
// other import as the function has it), fakes Google and Supabase at fetch (any other host is refused), calls the handler
// the function served, and prints one JSON line: what each route answered and every host that was asked.
import { issueState } from "../../../supabase/functions/gmail-oauth/career.ts";

const USER = "00000000-0000-4000-8000-00000000a6c1", SECRET = "s".repeat(48);
const env: Record<string, string> = {
  SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-test-key", SUPABASE_ANON_KEY: "anon-test-key",
  GOOGLE_OAUTH_CLIENT_ID: "client-test.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-test", OAUTH_STATE_SECRET: SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: "https://trainee.test/functions/v1/gmail-oauth",
};
for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
for (const k of ["UPMORE_LEGACY_GMAIL_CONNECT", "GOOGLE_APPROVED_EXTRA_SCOPES", "TRAINEE_CONNECT_PAGE"]) Deno.env.delete(k);

const asked: string[] = [], rpcs: string[] = [];
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const u = new URL(req.url);
  asked.push(`${req.method} ${u.host}${u.pathname}`);
  if (u.host === "supabase.test") {
    if (u.pathname === "/auth/v1/user") return (req.headers.get("authorization") ?? "").endsWith("good-jwt") ? j({ id: USER, aud: "authenticated", email: "pat@example.test" }) : j({ message: "invalid JWT" }, 401);
    const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname)?.[1];
    if (rpc) {
      rpcs.push(rpc);
      if (rpc === "oauth_state_use") return j(true);
      if (rpc === "oauth_connect_commit") return j("connected");
      if (rpc === "career_connector_link_peek") return j({ status: "ok", hint: null });
      if (rpc === "career_connector_link_open") return j({ user_id: USER });
      return j({ message: `no ${rpc} here` }, 404);
    }
    if (u.pathname === "/rest/v1/user_oauth_connections") return j([{ provider: "google_career", email: "pat@example.test", scopes: "openid email https://www.googleapis.com/auth/gmail.readonly", connected_at: "2026-11-10T00:00:00Z" }]);
    return j({ message: "not faked" }, 404);
  }
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
    const form = new URLSearchParams(await req.text());
    if (form.get("code") !== "google-code" || form.get("client_secret") !== env.GOOGLE_OAUTH_CLIENT_SECRET || form.get("redirect_uri") !== env.GOOGLE_OAUTH_REDIRECT_URI) return j({ error: "invalid_grant" }, 400);
    return j({ access_token: "ya29.test", refresh_token: "1//test", expires_in: 3599, scope: "openid email https://www.googleapis.com/auth/gmail.readonly", token_type: "Bearer" });
  }
  if (u.host === "www.googleapis.com" && u.pathname === "/oauth2/v2/userinfo") return j({ email: "pat@example.test", verified_email: true });
  throw new TypeError(`network refused in the harness: ${u.host}`);
}) as typeof fetch;

await import("../../../supabase/functions/gmail-oauth/index.ts");
// deno-lint-ignore no-explicit-any
const handler = (globalThis as any).__gmailOauthHandler as ((req: Request) => Promise<Response>) | undefined;
const out: Record<string, unknown> = { served: typeof handler === "function" };
if (handler) {
  const base = "https://trainee.test/functions/v1/gmail-oauth";
  const call = async (name: string, req: Request) => {
    const r = await handler(req);
    const text = await r.text();
    out[name] = { status: r.status, location: r.headers.get("location"), type: r.headers.get("content-type"), cors: r.headers.get("access-control-allow-origin"), body: text.slice(0, 20000) };
  };
  const post = (body: unknown, jwt?: string) => new Request(base, { method: "POST", headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) });
  await call("options", new Request(base, { method: "OPTIONS", headers: { Origin: "http://localhost:8000" } }));
  await call("no_jwt", post({ action: "status" }));
  await call("bad_jwt", post({ action: "status" }, "bad-jwt"));
  await call("start_legacy", post({ action: "start" }, "good-jwt"));
  await call("start_career", post({ action: "start_career" }, "good-jwt"));
  await call("status", post({ action: "status" }, "good-jwt"));
  await call("unknown", post({ action: "nope" }, "good-jwt"));
  await call("link_peek", new Request(`${base}?t=nonce-test`));
  await call("link_open", new Request(base, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "t=nonce-test" }));
  await call("denied", new Request(`${base}?error=access_denied&state=x`));
  await call("bad_state", new Request(`${base}?code=google-code&state=forged`));
  const state = await issueState(USER, "career", SECRET);
  await call("callback", new Request(`${base}?code=google-code&state=${encodeURIComponent(state)}`));
}
await new Promise((r) => setTimeout(r, 300)); // the resume after a connect runs after the response (EdgeRuntime absent here)
out.asked = [...new Set(asked)];
out.rpcs = rpcs;
void realFetch;
console.log("HARNESS " + JSON.stringify(out));
Deno.exit(0);
