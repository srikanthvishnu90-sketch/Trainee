-- Reverses 20261109120000_career_send_go_pause.sql: career_send_go as 20261031020000_career_outreach_r3.sql defines it,
-- without the account-pause check (a pause then stops the next claim only, not the rest of a batch already claimed).
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
