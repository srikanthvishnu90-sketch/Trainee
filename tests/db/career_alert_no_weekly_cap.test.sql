-- NO WEEKLY ALERT CAP (20261030180000_career_alert_no_weekly_cap.sql), in the database alone and deterministic: the zone is
-- pinned to UTC and every day and instant is passed in, so nothing reads the wall clock. 30 alerts in one week all queue
-- (the old function stopped at max_per_week, at most 25, and this person even states 3); the daily pacing still holds, a
-- posting is queued once, and the fit floor, alerts off and a paused account still refuse. Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000ac301'; b uuid := '00000000-0000-4000-8000-0000000ac302';
  p jsonb := '{"on": true, "keywords": ["data analyst"], "locations": [], "remote_ok": true, "report_hour": 8, "quiet_start": 22, "quiet_end": 7, "max_instant_per_day": 5, "max_per_week": 3}';
  d0 date := date '2026-11-02'; t0 timestamptz := timestamptz '2026-11-02 15:00:00+00';
  day int; k int; r text; n int; queued int := 0;
begin
  insert into auth.users(id, email) values (a, 'nw-a@example.test'), (b, 'nw-b@example.test');
  insert into public.profiles(id) values (a), (b);
  insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at) values (a, 'UTC', p, t0 - interval '1 hour');

  -- Six days, five alerts a day: 30 alerts inside seven days. The window the caller passes is the rolling week.
  for day in 0..5 loop
    for k in 1..5 loop
      r := public.career_alert_enqueue(a, format('alert:greenhouse:x:%s', day * 5 + k), 'New match', t0 + day * interval '1 day' + k * interval '1 minute', null, 80, d0 + day, t0 - interval '1 day');
      if r <> 'queued' then raise exception 'FAIL alert % of 30 (day %, #%) must queue, got %', day * 5 + k, day, k, r; end if;
      queued := queued + 1;
    end loop;
  end loop;
  select count(*) into n from public.career_outbox where user_id = a and kind = 'alert';
  if queued <> 30 or n <> 30 then raise exception 'FAIL 30 alerts in a week: queued %, rows %', queued, n; end if;
  raise notice 'ok   30 alerts in one week all queue (stated max_per_week 3 is accepted and ignored)';

  -- The same postings again: each is a duplicate, nothing is added, and the day's count does not move.
  for day in 0..5 loop
    for k in 1..5 loop
      r := public.career_alert_enqueue(a, format('alert:greenhouse:x:%s', day * 5 + k), 'New match', t0 + day * interval '1 day', null, 80, d0 + day, t0 - interval '1 day');
      if r <> 'duplicate' then raise exception 'FAIL a posting is queued once: day %, #% gave %', day, k, r; end if;
    end loop;
  end loop;
  select count(*) into n from public.career_outbox where user_id = a and kind = 'alert';
  if n <> 30 then raise exception 'FAIL duplicates add nothing: % rows', n; end if;
  if (select instant_sent_today from public.career_alert_prefs where user_id = a) <> 5 then raise exception 'FAIL duplicates do not count against the day'; end if;
  raise notice 'ok   the same posting again is a duplicate and adds nothing';

  -- Daily pacing is kept: the 6th alert on day 5 is held for the report ...
  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:31', 'New match', t0 + interval '5 days 10 minutes', null, 80, d0 + 5, t0 - interval '1 day');
  if r <> 'capped' then raise exception 'FAIL the daily pacing (5) still holds: %', r; end if;
  -- ... and the 7th day queues again, with 30 alerts already in the week (over the old 25 ceiling).
  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:31', 'New match', t0 + interval '6 days', null, 80, d0 + 6, t0 - interval '1 day');
  if r <> 'queued' then raise exception 'FAIL the 31st alert of the week on a new day: %', r; end if;
  raise notice 'ok   the daily pacing holds; a new day queues past 30 in the week';

  -- The other refusals are unchanged: the fit floor, alerts off, a paused account, an unknown person.
  update public.career_alert_prefs set prefs = p || '{"min_fit": 70, "max_instant_per_day": 10}'::jsonb, instant_sent_today = 0, sent_on = null where user_id = a;
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:40', 't', t0 + interval '7 days', null, 60, d0 + 7, t0) <> 'below_fit' then raise exception 'FAIL fit floor'; end if;
  update public.career_alert_prefs set prefs = prefs || '{"on": false}'::jsonb where user_id = a;
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:41', 't', t0 + interval '7 days', null, 95, d0 + 7, t0) <> 'off' then raise exception 'FAIL alerts off'; end if;
  update public.career_alert_prefs set prefs = prefs || '{"on": true}'::jsonb where user_id = a;
  insert into public.career_watch_kv(user_id, key, value) values (a, 'career:account', '{"paused": true}');
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:42', 't', t0 + interval '7 days', null, 95, d0 + 7, t0) <> 'off' then raise exception 'FAIL paused'; end if;
  if public.career_alert_enqueue(b, 'alert:greenhouse:x:1', 't', t0, null, null, d0, t0) <> 'off' then raise exception 'FAIL no settings'; end if;
  raise notice 'ok   fit floor, off, paused and no settings still refuse';

  if exists (select 1 from pg_proc where proname = 'career_alert_enqueue' and prosrc like '%max_per_week%') then raise exception 'FAIL the function no longer reads max_per_week'; end if;
  raise notice 'ok   the function does not read max_per_week';
end $$;

-- Service only.
set local role anon;
do $$ begin
  perform public.career_alert_enqueue('00000000-0000-4000-8000-0000000ac301', 'alert:x:1', 't', now(), null, null, current_date, now());
  raise exception 'FAIL anon runs career_alert_enqueue';
exception when insufficient_privilege then null; end $$;
reset role;
rollback;
