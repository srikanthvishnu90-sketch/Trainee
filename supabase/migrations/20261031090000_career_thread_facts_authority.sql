-- TAILORING ROUND 3 (2026-11-02): a corrected fact makes every approval stamped before it stale, for every person.
--
-- Why: an application payload is current (career_apply_current, which every prepare, card yes, queue, sweep and claim
-- checks) while nothing it depends on changed after it was stamped: its account_version >= the account's
-- authority_version. 20261026090009 moves authority_version when the CONFIRMED profile facts held on the account change.
-- But a person who uses only the web keeps their profile per thread (career_account_memory.ts accountMemoryOn: account
-- scope needs a texting contact or memory already on the account), and the profile applications are prepared from is the
-- thread's (career_apply_profile_for reads agent_flow_state). So for them a correction after the
-- yes ("actually my GPA is 3.9", PR #372), moved nothing: a payload made with GPA 3.7 stayed current and its yes would
-- queue it. Found by tests/architect/flow-scenarios-tailoring-r3.test.ts on Postgres (6 of 6 corrections).
--
-- What changes:
-- 1. career_thread_facts_authority (AFTER UPDATE OF state ON agent_flow_state): when a value the thread already held as
--    confirmed changes or is withdrawn (a confirmed fact's words, by fact id, or a profile basic, by key), the account row
--    records a new mark for that thread (under value->'thread_facts'->'<thread id>'; an md5, no fact text). Only that
--    moves anything. A fact confirmed for the first time, a new basic, a new thread (an insert), drafts, frames, the
--    tracker, a card shown, a fact's own bookkeeping (provenance, confirmation ids, timestamps, the corrections audit) and
--    every other part of the thread's state never do: no approval was made from a value that did not exist yet. A turn in
--    one thread never changes another thread's mark. A thread backed by the account (account_memory = 1) is skipped: it
--    holds a copy of the account's profile, whose confirmed facts already move authority, and 20261031050000 clears such
--    copies in other threads.
--    (PR #403 CI: the first version also moved on a first confirmation and on inserts, so the chat journey's and apply-many's
--    approvals, stamped before the resume was confirmed or a thread was opened, went stale: "invalid or stale application
--    approval", and a yes to a shown card approved nothing.)
-- 2. career_account_authority_mark (20261026090009, otherwise unchanged) counts thread_facts among the authority keys, so
--    the mark moves authority_version to the account's version. career_host_commit writes the account (version + 1)
--    before the thread's state, so an approval stamped before the correction is stale and one stamped after it is current.
--    An ordinary turn ("thanks") changes no mark and no approval.
-- Idempotent: create or replace, drop trigger if exists. The trigger function is security definer (it writes the
-- account row of the thread's own owner, whoever wrote the thread) and is executable by no client role.

-- The values a thread holds as confirmed: {"fact:<id>": <the fact without its status and bookkeeping>, "basic:<key>": value}.
-- A fact counts when its status is confirmed or needs_confirmation is false (as before); empty basics are no value.
create or replace function public.career_thread_facts_mark(p_state jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
 select coalesce(jsonb_object_agg(x.k, x.v), '{}'::jsonb) from (
  select 'fact:' || coalesce(f->>'id', md5(v::text)) as k, v
  from jsonb_array_elements(case when jsonb_typeof(p_state #> '{career,stores,profile,facts}') = 'array'
                                 then p_state #> '{career,stores,profile,facts}' else '[]'::jsonb end) f,
       lateral (select f - array['status','needs_confirmation','confirmation_event_id','confirmed_at','provenance','source_ref',
                                 'corrections','corrected_from','was','audit','audit_log','evidence','created_at','updated_at',
                                 'shown_at','used_at','last_used_at'] as v) p
  where jsonb_typeof(f) = 'object' and (f->>'status' = 'confirmed' or f->'needs_confirmation' = 'false'::jsonb)
  union all
  select 'basic:' || b.key, b.value
  from jsonb_each(case when jsonb_typeof(p_state #> '{career,stores,profile,basics}') = 'object'
                       then p_state #> '{career,stores,profile,basics}' else '{}'::jsonb end) b
  where b.value not in ('null'::jsonb, '""'::jsonb)
 ) x
$$;

-- Whether a value held in p_old (a mark above) is changed or gone in p_new. A value p_old did not hold is no change.
create or replace function public.career_thread_facts_changed(p_old jsonb, p_new jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select exists (select 1 from jsonb_each(coalesce(p_old, '{}'::jsonb)) o where coalesce(p_new, '{}'::jsonb)->o.key is distinct from o.value)
$$;

create or replace function public.career_thread_facts_authority() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 -- A thread backed by the account (account_memory = 1, 20261031050000) holds only a copy: the account's own confirmed facts
 -- already move authority (20261026090009), and clearing a copy in another thread is no change to any fact.
 if new.state#>>'{career,account_memory}' = '1' or old.state#>>'{career,account_memory}' = '1' then return null; end if;
 if not public.career_thread_facts_changed(public.career_thread_facts_mark(old.state), public.career_thread_facts_mark(new.state)) then return null; end if;
 -- a fresh mark every time (never a hash of the facts: changing a value back must move it again)
 update public.career_watch_kv
  set value = value || jsonb_build_object('thread_facts', coalesce(value->'thread_facts', '{}'::jsonb)
                || jsonb_build_object(new.thread_id::text, md5(new.thread_id::text || ':' || txid_current()::text || ':' || clock_timestamp()::text))),
      updated_at = now()
  where user_id = new.user_id and key = 'career:account';
 return null;
end $$;

drop trigger if exists career_thread_facts_authority on public.agent_flow_state;
create trigger career_thread_facts_authority after update of state on public.agent_flow_state
 for each row execute function public.career_thread_facts_authority();

create or replace function public.career_account_authority_mark() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare changed boolean;
begin
 if new.key<>'career:account' then return new; end if;
 if tg_op='INSERT' then
  new.value:=new.value||jsonb_build_object('authority_version',coalesce((new.value->>'version')::bigint,0));
  return new;
 end if;
 changed:=coalesce(new.value->'paused','false'::jsonb) is distinct from coalesce(old.value->'paused','false'::jsonb)
  or coalesce((new.value->>'epoch')::bigint,0)<>coalesce((old.value->>'epoch')::bigint,0)
  or new.value->'stated_facts' is distinct from old.value->'stated_facts'
  or new.value->'preferred_locations' is distinct from old.value->'preferred_locations'
  or jsonb_path_query_array(coalesce(new.value,'{}'::jsonb),'$.memory.profile.facts[*] ? (@.status == "confirmed")')
     is distinct from jsonb_path_query_array(coalesce(old.value,'{}'::jsonb),'$.memory.profile.facts[*] ? (@.status == "confirmed")')
  -- TAILORING ROUND 3: a thread's confirmed profile facts (career_thread_facts_authority above).
  or new.value->'thread_facts' is distinct from old.value->'thread_facts';
 if changed then
  new.value:=new.value||jsonb_build_object('authority_version',coalesce((new.value->>'version')::bigint,0));
 else
  new.value:=new.value||jsonb_build_object('authority_version',coalesce((old.value->>'authority_version')::bigint,0));
 end if;
 return new;
end $$;

revoke all on function public.career_thread_facts_mark(jsonb) from public, anon, authenticated;
revoke all on function public.career_thread_facts_changed(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.career_thread_facts_authority() from public, anon, authenticated;
grant execute on function public.career_thread_facts_mark(jsonb), public.career_thread_facts_changed(jsonb, jsonb) to service_role;
