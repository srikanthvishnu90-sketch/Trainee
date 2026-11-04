-- JOB ALERTS: NO WEEKLY CAP (owner rule, "no caps on anything").
-- career_alert_enqueue (20261030070000_proactive_r2.sql) answered 'capped' when the person's alerts in the rolling week reached
-- max_per_week (default 15, at most 25). That count is gone. Kept, unchanged: the person's own daily pacing
-- (max_instant_per_day, at most 10), quiet hours / paused account ('off'), the fit floor ('below_fit'), alerts off ('off'),
-- once per posting ('duplicate': the (user, key) pair is queued once, and a second call for it never counts again), and the
-- alert row lock that makes the day's count exact under two runs at once.
-- max_per_week stays an accepted setting and is ignored; p_week_since stays in the signature (the caller passes it) and is
-- ignored, so the function keeps its exact shape and nothing that calls it changes.
-- This is not a limit on outbound email: the deliverability breakers of the sending rail (bounce and hostile-reply breakers,
-- the per-domain daily limit, the warm-up ramp) are untouched; they protect the person's own mailbox reputation.
-- Idempotent; service role only.
create or replace function public.career_alert_enqueue(p_user uuid, p_key text, p_text text, p_at timestamptz, p_first_seen timestamptz,
  p_fit int, p_day date, p_week_since timestamptz) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_alert_prefs; today int; cap int;
begin
  if p_key !~ '^alert:.+$' then raise exception 'career_alert_enqueue: an alert key is alert:<job_id>'; end if;
  select * into r from public.career_alert_prefs where user_id = p_user for update;
  if not found or coalesce(r.prefs->>'on', 'false') <> 'true' then return 'off'; end if;
  if public.career_user_quiet(p_user) then return 'off'; end if;
  if exists (select 1 from public.career_outbox where user_id = p_user and key = p_key) then return 'duplicate'; end if;
  if (r.prefs->>'min_fit') ~ '^[0-9]+$' and (p_fit is null or p_fit < (r.prefs->>'min_fit')::int) then return 'below_fit'; end if;
  today := case when r.sent_on = p_day then greatest(coalesce(r.instant_sent_today, 0), 0) else 0 end;
  cap := least(10, case when (r.prefs->>'max_instant_per_day') ~ '^[0-9]+$' then (r.prefs->>'max_instant_per_day')::int else 3 end);
  if today >= cap then return 'capped'; end if;
  insert into public.career_outbox (user_id, key, kind, text, deliver_at, posting_first_seen_at, alert_fit)
  values (p_user, p_key, 'alert', p_text, p_at, p_first_seen, case when p_fit between 0 and 100 then p_fit end)
  on conflict (user_id, key) do nothing;
  if not found then return 'duplicate'; end if;
  update public.career_alert_prefs set instant_sent_today = today + 1, sent_on = p_day, updated_at = now() where user_id = p_user;
  return 'queued';
end $$;

revoke all on function public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz) from public, anon, authenticated;
grant execute on function public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz) to service_role;
