-- OWNER RULE (2026-10-26, in writing): "never submit applications without a real resume". FEATURE 16 (Telegram end to
-- end). The chat, the card and the engine refuse in code (career_apply_chat.ts, career_apply_cards.ts, approve-first.ts,
-- workers/career-cloud/worker.ts); this is the same rule in the database, so no path that skips the code gets past it:
--   1. approve-to-queue: a career_apply_jobs row is queued only when its person has a confirmed resume on file
--      (career_resume_on_file: entries confirmed with their fact_confirmed events) and the payload binds a resume that is
--      stored for them (career_resume_stored: resume_sha256 is the sha256 of a tailored render in the career-resumes
--      bucket, a resume the cloud holds, or a file they sent), never a bare 64-hex value (review of PR #194). Any approve
--      path (career_apply_enqueue, the card's career_apply_card_answer_for, the message card's tap) inserts through here.
--   2. the claim: a queued row that fails the same rule is never handed to a drive (the person's computer, the extension, the
--      cloud): the claim's update skips it. Rows queued before this rule are closed as not sent, with the reason.
--      Any other way into a sending state is refused too: a row inserted straight into driving (the emailed application,
--      career_apply_email_reserve_for) and an emailed application tried again (not_submitted -> driving). Rows recorded
--      in a finished state (career_apply_record_own: what the person sent themselves) send nothing and are not checked.
--   3. prepared and carded: a prepared application that fails it is never stored, and a card never shows one.
--   6. the card's answer says why: an item the queue refused for its resume reads "no_resume", not "refused".
--   4. career_resume_on_file(p_user): the person has resume entries they confirmed with provenance (a fact_confirmed
--      event in career_events names each one's confirmation_event_id). The chat's apply turn and the card read it.
--   5. career_resume_uploads: a resume the person sent as a file on a texting channel (Telegram), by its sha256 and the
--      provider's own reference, so a later "yes, that's my resume" records that upload as the evidence. Erased with the
--      account ("forget everything").
-- Triggers only, so none of the claim functions' texts change (scripts/launch/verify-claim-guards.sql and
-- tests/architect/bridge-ledger-order.test.ts compare those texts). Idempotent. NOT APPLIED: the owner applies migrations.

create or replace function public.career_resume_bound(p jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
 select coalesce(p->>'resume_sha256', '') ~ '^[a-f0-9]{64}$'
$$;
-- 1. approve-to-queue
create or replace function public.career_apply_jobs_resume_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 -- Any way into a sending state is checked: queued (approved, waiting) and driving (being sent). Review of #194
 -- (2026-10-27): the email path (career_apply_email_reserve_for) inserts straight into driving, and a retry moves
 -- not_submitted -> driving; both went past a guard that read only INSERT queued and the queued -> driving claim.
 -- Rows written in a finished state (career_apply_record_own: what the person already sent themselves, recorded after
 -- the fact) send nothing and are not checked here.
 if tg_op = 'INSERT' then
  if new.state in ('queued', 'driving') and not public.career_resume_ok(new.user_id, new.payload) then
   raise exception 'no_resume: an application is queued only with the resume it sends (owner rule 2026-10-26)';
  end if;
  return new;
 end if;
 if new.state = 'driving' and old.state is distinct from 'driving' and not public.career_resume_ok(new.user_id, new.payload) then
  -- 2. the claim: queued -> driving only with a bound resume; otherwise the row is not handed out (skipped).
  if old.state = 'queued' then return null; end if;
  -- Any other way into driving (an emailed application tried again) is refused outright.
  raise exception 'no_resume: an application is sent only with the resume it sends (owner rule 2026-10-26)';
 end if;
 return new;
end $$;
revoke all on function public.career_apply_jobs_resume_guard() from public, anon, authenticated;
drop trigger if exists career_apply_jobs_resume_guard on public.career_apply_jobs;
create trigger career_apply_jobs_resume_guard before insert or update of state on public.career_apply_jobs
 for each row execute function public.career_apply_jobs_resume_guard();

-- 3. prepared and carded
-- A resume file the person confirmed: a fact_confirmed event of theirs names, as its evidence, an uploaded FILE (not pasted
-- text) with this sha256 (career_router_evidence.ts: detail.upload {kind:'file', sha256}). Review of #194 (2026-10-27): a
-- hash the person's own computer reports counts only when it is one of these, never any 64-hex value.
create or replace function public.career_resume_confirmed_file(p_user uuid, p_sha256 text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce(p_sha256, '') ~ '^[a-f0-9]{64}$' and exists (select from public.career_events e
  where e.user_id = p_user and e.kind = 'fact_confirmed' and e.detail->'upload'->>'kind' = 'file' and e.detail->'upload'->>'sha256' = p_sha256)
$$;
revoke all on function public.career_resume_confirmed_file(uuid, text) from public, anon, authenticated;
grant execute on function public.career_resume_confirmed_file(uuid, text) to service_role;

create or replace function public.career_apply_prepared_resume_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 -- Prepared on the person's own signed-in computer (career_apply_prepare_own under their session: the request's role is
 -- authenticated and auth.uid() is them; never the service role's server prepare): the
 -- resume is the file on that computer, which the server never holds. Its sha256 is recorded only when it is a resume
 -- file the person confirmed (career_resume_confirmed_file); any other hash is refused below. The engine there hashes the
 -- file's bytes again right before it uploads them (portal-browser-helper.cjs RESUME_SHA_MISMATCH).
 if current_setting('role', true) = 'authenticated' and auth.uid() is not null and auth.uid() = new.user_id
    and public.career_resume_confirmed_file(new.user_id, new.payload->>'resume_sha256') then
  insert into public.career_resume_devices(user_id, sha256, at) values (new.user_id, new.payload->>'resume_sha256', now())
  on conflict (user_id, sha256) do update set at = excluded.at;
 end if;
 if not public.career_resume_ok(new.user_id, new.payload) then
  raise exception 'no_resume: an application is prepared only with the resume it sends (owner rule 2026-10-26)';
 end if;
 return new;
end $$;
revoke all on function public.career_apply_prepared_resume_guard() from public, anon, authenticated;
drop trigger if exists career_apply_prepared_resume_guard on public.career_apply_prepared;
create trigger career_apply_prepared_resume_guard before insert or update of payload on public.career_apply_prepared
 for each row execute function public.career_apply_prepared_resume_guard();

create or replace function public.career_apply_cards_resume_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 if exists (select from jsonb_array_elements(new.items) it
   left join public.career_apply_prepared p on p.id = (it->>'prepared_id')::uuid and p.user_id = new.user_id
   where p.id is null or not public.career_resume_ok(new.user_id, p.payload)) then
  raise exception 'no_resume: a card shows only applications that send a resume (owner rule 2026-10-26)';
 end if;
 return new;
end $$;
revoke all on function public.career_apply_cards_resume_guard() from public, anon, authenticated;
drop trigger if exists career_apply_cards_resume_guard on public.career_apply_cards;
create trigger career_apply_cards_resume_guard before insert on public.career_apply_cards
 for each row execute function public.career_apply_cards_resume_guard();

-- 4. a confirmed resume on file: a resume entry confirmed in the profile the server prepares from, whose confirmation
-- event is recorded for this person.
create or replace function public.career_resume_on_file(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 -- Any of the person's profiles: each thread's (agent_flow_state) and the account's (career:account memory, FEATURE 9). A
 -- resume confirmed in one thread is theirs in the next (review of PR #194: a second thread read as "no resume").
 with profiles as (
  select s.state->'career'->'stores'->'profile' as p from public.agent_flow_state s where s.user_id = p_user
  union all
  select k.value->'memory'->'profile' from public.career_watch_kv k where k.user_id = p_user and k.key = 'career:account'
 ), facts as (
  select f from profiles, jsonb_array_elements(case when jsonb_typeof(p->'facts') = 'array' then p->'facts' else '[]'::jsonb end) f
  where coalesce(p->>'user_id', p_user::text) = p_user::text
 )
 select exists (select from facts
  join public.career_events e on e.user_id = p_user and e.kind = 'fact_confirmed' and e.detail->>'confirmation_event_id' = f->>'confirmation_event_id'
  where f->>'status' = 'confirmed' and f->'needs_confirmation' = 'false'::jsonb and coalesce(f->>'confirmation_event_id', '') <> ''
   and coalesce(f->>'kind', '') in ('experience', 'education', 'project', 'leadership', 'certification'))
$$;
revoke all on function public.career_resume_on_file(uuid) from public, anon, authenticated;
grant execute on function public.career_resume_on_file(uuid) to service_role;

-- 5. a resume sent as a file
create table if not exists public.career_resume_uploads (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 channel text not null check (channel in ('telegram', 'whatsapp', 'imessage', 'web')),
 provider_ref text not null check (length(provider_ref) between 1 and 200),
 filename text not null check (length(filename) between 1 and 200),
 mime text not null check (length(mime) between 1 and 120),
 bytes integer not null check (bytes between 1 and 10485760),
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 content_b64 text not null check (length(content_b64) <= 14000000),
 message_sha256 text not null check (message_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 unique (user_id, sha256, message_sha256)
);
create index if not exists career_resume_uploads_user_message on public.career_resume_uploads (user_id, message_sha256);
alter table public.career_resume_uploads enable row level security;
revoke all on public.career_resume_uploads from public, anon, authenticated;
grant select on public.career_resume_uploads to authenticated;
drop policy if exists career_resume_uploads_own on public.career_resume_uploads;
create policy career_resume_uploads_own on public.career_resume_uploads for select to authenticated using (user_id = auth.uid());
grant select, insert on public.career_resume_uploads to service_role;

-- The resumes the person's own signed-in computer prepared applications with (by sha256; the bytes stay on that computer).
create table if not exists public.career_resume_devices (
 user_id uuid not null references public.profiles(id) on delete cascade,
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 at timestamptz not null default now(),
 primary key (user_id, sha256)
);
alter table public.career_resume_devices enable row level security;
revoke all on public.career_resume_devices from public, anon, authenticated;

-- A resume stored for this person under this sha256: the tailored render (career-resumes/<user>/<sha256>.pdf, WO-028), a
-- resume the cloud holds for them (career_apply_cloud_resumes), a file they sent (career_resume_uploads), or the file
-- their own signed-in computer prepared with and that they confirmed as a file (career_resume_devices).
-- What this checks: a row by that name or hash exists for this person. It does not read bytes (storage objects are
-- matched by name). The bytes are checked where they are used: the cloud worker re-hashes the file it is handed against
-- the approved resume_sha256 before the engine starts (workers/career-cloud/worker.ts, RESUME_CHANGED), uploads are
-- hashed on the way in (career_resume_upload_record_as), and the engine re-hashes the file right before it attaches it.
create or replace function public.career_resume_stored(p_user uuid, p_sha256 text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce(p_sha256, '') ~ '^[a-f0-9]{64}$' and (
  exists (select from storage.objects o where o.bucket_id = 'career-resumes' and o.name = p_user::text || '/' || p_sha256 || '.pdf')
  or exists (select from public.career_apply_cloud_resumes r where r.user_id = p_user and r.sha256 = p_sha256)
  or exists (select from public.career_resume_uploads u where u.user_id = p_user and u.sha256 = p_sha256)
  or exists (select from public.career_resume_devices d where d.user_id = p_user and d.sha256 = p_sha256))
$$;
revoke all on function public.career_resume_stored(uuid, text) from public, anon, authenticated;
grant execute on function public.career_resume_stored(uuid, text) to service_role;

-- The rule every guard applies: a confirmed resume on file, and the payload's resume stored for this person.
create or replace function public.career_resume_ok(p_user uuid, p jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select public.career_resume_bound(p) and public.career_resume_on_file(p_user) and public.career_resume_stored(p_user, p->>'resume_sha256')
$$;
revoke all on function public.career_resume_ok(uuid, jsonb) from public, anon, authenticated;


create or replace function public.career_resume_upload_record_as(p_user uuid, p_channel text, p_ref text, p_filename text, p_mime text,
 p_bytes integer, p_sha256 text, p_content_b64 text, p_message_sha256 text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare rid uuid;
begin
 if p_user is null then raise exception 'invalid resume upload'; end if;
 -- Review of #194 (folds in #206): a claimed fingerprint is not proof of a file. The decoded bytes must be the declared
 -- size and hash to the declared sha256, or nothing is stored.
 if p_content_b64 is null or p_sha256 is null or p_bytes is null
    or octet_length(decode(p_content_b64, 'base64')) <> p_bytes
    or encode(sha256(decode(p_content_b64, 'base64')), 'hex') <> p_sha256 then
  raise exception 'invalid resume upload: content does not match size and sha256';
 end if;
 insert into public.career_resume_uploads (user_id, channel, provider_ref, filename, mime, bytes, sha256, content_b64, message_sha256)
 values (p_user, p_channel, p_ref, p_filename, p_mime, p_bytes, p_sha256, p_content_b64, p_message_sha256)
 on conflict (user_id, sha256, message_sha256) do update set created_at = public.career_resume_uploads.created_at
 returning id into rid;
 return rid;
end $$;
revoke all on function public.career_resume_upload_record_as(uuid, text, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.career_resume_upload_record_as(uuid, text, text, text, text, integer, text, text, text) to service_role;

create or replace function public.career_resume_uploads_on_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.key = 'career:account' and coalesce((new.value->>'epoch')::bigint, 0) >
    (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end) then
  delete from public.career_resume_uploads where user_id = new.user_id;
  delete from public.career_resume_devices where user_id = new.user_id;
 end if;
 return new;
end $$;
revoke all on function public.career_resume_uploads_on_erase() from public, anon, authenticated;
drop trigger if exists career_resume_uploads_on_erase on public.career_watch_kv;
create trigger career_resume_uploads_on_erase after insert or update on public.career_watch_kv
 for each row when (new.key = 'career:account') execute function public.career_resume_uploads_on_erase();

-- Rows queued before the rule, with no resume on file and stored for them: closed as not sent, never driven.
update public.career_apply_jobs set state = 'not_submitted',
 reason = 'not sent: no resume was bound to it (applications go only with a real resume)', updated_at = now()
 where state = 'queued' and not public.career_resume_ok(user_id, payload);

-- 6. The card's answer, 20261025170000's text with one mapping added: the queue's no_resume refusal is said as itself.
create or replace function public.career_apply_card_answer_for(p_user uuid, p_card uuid, p_approve int[], p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare c public.career_apply_cards; it jsonb; p public.career_apply_prepared; out jsonb := '[]'; res text; n int;
begin
 if p_user is null or p_card is null or p_now is null then raise exception 'invalid card answer'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select * into c from public.career_apply_cards where id = p_card and user_id = p_user for update;
 if not found then raise exception 'invalid card answer'; end if;
 if c.state <> 'open' then raise exception 'card_answered'; end if;
 if c.shown_at < p_now - interval '24 hours' then raise exception 'card_expired'; end if;
 -- D-031 / SERIAL-1451: an approval counts only within 10 minutes of the card's showing.
 if cardinality(coalesce(p_approve, '{}')) > 0 and c.shown_at < p_now - interval '10 minutes' then raise exception 'card_stale'; end if;
 if exists (select from unnest(coalesce(p_approve, '{}')) a where a not between 1 and jsonb_array_length(c.items)) then
  raise exception 'not_on_card'; end if;
 for it in select * from jsonb_array_elements(c.items) loop
  n := (it->>'n')::int;
  select * into p from public.career_apply_prepared where id = (it->>'prepared_id')::uuid and user_id = p_user for update;
  if p.payload_hash is distinct from it->>'payload_hash' then res := 'changed';
  elsif n = any(coalesce(p_approve, '{}')) then
   begin
    perform public.career_apply_enqueue(p.payload, p.payload_hash, p.payload_hash, public.career_apply_daily_limit(p_user));
    res := 'queued';
   exception when others then
    res := case when sqlerrm like '%pace_unreadable%' then 'pace_unreadable' when sqlerrm like '%daily_cap%' then 'daily_cap'
     when sqlerrm like '%company_cooldown%' then 'company_cooldown'
     when sqlerrm like '%duplicate_job%' then 'duplicate' when sqlerrm like '%no_resume%' then 'no_resume' when sqlerrm like '%stale%' then 'stale' else 'refused' end;
   end;
  else res := 'declined'; end if;
  update public.career_apply_prepared set state = case res when 'queued' then 'approved' when 'stale' then 'expired' else 'declined' end, updated_at = p_now where id = p.id;
  out := out || jsonb_build_object('n', n, 'company', p.company, 'result', res);
 end loop;
 update public.career_apply_cards set state = 'answered', answered_at = p_now, answer = jsonb_build_object('approve', to_jsonb(coalesce(p_approve, '{}')), 'results', out) where id = c.id;
 return out;
end $$;
-- Same privileges as 20261020030000: only the definer wrappers (career_apply_card_answer_own/_as) call it.
revoke all on function public.career_apply_card_answer_for(uuid, uuid, int[], timestamptz) from public, anon, authenticated, service_role;
