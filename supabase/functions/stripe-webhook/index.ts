// Upmore stripe-webhook Edge Function.
// Handles Stripe webhook events for the $10/mo subscription.
//
// Events:
// - checkout.session.completed → mark subscription active, apply pending credits,
//   credit the referee's referrer (first paid charge)
// - customer.subscription.updated → sync status to user_subscriptions
// - customer.subscription.deleted → mark canceled
// - invoice.payment_succeeded → confirm active, log, credit the referee's
//   referrer (idempotent — only acts on pending referrals)
//
// Security: verifies Stripe webhook signature. No JWT (Stripe calls this).
// Referral credits: ANTI-GAMING 2026-09-27 — the $10 credit row is created ONLY
// when the referee's first paid charge clears (credit_pending_referral,
// idempotent). When a subscription becomes active, any unapplied credits for
// the user are added to their Stripe Customer Balance (negative = credit) and
// marked applied=true in our DB. Stripe auto-applies balance to invoices.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";

serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

    if (!stripeKey || !webhookSecret) {
      console.error("stripe-webhook: missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
      return json({ error: "Stripe not configured" }, 503);
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const admin = createClient(supabaseUrl, serviceKey);

    // 1. Verify signature.
    const sig = req.headers.get("stripe-signature");
    if (!sig) return json({ error: "Missing signature" }, 400);
    const rawBody = await req.text();
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, sig, webhookSecret);
    } catch (e) {
      console.error("stripe-webhook: signature verification failed:", (e as Error).message);
      return json({ error: "Invalid signature" }, 400);
    }

    // 2. Helper: apply unapplied referral credits to Stripe customer balance.
    async function applyPendingCredits(userId: string, customerId: string) {
      const { data: credits } = await admin
        .from("referral_credits")
        .select("id, amount")
        .eq("user_id", userId)
        .eq("applied", false);
      if (!credits || credits.length === 0) return 0;
      const totalCents = credits.reduce((s, c) => s + Math.round(Number(c.amount) * 100), 0);
      if (totalCents <= 0) return 0;
      // Negative amount = credit on customer balance.
      await stripe.customers.createBalanceTransaction(customerId, {
        amount: -totalCents,
        currency: "usd",
        description: `Referral credit applied (${credits.length} referral${credits.length === 1 ? "" : "s"})`,
      });
      await admin
        .from("referral_credits")
        .update({ applied: true })
        .in("id", credits.map(c => c.id));
      console.log(`stripe-webhook: applied $${(totalCents/100).toFixed(2)} credit to customer ${customerId}`);
      return totalCents;
    }

    // 3. Helper: upsert subscription status from a Stripe subscription object.
    // Returns the resolved Supabase user id (or null).
    async function syncSubscription(sub: Stripe.Subscription): Promise<string | null> {
      const userId = sub.metadata?.supabase_user_id || null;
      // Fall back to customer metadata if subscription metadata is empty.
      let resolvedUserId = userId;
      if (!resolvedUserId && typeof sub.customer === "string") {
        const cust = await stripe.customers.retrieve(sub.customer) as Stripe.Customer;
        resolvedUserId = cust.metadata?.supabase_user_id || null;
      }
      if (!resolvedUserId) {
        console.error("stripe-webhook: no supabase_user_id for subscription", sub.id);
        return null;
      }
      const statusMap: Record<string, string> = {
        active: "active",
        trialing: "trialing",
        past_due: "past_due",
        canceled: "canceled",
        unpaid: "unpaid",
        incomplete: "incomplete",
        incomplete_expired: "incomplete_expired",
      };
      await admin.from("user_subscriptions").upsert({
        user_id: resolvedUserId,
        status: statusMap[sub.status] || sub.status,
        stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        stripe_subscription_id: sub.id,
        current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        // Billing by text (20261028130000): a plan ending at period end is said so, never "next charge".
        cancel_at_period_end: sub.cancel_at_period_end === true,
        price_cents: 1000,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      // If now active, apply any pending referral credits.
      if (sub.status === "active" && typeof sub.customer === "string") {
        await applyPendingCredits(resolvedUserId, sub.customer);
      }
      return resolvedUserId;
    }

    // 3b. Helper: ANTI-GAMING 2026-09-27 — when the referee's first paid
    // charge clears, create the referrer's $10 credit row. Idempotent: the
    // DB function only acts on status='pending' referrals and the credit
    // insert is ON CONFLICT DO NOTHING, so every invoice.payment_succeeded
    // can safely call this.
    async function creditReferrerOnFirstPayment(userId: string) {
      try {
        const { data, error } = await admin.rpc("credit_pending_referral", {
          p_referee_id: userId,
        });
        if (error) {
          console.error("stripe-webhook: credit_pending_referral failed:", error.message);
          return;
        }
        if (data && (data as any).ok) {
          console.log(`stripe-webhook: referrer credited $10 for referee ${userId}`);
        }
      } catch (e) {
        console.error("stripe-webhook: creditReferrer error:", (e as Error).message);
      }
    }

    // 4. Route events.
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription && typeof session.subscription === "string") {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const uid = await syncSubscription(sub);
          // First paid charge path: credit the referee's referrer (idempotent).
          if (uid) await creditReferrerOnFirstPayment(uid);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub);
        break;
      }
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        console.log(`stripe-webhook: invoice ${invoice.id} paid ($${((invoice.amount_paid||0)/100).toFixed(2)})`);
        // First-paid-charge path (idempotent): resolve the paying user and
        // credit their referrer if the referral is still pending.
        let payUid: string | null = null;
        try {
          if (invoice.subscription && typeof invoice.subscription === "string") {
            const sub = await stripe.subscriptions.retrieve(invoice.subscription);
            payUid = sub.metadata?.supabase_user_id || null;
          }
          if (!payUid && typeof invoice.customer === "string") {
            const cust = await stripe.customers.retrieve(invoice.customer) as Stripe.Customer;
            payUid = cust.metadata?.supabase_user_id || null;
          }
        } catch (e) {
          console.error("stripe-webhook: payer resolve failed:", (e as Error).message);
        }
        if (payUid) await creditReferrerOnFirstPayment(payUid);
        break;
      }
      default:
        console.log(`stripe-webhook: unhandled event ${event.type}`);
    }

    return json({ received: true });
  } catch (e) {
    console.error("stripe-webhook error:", e);
    return json({ error: "Webhook failed: " + (e as Error).message }, 500);
  }
});
