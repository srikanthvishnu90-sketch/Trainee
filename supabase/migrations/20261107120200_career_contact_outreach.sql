-- CONTACT OUTREACH (release 9 workstream E; proposal D-042; _shared/career_contact_pipeline.ts). Not applied by this PR: the
-- owner's go-live creates the (empty) tables at the next release (scripts/launch/trainee-go-live.sh lists every migration);
-- nothing reads or writes them while CAREER_PEOPLE_SEARCH and CAREER_CONTACT_OUTREACH are off. Rollback: supabase/rollbacks/20261107120200_career_contact_outreach.down.sql.
--
--   career_contact_profiles        one professional a person asked about: name, title, company, domain, the page that named them
--   career_contact_facts           up to 25 cited professional facts each (claim, source, snippet <= 200, confidence, method), expiring
--   career_contact_email_evidence  the address found, how (method), its 0-100 score, and every check (syntax, MX, provider, catch-all, RCPT)
--   career_contact_suppression     GLOBAL: an address (by SHA-256) nobody's outreach may reach again; read together with the
--                                  rail's opt-outs (career_outreach_dnc) and bounced addresses (career_send_bad_addresses)
--   career_contact_sends           one row per email the connector queued (first or follow-up), for the daily new-contact limit
--                                  and the two-follow-up limit: only the person, the address's SHA-256, the step and the day.
--                                  It is kept when contacts are forgotten (forgetting must never reset either limit); the
--                                  contact link is cleared, and the rows go with the account.
--
-- Row security on, no policies: only the service role reads and writes. Per-person rows go with the account (on delete
-- cascade), with "forget everything" (career_erase_person finds every career_* table with a user_id), with
-- career_contact_forget (one contact or all; the send log stays, unlinked), and when they expire (career_contact_purge_expired). The suppression list
-- has no user_id on purpose: an opt-out outlives the account of whoever wrote to them. Idempotent.

create table if not exists public.career_contact_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 2 and 200),
  title text not null default '' check (length(title) <= 300),
  company text not null check (length(company) between 1 and 200),
  domain text not null check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,24}$'),
  source_url text not null check (length(source_url) <= 2048 and source_url ~ '^https://'),
  source_type text not null check (source_type in ('company_page', 'sec_edgar')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
create index if not exists career_contact_profiles_user on public.career_contact_profiles (user_id, created_at desc);
create index if not exists career_contact_profiles_expiry on public.career_contact_profiles (expires_at);

create table if not exists public.career_contact_facts (
  id bigint generated always as identity primary key,
  contact_id uuid not null references public.career_contact_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  claim text not null check (length(claim) between 3 and 240),
  source_url text not null check (length(source_url) <= 2048 and source_url ~ '^https://'),
  source_type text not null check (source_type in ('company_page', 'personal_page', 'sec_edgar', 'github', 'openalex', 'semantic_scholar', 'uspto', 'conference', 'news')),
  retrieved_at timestamptz not null,
  published_at timestamptz,
  quote_snippet text not null check (length(quote_snippet) <= 200),
  confidence numeric(3, 2) not null check (confidence between 0 and 1),
  method text not null check (length(method) between 1 and 80),
  expires_at timestamptz not null
);
create index if not exists career_contact_facts_contact on public.career_contact_facts (contact_id);
create index if not exists career_contact_facts_user on public.career_contact_facts (user_id);

create table if not exists public.career_contact_email_evidence (
  contact_id uuid primary key references public.career_contact_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text check (email is null or (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254)),
  method text check (method in ('first_party_published', 'github_public', 'pattern_rcpt_valid', 'finder_verified', 'pattern_unverified', 'guess')),
  -- The score is the method's (95, 90, 80, 75, 50, 30) or 0 (an MX or a mail server refused it): never anything in between.
  score int not null check (score = 0 or score = case method when 'first_party_published' then 95 when 'github_public' then 90 when 'pattern_rcpt_valid' then 80
    when 'finder_verified' then 75 when 'pattern_unverified' then 50 when 'guess' then 30 end),
  -- Approvable only at 70+ AND a mail server confirmed for the address's own domain (career_contact_email.ts findEmail).
  approvable boolean generated always as (score >= 70 and mx = 'pass') stored,
  why text not null default '' check (length(why) <= 300),
  syntax text not null check (syntax in ('pass', 'fail')),
  mx text not null check (mx in ('pass', 'fail', 'unknown')),
  provider text not null check (provider in ('google', 'microsoft', 'other', 'none', 'unknown')),
  catch_all boolean,
  rcpt text not null check (rcpt in ('accept', 'reject', 'unknown', 'not_probed')),
  source_url text check (source_url is null or source_url ~ '^https://'),
  format text check (format is null or length(format) <= 20),
  format_evidence int not null default 0 check (format_evidence >= 0),
  checked_at timestamptz not null,
  expires_at timestamptz not null,
  check (email is not null or score = 0)
);
create index if not exists career_contact_email_user on public.career_contact_email_evidence (user_id);

create table if not exists public.career_contact_suppression (
  email_hash text primary key check (email_hash ~ '^[a-f0-9]{64}$'),
  reason text not null default 'asked not to be contacted' check (length(reason) between 1 and 120),
  at timestamptz not null default now()
);

create table if not exists public.career_contact_sends (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references public.career_contact_profiles(id) on delete set null,
  email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
  step int not null check (step between 0 and 2), -- 0 the first email, 1 and 2 the follow-ups (at most two)
  queue_id uuid,
  day date not null,
  at timestamptz not null default now(),
  unique (user_id, email_hash, step)
);
create index if not exists career_contact_sends_day on public.career_contact_sends (user_id, day) where step = 0;

do $$ declare t text; begin
  foreach t in array array['career_contact_profiles', 'career_contact_facts', 'career_contact_email_evidence', 'career_contact_suppression', 'career_contact_sends'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Save one resolved contact (profile, facts, email evidence) in one transaction; returns its id.
create or replace function public.career_contact_save(p jsonb) returns uuid
language plpgsql security invoker set search_path = public, pg_temp as $$
declare u uuid := (p->>'user')::uuid; id_ uuid; e jsonb := p->'email'; exp timestamptz := coalesce((p->>'expires_at')::timestamptz, now() + interval '90 days');
begin
  insert into public.career_contact_profiles(user_id, name, title, company, domain, source_url, source_type, expires_at)
  values (u, p->'person'->>'name', coalesce(p->'person'->>'title', ''), p->'person'->>'company', p->'person'->>'domain', p->'person'->>'source_url', p->'person'->>'source_type', exp)
  returning id into id_;
  insert into public.career_contact_facts(contact_id, user_id, claim, source_url, source_type, retrieved_at, published_at, quote_snippet, confidence, method, expires_at)
  select id_, u, f->>'claim', f->>'source_url', f->>'source_type', (f->>'retrieved_at')::timestamptz, nullif(f->>'published_at', '')::timestamptz, f->>'quote_snippet',
    (f->>'confidence')::numeric, f->>'method', (f->>'expires_at')::timestamptz
  from jsonb_array_elements(coalesce(p->'facts', '[]'::jsonb)) with ordinality as x(f, n) where n <= 25;
  insert into public.career_contact_email_evidence(contact_id, user_id, email, method, score, syntax, mx, provider, catch_all, rcpt, source_url, format, format_evidence, checked_at, expires_at, why)
  values (id_, u, nullif(e->>'email', ''), nullif(e->>'method', ''), (e->>'score')::int, e->>'syntax', e->>'mx', e->>'provider', (e->>'catch_all')::boolean, e->>'rcpt',
    nullif(e->>'source_url', ''), nullif(e->>'format', ''), coalesce((e->>'format_evidence')::int, 0), (e->>'checked_at')::timestamptz, exp, left(coalesce(e->>'why', ''), 300));
  return id_;
end $$;

-- One contact as the person's own (null for anyone else's or an expired one): person, facts, email.
create or replace function public.career_contact_get(p jsonb) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('id', c.id, 'expires_at', c.expires_at,
    'person', jsonb_build_object('name', c.name, 'title', c.title, 'company', c.company, 'domain', c.domain, 'source_url', c.source_url, 'source_type', c.source_type),
    'facts', coalesce((select jsonb_agg(to_jsonb(f) - 'id' - 'contact_id' - 'user_id' order by f.confidence desc, f.id) from public.career_contact_facts f where f.contact_id = c.id and f.expires_at > now()), '[]'::jsonb),
    'email', (select to_jsonb(e) - 'contact_id' - 'user_id' - 'expires_at' from public.career_contact_email_evidence e where e.contact_id = c.id))
  from public.career_contact_profiles c where c.id = (p->>'id')::uuid and c.user_id = (p->>'user')::uuid and c.expires_at > now()
$$;

-- "Forget <contact>" / "forget my contacts": one contact, or all of the person's; returns how many were deleted. The
-- profile, its facts and its email evidence go. The send log does NOT: it is what the daily new-contact limit and the
-- two-follow-up limit count, so forgetting (one contact or all) must never hand back the day's sends or restart a
-- follow-up sequence. Its rows hold no name, address or fact, only the address's SHA-256; the contact link is cleared
-- (on delete set null) and they go with the account.
create or replace function public.career_contact_forget(p jsonb) returns int
language plpgsql security invoker set search_path = public, pg_temp as $$
declare n int; p_user uuid := (p->>'user')::uuid; p_id uuid := nullif(p->>'id', '')::uuid;
begin
  if p_user is null then raise exception 'career_contact_forget: user'; end if;
  update public.career_contact_sends set contact_id = null where user_id = p_user and contact_id is not null and (p_id is null or contact_id = p_id);
  delete from public.career_contact_profiles where user_id = p_user and (p_id is null or id = p_id);
  get diagnostics n = row_count;
  return n;
end $$;

-- Expired contacts (facts and evidence go with them): run by the scheduled sweep.
create or replace function public.career_contact_purge_expired(p jsonb default '{}') returns int
language plpgsql security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  delete from public.career_contact_facts where expires_at <= now();
  delete from public.career_contact_profiles where expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- The hashes among these that nobody may email: the global suppression list, every person's opt-outs, every bounce.
create or replace function public.career_contact_suppressed(p jsonb) returns text[]
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct h), '{}') from jsonb_array_elements_text(coalesce(p->'hashes', '[]'::jsonb)) h
  where exists (select 1 from public.career_contact_suppression s where s.email_hash = h)
     or exists (select 1 from public.career_outreach_dnc d where d.email_hash = h)
     or exists (select 1 from public.career_send_bad_addresses b where b.email_hash = h)
$$;

create or replace function public.career_contact_suppress(p jsonb) returns boolean
language sql security invoker set search_path = public, pg_temp as $$
  insert into public.career_contact_suppression(email_hash, reason) values (p->>'hash', left(coalesce(nullif(p->>'reason', ''), 'asked not to be contacted'), 120))
  on conflict (email_hash) do nothing;
  select true
$$;

-- The daily new-contact limit: record a queued email (step 0 counts toward the day), refused once the day is full.
create or replace function public.career_contact_record_send(p jsonb) returns text
language plpgsql security invoker set search_path = public, pg_temp as $$
declare u uuid := (p->>'user')::uuid; d date := (p->>'day')::date; cap int := greatest(0, coalesce((p->>'cap')::int, 20)); st int := coalesce((p->>'step')::int, 0);
begin
  perform pg_advisory_xact_lock(hashtextextended('career_contact_sends:' || u::text, 0));
  if st = 0 and (select count(*) from public.career_contact_sends where user_id = u and day = d and step = 0) >= cap then return 'daily_limit'; end if;
  insert into public.career_contact_sends(user_id, contact_id, email_hash, step, queue_id, day)
  values (u, nullif(p->>'contact', '')::uuid, p->>'email_hash', st, nullif(p->>'queue_id', '')::uuid, d)
  on conflict (user_id, email_hash, step) do nothing;
  return case when found then 'recorded' else 'already_recorded' end;
end $$;

do $$ declare f text; begin
  foreach f in array array['career_contact_save(jsonb)', 'career_contact_get(jsonb)', 'career_contact_forget(jsonb)', 'career_contact_purge_expired(jsonb)',
    'career_contact_suppressed(jsonb)', 'career_contact_suppress(jsonb)', 'career_contact_record_send(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
