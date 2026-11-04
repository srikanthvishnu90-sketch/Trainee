// career-essay-draft (WO-049): the extension card's "Draft from my facts". The signed-in person's own session only (the
// gateway verifies the JWT, verify_jwt = true in supabase/config.toml, and Supabase Auth reads the person from it, as
// agent-chat's handler-career.ts does); their facts are read here from their account, never from the request; the model
// is OpenAI only, through the gateway's callModel. Logic and tests: ../_shared/career_essay_card.ts,
// tests/architect/wo-049-essay-card.test.ts.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { corsFor } from "../agent-chat/_shared/chat_cors.ts";
import { callModel, newMeter } from "../_shared/model_gateway.ts";
import { essayModelConfig, handleEssayDraft, supabaseDraftCounter, supabaseFacts } from "../_shared/career_essay_card.ts";

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cors = corsFor(req);
  if (!url || !anon || !key) {
    return new Response(JSON.stringify({ ok: false, why: "model", message: "Drafting on the card isn't on yet. Answer this one in your own words." }), {
      status: 200, headers: { ...cors, "content-type": "application/json" },
    });
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const cfg = essayModelConfig(Deno.env);
  const meter = newMeter();
  return handleEssayDraft(req, {
    cors,
    // auth.getUser with the token passed explicitly: an edge function has no client session of its own.
    user: async (token) => {
      const client = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
      const { data } = await client.auth.getUser(token);
      return data?.user ? { id: data.user.id } : null;
    },
    card: () => ({
      facts: supabaseFacts(admin),
      model: (payload) => callModel(cfg, payload, { meter, role: "chat" }),
      counter: supabaseDraftCounter(admin),
      now: Date.now,
    }),
    // The draft's model spend, as the chat's drafts record theirs (no thread: the card is not a conversation).
    done: async (userId) => {
      if (!meter.calls) return;
      const { error } = await admin.from("agent_turn_costs").insert({ user_id: userId, thread_id: null, provider: meter.provider, models: meter.models, calls: meter.calls,
        failed: meter.failed, input_tokens: meter.input_tokens, output_tokens: meter.output_tokens, cached_tokens: meter.cached_tokens, usd_micros: meter.usd_micros, unpriced: meter.unpriced });
      if (error) console.error("essay card draft cost not recorded:", error.message);
    },
  });
});
