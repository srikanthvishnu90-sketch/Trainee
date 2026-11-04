// trainee-connect: the hosted account-connect page. Logic and tests: ./handler.ts, tests/architect/connect-page.test.ts.
// Deployed with verify_jwt = false: the signed, expiring, single-use token in the link (or Telegram's signed Mini App data) is the
// credential. Supabase serves an edge function's HTML as text/plain on its own domain, so people open it through the site's
// /connect rewrite (like /file). OAuth client ids and secrets are the owner's env vars and never leave the server.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { supabaseConnectDeps } from "./store.ts";
import { handleConnect } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("not configured", { status: 503 });
  return handleConnect(req, supabaseConnectDeps(createClient(url, key, { auth: { persistSession: false } }), Deno.env));
});
