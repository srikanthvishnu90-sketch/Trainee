-- Mass submission, the database side (owner decisions D-MS-2 and D-MS-3, 2026-10-27, in writing to the architect).
-- NOT APPLIED: like every migration, the owner applies it; nothing here runs on the live project until then.
-- definer-scan: dynamic function DDL reviewed (career_apply_mass_submit_install rewrites installed bodies by exact anchors)
--
-- D-MS-2: no product volume cap. Gone: the per-person daily number Trainee chose (already none since 20261025140000;
-- here also the cloud's own 15/25, the opt-in's 15 and the bridge's tap and authorize 15), the claim-size bounds of 6
-- (least(6, p_limit) in the person's claim, the pool claim and the cloud claim; the dispatcher's 6-at-a-time loop) and
-- the card's 8 and the 100-at-once on the apply queue (a card holds the whole shown batch, of any size). Kept: a pace the person
-- sets themselves (career_apply_pace_set; none by default) and the safety pacing per host (20261027141000).
-- D-MS-3: "one per company per 30 days" is gone. Refused only: the exact same posting for the same person, already sent
-- or in flight. A posting is the same when it has the same job id (the queue's own key, unique per person since
-- 20261020000001), the same canonical link (career_apply_posting_key), or, for an extension report or an old batch
-- record, the same posting key. Two roles at one company are two postings.
-- Kept unchanged: the exact-payload approval (enqueue's hash checks, career_apply_jobs_fixed), the claim's re-check that
-- closes a changed application as not sent (career_apply_void_unsendable), unique confirmation ids
-- (career_apply_jobs_confirmation), every resume check (the message card's prepared-resume requirement, the cloud's
-- resume-by-hash), the gates, pauses, kill switches and the unreadable-pace refusal.
--
-- How it stays true whatever order the bridge draft, its rollback or the one-ledger file are applied in: the launch
-- scripts and tests/db/run.sh run career_apply_reconcile_bridge() after every apply (scripts/launch/verify-claim-guards.sql),
-- and from here that ends with career_apply_mass_submit_install(), which rewrites the installed claims and cloud checks by
-- exact anchors and refuses (raises) if any old bound is left; career_apply_guards_missing() names any that are.
-- After 20261026230500. Idempotent.

-- ------------------------------------------------------------------------------------------- the posting's identity
-- A job link as one posting. Lower case; the host without www. and without a default port (:80, :443), any other port
-- kept; the path without trailing slashes, and without a final /apply or /application when two or more segments come
-- before it (Lever's /acme/<id>/apply, Ashby's /acme/<id>/application); the query kept, sorted, without tracking
-- parameters (utm_*, gh_src, src, source, ref, referrer, lever-*). Any Greenhouse link that names a job number
-- (…/jobs/123 or ?gh_jid=123) is that number. Null when it is not a web link. A key drops only what never tells two
-- postings apart, so two roles never share one.
create or replace function public.career_apply_posting_key(p_url text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare m text[]; h text; p text; q text; jid text;
begin
 m := regexp_match(lower(btrim(coalesce(p_url, ''))), '^https?://([^/?#@]+)([^?#]*)(\?[^#]*)?');
 if m is null then return null; end if;
 h := regexp_replace(regexp_replace(m[1], '^www\.', ''), ':(80|443)$', '');
 p := regexp_replace(coalesce(m[2], ''), '/+$', '');
 if p ~ '^/[^/]+/.+/(apply|application)$' then p := regexp_replace(regexp_replace(p, '/(apply|application)$', ''), '/+$', ''); end if;
 if h ~ '(^|\.)greenhouse\.io$' then
  jid := coalesce(substring(coalesce(m[3], '') from '[?&]gh_jid=([0-9]+)'), substring(p from '/jobs/([0-9]+)$'));
  if jid is not null then return 'greenhouse.io/jobs/' || jid; end if;
 end if;
 if m[3] is null or length(m[3]) < 2 then return h || p; end if;
 select string_agg(x, '&' order by x collate "C") into q from unnest(string_to_array(substr(m[3], 2), '&')) x
  where x <> '' and x !~ '^(utm_[a-z_]*|gh_src|src|source|ref|referrer|lever-[a-z-]*)(=|$)';
 return h || p || coalesce('?' || q, '');
end $$;
create index if not exists career_apply_jobs_posting_key on public.career_apply_jobs (user_id, public.career_apply_posting_key(url));

-- Whether this person already sent, may have sent, or (p_queued) approved to send this exact posting, from any path,
-- other than p_except (a queue row id or an extension report id). Postings at the same company are not the same posting.
create or replace function public.career_apply_posting_sent(p_user uuid, p_job_id text, p_url text, p_except text, p_queued boolean)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
 with k as (select public.career_apply_posting_key(p_url) as key, nullif(p_job_id, '') as job)
 select exists (select from public.career_apply_jobs j, k where j.user_id = p_user and j.id::text is distinct from p_except
   and j.state = any(public.career_apply_counted_states()) and (p_queued or j.state <> 'queued')
   and (j.job_id = k.job or public.career_apply_posting_key(j.url) = k.key))
  or exists (select from public.extension_submission_reports r, k where r.user_id = p_user and r.id::text is distinct from p_except
   and (r.posting_key = k.job or public.career_apply_posting_key(r.posting_url) = k.key))
  or exists (select from public.career_batch_ledgers_v1 l, k
   cross join lateral jsonb_array_elements(case when jsonb_typeof(l.records) = 'array' then l.records else '[]'::jsonb end) e
   where l.user_id = p_user and k.job is not null and e->>'status' = 'submitted' and e->>'canonicalKey' = k.job
   and coalesce(e->>'userId', p_user::text) = p_user::text)
$$;

-- ------------------------------------------------------------------------------------------- the ledger's refusal
-- Why one more application of this posting is refused now: 'pace_unreadable' (a saved pace that cannot be read),
-- 'duplicate_job' (this exact posting already sent or in flight), 'daily_cap' (only against a pace the person set
-- themselves), or null. No company rule, no product number; p_company and p_daily are kept for the callers' signature.
create or replace function public.career_apply_ledger_refusal(p_user uuid, p_company text, p_except text, p_now timestamptz, p_daily integer,
 p_job_id text, p_url text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare st record;
begin
 select * into st from public.career_apply_pace_state(p_user);
 if st.state = 'unreadable' then return 'pace_unreadable'; end if;
 if (p_job_id is not null or p_url is not null) and public.career_apply_posting_sent(p_user, p_job_id, p_url, p_except, true) then
  return 'duplicate_job'; end if;
 if st.state = 'set' and (select count(*) from public.career_apply_ledger(p_user, p_now - interval '1 day') l where l.ref is distinct from p_except) >= st.pace then
  return 'daily_cap'; end if;
 return null;
end $$;

-- ------------------------------------------------------------------------------------------- the queue
-- The queue's four texts (D-MS-3), as one function the reconcile can run again: the one-ledger file (20261025100000) and
-- 20261025140000/160000 re-create them with the company rule, so whichever order they are applied in, the reconcile the
-- launch scripts run after every apply ends with these (career_apply_mass_submit_install, below).
--  1. the five-argument refusal, for any caller that still has only a company: the same rule with no posting to compare;
--  2. enqueue (20261025140000's) with the posting passed to the refusal; p_daily accepted (any value, or none), ignored;
--  3. apply-by-email reserve (20261025100000's) with the posting passed (the refused earlier attempt excepted);
--  5. the erase tombstone's guard without its employer block (below);
--  4. every claim closes, as not sent, a queued application that may no longer go: its payload no longer hashes to what
--     was approved (unchanged), or the same posting was sent by another path after the approval (D-MS-3, in place of the
--     company).
create or replace function public.career_apply_mass_submit_queue_install() returns integer
language plpgsql security definer set search_path = public, pg_temp as $qi$
begin
 execute $q$create or replace function public.career_apply_ledger_refusal(p_user uuid, p_company text, p_except text, p_now timestamptz, p_daily integer)
returns text language sql stable security definer set search_path = public, pg_temp as $$
 select public.career_apply_ledger_refusal(p_user, p_company, p_except, p_now, p_daily, null, null)
$$;
$q$;
 execute $q$create or replace function public.career_apply_enqueue(p_payload jsonb,p_hash text,p_approval text,p_daily integer default null)
returns public.career_apply_jobs language plpgsql set search_path=public,extensions,pg_temp as $$
declare u uuid:=(p_payload->>'user_id')::uuid; j public.career_apply_jobs; why text;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 if p_payload->>'version' is distinct from '1' or nullif(p_payload->>'job_id','') is null or nullif(p_payload->>'company','') is null
 or coalesce(p_payload->>'url','') !~ '^https?://' or jsonb_typeof(p_payload->'fields') is distinct from 'array'
 or p_approval is distinct from p_hash or p_hash is distinct from public.career_apply_payload_hash(p_payload)
 or public.career_apply_current(u,p_payload) is distinct from true then raise exception 'invalid or stale application approval'; end if;
 if exists(select from public.career_apply_jobs where user_id=u and job_id=p_payload->>'job_id') then raise exception 'duplicate_job'; end if;
 -- D-MS-3: the exact posting, from any path (its canonical link too); D-MS-2: only a pace the person set.
 why := public.career_apply_ledger_refusal(u, p_payload->>'company', null, now(), null, p_payload->>'job_id', p_payload->>'url');
 if why is not null then raise exception '%', why; end if;
 insert into public.career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
 values(u,p_payload->>'job_id',p_payload->>'company',p_payload->>'url',p_payload,p_hash,p_approval) returning * into j; return j;
end $$;
$q$;
 execute $q$create or replace function public.career_apply_email_reserve_for(p_user uuid, p_payload jsonb, p_hash text, p_now timestamptz)
returns public.career_apply_jobs language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare j public.career_apply_jobs; prior public.career_apply_jobs; card jsonb; why text;
begin
 if p_user is null or p_now is null or p_payload is null or p_payload->>'kind' is distinct from 'email' or p_payload->>'version' is distinct from '1'
  or p_payload->>'user_id' is distinct from p_user::text or nullif(p_payload->>'job_id', '') is null or nullif(p_payload->>'company', '') is null
  or coalesce(p_payload->>'url', '') !~ '^https?://'
  or coalesce(p_payload->>'to', '') !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$'
  or length(coalesce(p_payload->>'subject', '')) not between 1 and 200 or p_payload->>'subject' ~ '[\r\n]'
  or length(coalesce(p_payload->>'body', '')) not between 1 and 5000
  or coalesce(p_payload#>>'{attachment,sha256}', '') !~ '^[a-f0-9]{64}$'
  or p_payload ? 'cc' or p_payload ? 'bcc'
  or coalesce(p_hash, '') is distinct from public.career_apply_payload_hash(p_payload) then
  raise exception 'invalid email application'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 select value into card from public.career_watch_kv where user_id = p_user and key = 'career:email-card' for update;
 if card is null or card->>'state' is distinct from 'shown' or card->>'payload_hash' is distinct from p_hash
  or (card->>'shown_at')::timestamptz < p_now - interval '24 hours' then raise exception 'changed_since_yes'; end if;
 -- One application per posting, except an emailed one Gmail refused (nothing went): a fresh yes may try it once more.
 select * into prior from public.career_apply_jobs where user_id = p_user and job_id = p_payload->>'job_id' for update;
 if found and not (prior.state = 'not_submitted' and prior.source = 'email') then raise exception 'duplicate_job'; end if;
 why := public.career_apply_ledger_refusal(p_user, p_payload->>'company', prior.id::text, p_now, null, p_payload->>'job_id', p_payload->>'url');
 if why is not null then raise exception '%', why; end if;
 if prior.id is not null then
  update public.career_apply_jobs set payload = p_payload, payload_hash = p_hash, approval_hash = p_hash, state = 'driving', attempts = 1,
   claimed_at = p_now, lease_token = gen_random_uuid(), reason = null, confirmation_id = null,
   evidence = jsonb_build_object('earlier_attempt', prior.evidence), created_at = p_now, updated_at = p_now
   where id = prior.id returning * into j;
 else
  insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, attempts, claimed_at, lease_token, source, created_at, updated_at)
  values (p_user, p_payload->>'job_id', p_payload->>'company', p_payload->>'url', p_payload, p_hash, p_hash, 'driving', 1, p_now, gen_random_uuid(), 'email', p_now, p_now)
  returning * into j;
 end if;
 update public.career_watch_kv set value = card || jsonb_build_object('state', 'sending', 'application', j.id), updated_at = p_now
  where user_id = p_user and key = 'career:email-card';
 return j;
end $$;
$q$;
 execute $q$create or replace function public.career_apply_void_unsendable(p_user uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int;
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
 return a + b;
end $$;
$q$;
 -- 5. The erase tombstone (20261026230100): a person who erased their record may not re-apply to the exact posting they
 --    had applied to (its job id, by hash), and nothing more: no 30-day employer block (D-MS-3). The employer hashes it
 --    kept for that block are no longer needed, and are cleared.
 if to_regclass('public.career_apply_erased') is not null then
  execute $q$create or replace function public.career_apply_erased_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- D-MS-3: only the exact posting. No employer rule.
  if exists (select 1 from public.career_apply_erased e where e.user_id = new.user_id
             and e.posting_hash = encode(sha256(convert_to(new.job_id, 'UTF8')), 'hex')) then
    raise exception 'duplicate_job';
  end if;
  return new;
end $$;
$q$;
  execute 'update public.career_apply_erased set company_hash = null where company_hash is not null';
  execute $q$create or replace function public.career_apply_erased_no_employer() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$ begin new.company_hash := null; return new; end $$;
$q$;
  execute 'revoke all on function public.career_apply_erased_no_employer() from public, anon, authenticated';
  execute 'drop trigger if exists career_apply_erased_no_employer on public.career_apply_erased';
  execute 'create trigger career_apply_erased_no_employer before insert or update on public.career_apply_erased for each row execute function public.career_apply_erased_no_employer()';
 end if;
 return 5;
end $qi$;
select public.career_apply_mass_submit_queue_install();

-- ------------------------------------------------------------------------------------------- the claim at scale
-- Owner, 2026-10-27 19:52 CDT: "we need to be able to operate these things at large scale" (100,000 people at once, each
-- with hundreds of applications a day). Every claim of approved applications is:
--  - fair across people: people take turns. career_apply_claim_turns holds one row per person with an approved
--    application waiting (kept by a trigger on the queue), ordered by when they were last claimed for. A round takes the
--    longest-waiting people and hands out the oldest few of each, so one person with thousands queued never starves the
--    rest;
--  - parallel: each worker locks the people of its round with FOR UPDATE SKIP LOCKED (two workers never take the same
--    person in one round), and each row with FOR UPDATE SKIP LOCKED; state, attempts and lease_token change in the same
--    statement, so no row is ever handed out twice; there is no global lock on the hot path;
--  - bounded and indexed: a round reads at most its people (career_apply_claim_turns_ready) and a few rows of each
--    (career_apply_jobs_queued_user), never the whole queue;
--  - leased: a drive that stops without a result keeps its row 'driving' only for its 15-minute lease; then
--    career_apply_sweep (bounded, SKIP LOCKED) records it unknown_outcome, never re-driven (whether it reached the
--    employer is unknown, and sending twice is worse than not sending), and the person is told.
-- The per-call number is the worker's own batch size, not a volume limit: a worker asks again when it has room.
-- A host whose portal refused waits (career_apply_host_backoff, 20261027140000): its applications stay queued meanwhile.
create index if not exists career_apply_jobs_queued_user on public.career_apply_jobs (user_id, created_at, id) where state = 'queued';
create table if not exists public.career_apply_claim_turns (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 last_claim_at timestamptz not null default '-infinity',
 queued boolean not null default true
);
create index if not exists career_apply_claim_turns_ready on public.career_apply_claim_turns (last_claim_at, user_id) where queued;
alter table public.career_apply_claim_turns enable row level security;
revoke all on public.career_apply_claim_turns from public, anon, authenticated;
grant select on public.career_apply_claim_turns to service_role;
-- The turn row follows the queue: a person with an approved application waiting is ready; one whose last waiting
-- application left the queue is not.
create or replace function public.career_apply_claim_turns_keep() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.state = 'queued' and (tg_op = 'INSERT' or old.state is distinct from 'queued') then
  insert into public.career_apply_claim_turns (user_id) values (new.user_id)
  on conflict (user_id) do update set queued = true where not career_apply_claim_turns.queued;
 elsif tg_op = 'UPDATE' and old.state = 'queued' and new.state <> 'queued'
  and not exists (select from public.career_apply_jobs q where q.user_id = new.user_id and q.state = 'queued' and q.id <> new.id) then
  update public.career_apply_claim_turns set queued = false where user_id = new.user_id and queued;
 end if;
 return null;
end $$;
drop trigger if exists career_apply_claim_turns_keep on public.career_apply_jobs;
create trigger career_apply_claim_turns_keep after insert or update of state on public.career_apply_jobs
 for each row execute function public.career_apply_claim_turns_keep();
insert into public.career_apply_claim_turns (user_id)
 select distinct user_id from public.career_apply_jobs where state = 'queued'
 on conflict (user_id) do update set queued = true;

-- The pool claim (the cloud queue's plain door), fair and parallel as above: at least p_per_person of each person a
-- round, more each (equally) when fewer people are waiting than the batch.
create or replace function public.career_apply_claim_fair(p_now timestamptz, p_limit integer, p_per_person integer)
returns setof public.career_apply_jobs language plpgsql security definer set search_path = public, pg_temp as $$
declare people uuid[]; ids uuid[]; per int := greatest(1, coalesce(p_per_person, 1)); lim int := greatest(0, coalesce(p_limit, 0));
begin
 if p_now is null or lim = 0 then return; end if;
 -- The longest-waiting people, locked SKIP LOCKED. The turn's age is also in the WHERE (no newer than the oldest
 -- lim * 64 turns, as this statement first sees them): a turn another worker served while this one was locking is
 -- re-checked against it (READ COMMITTED re-checks the WHERE of a row it had to wait for, not the ORDER BY), so a person
 -- just served is not served again ahead of people still waiting. The window is how far ahead two workers may reach,
 -- not a limit on anything.
 people := array(select t.user_id from public.career_apply_claim_turns t where t.queued
  and t.last_claim_at <= coalesce((select x.last_claim_at from public.career_apply_claim_turns x where x.queued
   order by x.last_claim_at, x.user_id offset lim * 64 limit 1), 'infinity')
  order by t.last_claim_at, t.user_id limit (lim + per - 1) / per for update skip locked);
 if cardinality(people) = 0 then return; end if;
 -- Fewer people waiting than the batch: an equal larger share each, so the batch still fills (one person alone is not
 -- served one at a time) and nobody gets more than anyone else in the round.
 per := greatest(per, ceil(lim::numeric / cardinality(people))::int);
 update public.career_apply_claim_turns set last_claim_at = p_now where user_id = any(people);
 -- This round's candidates: each person's oldest approved, current applications on a host that is not holding back,
 -- locked (SKIP LOCKED). Only these are read and re-checked: the cost of a claim follows what it hands out.
 ids := array(select q.id from unnest(people) with ordinality as pp(u, o)
  cross join lateral (select j.id, j.created_at from public.career_apply_jobs j
   where j.user_id = pp.u and j.state = 'queued' and j.source is null and j.attempts = 0
    and public.career_apply_current(j.user_id, j.payload)
    and not exists (select from public.career_apply_host_backoff b where b.scope = 'cloud' and b.host = public.career_apply_host(j.url) and b.until > p_now)
   order by j.created_at, j.id limit per for update of j skip locked) q
  order by pp.o, q.created_at, q.id limit lim);
 if cardinality(ids) = 0 then return; end if;
 -- The approval re-check on exactly these (career_apply_void_unsendable's two rules): a payload that no longer hashes to
 -- what was approved, or a posting another path sent since, is closed as not sent and never handed out.
 update public.career_apply_jobs set state = 'not_submitted', reason = 'not sent: the application changed after it was approved',
  evidence = evidence || jsonb_build_object('closed_at', p_now, 'closed', 'approval_changed'), updated_at = p_now
  where id = any(ids) and (approval_hash is distinct from payload_hash or payload_hash is distinct from public.career_apply_payload_hash(payload));
 update public.career_apply_jobs q set state = 'not_submitted',
  reason = 'not sent: this exact posting was already sent (recorded after you approved this one)',
  evidence = q.evidence || jsonb_build_object('closed_at', p_now, 'closed', 'duplicate_posting'), updated_at = p_now
  where q.id = any(ids) and q.state = 'queued' and public.career_apply_posting_sent(q.user_id, q.job_id, q.url, q.id::text, false);
 return query
 update public.career_apply_jobs j set state = 'driving', attempts = 1, claimed_at = p_now, lease_token = gen_random_uuid(),
  updated_at = p_now, source = 'cloud'
 where j.id = any(ids) and j.state = 'queued' returning j.*;
end $$;

-- The pool claim, as every caller already calls it: the fair claim, one per person a round. It still re-checks every
-- approval (career_apply_void_unsendable, career_apply_payload_hash) before handing anything out.
create or replace function public.career_apply_claim(p_now timestamptz, p_limit integer) returns setof public.career_apply_jobs
language sql set search_path = public, pg_temp as $$
 select * from public.career_apply_claim_fair(p_now, p_limit, 1) -- re-checks each one: the career_apply_void_unsendable rules, career_apply_payload_hash
$$;

-- The sweep: a drive past its 15-minute lease becomes unknown_outcome; walked by the driving index, at most 10000 a call,
-- SKIP LOCKED so many sweepers never wait on each other.
create or replace function public.career_apply_sweep(p_now timestamptz) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare n integer;
begin
 update public.career_apply_jobs set state = 'unknown_outcome', reason = 'application outcome unknown: the drive stopped before recording it; not retried',
  evidence = evidence || jsonb_build_object('swept_at', p_now), updated_at = p_now
  where id in (select id from public.career_apply_jobs where state = 'driving' and claimed_at < p_now - interval '15 minutes'
   order by claimed_at limit 10000 for update skip locked);
 get diagnostics n = row_count;
 return n;
end $$;

-- The cloud's claim (career_apply_cloud_claim_at, installed by 20261024120000 or the bridge draft), made fair and bounded
-- where it stands: its candidates came from a window over every queued row of every opted-in person; they come from this
-- round's people (turns, SKIP LOCKED), at most 4 of each, skipping hosts that refused; each claimed person's turn moves.
-- Every check the claim makes per job (career_apply_cloud_refusal) is unchanged. Refuses (raises) if the text is not one
-- of the two it knows; does nothing when already fair.
create or replace function public.career_apply_mass_submit_fair_claim_at() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare d text; a int; b int; c int; e int; joinq text; cond text; mid text; repl text;
 head text := 'ids := array(select x.id from (select q.id, q.created_at, row_number() over (partition by q.user_id order by q.created_at, q.id) rn';
 tail text := 'order by x.rn, x.created_at, x.id limit lim * 4);';
begin
 if to_regprocedure('public.career_apply_cloud_claim_at(integer,timestamptz)') is null then return 0; end if;
 d := pg_get_functiondef('public.career_apply_cloud_claim_at(integer,timestamptz)'::regprocedure);
 if position('career_apply_claim_turns' in d) > 0 then return 0; end if;
 a := position(head in d); b := position(tail in d);
 if a = 0 or b = 0 or b < a then raise exception 'mass submit: career_apply_cloud_claim_at is not a text this file knows'; end if;
 mid := substr(d, a + length(head), b - a - length(head));
 c := position('from public.career_apply_jobs q ' in mid);
 e := position('join public.career_apply_cloud_optin o on o.user_id = q.user_id and o.enabled' in mid);
 if c = 0 or e = 0 then raise exception 'mass submit: career_apply_cloud_claim_at candidates not recognized'; end if;
 -- What the candidates join besides the opt-in (the bridge's card binding), kept as it is.
 joinq := substr(mid, c + length('from public.career_apply_jobs q '), e - c - length('from public.career_apply_jobs q '));
 c := position('and (public.career_apply_portal(q.url) = any(fams)' in mid);
 e := position(')) x' in mid);
 if c = 0 or e = 0 then raise exception 'mass submit: career_apply_cloud_claim_at families not recognized'; end if;
 cond := substr(mid, c + 4, e - c - 4 + 1);
 repl := 'people := array(select t.user_id from public.career_apply_claim_turns t join public.career_apply_cloud_optin o on o.user_id = t.user_id and o.enabled'
  || E'\n        where t.queued order by t.last_claim_at, t.user_id limit lim for update of t skip locked);'
  || E'\n  ids := array(select q.id from unnest(people) with ordinality as pp(u, ord) cross join lateral (select q.id, row_number() over (order by q.created_at, q.id) rn'
  || E'\n        from public.career_apply_jobs q ' || joinq || 'join public.career_apply_cloud_optin o on o.user_id = q.user_id and o.enabled'
  || E'\n        where q.user_id = pp.u and q.state = ''queued'' and q.attempts = 0 and q.source is null and q.approval_hash = q.payload_hash'
  || E'\n         and ' || cond
  || E'\n         and not exists (select from public.career_apply_host_backoff hb where hb.scope = ''cloud'' and hb.host = public.career_apply_host(q.url) and hb.until > p_now)'
  || E'\n        order by q.created_at, q.id limit 4) q order by q.rn, pp.ord limit lim * 4);';
 d := substr(d, 1, a - 1) || repl || substr(d, b + length(tail));
 d := replace(d, 'ids uuid[] := ''{}'';', 'ids uuid[] := ''{}''; people uuid[];');
 d := replace(d, E'  got := got + 1;\n  return next j;', E'  got := got + 1;\n  update public.career_apply_claim_turns set last_claim_at = p_now where user_id = j.user_id;\n  return next j;');
 if position('people uuid[]' in d) = 0 or position('set last_claim_at = p_now where user_id = j.user_id' in d) = 0 then
  raise exception 'mass submit: career_apply_cloud_claim_at loop not recognized'; end if;
 execute d;
 return 1;
end $$;

-- ------------------------------------------------------------------------------------------- the chat's apply queue
-- 20261026100001's queue write: a posting already sent or in flight is refused 'duplicate_job'; no company rule.
create or replace function public.career_apply_want_put_for(p_user uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare it jsonb; added text[] := '{}'; refused jsonb := '[]'; k text;
begin
  if p_user is null or p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'invalid apply queue items'; end if;
  -- No count limit (owner, 2026-10-27: no limit of Trainee's own): any number of postings at once.
  for it in select * from jsonb_array_elements(p_items) loop
    k := null;
    if exists (select from public.career_apply_wanted w where w.user_id = p_user and w.posting_key = it->>'posting_key') then continue; end if;
    if public.career_apply_posting_sent(p_user, it->>'posting_key', it->>'url', null, true) then
      refused := refused || jsonb_build_array(jsonb_build_object('posting_key', it->>'posting_key', 'reason', 'duplicate_job'));
      continue;
    end if;
    insert into public.career_apply_wanted (user_id, posting_key, url, company, title, queued_at)
    values (p_user, it->>'posting_key', it->>'url', coalesce(it->>'company', ''), coalesce(it->>'title', ''), coalesce((it->>'queued_at')::timestamptz, now()))
    on conflict (user_id, posting_key) do nothing
    returning posting_key into k;
    if k is not null then added := added || k; end if;
  end loop;
  return jsonb_build_object('added', to_jsonb(added), 'refused', refused);
end $$;

-- ------------------------------------------------------------------------------------------- the server prepare
-- 20261025140000's candidates without the 30-day employer filter (a posting already applied to is still excluded).
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
   row_number() over (partition by a.user_id order by a.alerted_at desc, p.job_id) as rn, a.alerted_at
  from a
  join public.career_postings p on p.job_id = a.job_id and p.closed_at is null
  join public.profiles pr on pr.id = a.user_id
  join public.career_watch_kv k on k.user_id = a.user_id and k.key = 'career:account' and coalesce(k.value->>'paused', 'false') <> 'true'
  where not exists (select from public.career_apply_jobs j where j.user_id = a.user_id and j.job_id = p.job_id)
   and not exists (select from public.career_apply_prepared x where x.user_id = a.user_id and x.job_id = p.job_id)
   and not exists (select from public.career_apply_prepare_attempts t where t.user_id = a.user_id and t.posting_job_id = p.job_id
    and (t.outcome = 'ready'
     or (t.outcome = 'asked' and exists (select from public.career_apply_questions q where q.user_id = a.user_id and q.state = 'open'
      and t.engine_job_id = any(q.job_ids)))
     or (t.outcome <> 'asked' and t.at > p_now - interval '7 days')))
   and public.career_apply_company_key(p.company) <> ''
   and not public.career_apply_posting_sent(a.user_id, p.job_id, p.url, null, true)
 )
 select c.user_id, c.job_id, c.company, c.title, c.url, c.location, c.description, c.epoch, c.version
 from c where c.rn <= greatest(0, coalesce(p_per_person, 0))
 order by c.alerted_at desc, c.user_id, c.job_id
 limit greatest(0, coalesce(p_limit, 0))
$$;

-- ------------------------------------------------------------------------------------------- the card holds the shown batch
-- A card is no longer 8 at most: it holds the whole batch the person is shown, of any size (owner: no limit of our own).
-- The chat pages it for reading; one answer covers every item, each still bound to its own payload hash.
alter table public.career_apply_cards drop constraint if exists career_apply_cards_items_check;
alter table public.career_apply_cards add constraint career_apply_cards_items_check
 check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) >= 1);

create or replace function public.career_apply_card_open_for(p_user uuid, p_ids uuid[], p_now timestamptz)
returns public.career_apply_cards language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.career_apply_cards; items jsonb;
begin
 if p_user is null or p_ids is null or cardinality(p_ids) < 1 or p_now is null then raise exception 'invalid card'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 if (select count(*) from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown') and id = any(p_ids)) <> cardinality(p_ids)
  or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) then raise exception 'invalid card'; end if;
 select jsonb_agg(jsonb_build_object('n', o.n, 'prepared_id', p.id, 'payload_hash', p.payload_hash) order by o.n) into items
  from unnest(p_ids) with ordinality as o(id, n) join public.career_apply_prepared p on p.id = o.id;
 update public.career_apply_prepared set state = 'shown', updated_at = p_now where id = any(p_ids);
 update public.career_apply_cards set state = 'answered', answered_at = p_now, answer = '{"closed":"a newer card was shown"}'
  where user_id = p_user and state = 'open';
 insert into public.career_apply_cards (user_id, items, shown_at) values (p_user, items, p_now) returning * into c;
 return c;
end $$;

-- 20261025180000's scheduled push, with the card size above.
create or replace function public.career_apply_card_push_for(p_user uuid, p_ids uuid[], p_text text, p_now timestamptz)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare thread uuid; c public.career_apply_cards; home_contact text; seen timestamptz;
begin
 if p_user is null or p_ids is null or cardinality(p_ids) < 1 or p_now is null
  or p_text is null or length(p_text) not between 1 and 4000 then raise exception 'invalid card push'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 if exists (select from public.channel_contacts where user_id = p_user and opted_out) then return null; end if;
 select thread_id into thread from public.channel_contacts where user_id = p_user and thread_id is not null order by last_inbound_at desc nulls last, created_at limit 1;
 if thread is null then return null; end if;
 home_contact := public.channel_target(p_user, null);
 if home_contact like 'wa:%' then
  select last_inbound_at into seen from public.channel_contacts where contact = home_contact;
  if seen is null or seen < p_now - interval '23 hours' then return null; end if;
 end if;
 if exists (select from public.career_apply_cards where user_id = p_user and state = 'open' and shown_at >= p_now - interval '24 hours')
  or exists (select from public.career_outbox where user_id = p_user and kind = 'reply' and created_at >= p_now - interval '30 minutes')
  or coalesce((select m.meta->>'intent' in ('career_apply_questions', 'career_apply_confirm_which', 'career_apply_email')
                and m.created_at >= p_now - interval '24 hours'
               from public.agent_messages m where m.thread_id = thread and m.role = 'assistant' order by m.id desc limit 1), false)
  or (select count(*) from public.career_apply_prepared where user_id = p_user and state = 'ready' and id = any(p_ids)) <> cardinality(p_ids)
 then return null; end if;
 if exists (select from public.career_apply_prepared p, unnest(p.card_lines) l
            where p.id = any(p_ids) and position(btrim(regexp_replace(l, '\s+', ' ', 'g')) in p_text) = 0) then
  raise exception 'card text does not carry every line'; end if;
 c := public.career_apply_card_open_for(p_user, p_ids, p_now);
 insert into public.agent_messages (thread_id, role, content, meta)
 values (thread, 'assistant', p_text, jsonb_build_object('career', true, 'intent', 'career_apply_card', 'card_id', c.id, 'proactive', true));
 insert into public.career_outbox (user_id, key, kind, text, deliver_at, card_id) values (p_user, 'card:' || c.id, 'card', p_text, p_now, c.id);
 return c.id;
end $$;

-- ------------------------------------------------------------------------------------------- the cloud dispatcher
-- 20261026100000's dispatcher, each family claimed in one call for its whole share (no 6-at-a-time, no 500 a call). Its
-- global and per-portal numbers are the worker's own room (how many sandboxes it runs), not limits of Trainee's own.
create or replace function public.career_apply_cloud_dispatch_claim(p_want integer, p_global integer, p_per_portal integer)
returns setof public.career_apply_jobs language plpgsql security definer set search_path = public, pg_temp as $$
declare live jsonb; total int; room int; f text; n int; got int; j public.career_apply_jobs;
begin
 -- The worker's own room (how many sandboxes it can run), never a number of Trainee's own: any count, none refused.
 if p_want is null or p_want < 0 or p_global is null or p_global < 1 or p_per_portal is null or p_per_portal < 1 then
  raise exception 'invalid dispatch limits'; end if;
 perform pg_advisory_xact_lock(hashtextextended('career-cloud-dispatch-v1', 0));
 live := public.career_apply_cloud_inflight(clock_timestamp());
 total := (live->>'total')::int;
 room := least(p_want, p_global - total);
 for f in select x from unnest(array['greenhouse', 'lever', 'ashby']) x order by (live->>x)::int, x loop
  exit when room <= 0;
  n := least(room, p_per_portal - (live->>f)::int);
  continue when n <= 0;
  got := 0;
  for j in select * from public.career_apply_cloud_claim_portal_at(n, clock_timestamp(), f) loop
   got := got + 1;
   return next j;
  end loop;
  room := room - got;
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------- the installed pair, rewritten
-- The claims and cloud checks are installed by whichever of the bridge draft, its rollback, the one-ledger file and the
-- reconcile ran last, so they are rewritten where they stand: each anchor below is an exact text one of those files
-- installs; a function that still holds an old bound after the rewrite stops this with its name.
create or replace function public.career_apply_mass_submit_rewrite(p_fn text, p_pairs text[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare d text; was text; i int; changed int := 0;
begin
 if to_regprocedure(p_fn) is null then return 0; end if;
 d := pg_get_functiondef(to_regprocedure(p_fn)); was := d;
 for i in 1 .. coalesce(array_length(p_pairs, 1), 0) / 2 loop
  d := replace(d, p_pairs[2 * i - 1], p_pairs[2 * i]);
 end loop;
 if d is distinct from was then execute d; changed := 1; end if;
 return changed;
end $$;

create or replace function public.career_apply_mass_submit_install() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; f text; d text; bad text[] := '{}';
 dup_old text := E' if co <> '''' and exists (select from public.career_apply_ledger(j.user_id, p_now - interval ''30 days'') l\n  where l.company_key = co and l.ref is distinct from j.id::text) then\n  return ''company_cooldown''; end if;';
 dup_new text := E' -- D-MS-3: only this exact posting, already sent by any path, is refused (no company rule).\n if public.career_apply_posting_sent(j.user_id, j.job_id, j.url, j.id::text, false) then return ''duplicate_job''; end if;';
 own_pace text := 'coalesce(public.career_apply_daily_limit(j.user_id), case when (select s.state from public.career_apply_pace_state(j.user_id) s) = ''unreadable'' then 0 else 2147483647 end)';
begin
 -- The queue's texts, again, if an older file put its own back (the company rule, or no posting passed).
 if (select prosrc from pg_proc where oid = 'public.career_apply_enqueue(jsonb,text,text,integer)'::regprocedure) !~ 'p_payload->>''url''\)'
  or (select prosrc from pg_proc where oid = 'public.career_apply_email_reserve_for(uuid,jsonb,text,timestamptz)'::regprocedure) !~ 'p_payload->>''url''\)'
  or (select prosrc from pg_proc where oid = 'public.career_apply_void_unsendable(uuid,timestamptz)'::regprocedure) !~ 'career_apply_posting_sent'
  or (select prosrc from pg_proc where oid = 'public.career_apply_ledger_refusal(uuid,text,text,timestamptz,integer)'::regprocedure) ~ 'company_cooldown'
  or coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.career_apply_erased_guard()')), '') ~ 'company_cooldown' then
  n := n + public.career_apply_mass_submit_queue_install();
 end if;
 -- No claim-size bound of 6 (D-MS-2), in every text that installs one.
 foreach f in array array['public.career_apply_claim_own(integer,text)', 'public.career_apply_claim(timestamptz,integer)',
   'public.career_apply_cloud_claim_at(integer,timestamptz)'] loop
  n := n + public.career_apply_mass_submit_rewrite(f, array[
   'least(6,coalesce(p_limit,0))', 'coalesce(p_limit,0)',
   'least(6, coalesce(p_limit, 0))', 'coalesce(p_limit, 0)']);
 end loop;
 -- The cloud's check: no product number (25, or the bridge's 15) and no company rule; the person's own pace only.
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_cloud_refusal(public.career_apply_jobs,timestamptz)', array[
  'least(15, coalesce(o.daily, 15), public.career_apply_daily_limit(j.user_id))', own_pace,
  'least(coalesce(o.daily, 25), public.career_apply_daily_limit(j.user_id))', own_pace,
  'own := coalesce(o.daily, public.career_apply_daily_limit(j.user_id));', 'own := public.career_apply_daily_limit(j.user_id);',
  dup_old, dup_new]);
 -- The bridge draft's own: the authorize before effect, its opt-in.
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)', array[
  '>=least(15,coalesce(o.daily,15),public.career_apply_daily_limit(u))',
  '>=coalesce(public.career_apply_daily_limit(u),case when (select s.state from public.career_apply_pace_state(u) s)=''unreadable'' then 0 else 2147483647 end)',
  E' if public.career_apply_company_key(j.company)<>'''' and exists(select 1 from public.career_apply_jobs x where x.user_id=u and x.id<>j.id and x.state=any(went)\n  and coalesce(x.claimed_at,x.created_at)>n-interval''30 days'' and public.career_apply_company_key(x.company)=public.career_apply_company_key(j.company)) then raise exception ''company_cooldown''; end if;',
  ' if public.career_apply_posting_sent(u,j.job_id,j.url,j.id::text,false) then raise exception ''duplicate_job''; end if;']);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_cloud_optin_as(uuid,boolean,text)', array[
  'd := least(15, public.career_apply_daily_limit(p_user));', 'd := public.career_apply_daily_limit(p_user);']);
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_cloud_optin_get(uuid)', array[
  'least(15,coalesce(daily,15),public.career_apply_daily_limit(p_user))', 'public.career_apply_daily_limit(p_user)',
  'least(15,public.career_apply_daily_limit(p_user))', 'public.career_apply_daily_limit(p_user)']);
 alter table public.career_apply_cloud_optin alter column daily drop default;
 -- The pool claim and the sweep, if an older file put its own back (one unfair window over the queue).
 if (select prosrc from pg_proc where oid = 'public.career_apply_claim(timestamptz,integer)'::regprocedure) !~ 'career_apply_claim_fair' then
  execute 'create or replace function public.career_apply_claim(p_now timestamptz, p_limit integer) returns setof public.career_apply_jobs
language sql set search_path = public, pg_temp as $c$
 select * from public.career_apply_claim_fair(p_now, p_limit, 1) -- re-checks each one: the career_apply_void_unsendable rules, career_apply_payload_hash
$c$';
  n := n + 1;
 end if;
 -- The cloud claim made fair and bounded; the person's own claim skips a host that refused them.
 n := n + public.career_apply_mass_submit_fair_claim_at();
 n := n + public.career_apply_mass_submit_rewrite('public.career_apply_claim_own(integer,text)', array[
  E'and payload_hash=public.career_apply_payload_hash(payload)\n  order by created_at,id limit greatest(0,coalesce(p_limit,0))',
  E'and payload_hash=public.career_apply_payload_hash(payload)\n  and not exists (select from public.career_apply_host_backoff hb where hb.scope = u::text and hb.host = public.career_apply_host(url) and hb.until > n)\n  order by created_at,id limit greatest(0,coalesce(p_limit,0))']);
 -- The cloud runner's per-portal claim is generated from claim_at: generate it again from the rewritten one.
 if to_regprocedure('public.career_apply_cloud_claim_portal_install()') is not null then perform public.career_apply_cloud_claim_portal_install(); end if;
 -- Nothing of the old bounds may be left in what is installed.
 foreach f in array array['public.career_apply_erased_guard()', 'public.career_apply_claim_own(integer,text)', 'public.career_apply_claim(timestamptz,integer)',
   'public.career_apply_cloud_claim_at(integer,timestamptz)', 'public.career_apply_cloud_claim_portal_at(integer,timestamptz,text)',
   'public.career_apply_cloud_refusal(public.career_apply_jobs,timestamptz)', 'public.career_apply_message_cloud_authorize(uuid,uuid,text,text)',
   'public.career_apply_cloud_optin_as(uuid,boolean,text)', 'public.career_apply_cloud_optin_get(uuid)'] loop
  continue when to_regprocedure(f) is null;
  d := (select prosrc from pg_proc where oid = to_regprocedure(f));
  if d ~ 'least\(6,|least\(6, |least\(15|company_cooldown|coalesce\(o\.daily' then bad := bad || f; end if;
 end loop;
 if (select prosrc from pg_proc where oid = to_regprocedure('public.career_apply_cloud_claim_at(integer,timestamptz)')) !~ 'career_apply_claim_turns' then
  bad := bad || 'public.career_apply_cloud_claim_at(integer,timestamptz): not fair'::text; end if;
 if (select prosrc from pg_proc where oid = 'public.career_apply_claim_own(integer,text)'::regprocedure) !~ 'career_apply_host_backoff' then
  bad := bad || 'public.career_apply_claim_own(integer,text): no portal backoff'::text; end if;
 if cardinality(bad) > 0 then raise exception 'mass submit: an old bound is still installed in %', array_to_string(bad, ', '); end if;
 return format('rewritten %s', n);
end $$;

-- The cloud check without the bridge, as the reconcile installs it (20261025160000's text, rewritten as above). Kept
-- under its name: the reconcile calls it.
create or replace function public.career_apply_cloud_refusal_own_pace() returns void
language plpgsql security definer set search_path = public, pg_temp as $op$
begin
 if to_regclass('career_message_approval_private.cloud_bound_jobs') is not null then return; end if;
 execute $body$create or replace function public.career_apply_cloud_refusal(j public.career_apply_jobs, p_now timestamptz) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare fam text := public.career_apply_portal(j.url); o public.career_apply_cloud_optin; a jsonb; own integer; went text[] :=
 array['driving', 'confirmed', 'submitted_unconfirmed', 'needs_user', 'unknown_outcome'];
begin
 if j.state <> 'queued' or j.attempts <> 0 or j.source is not null or j.approval_hash is distinct from j.payload_hash
  or j.payload_hash is distinct from public.career_apply_payload_hash(j.payload)
  or coalesce(j.payload->>'engine_approval', '') !~ '^[0-9a-f]{64}$' then return 'not_approved'; end if;
 if public.career_apply_current(j.user_id, j.payload) is distinct from true then return 'stale'; end if;
 if fam is null or fam not in ('greenhouse', 'lever', 'ashby') then return 'portal_not_cloud'; end if;
 if coalesce(j.payload->>'destination', '') !~ '^https://' then return 'person_submits'; end if;
 if not public.career_apply_cloud_open(fam) and public.career_apply_cloud_waiver_left(j.user_id, fam, p_now) <= 0 then return 'gate_closed'; end if;
 select * into o from public.career_apply_cloud_optin where user_id = j.user_id;
 select value into a from public.career_watch_kv where user_id = j.user_id and key = 'career:account';
 if o.user_id is null or not o.enabled or o.privacy_epoch is distinct from coalesce((a->>'epoch')::bigint, 0) then return 'not_opted_in'; end if;
 if exists (select from public.career_apply_cloud_pauses where scope = 'portal' and portal = fam and until > p_now) then
  return 'portal_paused'; end if;
 if exists (select from public.career_apply_cloud_pauses where scope = 'person' and user_id = j.user_id and until > p_now) then
  return 'person_paused'; end if;
 if (select s.state from public.career_apply_pace_state(j.user_id) s) = 'unreadable' then return 'pace_unreadable'; end if;
 -- D-MS-2: only a pace the person set themselves (career_apply_pace_set), none by default.
 own := public.career_apply_daily_limit(j.user_id);
 if own is not null and (select count(*) from public.career_apply_jobs where user_id = j.user_id and state = any(went) and claimed_at > p_now - interval '1 day') >= own then
  return 'daily_limit'; end if;
 -- D-MS-3: only this exact posting, already sent by any path, is refused (no company rule).
 if public.career_apply_posting_sent(j.user_id, j.job_id, j.url, j.id::text, false) then return 'duplicate_job'; end if;
 return null;
end $$;$body$;
end $op$;

-- What the live definitions lack, 20261025110000's list with D-MS-2/3: the cloud check reads the exact-posting rule (in
-- place of the company ledger) and no claim or cloud check keeps a product bound.
create or replace function public.career_apply_guards_missing() returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare out text[] := '{}'; d text; f text; bridge boolean := to_regclass('career_message_approval_private.cloud_bound_jobs') is not null;
begin
 d := pg_get_functiondef('public.career_apply_claim_own(integer,text)'::regprocedure);
 if d !~ 'career_apply_void_unsendable' or d !~ 'career_apply_payload_hash\(payload\)' then out := array_append(out, 'career_apply_claim_own: no approval re-check'); end if;
 if bridge and (d !~ 'career-card-cloud-bridge-maintenance-v1' or d !~ 'cloud_bound_jobs') then
  out := array_append(out, 'career_apply_claim_own: takes cloud-bound jobs'); end if;
 d := pg_get_functiondef('public.career_apply_claim(timestamptz,integer)'::regprocedure);
 if d !~ 'career_apply_void_unsendable' or d !~ 'career_apply_payload_hash' then out := array_append(out, 'career_apply_claim: no approval re-check'); end if;
 d := pg_get_functiondef('public.career_apply_cloud_refusal(public.career_apply_jobs,timestamptz)'::regprocedure);
 if d !~ 'career_apply_payload_hash\(j\.payload\)' then out := array_append(out, 'career_apply_cloud_refusal: no approval re-check'); end if;
 if d !~ 'career_apply_posting_sent\(' then out := array_append(out, 'career_apply_cloud_refusal: not on the one ledger'); end if;
 if bridge and (d !~ 'cloud_bound_refusal' or d !~ 'cloud_switches_off') then
  out := array_append(out, 'career_apply_cloud_refusal: no card binding or switches'); end if;
 d := pg_get_functiondef('public.career_apply_enqueue(jsonb,text,text,integer)'::regprocedure);
 if d !~ 'career_apply_ledger_refusal\(' or d !~ 'p_payload->>''url''\)' then out := array_append(out, 'career_apply_enqueue: not on the one ledger and cap'); end if;
 d := pg_get_functiondef('public.career_apply_email_reserve_for(uuid,jsonb,text,timestamptz)'::regprocedure);
 if d !~ 'career_apply_ledger_refusal\(' or d !~ 'p_payload->>''url''\)' then out := array_append(out, 'career_apply_email_reserve_for: not on the one ledger and cap'); end if;
 d := pg_get_functiondef('public.career_apply_jobs_fixed()'::regprocedure);
 if d !~ 'approval_fixed' then out := array_append(out, 'career_apply_jobs_fixed: approval not frozen'); end if;
 if not exists (select from pg_trigger where tgname = 'career_apply_jobs_confirmation' and tgrelid = 'public.career_apply_jobs'::regclass and tgenabled <> 'D') then
  out := array_append(out, 'career_apply_jobs_confirmation: trigger missing'); end if;
 -- D-MS-2 / D-MS-3: no product bound left anywhere a claim or a cloud check is installed.
 foreach f in array array['public.career_apply_claim_own(integer,text)', 'public.career_apply_claim(timestamptz,integer)',
   'public.career_apply_cloud_claim_at(integer,timestamptz)', 'public.career_apply_cloud_refusal(public.career_apply_jobs,timestamptz)',
   'public.career_apply_message_cloud_authorize(uuid,uuid,text,text)'] loop
  continue when to_regprocedure(f) is null;
  d := (select prosrc from pg_proc where oid = to_regprocedure(f));
  if d ~ 'least\(6,|least\(6, |least\(15|coalesce\(o\.daily' then out := array_append(out, f || ': a product volume bound'); end if;
  if d ~ 'company_cooldown' then out := array_append(out, f || ': the company rule'); end if;
 end loop;
 return out;
end $$;

-- The name the launch scripts call (20261025140000's wrapper): the reconcile, the own-pace text, then the rewrite above.
create or replace function public.career_apply_reconcile_bridge() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r text;
begin
 r := public.career_apply_reconcile_bridge_20261025110000();
 perform public.career_apply_cloud_refusal_own_pace();
 perform public.career_apply_mass_submit_install();
 return r;
end $$;

revoke all on function public.career_apply_claim_turns_keep(), public.career_apply_claim_fair(timestamptz, integer, integer),
 public.career_apply_mass_submit_fair_claim_at() from public, anon, authenticated;
revoke all on function public.career_apply_claim_turns_keep(), public.career_apply_mass_submit_fair_claim_at() from service_role;
grant execute on function public.career_apply_claim_fair(timestamptz, integer, integer) to service_role;
revoke all on function public.career_apply_posting_sent(uuid, text, text, text, boolean),
 public.career_apply_ledger_refusal(uuid, text, text, timestamptz, integer, text, text),
 public.career_apply_ledger_refusal(uuid, text, text, timestamptz, integer),
 public.career_apply_email_reserve_for(uuid, jsonb, text, timestamptz),
 public.career_apply_void_unsendable(uuid, timestamptz),
 public.career_apply_want_put_for(uuid, jsonb),
 public.career_apply_prepare_candidates(timestamptz, integer, integer),
 public.career_apply_card_open_for(uuid, uuid[], timestamptz),
 public.career_apply_card_push_for(uuid, uuid[], text, timestamptz),
 public.career_apply_cloud_dispatch_claim(integer, integer, integer),
 public.career_apply_mass_submit_rewrite(text, text[]), public.career_apply_mass_submit_install(), public.career_apply_mass_submit_queue_install(),
 public.career_apply_cloud_refusal_own_pace(), public.career_apply_guards_missing(), public.career_apply_reconcile_bridge()
 from public, anon, authenticated;
revoke all on function public.career_apply_card_open_for(uuid, uuid[], timestamptz), public.career_apply_card_push_for(uuid, uuid[], text, timestamptz),
 public.career_apply_mass_submit_rewrite(text, text[]), public.career_apply_mass_submit_install(), public.career_apply_mass_submit_queue_install(),
 public.career_apply_cloud_refusal_own_pace(), public.career_apply_reconcile_bridge() from service_role;
grant execute on function public.career_apply_posting_sent(uuid, text, text, text, boolean),
 public.career_apply_ledger_refusal(uuid, text, text, timestamptz, integer, text, text),
 public.career_apply_ledger_refusal(uuid, text, text, timestamptz, integer),
 public.career_apply_void_unsendable(uuid, timestamptz), public.career_apply_want_put_for(uuid, jsonb),
 public.career_apply_prepare_candidates(timestamptz, integer, integer), public.career_apply_cloud_dispatch_claim(integer, integer, integer),
 public.career_apply_guards_missing() to service_role;

select public.career_apply_reconcile_bridge();
