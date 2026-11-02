-- MASS APPLY (2026-11-01): the cloud throttle's failure-rate rule waits for a real sample. As written (20261021080000) a
-- portal's window starts empty after each pause, so ONE error in its first few attempts was "2% of the window" and paused
-- that ATS (Greenhouse, Lever or Ashby) for 6 hours for every person: one batch's single failure stopped everyone's
-- batches. Now the failure-rate rule needs at least 20 attempts in the window (2% of 50 still pauses, as before), and a
-- site that is really down pauses after its last 3 attempts all failed (review of #384: never 19 failures first); the
-- bot-check rule (2 verification checks in the last 20 attempts) and the person's own pause (2 checks in a day) are
-- unchanged, and a posting closed after the approval is recorded not_sent (workers/career-cloud/worker.ts POSTING_CLOSED),
-- never an error. Every other line is 20261021080000's. Idempotent; not applied to any database by this change.
create or replace function public.career_apply_cloud_throttle(p_portal text, p_user uuid, p_now timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare since timestamptz; tries int; fails int; bots20 int; why text; pid bigint; owner uuid; bots_today int; nice text;
begin
 owner := nullif((select value from public.career_cloud_settings where key = 'owner_user_id'), '')::uuid;
 nice := initcap(p_portal);
 if not exists (select from public.career_apply_cloud_pauses where scope = 'portal' and portal = p_portal and until > p_now) then
  since := coalesce((select max(created_at) from public.career_apply_cloud_pauses where scope = 'portal' and portal = p_portal), '-infinity');
  select count(*), count(*) filter (where outcome in ('bot_check', 'error')) into tries, fails
   from (select outcome from public.career_apply_cloud_events where portal = p_portal and outcome <> 'confirmed' and at > since
         order by id desc limit 50) w;
  select count(*) filter (where outcome = 'bot_check') into bots20
   from (select outcome from public.career_apply_cloud_events where portal = p_portal and outcome <> 'confirmed' and at > since
         order by id desc limit 20) w;
  if bots20 >= 2 then why := format('bot_check_spike: %s bot checks in the last 20 attempts', bots20);
  -- A site that is really down: its last 3 attempts in this window all failed (whatever the sample size). Only failures the
  -- site can cause count: our own browser crashing (DRIVER_ERROR, DRIVER_ERROR_AT_SUBMIT) or giving no result
  -- (ENGINE_NO_RESULT) says nothing about the site, so those attempts are left out of the last 3 (they neither pause it
  -- nor break a run of the site's own failures).
  elsif (select count(*) = 3 and bool_and(outcome = 'error') from (select outcome from public.career_apply_cloud_events
     where portal = p_portal and outcome <> 'confirmed' and at > since
      and coalesce(error_kind, '') not in ('DRIVER_ERROR', 'DRIVER_ERROR_AT_SUBMIT', 'ENGINE_NO_RESULT')
     order by id desc limit 3) l3) then
   why := 'consecutive_errors: the last 3 attempts failed';
  elsif tries >= 20 and fails * 100 >= 2 * tries then why := format('failure_rate: %s of the last %s attempts failed', fails, tries); end if;
  if why is not null then
   insert into public.career_apply_cloud_pauses (scope, portal, reason, until, created_at)
   values ('portal', p_portal, why, p_now + interval '6 hours', p_now) returning id into pid;
   perform public.career_apply_cloud_tell(p_user, 'status:cloud-pause:' || pid,
    'Trainee paused sending applications from the cloud on ' || nice || ' for 6 hours: recent attempts there hit a verification '
    || 'check or an error, and pausing protects your name with employers. Nothing you approved is lost. It waits, and your own '
    || 'computer can still send it.', p_now);
   perform public.career_apply_cloud_tell(owner, 'status:cloud-pause:' || pid,
    'Cloud apply paused on ' || nice || ' until ' || to_char((p_now + interval '6 hours') at time zone 'UTC', 'YYYY-MM-DD HH24:MI')
    || ' UTC (' || replace(why, '_', ' ') || '). The cloud report has the counts (docs/launch/CLOUD-WORKER.md).', p_now);
  end if;
 end if;
 if p_user is not null and not exists (select from public.career_apply_cloud_pauses where scope = 'person' and user_id = p_user and until > p_now) then
  select count(*) into bots_today from public.career_apply_cloud_events where user_id = p_user and outcome = 'bot_check'
   and at >= date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC';
  if bots_today >= 2 then
   insert into public.career_apply_cloud_pauses (scope, user_id, reason, until, created_at)
   values ('person', p_user, format('%s bot checks today', bots_today),
    (date_trunc('day', p_now at time zone 'UTC') + interval '1 day') at time zone 'UTC', p_now) returning id into pid;
   perform public.career_apply_cloud_tell(p_user, 'status:cloud-pause:' || pid,
    'Two employer sites showed a verification check to the cloud today, so Trainee stopped sending your applications from the '
    || 'cloud until tomorrow. That protects your name. Your own computer can still send them, and the ones that need you are '
    || 'waiting with their links.', p_now);
   perform public.career_apply_cloud_tell(owner, 'status:cloud-pause:' || pid,
    'Cloud apply paused for one person until tomorrow UTC (' || bots_today || ' bot checks today). The cloud report has the counts (docs/launch/CLOUD-WORKER.md).', p_now);
  end if;
 end if;
end $$;
revoke all on function public.career_apply_cloud_throttle(text, uuid, timestamptz) from public, anon, authenticated;
