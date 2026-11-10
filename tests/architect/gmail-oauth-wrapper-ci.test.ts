// The gmail-oauth HTTP wrapper (supabase/functions/gmail-oauth/index.ts), CI only (s-release, 2026-11-10). Its pure parts are
// unit-tested (career.ts, _shared/oauth_connect.ts, _shared/connectors.ts), but the glue that serves them was never run: the
// agent sandboxes cannot import it (deno.land and cdn.jsdelivr.net are blocked there), so in CI this imports the real file and
// drives its handler end to end with a fake Google and a fake Supabase at fetch, every other host refused:
//   the std module it serves with resolves and exports serve; the function serves a handler; CORS answers only an allowed
//   origin; no or a bad sign-in is 401; the legacy grant is 410 (off); the career consent asks Google for exactly openid,
//   email and gmail.readonly (never calendar, no send without approval) with a state, this client and the verified
//   redirect; status reads the person's connection; the one-time chat link peeks and opens to Google's consent; a declined
//   consent and a forged state store nothing; a real callback spends the state, exchanges the code at Google, reads the
//   address, commits the grant, and lands on "Gmail connected"; no host but the fakes was asked.
// The harness runs in a subprocess whose import map sends only std's serve to tests/architect/helpers/capture-serve.ts
// (it keeps the handler instead of listening); every other import is the function's own.
// Locally (agent sandboxes): NOT_RUN, unless GMAIL_OAUTH_HARNESS_LOCAL=1, which also maps the two blocked CDNs to npm.
// Run: deno test -A --no-check tests/architect/gmail-oauth-wrapper-ci.test.ts
import assertNode from "node:assert/strict";

const CI = Deno.env.get("CI") === "true";
const LOCAL = Deno.env.get("GMAIL_OAUTH_HARNESS_LOCAL") === "1";
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
const STD_SERVE = "https://deno.land/std@0.208.0/http/server.ts";
const here = new URL(".", import.meta.url);

Deno.test({ name: "gmail-oauth wrapper: the real index.ts imported and served, every route end to end with a fake Google", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!CI && !LOCAL) { console.log("NOT_RUN locally: deno.land and cdn.jsdelivr.net are blocked in the sandboxes; CI runs it"); return; }
  if (CI) {
    const std = await import(STD_SERVE);
    eq(typeof std.serve, "function", "the std module index.ts serves with resolves and exports serve");
  }
  const dir = await Deno.makeTempDir({ prefix: "gmail-oauth-harness-" });
  try {
    const imports: Record<string, string> = { [STD_SERVE]: new URL("helpers/capture-serve.ts", here).href };
    if (LOCAL) {
      imports["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm"] = "npm:@supabase/supabase-js@2.117.1";
      imports["https://esm.sh/@supabase/supabase-js@2.117.1"] = "npm:@supabase/supabase-js@2.117.1";
    }
    const map = `${dir}/import-map.json`;
    await Deno.writeTextFile(map, JSON.stringify({ imports }));
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", `--import-map=${map}`, new URL("helpers/gmail-oauth-harness.ts", here).pathname],
      stdout: "piped", stderr: "piped", env: { NO_COLOR: "1" },
    }).output();
    const stdout = new TextDecoder().decode(run.stdout), stderr = new TextDecoder().decode(run.stderr);
    const line = stdout.split("\n").find((l) => l.startsWith("HARNESS "));
    if (!line) throw new Error(`the harness printed no result (exit ${run.code}):\n${stderr.slice(-3000)}\n${stdout.slice(-2000)}`);
    // deno-lint-ignore no-explicit-any
    const r: any = JSON.parse(line.slice(8));
    ok(r.served, "index.ts served a handler");
    eq([r.options.status, r.options.cors], [200, "http://localhost:8000"], "CORS preflight answers an allowed origin");
    eq(r.no_jwt.status, 401, "no sign-in: 401");
    eq(r.bad_jwt.status, 401, "a sign-in Supabase refuses: 401");
    eq(r.start_legacy.status, 410, "the legacy finance grant is off: 410");
    eq(r.start_career.status, 200, "the career consent starts");
    const consent = new URL(JSON.parse(r.start_career.body).url);
    eq(consent.origin + consent.pathname, "https://accounts.google.com/o/oauth2/v2/auth", "to Google's consent");
    eq(consent.searchParams.get("client_id"), "client-test.apps.googleusercontent.com", "with this client");
    eq(consent.searchParams.get("redirect_uri"), "https://trainee.test/functions/v1/gmail-oauth", "and the verified redirect");
    eq(consent.searchParams.get("scope")!.split(" ").sort(), ["email", "https://www.googleapis.com/auth/gmail.readonly", "openid"], "only openid, email and gmail.readonly");
    ok((consent.searchParams.get("state") ?? "").length > 20, "with a signed state");
    eq(r.status.status, 200, "status answers");
    ok(/google_career|pat@example\.test/.test(r.status.body), `status reads the person's connection: ${r.status.body.slice(0, 200)}`);
    eq(r.unknown.status, 400, "an unknown action: 400");
    eq(r.link_peek.status, 200, "the chat's one-time link shows its page");
    ok(/Connect Gmail to Trainee/.test(r.link_peek.body), "naming what it connects");
    eq(r.link_open.status, 303, "the person's tap opens Google's consent");
    ok(String(r.link_open.location).startsWith("https://accounts.google.com/o/oauth2/v2/auth?"), `to Google: ${r.link_open.location}`);
    ok(r.denied.status >= 300, `a declined consent stores nothing and lands (${r.denied.status})`);
    eq(r.bad_state.status === 200, false, "a forged state stores nothing");
    eq(r.callback.status, 200, "a real callback lands");
    ok(/Gmail connected/.test(r.callback.body), "on \"Gmail connected\"");
    ok(r.rpcs.includes("oauth_state_use") && r.rpcs.includes("oauth_connect_commit"), `the state is spent and the grant committed: ${r.rpcs.join(", ")}`);
    ok(r.rpcs.indexOf("oauth_state_use") < r.rpcs.indexOf("oauth_connect_commit"), "the state is spent before the grant is stored");
    ok(r.asked.includes("POST oauth2.googleapis.com/token") && r.asked.includes("GET www.googleapis.com/oauth2/v2/userinfo"), "the code exchanged at Google and the address read");
    const hosts = new Set(r.asked.map((a: string) => a.split(" ")[1].split("/")[0]));
    ok([...hosts].every((h) => ["supabase.test", "oauth2.googleapis.com", "www.googleapis.com"].includes(h as string)), `no host but the fakes: ${[...hosts].join(", ")}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
} });
