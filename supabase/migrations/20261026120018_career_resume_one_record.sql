-- ONE CONFIRMED RESUME (2026-10-26, docs/architect/RESUME-FLOW-2026-10-26.md). A resume given on any channel ends as one
-- record per person, and every apply path reads only that record. NOT APPLIED: like every migration, the owner applies it.
--
-- Before this file a resume lived in five places that nothing tied together: the chat's profile entries (agent_flow_state),
-- the cloud's kept file (career_apply_cloud_resumes), tailored renders (storage career-resumes/<user>/<sha256>.pdf), a
-- Telegram upload (career_resume_uploads, PR #194) and whatever file the person's own computer held. A new resume left
-- the old one in every other place, and an approval made with the old one stayed good.
--
-- 1. career_resume_record: one row per person. 'confirmed' names the resume by the sha256 of the bytes the person gave
--    (a file's bytes, or a paste's UTF-8 text), how it came (file or paste), when they confirmed it and the
--    confirmation event; the bytes are kept only when the database itself hashed them to that sha256 (a check). 'deleted'
--    keeps no content: the person said "delete my resume", or the account was erased.
-- 2. The entries write it, all through one door (career_resume_put): the person's "yes, that's my resume" is recorded by
--    the chat on every channel as fact_confirmed events naming their upload (career_router_evidence.ts: the message they
--    pasted, as agent_messages:<id>, or the file, as "<ref> (career_resume_uploads:<id>)"). A trigger on career_events
--    turns the first such event of a confirmation into the record, after checking the upload in the database: a paste's
--    stored message must hash to the event's sha256 and belong to the person; a Telegram file's stored bytes must hash
--    to it. A file the database holds no bytes for (the web's file read, PR #201) is recorded by its sha256 with no copy.
--    The person's own signed-in computer putting a file for the cloud (career_apply_cloud_resume_put_own) is the same
--    door. The same resume again changes nothing.
-- 3. A different resume replaces the record, and everything bound to the old one stops at once: approved applications not
--    yet handed out are removed from the queue (approve again with the new resume), prepared applications not yet
--    approved are discarded (so they are prepared again), and the cloud keeps only the new file (or none, for a paste).
--    In-flight sends cannot be stopped; they are counted.
-- 4. The readers, for a person the rule covers (anyone with a record, confirmed or deleted; everyone once the owner sets
--    CAREER_ONE_RESUME on with career_resume_everyone_on()):
--     - career_apply_profile_for (what every prepare and the chat's "resume on file" check read) returns only the entries
--       that came from the record's upload, and none when there is no record: no record, nothing to prepare from;
--     - an application is queued, handed to a drive (own computer, extension, cloud, email), or stored prepared only when
--       the resume it carries is the record's file, or a tailored render stored after the record was confirmed
--       (career-resumes/<user>/<sha256>.pdf); a paste's text is never sent as the file. Refusals read "no_resume: ...".
-- 5. "delete my resume" (career_resume_delete_as) and an account erase leave no copy: the record's content, the cloud's
--    kept files and the person's uploads; then everything bound to them stops as in 3.
-- Version 20261026120018 sorts before the open PRs' migrations (#194 20261026210016, #202 20261026230017) so the go-live
-- list takes this line in a different place from theirs. Nothing here depends on their objects: career_resume_uploads is
-- read only when it exists. Idempotent.

create table if not exists public.career_resume_record (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 state text not null check (state in ('confirmed', 'deleted')),
 sha256 text check (sha256 ~ '^[a-f0-9]{64}$'),
 kind text check (kind in ('file', 'paste')),
 source_ref text check (length(source_ref) between 1 and 300),
 filename text check (length(filename) between 1 and 200 and filename !~ '[/\\]' and filename !~ '^\.'),
 bytes bytea check (octet_length(bytes) between 1 and 10485760),
 confirmation_event_id text check (length(confirmation_event_id) between 1 and 120),
 confirmed_at timestamptz,
 generation integer not null default 1 check (generation >= 1),
 updated_at timestamptz not null default now(),
 constraint career_resume_record_confirmed check ((state = 'confirmed') = (sha256 is not null and kind is not null and confirmed_at is not null
  and confirmation_event_id is not null)),
 constraint career_resume_record_deleted_empty check (state = 'confirmed' or (bytes is null and filename is null and source_ref is null)),
 constraint career_resume_record_bytes_hash check (bytes is null or encode(sha256(bytes), 'hex') = sha256)
);
alter table public.career_resume_record enable row level security;
revoke all on public.career_resume_record from public, anon, authenticated;
grant all on public.career_resume_record to service_role;

-- The owner's switch: 'on' puts every person under the rule (no record: nothing is prepared or sent). Off, the rule
-- covers the people who have a record.
create table if not exists public.career_resume_settings (
 key text primary key check (key = 'CAREER_ONE_RESUME'),
 value text not null check (value in ('on', 'off')),
 updated_at timestamptz not null default now()
);
alter table public.career_resume_settings enable row level security;
revoke all on public.career_resume_settings from public, anon, authenticated;
grant all on public.career_resume_settings to service_role;

create or replace function public.career_resume_rule_on(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce((select value = 'on' from public.career_resume_settings where key = 'CAREER_ONE_RESUME'), false)
  or exists (select from public.career_resume_record where user_id = p_user)
$$;

-- The resume an application carries: the file the form gets (resume_sha256), or an emailed application's attachment.
create or replace function public.career_resume_carried(p jsonb) returns text
language sql immutable set search_path = public, pg_temp as $$
 select coalesce(nullif(p->>'resume_sha256', ''), nullif(p#>>'{attachment,sha256}', ''))
$$;

-- The resumes a person replaced or deleted, by sha256 (the record's file or paste, and the renders stored before the
-- change): never carried again unless they confirm that same resume again. Hashes only; erased with the account.
create table if not exists public.career_resume_retired (
 user_id uuid not null references public.profiles(id) on delete cascade,
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 retired_at timestamptz not null default now(),
 primary key (user_id, sha256)
);
alter table public.career_resume_retired enable row level security;
revoke all on public.career_resume_retired from public, anon, authenticated;
grant all on public.career_resume_retired to service_role;

-- May an application carry this resume?
--   No record: as before this file (true), unless the owner's switch is on (false: nothing without a resume on file).
--   A record: never after a delete or an erase; never a resume they replaced; never a paste's text as the file; the
--   record's file, and a render stored after the record was confirmed, yes; any other resume (one the database can't
--   tie to the record, e.g. a render kept outside storage) only while the switch is off.
create or replace function public.career_resume_allowed(p_user uuid, p_sha256 text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.career_resume_record; v_strict boolean := coalesce((select value = 'on' from public.career_resume_settings where key = 'CAREER_ONE_RESUME'), false);
begin
 select * into r from public.career_resume_record where user_id = p_user;
 if not found then return not v_strict; end if;
 if r.state <> 'confirmed' or coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' then return false; end if;
 if exists (select from public.career_resume_retired x where x.user_id = p_user and x.sha256 = p_sha256) then return false; end if;
 if p_sha256 = r.sha256 then return r.kind = 'file'; end if;
 if exists (select from storage.objects o where o.bucket_id = 'career-resumes' and o.name = p_user::text || '/' || p_sha256 || '.pdf'
  and o.created_at >= r.confirmed_at) then return true; end if;
 return not v_strict;
end $$;

-- ---------------------------------------------------------------------------------------------- the readers' guards
create or replace function public.career_resume_jobs_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if tg_op = 'INSERT' then
  if new.state in ('queued', 'driving') and not public.career_resume_allowed(new.user_id, public.career_resume_carried(new.payload)) then
   raise exception 'no_resume: an application goes only with the resume on file (one confirmed resume)';
  end if;
  return new;
 end if;
 if new.state = 'driving' and old.state is distinct from 'driving'
    and not public.career_resume_allowed(new.user_id, public.career_resume_carried(new.payload)) then
  -- A claim (queued -> driving) skips it: nothing is handed to a drive. Any other way into driving is refused.
  if old.state = 'queued' then return null; end if;
  raise exception 'no_resume: an application goes only with the resume on file (one confirmed resume)';
 end if;
 return new;
end $$;
revoke all on function public.career_resume_jobs_guard() from public, anon, authenticated;
drop trigger if exists career_resume_jobs_guard on public.career_apply_jobs;
create trigger career_resume_jobs_guard before insert or update of state, payload on public.career_apply_jobs
 for each row execute function public.career_resume_jobs_guard();

create or replace function public.career_resume_prepared_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.state in ('ready', 'shown') and not public.career_resume_allowed(new.user_id, public.career_resume_carried(new.payload)) then
  raise exception 'no_resume: an application is prepared only with the resume on file (one confirmed resume)';
 end if;
 return new;
end $$;
revoke all on function public.career_resume_prepared_guard() from public, anon, authenticated;
drop trigger if exists career_resume_prepared_guard on public.career_apply_prepared;
create trigger career_resume_prepared_guard before insert or update of payload on public.career_apply_prepared
 for each row execute function public.career_resume_prepared_guard();

-- The profile every prepare and the chat's "resume on file" check read (20261025120000's text, then the rule): under
-- the rule, the thread whose profile holds the record's entries first (a resume confirmed on Telegram is theirs when they
-- next talk on the web, a newer thread with no entries), then the newest as before; and of its entries, only those that
-- came from the record's upload, plus entries from no upload that are not resume entries (experience, education,
-- project, leadership, certification). With no record the order and the entries are 20261025120000's.
create or replace function public.career_apply_profile_for(p_user uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
 with p as (
  select s.state->'career'->'stores'->'profile' as prof from public.agent_flow_state s
  left join public.career_resume_record rr on rr.user_id = p_user and rr.state = 'confirmed'
  where s.user_id = p_user and jsonb_typeof(s.state->'career'->'stores'->'profile') = 'object'
   and (s.state->'career'->'stores'->'profile' ? 'facts' or s.state->'career'->'stores'->'profile' ? 'basics')
   and coalesce(s.state->'career'->'stores'->'profile'->>'user_id', p_user::text) = p_user::text
  order by (rr.sha256 is not null and exists (select from jsonb_array_elements(case when jsonb_typeof(s.state->'career'->'stores'->'profile'->'facts') = 'array'
    then s.state->'career'->'stores'->'profile'->'facts' else '[]'::jsonb end) f where f->'source_ref'->>'upload_sha256' = rr.sha256)) desc,
   s.updated_at desc, s.thread_id
  limit 1
 )
 select case when not public.career_resume_rule_on(p_user) then p.prof
  else jsonb_set(p.prof, '{facts}', coalesce((select jsonb_agg(f order by n) from jsonb_array_elements(
    case when jsonb_typeof(p.prof->'facts') = 'array' then p.prof->'facts' else '[]'::jsonb end) with ordinality as x(f, n)
   where (r.state = 'confirmed' and f->'source_ref'->>'upload_sha256' = r.sha256)
    or (coalesce(f->'source_ref'->>'upload_sha256', '') = ''
     and coalesce(f->>'kind', '') not in ('experience', 'education', 'project', 'leadership', 'certification'))), '[]'::jsonb)) end
 from p left join public.career_resume_record r on r.user_id = p_user
$$;
revoke all on function public.career_apply_profile_for(uuid) from public, anon, authenticated;
grant execute on function public.career_apply_profile_for(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------- stop what is bound
-- Everything of this person's that the rule no longer allows, stopped: approved and never handed out (queued, no
-- attempt) removed from the queue; prepared and not yet approved discarded with their prepare tries (so the posting is
-- prepared again); the ones being sent now counted. One timeline note says what happened.
create or replace function public.career_resume_stop_unbound(p_user uuid, p_why text, p_before timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare q int; d int; s int; gone text[]; keep text;
begin
 -- Bound to an earlier resume: anything the rule no longer allows, and anything made before the change (p_before) that
 -- does not carry the record's own file. Made before the change means made from the earlier resume's entries.
 select case when kind = 'file' then sha256 end into keep from public.career_resume_record where user_id = p_user and state = 'confirmed';
 create temp table if not exists career_resume_stale (kind text, id uuid) on commit drop;
 delete from career_resume_stale;
 insert into career_resume_stale select 'job', id from public.career_apply_jobs where user_id = p_user and state in ('queued', 'driving')
  and (not public.career_resume_allowed(p_user, public.career_resume_carried(payload))
   or (p_before is not null and created_at < p_before and public.career_resume_carried(payload) is distinct from keep));
 insert into career_resume_stale select 'prepared', id from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown')
  and (not public.career_resume_allowed(p_user, public.career_resume_carried(payload))
   or (p_before is not null and created_at < p_before and public.career_resume_carried(payload) is distinct from keep));
 -- What they carried is retired with the earlier resume: never carried again (unless that resume is confirmed again).
 insert into public.career_resume_retired (user_id, sha256)
 select p_user, c from (select public.career_resume_carried(j.payload) c from public.career_apply_jobs j join career_resume_stale t on t.kind = 'job' and t.id = j.id
  union select public.career_resume_carried(p.payload) from public.career_apply_prepared p join career_resume_stale t on t.kind = 'prepared' and t.id = p.id) z
 where c ~ '^[a-f0-9]{64}$' and c is distinct from keep
 on conflict do nothing;
 with x as (delete from public.career_apply_jobs j using career_resume_stale t where t.kind = 'job' and j.id = t.id and j.state = 'queued' and j.attempts = 0
   returning j.company)
 select count(*), array_agg(distinct company) into q, gone from x;
 delete from public.career_apply_prepare_attempts a using career_resume_stale t where t.kind = 'prepared' and a.user_id = p_user and a.prepared_id = t.id;
 with x as (delete from public.career_apply_prepared p using career_resume_stale t where t.kind = 'prepared' and p.id = t.id returning 1)
 select count(*) into d from x;
 select count(*) into s from public.career_apply_jobs j join career_resume_stale t on t.kind = 'job' and t.id = j.id where j.state = 'driving';
 if q + d + s > 0 then
  insert into public.career_events (user_id, kind, subject, detail, source)
  values (p_user, 'note', left('resume ' || p_why || ': approvals with the earlier resume stopped', 200),
   jsonb_build_object('why', p_why, 'cancelled', q, 'discarded', d, 'being_sent', s, 'companies', to_jsonb(coalesce(gone, '{}'))), 'resume');
 end if;
 return jsonb_build_object('cancelled', q, 'discarded', d, 'being_sent', s, 'companies', to_jsonb(coalesce(gone, '{}')));
end $$;
revoke all on function public.career_resume_stop_unbound(uuid, text, timestamptz) from public, anon, authenticated;

-- The record's resume and every render stored up to p_at, retired for this person.
create or replace function public.career_resume_retire(p_user uuid, p_at timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 insert into public.career_resume_retired (user_id, sha256)
 select p_user, sha256 from public.career_resume_record where user_id = p_user and state = 'confirmed'
 union select p_user, substring(o.name from '^[0-9a-f-]{36}/([a-f0-9]{64})\.pdf$') from storage.objects o
  where o.bucket_id = 'career-resumes' and o.name like p_user::text || '/%' and o.created_at <= p_at
   and o.name ~ '^[0-9a-f-]{36}/[a-f0-9]{64}\.pdf$'
 on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------------------------- the one door
create or replace function public.career_resume_put(p_user uuid, p_sha256 text, p_kind text, p_ref text, p_filename text, p_bytes bytea,
 p_event text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_resume_record; a jsonb; fname text; stopped jsonb := '{}'::jsonb;
begin
 if p_user is null or coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' or p_kind not in ('file', 'paste') or coalesce(p_event, '') = '' then
  raise exception 'invalid resume record'; end if;
 if p_bytes is not null and encode(sha256(p_bytes), 'hex') <> p_sha256 then raise exception 'invalid resume record'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 select * into r from public.career_resume_record where user_id = p_user for update;
 if found and r.state = 'confirmed' and r.sha256 = p_sha256 then
  return jsonb_build_object('changed', false, 'generation', r.generation);
 end if;
 perform public.career_resume_retire(p_user, clock_timestamp());
 delete from public.career_resume_retired where user_id = p_user and sha256 = p_sha256;
 fname := nullif(left(regexp_replace(coalesce(p_filename, ''), '[/\\\r\n]', ' ', 'g'), 200), '');
 if fname like '.%' then fname := 'resume' || fname; end if;
 insert into public.career_resume_record as x (user_id, state, sha256, kind, source_ref, filename, bytes, confirmation_event_id, confirmed_at, generation, updated_at)
 values (p_user, 'confirmed', p_sha256, p_kind, left(nullif(p_ref, ''), 300), fname,
  case when octet_length(p_bytes) between 1 and 10485760 then p_bytes end, left(p_event, 120), clock_timestamp(), 1, clock_timestamp())
 on conflict (user_id) do update set state = 'confirmed', sha256 = excluded.sha256, kind = excluded.kind, source_ref = excluded.source_ref,
  filename = excluded.filename, bytes = excluded.bytes, confirmation_event_id = excluded.confirmation_event_id,
  confirmed_at = excluded.confirmed_at, generation = x.generation + 1, updated_at = excluded.updated_at
 returning * into r;
 -- The cloud attaches only this file: kept for the account as it is now (its epoch), every other kept file removed.
 delete from public.career_apply_cloud_resumes where user_id = p_user and sha256 <> p_sha256;
 select value into a from public.career_watch_kv where user_id = p_user and key = 'career:account';
 if r.kind = 'file' and r.bytes is not null and octet_length(r.bytes) <= 5242880 and a is not null then
  insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
  values (p_user, r.sha256, coalesce(r.filename, 'resume'), r.bytes, coalesce((a->>'epoch')::bigint, 0))
  on conflict (user_id, sha256) do update set filename = excluded.filename, bytes = excluded.bytes, privacy_epoch = excluded.privacy_epoch;
 else
  delete from public.career_apply_cloud_resumes where user_id = p_user;
 end if;
 stopped := public.career_resume_stop_unbound(p_user, 'replaced', r.confirmed_at);
 return jsonb_build_object('changed', true, 'generation', r.generation, 'stopped', stopped);
end $$;
revoke all on function public.career_resume_put(uuid, text, text, text, text, bytea, text) from public, anon, authenticated;

-- The entries' door: the person's yes to their resume, as the chat records it on every channel. Checked here, never
-- taken on the event's word: a paste is their own stored message hashing to the event's sha256; a file is bytes the
-- database holds for them hashing to it (career_resume_uploads, when that table exists), or, with no bytes held, the
-- sha256 the chat took of the file it read (the record then keeps no copy). Anything else records nothing.
create or replace function public.career_resume_take(p_user uuid, p_detail jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare u jsonb := p_detail->'upload'; sha text := p_detail->'upload'->>'sha256'; ref text := p_detail->'upload'->>'ref';
 msg text; up record; b bytea; fname text; m text[];
begin
 if coalesce(p_detail->>'via', '') <> 'router: their yes to the resume entries shown to them' or jsonb_typeof(u) is distinct from 'object'
    or coalesce(sha, '') !~ '^[a-f0-9]{64}$' or coalesce(p_detail->>'confirmation_event_id', '') = '' then return false; end if;
 if exists (select from public.career_resume_record where user_id = p_user and state = 'confirmed' and sha256 = sha) then return false; end if;
 if u->>'kind' = 'message' then
  m := regexp_match(coalesce(ref, ''), '^agent_messages:([0-9]{1,18})$');
  if m is null then return false; end if;
  select x.content into msg from public.agent_messages x join public.agent_threads t on t.id = x.thread_id
   where x.id = m[1]::bigint and t.user_id = p_user and x.role = 'user';
  if msg is null then return false; end if;
  b := convert_to(msg, 'UTF8');
  if encode(sha256(b), 'hex') <> sha then return false; end if;
  perform public.career_resume_put(p_user, sha, 'paste', ref, null, b, p_detail->>'confirmation_event_id');
 elsif u->>'kind' = 'file' then
  m := regexp_match(coalesce(ref, ''), '\(career_resume_uploads:([0-9a-f-]{36})\)$');
  if m is not null and to_regclass('public.career_resume_uploads') is not null then
   execute 'select filename, decode(content_b64, ''base64'') as bytes from public.career_resume_uploads where id = $1::uuid and user_id = $2 and sha256 = $3'
    into up using m[1], p_user, sha;
   if up.bytes is null or encode(sha256(up.bytes), 'hex') <> sha then return false; end if;
   b := up.bytes; fname := up.filename;
  end if;
  perform public.career_resume_put(p_user, sha, 'file', ref, fname, b, p_detail->>'confirmation_event_id');
 else
  return false;
 end if;
 return true;
end $$;
revoke all on function public.career_resume_take(uuid, jsonb) from public, anon, authenticated;

create or replace function public.career_resume_from_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 perform public.career_resume_take(new.user_id, new.detail);
 return new;
end $$;

revoke all on function public.career_resume_from_event() from public, anon, authenticated;
drop trigger if exists career_resume_from_event on public.career_events;
create trigger career_resume_from_event after insert on public.career_events
 for each row when (new.kind = 'fact_confirmed') execute function public.career_resume_from_event();

-- The person's own signed-in computer keeping a file for the cloud (career_apply_cloud_resume_put_own, under their
-- session) is them choosing their resume: the same door. Rows this file's own door writes are not re-entered.
create or replace function public.career_resume_from_cloud_put() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if pg_trigger_depth() > 1 then return new; end if;
 if current_setting('role', true) = 'authenticated' and auth.uid() is not null and auth.uid() = new.user_id then
  perform public.career_resume_put(new.user_id, new.sha256, 'file', 'web:cloud_resume_put_own', new.filename, new.bytes,
   'cloud_put_own:' || new.sha256);
 end if;
 return new;
end $$;
revoke all on function public.career_resume_from_cloud_put() from public, anon, authenticated;
drop trigger if exists career_resume_from_cloud_put on public.career_apply_cloud_resumes;
create trigger career_resume_from_cloud_put after insert or update of bytes on public.career_apply_cloud_resumes
 for each row execute function public.career_resume_from_cloud_put();

-- ---------------------------------------------------------------------------------------------- read, delete, erase
create or replace function public.career_resume_current_as(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce((select jsonb_build_object('state', r.state, 'kind', r.kind, 'filename', r.filename, 'sha256', r.sha256,
   'confirmed_at', r.confirmed_at, 'file_kept', r.bytes is not null, 'generation', r.generation)
  from public.career_resume_record r where r.user_id = p_user), jsonb_build_object('state', 'none'))
$$;

create or replace function public.career_resume_forget(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 perform public.career_resume_retire(p_user, clock_timestamp());
 insert into public.career_resume_record as x (user_id, state, generation, updated_at) values (p_user, 'deleted', 1, clock_timestamp())
 on conflict (user_id) do update set state = 'deleted', sha256 = null, kind = null, source_ref = null, filename = null, bytes = null,
  confirmation_event_id = null, confirmed_at = null, generation = x.generation + 1, updated_at = clock_timestamp();
 delete from public.career_apply_cloud_resumes where user_id = p_user;
 if to_regclass('public.career_resume_uploads') is not null then
  execute 'delete from public.career_resume_uploads where user_id = $1' using p_user;
 end if;
end $$;
revoke all on function public.career_resume_forget(uuid) from public, anon, authenticated;

-- "delete my resume": every copy gone, and what was bound to it stopped. Says what there was.
create or replace function public.career_resume_delete_as(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_resume_record; stopped jsonb;
begin
 if p_user is null then raise exception 'invalid resume delete'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 select * into r from public.career_resume_record where user_id = p_user for update;
 perform public.career_resume_forget(p_user);
 stopped := public.career_resume_stop_unbound(p_user, 'deleted', null);
 return jsonb_build_object('had', coalesce(r.state = 'confirmed', false), 'kind', r.kind, 'filename', r.filename,
  'confirmed_at', r.confirmed_at, 'stopped', stopped);
end $$;

create or replace function public.career_resume_on_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.key = 'career:account' and coalesce((new.value->>'epoch')::bigint, 0) >
    (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end)
    and exists (select from public.career_resume_record where user_id = new.user_id) then
  perform public.career_resume_forget(new.user_id);
  perform public.career_resume_stop_unbound(new.user_id, 'erased', null);
 end if;
 return new;
end $$;
revoke all on function public.career_resume_on_erase() from public, anon, authenticated;
drop trigger if exists career_resume_on_erase on public.career_watch_kv;
create trigger career_resume_on_erase after insert or update on public.career_watch_kv
 for each row when (new.key = 'career:account') execute function public.career_resume_on_erase();

-- The owner's switch, on: every person under the rule. Each person who confirmed a resume before this file gets their
-- record from their latest confirmation (checked as the trigger checks it); then what the rule no longer allows is
-- closed as not sent with the reason (kept on record, never driven), as 20261026210016 closes rows queued before it.
create or replace function public.career_resume_everyone_on() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare e record; n int := 0; c int;
begin
 for e in select distinct on (user_id) * from public.career_events
   where kind = 'fact_confirmed' and detail->>'via' = 'router: their yes to the resume entries shown to them'
    and not exists (select from public.career_resume_record r where r.user_id = career_events.user_id)
   order by user_id, at desc, id desc loop
  -- The same checks as a new confirmation.
  if public.career_resume_take(e.user_id, e.detail) then n := n + 1; end if;
 end loop;
 insert into public.career_resume_settings (key, value) values ('CAREER_ONE_RESUME', 'on')
 on conflict (key) do update set value = 'on', updated_at = now();
 update public.career_apply_jobs set state = 'not_submitted',
  reason = 'not sent: it carried a resume other than the one on file (one confirmed resume)', updated_at = now()
  where state = 'queued' and not public.career_resume_allowed(user_id, public.career_resume_carried(payload));
 get diagnostics c = row_count;
 update public.career_apply_prepared set state = 'expired', updated_at = now()
  where state in ('ready', 'shown') and not public.career_resume_allowed(user_id, public.career_resume_carried(payload));
 return jsonb_build_object('recorded', n, 'closed', c);
end $$;
revoke all on function public.career_resume_everyone_on() from public, anon, authenticated;

-- Only two doors are the service's (the chat's turn); every other function runs inside triggers and the two doors, as the
-- owner, and the switch is the owner's (psql as the database owner): none is callable through the API by anyone.
revoke all on function public.career_resume_rule_on(uuid), public.career_resume_allowed(uuid, text), public.career_resume_carried(jsonb),
 public.career_resume_put(uuid, text, text, text, text, bytea, text), public.career_resume_take(uuid, jsonb),
 public.career_resume_stop_unbound(uuid, text, timestamptz), public.career_resume_retire(uuid, timestamptz), public.career_resume_forget(uuid), public.career_resume_everyone_on(),
 public.career_resume_jobs_guard(), public.career_resume_prepared_guard(), public.career_resume_from_event(),
 public.career_resume_from_cloud_put(), public.career_resume_on_erase()
 from public, anon, authenticated, service_role;
revoke all on function public.career_resume_current_as(uuid), public.career_resume_delete_as(uuid) from public, anon, authenticated;
grant execute on function public.career_resume_current_as(uuid), public.career_resume_delete_as(uuid) to service_role;
