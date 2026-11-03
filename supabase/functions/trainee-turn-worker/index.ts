// trainee-turn-worker (ACK FAST, CHAT_QUEUE): runs the texts the chat webhooks queued. Logic and tests: ./handler.ts,
// tests/architect/ack-fast-queue.test.ts. Deploy with --no-verify-jwt (pg_cron and the webhooks carry no JWT):
// x-trainee-turn-secret = TRAINEE_TURN_SECRET (32+ characters) is the gate. Deployed only when that secret is set (trainee-go-live.sh GATED).
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { chatThroughAgent, deliverer } from "../_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../trainee-inbound/store.ts";
import { supabaseWorkerStore } from "../_shared/inbound_turn_queue.ts";
import { telegramCoreDeps } from "../trainee-telegram/handler.ts";
import { imessageCoreDeps } from "../trainee-inbound/handler.ts";
import { loopSend } from "../_shared/loopmessage.ts";
import { failedTurnNotice } from "../_shared/inbound_turn_queue.ts";
import { handleTurnWorker } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  return handleTurnWorker(req, {
    env: Deno.env, store: supabaseWorkerStore(admin, { maxInflight: Number(Deno.env.get("TURN_MAX_INFLIGHT")) >= 1 ? Math.floor(Number(Deno.env.get("TURN_MAX_INFLIGHT"))) : undefined }),
    notifyFailed: (msg) => failedTurnNotice(supabaseInboundStore(admin), msg, Date.now()),
    // deno-lint-ignore no-explicit-any
    background: (globalThis as any).EdgeRuntime?.waitUntil ? (p) => (globalThis as any).EdgeRuntime.waitUntil(p) : undefined,
    depsFor: (channel) => {
      const deliverNow = deliverer(admin, Deno.env);
      const deliver = (a: { userId: string; key: string; now: number }) => deliverNow({ userId: a.userId, key: a.key, now: a.now });
      if (channel === "telegram") return telegramCoreDeps({ env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(url, key, { channel: "telegram" }), admin, deliver });
      if (channel === "imessage") {
        const apiKey = Deno.env.get("LOOPMESSAGE_API_KEY") || "", secret = Deno.env.get("TRAINEE_INBOUND_SECRET") || "";
        if (!apiKey) return null;
        return imessageCoreDeps({ env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), send: (k) => loopSend({ apiKey: k }), chat: chatThroughAgent(url, key),
          deliverReply: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) }, apiKey, secret);
      }
      return null; // WhatsApp keeps running its turns inline (not queued by this change)
    },
  });
});
