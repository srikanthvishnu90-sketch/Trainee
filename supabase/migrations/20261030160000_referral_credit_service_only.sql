-- ISOLATION HOLE (found by tests/db/isolation_surface.check.sql, 2026-10-30): credit_pending_referral(p_referee_id) is a SECURITY
-- DEFINER payout. 20261026230500 keeps EXECUTE for `authenticated` on it (the sweep keeps what signed-in people had), and the body
-- trusted its argument, so any signed-in person who knew a referee's id could credit that referee's referrer without the referee
-- ever paying (or call it for themselves after qualify_referral). Its only caller is the Stripe webhook, as the service role
-- (_shared/stripe_webhook.ts), whose JWT carries no sub. The grant is left as it is (tests/db/definer_lockdown.test.sql asserts it);
-- the body now refuses any caller that has a user identity. Same result for every caller that worked before. Idempotent.
create or replace function public.credit_pending_referral(p_referee_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_referral_id uuid;
  v_referrer_id uuid;
  v_month_count int;
  v_credit_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'credit_pending_referral is service-role only';
  end if;
  if p_referee_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_referee');
  end if;

  select id, referrer_id into v_referral_id, v_referrer_id
  from public.referrals
  where referee_id = p_referee_id and status = 'pending'
  order by created_at desc
  limit 1;

  if v_referral_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_pending_referral');
  end if;

  -- The referrer must STILL be an eligible subscriber at payout time.
  if not public.is_eligible_referrer(v_referrer_id) then
    return jsonb_build_object('ok', false, 'error', 'referrer_not_subscriber');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('upmore_referral:' || v_referrer_id::text, 0)
  );

  -- Re-check the cap at payout (counts pending+credited created this month).
  select count(*) into v_month_count
  from public.referrals
  where referrer_id = v_referrer_id
    and status in ('pending', 'credited')
    and created_at >= date_trunc('month', now());

  if v_month_count > 5 then
    return jsonb_build_object('ok', false, 'error', 'monthly_cap_reached');
  end if;

  -- Idempotent credit insert: referral_id is UNIQUE.
  insert into public.referral_credits (user_id, amount, referral_id, applied)
  values (v_referrer_id, 10, v_referral_id, false)
  on conflict (referral_id) do nothing
  returning id into v_credit_id;

  -- Flip pending -> credited exactly once.
  update public.referrals
  set status = 'credited', credited_at = now()
  where id = v_referral_id and status = 'pending';

  return jsonb_build_object(
    'ok', true,
    'referral_id', v_referral_id,
    'credit_id', v_credit_id,
    'amount', 10
  );
end;
$$;
-- create or replace keeps the grants the lockdown (20261026230500) left: signed-in people and the service role, never anon.
revoke all on function public.credit_pending_referral(uuid) from public, anon;
grant execute on function public.credit_pending_referral(uuid) to authenticated, service_role;
