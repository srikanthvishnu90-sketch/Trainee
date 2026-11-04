// Upmore stripe-webhook Edge Function: Stripe's events for the subscription. No JWT (Stripe calls this).
// The logic is supabase/functions/_shared/stripe_webhook.ts (signature checked there; every subscription event re-reads
// the subscription from Stripe and writes it through billing_sync_subscription, so a replayed, duplicate or out-of-order
// event never puts back an older state; referral credits applied once). Tests: tests/architect/scenarios-billing-cancel.test.ts
// and tests/architect/flow-scenarios-billing-cancel.test.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { handleStripeWebhook, supabaseWebhookStore, webhookStripe } from "../_shared/stripe_webhook.ts";

serve((req) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  return handleStripeWebhook(req, {
    secret: Deno.env.get("STRIPE_WEBHOOK_SECRET"),
    stripe: key ? webhookStripe(fetch, key) : null,
    store: supabaseWebhookStore(admin),
    now: () => Date.now(),
  });
});
