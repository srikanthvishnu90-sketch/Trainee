// Item 14 rulings (coordinator, 2026-11-10), end to end on Postgres 16: the connect page opened from a link (which may have been
// forwarded) names the account masked, never disconnects, even after Start was pressed from it, and tells the person the exact
// chat words; those exact words, sent to the REAL chat handler (agent-chat/handler-career.ts), disconnect Gmail. The page is the
// deployed one (trainee-connect handler over its deployed store, supabaseConnectDeps) and the chat is the deployed one, both over
// every migration in production order; the only seams are the HTTP hop to the project (tests/flow/postgrest.ts) and Google's revoke
// endpoint (a fake that records each request). Run: the gate runs it with CI=true; add --import-map=tests/flow/supabase-npm.json
// where esm.sh is unreachable.
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { connectPageToken, mintConnectToken } from "../../supabase/functions/_shared/connect_link.ts";
import { handleConnect } from "../../supabase/functions/trainee-connect/handler.ts";
import { supabaseConnectDeps } from "../../supabase/functions/trainee-connect/store.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const G = "7b0f8f8e-6a43-4a49-9d2c-0000000c14d1";
const ADDR = "ada.fictional@example.test";
const SECRET = "connect-link-secret-c14d-0123456789-abcdef";
const BASE = "https://trainee.example/connect", BOT_URL = "https://t.me/TraineeTestBot";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1";
const ENV: Record<string, string> = { TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_BOT_URL: BOT_URL, TRAINEE_CONNECT_BASE_URL: BASE,
  GOOGLE_OAUTH_CLIENT_ID: "client-id-c14d.apps.example", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-c14d-fixture", OAUTH_STATE_SECRET: "state-secret-c14d-0123456789-abcdef",
  SUPABASE_URL };
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const formsOf = (html: string) => [...html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => [x[1], x[2].replace(/&amp;/g, "&")])));

Deno.test({ name: "item 14: a link's page never disconnects (even after Start), and its exact chat words 'DISCONNECT GMAIL' disconnect through the real chat", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const pg: Pg = await startPg();
  const revoked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as string, init);
    if (req.url !== GOOGLE_REVOKE) return await real(input as never, init);
    revoked.push(await req.text());
    return new Response("", { status: 200 });
  }) as typeof fetch;
  let restore = () => {};
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into auth.users (id, email) values ('${G}', '${G}@example.test'); insert into public.profiles (id) values ('${G}');
      insert into public.career_watch_kv (user_id, key, value) values ('${G}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
      select public.oauth_vault_store('oauth_google_career_${G}', ${lit(JSON.stringify({ access_token: "at-c14d", refresh_token: "rt-c14d", expires_at: Date.parse("2027-01-01T00:00:00Z") }))});
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values
        ('${G}', 'google_career', 'oauth_google_career_${G}', '${ADDR}', 'openid email https://www.googleapis.com/auth/gmail.readonly');`);
    const handler = await careerHandler(pg, { "tok-c14d": G });
    restore = handler.restore;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false }, global: { fetch: handler.double.fetch as typeof fetch } });
    const NOW = Date.now();
    const d = supabaseConnectDeps(admin, { get: (k) => ENV[k] }, handler.double.fetch as typeof fetch, () => NOW);
    const rows = async () => Number(await pg.sql(`select count(*) from public.user_oauth_connections where user_id = '${G}'`));
    const jar = new Map<string, string>();
    const go = async (form?: Record<string, string>, path = "") => {
      const r = await handleConnect(new Request(`${BASE}${path}`, form
        ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: new URLSearchParams(form).toString() }
        : { headers: { "user-agent": BROWSER, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } }), d);
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const [k, ...v] = kv.split("="); if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v.join("=")); }
      return { r, html: r.status >= 300 && r.status < 400 ? "" : await r.text() };
    };

    // A forwarded link, opened by whoever has it: the account masked, no Disconnect, the chat's words
    const link = (await mintConnectToken({ secret: SECRET, userId: G, reason: "replies", channel: "telegram", now: NOW, kind: "l" }))!;
    // Architect amendment, security: link scanners (x-audit, coordinator ruling 2026-11-10): the GET draws the open page and
    // uses nothing up; its one button posts the link with the page token, which takes it.
    const shown = await go(undefined, `?t=${encodeURIComponent(link)}`);
    eq(shown.r.status, 200);
    eq((await go({ link: /name="link" value="([^"]+)"/.exec(shown.html)?.[1] ?? "", pt: /name="pt" value="([^"]+)"/.exec(shown.html)?.[1] ?? "" })).r.status, 303);
    const page = await go();
    eq(page.r.status, 200);
    const t = plain(page.html);
    assert(/Your email is connected/.test(t) && t.includes("Connected as a***@e***.test") && !page.html.includes(ADDR), `masked: ${t}`);
    const words = /Reply (DISCONNECT GMAIL) in your chat with Trainee to disconnect\./.exec(t)?.[1];
    eq(words, "DISCONNECT GMAIL", "the page names the exact chat words");
    assert(!formsOf(page.html).some((f) => f.action === "disconnect"), "no Disconnect form on a link's page");

    // ...and pressing Start from it (the browser now holds the started-consent cookie) still cannot disconnect
    // (the masked page draws no form at all; a post made anyway carries this browser's own page token, as its other pages draw it)
    const pageToken = (await connectPageToken(jar.get("tc_s") ?? "", SECRET))!;
    const start = await go({ t: pageToken, action: "start", provider: "google" });
    assert(start.r.status === 303 && /^https:\/\/accounts\.google\.com\//.test(start.r.headers.get("location") ?? ""), `Start goes to Google's own page (${start.r.status})`);
    assert(jar.has("tc_p"), "the started consent is remembered");
    for (const provider of ["google", "microsoft"]) {
      const forced = await go({ t: pageToken, action: "disconnect", provider });
      eq(forced.r.status, 403, `a disconnect posted after Start (${provider}) is refused`);
      assert(/Reply DISCONNECT (GMAIL|OUTLOOK) in your chat with Trainee to disconnect\./.test(plain(forced.html)) && /Nothing was changed\./.test(plain(forced.html)));
    }
    eq(await rows(), 1, "still connected");
    eq(revoked, [], "nothing sent to Google");

    // The exact words, in the person's chat, through the real handler: disconnected
    const r = await handler.chat("tok-c14d").say(words!);
    eq(r.status, 200, r.reply);
    eq([r.intent, r.resultStatus], ["career_google_disconnect", "completed"], r.reply);
    assert(/^Gmail is disconnected\./.test(r.reply), r.reply);
    eq(await rows(), 0, "the connection is gone");
    eq(revoked, ["token=rt-c14d"], "revoked at Google with its own refresh token, once");
    jar.delete("tc_p");
    assert(/<h1>Connect your email<\/h1>/.test((await go()).html), "the page then offers to connect again");
  } finally {
    restore();
    globalThis.fetch = real;
    await pg.stop();
  }
} });
