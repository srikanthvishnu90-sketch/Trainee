// M4 (2026-10-27): Outlook connect from any channel. The link "connect my outlook" sends (GET peeks, POST goes to Microsoft
// with PKCE), Microsoft's redirect back (GET ?state&code), and the leased batch run (POST JSON with x-outlook-jobs-secret).
// Public by necessity (verify_jwt = false, deployed by go-live with --no-verify-jwt): the one-time token, the signed state
// and the jobs secret are the authentication (_shared/outlook_connector.ts). Its URL is the Azure app's redirect URI:
// <SUPABASE_URL>/functions/v1/outlook-oauth.
// Task 3 (2026-10-28): once connected, the tasks that waited for Outlook resume (_shared/connectors.ts afterConnect), after
// the response, each re-run as the person through agent-chat with a stable turn key.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { handleOutlookOAuth } from "../_shared/outlook_connector.ts";
import { chatThroughAgent, deliverer } from "../_shared/channel_runtime.ts";
import { afterConnect } from "../_shared/connectors.ts";
import { connectLanding } from "../_shared/connect_landing.ts";

// deno-lint-ignore no-explicit-any
const later = (p: Promise<unknown>) => { const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(p); return Promise.resolve(); };

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, key);
  const deliver = deliverer(admin, Deno.env);
  const log = (l: string) => console.log(l);
  const run = chatThroughAgent(url, key);
  return handleOutlookOAuth(req, {
    admin, env: Deno.env, fetch, deliver, log,
    landing: (o) => connectLanding(Deno.env, { provider: "microsoft", ...o }),
    afterConnect: (a) => later(afterConnect({ admin, env: Deno.env, fetch, now: Date.now, deliver, log,
      runTurn: async (t) => ({ reply: (await run(t)).reply, persisted: true }) }, a.userId, "outlook", a).catch((e) => log(`outlook-oauth: resume: ${String(e?.message ?? e).slice(0, 120)}`))),
  });
});
