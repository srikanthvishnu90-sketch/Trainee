-- Billing and cancelling by text (owner, 2026-10-27; supabase/functions/_shared/career_billing.ts). A plan cancelled at
-- period end stays "active" at Stripe until the period ends, so the row must say it is ending, or "what am I paying"
-- would promise a next charge that will never come. stripe-webhook writes Stripe's cancel_at_period_end on every
-- subscription event; the chat's cancel sets it once Stripe accepted the cancel.
-- Idempotent. The table is 20260927_000001_referral_program.sql's, created here the same way when a project lacks it
-- (that file is not in go-live's list), with the same row security: the person reads their own row; only the service
-- role writes.
create table if not exists public.user_subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'incomplete'
    check (status in ('incomplete','incomplete_expired','trialing','active',
                      'past_due','canceled','unpaid')),
  plan text not null default 'monthly',
  price_cents integer not null default 1000,
  current_period_start timestamptz,
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_subscriptions enable row level security;
drop policy if exists "own subscription" on public.user_subscriptions;
create policy "own subscription" on public.user_subscriptions for select using (auth.uid() = user_id);
alter table public.user_subscriptions add column if not exists cancel_at_period_end boolean not null default false;
