// trainee-deliver (WO-013b-1; every channel since WO-038): the every-minute delivery run. Logic and tests: ./handler.ts,
// tests/edge/channel-delivery.test.ts, tests/architect/wo-038-channels.test.ts.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { supabaseChannelStore } from "../_shared/channel_store.ts";
import { loopSend } from "../_shared/loopmessage.ts";
import { adaptersFromEnv } from "../_shared/channel_registry.ts";
import { telegramPacerFromEnv } from "../_shared/channel_pacer.ts";
import { fileCardsFor } from "../_shared/channel_runtime.ts";
import { handleDeliver } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleDeliver(req, {
    env: Deno.env, now: Date.now, store: (so) => supabaseChannelStore(admin, { lanes: (Deno.env.get("DELIVER_LANES") || "").toLowerCase() !== "off", shard: so?.shard }), send: (apiKey) => loopSend({ apiKey }),
    adapters: (env) => adaptersFromEnv(env, { sharedPace: telegramPacerFromEnv(env, admin), fileCards: fileCardsFor(admin, env, Date.now) }),
    recordRun: async (r) => {
      const { error } = await admin.from("channel_delivery_runs").insert({ run_at: r.at, delivered: r.delivered, failed: r.failed, retried: r.retried, skipped_opt_out: r.skipped_opt_out,
        capped: r.capped, swept: r.swept, ms: r.ms, error: r.error, held: r.held ?? 0, nudged: r.nudged ?? 0, not_wired: r.not_wired ?? 0 });
      if (error) throw new Error(`record run: ${error.message}`);
    },
  });
});
