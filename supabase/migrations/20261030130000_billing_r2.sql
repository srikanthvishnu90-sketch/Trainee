-- Billing round 2 (battery 2026-10-30; tests/architect/scenarios-billing-r2.test.ts, flow-scenarios-billing-r2.test.ts).
-- stripe-webhook (supabase/functions/_shared/stripe_webhook.ts) now writes, from Stripe's own subscription:
--   - currency: the price's currency (a EUR plan's price was dropped as unknown; the chat said "a price I don't have on
--     file"). Null on the rows written before: those prices were USD;
--   - discounted: a coupon or discount on the subscription (the chat said "You're paying $10/month" under a 100%-off coupon);
--   - live_subscriptions: how many of the person's subscriptions are live at Stripe (a double checkout: two live ones, the row
--     shows the newest; the chat says there are two). Null: not known.
-- billing_sync_subscription gains the three as p_currency, p_discounted, p_live_subscriptions (13 arguments), with the same
-- rules as 20261030020000 (the later read wins; an old subscription's end never replaces a different live one; another
-- person's customer or subscription refused; a missing person refused). The 10-argument form stays, as a wrapper with the
-- values it always meant (usd, no discount, count unknown), so a webhook deployed before this file still writes.
-- Idempotent. Only the service role may call either form.
alter table public.user_subscriptions add column if not exists currency text;
alter table public.user_subscriptions add column if not exists discounted boolean not null default false;
alter table public.user_subscriptions add column if not exists live_subscriptions integer;

create or replace function public.billing_sync_subscription(
  p_user_id uuid, p_status text, p_plan text, p_price_cents integer, p_period_start timestamptz, p_period_end timestamptz,
  p_customer text, p_subscription text, p_cancel_at_period_end boolean, p_synced_at timestamptz,
  p_currency text, p_discounted boolean, p_live_subscriptions integer
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  live constant text[] := array['active', 'trialing', 'past_due', 'unpaid'];
  cur public.user_subscriptions%rowtype;
  n integer;
begin
  if p_user_id is null or p_synced_at is null or coalesce(p_customer, '') = '' or coalesce(p_subscription, '') = ''
     or p_status is null or p_status not in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')
     or (p_price_cents is not null and p_price_cents < 0)
     or (p_currency is not null and p_currency !~ '^[a-z]{3}$')
     or (p_live_subscriptions is not null and p_live_subscriptions < 0) then
    return 'invalid';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then return 'no_user'; end if;
  if exists (select 1 from public.user_subscriptions
             where user_id <> p_user_id and (stripe_customer_id = p_customer or stripe_subscription_id = p_subscription)) then
    return 'foreign';
  end if;
  insert into public.user_subscriptions as s (user_id, status, plan, price_cents, current_period_start, current_period_end,
    stripe_customer_id, stripe_subscription_id, cancel_at_period_end, stripe_synced_at, currency, discounted, live_subscriptions, updated_at)
  values (p_user_id, p_status, coalesce(p_plan, 'monthly'), p_price_cents, p_period_start, p_period_end,
    p_customer, p_subscription, coalesce(p_cancel_at_period_end, false), p_synced_at,
    case when p_price_cents is null then null else p_currency end, coalesce(p_discounted, false), p_live_subscriptions, now())
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
    currency = excluded.currency,
    discounted = excluded.discounted,
    live_subscriptions = excluded.live_subscriptions,
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

-- The 10-argument form (20261030020000): the same write, with what it always meant (a USD price, no discount, the count
-- of live subscriptions not known).
create or replace function public.billing_sync_subscription(
  p_user_id uuid, p_status text, p_plan text, p_price_cents integer, p_period_start timestamptz, p_period_end timestamptz,
  p_customer text, p_subscription text, p_cancel_at_period_end boolean, p_synced_at timestamptz
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.billing_sync_subscription(p_user_id, p_status, p_plan, p_price_cents, p_period_start, p_period_end,
    p_customer, p_subscription, p_cancel_at_period_end, p_synced_at, 'usd'::text, false, null::integer);
end $$;

revoke all on function public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz, text, boolean, integer) to service_role;
revoke all on function public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz) to service_role;
