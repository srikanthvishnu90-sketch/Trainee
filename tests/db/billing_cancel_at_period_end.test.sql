-- Billing by text (20261028130000): user_subscriptions says when a plan ends at period end; RLS stays on, the person
-- reads only their own row and cannot write it (only the service role, as the webhook and the chat's cancel do).
\set ON_ERROR_STOP on
begin;
select t.ok((select is_nullable = 'NO' and column_default = 'false' from information_schema.columns
  where table_schema = 'public' and table_name = 'user_subscriptions' and column_name = 'cancel_at_period_end'), 'the column, false unless said');
select t.ok((select relrowsecurity from pg_class where oid = 'public.user_subscriptions'::regclass), 'RLS on');
select t.ok(not exists (
  select 1 from pg_policies where schemaname = 'public' and tablename = 'user_subscriptions' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')), 'no client may write it');
rollback;
