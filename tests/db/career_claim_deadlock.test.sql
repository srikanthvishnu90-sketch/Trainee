-- OUTREACH CLAIM DEADLOCK (20261105180000_career_claim_deadlock.sql), in the database alone (the concurrent interleaving and
-- the contention rounds are tests/db/career_claim_deadlock.py): the claim reads a person's rows under that person's claim
-- lock and holds it to its end; a refused follow-up still ends its thread's sequence in the same call; per-person shares,
-- oldest first and the lease are as before; SECURITY DEFINER, service role only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000dd001'; b uuid := '00000000-0000-4000-8000-0000000dd002';
  ta uuid := '00000000-0000-4000-8000-0000000dda01'; tr uuid := '00000000-0000-4000-8000-0000000dda02'; tb uuid := '00000000-0000-4000-8000-0000000ddb01';
  f uuid; got uuid[]; n int; p regprocedure := 'public.career_outreach_action_claim(text, int, int, timestamptz, int)'::regprocedure;
begin
  -- The function as shipped: SECURITY DEFINER with a fixed search_path, executable by the service role only.
  if not (select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid = p) then
    raise exception 'FAIL the claim is not SECURITY DEFINER with search_path public, pg_temp'; end if;
  if has_function_privilege('anon', p, 'execute') or has_function_privilege('authenticated', p, 'execute')
     or exists (select from pg_proc, aclexplode(proacl) x where oid = p and x.grantee = 0) then
    raise exception 'FAIL anon, authenticated or public can run the claim'; end if;
  if not has_function_privilege('service_role', p, 'execute') then raise exception 'FAIL the service role cannot run the claim'; end if;
  raise notice 'ok   career_outreach_action_claim: SECURITY DEFINER, search_path fixed, service role only';

  insert into auth.users(id, email) values (a, 'dd-a@example.test'), (b, 'dd-b@example.test');
  insert into public.profiles(id) values (a), (b);
  insert into public.career_outreach_threads(id, user_id, provider, provider_thread, recipient_email, sent_at, status, replied_at) values
    (ta, a, 'gmail', 'dd-ta', 'dd-ta@example.test', now() - interval '9 days', 'wants_call', null),
    (tr, a, 'gmail', 'dd-tr', 'dd-tr@example.test', now() - interval '9 days', 'awaiting', now() - interval '1 day'),
    (tb, b, 'gmail', 'dd-tb', 'dd-tb@example.test', now() - interval '9 days', 'wants_call', null);
  -- A: a follow-up on a thread that has a reply (oldest), then four scheduling replies; B: three scheduling replies.
  insert into public.career_outreach_actions(user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at)
  values (a, tr, 'followup', 1, gen_random_uuid(), 1, '{}', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '1 hour')
  returning id into f;
  insert into public.career_outreach_actions(user_id, thread_id, kind, batch_id, n, payload, hash, status, approved_hash, approved_at)
  select a, ta, 'schedule_reply', gen_random_uuid(), k, '{}', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '50 minutes' + k * interval '1 minute'
  from generate_series(1, 4) k;
  insert into public.career_outreach_actions(user_id, thread_id, kind, batch_id, n, payload, hash, status, approved_hash, approved_at)
  select b, tb, 'schedule_reply', gen_random_uuid(), k, '{}', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '50 minutes' + k * interval '1 minute'
  from generate_series(1, 3) k;

  -- Two per person per pass, room for 5: A's follow-up refused (its slot used, as before), A's two oldest replies, B's two
  -- oldest, then a second pass: one more (whoever comes first round from the random start).
  got := array(select x.id from public.career_outreach_action_claim('dd-w', 5, 2, now(), 600) x);
  if cardinality(got) <> 5 then raise exception 'FAIL the claim took % (want 5)', cardinality(got); end if;
  if exists (select from public.career_outreach_actions where id = any(got) and (status <> 'running' or lease_owner <> 'dd-w' or lease_until <= now())) then
    raise exception 'FAIL a claimed action is not leased to the worker'; end if;
  select count(*) into n from public.career_outreach_actions where user_id = a and kind = 'schedule_reply' and id = any(got)
    and approved_at <= (select min(approved_at) + interval '1 minute' from public.career_outreach_actions where user_id = a and kind = 'schedule_reply');
  if n < 2 then raise exception 'FAIL A''s two oldest replies were not taken first (%)', n; end if;
  raise notice 'ok   per-person share, oldest first, leased to the worker; the call filled by a second pass';
  if not (select status = 'refused' and result = 'replied' from public.career_outreach_actions where id = f) then
    raise exception 'FAIL the follow-up on a thread with a reply is not refused'; end if;
  if not (select followup_state = 'off' from public.career_outreach_threads where id = tr) then
    raise exception 'FAIL the refused follow-up did not end its thread''s sequence'; end if;
  raise notice 'ok   a refused follow-up is refused and ends its thread''s sequence in the same call';
  -- Each person read was read under that person's claim lock, held by this transaction to its end.
  select count(*) into n from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
    and ((l.classid::bigint << 32) | l.objid::bigint) in (hashtextextended('career_outreach_action_claim:' || a::text, 0),
                                                         hashtextextended('career_outreach_action_claim:' || b::text, 0));
  if n <> 2 then raise exception 'FAIL the claim holds % of the two person claim locks (want 2)', n; end if;
  raise notice 'ok   each person''s rows read under that person''s claim lock, held to the end of the claim';
  -- The rest: B's last reply and A's others, in a later call; nothing is taken twice.
  got := got || array(select x.id from public.career_outreach_action_claim('dd-w2', 10, 2, now(), 600) x);
  if cardinality(got) <> 7 or (select count(distinct x) from unnest(got) x) <> 7 then raise exception 'FAIL not every action claimed exactly once (%)', cardinality(got); end if;
  raise notice 'ok   a second call takes the rest; nothing claimed twice';
end $$;
rollback;
