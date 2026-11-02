-- definer-scan: dynamic function DDL reviewed (career_apply_reprepare_install rewrites installed bodies by exact anchors)
-- MASS APPLY (2026-11-01, architect decision (B)): an application the form stopped because it gained a required question
-- after the approval (ended not_submitted, reason needs_answers: nothing was sent) is prepared AGAIN once the person
-- answers it, and goes only on a NEW card and a NEW approval of the new payload. Never auto-submitted.
--
-- No approval-binding guard is weakened. The old row stays exactly as it is, as immutable history: its payload, its
-- approval binding (card-cloud bridge) and its source never change. The re-prepared application is a NEW row, through the
-- normal card -> career_apply_card_answer_for -> career_apply_enqueue path.
--
-- What changes, and nothing else:
--   1. career_apply_job_history(j): the one predicate, "ended not_submitted because the form needs answers".
--   2. unique(user_id, job_id) becomes a partial unique index excluding only such rows: at most ONE non-history row per
--      person and posting at any time, enforced by the index (two concurrent approvals: one row, the other duplicate_job).
--   3. A job that ends needs_answers puts its posting back in the person's queue (career_apply_wanted 'waiting') and asks
--      for a preparation (career_apply_prepare_request_put): the preparation asks the new question, one at a time.
--   4. career_apply_prepare_candidates: a history row no longer keeps its posting out; prepared rows and tries older than
--      it do not count.
--   5. Rewritten by exact anchors (career_apply_reprepare_install, which career_apply_reconcile_bridge now ends with, so a
--      reconcile that re-creates them takes it again): the duplicate checks of career_apply_enqueue, career_apply_prepare_own,
--      career_apply_record_own, career_apply_prepare_for (the re-prepared application is stored for its new card) and the
--      prior-row read of career_apply_email_reserve_for skip history rows; the pending list (career_apply_pending_for) does
--      not hide a re-queued posting behind its history row; the status read (career_apply_status_for) leaves out a history
--      row once a newer row exists for that posting. NOT rewritten: the per-ATS waiver (career_apply_cloud_waiver_left, D-010)
--      keeps counting every cloud drive that ran (attempts > 0), a history row included: a drive that stopped at the form
--      still opened the employer's form under the waiver. The daily cap counts sent states only
--      (career_apply_cloud_text_refusal 'went'), so a history row (not_submitted) never counted.
--   6. The re-preparation is asked with the person's own pace (career_apply_daily_limit, null when none is set), as the
--      runner's door asks it; the dispatcher's claim still applies the runner's per-person number too.
--   7. An approval already bound to a history row is refused on any new row (career_apply_history_approval_guard).
-- Additive and reversible (supabase/rollbacks/20261101130000_career_apply_reprepare_needs_answers.down.sql). Idempotent.

create or replace function public.career_apply_job_history(j public.career_apply_jobs) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select j.state = 'not_submitted' and coalesce(j.reason, '') = 'needs_answers'
$$;
revoke all on function public.career_apply_job_history(public.career_apply_jobs) from public, anon, authenticated;

-- 2. At most one live row per person and posting.
create unique index if not exists career_apply_jobs_live_posting on public.career_apply_jobs (user_id, job_id)
 where not (state = 'not_submitted' and coalesce(reason, '') = 'needs_answers');
alter table public.career_apply_jobs drop constraint if exists career_apply_jobs_user_id_job_id_key;

-- 3. Back in the queue, and a preparation asked for, when the form stopped it for an unanswered question.
create or replace function public.career_apply_reprepare_on_needs_answers() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.state = 'not_submitted' and coalesce(new.reason, '') = 'needs_answers' and old.state is distinct from 'not_submitted' then
  begin
   insert into public.career_apply_wanted (user_id, posting_key, url, company, title, state, queued_at)
   values (new.user_id, new.job_id, new.url, left(coalesce(new.company, ''), 200), left(coalesce(new.payload->>'title', ''), 200), 'waiting', clock_timestamp())
   on conflict (user_id, posting_key) do update set state = 'waiting', taken_at = null, queued_at = clock_timestamp();
   perform public.career_apply_prepare_request_put(new.user_id, array[new.job_id], public.career_apply_daily_limit(new.user_id));
  exception when others then
   -- Never lose the finish over the re-queue: the posting can still be asked for again in chat.
   raise warning 'reprepare: % (job %)', sqlerrm, new.id;
  end;
 end if;
 return new;
end $$;
revoke all on function public.career_apply_reprepare_on_needs_answers() from public, anon, authenticated;
drop trigger if exists career_apply_reprepare_on_needs_answers on public.career_apply_jobs;
create trigger career_apply_reprepare_on_needs_answers after update of state on public.career_apply_jobs
 for each row execute function public.career_apply_reprepare_on_needs_answers();

-- 3b. An approval spent on a history row is never spent again: a new row whose payload, approval or engine approval is
--     the same as a history row's of that person and posting is refused, whatever path inserts it (no user path does:
--     the re-prepared application carries the new answer, so a new payload and a new approval).
create or replace function public.career_apply_history_approval_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if exists (select from public.career_apply_jobs x where x.user_id = new.user_id and x.job_id = new.job_id
   and public.career_apply_job_history(x)
   and (x.payload_hash = new.payload_hash or x.approval_hash = new.approval_hash
    or nullif(x.payload->>'engine_approval', '') = nullif(new.payload->>'engine_approval', ''))) then
  raise exception 'approval_spent: this approval was used by an application the form stopped; a new card and a new approval are needed';
 end if;
 return new;
end $$;
revoke all on function public.career_apply_history_approval_guard() from public, anon, authenticated;
drop trigger if exists career_apply_history_approval_guard on public.career_apply_jobs;
create trigger career_apply_history_approval_guard before insert on public.career_apply_jobs
 for each row execute function public.career_apply_history_approval_guard();

-- 4. The candidates: 20261101121000's text (a browser error is retried after 30 minutes, a refusal after 7 days), a history
--    row and what is older than it not counted.
create or replace function public.career_apply_prepare_candidates(p_now timestamptz, p_per_person integer, p_limit integer)
returns table (user_id uuid, job_id text, company text, title text, url text, location text, description text, epoch bigint, version bigint)
language sql stable security definer set search_path = public, pg_temp as $$
 with s as (
  select o.user_id, substr(o.key, 7) as job_id, o.created_at as at
  from public.career_outbox o
  where o.kind = 'alert' and o.key like 'alert:%' and o.created_at > p_now - interval '14 days'
  union all
  select w.user_id, w.posting_key as job_id, w.queued_at as at
  from public.career_apply_wanted w
  where w.state = 'waiting'
 ), a as (
  select s.user_id, s.job_id, max(s.at) as alerted_at from s group by s.user_id, s.job_id
 ), c as (
  select a.user_id, p.job_id, p.company, p.title, p.url, p.location, p.description,
   coalesce((k.value->>'epoch')::bigint, 0) as epoch, coalesce((k.value->>'version')::bigint, 0) as version,
   row_number() over (partition by a.user_id order by a.alerted_at desc, p.job_id) as rn, a.alerted_at,
   (select max(h.updated_at) from public.career_apply_jobs h where h.user_id = a.user_id and h.job_id = p.job_id
     and public.career_apply_job_history(h)) as stopped_at
  from a
  join public.career_postings p on p.job_id = a.job_id and p.closed_at is null
  join public.profiles pr on pr.id = a.user_id
  join public.career_watch_kv k on k.user_id = a.user_id and k.key = 'career:account' and coalesce(k.value->>'paused', 'false') <> 'true'
  where not exists (select from public.career_apply_jobs j where j.user_id = a.user_id and j.job_id = p.job_id
     and not public.career_apply_job_history(j))
   and public.career_apply_company_key(p.company) <> ''
   and not public.career_apply_posting_sent(a.user_id, p.job_id, p.url, null, true)
 )
 select c.user_id, c.job_id, c.company, c.title, c.url, c.location, c.description, c.epoch, c.version
 from c
 where c.rn <= greatest(0, coalesce(p_per_person, 0))
  and not exists (select from public.career_apply_prepared x where x.user_id = c.user_id and x.job_id = c.job_id
   and (c.stopped_at is null or x.created_at > c.stopped_at))
  and not exists (select from public.career_apply_prepare_attempts t where t.user_id = c.user_id and t.posting_job_id = c.job_id
   and (c.stopped_at is null or t.at > c.stopped_at)
   and (t.outcome = 'ready'
    or (t.outcome = 'asked' and exists (select from public.career_apply_questions q where q.user_id = c.user_id and q.state = 'open'
     and t.engine_job_id = any(q.job_ids)))
    or (t.outcome = 'error' and t.at > p_now - interval '30 minutes')
    or (t.outcome not in ('asked', 'error') and t.at > p_now - interval '7 days')))
 order by c.alerted_at desc, c.user_id, c.job_id
 limit greatest(0, coalesce(p_limit, 0))
$$;

revoke all on function public.career_apply_prepare_candidates(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.career_apply_prepare_candidates(timestamptz, integer, integer) to service_role;

-- 5. The anchored rewrites.
create or replace function public.career_apply_reprepare_install() returns text
language plpgsql security definer set search_path = public, pg_temp as $ri$
declare n int := 0; f text; bad text[] := '{}';
 enq_from text := E'if exists(select from public.career_apply_jobs where user_id=u and job_id=p_payload->>''job_id'') then raise exception ''duplicate_job''; end if;';
 enq_to text := E'if exists(select from public.career_apply_jobs x where x.user_id=u and x.job_id=p_payload->>''job_id'' and not public.career_apply_job_history(x)) then raise exception ''duplicate_job''; end if;';
 own_from text := E'if exists (select from public.career_apply_jobs where user_id = u and job_id = p_payload->>''job_id'') then raise exception ''duplicate_job''; end if;';
 own_to text := E'if exists (select from public.career_apply_jobs x where x.user_id = u and x.job_id = p_payload->>''job_id'' and not public.career_apply_job_history(x)) then raise exception ''duplicate_job''; end if;';
 rec_from text := E'if exists (select from public.career_apply_jobs where user_id = u and job_id = p_job_id) then raise exception ''duplicate_job''; end if;';
 rec_to text := E'if exists (select from public.career_apply_jobs x where x.user_id = u and x.job_id = p_job_id and not public.career_apply_job_history(x)) then raise exception ''duplicate_job''; end if;';
 em_from text := E'select * into prior from public.career_apply_jobs where user_id = p_user and job_id = p_payload->>''job_id'' for update;';
 em_to text := E'select * into prior from public.career_apply_jobs x where x.user_id = p_user and x.job_id = p_payload->>''job_id'' and not public.career_apply_job_history(x) for update;';
 pe_from text := E'and not exists (select from public.career_apply_jobs j where j.user_id = w.user_id and j.job_id in (w.posting_key, coalesce(t.engine_job_id, '''')))';
 pe_to text := E'and not exists (select from public.career_apply_jobs j where j.user_id = w.user_id and j.job_id in (w.posting_key, coalesce(t.engine_job_id, '''')) and not public.career_apply_job_history(j))';
 st_from text := E'from (select * from public.career_apply_jobs where user_id = p_user and (p_job_id is null or job_id = p_job_id) order by updated_at desc limit 200) j';
 st_to text := E'from (select * from public.career_apply_jobs h where h.user_id = p_user and (p_job_id is null or h.job_id = p_job_id) and not (public.career_apply_job_history(h) and exists (select from public.career_apply_jobs l where l.user_id = h.user_id and l.job_id = h.job_id and l.id <> h.id and l.created_at > h.created_at)) order by h.updated_at desc limit 200) j';
 pf_from text := E'if exists (select from public.career_apply_jobs where user_id = p_user and job_id in (p_payload->>''job_id'', p_posting_job_id)) then\n  raise exception ''duplicate_job''; end if;';
 pf_to text := E'if exists (select from public.career_apply_jobs x where x.user_id = p_user and x.job_id in (p_payload->>''job_id'', p_posting_job_id) and not public.career_apply_job_history(x)) then\n  raise exception ''duplicate_job''; end if;';
begin
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_enqueue(jsonb,text,text,integer)', array[enq_from, enq_to]);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_prepare_own(jsonb,text[])', array[own_from, own_to]);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_record_own(text,text,text,text)', array[rec_from, rec_to]);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_email_reserve_for(uuid,jsonb,text,timestamptz)', array[em_from, em_to]);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_pending_for(uuid)', array[pe_from, pe_to]);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_status_for(uuid,text)', array[st_from, st_to]);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_prepare_for(uuid,text,jsonb,text[])', array[pf_from, pf_to]);
 -- Every installed one must now carry the history exclusion; an anchor that moved fails loudly, never silently.
 foreach f in array array['public.career_apply_enqueue(jsonb,text,text,integer)', 'public.career_apply_prepare_own(jsonb,text[])',
   'public.career_apply_record_own(text,text,text,text)', 'public.career_apply_email_reserve_for(uuid,jsonb,text,timestamptz)',
   'public.career_apply_pending_for(uuid)', 'public.career_apply_status_for(uuid,text)', 'public.career_apply_prepare_for(uuid,text,jsonb,text[])'] loop
  if to_regprocedure(f) is not null and position('career_apply_job_history' in pg_get_functiondef(to_regprocedure(f))) = 0 then bad := bad || f; end if;
 end loop;
 if cardinality(bad) > 0 then raise exception 'reprepare: an anchor was not found in %', array_to_string(bad, ', '); end if;
 return format('rewritten %s', n);
end $ri$;
revoke all on function public.career_apply_reprepare_install() from public, anon, authenticated;

-- 20261031000000's reconcile, ending with the rewrite above too.
create or replace function public.career_apply_reconcile_bridge() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r text;
begin
 r := public.career_apply_reconcile_bridge_20261025110000();
 perform public.career_apply_cloud_refusal_own_pace();
 perform public.career_apply_mass_submit_install();
 perform public.career_apply_submit_worker_install();
 perform public.career_apply_cloud_authorize_closed_install();
 perform public.career_apply_reprepare_install();
 return r;
end $$;
revoke all on function public.career_apply_reconcile_bridge() from public, anon, authenticated;

select public.career_apply_reprepare_install();
