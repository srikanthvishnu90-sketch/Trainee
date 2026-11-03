-- What comes back after an outreach email is sent (owner rules, 2026-10-29; REPLY SCENARIOS,
-- tests/architect/scenarios-replies.test.ts, ~10,000 generated messages and 240 end to end on Postgres). Two functions of
-- 20261027240000_career_outreach_replies.sql again, each changed only as said:
--   career_outreach_reply_apply
--     1. An opt-out or a bounce read by the replies lane cancels EVERY email still queued to that address on the sending
--        rail, anyone's, at once, as the rail's own career_send_record does when its reply check reads it first. Before,
--        only the rail rows of this thread's own actions were taken back; the rest stayed "queued" (counted as waiting to
--        go) until a claim found the address on the list.
--     2. An out-of-office with a return date delays the sequence on the rail too: a follow-up the person approved that is
--        already queued to that address waits until the day after the return date (follow-ups not yet drafted or claimed
--        already wait: career_outreach_followups_due, career_outreach_action_claim). An auto-reply never stops it.
--   career_outreach_rail_takeback
--     3. A follow-up the rail cancelled before it went (its reply check read the answer first and stopped the sequence)
--        is not sent either: its action is marked cancelled and it is not counted in followups_sent, whichever lane read
--        the answer first. Before, the count kept it when the rail got there first.
-- Everything else is exactly as before. Idempotent (create or replace); the grants are the same.

create or replace function public.career_outreach_rail_takeback(p_thread uuid, p_followups_only boolean, p_why text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare k int; k2 int;
begin
 with q as (
  update public.career_send_queue set state = 'cancelled', result = left(p_why, 300), updated_at = now()
  where state = 'queued' and kind = 'general' and id in (select x.provider_ref::uuid from public.career_outreach_actions x
    where x.thread_id = p_thread and x.status = 'done' and x.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and (not p_followups_only or x.kind = 'followup'))
  returning source_id
 ), a as (
  update public.career_outreach_actions x set status = 'cancelled', result = left('not sent: ' || p_why, 300), updated_at = now()
  from q where x.id = q.source_id returning x.kind
 )
 select count(*) filter (where kind = 'followup') into k from a;
 -- (3) What the rail itself already cancelled before it was ever sent.
 with a as (
  update public.career_outreach_actions x set status = 'cancelled', result = left('not sent: ' || coalesce(s.result, p_why), 300), updated_at = now()
  from public.career_send_queue s
  where x.thread_id = p_thread and x.status = 'done' and x.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (not p_followups_only or x.kind = 'followup')
    and s.id = x.provider_ref::uuid and s.kind = 'general' and s.state = 'cancelled' and s.sent_at is null
  returning x.kind
 )
 select count(*) filter (where kind = 'followup') into k2 from a;
 k := k + k2;
 if k > 0 then
  update public.career_outreach_threads set followups_sent = greatest(followups_sent - k, 0), updated_at = now() where id = p_thread;
 end if;
 return k;
end $$;
revoke all on function public.career_outreach_rail_takeback(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.career_outreach_rail_takeback(uuid, boolean, text) to service_role;

create or replace function public.career_outreach_reply_apply(p_user uuid, p_thread uuid, p_msg text, p_class text, p_at timestamptz, p_detail jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.career_outreach_threads; n int; d jsonb := coalesce(p_detail, '{}'::jsonb); s text; back timestamptz; k int;
begin
 if p_class not in ('interested', 'wants_call', 'confirms_time', 'not_interested', 'out_of_office', 'bounce', 'referral', 'other') then
  raise exception 'unknown reply class'; end if;
 select * into t from public.career_outreach_threads where id = p_thread and user_id = p_user for update;
 if not found then raise exception 'no such outreach thread'; end if;
 insert into public.career_outreach_turns(thread_id, provider_msg, user_id, who, class, summary, asks, commitments, at)
  values (p_thread, p_msg, p_user, case when p_class = 'bounce' then 'system' else coalesce(nullif(d->>'who', ''), 'contact') end, p_class, left(d->>'summary', 400),
   case when jsonb_typeof(d->'asks') = 'array' then d->'asks' else '[]'::jsonb end,
   case when jsonb_typeof(d->'commitments') = 'array' then d->'commitments' else '[]'::jsonb end, coalesce(p_at, now()))
  on conflict do nothing;
 get diagnostics n = row_count;
 if n = 0 then return 'seen'; end if;
 -- The conversation's running state, as code computed it from every turn (the caller's merge): written on every turn.
 update public.career_outreach_threads set turns = turns + 1,
  open_asks = case when jsonb_typeof(d->'conversation'->'open_asks') = 'array' then d->'conversation'->'open_asks' else open_asks end,
  commitments = case when jsonb_typeof(d->'conversation'->'commitments') = 'array' then d->'conversation'->'commitments' else commitments end,
  next_step = coalesce(left(d->'conversation'->>'next_step', 300), next_step), updated_at = now()
  where id = p_thread;
 if t.status in ('not_interested', 'bounced') then return 'terminal'; end if;
 if p_class in ('not_interested', 'bounce') then
  insert into public.career_outreach_dnc(user_id, email_hash, reason, at)
   values (p_user, public.career_outreach_email_hash(t.recipient_email), case when p_class = 'bounce' then 'bounced: the address does not work' else 'recipient asked to stop' end, now())
   on conflict (user_id, email_hash) do nothing;
  if p_class = 'bounce' then
   insert into public.career_send_bad_addresses(email_hash, reason) values (public.career_send_email_hash(t.recipient_email), 'bounced')
   on conflict (email_hash) do nothing;
  end if;
  update public.career_outreach_actions set status = 'cancelled', result = 'cancelled: ' || p_class, lease_owner = null, lease_until = null, updated_at = now()
   where thread_id = p_thread and status in ('shown', 'approved');
  k := public.career_outreach_rail_takeback(p_thread, false, case when p_class = 'bounce' then 'bad_address' else 'opted_out' end);
  -- (1) Every other email still queued to the address, anyone's, never goes.
  update public.career_send_queue set state = 'cancelled', result = case when p_class = 'bounce' then 'bad_address' else 'opted_out' end, updated_at = now()
   where recipient_email = t.recipient_email and state = 'queued';
  s := case when p_class = 'bounce' then 'bounced' else 'not_interested' end;
  update public.career_outreach_threads set status = s, status_at = now(), replied_at = case when p_class = 'bounce' then replied_at else coalesce(replied_at, p_at) end,
   followup_state = case when followup_state = 'done' and k = 0 then 'done' else 'off' end, summary = left(coalesce(d->>'summary', summary), 400), updated_at = now()
   where id = p_thread;
  return s;
 end if;
 if p_class = 'out_of_office' then
  back := case when coalesce(d->>'return_at', '') ~ '^\d{4}-\d{2}-\d{2}' then (d->>'return_at')::timestamptz else null end;
  if t.status in ('awaiting', 'out_of_office') then
   update public.career_outreach_threads set status = 'out_of_office', status_at = now(), ooo_until = coalesce(back, ooo_until),
    summary = left(coalesce(d->>'summary', summary), 400), updated_at = now() where id = p_thread;
   -- (2) A follow-up of this person's already queued to the address waits past the return date (never earlier than it was).
   if back is not null then
    update public.career_send_queue q set next_at = greatest(q.next_at, back + interval '1 day'), updated_at = now()
     where q.user_id = p_user and q.recipient_email = t.recipient_email and q.state = 'queued'
       and (q.follow_up_of is not null or q.id in (select x.provider_ref::uuid from public.career_outreach_actions x
         where x.thread_id = p_thread and x.kind = 'followup' and x.status = 'done' and x.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
   end if;
   return 'out_of_office';
  end if;
  return t.status;
 end if;
 -- A person answered: no follow-up after this, ever.
 update public.career_outreach_actions set status = 'cancelled', result = 'cancelled: they replied', lease_owner = null, lease_until = null, updated_at = now()
  where thread_id = p_thread and kind = 'followup' and status in ('shown', 'approved');
 -- and a follow-up already handed to the rail but not sent yet never goes (and is not counted as sent).
 k := public.career_outreach_rail_takeback(p_thread, true, 'they replied');
 s := case
  when p_class = 'confirms_time' then (case when t.status in ('call_proposed', 'call_scheduled') then t.status else 'wants_call' end)
  when t.status = 'call_scheduled' then 'call_scheduled'
  when t.status = 'call_proposed' and p_class in ('wants_call', 'interested', 'other') then 'call_proposed'
  else p_class end;
 update public.career_outreach_threads set status = s, status_at = now(), replied_at = coalesce(replied_at, p_at), ooo_until = null,
  followup_state = case when followup_state = 'done' and k = 0 then 'done' else 'off' end,
  summary = left(coalesce(d->>'summary', summary), 400),
  referral = case when p_class = 'referral' and jsonb_typeof(d->'referral') = 'object' then d->'referral' else referral end,
  their_times = case when jsonb_typeof(d->'their_times') = 'array' then d->'their_times' else their_times end,
  contact_tz = coalesce(nullif(d->>'contact_tz', ''), contact_tz),
  updated_at = now()
  where id = p_thread;
 return s;
end $$;
revoke all on function public.career_outreach_reply_apply(uuid, uuid, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.career_outreach_reply_apply(uuid, uuid, text, text, timestamptz, jsonb) to service_role;
