-- stripe-webhook's only write (20261030020000_billing_webhook_sync.sql): billing_sync_subscription. The later read of
-- Stripe wins and an older one is refused; an old subscription's "canceled" never replaces a different live one; a
-- customer or subscription on another person's row is refused; a person who does not exist is refused; the price may be
-- unknown (null), never assumed; only the service role may call it. Everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000b5c01','sync-a@example.test'),('00000000-0000-4000-8000-0000000b5c02','sync-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000b5c01'),('00000000-0000-4000-8000-0000000b5c02');
create function pg_temp.sync(u text, st text, sub text, cust text, cape boolean, at text, price int default 1000, pend text default '2026-11-27T15:00:00Z')
returns text language sql as $$
  select public.billing_sync_subscription(u::uuid, st, 'monthly', price, '2026-10-27T15:00:00Z'::timestamptz, pend::timestamptz, cust, sub, cape, at::timestamptz) $$;
create function pg_temp.row(u text) returns text language sql as $$
  select status || '|' || stripe_subscription_id || '|' || cancel_at_period_end || '|' || coalesce(price_cents::text, 'null') || '|' || to_char(current_period_end at time zone 'utc', 'YYYY-MM-DD')
  from public.user_subscriptions where user_id = u::uuid $$;
\set a '''00000000-0000-4000-8000-0000000b5c01'''
\set b '''00000000-0000-4000-8000-0000000b5c02'''

select t.ok(pg_temp.sync(:a, 'active', 'sub_A1', 'cus_A', false, '2026-10-30T10:00:00Z') = 'applied', 'a first read is written');
select t.ok(pg_temp.row(:a) = 'active|sub_A1|false|1000|2026-11-27', 'the row is the read');
select t.ok(pg_temp.sync(:a, 'active', 'sub_A1', 'cus_A', true, '2026-10-30T10:05:00Z') = 'applied', 'a later read (cancel at period end) is written');
select t.ok(pg_temp.sync(:a, 'active', 'sub_A1', 'cus_A', false, '2026-10-30T10:01:00Z') = 'stale', 'an older read arriving late is refused');
select t.ok(pg_temp.row(:a) = 'active|sub_A1|true|1000|2026-11-27', 'the cancel stays');
select t.ok(pg_temp.sync(:a, 'active', 'sub_A1', 'cus_A', true, '2026-10-30T10:05:00Z') = 'applied', 'the same read twice is the same row (idempotent)');
-- An old subscription's end arriving after a new live one.
select t.ok(pg_temp.sync(:a, 'active', 'sub_A2', 'cus_A', false, '2026-10-30T11:00:00Z', 1000, '2026-12-30T11:00:00Z') = 'applied', 'a new live subscription replaces the old one');
select t.ok(pg_temp.sync(:a, 'canceled', 'sub_A1', 'cus_A', false, '2026-10-30T12:00:00Z') = 'other_subscription', 'the old one''s canceled never replaces the live one');
select t.ok(pg_temp.row(:a) = 'active|sub_A2|false|1000|2026-12-30', 'still the live one');
select t.ok(pg_temp.sync(:a, 'past_due', 'sub_A2', 'cus_A', false, '2026-10-30T13:00:00Z') = 'applied', 'past_due is written');
select t.ok(pg_temp.sync(:a, 'canceled', 'sub_A2', 'cus_A', false, '2026-10-30T14:00:00Z') = 'applied', 'the live one''s own deletion is written');
select t.ok(pg_temp.row(:a) like 'canceled|sub_A2|%', 'canceled');
-- Another person's customer or subscription.
select t.ok(pg_temp.sync(:b, 'active', 'sub_B1', 'cus_A', false, '2026-10-30T15:00:00Z') = 'foreign', 'another person''s customer is refused');
select t.ok(pg_temp.sync(:b, 'active', 'sub_A2', 'cus_B', false, '2026-10-30T15:00:00Z') = 'foreign', 'another person''s subscription is refused');
select t.ok(not exists (select 1 from public.user_subscriptions where user_id = :b::uuid), 'nothing written for B');
select t.ok(pg_temp.sync('00000000-0000-4000-8000-0000000b5c99', 'active', 'sub_X', 'cus_X', false, '2026-10-30T15:00:00Z') = 'no_user', 'no such person');
select t.ok(pg_temp.sync(:b, 'bogus', 'sub_B1', 'cus_B', false, '2026-10-30T15:00:00Z') = 'invalid', 'an unknown status');
select t.ok(public.billing_sync_subscription(:b::uuid, 'active', null, null, null, null, 'cus_B', 'sub_B1', false, '2026-10-30T15:00:00Z') = 'applied', 'an unknown price is written as unknown');
select t.ok(pg_temp.row(:b) is null or (select price_cents is null and plan = 'monthly' from public.user_subscriptions where user_id = :b::uuid), 'price null, never $10');
-- The privilege.
select t.ok(has_function_privilege('service_role', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz)', 'EXECUTE'), 'service role may call it');
select t.ok(not has_function_privilege('authenticated', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz)', 'EXECUTE'), 'a signed-in person may not');
select t.ok(not has_function_privilege('anon', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz)', 'EXECUTE'), 'anon may not');
rollback;
