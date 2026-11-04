-- The submit worker, after the yes (2026-10-31 round: tests/architect/scenarios-submit-worker*.test.ts, the seeded battery on
-- the worker's decisions, and tests/architect/flow-scenarios-submit-worker.test.ts, sampled runs through the real worker on a
-- real Postgres). What was found on the claims every worker takes from (career_apply_claim_fair: the pool and the many-instance
-- cloud worker; career_apply_claim_own: the person's own computer; career_apply_cloud_claim_at / _portal_at: the cloud worker
-- and the cloud runner; career_apply_cloud_text_claim_at: the text-card route; career_apply_vm_claim: the apply VM):
--   1. A posting closed after the yes was still sent. The close trigger (20261030110000) closes what is queued AT the close; an
--      application being driven then and put back by the worker (the site said 429, the worker stopped before starting it)
--      came back to the queue with the posting already closed, and no claim looked at the posting: it was sent.
--   2. An approval that expired while queued, an account reset or changed under it ("forget everything", the authority
--      fence), or a resume that is no longer the confirmed one (its file removed): the claims skipped the row, every time,
--      for ever. It stayed "approved, not sent yet" with no reason, never ended, and (the person's oldest) took the person's
--      turn in every round, so their other applications waited behind it.
--   3. A job put back with a not-before time (the host asked us to wait) was still the person's oldest candidate; the
--      not-before trigger skipped it silently, so the person's newer applications were not claimed until it was due (up to
--      a day). In the cloud claim the skipped update returned an all-null row to the worker (a job with no id or lease).
--   4. The not-before trigger compared the database's microseconds with the worker's millisecond clock (p_now): a job due
--      within the worker's current millisecond was skipped (the send rail's same bug, b40e3d5f4).
--   5. The employer's confirmation email that arrives while the drive is still recorded as running (the worker died after
--      the board accepted and before it wrote the outcome) was refused as "never went to the employer" and never read
--      again: the application later swept to "unknown" although the employer had confirmed it.
--   6. The text-card route's last authorization before Submit did not look at the posting: one closed between the claim and
--      the Submit was sent.
-- Fixed here, without loosening anything:
--   career_apply_unsendable_why(row, now): why a queued application can never go as approved (posting_closed,
--     approval_expired, account_changed, resume_gone), or null. A paused account is not a reason: it waits.
--   career_apply_close_unsendable(ids, now): closes those as not sent, with a reason the person can read and nothing_sent.
--   Every claim closes them first and never hands them out; every claim skips a not-before that is not yet due (compared at
--   millisecond precision, the worker's clock); the cloud claims never return a row they did not claim.
--   career_apply_void_unsendable (the own computer's first step) closes them too.
--   career_apply_confirm_as accepts an application still recorded as being driven (claimed before the email).
--   career_apply_cloud_text_refusal refuses a closed posting (the claim and the authorization before Submit).
-- The claims the reconcile re-creates (career_apply_claim_own, from 20261025110000's text) are rewritten again by
-- career_apply_submit_worker_install(), which career_apply_reconcile_bridge() now ends with (scripts/launch/verify-claim-guards.sql
-- runs it after every apply). Idempotent: applies cleanly twice. Service role only; nothing here is granted to a person.

-- ------------------------------------------------------------------------------------------- why it may never go
create or replace function public.career_apply_unsendable_why(j public.career_apply_jobs, p_now timestamptz)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a jsonb; exp timestamptz;
begin
 if j.id is null or j.state is distinct from 'queued' then return null; end if;
 if exists (select from public.career_postings p where p.job_id = j.job_id and p.closed_at is not null) then return 'posting_closed'; end if;
 begin exp := (j.payload->>'expires_at')::timestamptz; exception when others then exp := null; end;
 -- The approval's own expiry, on the database's clock (as career_apply_current reads it).
 if exp is null or exp <= clock_timestamp() then return 'approval_expired'; end if;
 select value into a from public.career_watch_kv where user_id = j.user_id and key = 'career:account';
 if a is null then return 'account_changed'; end if;
 -- Paused: not a reason to end it. It waits (every claim skips it while career_apply_current is false).
 if coalesce(a->>'paused', 'false') <> 'false' then return null; end if;
 begin
  if coalesce((a->>'epoch')::bigint, 0) is distinct from (j.payload->>'privacy_epoch')::bigint
   or (j.payload->>'account_version')::bigint < coalesce((a->>'authority_version')::bigint, 0)
   or (j.payload->>'account_version')::bigint > coalesce((a->>'version')::bigint, 0)
   or j.payload->>'account_version' is null or j.payload->>'privacy_epoch' is null then return 'account_changed'; end if;
 exception when others then return 'account_changed';
 end;
 if to_regprocedure('public.career_resume_ok(uuid,jsonb)') is not null then
  if not public.career_resume_ok(j.user_id, j.payload) then return 'resume_gone'; end if;
 end if;
 return null;
end $$;
revoke all on function public.career_apply_unsendable_why(public.career_apply_jobs, timestamptz) from public, anon, authenticated;

-- The reason as the person reads it ("where are my applications" shows it after "not sent").
create or replace function public.career_apply_unsendable_words(p_why text) returns text
language sql immutable set search_path = pg_catalog as $$
 select case p_why
  when 'posting_closed' then 'not sent: the posting closed before we sent it'
  when 'approval_expired' then 'not sent: your approval expired before we could send it; nothing was sent. Approve it again if you still want it'
  when 'account_changed' then 'not sent: your Trainee account changed after you approved it (it was reset, or your details changed); nothing was sent. Ask Trainee to prepare it again'
  when 'resume_gone' then 'not sent: the resume you approved it with is no longer your confirmed resume; nothing was sent. Approve it again with your current resume'
  else 'not sent: it could no longer be sent as you approved it; nothing was sent' end
$$;

create or replace function public.career_apply_close_unsendable(p_ids uuid[], p_now timestamptz)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; why text; n int := 0; t timestamptz := coalesce(p_now, clock_timestamp());
begin
 if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
 for j in select * from public.career_apply_jobs where id = any(p_ids) and state = 'queued' order by id loop
  why := public.career_apply_unsendable_why(j, t);
  continue when why is null;
  begin
   update public.career_apply_jobs set state = 'not_submitted', reason = public.career_apply_unsendable_words(why),
    evidence = evidence || jsonb_build_object('closed_at', t, 'closed', why, 'nothing_sent', true), updated_at = t
    where id = j.id and state = 'queued';
   if found then n := n + 1; end if;
  exception when others then
   -- A row the queue's own triggers will not let us close stays queued; the claims still never hand it out (they re-check).
   raise warning 'career_apply_close_unsendable: % (%)', sqlerrm, j.id;
  end;
 end loop;
 return n;
end $$;
revoke all on function public.career_apply_close_unsendable(uuid[], timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------- the not-before time
-- At millisecond precision: the claims pass the worker's clock (JavaScript, milliseconds) as claimed_at.
create or replace function public.career_apply_jobs_not_before() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 if new.state = 'driving' and old.state = 'queued' and old.not_before is not null
  and date_trunc('milliseconds', old.not_before) > coalesce(new.claimed_at, clock_timestamp()) then
  return null;
 end if;
 return new;
end $$;
revoke all on function public.career_apply_jobs_not_before() from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------- the person's own computer
-- Its first step (career_apply_claim_own calls it before picking): also ends what may never go.
create or replace function public.career_apply_void_unsendable(p_user uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int; c int;
begin
 update public.career_apply_jobs set state = 'not_submitted', reason = 'not sent: the application changed after it was approved',
  evidence = evidence || jsonb_build_object('closed_at', p_now, 'closed', 'approval_changed'), updated_at = p_now
  where (p_user is null or user_id = p_user) and state = 'queued' and source is null and attempts = 0
  and (approval_hash is distinct from payload_hash or payload_hash is distinct from public.career_apply_payload_hash(payload));
 get diagnostics a = row_count;
 update public.career_apply_jobs q set state = 'not_submitted',
  reason = 'not sent: this exact posting was already sent (recorded after you approved this one)',
  evidence = q.evidence || jsonb_build_object('closed_at', p_now, 'closed', 'duplicate_posting'), updated_at = p_now
  where (p_user is null or q.user_id = p_user) and q.state = 'queued' and q.source is null and q.attempts = 0
  and public.career_apply_posting_sent(q.user_id, q.job_id, q.url, q.id::text, false);
 get diagnostics b = row_count;
 c := public.career_apply_close_unsendable(array(select id from public.career_apply_jobs
  where (p_user is null or user_id = p_user) and state = 'queued'), p_now);
 return a + b + c;
end $$;
revoke all on function public.career_apply_void_unsendable(uuid, timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------- the pool claim
-- 20261027141000's fair claim, with: what may never go is a candidate only to be closed (never handed out), a not-before
-- not yet due is not a candidate (it no longer holds the person's turn), and the hand-out re-checks both.
create or replace function public.career_apply_claim_fair(p_now timestamptz, p_limit integer, p_per_person integer)
returns setof public.career_apply_jobs language plpgsql security definer set search_path = public, pg_temp as $$
declare people uuid[]; ids uuid[]; per int := greatest(1, coalesce(p_per_person, 1)); lim int := greatest(0, coalesce(p_limit, 0));
begin
 if p_now is null or lim = 0 then return; end if;
 people := array(select t.user_id from public.career_apply_claim_turns t where t.queued
  and t.last_claim_at <= coalesce((select x.last_claim_at from public.career_apply_claim_turns x where x.queued
   order by x.last_claim_at, x.user_id offset lim * 64 limit 1), 'infinity')
  order by t.last_claim_at, t.user_id limit (lim + per - 1) / per for update skip locked);
 if cardinality(people) = 0 then return; end if;
 per := greatest(per, ceil(lim::numeric / cardinality(people))::int);
 update public.career_apply_claim_turns set last_claim_at = p_now where user_id = any(people);
 ids := array(select q.id from unnest(people) with ordinality as pp(u, o)
  cross join lateral (select j.id, j.created_at from public.career_apply_jobs j
   where j.user_id = pp.u and j.state = 'queued' and j.source is null and j.attempts = 0
    and (j.not_before is null or date_trunc('milliseconds', j.not_before) <= p_now)
    and (public.career_apply_current(j.user_id, j.payload) or public.career_apply_unsendable_why(j, p_now) is not null)
    and not exists (select from public.career_apply_host_backoff b where b.scope = 'cloud' and b.host = public.career_apply_host(j.url) and b.until > p_now)
   order by j.created_at, j.id limit per for update of j skip locked) q
  order by pp.o, q.created_at, q.id limit lim);
 if cardinality(ids) = 0 then return; end if;
 -- What may never go as approved (a closed posting, an expired approval, a changed account, a resume no longer confirmed)
 -- is closed as not sent, with its reason, and never handed out.
 perform public.career_apply_close_unsendable(ids, p_now);
 -- The approval re-check on exactly these (career_apply_void_unsendable's two rules).
 update public.career_apply_jobs set state = 'not_submitted', reason = 'not sent: the application changed after it was approved',
  evidence = evidence || jsonb_build_object('closed_at', p_now, 'closed', 'approval_changed'), updated_at = p_now
  where id = any(ids) and state = 'queued' and (approval_hash is distinct from payload_hash or payload_hash is distinct from public.career_apply_payload_hash(payload));
 update public.career_apply_jobs q set state = 'not_submitted',
  reason = 'not sent: this exact posting was already sent (recorded after you approved this one)',
  evidence = q.evidence || jsonb_build_object('closed_at', p_now, 'closed', 'duplicate_posting'), updated_at = p_now
  where q.id = any(ids) and q.state = 'queued' and public.career_apply_posting_sent(q.user_id, q.job_id, q.url, q.id::text, false);
 return query
 update public.career_apply_jobs j set state = 'driving', attempts = 1, claimed_at = p_now, lease_token = gen_random_uuid(),
  updated_at = p_now, source = 'cloud'
 where j.id = any(ids) and j.state = 'queued' and public.career_apply_current(j.user_id, j.payload)
  and public.career_apply_unsendable_why(j, p_now) is null returning j.*;
end $$;
revoke all on function public.career_apply_claim_fair(timestamptz, integer, integer) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------- the employer's email
-- 20261021075000's confirm, also for an application still recorded as being driven (claimed before the email): the worker
-- died after the board accepted it and before it wrote the outcome. The email is the employer's own answer.
create or replace function public.career_apply_confirm_as(p_user uuid, p_id uuid, p_hash text, p_kind text, p_evidence text, p_mail_at timestamptz)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs; sub timestamptz;
begin
 if p_user is null or p_id is null or coalesce(p_hash, '') !~ '^[a-f0-9]{64}$' or p_kind is null
  or p_kind not in ('received', 'rejection', 'interview', 'offer') or p_evidence is null
  or length(p_evidence) not between 1 and 300 or p_evidence ~ '[0-9]{6,}' or p_mail_at is null then
  raise exception 'invalid confirmation'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 select * into j from public.career_apply_jobs where id = p_id and user_id = p_user for update;
 if not found then raise exception 'not your application'; end if;
 if j.confirmation_mail_hash = p_hash then return 'already'; end if;
 if j.confirmation_mail_hash is not null then return 'confirmed_by_another_email'; end if;
 if j.state not in ('submitted_unconfirmed', 'unknown_outcome', 'confirmed', 'driving') then return 'not_sent'; end if;
 if j.state = 'driving' and j.claimed_at is null then return 'not_sent'; end if;
 sub := coalesce(j.claimed_at, j.created_at);
 if p_mail_at < sub or p_mail_at > sub + interval '14 days' then return 'outside_window'; end if;
 update public.career_apply_jobs set state = 'confirmed', email_confirmed_at = p_mail_at, confirmation_mail_hash = p_hash, updated_at = now(),
  evidence = case when j.state = 'driving' then evidence || jsonb_build_object('confirmed_while_driving', true, 'lease_at_email', j.claimed_at) else evidence end
  where id = p_id;
 insert into public.career_mail_events (user_id, application_ref, kind, company, stage, flagged, evidence, message_hash, mail_at)
 values (p_user, 'job:' || p_id, p_kind, left(j.company, 200), null, false, p_evidence, p_hash, p_mail_at)
 on conflict (user_id, message_hash) do update set application_ref = excluded.application_ref;
 return 'confirmed';
end $$;
revoke all on function public.career_apply_confirm_as(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------- the rewrites
-- The claims whose text other files own (the reconcile re-creates career_apply_claim_own; the bridge re-creates
-- career_apply_cloud_claim_at; FEATURE 17's text route and the VM's claim): rewritten in place by exact anchors, as
-- career_apply_mass_submit_install does, so each keeps whatever else it has (the bridge's card binding). A function that
-- is not installed is skipped; one that is installed and does not take the rewrite stops the run (raise).
create or replace function public.career_apply_submit_worker_install() returns text
language plpgsql security definer set search_path = public, pg_temp as $si$
declare n int := 0; d text; bad text[] := '{}'; f text;
 own_from text := E'  and not exists (select from public.career_apply_host_backoff hb where hb.scope = u::text';
 own_to text := E'  and (not_before is null or date_trunc(''milliseconds'', not_before) <= n)\n  and not exists (select from public.career_apply_host_backoff hb where hb.scope = u::text';
 at_nb_from text := E'         and not exists (select from public.career_apply_host_backoff hb where hb.scope = ''cloud'' and hb.host = public.career_apply_host(q.url) and hb.until > p_now)\n        order by q.created_at, q.id limit 4)';
 at_nb_to text := E'         and (q.not_before is null or date_trunc(''milliseconds'', q.not_before) <= p_now)\n         and not exists (select from public.career_apply_host_backoff hb where hb.scope = ''cloud'' and hb.host = public.career_apply_host(q.url) and hb.until > p_now)\n        order by q.created_at, q.id limit 4)';
 at_close_from text := E'  continue when public.career_apply_cloud_refusal(j, p_now) is not null;';
 at_close_to text := E'  continue when public.career_apply_close_unsendable(array[j.id], p_now) > 0;\n  continue when public.career_apply_cloud_refusal(j, p_now) is not null;';
 at_null_from text := E'   updated_at = p_now, source = ''cloud'' where id = j.id returning * into j;\n  got := got + 1;';
 at_null_to text := E'   updated_at = p_now, source = ''cloud'' where id = j.id returning * into j;\n  continue when j.id is null;\n  got := got + 1;';
 tx_nb_from text := E'    and public.career_apply_portal(q.url) = p_portal) x';
 tx_nb_to text := E'    and public.career_apply_portal(q.url) = p_portal\n    and (q.not_before is null or date_trunc(''milliseconds'', q.not_before) <= p_now)) x';
 tx_close_from text := E'  continue when public.career_apply_cloud_text_refusal(j, clock_timestamp(), ''claim'', p_per_person_day, p_per_site_minute) is not null;';
 tx_close_to text := E'  continue when public.career_apply_close_unsendable(array[j.id], p_now) > 0;\n  continue when public.career_apply_cloud_text_refusal(j, clock_timestamp(), ''claim'', p_per_person_day, p_per_site_minute) is not null;';
 tx_null_from text := E'   updated_at = clock_timestamp(), source = ''cloud'' where id = j.id returning * into j;\n  insert into';
 tx_null_to text := E'   updated_at = clock_timestamp(), source = ''cloud'' where id = j.id returning * into j;\n  continue when j.id is null;\n  insert into';
 tr_from text := E' if public.career_apply_cloud_card_bound(j.id) then return ''card_cloud_route''; end if;';
 tr_to text := E' if exists (select from public.career_postings p where p.job_id = j.job_id and p.closed_at is not null) then return ''posting_closed''; end if;\n if public.career_apply_cloud_card_bound(j.id) then return ''card_cloud_route''; end if;';
 vm_cand_from text := E'    and public.career_apply_current(j.user_id, j.payload)\n';
 vm_cand_to text := E'    and (public.career_apply_current(j.user_id, j.payload) or public.career_apply_unsendable_why(j, now_) is not null)\n    and (j.not_before is null or date_trunc(''milliseconds'', j.not_before) <= now_)\n';
 vm_close_from text := E' if cardinality(ids) = 0 then return ''[]''::jsonb; end if;\n -- The stored-approval check';
 vm_close_to text := E' if cardinality(ids) = 0 then return ''[]''::jsonb; end if;\n perform public.career_apply_close_unsendable(ids, now_);\n -- The stored-approval check';
 vm_take_from text := E'  where j.id = any (ids) and j.state = ''queued'' returning j.*)';
 vm_take_to text := E'  where j.id = any (ids) and j.state = ''queued'' and public.career_apply_current(j.user_id, j.payload)\n   and public.career_apply_unsendable_why(j, now_) is null returning j.*)';
begin
 -- The person's own computer: a not-before not yet due is not picked (it no longer holds the person's oldest place).
 f := 'public.career_apply_claim_own(integer,text)';
 if to_regprocedure(f) is not null and position('date_trunc(''milliseconds'', not_before)' in pg_get_functiondef(to_regprocedure(f))) = 0 then
  n := n + public.career_apply_mass_submit_rewrite(f, array[own_from, own_to]);
 end if;
 -- The cloud claim: closes what may never go, skips a not-before not yet due, never returns a row it did not claim.
 f := 'public.career_apply_cloud_claim_at(integer,timestamptz)';
 if to_regprocedure(f) is not null and position('career_apply_close_unsendable' in pg_get_functiondef(to_regprocedure(f))) = 0 then
  n := n + public.career_apply_mass_submit_rewrite(f, array[at_nb_from, at_nb_to, at_close_from, at_close_to, at_null_from, at_null_to]);
  -- The cloud runner's per-portal claim is generated from it.
  if to_regprocedure('public.career_apply_cloud_claim_portal_install()') is not null then perform public.career_apply_cloud_claim_portal_install(); end if;
 end if;
 f := 'public.career_apply_cloud_text_claim_at(integer,timestamptz,text,integer,integer)';
 if to_regprocedure(f) is not null and position('career_apply_close_unsendable' in pg_get_functiondef(to_regprocedure(f))) = 0 then
  n := n + public.career_apply_mass_submit_rewrite(f, array[tx_nb_from, tx_nb_to, tx_close_from, tx_close_to, tx_null_from, tx_null_to]);
 end if;
 f := 'public.career_apply_cloud_text_refusal(public.career_apply_jobs,timestamptz,text,integer,integer)';
 if to_regprocedure(f) is not null and position('posting_closed' in pg_get_functiondef(to_regprocedure(f))) = 0 then
  n := n + public.career_apply_mass_submit_rewrite(f, array[tr_from, tr_to]);
 end if;
 f := 'public.career_apply_vm_claim(text,integer,integer,text[])';
 if to_regprocedure(f) is not null and position('career_apply_close_unsendable' in pg_get_functiondef(to_regprocedure(f))) = 0 then
  n := n + public.career_apply_mass_submit_rewrite(f, array[vm_cand_from, vm_cand_to, vm_close_from, vm_close_to, vm_take_from, vm_take_to]);
 end if;
 -- Every installed one has taken it.
 foreach f in array array['public.career_apply_claim_own(integer,text)', 'public.career_apply_cloud_claim_at(integer,timestamptz)',
   'public.career_apply_cloud_claim_portal_at(integer,timestamptz,text)', 'public.career_apply_cloud_text_claim_at(integer,timestamptz,text,integer,integer)',
   'public.career_apply_vm_claim(text,integer,integer,text[])'] loop
  continue when to_regprocedure(f) is null;
  d := pg_get_functiondef(to_regprocedure(f));
  if position('date_trunc(''milliseconds''' in d) = 0 then bad := bad || (f || ': a not-before not yet due still holds the person''s place'); end if;
  if f <> 'public.career_apply_claim_own(integer,text)' and position('career_apply_close_unsendable' in d) = 0 then
   bad := bad || (f || ': does not close what may never go'); end if;
  if f in ('public.career_apply_cloud_claim_at(integer,timestamptz)', 'public.career_apply_cloud_claim_portal_at(integer,timestamptz,text)',
    'public.career_apply_cloud_text_claim_at(integer,timestamptz,text,integer,integer)') and position('continue when j.id is null' in d) = 0 then
   bad := bad || (f || ': may return a row it did not claim'); end if;
 end loop;
 if to_regprocedure('public.career_apply_cloud_text_refusal(public.career_apply_jobs,timestamptz,text,integer,integer)') is not null
  and position('posting_closed' in pg_get_functiondef('public.career_apply_cloud_text_refusal(public.career_apply_jobs,timestamptz,text,integer,integer)'::regprocedure)) = 0 then
  bad := bad || 'career_apply_cloud_text_refusal: a closed posting is not refused'::text; end if;
 if cardinality(bad) > 0 then raise exception 'submit worker: %', array_to_string(bad, '; '); end if;
 return format('rewritten %s', n);
end $si$;
revoke all on function public.career_apply_submit_worker_install() from public, anon, authenticated;

-- The reconcile the launch scripts run after every apply (scripts/launch/verify-claim-guards.sql) re-creates the own
-- computer's claim from its text: it ends with this file's rewrite too.
create or replace function public.career_apply_reconcile_bridge() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r text;
begin
 r := public.career_apply_reconcile_bridge_20261025110000();
 perform public.career_apply_cloud_refusal_own_pace();
 perform public.career_apply_mass_submit_install();
 perform public.career_apply_submit_worker_install();
 return r;
end $$;
revoke all on function public.career_apply_reconcile_bridge() from public, anon, authenticated;

select public.career_apply_submit_worker_install();
