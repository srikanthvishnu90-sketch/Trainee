-- ROOT CAUSE 3 (docs/architect/ROOT-CAUSES-2026-10-31.md): the person's profile (confirmed resume entries, basics,
-- preferences) and tracker live on the account record (career_watch_kv 'career:account'.memory, 20261026090009), the
-- default since 2026-10-31. Each thread's snapshot (agent_flow_state.state.career.stores) still carries a copy, because the
-- server readers look there (career_apply_profile_for, career_resume_on_file, the card-cloud bridge, the cloud engine,
-- the extension sync), each taking the most recent thread that holds facts or basics.
--
-- Without this, every other thread kept the copy it had at its own last turn: a resume confirmed on Telegram left the web
-- thread's copy as drafts until the person wrote there again, so the server saw two profiles for one person (one stale),
-- and a later turn on the web added a second copy of the same confirmed entries.
-- With this, when a thread backed by the account (its snapshot carries account_memory = 1, stamped by career_host.js
-- extractSnapshot) saves a profile or tracker, the copies in the person's OTHER account-backed threads are cleared.
-- Exactly one thread (the one that saved last) holds the profile and tracker, and they are the account's: an
-- account-backed save only happens after createTurnCtx loaded the account's copy, and the account-version fence refuses a
-- concurrent save. Every thread reloads the account's copy on its next turn. What is cleared is only the copy: the
-- profile's non-frame keys and the tracker's rows; each thread keeps its own conversation frames (profile keys starting
-- with "_", except the _careerTrackStore mirror, and the tracker's _careerThread).
--
-- Not touched: a thread last written before the switch (no account_memory stamp) keeps its own copy until its next turn,
-- when createTurnCtx folds it in, so nothing a person confirmed before the switch is cleared here; per-thread mode
-- (CAREER_ACCOUNT_MEMORY=off) never stamps a snapshot, so this does nothing there; an erase writes no profile.
-- The cleared rows keep their updated_at, so "the most recent thread" stays the one that saved.
--
-- Two saves at once (tests/db/career_account_memory_one_copy_race.py): rows are locked in thread order, skipping any a
-- concurrent save holds, so two threads of one person never deadlock; a per-person advisory lock (held to commit) makes
-- the second save's trigger wait for the first's commit, so two saves whose rows were both locked first still leave one copy.
--
-- Additive and reversible: one function and one trigger. Down:
--   drop trigger if exists career_account_memory_one_copy on public.agent_flow_state;
--   drop function if exists public.career_account_memory_one_copy();
-- (copies cleared while it was installed are not restored; the account holds them and each thread reloads them.)
create or replace function public.career_account_memory_one_copy() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.state#>>'{career,account_memory}' is distinct from '1'
    or not (jsonb_typeof(new.state#>'{career,stores,profile,facts}') is not distinct from 'array'
            or jsonb_typeof(new.state#>'{career,stores,profile,basics}') is not distinct from 'object'
            or jsonb_typeof(new.state#>'{career,stores,trackStore,rows}') is not distinct from 'array') then
  return new;
 end if;
 -- One save per person at a time clears the others: with skip-locked alone, two threads that each hold their own row
 -- before either trigger runs would skip each other and leave two copies. The second waits here for the first to
 -- commit, then (a fresh snapshot, the first's row unlocked) clears it. Held to commit; never waits on a row lock.
 perform pg_advisory_xact_lock(hashtext('career_one_copy:'||new.user_id::text));
 update public.agent_flow_state s set
  state = jsonb_set(s.state, '{career,stores}',
    ((s.state#>'{career,stores}') - 'profile' - 'trackStore')
    || coalesce((select jsonb_build_object('profile', jsonb_object_agg(e.k, e.v)) from jsonb_each(case when jsonb_typeof(s.state#>'{career,stores,profile}') = 'object'
                   then s.state#>'{career,stores,profile}' else '{}'::jsonb end) e(k, v)
                 where left(e.k, 1) = '_' and e.k not in ('_careerTrackStore', '_fromStatedFacts')
                 having count(*) > 0), '{}'::jsonb)
    || case when jsonb_typeof(s.state#>'{career,stores,trackStore,_careerThread}') = 'object'
         then jsonb_build_object('trackStore', jsonb_build_object('_careerThread', s.state#>'{career,stores,trackStore,_careerThread}'))
         else '{}'::jsonb end),
  updated_at = s.updated_at
 where s.thread_id in (
   -- Each saving transaction already holds its own row. Two threads of one person saving at once would each wait for the
   -- other's row (a deadlock). The other rows are taken in thread order and a row another save holds is skipped: that
   -- save is the newer copy and clears this one when it runs its own trigger, or the next save does.
   select o.thread_id from public.agent_flow_state o
   where o.user_id = new.user_id
     and o.thread_id <> new.thread_id
     and o.state#>>'{career,account_memory}' = '1'
     and jsonb_typeof(o.state#>'{career,stores}') = 'object'
     and (jsonb_typeof(o.state#>'{career,stores,profile,facts}') is not distinct from 'array'
          or jsonb_typeof(o.state#>'{career,stores,profile,basics}') is not distinct from 'object'
          or jsonb_typeof(o.state#>'{career,stores,trackStore,rows}') is not distinct from 'array')
   order by o.thread_id
   for update skip locked);
 return new;
end $$;
revoke all on function public.career_account_memory_one_copy() from public, anon, authenticated;
drop trigger if exists career_account_memory_one_copy on public.agent_flow_state;
create trigger career_account_memory_one_copy after insert or update of state on public.agent_flow_state
 for each row execute function public.career_account_memory_one_copy();
