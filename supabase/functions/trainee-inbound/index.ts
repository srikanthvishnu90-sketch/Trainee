// trainee-inbound (WO-013b-2): LoopMessage's inbound webhook (iMessage). Logic and tests: ./handler.ts,
// tests/edge/channel-inbound.test.ts. WhatsApp and Telegram have their own webhooks (trainee-whatsapp, trainee-telegram)
// over the same core (_shared/channel_inbound.ts).
// Deploy with --no-verify-jwt: LoopMessage cannot send an Authorization header; the 32+ character secret is the gate.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { loopSend } from "../_shared/loopmessage.ts";
import { chatThroughAgent, deliverer } from "../_shared/channel_runtime.ts";
import { handleInbound } from "./handler.ts";
import { supabaseInboundStore } from "./store.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const deliverNow = deliverer(admin, Deno.env);
  return handleInbound(req, {
    env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), send: (apiKey) => loopSend({ apiKey }),
    // CHANNEL PARITY (2026-11-05): each webhook names its channel, as Telegram's does (connect links, the readiness ask).
    chat: chatThroughAgent(url, key, { channel: "imessage" }),
    // The answer, or a link question to another channel, through whichever adapters are wired.
    deliverReply: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }),
  });
});
