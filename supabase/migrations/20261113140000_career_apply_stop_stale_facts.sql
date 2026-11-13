-- D-075 (review of #790, round 3, item 5; round 2 of PR #822): an approved hosted application is stopped when a fact it states is
-- set aside, corrected, replaced or removed.
--
-- An approved application carries the answers it was prepared with (career_apply_jobs.payload, frozen under payload_hash). Nothing
-- on the hosted path read the person's facts again, so after "the 3.9 gpa is outdated" (code sets the fact aside), a correction
-- (correct_profile_fact, a router entry correction) or a new screening answer (saveScreenFact replaces the fact) the approved row
-- stating the old fact was still claimed and sent. The rule: facts about the person come only from facts they confirmed (D-007),
-- and nothing is sent without their yes to that exact application.
--
-- WHAT A CHANGE IS, AND WHERE IT IS RECORDED (career_apply_fact_changes: person, time, fact ids, value keys). Every fact write goes
-- through the host commit, which writes the person's profile to the account record (career_watch_kv 'career:account', memory) and
-- the thread's copy (agent_flow_state). A trigger on each (career_apply_facts_write_record) compares the facts before and after, in
-- the same transaction as the write: a fact in use (confirmed) that is removed, rejected, set aside (withdrawn_by_owner) or whose
-- words or value changed is recorded with its id and the keys of its old value. The thread copy is compared only while the account
-- holds no profile (the account copy is the record when it does: a stale thread copy is never read as a change). So the record
-- exists even when the chat's stop call below fails, and every guard reads it.
--
-- WHAT AN APPLICATION "STATES" (career_apply_payload_stale): a field carrying a factId states that fact, whatever its value says
-- ("Yes" to "authorized to work?" from the work authorization fact); a changed fact id makes it stale. Text and numbers with no
-- factId are compared by normalised keys (career_apply_value_keys): numbers by value (3.9 = 3.90 = the 3.9 of "3.9/4.0"), dates
-- by month and year ("May 2024" = "05/2024" = "2024-05"), any other text only as a whole phrase of four or more characters that is
-- not one common word (never "yes", "no", "May" alone: those are covered by the fact id).
--
-- WHAT IS CLOSED:
--   1. The chat's stop (career_apply_stop_stale_facts(p_user, p_changes, p_reason), service role only, under the person's locks;
--      it records the change first): for that person, approved rows not started (queued, attempts = 0) are closed not_submitted
--      (evidence.reason 'fact_changed'); rows waiting on the person (needs_user, a hand-off included) are closed the same way and
--      reported as needing a fresh look; a row the apply VM holds that has not reached its submit point (vm_phase not
--      'submitting', no click recorded) is closed and its lease taken, so the worker's next check stops it unsent; prepared rows
--      not yet approved are removed and their open card closed. A queued row already tried is reported (the claim refuses it); a
--      row past its submit point, or driven by the person's own computer, the cloud runner or an email, is reported as being sent.
--   2. Every claim (trigger career_apply_facts_claim_guard on queued -> driving): a row whose facts_at is older than a recorded
--      change it states is closed instead of started.
--   3. The submit points: the apply VM's 'submitting' heartbeat (career_apply_vm_heartbeat, as 20261105120000 with this one check)
--      closes the row and answers {ok: false, why: 'fact_changed'}; the cloud runner's authorization (career_apply_cloud_authorize_any)
--      refuses 'fact_changed'; an emailed application, started at the person's yes to its card, is refused when the card was shown
--      before the change (career_apply_facts_email_guard). The person's own computer refuses itself (checkSubmitGuards:
--      stale_packet_facts).
--   facts_at (prepared and approved rows) is when the facts were read: the prepare, else the approval; only a new approval (a new
--   payload or approval hash) moves it. A stopped application comes back only through a new approval; putting a fact back
--   re-queues nothing.
-- Additive and reversible (supabase/rollbacks/20261113140000_career_apply_stop_stale_facts.down.sql). Idempotent.

create table if not exists public.career_apply_fact_changes (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 at timestamptz not null default clock_timestamp(),
 fact_ids text[] not null default '{}',
 fact_keys text[] not null default '{}',
 reason text not null check (reason ~ '^[a-z_]{1,40}$'),
 check (cardinality(fact_ids) + cardinality(fact_keys) between 1 and 400)
);
create index if not exists career_apply_fact_changes_user_at on public.career_apply_fact_changes (user_id, at desc);
alter table public.career_apply_fact_changes enable row level security; -- no policy: the functions below only
revoke all on public.career_apply_fact_changes from public, anon, authenticated;
grant all on public.career_apply_fact_changes to service_role;

alter table public.career_apply_prepared add column if not exists facts_at timestamptz;
alter table public.career_apply_jobs add column if not exists facts_at timestamptz;
-- Rows from before this file keep facts_at null: it reads as the time they were made (created_at).

-- The key of one value, or null when it is not one that can be compared on its own: 'n:<number>', 'd:<year>-<month>', 't:<phrase>'.
create or replace function public.career_apply_value_key(p text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare t text := lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')); m text[]; mi int;
begin
 if t = '' then return null; end if;
 m := regexp_match(t, '^([0-9]{1,2})/(?:[0-9]{1,2}/)?((?:19|20)[0-9]{2})$');
 if m is not null and m[1]::int between 1 and 12 then return 'd:' || m[2] || '-' || lpad(m[1], 2, '0'); end if;
 m := regexp_match(t, '^((?:19|20)[0-9]{2})-([0-9]{1,2})(?:-[0-9]{1,2})?$');
 if m is not null and m[2]::int between 1 and 12 then return 'd:' || m[1] || '-' || lpad(m[2], 2, '0'); end if;
 m := regexp_match(t, '^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?: [0-9]{1,2}(?:st|nd|rd|th)?,?)? ((?:19|20)[0-9]{2})$');
 if m is not null then
  mi := array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'], m[1]);
  return 'd:' || m[2] || '-' || lpad(mi::text, 2, '0');
 end if;
 m := regexp_match(t, '^\$?\s*(-?[0-9]+(?:\.[0-9]+)?)\s*(?:/\s*[0-9]+(?:\.[0-9]+)?)?\s*%?$');
 if m is not null then return 'n:' || trim_scale(m[1]::numeric)::text; end if;
 if length(t) < 4 or t !~ '[a-z0-9]' then return null; end if;
 if t !~ ' ' and t ~ '^(yes|no|none|true|false|maybe|other|unknown|null|n/a|prefer|declined|decline|with|have|that|this|from|will|your|they|been|were|what|when|where|which|their|there|would|about|also|into|only|some|than|then|them|these|those|very|just|more|most|such|over|under|january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\.?$' then return null; end if;
 return 't:' || t;
end $$;
revoke all on function public.career_apply_value_key(text) from public, anon, authenticated;

-- Every key a text holds: its own key, each number in it and each month-year date in it.
create or replace function public.career_apply_value_keys(p text) returns text[]
language sql immutable set search_path = public, pg_temp as $$
 select coalesce(array_agg(distinct k) filter (where k is not null), '{}') from (
  select public.career_apply_value_key(p) k
  union all select public.career_apply_value_key(x[1]) from regexp_matches(coalesce(p, ''), '(?<![0-9.])([0-9]+(?:\.[0-9]+)?)(?![0-9]|\.[0-9])', 'g') x
  union all select public.career_apply_value_key(x[1]) from regexp_matches(lower(coalesce(p, '')),
   '((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?: [0-9]{1,2}(?:st|nd|rd|th)?,?)? (?:19|20)[0-9]{2}|(?<![0-9/])[0-9]{1,2}/(?:[0-9]{1,2}/)?(?:19|20)[0-9]{2}|(?:19|20)[0-9]{2}-[0-9]{1,2})', 'g') x
 ) z
$$;
revoke all on function public.career_apply_value_keys(text) from public, anon, authenticated;

-- The keys a fact's old value no longer has: everything its old words and value held (and the value after its label, "GPA: 3.9"),
-- minus what the new words still hold when the fact was corrected (null p_now: set aside, removed or rejected).
create or replace function public.career_apply_changed_keys(p_was text, p_was_value text, p_now text, p_now_value text) returns text[]
language sql immutable set search_path = public, pg_temp as $$
 select coalesce(array_agg(distinct k), '{}') from (
  select unnest(public.career_apply_value_keys(p_was) || public.career_apply_value_keys(p_was_value)
   || public.career_apply_value_keys((regexp_match(coalesce(p_was, ''), '^[^:]{1,40}:\s*(\S.*)$'))[1])) k
  except select unnest(public.career_apply_value_keys(p_now) || public.career_apply_value_keys(p_now_value)
   || public.career_apply_value_keys((regexp_match(coalesce(p_now, ''), '^[^:]{1,40}:\s*(\S.*)$'))[1]))
 ) z where k is not null
$$;
revoke all on function public.career_apply_changed_keys(text, text, text, text) from public, anon, authenticated;

-- Does this payload state one of these facts (by id) or values (by key)? An object with a factId states that fact and nothing
-- else; text and numbers outside such objects are compared by key, and a phrase key also as a whole phrase inside longer text.
create or replace function public.career_apply_payload_stale(p jsonb, p_ids text[], p_keys text[]) returns boolean
language plpgsql immutable set search_path = public, pg_temp as $$
declare v jsonb; s text; k text;
begin
 if p is null then return false; end if;
 case jsonb_typeof(p)
  when 'object' then
   if p ? 'factId' then return coalesce(p->>'factId', '') = any(coalesce(p_ids, '{}')); end if;
   -- The application's own bookkeeping (where it goes, whose it is, its hashes and times) states no fact.
   for v in select value from jsonb_each(p) where key not in ('url', 'destination', 'link', 'job_id', 'company', 'user_id', 'version',
     'privacy_epoch', 'account_version', 'expires_at', 'engine_approval', 'resume_sha256', 'sha256', 'payload_hash', 'approval_hash',
     'attachment', 'to', 'cc', 'bcc', 'id', 'name', 'label', 'selector', 'field_id', 'type', 'required', 'options') loop
    if public.career_apply_payload_stale(v, p_ids, p_keys) then return true; end if;
   end loop;
   return false;
  when 'array' then
   for v in select value from jsonb_array_elements(p) loop if public.career_apply_payload_stale(v, p_ids, p_keys) then return true; end if; end loop;
   return false;
  when 'string', 'number' then
   if coalesce(cardinality(p_keys), 0) = 0 then return false; end if;
   s := p #>> '{}';
   if s ~* '^(https?://|mailto:)' or s ~* '^[0-9a-f]{32,}$' or s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then return false; end if;
   if public.career_apply_value_keys(s) && p_keys then return true; end if;
   s := ' ' || btrim(regexp_replace(lower(s), '[^a-z0-9]+', ' ', 'g')) || ' ';
   foreach k in array p_keys loop
    if k like 't:%' and position(' ' || btrim(regexp_replace(substr(k, 3), '[^a-z0-9]+', ' ', 'g')) || ' ' in s) > 0 then return true; end if;
   end loop;
   return false;
  else return false;
 end case;
end $$;
revoke all on function public.career_apply_payload_stale(jsonb, text[], text[]) from public, anon, authenticated;

-- The latest recorded change, at or after p_since, that this payload states; null when none.
create or replace function public.career_apply_fact_hit(p_user uuid, p_payload jsonb, p_since timestamptz) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
 select max(c.at) from public.career_apply_fact_changes c
  where c.user_id = p_user and c.at >= p_since and public.career_apply_payload_stale(p_payload, c.fact_ids, c.fact_keys)
$$;
revoke all on function public.career_apply_fact_hit(uuid, jsonb, timestamptz) from public, anon, authenticated;

-- The facts that changed between two copies of a profile's facts: the ids and the keys of their old values.
create or replace function public.career_apply_facts_diff(p_old jsonb, p_new jsonb, out ids text[], out keys text[])
language sql immutable set search_path = public, pg_temp as $$
 with o as (select f from jsonb_array_elements(case when jsonb_typeof(p_old) = 'array' then p_old else '[]'::jsonb end) f
   where jsonb_typeof(f) = 'object' and coalesce(f->>'id', '') <> '' and coalesce(f->>'status', '') not in ('draft', 'rejected')
    and coalesce(f->>'needs_confirmation', 'false') <> 'true' and not f ? 'withdrawn_by_owner'),
  n as (select f from jsonb_array_elements(case when jsonb_typeof(p_new) = 'array' then p_new else '[]'::jsonb end) f where jsonb_typeof(f) = 'object'),
  c as (select o.f as was, (select n.f from n where n.f->>'id' = o.f->>'id' limit 1) as now from o)
 select coalesce(array_agg(distinct c.was->>'id'), '{}'),
  coalesce((select array_agg(distinct k) from c c2, unnest(public.career_apply_changed_keys(c2.was->>'text', c2.was->>'value',
     case when c2.now is null or c2.now ? 'withdrawn_by_owner' or c2.now->>'status' = 'rejected' then null else c2.now->>'text' end,
     case when c2.now is null or c2.now ? 'withdrawn_by_owner' or c2.now->>'status' = 'rejected' then null else c2.now->>'value' end)) k
    where c2.now is null or c2.now ? 'withdrawn_by_owner' or c2.now->>'status' = 'rejected'
     or lower(btrim(coalesce(c2.now->>'text', ''))) <> lower(btrim(coalesce(c2.was->>'text', '')))
     or coalesce(c2.now->>'value', '') <> coalesce(c2.was->>'value', '')), '{}')
 from c where c.now is null or c.now ? 'withdrawn_by_owner' or c.now->>'status' = 'rejected'
  or lower(btrim(coalesce(c.now->>'text', ''))) <> lower(btrim(coalesce(c.was->>'text', '')))
  or coalesce(c.now->>'value', '') <> coalesce(c.was->>'value', '')
$$;
revoke all on function public.career_apply_facts_diff(jsonb, jsonb) from public, anon, authenticated;

-- The record, written by the fact write itself (same transaction).
create or replace function public.career_apply_facts_write_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; old_f jsonb; new_f jsonb;
begin
 if tg_table_name = 'career_watch_kv' then
  if new.key is distinct from 'career:account' then return null; end if;
  old_f := old.value #> '{memory,profile,facts}'; new_f := new.value #> '{memory,profile,facts}';
  if new_f is null and old_f is not null and not (new.value ? 'memory') then return null; end if; -- the memory was not written
 else
  -- The thread's copy is the record only while the account holds no profile.
  if exists (select from public.career_watch_kv k where k.user_id = new.user_id and k.key = 'career:account'
    and jsonb_typeof(k.value #> '{memory,profile,facts}') = 'array') then return null; end if;
  old_f := old.state #> '{career,stores,profile,facts}'; new_f := new.state #> '{career,stores,profile,facts}';
  if new_f is null then return null; end if;
 end if;
 if old_f is null or old_f = new_f then return null; end if;
 select * into d from public.career_apply_facts_diff(old_f, new_f);
 if cardinality(d.ids) > 0 then
  insert into public.career_apply_fact_changes (user_id, fact_ids, fact_keys, reason)
  values (new.user_id, d.ids[1:200], d.keys[1:200], 'fact_write');
 end if;
 return null;
end $$;
revoke all on function public.career_apply_facts_write_record() from public, anon, authenticated; -- trigger function
drop trigger if exists career_apply_facts_write_record on public.career_watch_kv;
create trigger career_apply_facts_write_record after update of value on public.career_watch_kv
 for each row when (new.key = 'career:account') execute function public.career_apply_facts_write_record();
drop trigger if exists career_apply_facts_write_record on public.agent_flow_state;
create trigger career_apply_facts_write_record after update of state on public.agent_flow_state
 for each row execute function public.career_apply_facts_write_record();

-- facts_at: when the facts a row carries were read. A prepared row: when it was prepared (again). An approved row: its prepared
-- row's time, else the approval's; moved only by a new approval (a new payload or approval hash).
create or replace function public.career_apply_facts_at_stamp() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if tg_table_name = 'career_apply_prepared' then
  if tg_op = 'INSERT' or new.payload_hash is distinct from old.payload_hash or (new.state = 'ready' and old.state not in ('ready', 'shown')) then
   new.facts_at := clock_timestamp();
  else new.facts_at := coalesce(old.facts_at, old.created_at); end if;
  return new;
 end if;
 if tg_op = 'INSERT' or new.payload_hash is distinct from old.payload_hash or new.approval_hash is distinct from old.approval_hash then
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

-- The one close every stop uses: not sent, with the reason, unclaimed. A row the apply VM holds loses its lease (its next check
-- answers lease_lost and nothing is clicked); a row past its submit point is never closed here.
create or replace function public.career_apply_fact_changed_close(p_id uuid, p_at timestamptz, p_by text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 update public.career_apply_jobs set state = 'not_submitted', reason = 'not sent: a fact it states changed after you approved it',
  lease_token = null, claimed_at = null, vm_heartbeat_at = null,
  evidence = evidence || jsonb_build_object('reason', 'fact_changed', 'nothing_sent', true, 'fact_changed_at', p_at, 'stopped_by', p_by, 'stopped_at', clock_timestamp()),
  updated_at = clock_timestamp()
  where id = p_id and (state in ('queued', 'needs_user')
   or (state = 'driving' and vm_worker is not null and vm_phase is distinct from 'submitting' and not evidence ? 'clicked_at'));
 return found;
end $$;
revoke all on function public.career_apply_fact_changed_close(uuid, timestamptz, text) from public, anon, authenticated;

-- Every claim's start of a drive (queued -> driving) passes here: a row stating a change recorded after its facts were read is
-- closed and the claim's own update of it is skipped.
create or replace function public.career_apply_facts_claim_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare changed timestamptz;
begin
 changed := public.career_apply_fact_hit(old.user_id, old.payload, coalesce(old.facts_at, old.created_at));
 if changed is null then return new; end if;
 perform public.career_apply_fact_changed_close(old.id, changed, 'claim');
 return null;
end $$;
revoke all on function public.career_apply_facts_claim_guard() from public, anon, authenticated; -- trigger function
drop trigger if exists career_apply_facts_claim_guard on public.career_apply_jobs;
create trigger career_apply_facts_claim_guard before update on public.career_apply_jobs
 for each row when (new.state = 'driving' and old.state = 'queued')
 execute function public.career_apply_facts_claim_guard();

-- An emailed application starts at the person's yes to its card (career_apply_email_reserve_for: straight to driving, source
-- 'email'). Its facts were read when the card was shown: a card shown before a change it states is refused 'fact_changed'.
create or replace function public.career_apply_facts_email_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare shown timestamptz;
begin
 if tg_op = 'UPDATE' and old.state = 'driving' then return new; end if;
 begin
  select (value->>'shown_at')::timestamptz into shown from public.career_watch_kv where user_id = new.user_id and key = 'career:email-card';
 exception when others then shown := null; end;
 if public.career_apply_fact_hit(new.user_id, new.payload, coalesce(shown, new.created_at)) is not null then
  raise exception 'fact_changed: an answer this email states changed after it was shown';
 end if;
 return new;
end $$;
revoke all on function public.career_apply_facts_email_guard() from public, anon, authenticated; -- trigger function
drop trigger if exists career_apply_facts_email_guard on public.career_apply_jobs;
create trigger career_apply_facts_email_guard before insert or update on public.career_apply_jobs
 for each row when (new.state = 'driving' and new.source = 'email')
 execute function public.career_apply_facts_email_guard();

-- The apply VM's submit point, as 20261105120000 with the fact check first.
create or replace function public.career_apply_vm_heartbeat(p_id uuid, p_lease uuid, p_worker text, p_phase text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.career_apply_jobs;
begin
 if p_phase is not null and p_phase not in ('preparing', 'submitting') then raise exception 'invalid phase'; end if;
 select * into j from public.career_apply_jobs where id = p_id and lease_token = p_lease and vm_worker = p_worker and state = 'driving' for update;
 if not found then return jsonb_build_object('ok', false, 'why', 'lease_lost'); end if;
 -- Revoked or expired since the claim: stop, whatever the phase (the queue trigger would refuse this write anyway).
 if public.career_apply_vm_approval_refusal(j, clock_timestamp()) is not null then return jsonb_build_object('ok', false, 'why', 'not_approved'); end if;
 if p_phase = 'submitting' then
  -- D-075: the last step before the click. A fact this application states changed after its facts were read: closed, not sent.
  if j.vm_phase is distinct from 'submitting' and public.career_apply_fact_hit(j.user_id, j.payload, coalesce(j.facts_at, j.created_at)) is not null then
   perform public.career_apply_fact_changed_close(j.id, clock_timestamp(), 'submit_check');
   return jsonb_build_object('ok', false, 'why', 'fact_changed');
  end if;
  if not public.career_apply_vm_enabled() then return jsonb_build_object('ok', false, 'why', 'switch_off'); end if;
  if not public.career_apply_current(j.user_id, j.payload) then return jsonb_build_object('ok', false, 'why', 'account_changed'); end if;
  if not public.career_apply_vm_user_ok(j.user_id) then return jsonb_build_object('ok', false, 'why', 'not_opted_in'); end if;
  if exists (select from public.career_postings cp where cp.job_id = j.job_id and cp.closed_at is not null) then
   return jsonb_build_object('ok', false, 'why', 'posting_closed'); end if;
  if public.career_apply_posting_sent(j.user_id, j.job_id, j.url, j.id::text, false) then
   return jsonb_build_object('ok', false, 'why', 'duplicate_job'); end if;
  if j.vm_phase = 'preparing' then
   update public.career_apply_jobs set vm_phase = 'submitting', vm_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_id;
  else
   update public.career_apply_jobs set vm_heartbeat_at = clock_timestamp() where id = p_id;
  end if;
 else
  update public.career_apply_jobs set vm_heartbeat_at = clock_timestamp() where id = p_id;
 end if;
 return jsonb_build_object('ok', true);
end $$;

-- The cloud runner's submit point, as 20261026230017 with the fact check first.
create or replace function public.career_apply_cloud_authorize_any(p_id uuid, p_lease uuid, p_hash text, p_source_digest text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; j public.career_apply_jobs;
begin
 -- D-075: the cloud's last check before the engine and the Submit. A fact this application states changed after its facts were
 -- read: refused (the worker reports it not sent; a row left driving is swept back to the queue, where the claim guard closes it).
 select * into j from public.career_apply_jobs where id = p_id;
 if found and public.career_apply_fact_hit(j.user_id, j.payload, coalesce(j.facts_at, j.created_at)) is not null then
  raise exception 'fact_changed: an answer this application states changed after it was approved';
 end if;
 if public.career_apply_cloud_card_bound(p_id) then
  execute 'select public.career_apply_message_cloud_authorize($1, $2, $3, $4)' into r using p_id, p_lease, p_hash, p_source_digest;
  return r;
 end if;
 return public.career_apply_cloud_text_authorize(p_id, p_lease, p_hash, p_source_digest);
end $$;

-- The chat's stop, in the turn that changed the fact. p_changes: [{"id": fact id, "was": old words, "was_value": old value or
-- null, "now": new words or null (set aside), "now_value": new value or null}]. The change is recorded first.
create or replace function public.career_apply_stop_stale_facts(p_user uuid, p_changes jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids text[]; ks text[]; at_ timestamptz; pids uuid[]; out_ jsonb := jsonb_build_object('cancelled', '[]'::jsonb, 'waiting', '[]'::jsonb,
 'stopped_preparing', '[]'::jsonb, 'started', '[]'::jsonb, 'being_sent', '[]'::jsonb, 'discarded', '[]'::jsonb); r record; bucket text;
begin
 if p_user is null or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 40
  or coalesce(p_reason, '') !~ '^[a-z_]{1,40}$' then raise exception 'invalid fact change'; end if;
 select coalesce(array_agg(distinct c->>'id') filter (where coalesce(c->>'id', '') <> ''), '{}'),
  coalesce((select array_agg(distinct k) from jsonb_array_elements(p_changes) c2,
   unnest(public.career_apply_changed_keys(c2->>'was', c2->>'was_value', c2->>'now', c2->>'now_value')) k), '{}')
  into ids, ks from jsonb_array_elements(p_changes) c;
 if cardinality(ids) + cardinality(ks) = 0 then raise exception 'invalid fact change'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 at_ := clock_timestamp();
 insert into public.career_apply_fact_changes (user_id, at, fact_ids, fact_keys, reason) values (p_user, at_, ids[1:200], ks[1:200], p_reason);
 -- Prepared, not yet approved.
 pids := array(select id from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown') and public.career_apply_payload_stale(payload, ids, ks));
 out_ := jsonb_set(out_, '{discarded}', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'company', company) order by created_at), '[]'::jsonb) from public.career_apply_prepared where id = any(pids)));
 update public.career_apply_cards c set state = 'answered', answered_at = clock_timestamp(), answer = '{"closed":"a fact it states changed"}'
  where c.user_id = p_user and c.state = 'open' and exists (select from jsonb_array_elements(c.items) it where (it->>'prepared_id')::uuid = any(pids));
 delete from public.career_apply_prepare_attempts where user_id = p_user and prepared_id = any(pids);
 delete from public.career_apply_prepared where id = any(pids);
 -- Approved.
 for r in select id, company, state, attempts, lease_token, vm_worker, vm_phase, evidence from public.career_apply_jobs
   where user_id = p_user and state in ('queued', 'driving', 'needs_user') and public.career_apply_payload_stale(payload, ids, ks) order by created_at for update loop
  if r.state = 'queued' and r.attempts > 0 then bucket := 'started';
  elsif r.state = 'driving' and not (r.vm_worker is not null and r.vm_phase is distinct from 'submitting' and not r.evidence ? 'clicked_at') then bucket := 'being_sent';
  elsif public.career_apply_fact_changed_close(r.id, at_, 'chat') then
   bucket := case r.state when 'queued' then 'cancelled' when 'needs_user' then 'waiting' else 'stopped_preparing' end;
  else bucket := 'being_sent'; end if;
  out_ := jsonb_set(out_, array[bucket], (out_->bucket) || jsonb_build_object('id', r.id, 'company', r.company));
 end loop;
 if (select sum(jsonb_array_length(value)) from jsonb_each(out_)) > 0 then
  insert into public.career_events (user_id, kind, subject, detail, source)
  values (p_user, 'note', 'fact changed: applications stating it stopped',
   (select jsonb_object_agg(key, jsonb_array_length(value)) from jsonb_each(out_)) || jsonb_build_object('why', p_reason), 'apply');
 end if;
 return out_ || jsonb_build_object('at', at_);
end $$;
revoke all on function public.career_apply_stop_stale_facts(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.career_apply_stop_stale_facts(uuid, jsonb, text) to service_role;
