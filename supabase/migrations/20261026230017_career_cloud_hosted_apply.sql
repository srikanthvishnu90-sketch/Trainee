-- Hosted apply (FEATURE 17, 2026-10-26): preparation and sending for a person with only a phone. NOT APPLIED: like
-- every migration, the owner applies it (scripts/launch/trainee-go-live.sh lists it with its mark).
--
-- Three things, each service role only, each behind switches that are off until the owner turns them on:
--
--  1. The cloud route for text cards (the card shown in chat: Telegram, SMS, WhatsApp, the web chat's text card). The card
--     bridge (20261024130000) lets the cloud claim only a job approved on the newer cloud card, which only a signed-in web
--     person can tap. A job approved on a text card (career_apply_card_answer_for: the exact prepared payload, by its hash,
--     within the card's 10-minute window) is claimable here, and only when ALL of these hold at the claim and again at
--     the authorization before the engine and before the one Submit:
--       the kill switch CAREER_CLOUD_APPLY = 'on' and this route's own switch CAREER_CLOUD_TEXT_CARDS = 'on';
--       the job is the one the card's item approved (same person, same payload, same hash; the card answered with that
--       number approved and queued; the job created inside the card's showing and its answer) and is less than 24 hours
--       old from the answer;
--       the person's account is as approved (career_apply_current), the portal family is greenhouse, lever or ashby,
--       the destination is the employer's https endpoint (not a form only the person can submit);
--       the gate is open for the family (3 hand submissions confirmed by email, 20261021080000, unchanged) or the person
--       holds a live waiver with sends left (20261024120000, unchanged);
--       the person's opt-in is on for this account (an erase ends it), neither the family nor the person is paused;
--       the person's own pace only (the number they set, CAPS-1390), when they set one; Trainee
--       has no number of its own (owner, 2026-10-27, D-MS-2 and NO LIMITS: no per-person daily cap, no default pacing
--       number); no employer cooldown (D-MS-3: only the exact posting is a duplicate, kept by the queue's own unique
--       rule); a per-site number of claims per minute only when the dispatcher is given one (configurable, unset by
--       default: the brake is the portal's own refusal, which pauses the family);
--       the resume the payload names is kept for the cloud, for this account, byte for byte.
--     Claimed jobs get a marker (career_apply_cloud_text_claims); the authorization requires it. Nothing here changes the
--     gate, the waiver, the bridge or any earlier claim.
--  2. Hosted preparation requests (career_apply_prepare_requests): the chat's "prepare these now" for one person's queued
--     postings, claimed by the dispatcher under a global number (infrastructure sizing) and, only when given, a
--     per-site-per-minute number; no per-person or per-request ceiling (a request of any size is split into parts of 25
--     postings, one sandbox each, all accepted); run in a sandbox under a lease, finished once.
--  3. A bounded card push for postings the person asked for in chat (career_apply_card_push_requested_for): the same
--     checks as the scheduled push (career_apply_card_push_for) except the 30-minute "conversation under way" hold, which
--     is what kept the card the person had just asked for from being shown. Only for prepared rows from a preparation
--     the person's own chat requested in the last 2 hours.

-- ---------------------------------------------------------------------------------------------- the outbox's kinds
-- The outbox's kinds and keys as their union across every earlier file: 20261021070000 (channel parity) and
-- 20261021075000 (apply ops) each re-create these two checks, and an apply order that runs parity after ops (the flow
-- harness's, and any live project patched by hand) drops 'link' and 'questions', which the questions push and this
-- file's requested pushes write. Re-created here, last, as the superset: nothing that was allowed is refused.
alter table public.career_outbox drop constraint if exists career_outbox_kind_check;
alter table public.career_outbox add constraint career_outbox_kind_check
  check (kind in ('alert', 'report', 'reply', 'receipt', 'card', 'status', 'followup', 'mock', 'brief', 'digest', 'link', 'questions'));
alter table public.career_outbox drop constraint if exists career_outbox_key_check;
alter table public.career_outbox add constraint career_outbox_key_check
  check (key ~ '^(alert|report|reply|receipt|card|status|followup|mock|brief|digest|link|questions):.+$' and length(key) <= 310);

-- ---------------------------------------------------------------------------------------------- the switch
alter table public.career_cloud_settings drop constraint if exists career_cloud_settings_key_check;
alter table public.career_cloud_settings add constraint career_cloud_settings_key_check
  check (key in ('CAREER_CLOUD_APPLY', 'owner_user_id', 'gate_user_ids', 'CAREER_AGENT_SUBMIT', 'CAREER_CLOUD_TEXT_CARDS'));
create or replace function public.career_apply_cloud_text_cards_enabled() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce((select value = 'on' from public.career_cloud_settings where key = 'CAREER_CLOUD_TEXT_CARDS'), false)
$$;

-- ---------------------------------------------------------------------------------------------- 1. text cards
create table if not exists public.career_apply_cloud_text_claims (
  job_id uuid primary key references public.career_apply_jobs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  card_id uuid not null,
  item_n integer not null check (item_n >= 1),
  host text not null check (length(host) between 1 and 300),
  claimed_at timestamptz not null
);
create index if not exists career_apply_cloud_text_claims_host on public.career_apply_cloud_text_claims (host, claimed_at);
alter table public.career_apply_cloud_text_claims enable row level security;
revoke all on public.career_apply_cloud_text_claims from public, anon, authenticated;
grant select on public.career_apply_cloud_text_claims to service_role;

create or replace function public.career_apply_url_host(p_url text) returns text
language sql immutable set search_path = pg_catalog as $$
 select lower(substring(p_url from '^https://([^/?#:@]+)(?::[0-9]+)?(?:[/?#]|$)'))
$$;

-- The text card item that approved this job, or null: the card answered with this item's number approved and queued, the
-- item's hash and its prepared row's hash and payload exactly the job's, the job created inside the card's showing and
-- its answer.
create or replace function public.career_apply_cloud_text_card_of(j public.career_apply_jobs) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('card_id', c.id, 'n', (it->>'n')::int, 'answered_at', c.answered_at)
 from public.career_apply_cards c
 cross join lateral jsonb_array_elements(c.items) it
 join public.career_apply_prepared p on p.id = (it->>'prepared_id')::uuid
 where c.user_id = j.user_id and c.state = 'answered' and c.answered_at is not null
  and it->>'payload_hash' = j.payload_hash
  and p.user_id = j.user_id and p.state = 'approved' and p.payload_hash = j.payload_hash and p.payload = j.payload
  and jsonb_typeof(c.answer->'approve') = 'array' and c.answer->'approve' @> to_jsonb((it->>'n')::int)
  and exists (select from jsonb_array_elements(coalesce(c.answer->'results', '[]'::jsonb)) r
   where r->>'n' = it->>'n' and r->>'result' = 'queued')
  and j.created_at >= c.shown_at and j.created_at <= c.answered_at
 order by c.answered_at desc limit 1
$$;

create or replace function public.career_apply_cloud_card_bound(p_job uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r boolean := false;
begin
 if to_regclass('career_message_approval_private.cloud_bound_jobs') is null then return false; end if;
 execute 'select exists (select 1 from career_message_approval_private.cloud_bound_jobs where job_row_id = $1)' into r using p_job;
 return coalesce(r, false);
end $$;

-- Where the application is sent: only an https address the employer's form posts to (a form only the person can submit
-- carries none). Its own function so the rule is one place.
create or replace function public.career_apply_cloud_destination_ok(p_dest text) returns boolean
language sql immutable set search_path = pg_catalog as $$ select coalesce(p_dest, '') ~ '^https://' $$;

-- Why the cloud may not take this text-card job now, or null. p_phase: 'claim' (queued, unclaimed) or 'authorize' (the
-- same job, driving under this route's claim). p_per_person_day / p_per_site_minute: the dispatcher's numbers, or null
-- (unset by default; NO LIMITS).
create or replace function public.career_apply_cloud_text_refusal(j public.career_apply_jobs, p_now timestamptz, p_phase text,
 p_per_person_day integer default null, p_per_site_minute integer default null) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare fam text := public.career_apply_portal(j.url); v_host text := public.career_apply_url_host(j.url); card jsonb;
 o public.career_apply_cloud_optin; a jsonb; co text := public.career_apply_company_key(j.company);
 went text[] := array['driving', 'confirmed', 'submitted_unconfirmed', 'needs_user', 'unknown_outcome']; cap integer;
begin
 if p_now is null or p_phase is null or p_phase not in ('claim', 'authorize') then return 'invalid'; end if;
 -- The owner's kill switch (CAREER_AGENT_SUBMIT), the cloud's (CAREER_CLOUD_APPLY) and this route's (CAREER_CLOUD_TEXT_CARDS):
 -- all three, as every other cloud route requires the first two.
 if not public.career_apply_agent_submit_enabled() then return 'cloud_switches_off'; end if;
 if not public.career_apply_cloud_enabled() or not public.career_apply_cloud_text_cards_enabled() then return 'cloud_switches_off'; end if;
 if p_phase = 'claim' and (j.state <> 'queued' or j.attempts <> 0 or j.source is not null) then return 'not_approved'; end if;
 if p_phase = 'authorize' and (j.state <> 'driving' or j.source is distinct from 'cloud' or j.attempts <> 1
  or not exists (select from public.career_apply_cloud_text_claims t where t.job_id = j.id and t.user_id = j.user_id)) then
  return 'not_approved'; end if;
 if j.approval_hash is distinct from j.payload_hash or j.payload_hash is distinct from public.career_apply_payload_hash(j.payload)
  or coalesce(j.payload->>'engine_approval', '') !~ '^[0-9a-f]{64}$' or j.payload->>'user_id' is distinct from j.user_id::text
  or j.payload->>'url' is distinct from j.url or j.payload->>'company' is distinct from j.company
  or j.payload->>'job_id' is distinct from j.job_id then return 'not_approved'; end if;
 if public.career_apply_cloud_card_bound(j.id) then return 'card_cloud_route'; end if;
 card := public.career_apply_cloud_text_card_of(j);
 if card is null then return 'not_card_approved'; end if;
 if (card->>'answered_at')::timestamptz <= p_now - interval '24 hours' then return 'approval_expired'; end if;
 if p_phase = 'authorize' and not exists (select from public.career_apply_cloud_text_claims t where t.job_id = j.id
  and t.card_id = (card->>'card_id')::uuid and t.item_n = (card->>'n')::int) then return 'not_approved'; end if;
 if public.career_apply_current(j.user_id, j.payload) is distinct from true then return 'stale'; end if;
 if fam is null or fam not in ('greenhouse', 'lever', 'ashby') then return 'portal_not_cloud'; end if;
 if not public.career_apply_cloud_destination_ok(j.payload->>'destination') then return 'person_submits'; end if;
 if not public.career_apply_cloud_open(fam) then
  if p_phase = 'claim' and public.career_apply_cloud_waiver_left(j.user_id, fam, p_now) <= 0 then return 'gate_closed'; end if;
  -- At the authorization this job already counts against its waiver: it may go while the count, it included, is within.
  if p_phase = 'authorize' and not exists (select from public.career_apply_cloud_gate_waivers w where w.user_id = j.user_id
   and w.portal = fam and w.revoked_at is null and w.created_at <= j.claimed_at and w.expires_at > p_now
   and (select count(*) from public.career_apply_jobs x where x.user_id = j.user_id and x.source = 'cloud' and x.attempts > 0
    and x.claimed_at >= w.created_at and public.career_apply_portal(x.url) = fam) <= w.max_sends) then return 'gate_closed'; end if;
 end if;
 select * into o from public.career_apply_cloud_optin where user_id = j.user_id;
 select value into a from public.career_watch_kv where user_id = j.user_id and key = 'career:account';
 if o.user_id is null or not o.enabled or o.privacy_epoch is distinct from coalesce((a->>'epoch')::bigint, 0) then return 'not_opted_in'; end if;
 if exists (select from public.career_apply_cloud_pauses where scope = 'portal' and portal = fam and until > p_now) then return 'portal_paused'; end if;
 if exists (select from public.career_apply_cloud_pauses where scope = 'person' and user_id = j.user_id and until > p_now) then return 'person_paused'; end if;
 -- Only a number someone chose: the person's own pace as it is now (career_apply_daily_limit, CAPS-1390) and the
 -- dispatcher's, if it was given one. Not the opt-in row's daily copy: the card-cloud bridge's opt-in writes least(15, ...)
 -- there, Trainee's number, not the person's. least() skips nulls; with neither, there is no daily number (NO LIMITS).
 -- No employer cooldown (D-MS-3).
 cap := least(public.career_apply_daily_limit(j.user_id), p_per_person_day);
 if cap is not null and (select count(*) from public.career_apply_jobs x where x.user_id = j.user_id and x.id <> j.id and x.state = any(went)
  and x.claimed_at > p_now - interval '1 day') >= cap then return 'daily_limit'; end if;
 if p_phase = 'claim' and p_per_site_minute is not null and (select count(*) from public.career_apply_cloud_text_claims t
  where t.host = v_host and t.claimed_at > p_now - interval '1 minute') >= p_per_site_minute then return 'site_rate'; end if;
 if not exists (select from public.career_apply_cloud_resumes r where r.user_id = j.user_id and r.sha256 = j.payload->>'resume_sha256'
  and r.privacy_epoch = (j.payload->>'privacy_epoch')::bigint and encode(sha256(r.bytes), 'hex') = r.sha256) then
  return 'resume_not_in_cloud'; end if;
 return null;
end $$;

-- The text-card claim for one portal family: at most p_limit (1..6), oldest first per person, each person's lock in user
-- id order (as every claim), each job claimed once (attempts = 1, source = 'cloud'), with its marker.
create or replace function public.career_apply_cloud_text_claim_at(p_limit integer, p_now timestamptz, p_portal text,
 p_per_person_day integer default null, p_per_site_minute integer default null) returns setof public.career_apply_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids uuid[]; users uuid[]; u uuid; c uuid; j public.career_apply_jobs; card jsonb; got int := 0;
 lim int := greatest(0, least(6, coalesce(p_limit, 0)));
begin
 if p_now is null or lim = 0 or p_portal is null or p_portal not in ('greenhouse', 'lever', 'ashby')
  or not public.career_apply_agent_submit_enabled()
  or not public.career_apply_cloud_enabled() or not public.career_apply_cloud_text_cards_enabled() then return; end if;
 ids := array(select x.id from (select q.id, q.created_at, row_number() over (partition by q.user_id order by q.created_at, q.id) rn
   from public.career_apply_jobs q join public.career_apply_cloud_optin o on o.user_id = q.user_id and o.enabled
   where q.state = 'queued' and q.attempts = 0 and q.source is null and q.approval_hash = q.payload_hash
    and public.career_apply_portal(q.url) = p_portal) x order by x.rn, x.created_at, x.id limit lim * 4);
 users := array(select distinct user_id from public.career_apply_jobs where id = any(ids) order by user_id);
 foreach u in array users loop perform pg_advisory_xact_lock(hashtextextended(u::text, 0)); end loop;
 foreach c in array ids loop
  exit when got >= lim;
  select * into j from public.career_apply_jobs where id = c and state = 'queued' for update skip locked;
  continue when not found;
  continue when public.career_apply_cloud_text_refusal(j, clock_timestamp(), 'claim', p_per_person_day, p_per_site_minute) is not null;
  card := public.career_apply_cloud_text_card_of(j);
  update public.career_apply_jobs set state = 'driving', attempts = 1, claimed_at = clock_timestamp(), lease_token = gen_random_uuid(),
   updated_at = clock_timestamp(), source = 'cloud' where id = j.id returning * into j;
  insert into public.career_apply_cloud_text_claims (job_id, user_id, card_id, item_n, host, claimed_at)
   values (j.id, j.user_id, (card->>'card_id')::uuid, (card->>'n')::int, public.career_apply_url_host(j.url), j.claimed_at);
  got := got + 1;
  return next j;
 end loop;
end $$;

-- The authorization before the engine and before the one Submit, for either route: a card-cloud job goes to the bridge's
-- own authorization, unchanged; a text-card job to this route's, which re-checks everything the claim checked.
create or replace function public.career_apply_cloud_text_authorize(p_id uuid, p_lease uuid, p_hash text, p_source_digest text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; j public.career_apply_jobs; why text; dig text;
begin
 select user_id into u from public.career_apply_jobs where id = p_id;
 if u is null then raise exception 'invalid apply claim'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text, 0));
 select * into j from public.career_apply_jobs where id = p_id for update;
 if j.state is distinct from 'driving' or j.source is distinct from 'cloud' or p_lease is null or j.lease_token is distinct from p_lease
  or j.payload_hash is distinct from p_hash or j.claimed_at is null or j.claimed_at <= clock_timestamp() - interval '15 minutes' then
  raise exception 'invalid apply claim'; end if;
 -- The owner's kill switch first, in its own words: nothing goes to the engine or to Submit while it is off.
 if not public.career_apply_agent_submit_enabled() then raise exception 'agent submit is off'; end if;
 why := public.career_apply_cloud_text_refusal(j, clock_timestamp(), 'authorize');
 if why is not null then raise exception '%', why; end if;
 -- The approved sources as they are now (the same digest the card-cloud route checks): the worker read them and checked
 -- every approved answer still stands; a change between that read and this call refuses.
 if coalesce(p_source_digest, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid source digest'; end if;
 if to_regprocedure('public.career_apply_message_cloud_sources(uuid)') is null then raise exception 'approved sources unreadable'; end if;
 execute 'select public.career_apply_message_cloud_sources($1)->>''digest''' into dig using j.user_id;
 if dig is distinct from p_source_digest then raise exception 'approved sources changed'; end if;
 return jsonb_build_object('authorized', true, 'job_id', p_id, 'lease_token', p_lease, 'payload_hash', p_hash, 'route', 'text_card');
end $$;
create or replace function public.career_apply_cloud_authorize_any(p_id uuid, p_lease uuid, p_hash text, p_source_digest text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
 if public.career_apply_cloud_card_bound(p_id) then
  execute 'select public.career_apply_message_cloud_authorize($1, $2, $3, $4)' into r using p_id, p_lease, p_hash, p_source_digest;
  return r;
 end if;
 return public.career_apply_cloud_text_authorize(p_id, p_lease, p_hash, p_source_digest);
end $$;

-- The dispatcher's door for both routes. The card-cloud route first, through its own dispatch claim and its limits
-- unchanged; then text cards, per family, inside what is left of the global and per-family room, with the per-person and
-- per-site numbers. One dispatcher at a time (the same transaction lock).
create or replace function public.career_apply_cloud_dispatch_claim2(p_want integer, p_global integer, p_per_portal integer,
 p_per_person_day integer, p_per_site_minute integer) returns setof public.career_apply_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare live jsonb; room int; f text; n int; got int; j public.career_apply_jobs; first int := 0;
begin
 if p_want is null or p_want not between 0 and 500 or p_global is null or p_global not between 1 and 10000
  or p_per_portal is null or p_per_portal not between 1 and 10000 or p_per_person_day < 1 or p_per_site_minute < 1 then
  raise exception 'invalid dispatch limits'; end if;
 perform pg_advisory_xact_lock(hashtextextended('career-cloud-dispatch-v1', 0));
 for j in select * from public.career_apply_cloud_dispatch_claim(p_want, p_global, p_per_portal) loop
  first := first + 1;
  return next j;
 end loop;
 live := public.career_apply_cloud_inflight(clock_timestamp());
 room := least(p_want - first, p_global - (live->>'total')::int);
 for f in select x from unnest(array['greenhouse', 'lever', 'ashby']) x order by (live->>x)::int, x loop
  exit when room <= 0;
  n := least(room, p_per_portal - (live->>f)::int);
  while n > 0 loop
   got := 0;
   for j in select * from public.career_apply_cloud_text_claim_at(least(6, n), clock_timestamp(), f, p_per_person_day, p_per_site_minute) loop
    got := got + 1;
    return next j;
   end loop;
   n := n - got; room := room - got;
   exit when got < 6;
  end loop;
 end loop;
end $$;

-- The resume a person keeps for the cloud, as is: put by the service for them (the hosted preparation, or a channel's
-- confirmed file upload), read back for their current account only.
create or replace function public.career_apply_cloud_resume_put_for(p_user uuid, p_filename text, p_b64 text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare b bytea; h text; a jsonb;
begin
 if p_user is null or p_b64 is null or length(p_b64) > 7200000 then raise exception 'invalid resume'; end if;
 b := decode(p_b64, 'base64');
 h := encode(sha256(b), 'hex');
 select value into a from public.career_watch_kv where user_id = p_user and key = 'career:account';
 if a is null then raise exception 'no_account'; end if;
 insert into public.career_apply_cloud_resumes (user_id, sha256, filename, bytes, privacy_epoch)
 values (p_user, h, p_filename, b, coalesce((a->>'epoch')::bigint, 0))
 on conflict (user_id, sha256) do update set filename = excluded.filename, bytes = excluded.bytes, privacy_epoch = excluded.privacy_epoch,
  created_at = now();
 return h;
end $$;
create or replace function public.career_apply_cloud_resume_kept_for(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('filename', r.filename, 'sha256', r.sha256, 'b64', encode(r.bytes, 'base64'))
 from public.career_apply_cloud_resumes r join public.career_watch_kv k on k.user_id = r.user_id and k.key = 'career:account'
 where r.user_id = p_user and r.privacy_epoch = coalesce((k.value->>'epoch')::bigint, 0) and encode(sha256(r.bytes), 'hex') = r.sha256
 order by r.created_at desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------- 2. preparation requests
-- One status text to the person about their preparation, on their channel: the outbox when they text (never after STOP),
-- else a message in the thread they last talked in (the web chat). Once per key. True when it was said.
create or replace function public.career_apply_prepare_tell(p_user uuid, p_key text, p_text text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare thread uuid; n int;
begin
 if p_user is null or p_key !~ '^status:prepare:' or p_text is null or length(p_text) not between 1 and 1500 then raise exception 'invalid notice'; end if;
 if exists (select from public.channel_contacts where user_id = p_user and opted_out) then return false; end if;
 if exists (select from public.channel_contacts where user_id = p_user and thread_id is not null) then
  insert into public.career_outbox (user_id, key, kind, text, deliver_at) values (p_user, p_key, 'status', p_text, clock_timestamp()) on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
 end if;
 select m.thread_id into thread from public.agent_messages m join public.agent_threads t on t.id = m.thread_id
  where t.user_id = p_user order by m.id desc limit 1;
 if thread is null or exists (select from public.agent_messages where thread_id = thread and meta->>'notice_key' = p_key) then return false; end if;
 insert into public.agent_messages (thread_id, role, content, meta)
 values (thread, 'assistant', p_text, jsonb_build_object('career', true, 'intent', 'career_apply_prepare_notice', 'notice_key', p_key));
 return true;
end $$;


create table if not exists public.career_apply_prepare_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_ids text[] not null check (cardinality(job_ids) between 1 and 25),
  hosts text[] not null default '{}' check (cardinality(hosts) = cardinality(job_ids)),
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed', 'expired')),
  lease_token uuid,
  sandbox text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  outcome jsonb not null default '{}' check (octet_length(outcome::text) <= 65536),
  card_id uuid
);
create index if not exists career_apply_prepare_requests_queue on public.career_apply_prepare_requests (state, created_at);
create index if not exists career_apply_prepare_requests_user on public.career_apply_prepare_requests (user_id, claimed_at);
alter table public.career_apply_prepare_requests enable row level security;
revoke all on public.career_apply_prepare_requests from public, anon, authenticated;
grant select on public.career_apply_prepare_requests to service_role;

-- The chat's request: the person's own queued postings (career_apply_wanted, waiting) and nothing else, never one on
-- LinkedIn or Indeed (Trainee never automates either). A second request for the same postings while one is waiting or
-- running is the same request (a double tap or a retried kick). hosts[i] is the employer host of job_ids[i].
-- The numbers count postings, not requests. A request of any size is accepted whole and split into parts of 25 postings
-- (one sandbox each; a part is a batch, never a ceiling: NO LIMITS). p_per_person_day: a number someone chose, or null
-- (unset by default); only then can a part wait for the next day. Returns {id (the first part), state, accepted,
-- waiting_for, requests (every part's id), postings (how many in all)}.
create or replace function public.career_apply_prepare_request_put(p_user uuid, p_job_ids text[], p_per_person_day integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare ids text[]; part text[]; r public.career_apply_prepare_requests; used int; parts uuid[] := '{}'; first public.career_apply_prepare_requests;
 i int; waits boolean;
begin
 if p_user is null or p_job_ids is null or cardinality(p_job_ids) < 1 or p_per_person_day < 1 then raise exception 'invalid prepare request'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 7));
 ids := array(select distinct w.posting_key from public.career_apply_wanted w where w.user_id = p_user and w.state = 'waiting'
  and w.posting_key = any(p_job_ids) and not public.career_apply_never_automated(w.url) order by 1);
 if cardinality(ids) = 0 then raise exception 'nothing_to_prepare'; end if;
 used := public.career_apply_prepare_postings_today(p_user, clock_timestamp());
 waits := p_per_person_day is not null and used >= p_per_person_day;
 i := 1;
 while i <= cardinality(ids) loop
  part := ids[i : i + 24];
  select * into r from public.career_apply_prepare_requests where user_id = p_user and state in ('queued', 'running')
   and job_ids @> part and job_ids <@ part and created_at > clock_timestamp() - interval '15 minutes' order by created_at desc limit 1;
  if r.id is null then
   insert into public.career_apply_prepare_requests (user_id, job_ids, hosts, outcome)
   values (p_user, part, array(select coalesce(public.career_apply_url_host(w.url), '') from unnest(part) with ordinality k(pk, n)
    join public.career_apply_wanted w on w.user_id = p_user and w.posting_key = k.pk order by k.n),
    case when waits then '{"waiting_for":"per_person_day"}'::jsonb else '{}'::jsonb end)
   returning * into r;
  end if;
  if first.id is null then first := r; end if;
  parts := parts || r.id;
  i := i + 25;
 end loop;
 return jsonb_build_object('id', first.id, 'state', first.state, 'accepted', not waits,
  'waiting_for', case when waits then 'per_person_day' end, 'requests', to_jsonb(parts), 'postings', cardinality(ids));
end $$;

-- Postings Trainee started preparing for this person in the 24 hours before p_at.
create or replace function public.career_apply_prepare_postings_today(p_user uuid, p_at timestamptz) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce(sum(cardinality(job_ids)), 0)::integer from public.career_apply_prepare_requests
 where user_id = p_user and claimed_at > p_at - interval '1 day'
$$;
-- A posting Trainee never prepares or sends: LinkedIn and Indeed (the owner's rule: never automated).
create or replace function public.career_apply_never_automated(p_url text) returns boolean
language sql immutable set search_path = pg_catalog as $$
 select coalesce(lower(substring(p_url from '^[a-z]+://([^/?#:@]+)')), '') ~ '(^|\.)(linkedin\.com|indeed\.com|indeed\.[a-z.]+)$'
$$;

-- The dispatcher's claim: requests running past their 15-minute lease are expired (never re-run: a sandbox may still be
-- writing); then the oldest queued ones, at most p_want, never more than p_global running at once (infrastructure
-- sizing). The numbers count postings: p_per_person_day / p_per_site_minute only when given (null by default, NO LIMITS):
-- at most that many postings started per person in 24 hours / per employer host per minute. A request that fits only in part is split: the postings that fit run now, the rest wait in
-- a request of their own (same age, same order). A request that does not fit at all records why it waits.
-- Requests older than 24 hours that never fit are expired, and the person told.
create or replace function public.career_apply_prepare_request_claim(p_want integer, p_global integer, p_per_person_day integer,
 p_per_site_minute integer) returns setof public.career_apply_prepare_requests
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_apply_prepare_requests; running int; got int := 0; n timestamptz := clock_timestamp();
 left_person int; take text[]; take_h text[]; rest text[]; rest_h text[]; i int; h text; site jsonb; why text;
begin
 if p_want is null or p_want not between 0 and 500 or p_global is null or p_global not between 1 and 10000
  or p_per_person_day < 1 or p_per_site_minute < 1 then
  raise exception 'invalid prepare limits'; end if;
 perform pg_advisory_xact_lock(hashtextextended('career-prepare-dispatch-v1', 0));
 -- Each expiry is told to the person once (unless they said STOP): what happened, that nothing was sent, what to do.
 for r in update public.career_apply_prepare_requests set state = 'expired', finished_at = n,
  outcome = outcome || jsonb_build_object('reason', 'the preparation did not finish inside its lease; not run again')
  where state = 'running' and claimed_at < n - interval '15 minutes' returning * loop
  perform public.career_apply_prepare_tell(r.user_id, 'status:prepare:' || r.id, 'Preparing the application you asked for stopped before it finished, so there is no card for it. Nothing was sent. Say "apply me to" with the link to try again.');
 end loop;
 for r in update public.career_apply_prepare_requests set state = 'expired', finished_at = n,
  outcome = outcome || jsonb_build_object('reason', 'not started within 24 hours')
  where state = 'queued' and created_at < n - interval '24 hours' returning * loop
  perform public.career_apply_prepare_tell(r.user_id, 'status:prepare:' || r.id, 'I couldn''t start preparing the application you asked for within a day. Nothing was sent, and it is still in your queue. Say "apply me to" with the link to try again.');
 end loop;
 select count(*) into running from public.career_apply_prepare_requests where state = 'running';
 -- Postings started this minute, per host.
 select coalesce(jsonb_object_agg(y.host, y.c), '{}') into site from (select u.host, count(*) c from public.career_apply_prepare_requests x, unnest(x.hosts) u(host)
  where x.claimed_at > n - interval '1 minute' group by u.host) y;
 for r in select * from public.career_apply_prepare_requests where state = 'queued' order by created_at, id for update skip locked loop
  exit when got >= p_want or running + got >= p_global;
  left_person := case when p_per_person_day is null then null else p_per_person_day - public.career_apply_prepare_postings_today(r.user_id, n) end;
  take := '{}'; take_h := '{}'; rest := '{}'; rest_h := '{}'; why := null;
  for i in 1 .. cardinality(r.job_ids) loop
   h := coalesce(r.hosts[i], '');
   if left_person is not null and cardinality(take) >= left_person then rest := rest || r.job_ids[i]; rest_h := rest_h || h; why := coalesce(why, 'per_person_day');
   elsif p_per_site_minute is not null and coalesce((site->>h)::int, 0) >= p_per_site_minute then rest := rest || r.job_ids[i]; rest_h := rest_h || h; why := coalesce(why, 'per_site_minute');
   else take := take || r.job_ids[i]; take_h := take_h || h; site := site || jsonb_build_object(h, coalesce((site->>h)::int, 0) + 1);
   end if;
  end loop;
  if cardinality(take) = 0 then
   update public.career_apply_prepare_requests set outcome = outcome || jsonb_build_object('waiting_for', why) where id = r.id;
   continue;
  end if;
  if cardinality(rest) > 0 then
   insert into public.career_apply_prepare_requests (user_id, job_ids, hosts, created_at, outcome)
   values (r.user_id, rest, rest_h, r.created_at, jsonb_build_object('waiting_for', why, 'split_from', r.id));
  end if;
  update public.career_apply_prepare_requests set state = 'running', claimed_at = n, lease_token = gen_random_uuid(),
   job_ids = take, hosts = take_h, outcome = outcome - 'waiting_for'
   where id = r.id returning * into r;
  got := got + 1;
  return next r;
 end loop;
end $$;

-- What a sandbox may see of its request: the person and the postings, only while it runs under that lease.
create or replace function public.career_apply_prepare_request_scope(p_id uuid, p_lease uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('id', r.id, 'user_id', r.user_id, 'job_ids', to_jsonb(r.job_ids))
 from public.career_apply_prepare_requests r
 where r.id = p_id and r.state = 'running' and p_lease is not null and r.lease_token = p_lease and r.claimed_at > clock_timestamp() - interval '15 minutes'
$$;
create or replace function public.career_apply_prepare_request_sandbox(p_id uuid, p_lease uuid, p_sandbox text) returns void
language sql security definer set search_path = public, pg_temp as $$
 update public.career_apply_prepare_requests set sandbox = left(p_sandbox, 128) where id = p_id and lease_token = p_lease and state = 'running'
$$;
create or replace function public.career_apply_prepare_request_finish(p_id uuid, p_lease uuid, p_state text, p_outcome jsonb, p_card uuid default null)
returns public.career_apply_prepare_requests language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_apply_prepare_requests;
begin
 if p_state is null or p_state not in ('done', 'failed') or p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
  or octet_length(p_outcome::text) > 60000 then raise exception 'invalid prepare finish'; end if;
 update public.career_apply_prepare_requests set state = p_state, finished_at = clock_timestamp(), outcome = p_outcome, card_id = p_card
  where id = p_id and state = 'running' and p_lease is not null and lease_token = p_lease returning * into r;
 if r.id is null then raise exception 'invalid prepare lease'; end if;
 return r;
end $$;

-- The applications this request made ready (for the card the person asked for), only under its lease.
create or replace function public.career_apply_prepare_request_ready(p_id uuid, p_lease uuid)
returns table (id uuid, company text, card_lines text[], created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
 select p.id, p.company, p.card_lines, p.created_at
 from public.career_apply_prepare_requests r
 join public.career_apply_prepare_attempts t on t.user_id = r.user_id and t.posting_job_id = any(r.job_ids) and t.outcome = 'ready'
 join public.career_apply_prepared p on p.id = t.prepared_id and p.user_id = r.user_id and p.state = 'ready'
 where r.id = p_id and r.state = 'running' and p_lease is not null and r.lease_token = p_lease
 order by p.created_at, p.id
$$;

-- The posting this request asked for, as Trainee holds it (career_postings: the link the person sent), only under its
-- lease and only for one of its postings: the bridge stores a prepared application only when it is for this link.
create or replace function public.career_apply_prepare_request_posting(p_id uuid, p_lease uuid, p_posting text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('job_id', p.job_id, 'url', p.url, 'company', p.company)
 from public.career_apply_prepare_requests r join public.career_postings p on p.job_id = p_posting
 where r.id = p_id and r.state = 'running' and p_lease is not null and r.lease_token = p_lease and p_posting = any(r.job_ids)
$$;

-- ---------------------------------------------------------------------------------------------- 3. the bounded push
-- The card of applications the person asked for in chat, shown as soon as they are prepared: every check of the
-- scheduled push (opted out, no texting thread, WhatsApp's 23-hour window, a questions turn still open, every id ready,
-- the text carrying every line) except the 30-minute "conversation under way" hold. Only for prepared rows whose
-- posting was in a preparation request of this person made in the last 2 hours.
create or replace function public.career_apply_card_push_requested_for(p_user uuid, p_request uuid, p_ids uuid[], p_text text, p_now timestamptz)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare thread uuid; c public.career_apply_cards; home_contact text; seen timestamptz; req public.career_apply_prepare_requests; web_only boolean := false;
begin
 if p_user is null or p_request is null or p_ids is null or cardinality(p_ids) < 1 or p_now is null
  or p_text is null or length(p_text) not between 1 and 4000 then raise exception 'invalid card push'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select * into req from public.career_apply_prepare_requests where id = p_request and user_id = p_user and created_at > p_now - interval '2 hours';
 if req.id is null then raise exception 'not a requested preparation'; end if;
 if exists (select from unnest(p_ids) x where not exists (select from public.career_apply_prepare_attempts t
   where t.user_id = p_user and t.prepared_id = x and t.posting_job_id = any(req.job_ids))) then
  raise exception 'not a requested preparation'; end if;
 if exists (select from public.channel_contacts where user_id = p_user and opted_out) then return null; end if;
 select thread_id into thread from public.channel_contacts where user_id = p_user and thread_id is not null order by last_inbound_at desc nulls last, created_at limit 1;
 -- A person on the web chat only (no texting contact): the card goes into the thread they last talked in, with no text.
 if thread is null then
  select m.thread_id into thread from public.agent_messages m join public.agent_threads t on t.id = m.thread_id
   where t.user_id = p_user order by m.id desc limit 1;
  web_only := thread is not null;
 end if;
 if thread is null then return null; end if;
 home_contact := public.channel_target(p_user, null);
 if home_contact like 'wa:%' then
  select last_inbound_at into seen from public.channel_contacts where contact = home_contact;
  if seen is null or seen < p_now - interval '23 hours' then return null; end if;
 end if;
 if coalesce((select m.meta->>'intent' in ('career_apply_questions', 'career_apply_confirm_which', 'career_apply_email')
               and m.created_at >= p_now - interval '24 hours'
              from public.agent_messages m where m.thread_id = thread and m.role = 'assistant' order by m.id desc limit 1), false)
  or (select count(*) from public.career_apply_prepared where user_id = p_user and state = 'ready' and id = any(p_ids)) <> cardinality(p_ids)
 then return null; end if;
 if exists (select from public.career_apply_prepared p, unnest(p.card_lines) l
            where p.id = any(p_ids) and position(btrim(regexp_replace(l, '\s+', ' ', 'g')) in p_text) = 0) then
  raise exception 'card text does not carry every line'; end if;
 c := public.career_apply_card_open_for(p_user, p_ids, p_now);
 insert into public.agent_messages (thread_id, role, content, meta)
 values (thread, 'assistant', p_text, jsonb_build_object('career', true, 'intent', 'career_apply_card', 'card_id', c.id, 'requested', true,
  'prepare_request', p_request));
 if not web_only then
  insert into public.career_outbox (user_id, key, kind, text, deliver_at, card_id) values (p_user, 'card:' || c.id, 'card', p_text, p_now, c.id);
 end if;
 return c.id;
end $$;

-- The questions this request's preparation asked (open, never texted), only under its lease.
create or replace function public.career_apply_prepare_request_questions(p_id uuid, p_lease uuid) returns setof public.career_apply_questions
language sql stable security definer set search_path = public, pg_temp as $$
 select q.* from public.career_apply_prepare_requests r
 join public.career_apply_questions q on q.user_id = r.user_id and q.state = 'open' and q.pushed_at is null
 where r.id = p_id and r.state = 'running' and p_lease is not null and r.lease_token = p_lease
  and q.job_ids && array(select t.engine_job_id from public.career_apply_prepare_attempts t where t.user_id = r.user_id
   and t.posting_job_id = any(r.job_ids) and t.outcome = 'asked' and t.engine_job_id is not null)
 order by q.created_at, q.id limit 20
$$;
-- Those questions, texted at once (the person is waiting on this application): every check of the scheduled questions
-- push (career_apply_questions_push_for) but its one-a-day and "thread busy" holds, and only questions this request asked.
create or replace function public.career_apply_questions_push_requested_for(p_user uuid, p_request uuid, p_ids uuid[], p_text text, p_now timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare thread uuid; req public.career_apply_prepare_requests; asked text[]; web_only boolean := false;
begin
 if p_user is null or p_request is null or p_ids is null or cardinality(p_ids) not between 1 and 5 or p_now is null
  or p_text is null or length(p_text) not between 1 and 4000 then raise exception 'invalid questions push'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select * into req from public.career_apply_prepare_requests where id = p_request and user_id = p_user and created_at > p_now - interval '2 hours';
 if req.id is null then raise exception 'not a requested preparation'; end if;
 asked := array(select t.engine_job_id from public.career_apply_prepare_attempts t where t.user_id = p_user
  and t.posting_job_id = any(req.job_ids) and t.outcome = 'asked' and t.engine_job_id is not null);
 if exists (select from unnest(p_ids) x where not exists (select from public.career_apply_questions q
   where q.id = x and q.user_id = p_user and q.job_ids && asked)) then raise exception 'not a requested preparation'; end if;
 if exists (select from public.channel_contacts where user_id = p_user and opted_out) then return false; end if;
 select thread_id into thread from public.channel_contacts where user_id = p_user and thread_id is not null
  order by last_inbound_at desc nulls last, created_at limit 1;
 if thread is null then
  select m.thread_id into thread from public.agent_messages m join public.agent_threads t on t.id = m.thread_id
   where t.user_id = p_user order by m.id desc limit 1;
  web_only := thread is not null;
 end if;
 if thread is null then return false; end if;
 if (select count(*) from public.career_apply_questions where user_id = p_user and id = any(p_ids) and state = 'open' and pushed_at is null)
     <> (select count(distinct x) from unnest(p_ids) x) or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids)
 then return false; end if;
 if exists (select from public.career_apply_questions where id = any(p_ids)
            and position(public.career_text_spaces(label) in public.career_text_spaces(p_text)) = 0) then return false; end if;
 update public.career_apply_questions set pushed_at = p_now, updated_at = p_now where id = any(p_ids);
 insert into public.agent_messages (thread_id, role, content, meta)
 values (thread, 'assistant', p_text, jsonb_build_object('career', true, 'intent', 'career_apply_questions', 'requested', true, 'prepare_request', p_request));
 insert into public.career_watch_kv (user_id, key, value, updated_at)
 values (p_user, 'career:questions-shown', jsonb_build_object('thread', thread, 'ids', to_jsonb(p_ids::text[]), 'at', p_now), p_now)
 on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at;
 if not web_only then
  insert into public.career_outbox (user_id, key, kind, text, deliver_at) values (p_user, 'questions:' || p_ids[1], 'questions', p_text, p_now);
 end if;
 return true;
end $$;

-- When nothing could be prepared for what the person asked, they are told why, once per request (the outbox keeps one
-- text per key, ever), unless they said STOP.
create or replace function public.career_apply_prepare_request_notice(p_id uuid, p_lease uuid, p_text text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_apply_prepare_requests;
begin
 if p_text is null or length(p_text) not between 1 and 1500 then raise exception 'invalid notice'; end if;
 select * into r from public.career_apply_prepare_requests where id = p_id and state = 'running' and p_lease is not null and lease_token = p_lease;
 if r.id is null then raise exception 'invalid prepare lease'; end if;
 return public.career_apply_prepare_tell(r.user_id, 'status:prepare:' || r.id, p_text);
end $$;

-- ---------------------------------------------------------------------------------------------- follow-through
-- Where each posting the person asked for stands before it is an application on the queue, from the records: on a card
-- waiting for their tap, waiting on their answers, being prepared, could not be prepared (and why), or only in the queue.
create or replace function public.career_apply_pending_for(p_user uuid)
returns table (posting_key text, company text, title text, url text, stage text, detail text, open_questions integer, at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
 select w.posting_key, w.company, w.title, w.url,
  case
   when exists (select from public.career_apply_prepared p join public.career_apply_cards c on c.user_id = p.user_id and c.state = 'open'
     and c.items @> jsonb_build_array(jsonb_build_object('prepared_id', p.id::text)) where p.id = t.prepared_id and p.state = 'shown') then 'on_card'
   -- Prepared, but they texted STOP: no card is shown until they text START.
   when exists (select from public.career_apply_prepared p where p.id = t.prepared_id and p.state = 'ready')
    and exists (select from public.channel_contacts c where c.user_id = w.user_id and c.opted_out) then 'stopped'
   when exists (select from public.career_apply_prepared p where p.id = t.prepared_id and p.state = 'ready') then 'ready'
   when exists (select from public.career_apply_prepare_requests r where r.user_id = w.user_id and r.state = 'running' and w.posting_key = any(r.job_ids)) then 'preparing'
   -- Waiting to start: because today's preparations are used up, or for its turn (another site's minute, the queue).
   when exists (select from public.career_apply_prepare_requests r where r.user_id = w.user_id and r.state = 'queued' and w.posting_key = any(r.job_ids)
    and r.outcome->>'waiting_for' = 'per_person_day') then 'waiting_day_limit'
   when exists (select from public.career_apply_prepare_requests r where r.user_id = w.user_id and r.state = 'queued' and w.posting_key = any(r.job_ids)) then 'starting'
   when t.outcome = 'asked' and q.n > 0 then 'waiting_on_you'
   when t.outcome in ('refused', 'no_resume', 'error') then t.outcome
   else 'in_queue' end,
  t.detail, coalesce(q.n, 0)::integer, coalesce(t.at, w.queued_at)
 from public.career_apply_wanted w
 left join public.career_apply_prepare_attempts t on t.user_id = w.user_id and t.posting_job_id = w.posting_key
 left join lateral (select count(*) n from public.career_apply_questions x where x.user_id = w.user_id and x.state = 'open'
   and t.engine_job_id is not null and t.engine_job_id = any(x.job_ids)) q on true
 where w.user_id = p_user and w.state = 'waiting'
  and not exists (select from public.career_apply_jobs j where j.user_id = w.user_id and j.job_id in (w.posting_key, coalesce(t.engine_job_id, '')))
 order by coalesce(t.at, w.queued_at) desc
$$;

-- "Cancel my application to X": everything for that employer not yet sent is withdrawn, under the person's lock (the claim
-- takes the same lock, so a job cannot be claimed halfway through): their queued postings leave the queue, their prepared
-- applications not yet approved are removed with their tries (so asking again prepares afresh), an open card that shows
-- one is closed (a tap on it approves nothing), an approved application not yet claimed is closed not_submitted. One
-- being sent now, or already sent, is left as it is and named. Returns what was done.
create or replace function public.career_apply_cancel_for(p_user uuid, p_company text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare co text := public.career_apply_company_key(p_company); wanted int := 0; prepared int := 0; cards int := 0; jobs int := 0;
 ids uuid[]; driving int; sent jsonb; keys text[];
begin
 if p_user is null or co = '' then raise exception 'invalid cancel'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 keys := array(select posting_key from public.career_apply_wanted where user_id = p_user and state = 'waiting' and public.career_apply_company_key(company) = co);
 ids := array(select id from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown') and public.career_apply_company_key(company) = co);
 update public.career_apply_cards c set state = 'answered', answered_at = clock_timestamp(), answer = '{"closed":"cancelled by the person"}'
  where c.user_id = p_user and c.state = 'open' and exists (select from jsonb_array_elements(c.items) it where (it->>'prepared_id')::uuid = any(ids));
 get diagnostics cards = row_count;
 delete from public.career_apply_prepare_attempts where user_id = p_user and (prepared_id = any(ids) or posting_job_id = any(keys));
 delete from public.career_apply_prepared where id = any(ids);
 get diagnostics prepared = row_count;
 delete from public.career_apply_wanted where user_id = p_user and posting_key = any(keys);
 get diagnostics wanted = row_count;
 update public.career_apply_prepare_requests set (job_ids, hosts) = (select array_agg(u.j order by u.n), array_agg(coalesce(u.h, '') order by u.n)
   from unnest(job_ids, hosts) with ordinality u(j, h, n) where not u.j = any(keys))
  where user_id = p_user and state in ('queued', 'running') and job_ids && keys and cardinality(array(select x from unnest(job_ids) x where not x = any(keys))) > 0;
 update public.career_apply_prepare_requests set state = 'expired', finished_at = clock_timestamp(),
  outcome = outcome || '{"reason":"cancelled by the person"}' where user_id = p_user and state in ('queued', 'running') and job_ids <@ keys;
 update public.career_apply_jobs set state = 'not_submitted', reason = 'not sent: you cancelled it before it was sent',
  evidence = evidence || jsonb_build_object('reason', 'cancelled by the person', 'cancelled_at', clock_timestamp()), updated_at = clock_timestamp()
  where user_id = p_user and state = 'queued' and attempts = 0 and source is null and public.career_apply_company_key(company) = co;
 get diagnostics jobs = row_count;
 select count(*) into driving from public.career_apply_jobs where user_id = p_user and state = 'driving' and public.career_apply_company_key(company) = co;
 select jsonb_agg(jsonb_build_object('state', state, 'at', coalesce(claimed_at, created_at)) order by created_at desc) into sent
  from public.career_apply_jobs where user_id = p_user and state in ('confirmed', 'submitted_unconfirmed', 'unknown_outcome') and public.career_apply_company_key(company) = co;
 return jsonb_build_object('queued_removed', wanted, 'prepared_removed', prepared, 'cards_closed', cards, 'approved_cancelled', jobs,
  'being_sent', driving, 'already_sent', coalesce(sent, '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------- grants
revoke all on function public.career_apply_cloud_text_cards_enabled(), public.career_apply_url_host(text),
 public.career_apply_cloud_text_card_of(public.career_apply_jobs), public.career_apply_cloud_card_bound(uuid),
 public.career_apply_cloud_text_refusal(public.career_apply_jobs, timestamptz, text, integer, integer),
 public.career_apply_cloud_text_claim_at(integer, timestamptz, text, integer, integer),
 public.career_apply_cloud_text_authorize(uuid, uuid, text, text), public.career_apply_cloud_authorize_any(uuid, uuid, text, text),
 public.career_apply_cloud_dispatch_claim2(integer, integer, integer, integer, integer),
 public.career_apply_cloud_resume_put_for(uuid, text, text), public.career_apply_cloud_resume_kept_for(uuid),
 public.career_apply_prepare_request_put(uuid, text[], integer), public.career_apply_prepare_request_claim(integer, integer, integer, integer),
 public.career_apply_prepare_request_scope(uuid, uuid), public.career_apply_prepare_request_sandbox(uuid, uuid, text),
 public.career_apply_prepare_request_finish(uuid, uuid, text, jsonb, uuid), public.career_apply_prepare_request_ready(uuid, uuid),
 public.career_apply_card_push_requested_for(uuid, uuid, uuid[], text, timestamptz), public.career_apply_prepare_request_questions(uuid, uuid),
 public.career_apply_questions_push_requested_for(uuid, uuid, uuid[], text, timestamptz), public.career_apply_prepare_request_notice(uuid, uuid, text), public.career_apply_pending_for(uuid), public.career_apply_cancel_for(uuid, text), public.career_apply_prepare_tell(uuid, text, text),
 public.career_apply_cloud_destination_ok(text), public.career_apply_prepare_postings_today(uuid, timestamptz), public.career_apply_never_automated(text),
 public.career_apply_prepare_request_posting(uuid, uuid, text)
 from public, anon, authenticated, service_role;
grant execute on function public.career_apply_cloud_text_cards_enabled(), public.career_apply_url_host(text),
 public.career_apply_cloud_authorize_any(uuid, uuid, text, text), public.career_apply_cloud_dispatch_claim2(integer, integer, integer, integer, integer),
 public.career_apply_cloud_resume_put_for(uuid, text, text), public.career_apply_cloud_resume_kept_for(uuid),
 public.career_apply_prepare_request_put(uuid, text[], integer), public.career_apply_prepare_request_claim(integer, integer, integer, integer),
 public.career_apply_prepare_request_scope(uuid, uuid), public.career_apply_prepare_request_sandbox(uuid, uuid, text),
 public.career_apply_prepare_request_finish(uuid, uuid, text, jsonb, uuid), public.career_apply_prepare_request_ready(uuid, uuid),
 public.career_apply_card_push_requested_for(uuid, uuid, uuid[], text, timestamptz), public.career_apply_prepare_request_questions(uuid, uuid),
 public.career_apply_questions_push_requested_for(uuid, uuid, uuid[], text, timestamptz), public.career_apply_prepare_request_notice(uuid, uuid, text), public.career_apply_pending_for(uuid), public.career_apply_cancel_for(uuid, text),
 public.career_apply_prepare_request_posting(uuid, uuid, text) to service_role;
