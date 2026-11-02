// trainee-telegram (WO-038): Telegram's webhook. Logic and tests: ./handler.ts, tests/architect/wo-038-channels.test.ts.
// Deploy with --no-verify-jwt: Telegram sends no Authorization header; X-Telegram-Bot-Api-Secret-Token is the gate.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { chatThroughAgent, deliverer } from "../_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../trainee-inbound/store.ts";
import { handleTelegram } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const deliverNow = deliverer(admin, Deno.env); // one per request: the parts of a reply share Telegram's pacing
  return handleTelegram(req, {
    env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(url, key, { channel: "telegram" }), admin, // REPLY SHAPE: agent-chat shapes Telegram replies only; // FEATURE 16: files and card buttons
    deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now, ...(a.replyTo ? { replyTo: a.replyTo } : {}) }),
  });
});
