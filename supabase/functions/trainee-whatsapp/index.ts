// trainee-whatsapp (WO-038): the WhatsApp Cloud API webhook. Logic and tests: ./handler.ts, tests/architect/wo-038-channels.test.ts.
// Deploy with --no-verify-jwt: Meta sends no Authorization header; the verify token (GET) and the app secret's signature
// (POST) are the gate.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { chatThroughAgent, deliverer } from "../_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../trainee-inbound/store.ts";
import { handleWhatsApp } from "./handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const deliverNow = deliverer(admin, Deno.env);
  return handleWhatsApp(req, {
    // CHANNEL PARITY (2026-11-05): each webhook names its channel, as Telegram's does (connect links, the readiness ask).
    env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(url, key, { channel: "whatsapp" }),
    // Everything due for the person, oldest first: what waited for the window goes out before the answer.
    deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now, wholeUser: true }),
  });
});
