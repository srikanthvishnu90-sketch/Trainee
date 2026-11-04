// ops-monitor: owner alerts and the daily digest. Logic and tests: ./handler.ts, tests/edge/ops-monitor.test.ts.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { supabaseFunnelSource } from "../_shared/ops_funnel.ts";
import { handleOps } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleOps(req, { env: Deno.env, admin, source: supabaseFunnelSource(admin) });
});
