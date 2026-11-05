-- PROACTIVE SCENARIOS ROUND 4 (20261105170000_proactive_r4.sql), in the database alone: a person who moves west (Tokyo to
-- Los Angeles) goes back a date on their clock; the alerts already counted for the later date still hold, and sent_on never
-- goes back. Once that later date has passed on the new clock, the count starts over. Unchanged: a key once, alerts off,
-- the fit floor, the daily pacing. Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000ab401';
  p jsonb := '{"on": true, "keywords": ["data analyst"], "locations": [], "remote_ok": true, "report_hour": 8, "quiet_start": 22, "quiet_end": 7, "max_instant_per_day": 3}';
  at timestamptz := timestamptz '2026-11-05 01:00Z'; wk timestamptz := timestamptz '2026-10-29 01:00Z'; r text;
begin
  insert into auth.users(id, email) values (a, 'ab4-a@example.test');
  insert into public.profiles(id) values (a);
  insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at) values (a, 'Asia/Tokyo', p, at - interval '1 hour');
  -- 10:00 on 5 November in Tokyo: the day's three.
  for i in 1..3 loop
    r := public.career_alert_enqueue(a, 'alert:greenhouse:w:' || i, 'New match ' || i, at, null, null, date '2026-11-05', wk);
    if r <> 'queued' then raise exception 'FAIL alert % in Tokyo: %', i, r; end if;
  end loop;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:w:4', 'New match 4', at, null, null, date '2026-11-05', wk);
  if r <> 'capped' then raise exception 'FAIL the cap of 3 in Tokyo: %', r; end if;
  raise notice 'ok   three alerts on 5 November in Tokyo, the fourth capped';

  -- They move to Los Angeles: an hour later it is 4 November, 18:00 there. The three just had still count.
  update public.career_alert_prefs set tz = 'America/Los_Angeles' where user_id = a;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:w:5', 'New match 5', at + interval '1 hour', null, null, date '2026-11-04', wk);
  if r <> 'capped' then raise exception 'FAIL a move west started a new day''s allowance (4 November after 5 November): %', r; end if;
  if (select instant_sent_today || '|' || sent_on from public.career_alert_prefs where user_id = a) <> '3|2026-11-05' then
    raise exception 'FAIL the count and its date went back: %', (select instant_sent_today || '|' || sent_on from public.career_alert_prefs where user_id = a); end if;
  -- 5 November in Los Angeles: still the date counted.
  r := public.career_alert_enqueue(a, 'alert:greenhouse:w:6', 'New match 6', at + interval '20 hours', null, null, date '2026-11-05', wk);
  if r <> 'capped' then raise exception 'FAIL 5 November again in Los Angeles: %', r; end if;
  raise notice 'ok   after a move west the day already counted still holds';

  -- 6 November in Los Angeles: a new date, the count starts over and is kept for it.
  r := public.career_alert_enqueue(a, 'alert:greenhouse:w:7', 'New match 7', at + interval '40 hours', null, null, date '2026-11-06', wk);
  if r <> 'queued' then raise exception 'FAIL a new date starts over: %', r; end if;
  if (select instant_sent_today || '|' || sent_on from public.career_alert_prefs where user_id = a) <> '1|2026-11-06' then raise exception 'FAIL the new day''s count'; end if;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:w:7', 'New match 7', at + interval '40 hours', null, null, date '2026-11-06', wk);
  if r <> 'duplicate' then raise exception 'FAIL a key once: %', r; end if;
  -- A move east (to Tokyo) goes forward a date: a new day, as before.
  update public.career_alert_prefs set tz = 'Asia/Tokyo' where user_id = a;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:w:8', 'New match 8', at + interval '41 hours', null, null, date '2026-11-07', wk);
  if r <> 'queued' or (select instant_sent_today || '|' || sent_on from public.career_alert_prefs where user_id = a) <> '1|2026-11-07' then raise exception 'FAIL a move east: %', r; end if;
  update public.career_alert_prefs set prefs = p || '{"on": false}'::jsonb where user_id = a;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:w:9', 'New match 9', at + interval '41 hours', null, null, date '2026-11-07', wk);
  if r <> 'off' then raise exception 'FAIL alerts off: %', r; end if;
  raise notice 'ok   a new date starts over; a key once; a move east; off';
end $$;

-- Service only.
do $$
begin
  if has_function_privilege('anon', 'public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz)', 'execute')
    or has_function_privilege('authenticated', 'public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz)', 'execute') then
    raise exception 'FAIL career_alert_enqueue is callable outside the service role'; end if;
  if not has_function_privilege('service_role', 'public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz)', 'execute') then
    raise exception 'FAIL the service role cannot queue alerts'; end if;
  raise notice 'ok   service only';
end $$;
rollback;
