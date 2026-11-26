-- Rollback of 20261113150000_career_outreach_adopt_skip_mail_reply.sql: career_outreach_threads_adopt exactly as 20261027240000
-- defined it (every sent draft is adopted, a mail reply included). Roll back only together with the code that writes mail replies
-- as their own kind; nothing is deleted either way.
create or replace function public.career_outreach_threads_adopt(p_limit int)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; n int := 0;
begin
 for d in select x.* from public.career_outreach_drafts x
   where x.status in ('sent', 'replied', 'bounced') and x.gmail_thread is not null and x.sent_at is not null
     and not exists (select 1 from public.career_outreach_threads t where t.draft_id = x.id)
   order by x.sent_at limit greatest(coalesce(p_limit, 1), 1) loop
  perform public.career_outreach_thread_track(d.user_id, d.id,
    coalesce((select q.provider from public.career_send_queue q where q.user_id = d.user_id and q.recipient_email = lower(d.recipient_email)
      and q.kind = 'outreach' and q.source_id = d.id limit 1), 'gmail'), d.gmail_thread, d.recipient_email,
    coalesce(d.recipient->>'name', ''), coalesce(d.recipient->>'firm', ''), d.subject, d.sent_at, nullif(d.recipient->>'tz', ''));
  n := n + 1;
 end loop;
 -- Emails this lane handed to the rail: once the rail has sent one, its provider thread becomes the conversation's alias;
 -- one the rail never sent (refused, cancelled, failed) is recorded on the action so the person's view says so.
 for d in select a.id, a.user_id, a.thread_id, q.provider, q.state, q.gmail_thread, q.result from public.career_outreach_actions a
   join public.career_send_queue q on a.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and q.id = a.provider_ref::uuid
   where a.status = 'done' and a.kind in ('followup', 'schedule_reply') and a.rail_seen_at is null
     and q.state in ('sent', 'replied', 'bounced', 'refused', 'cancelled', 'failed')
   order by a.done_at limit greatest(coalesce(p_limit, 1), 1) loop
  if d.gmail_thread is not null then
   insert into public.career_outreach_thread_aliases(user_id, provider, provider_thread, thread_id)
   values (d.user_id, d.provider, d.gmail_thread, d.thread_id) on conflict do nothing;
  end if;
  update public.career_outreach_actions set rail_seen_at = now(), updated_at = now(),
    result = case when d.state in ('refused', 'cancelled', 'failed') then left('not sent by the rail: ' || coalesce(d.result, d.state), 300) else result end
   where id = d.id;
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function public.career_outreach_threads_adopt(int) from public, anon, authenticated;
grant execute on function public.career_outreach_threads_adopt(int) to service_role;
