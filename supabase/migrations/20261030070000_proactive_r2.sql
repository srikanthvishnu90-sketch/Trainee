-- PROACTIVE SCENARIOS, ROUND 2 (2026-10-30; tests/architect/scenarios-proactive-r2.test.ts, 10,000 generated scenarios,
-- and tests/architect/flow-scenarios-proactive-r2.test.ts, people on Postgres through career-proactive and trainee-deliver
-- with runs forced to overlap). What the database let through:
--   1. Two scheduled alerts runs at once that read the boards at different moments each planned the person's whole day
--      from the same counters and each queued it: a cap of 3 a day became 6 (round 1's "not fixed"). And a person who
--      turned alerts off, asked for fewer, raised their fit floor or paused while a run was going got everything that run
--      had planned from the settings it read at its start. career_alert_enqueue (new) queues one job alert with the person's
--      alert row locked: their settings as they are at that moment (on, the day's and the week's cap, the fit floor, the
--      account not quiet), the day's count kept in the same transaction. The run writes its other counters as before and
--      never the day's count.
--   2. career_outbox.alert_fit (new): the fit an alert was queued with, so delivery holds an alert below a fit floor the
--      person raised after it was queued.
--   3. career_outbox.held_at (new, set by a trigger the first time a row is held): a row WhatsApp's 24-hour window held.
--      Round 1 kept every WhatsApp row out of the 48-hour stale rule (a held row goes out whole when the person writes,
--      WO-038/W5), so a web-only person who connected WhatsApp days later got the whole backlog of stale alerts and
--      reports. Now only a row that was held is exempt.
--   4. channel_template_claim (new): the waiting-updates template budget (WHATSAPP_DAILY_TEMPLATES) claimed one template
--      at a time, counted and recorded together under one lock per day. Each delivery run read the day's count once and
--      counted on from there, so two runs at once each sent up to the whole budget.
--   5. career_interviews.moved_at and cancelled_at (new): an interview a later email moved or cancelled gets no thank-you
--      and no nudge for that date.
-- Additive and idempotent; service role only.

alter table public.career_outbox add column if not exists alert_fit smallint;
alter table public.career_outbox drop constraint if exists career_outbox_alert_fit;
alter table public.career_outbox add constraint career_outbox_alert_fit check (alert_fit is null or (alert_fit between 0 and 100));
alter table public.career_outbox add column if not exists held_at timestamptz;

create or replace function public.career_outbox_held_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status = 'held' and new.held_at is null then new.held_at := now(); end if;
  return new;
end $$;
drop trigger if exists career_outbox_held_at on public.career_outbox;
create trigger career_outbox_held_at before insert or update of status on public.career_outbox
  for each row when (new.status = 'held') execute function public.career_outbox_held_at();

alter table public.career_interviews add column if not exists moved_at timestamptz;
alter table public.career_interviews add column if not exists cancelled_at timestamptz;

-- One job alert, queued only while the person's settings as they are now have room for it. Answers 'queued', or why not:
-- 'duplicate' (that key was queued before), 'capped' (no room today or in the rolling week), 'below_fit', 'off' (alerts
-- off or no settings, or the account paused, stopped or gone). p_day is the person's local day the run counts against.
create or replace function public.career_alert_enqueue(p_user uuid, p_key text, p_text text, p_at timestamptz, p_first_seen timestamptz,
  p_fit int, p_day date, p_week_since timestamptz) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_alert_prefs; today int; cap int; week_cap int; min_fit int; n int;
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
  week_cap := greatest(0, least(25, case when (r.prefs->>'max_per_week') ~ '^[0-9]+$' then (r.prefs->>'max_per_week')::int else 15 end));
  select count(*) into n from public.career_outbox where user_id = p_user and kind = 'alert' and deliver_at >= p_week_since;
  if n >= week_cap then return 'capped'; end if;
  insert into public.career_outbox (user_id, key, kind, text, deliver_at, posting_first_seen_at, alert_fit)
  values (p_user, p_key, 'alert', p_text, p_at, p_first_seen, case when p_fit between 0 and 100 then p_fit end)
  on conflict (user_id, key) do nothing;
  if not found then return 'duplicate'; end if;
  update public.career_alert_prefs set instant_sent_today = today + 1, sent_on = p_day, updated_at = now() where user_id = p_user;
  return 'queued';
end $$;

-- One waiting-updates template against the day's budget (the WhatsApp contacts nudged that UTC day, as nudgesOn counts
-- them), recorded on the contact in the same step, and one per silence: never again to a contact already nudged since its
-- last message (two runs at once each held rows of the same person and each sent the template). true: claimed; false:
-- the budget is spent, the person was already told, or the contact is unknown.
create or replace function public.channel_template_claim(p_contact text, p_day date, p_cap int, p_at timestamptz) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare used int;
begin
  perform pg_advisory_xact_lock(hashtext('channel_template_claim'), hashtext(p_day::text));
  if exists (select 1 from public.channel_contacts where contact = p_contact and nudged_at is not null
             and (last_inbound_at is null or nudged_at >= last_inbound_at)) then return false; end if;
  select count(*) into used from public.channel_contacts
    where channel = 'whatsapp' and nudged_at >= (p_day::timestamp at time zone 'UTC') and nudged_at < ((p_day + 1)::timestamp at time zone 'UTC');
  if used >= greatest(p_cap, 0) then return false; end if;
  update public.channel_contacts set nudged_at = p_at where contact = p_contact;
  return found;
end $$;

revoke all on function public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz),
  public.channel_template_claim(text, date, int, timestamptz), public.career_outbox_held_at() from public, anon, authenticated;
grant execute on function public.career_alert_enqueue(uuid, text, text, timestamptz, timestamptz, int, date, timestamptz),
  public.channel_template_claim(text, date, int, timestamptz) to service_role;
