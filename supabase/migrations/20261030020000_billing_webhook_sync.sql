-- stripe-webhook writes a subscription only through billing_sync_subscription (supabase/functions/_shared/stripe_webhook.ts;
-- battery 2026-10-30, tests/architect/scenarios-billing-cancel.test.ts). The handler re-reads the subscription from
-- Stripe on every event and passes the instant it read it; this function writes that read onto the person's row only when:
--   - it is not older than the read already written (stripe_synced_at): a slower handler holding an older read, or a
--     late retry, never puts back an earlier state (period end, cancel_at_period_end, status);
--   - it does not replace a different, live subscription with one that is not live (an old subscription's "canceled"
--     arriving after the person subscribed again);
--   - the customer and the subscription are not already on another person's row (a subscription never attaches to the
--     wrong person), and the person exists.
-- It returns what it did: applied | stale | other_subscription | foreign | no_user | invalid. One statement per call
-- (insert ... on conflict do update ... where), so two deliveries at once cannot interleave their writes.
-- price_cents may be null: the subscription's own price when Stripe states one, never an assumed $10.
-- Idempotent. Only the service role (the webhook) may call it.
alter table public.user_subscriptions add column if not exists stripe_synced_at timestamptz;
alter table public.user_subscriptions alter column price_cents drop not null;

create or replace function public.billing_sync_subscription(
  p_user_id uuid, p_status text, p_plan text, p_price_cents integer, p_period_start timestamptz, p_period_end timestamptz,
  p_customer text, p_subscription text, p_cancel_at_period_end boolean, p_synced_at timestamptz
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  live constant text[] := array['active', 'trialing', 'past_due', 'unpaid'];
  cur public.user_subscriptions%rowtype;
  n integer;
begin
  if p_user_id is null or p_synced_at is null or coalesce(p_customer, '') = '' or coalesce(p_subscription, '') = ''
     or p_status is null or p_status not in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')
     or (p_price_cents is not null and p_price_cents < 0) then
    return 'invalid';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then return 'no_user'; end if;
  if exists (select 1 from public.user_subscriptions
             where user_id <> p_user_id and (stripe_customer_id = p_customer or stripe_subscription_id = p_subscription)) then
    return 'foreign';
  end if;
  insert into public.user_subscriptions as s (user_id, status, plan, price_cents, current_period_start, current_period_end,
    stripe_customer_id, stripe_subscription_id, cancel_at_period_end, stripe_synced_at, updated_at)
  values (p_user_id, p_status, coalesce(p_plan, 'monthly'), p_price_cents, p_period_start, p_period_end,
    p_customer, p_subscription, coalesce(p_cancel_at_period_end, false), p_synced_at, now())
  on conflict (user_id) do update set
    status = excluded.status,
    plan = coalesce(p_plan, s.plan),
    price_cents = excluded.price_cents,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    cancel_at_period_end = excluded.cancel_at_period_end,
    stripe_synced_at = excluded.stripe_synced_at,
    updated_at = now()
  where (s.stripe_synced_at is null or s.stripe_synced_at <= excluded.stripe_synced_at)
    and not (s.stripe_subscription_id is not null and s.stripe_subscription_id <> excluded.stripe_subscription_id
             and s.status = any (live) and not (excluded.status = any (live)));
  get diagnostics n = row_count;
  if n = 1 then return 'applied'; end if;
  select * into cur from public.user_subscriptions where user_id = p_user_id;
  if cur.stripe_synced_at is not null and cur.stripe_synced_at > p_synced_at then return 'stale'; end if;
  return 'other_subscription';
end $$;

revoke all on function public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz) to service_role;
