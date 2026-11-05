-- Reverses 20261105180000_career_claim_deadlock.sql: career_outreach_action_claim exactly as 20261027240000 left it (each
-- person's rows read without the per-person claim lock; a refused follow-up's thread updated inside the loop).
create or replace function public.career_outreach_action_claim(p_worker text, p_limit int, p_per_user int, p_now timestamptz, p_lease_seconds int)
returns setof public.career_outreach_actions language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.career_outreach_actions; t public.career_outreach_threads; why text; took int := 0; lim int := greatest(coalesce(p_limit, 1), 1);
  per int := greatest(coalesce(p_per_user, 1), 1); start uuid := gen_random_uuid(); cur uuid; u uuid; wrapped boolean := false; steps int := 0; took_before int; round_done boolean;
begin
 if p_worker is null or p_now is null or coalesce(p_lease_seconds, 0) < 1 then raise exception 'invalid action claim'; end if;
 -- A worker that died mid-action: back to approved, checked again by this claim. Taking it again never doubles the effect
 -- (the rail's enqueue answers already_queued for the same action and hash; the calendar event id comes from the action id).
 update public.career_outreach_actions set status = 'approved', result = 'lease expired; taken again (idempotent)',
   lease_owner = null, lease_until = null, updated_at = now()
  where id in (select id from public.career_outreach_actions where status = 'running' and lease_until < p_now
               order by lease_until limit 1000 for update skip locked);
 -- People in turn, from a random point round the user ids (each step one index probe on the approved partial index),
 -- p_per_user of each person's oldest approvals per pass: no person, however many approvals they hold, starves another.
 -- When a pass has gone round everyone and the call still has room, another pass fills it (fairness, never a cap: one
 -- person alone gets the whole call).
 <<passes>>
 loop
 took_before := took; cur := start; wrapped := false; steps := 0; round_done := false;
 loop
  steps := steps + 1;
  exit when took >= lim or steps > lim * 4 + 8;
  if not wrapped then select x.user_id into u from public.career_outreach_actions x where x.status = 'approved' and x.user_id >= cur and (steps = 1 or x.user_id > cur) order by x.user_id limit 1;
  else select x.user_id into u from public.career_outreach_actions x where x.status = 'approved' and x.user_id > cur and x.user_id < start order by x.user_id limit 1; end if;
  if u is null then
   if wrapped then round_done := true; exit; end if;
   wrapped := true; cur := '00000000-0000-0000-0000-000000000000'::uuid;
   select x.user_id into u from public.career_outreach_actions x where x.status = 'approved' and x.user_id >= cur and x.user_id < start order by x.user_id limit 1;
   if u is null then round_done := true; exit; end if;
  end if;
  cur := u;
  for a in select x.* from public.career_outreach_actions x where x.user_id = u and x.status = 'approved'
    order by x.approved_at, x.n limit per for update skip locked loop
   select * into t from public.career_outreach_threads where id = a.thread_id;
   why := null;
   if a.approved_hash is null or a.approved_hash <> a.hash then why := 'changed';
   elsif a.kind <> 'calendar_event' and exists (select 1 from public.career_outreach_dnc d where d.email_hash = public.career_outreach_email_hash(t.recipient_email)) then why := 'do_not_contact';
   elsif exists (select 1 from public.career_send_bad_addresses b where b.email_hash = public.career_send_email_hash(t.recipient_email)) then why := 'bad_address';
   elsif t.status in ('not_interested', 'bounced') then why := 'do_not_contact';
   elsif a.kind = 'followup' and (t.replied_at is not null or t.status not in ('awaiting', 'out_of_office')) then why := 'replied';
   elsif a.kind = 'followup' and (t.followup_state in ('off', 'done') or coalesce(a.step, 0) <= t.followups_sent
     or exists (select 1 from public.career_outreach_actions o where o.thread_id = a.thread_id and o.kind = 'followup' and (o.status = 'running' or (o.status = 'done' and o.step = a.step)) and o.id <> a.id)) then why := 'already_followed_up';
   elsif a.kind = 'schedule_reply' and t.status not in ('wants_call', 'interested', 'call_proposed') then why := 'no_call_wanted';
   elsif a.kind = 'calendar_event' and exists (select 1 from public.career_outreach_actions o where o.thread_id = a.thread_id and o.kind = 'calendar_event' and o.status in ('running', 'done') and o.id <> a.id) then why := 'already_created';
   end if;
   if why is not null then
    update public.career_outreach_actions set status = 'refused', result = why, updated_at = now() where id = a.id;
    if a.kind = 'followup' then update public.career_outreach_threads set followup_state = 'off', updated_at = now() where id = a.thread_id and followup_state in ('none', 'drafted'); end if;
    continue;
   end if;
   if a.kind = 'followup' and t.ooo_until is not null and t.ooo_until + interval '1 day' > p_now then continue; end if;
   exit when took >= lim;
   update public.career_outreach_actions set status = 'running', lease_owner = p_worker, lease_until = p_now + make_interval(secs => p_lease_seconds), updated_at = now()
    where id = a.id returning * into a;
   took := took + 1;
   return next a;
  end loop;
 end loop;
 -- Only a pass that went round everyone may start another: one cut short (rows other workers hold) never gives a person a second share.
 exit passes when took >= lim or took = took_before or not round_done;
 end loop;
end $$;
revoke all on function public.career_outreach_action_claim(text, int, int, timestamptz, int) from public, anon, authenticated;
grant execute on function public.career_outreach_action_claim(text, int, int, timestamptz, int) to service_role;
