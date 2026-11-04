-- Billing round 2 (20261030130000_billing_r2.sql): billing_sync_subscription's 13-argument form writes the price's currency,
-- a discount and how many of the person's subscriptions are live, under the same rules as before (the later read wins, an
-- old subscription's end never replaces a different live one, another person's customer refused, a missing person refused);
-- a bad currency or a negative count is refused; the 10-argument form still writes (usd, no discount, count unknown); only
-- the service role may call either. Everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000b2c01','r2-a@example.test'),('00000000-0000-4000-8000-0000000b2c02','r2-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000b2c01'),('00000000-0000-4000-8000-0000000b2c02');
create function pg_temp.sync(u text, st text, sub text, cust text, at text, price int, cur text, disc boolean, live int, pend text default '2026-11-27T15:00:00Z')
returns text language sql as $$
  select public.billing_sync_subscription(u::uuid, st, 'monthly', price, '2026-10-27T15:00:00Z'::timestamptz, pend::timestamptz, cust, sub, false, at::timestamptz, cur, disc, live) $$;
create function pg_temp.row(u text) returns text language sql as $$
  select status || '|' || stripe_subscription_id || '|' || coalesce(price_cents::text, 'null') || '|' || coalesce(currency, 'null') || '|' || discounted || '|' || coalesce(live_subscriptions::text, 'null')
  from public.user_subscriptions where user_id = u::uuid $$;
\set a '''00000000-0000-4000-8000-0000000b2c01'''
\set b '''00000000-0000-4000-8000-0000000b2c02'''

select t.ok(pg_temp.sync(:a, 'active', 'sub_R1', 'cus_RA', '2026-10-30T10:00:00Z', 900, 'eur', false, 1) = 'applied', 'a EUR read is written');
select t.ok(pg_temp.row(:a) = 'active|sub_R1|900|eur|false|1', 'the price in its currency, one live');
select t.ok(pg_temp.sync(:a, 'active', 'sub_R1', 'cus_RA', '2026-10-30T10:01:00Z', 1000, 'usd', true, 1) = 'applied', 'a coupon is written');
select t.ok(pg_temp.row(:a) = 'active|sub_R1|1000|usd|true|1', 'discounted');
select t.ok(pg_temp.sync(:a, 'active', 'sub_R2', 'cus_RA', '2026-10-30T10:02:00Z', 1000, 'usd', false, 2) = 'applied', 'the newest of two live subscriptions, with the count');
select t.ok(pg_temp.row(:a) = 'active|sub_R2|1000|usd|false|2', 'two live');
select t.ok(pg_temp.sync(:a, 'active', 'sub_R1', 'cus_RA', '2026-10-30T10:01:30Z', 1000, 'usd', false, 2) = 'stale', 'an older read is refused, as before');
select t.ok(pg_temp.sync(:a, 'canceled', 'sub_R0', 'cus_RA', '2026-10-30T10:03:00Z', 1000, 'usd', false, 0) = 'other_subscription', 'an old subscription''s end never replaces the live one, as before');
select t.ok(pg_temp.row(:a) = 'active|sub_R2|1000|usd|false|2', 'still the live one');
select t.ok(pg_temp.sync(:a, 'active', 'sub_R2', 'cus_RA', '2026-10-30T10:04:00Z', null, 'usd', false, 1) = 'applied', 'an unknown price');
select t.ok(pg_temp.row(:a) = 'active|sub_R2|null|null|false|1', 'no price, no currency');
select t.ok(pg_temp.sync(:a, 'active', 'sub_R2', 'cus_RA', '2026-10-30T10:05:00Z', 1000, 'US$', false, 1) = 'invalid', 'a currency that is not a 3-letter code is refused');
select t.ok(pg_temp.sync(:a, 'active', 'sub_R2', 'cus_RA', '2026-10-30T10:05:00Z', 1000, 'usd', false, -1) = 'invalid', 'a negative count is refused');
select t.ok(pg_temp.sync(:b, 'active', 'sub_RB', 'cus_RA', '2026-10-30T10:06:00Z', 1000, 'usd', false, 1) = 'foreign', 'another person''s customer is refused, as before');
select t.ok(pg_temp.sync('00000000-0000-4000-8000-0000000b2c99', 'active', 'sub_RX', 'cus_RX', '2026-10-30T10:06:00Z', 1000, 'usd', false, 1) = 'no_user', 'a person who does not exist (a deleted account) is refused');
-- The 10-argument form (a webhook deployed before this migration) still writes, with what it always meant.
select t.ok(public.billing_sync_subscription(:b::uuid, 'active', 'monthly', 1000, null, null, 'cus_RB', 'sub_RB', false, '2026-10-30T10:07:00Z') = 'applied', 'the 10-argument form writes');
select t.ok(pg_temp.row(:b) = 'active|sub_RB|1000|usd|false|null', 'usd, no discount, count unknown');
select t.ok(public.billing_sync_subscription(:b::uuid, 'canceled', 'monthly', 1000, null, null, 'cus_RB', 'sub_RB', false, '2026-10-30T10:06:59Z') = 'stale', 'the 10-argument form keeps the staleness rule');
-- The privileges.
select t.ok(has_function_privilege('service_role', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz, text, boolean, integer)', 'EXECUTE'), 'service role may call the 13-argument form');
select t.ok(not has_function_privilege('authenticated', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz, text, boolean, integer)', 'EXECUTE'), 'a signed-in person may not');
select t.ok(not has_function_privilege('anon', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz, text, boolean, integer)', 'EXECUTE'), 'anon may not');
select t.ok(not has_function_privilege('anon', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz)', 'EXECUTE'), 'anon may not call the 10-argument form');
select t.ok(not has_function_privilege('authenticated', 'public.billing_sync_subscription(uuid, text, text, integer, timestamptz, timestamptz, text, text, boolean, timestamptz)', 'EXECUTE'), 'a signed-in person may not call the 10-argument form');
rollback;
