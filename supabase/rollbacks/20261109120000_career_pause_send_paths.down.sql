-- Reverses 20261109120000_career_pause_send_paths.sql: career_send_go as 20261031020000_career_outreach_r3.sql defines it and
-- career_outreach_action_claim as 20261105180000_career_claim_deadlock.sql defines it, neither reading the account pause.
create or replace function public.career_send_go(p jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.career_send_queue;
begin
  if p->>'worker' is null or p->>'id' is null then raise exception 'invalid send check'; end if;
  -- FOR SHARE: a disconnect in progress holds the row; this waits for it, then sees the email cancelled.
  select * into q from public.career_send_queue where id = (p->>'id')::uuid for share;
  if not found or q.state <> 'sending' or q.lease_owner is distinct from p->>'worker' then return 'stop'; end if;
  if not exists (select 1 from public.user_oauth_connections c where c.user_id = q.user_id and c.provider = public.career_send_connection(q.provider))
     or exists (select 1 from public.career_send_accounts a where a.user_id = q.user_id and a.provider = q.provider and a.state = 'disconnected') then
    return 'stop';
  end if;
  -- (4) What came back since the claim: an opt-out or a bounce of this address (anyone's), or an answer on this
  -- follow-up's sequence. The email is handed back untried; the next claim cancels it and says why.
  if exists (select 1 from public.career_outreach_dnc where email_hash = public.career_send_email_hash(q.recipient_email))
     or exists (select 1 from public.career_send_bad_addresses where email_hash = public.career_send_email_hash(q.recipient_email)) then
    return 'stop';
  end if;
  if q.follow_up_of is not null and (
       exists (select 1 from public.career_send_queue r where r.id = q.follow_up_of and r.state <> 'sent')
       or exists (select 1 from public.career_send_queue f where f.follow_up_of = q.follow_up_of and f.id <> q.id and f.state in ('replied', 'bounced'))) then
    return 'stop';
  end if;
  return 'go';
end $$;
revoke all on function public.career_send_go(jsonb) from public, anon, authenticated;
grant execute on function public.career_send_go(jsonb) to service_role;

create or replace function public.career_outreach_action_claim(p_worker text, p_limit int, p_per_user int, p_now timestamptz, p_lease_seconds int)
returns setof public.career_outreach_actions language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.career_outreach_actions; t public.career_outreach_threads; why text; took int := 0; lim int := greatest(coalesce(p_limit, 1), 1);
  per int := greatest(coalesce(p_per_user, 1), 1); start uuid := gen_random_uuid(); cur uuid; u uuid; wrapped boolean := false; steps int := 0; took_before int; round_done boolean;
  held_any boolean := false; busy uuid; waited boolean := false; ends uuid[] := '{}'; end_threads uuid[] := '{}'; end_results text[] := '{}'; end_at timestamptz[] := '{}'; ok_threads uuid[]; i int;
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
 -- (3) A claim that found nothing else to do waits once for a person another claim holds (it holds no person itself then,
 -- so no claim ever waits for a claim that waits for it), then goes round again.
 <<attempt>>
 loop
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
  -- (1) One claim at a time per person: taken before the person's rows are read, so the read sees every earlier claim of
  -- this person committed and never meets (or locks) a row another claim leased. A person another claim holds now is
  -- passed over, as rows it holds were (skip locked).
  if not pg_try_advisory_xact_lock(hashtextextended('career_outreach_action_claim:' || u::text, 0)) then
   busy := coalesce(busy, u);
   continue;
  end if;
  held_any := true;
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
    -- (2) A refused follow-up also ends its thread's sequence: at the end of the claim, below.
    if a.kind = 'followup' then ends := ends || a.id; end_threads := end_threads || a.thread_id; end_results := end_results || a.result; end_at := end_at || a.updated_at; end if;
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
 exit attempt when took > 0 or held_any or busy is null or waited;
 perform pg_advisory_xact_lock(hashtextextended('career_outreach_action_claim:' || busy::text, 0));
 waited := true;
 end loop;
 -- (2) Each refused follow-up's thread sequence ends (in this transaction, as before). The threads are locked in id order
 -- and never waited for: a refused follow-up whose thread another transaction holds right now goes back to approved exactly
 -- as it was (nobody saw it refused), refused by the next claim. So the claim never waits while it holds rows.
 if cardinality(ends) > 0 then
  ok_threads := array(select x.id from public.career_outreach_threads x where x.id = any(end_threads) order by x.id for update skip locked);
  for i in 1 .. cardinality(ends) loop
   if end_threads[i] = any(ok_threads) then
    update public.career_outreach_threads set followup_state = 'off', updated_at = now() where id = end_threads[i] and followup_state in ('none', 'drafted');
   else
    update public.career_outreach_actions set status = 'approved', result = end_results[i], updated_at = end_at[i] where id = ends[i];
   end if;
  end loop;
 end if;
end $$;
revoke all on function public.career_outreach_action_claim(text, int, int, timestamptz, int) from public, anon, authenticated;
grant execute on function public.career_outreach_action_claim(text, int, int, timestamptz, int) to service_role;
