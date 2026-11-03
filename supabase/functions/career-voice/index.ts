// career-voice (WO-035), switched OFF (owner directive 2026-11-02 18:38 CT: Claude-only, no OpenAI, voice stays off). "start"
// always answers NOT_WIRED ("voice is off: no provider") and mints nothing; "fallback" still moves the person to the text
// mock; "finish" is unreachable (no call token is ever issued). Logic and tests: ../_shared/career_voice.ts,
// tests/architect/wo-035-voice-mock.test.ts.
// Deploy with --no-verify-jwt: the page has no Upmore session; the signed, single-use, 10-minute link is the gate.
// CORS: the app's own origins only.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { corsFor } from "../agent-chat/_shared/chat_cors.ts";
import { deliverDue } from "../_shared/channel.ts";
import { supabaseChannelStore } from "../_shared/channel_store.ts";
import { loopSend } from "../_shared/loopmessage.ts";
import { handleVoice, supabaseVoiceSessions } from "../_shared/career_voice.ts";
import { DEFAULT_DAILY_CONTACTS } from "../trainee-deliver/handler.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cors = corsFor(req);
  if (!url || !key) {
    return new Response(JSON.stringify({ status: "NOT_WIRED", message: "Voice is not available." }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const loopKey = Deno.env.get("LOOPMESSAGE_API_KEY") || "";
  const cap = Number(Deno.env.get("LOOPMESSAGE_DAILY_CONTACTS") || DEFAULT_DAILY_CONTACTS);
  return handleVoice(req, {
    env: (k) => Deno.env.get(k),
    now: Date.now,
    cors,
    sessions: supabaseVoiceSessions(admin),
    // The debrief goes out now when the texting channel is wired; otherwise the scheduled delivery run sends it (each
    // minute). Either way the outbox keeps it once, under mock:<session id>.
    deliver: loopKey
      ? async (userId, outboxKey) => {
        const store = supabaseChannelStore(admin, { only: { userId, key: outboxKey } });
        await deliverDue({ store, send: loopSend({ apiKey: loopKey }), now: Date.now(), limit: 1, dailyContactCap: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_DAILY_CONTACTS });
        await store.release();
      }
      : undefined,
    log: (line) => console.log(line),
  });
});
