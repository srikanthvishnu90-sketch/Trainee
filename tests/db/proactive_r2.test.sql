-- PROACTIVE SCENARIOS ROUND 2 (20261030070000_proactive_r2.sql), in the database alone: a job alert is queued only while
-- the person's settings as they are now have room (the day's cap, the week's cap, the fit floor, alerts on, the account not
-- quiet), counted in the same step, a key once; a row the WhatsApp window holds is marked held (held_at) and keeps the
-- mark when it goes back in the queue; the template budget is claimed one at a time against the day's count; an interview
-- can be marked moved or cancelled. Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000ab201'; b uuid := '00000000-0000-4000-8000-0000000ab202';
  p jsonb := '{"on": true, "keywords": ["data analyst"], "locations": [], "remote_ok": true, "report_hour": 8, "quiet_start": 22, "quiet_end": 7, "max_instant_per_day": 2, "max_per_week": 3}';
  d date := date '2026-11-03'; wk timestamptz := timestamptz '2026-10-27 15:00Z'; at timestamptz := timestamptz '2026-11-03 15:00Z';
  r text; row_id bigint;
begin
  insert into auth.users(id, email) values (a, 'ab-a@example.test'), (b, 'ab-b@example.test');
  insert into public.profiles(id) values (a), (b);
  insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at) values (a, 'America/New_York', p, at - interval '1 hour');

  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:1', 'New match: one', at, at - interval '5 minutes', 80, d, wk);
  if r <> 'queued' then raise exception 'FAIL the first alert is queued: %', r; end if;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:1', 'New match: one', at, null, 80, d, wk);
  if r <> 'duplicate' then raise exception 'FAIL a key once: %', r; end if;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:2', 'New match: two', at, null, null, d, wk);
  if r <> 'queued' then raise exception 'FAIL the second: %', r; end if;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:3', 'New match: three', at, null, null, d, wk);
  if r <> 'capped' then raise exception 'FAIL the day''s cap of 2 holds: %', r; end if;
  if (select instant_sent_today || '|' || sent_on from public.career_alert_prefs where user_id = a) <> '2|2026-11-03' then raise exception 'FAIL the day''s count is kept with the alerts'; end if;
  if (select alert_fit from public.career_outbox where user_id = a and key = 'alert:greenhouse:x:1') <> 80 then raise exception 'FAIL the fit is kept with the alert'; end if;
  raise notice 'ok   queued, a key once, the day''s cap counted in the same step';

  -- A new day: the count starts over; the week's cap (3) still holds.
  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:4', 'New match: four', at + interval '1 day', null, null, d + 1, wk + interval '1 day');
  if r <> 'queued' then raise exception 'FAIL a new day starts over: %', r; end if;
  r := public.career_alert_enqueue(a, 'alert:greenhouse:x:5', 'New match: five', at + interval '1 day', null, null, d + 1, wk + interval '1 day');
  if r <> 'capped' then raise exception 'FAIL the week''s cap of 3 holds: %', r; end if;
  raise notice 'ok   the week''s cap holds across days';

  -- The settings as they are now: fewer, a fit floor, off, paused.
  update public.career_alert_prefs set prefs = p || '{"max_instant_per_day": 1, "max_per_week": 25, "min_fit": 70}'::jsonb, instant_sent_today = 0, sent_on = null where user_id = a;
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:6', 't', at + interval '2 days', null, 60, d + 2, wk) <> 'below_fit' then raise exception 'FAIL a fit under the floor'; end if;
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:7', 't', at + interval '2 days', null, null, d + 2, wk) <> 'below_fit' then raise exception 'FAIL no fit known under a floor'; end if;
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:8', 't', at + interval '2 days', null, 75, d + 2, wk) <> 'queued' then raise exception 'FAIL a fit over the floor'; end if;
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:9', 't', at + interval '2 days', null, 95, d + 2, wk) <> 'capped' then raise exception 'FAIL fewer: 1 a day'; end if;
  update public.career_alert_prefs set prefs = prefs || '{"on": false}'::jsonb where user_id = a;
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:10', 't', at + interval '3 days', null, 95, d + 3, wk) <> 'off' then raise exception 'FAIL alerts off'; end if;
  update public.career_alert_prefs set prefs = prefs || '{"on": true}'::jsonb where user_id = a;
  insert into public.career_watch_kv(user_id, key, value) values (a, 'career:account', '{"paused": true}');
  if public.career_alert_enqueue(a, 'alert:greenhouse:x:11', 't', at + interval '3 days', null, 95, d + 3, wk) <> 'off' then raise exception 'FAIL paused'; end if;
  if public.career_alert_enqueue(b, 'alert:greenhouse:x:1', 't', at, null, null, d, wk) <> 'off' then raise exception 'FAIL no settings, no alert'; end if;
  begin
    perform public.career_alert_enqueue(b, 'report:2026-11-03', 't', at, null, null, d, wk);
    raise exception 'FAIL only alert keys';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'ok   the settings now decide: fewer, a fit floor, off, paused, none';

  -- The window: held_at is set the first time a row is held, and stays when the person's message puts it back.
  insert into public.channel_contacts(contact, user_id, last_inbound_at) values ('wa:15550200001', b, at - interval '3 days');
  insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (b, 'receipt:ab-1', 'receipt', 'Applied.', at - interval '2 days') returning career_outbox.id into row_id;
  if (select held_at from public.career_outbox where career_outbox.id = row_id) is not null then raise exception 'FAIL a queued row is not held'; end if;
  update public.career_outbox set status = 'held' where career_outbox.id = row_id;
  if (select held_at from public.career_outbox where career_outbox.id = row_id) is null then raise exception 'FAIL a held row is marked'; end if;
  perform public.channel_inbound_seen('wa:15550200001', at, null, null);
  if (select status || '|' || (held_at is not null)::text from public.career_outbox where career_outbox.id = row_id) <> 'queued|true' then raise exception 'FAIL the mark stays when it is put back'; end if;
  raise notice 'ok   a held row keeps its mark when the person writes';

  -- The template budget: two claims against a budget of one on a day; a new day, a new budget.
  insert into public.channel_contacts(contact, user_id) values ('wa:15550200002', a);
  if not public.channel_template_claim('wa:15550200001', d, 1, at) then raise exception 'FAIL the first template'; end if;
  if public.channel_template_claim('wa:15550200002', d, 1, at) then raise exception 'FAIL the budget of one holds'; end if;
  if (select nudged_at from public.channel_contacts where contact = 'wa:15550200002') is not null then raise exception 'FAIL a refused claim records nothing'; end if;
  if not public.channel_template_claim('wa:15550200002', d + 1, 1, at + interval '1 day') then raise exception 'FAIL a new day'; end if;
  if public.channel_template_claim('wa:15550200009', d + 5, 5, at + interval '5 days') then raise exception 'FAIL an unknown contact claims nothing'; end if;
  raise notice 'ok   the template budget is claimed one at a time';

  insert into public.career_interviews(user_id, invite_key, source, interview_date, seen_at) values (a, repeat('a', 64), 'mail', d + 5, at);
  update public.career_interviews set moved_at = at, cancelled_at = at where user_id = a;
  raise notice 'ok   an interview can be marked moved or cancelled';

  if has_function_privilege('authenticated', 'public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.channel_template_claim(text, date, int, timestamptz)', 'execute') then
    raise exception 'FAIL service role only';
  end if;
  raise notice 'ok   service role only';
end $$;
rollback;
