-- D-075 (review of #790, round 3, item 5): an approved hosted application is stopped when a fact it states is set aside or corrected.
--
-- An approved application carries the answers it was prepared with (career_apply_jobs.payload, frozen under payload_hash). Nothing
-- on the hosted path read the person's facts again, so after "the 3.9 gpa is outdated" (code sets the fact aside) or a correction
-- (correct_profile_fact) the approved row stating the old value was still claimed and sent. The person's own engine already refuses
-- (checkSubmitGuards: stale_packet_facts). The rule: facts about the person come only from facts they confirmed (D-007), and nothing
-- is sent without their yes to that exact application.
--
--   1. career_apply_stop_stale_facts(p_user, p_values, p_reason), called by the chat turn that changed the fact (service role only),
--      modelled on career_apply_cancel_for and career_resume_stop_unbound: under the person's locks (the claims take the same), for
--      that person only, every approved application not yet started (queued, attempts = 0, unclaimed) whose payload states one of
--      the values is closed not_submitted, unsent; every prepared application not yet approved (ready, shown) stating one is removed
--      with its tries, and an open card showing it is closed (a tap approves nothing). A queued row already tried, and one being
--      sent now, are not touched and are returned (started, being_sent). Returns what was stopped, with the employers.
--   2. The race (the chat's call fails, or a row is prepared or re-queued around it) is closed where every claim passes: the change
--      is recorded per person (career_apply_fact_changes: when, which values), each prepared row and each approved row carries the
--      time its facts were read (facts_at: the prepare, else the approval), and the trigger career_apply_facts_claim_guard refuses
--      the start of a drive (queued -> driving, whatever claim function asks) on a row whose facts_at is older than a change whose
--      value its payload states: the row is closed not_submitted with the reason, and the claim is handed nothing for it.
--      A stopped application comes back only through a new approval (which stamps facts_at again); putting the fact back re-queues
--      nothing.
-- "States a value": some text or number anywhere in the payload holds the value as a whole word (case-insensitive; "3.9" is not in
-- "3.95" or "13.9"). Over-matching stops an application that then needs a fresh yes; it never sends one.
-- Additive and reversible (supabase/rollbacks/20261113140000_career_apply_stop_stale_facts.down.sql). Idempotent.

create table if not exists public.career_apply_fact_changes (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 at timestamptz not null default clock_timestamp(),
 fact_values text[] not null check (cardinality(fact_values) between 1 and 40),
 reason text not null check (reason ~ '^[a-z_]{1,40}$')
);
create index if not exists career_apply_fact_changes_user_at on public.career_apply_fact_changes (user_id, at desc);
alter table public.career_apply_fact_changes enable row level security; -- no policy: the functions below only
revoke all on public.career_apply_fact_changes from public, anon, authenticated;
grant all on public.career_apply_fact_changes to service_role;

alter table public.career_apply_prepared add column if not exists facts_at timestamptz;
alter table public.career_apply_jobs add column if not exists facts_at timestamptz;
-- Rows from before this file keep facts_at null: it reads as the time they were made (created_at).

-- Does the payload state one of the values? Every text and number in it, the value as a whole word.
create or replace function public.career_apply_payload_states(p_payload jsonb, p_values text[]) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select exists (
  select from jsonb_path_query(coalesce(p_payload, '{}'::jsonb), 'strict $.** ? (@.type() == "string" || @.type() == "number")') s(v)
  cross join unnest(coalesce(p_values, '{}')) as w(val)
  where length(btrim(w.val)) >= 2
   and (s.v #>> '{}') ~* ('(^|[^[:alnum:]])' || regexp_replace(btrim(w.val), '([^[:alnum:][:space:]])', '\\\1', 'g') || '($|[^[:alnum:]])'))
$$;
revoke all on function public.career_apply_payload_states(jsonb, text[]) from public, anon, authenticated;

-- facts_at: when the facts a row carries were read. A prepared row: when it was prepared (again). An approved row: its prepared
-- row's time, else the approval's; stamped again only by a new approval of a row that was not sent.
create or replace function public.career_apply_facts_at_stamp() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if tg_table_name = 'career_apply_prepared' then
  if tg_op = 'INSERT' or new.payload_hash is distinct from old.payload_hash or (new.state = 'ready' and old.state not in ('ready', 'shown')) then
   new.facts_at := clock_timestamp();
  else new.facts_at := coalesce(old.facts_at, old.created_at); end if;
  return new;
 end if;
 if tg_op = 'INSERT' or new.payload_hash is distinct from old.payload_hash or new.approval_hash is distinct from old.approval_hash
    or (old.state = 'not_submitted' and new.state = 'queued') then
  new.facts_at := coalesce((select max(coalesce(p.facts_at, p.created_at)) from public.career_apply_prepared p
   where p.user_id = new.user_id and p.job_id = new.job_id and p.payload_hash = new.payload_hash), clock_timestamp());
 else new.facts_at := coalesce(old.facts_at, old.created_at); end if;
 return new;
end $$;
revoke all on function public.career_apply_facts_at_stamp() from public, anon, authenticated; -- trigger function
drop trigger if exists career_apply_facts_at_stamp on public.career_apply_prepared;
create trigger career_apply_facts_at_stamp before insert or update on public.career_apply_prepared
 for each row execute function public.career_apply_facts_at_stamp();
drop trigger if exists career_apply_facts_at_stamp on public.career_apply_jobs;
create trigger career_apply_facts_at_stamp before insert or update on public.career_apply_jobs
 for each row execute function public.career_apply_facts_at_stamp();

-- The one close both the chat's stop and the claim guard use: not sent, with the reason, unclaimed.
create or replace function public.career_apply_fact_changed_close(p_id uuid, p_at timestamptz, p_by text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 update public.career_apply_jobs set state = 'not_submitted', reason = 'not sent: a fact it states changed after you approved it',
  lease_token = null, claimed_at = null,
  evidence = evidence || jsonb_build_object('reason', 'fact_changed', 'nothing_sent', true, 'fact_changed_at', p_at, 'stopped_by', p_by, 'stopped_at', clock_timestamp()),
  updated_at = clock_timestamp()
  where id = p_id and state = 'queued';
end $$;
revoke all on function public.career_apply_fact_changed_close(uuid, timestamptz, text) from public, anon, authenticated;

-- Every claim's start of a drive (queued -> driving) passes here. A row whose facts were read before a change of a value it states
-- is not started: it is closed not_submitted with the reason and the claim's own update of it is skipped.
create or replace function public.career_apply_facts_claim_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare changed timestamptz;
begin
 select max(c.at) into changed from public.career_apply_fact_changes c
  where c.user_id = old.user_id and c.at >= coalesce(old.facts_at, old.created_at) and public.career_apply_payload_states(old.payload, c.fact_values);
 if changed is null then return new; end if;
 perform public.career_apply_fact_changed_close(old.id, changed, 'claim');
 return null;
end $$;
revoke all on function public.career_apply_facts_claim_guard() from public, anon, authenticated; -- trigger function
drop trigger if exists career_apply_facts_claim_guard on public.career_apply_jobs;
create trigger career_apply_facts_claim_guard before update on public.career_apply_jobs
 for each row when (new.state = 'driving' and old.state = 'queued')
 execute function public.career_apply_facts_claim_guard();

-- The chat's stop, in the turn that set the fact aside or corrected it.
create or replace function public.career_apply_stop_stale_facts(p_user uuid, p_values text[], p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare vals text[]; at_ timestamptz; ids uuid[]; cancelled jsonb; discarded jsonb; started jsonb; being_sent jsonb; r record;
begin
 vals := array(select distinct left(btrim(v), 300) from unnest(coalesce(p_values, '{}')) v where length(btrim(v)) >= 2 limit 40);
 if p_user is null or cardinality(vals) = 0 or coalesce(p_reason, '') !~ '^[a-z_]{1,40}$' then raise exception 'invalid fact change'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 at_ := clock_timestamp();
 -- The record every later claim reads: first, so a row this call does not reach is still refused at its claim.
 insert into public.career_apply_fact_changes (user_id, at, fact_values, reason) values (p_user, at_, vals, p_reason);
 -- Prepared, not yet approved.
 ids := array(select id from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown') and public.career_apply_payload_states(payload, vals));
 select coalesce(jsonb_agg(jsonb_build_object('id', id, 'company', company) order by created_at), '[]'::jsonb) into discarded
  from public.career_apply_prepared where id = any(ids);
 update public.career_apply_cards c set state = 'answered', answered_at = clock_timestamp(), answer = '{"closed":"a fact it states changed"}'
  where c.user_id = p_user and c.state = 'open' and exists (select from jsonb_array_elements(c.items) it where (it->>'prepared_id')::uuid = any(ids));
 delete from public.career_apply_prepare_attempts where user_id = p_user and prepared_id = any(ids);
 delete from public.career_apply_prepared where id = any(ids);
 -- Approved: not yet started ones are closed unsent; started ones are reported as they are.
 cancelled := '[]'::jsonb; started := '[]'::jsonb; being_sent := '[]'::jsonb;
 for r in select id, company, state, attempts, lease_token from public.career_apply_jobs
   where user_id = p_user and state in ('queued', 'driving') and public.career_apply_payload_states(payload, vals) order by created_at for update loop
  if r.state = 'queued' and r.attempts = 0 and r.lease_token is null then
   perform public.career_apply_fact_changed_close(r.id, at_, 'chat');
   cancelled := cancelled || jsonb_build_object('id', r.id, 'company', r.company);
  elsif r.state = 'queued' then started := started || jsonb_build_object('id', r.id, 'company', r.company);
  else being_sent := being_sent || jsonb_build_object('id', r.id, 'company', r.company); end if;
 end loop;
 if jsonb_array_length(cancelled) + jsonb_array_length(discarded) + jsonb_array_length(started) + jsonb_array_length(being_sent) > 0 then
  insert into public.career_events (user_id, kind, subject, detail, source)
  values (p_user, 'note', 'fact changed: applications stating it stopped',
   jsonb_build_object('why', p_reason, 'cancelled', jsonb_array_length(cancelled), 'discarded', jsonb_array_length(discarded),
    'started', jsonb_array_length(started), 'being_sent', jsonb_array_length(being_sent)), 'apply');
 end if;
 return jsonb_build_object('cancelled', cancelled, 'discarded', discarded, 'started', started, 'being_sent', being_sent, 'at', at_);
end $$;
revoke all on function public.career_apply_stop_stale_facts(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.career_apply_stop_stale_facts(uuid, text[], text) to service_role;
