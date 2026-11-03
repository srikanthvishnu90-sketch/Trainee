// Task 3 (2026-10-28): the connector framework wired into the REAL career handler (agent-chat/handler-career.ts handleChat)
// on real Postgres with the real supabase-js client (tests/flow/handler.ts); the only seam is the HTTP hop to the Supabase
// project. A web turn is the person's own request; a channel turn is the bridge's (service key + as_user_id), exactly as
// Telegram, iMessage and WhatsApp call agent-chat. Outcome checks: the reply, its intent, and the rows written.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/connector-framework-handler.test.ts
// deno-lint-ignore-file no-explicit-any
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const PEOPLE: Record<string, string> = { "tok-w": "7b0f8f8e-6a43-4a49-9d2c-0000000007a1", "tok-t": "7b0f8f8e-6a43-4a49-9d2c-0000000007a2", "tok-i": "7b0f8f8e-6a43-4a49-9d2c-0000000007a3", "tok-h": "7b0f8f8e-6a43-4a49-9d2c-0000000007a4" };
const THREADS: Record<string, string> = { "tok-t": "7b0f8f8e-6a43-4a49-9d2c-0000000007b2", "tok-i": "7b0f8f8e-6a43-4a49-9d2c-0000000007b3", "tok-h": "7b0f8f8e-6a43-4a49-9d2c-0000000007b4" };
const CONTACT: Record<string, string> = { "tok-t": "tg:7700", "tok-i": "+15557770003", "tok-h": "wa:15557770004" };

Deno.test({ name: "Task 3 through the real handler: what's connected, ask once, on web and every channel", ignore: !pgBinDir() && !CI, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  for (const [k, v] of Object.entries({ MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client-0000", MICROSOFT_OAUTH_CLIENT_SECRET: "fake-ms-secret-0000", OAUTH_STATE_SECRET: "fake-state-secret-0000-xxxxxxxx", OUTLOOK_LINK_BASE: "https://proj.example.test/functions/v1/outlook-oauth" })) Deno.env.set(k, v);
  const pg = await startPg();
  await supabaseParity(pg);
  for (const [tok, u] of Object.entries(PEOPLE)) {
    await pg.sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test'); insert into public.profiles (id) values ('${u}');
      insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
      select public.oauth_vault_store('oauth_google_career_${u}', '{"access_token":"ya29.FAKEhandler","refresh_token":"1//FAKEhandler"}');
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${u}', 'google_career', 'oauth_google_career_${u}', 'me@gmail.example', 'openid email https://www.googleapis.com/auth/gmail.readonly');`);
    if (THREADS[tok]) await pg.sql(`insert into public.agent_threads (id, user_id) values ('${THREADS[tok]}', '${u}'); insert into public.channel_contacts (contact, user_id, thread_id) values ('${CONTACT[tok]}', '${u}', '${THREADS[tok]}');`);
  }
  // Google and Microsoft, faked: nothing leaves the test (the PostgREST double passes every other host to this fetch).
  const revoked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://oauth2.googleapis.com/revoke") { revoked.push(String(init?.body ?? "")); return new Response("", { status: 200 }); }
    if (/^https:\/\/(?:[a-z0-9-]+\.)*(?:google|googleapis|microsoft|microsoftonline|openai)\.com\//.test(url)) throw new Error(`a call left the test: ${url}`);
    return await real(input, init);
  }) as typeof fetch;
  const h = await careerHandler(pg, PEOPLE);
  // A channel turn, as the bridge sends it (channel_runtime.ts chatThroughAgent).
  const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
  const bridge = async (tok: string, message: string, key: string) => {
    const res = await handleChat(new Request(`${SUPABASE_URL}/functions/v1/agent-chat`, { method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ as_user_id: PEOPLE[tok], message, turn_key: key, thread_id: THREADS[tok] }) }));
    const body = await res.json().catch(() => ({}));
    return { status: res.status, reply: String(body?.reply ?? ""), intent: body?.meta?.intent ?? null, resultStatus: body?.meta?.result_status ?? null };
  };
  try {
    await t.step("\"what's connected\": the same plain answer on web, Telegram, iMessage and WhatsApp", async () => {
      const web = await h.chat("tok-w").say("what's connected?");
      eq([web.status, web.intent], [200, "career_connectors_status"], `web: ${web.reply}`);
      const expect = ["Here's what's connected to Trainee:",
        "Gmail: connected (me@gmail.example). I use it to read employers' replies and application codes (sender, subject and preview only).",
        'Outlook: not connected. Text "connect my outlook" to connect it.', 'Say "disconnect gmail" any time to remove it and what I read from it.'].join("\n");
      eq(web.reply, expect, "web");
      for (const tok of ["tok-t", "tok-i", "tok-h"]) {
        const r = await bridge(tok, "What's connected?", `wc-${tok}`);
        eq([r.status, r.intent, r.reply], [200, "career_connectors_status", expect], tok);
      }
    });
    await t.step("one ask, on Telegram: \"check my outlook\" asks once with the link; asking again keeps the task and sends no link", async () => {
      const a = await bridge("tok-t", "check my outlook", "co-1");
      eq([a.status, a.intent, a.resultStatus], [200, "career_connector_need", "asked"], a.reply);
      assert(/\?t=[A-Za-z0-9_-]{32}/.test(a.reply) && /Microsoft's sign-in may not work inside Telegram's own browser/.test(a.reply), a.reply);
      const b = await bridge("tok-t", "check my outlook", "co-2");
      eq([b.resultStatus, /\?t=/.test(b.reply)], ["waiting", false], b.reply);
      eq(await pg.sql(`select count(*) || ':' || min(channel) from public.career_outlook_links where user_id = '${PEOPLE["tok-t"]}'`), "1:telegram", "one link, bound to Telegram");
      eq(await pg.sql(`select count(*) || ':' || min(status) || ':' || min(channel) from public.career_parked_tasks where user_id = '${PEOPLE["tok-t"]}'`), "1:waiting:telegram", "one task, waiting, from Telegram");
    });
    await t.step("\"disconnect gmail\" through the handler is the framework's, with the Google disconnect's own intent", async () => {
      const r = await h.chat("tok-w").say("disconnect gmail");
      eq([r.status, r.intent], [200, "career_google_disconnect"], r.reply);
      eq(await pg.sql(`select count(*) from public.user_oauth_connections where user_id = '${PEOPLE["tok-w"]}'`), "0", "the row is gone");
      eq(revoked.length, 1, "revoked at (fake) Google once");
    });
  } finally { h.restore(); globalThis.fetch = real; await pg.stop(); }
});
