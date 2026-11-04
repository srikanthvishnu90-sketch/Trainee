// trainee-telegram-link (FEATURE 16): Telegram's login, verified, links a chat to the signed-in person. Logic and tests:
// ./handler.ts, tests/architect/telegram-login-link.test.ts. Deployed with JWT verification on (the person's session).
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { handleTelegramLink } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleTelegramLink(req, {
    env: Deno.env, now: Date.now,
    userOf: async (jwt) => { const { data } = await admin.auth.getUser(jwt); return data?.user?.id ?? null; },
    rpc: async (name, args) => await admin.rpc(name, args),
  });
});
