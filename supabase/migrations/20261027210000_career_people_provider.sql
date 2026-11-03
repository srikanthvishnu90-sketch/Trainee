-- PEOPLE DISCOVERY AT SCALE (D-MN-3 as REPLACED by the owner, 2026-10-27 21:32: "don't use Hunter or Apollo ... so we can do
-- it with anyone"). No paid people/email provider. People are found the way a research agent finds them: web search
-- through the model gateway (OpenAI's web_search tool), then the public pages themselves, read with N1's SSRF-guarded page
-- reader. Code: supabase/functions/_shared/career_people_provider.ts. Docs: docs/architect/PEOPLE-PROVIDER-2026-10-27.md.
-- Everything lands in the same career_people store as the person's own sources (20261027010000_career_people.sql).
--
--   career_people (extended)     source 'provider' (provider 'web'): provider_id, domain, email_status (published |
--                                inferred | bounced | none), email_evidence, email_confidence, mx, sendable, fetched_at,
--                                profile_text, same_as. Every provider row keeps the https source_url of the page that
--                                names the person and their employer; no page, no person (a check holds it).
--   career_provider_cache        one discovery (provider + normalized query: company, roles) shared by EVERY person
--   career_provider_people       what it found (rows, not a blob). Holds no user id. Only published addresses.
--   career_provider_jobs         the discovery queue: one active job per query however many people asked; FOR UPDATE SKIP
--                                LOCKED leases, expired leases reclaimed, fair across people by virtual rank.
--   career_provider_waiters      who waits for an active job; on completion each gets their own deduped copy.
--   career_provider_state        blocked_until, set only when the outside service REFUSED (429, quota): shared by every
--                                instance. Trainee sets no volume limit of its own (owner, 2026-10-27 19:55).
--   career_provider_lookups      every discovery, searched or cached: search calls, pages read, results, model cost.
--   career_email_formats         per domain, the address formats (first.last, flast, ...) learned from published and
--                                known addresses, with evidence (distinct addresses), replies and bounces: shared across
--                                everyone, FORMATS ONLY (never an address, a name or a contact).
--   career_email_format_evidence one vote per address per domain, as a sha256 of the address (no address kept).
--   career_email_domains         per domain, whether it publishes a mail server (MX over DNS-over-HTTPS; no SMTP probing).
--   career_email_bad             addresses that bounced, as sha256: never inferred or sent to again.
--
-- An address on a provider row is, in order of strength: published (on the page that names them), or inferred (from the
-- domain's format, learned from 2+ addresses at that exact domain, with the evidence count). A person's own address for
-- someone (their Gmail or export) is "known": that row is theirs and the provider row is not stored again. sendable =
-- an address, the domain's MX present, never bounced; inferred ones are sent only after the person approves that exact
-- address (the outreach card labels it).
-- Visibility: every table here is service-role only. Erase: "forget everything" deletes the person's provider rows, waits
-- and their user id on the ledger; the shared formats stay (no person in them). Idempotent.

-- ---------------------------------------------------------------------------------------------- career_people, extended
alter table public.career_people drop constraint if exists career_people_source_check;
alter table public.career_people add constraint career_people_source_check check (source in ('linkedin_export', 'gmail', 'company_page', 'provider'));
alter table public.career_people add column if not exists provider text check (provider is null or provider = 'web');
alter table public.career_people add column if not exists provider_id text check (provider_id is null or length(provider_id) between 1 and 300);
alter table public.career_people add column if not exists domain text check (domain is null or (length(domain) <= 253 and domain = lower(domain)));
alter table public.career_people add column if not exists email_status text check (email_status is null or email_status in ('published', 'inferred', 'bounced', 'none'));
alter table public.career_people add column if not exists email_evidence int check (email_evidence is null or email_evidence >= 0);
alter table public.career_people add column if not exists email_confidence int check (email_confidence is null or email_confidence between 0 and 100);
alter table public.career_people add column if not exists mx text check (mx is null or mx in ('pass', 'fail', 'not_run'));
alter table public.career_people add column if not exists sendable boolean not null default false;
alter table public.career_people add column if not exists fetched_at timestamptz;
-- A link to a site Trainee never opens (a LinkedIn profile a search result pointed to): kept as text only, never fetched.
alter table public.career_people add column if not exists profile_text text check (profile_text is null or length(profile_text) <= 600);
-- The person's own row this provider row is the same person as (a published address found for a contact who had none).
alter table public.career_people add column if not exists same_as bigint references public.career_people(id) on delete set null;
-- Its foreign key needs this index: without it every deleted row (an erase, a person's own delete) scans the whole table
-- for rows linked to it (CI: a million-row cleanup that never finished).
create index if not exists career_people_same_as_idx on public.career_people (same_as) where same_as is not null;
alter table public.career_people drop constraint if exists career_people_provider_shape;
alter table public.career_people add constraint career_people_provider_shape check (
  (source = 'provider') = (provider is not null and provider_id is not null and fetched_at is not null)
  and (source <> 'provider' or (source_url is not null and name is not null)));
alter table public.career_people drop constraint if exists career_people_sendable_verified;
alter table public.career_people add constraint career_people_sendable_verified check (
  not sendable or (source = 'provider' and email is not null and email_status in ('published', 'inferred') and mx = 'pass'));
alter table public.career_people_imports drop constraint if exists career_people_imports_source_check;
alter table public.career_people_imports add constraint career_people_imports_source_check check (source in ('linkedin_export', 'gmail', 'company_page', 'provider'));

-- The one name normalization both sides of a dedupe use (lower, apostrophes dropped, & as "and", punctuation and
-- whitespace runs to one space): "Alex O'Brien" and "alex  obrien" at the same firm are one person. Plain SQL with no
-- SET clause, so the planner can inline it into the expression index below.
create or replace function public.career_people_name_key(p_name text, p_company_key text)
returns text language sql immutable parallel safe as $$
  select case when p_name is null or btrim(p_name) = '' then null
    else btrim(pg_catalog.regexp_replace(pg_catalog.replace(pg_catalog.translate(pg_catalog.lower(p_name), '''’', ''), '&', ' and '), '[[:space:][:punct:]]+', ' ', 'g')) || '|' || coalesce(p_company_key, '') end
$$;
revoke all on function public.career_people_name_key(text, text) from public, anon, authenticated;
grant execute on function public.career_people_name_key(text, text) to service_role;
-- Indexed dedupe lookups (load-tested at 1M rows: tests/db/career_people_provider_scale.py).
create index if not exists career_people_user_email on public.career_people (user_id, email) where email is not null;
create index if not exists career_people_user_name_key on public.career_people (user_id, public.career_people_name_key(name, company_key)) where name is not null;
create index if not exists career_people_provider_company on public.career_people (user_id, company_key, id) where source = 'provider';
create index if not exists career_people_email_all on public.career_people (email) where email is not null and source = 'provider';

-- ---------------------------------------------------------------------------------------------- email formats (shared)
create table if not exists public.career_email_formats (
  domain text not null check (length(domain) between 3 and 253 and domain = lower(domain)),
  format text not null check (format in ('first.last', 'firstlast', 'flast', 'f.last', 'first', 'last', 'first_last', 'first-last', 'firstl', 'last.first', 'lastf')),
  evidence int not null default 0 check (evidence >= 0),
  replies int not null default 0 check (replies >= 0),
  bounces int not null default 0 check (bounces >= 0),
  updated_at timestamptz not null default now(),
  primary key (domain, format)
);
create table if not exists public.career_email_format_evidence (
  domain text not null,
  addr_hash text not null check (addr_hash ~ '^[a-f0-9]{64}$'),
  format text not null,
  created_at timestamptz not null default now(),
  primary key (domain, addr_hash)
);
create table if not exists public.career_email_domains (
  domain text primary key check (length(domain) between 3 and 253 and domain = lower(domain)),
  mx text not null check (mx in ('pass', 'fail', 'not_run')),
  checked_at timestamptz not null default now()
);
create table if not exists public.career_email_bad (
  addr_hash text primary key check (addr_hash ~ '^[a-f0-9]{64}$'),
  reason text not null check (reason in ('bounce', 'hard_failure')),
  created_at timestamptz not null default now()
);

create or replace function public.career_email_hash(p_email text)
returns text language sql immutable parallel safe as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(pg_catalog.btrim(p_email)), 'UTF8')), 'hex')
$$;
revoke all on function public.career_email_hash(text) from public, anon, authenticated;
grant execute on function public.career_email_hash(text) to service_role;

-- A local part from a name and a format; null when the name isn't plain ASCII letters (never a transliteration guess) or
-- the format needs a last name the name doesn't have.
create or replace function public.career_email_local(p_format text, p_name text)
returns text language plpgsql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
declare parts text[]; f text; l text;
begin
  if p_name is null or p_name !~ '^[A-Za-z][A-Za-z .''-]*$' then return null; end if;
  parts := regexp_split_to_array(btrim(regexp_replace(replace(replace(lower(p_name), '''', ''), '-', ''), '\s+', ' ', 'g')), ' ');
  f := regexp_replace(parts[1], '[^a-z]', '', 'g');
  l := regexp_replace(parts[array_length(parts, 1)], '[^a-z]', '', 'g');
  if f = '' then return null; end if;
  if array_length(parts, 1) < 2 or l = '' then
    return case when p_format = 'first' then f else null end;
  end if;
  return case p_format
    when 'first.last' then f || '.' || l when 'firstlast' then f || l when 'flast' then left(f, 1) || l when 'f.last' then left(f, 1) || '.' || l
    when 'first' then f when 'last' then l when 'first_last' then f || '_' || l when 'first-last' then f || '-' || l
    when 'firstl' then f || left(l, 1) when 'last.first' then l || '.' || f when 'lastf' then l || left(f, 1) end;
end $$;
revoke all on function public.career_email_local(text, text) from public, anon, authenticated;
grant execute on function public.career_email_local(text, text) to service_role;

-- Which format a named address follows (the most specific one that matches), or null.
create or replace function public.career_email_format_of(p_name text, p_email text)
returns text language sql immutable parallel safe set search_path = public, pg_temp as $$
  select f from unnest(array['first.last', 'f.last', 'first_last', 'first-last', 'last.first', 'firstlast', 'flast', 'lastf', 'firstl', 'first', 'last']) with ordinality x(f, o)
  where career_email_local(f, p_name) = split_part(lower(p_email), '@', 1) order by o limit 1
$$;
revoke all on function public.career_email_format_of(text, text) from public, anon, authenticated;
grant execute on function public.career_email_format_of(text, text) to service_role;

-- Learn one named address at a domain: one vote per address, ever (the hash), for the format it follows.
create or replace function public.career_email_learn(p_name text, p_email text)
returns text language plpgsql security invoker set search_path = public, pg_temp as $$
declare d text := lower(split_part(p_email, '@', 2)); f text := career_email_format_of(p_name, p_email); n int;
begin
  if f is null or d = '' or d !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then return null; end if;
  insert into career_email_format_evidence (domain, addr_hash, format) values (d, career_email_hash(p_email), f) on conflict do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    insert into career_email_formats (domain, format, evidence) values (d, f, 1)
    on conflict (domain, format) do update set evidence = career_email_formats.evidence + 1, updated_at = now();
  end if;
  return f;
end $$;
revoke all on function public.career_email_learn(text, text) from public, anon, authenticated;
grant execute on function public.career_email_learn(text, text) to service_role;

-- The domain's best format: 2+ distinct addresses of evidence; confidence from evidence, replies and bounces.
create or replace function public.career_email_best_format(p_domain text)
returns table (format text, evidence int, confidence int) language sql stable set search_path = public, pg_temp as $$
  select f.format, f.evidence, least(99, round(100.0 * (f.evidence + 2 * f.replies) / (f.evidence + 2 * f.replies + 3 * f.bounces + 1)))::int
  from career_email_formats f where f.domain = lower(p_domain) and f.evidence >= 2
  order by 3 desc, f.evidence desc, f.format limit 1
$$;
revoke all on function public.career_email_best_format(text) from public, anon, authenticated;
grant execute on function public.career_email_best_format(text) to service_role;

-- What happened to a sent address. bounce: the address is bad forever (hash), every stored copy stops being sendable, and
-- if it was an inferred address its domain format loses confidence. reply: a confirmed address, its format gains.
create or replace function public.career_email_feedback(p_email text, p_name text, p_outcome text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare d text := lower(split_part(p_email, '@', 2)); f text := career_email_format_of(p_name, p_email); n int := 0;
begin
  if p_outcome not in ('bounce', 'reply') or p_email is null then raise exception 'invalid email feedback'; end if;
  if p_outcome = 'bounce' then
    insert into career_email_bad (addr_hash, reason) values (career_email_hash(p_email), 'bounce') on conflict do nothing;
    update career_people set sendable = false, email_status = 'bounced' where email = lower(btrim(p_email)) and source = 'provider';
    get diagnostics n = row_count;
    if f is not null then update career_email_formats set bounces = bounces + 1, updated_at = now() where domain = d and format = f; end if;
  else
    if f is not null then
      perform career_email_learn(p_name, p_email);
      update career_email_formats set replies = replies + 1, updated_at = now() where domain = d and format = f;
    end if;
  end if;
  return jsonb_build_object('format', f, 'rows_marked', n);
end $$;
revoke all on function public.career_email_feedback(text, text, text) from public, anon, authenticated;
grant execute on function public.career_email_feedback(text, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------- the shared cache
create table if not exists public.career_provider_cache (
  id bigint generated always as identity primary key,
  provider text not null check (provider = 'web'),
  query_key text not null check (length(query_key) between 1 and 600),
  company text not null default '' check (length(company) <= 200),
  company_key text not null default '' check (length(company_key) <= 200),
  domain text check (domain is null or length(domain) <= 253),
  results int not null default 0 check (results >= 0),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (provider, query_key)
);
create table if not exists public.career_provider_people (
  id bigint generated always as identity primary key,
  cache_id bigint not null references public.career_provider_cache(id) on delete cascade,
  provider text not null check (provider = 'web'),
  provider_id text not null check (length(provider_id) between 1 and 300),
  name text not null check (length(name) between 1 and 200),
  email text check (email is null or (length(email) between 3 and 254 and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  company text not null default '' check (length(company) <= 200),
  company_key text not null default '' check (length(company_key) <= 200),
  domain text check (domain is null or length(domain) <= 253),
  position text not null default '' check (length(position) <= 300),
  source_ref text not null check (length(source_ref) between 1 and 600),
  source_url text not null check (length(source_url) <= 2048 and source_url ~ '^https://'),
  profile_text text check (profile_text is null or length(profile_text) <= 600),
  unique (cache_id, provider_id)
);
create index if not exists career_provider_people_cache on public.career_provider_people (cache_id, id);

-- ---------------------------------------------------------------------------------------------- the queue
create table if not exists public.career_provider_jobs (
  id bigint generated always as identity primary key,
  provider text not null check (provider = 'web'),
  query_key text not null check (length(query_key) between 1 and 600),
  query jsonb not null check (jsonb_typeof(query) = 'object' and octet_length(query::text) <= 8192),
  cache_seconds int not null check (cache_seconds >= 0),
  vrank bigint not null default 0,
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed')),
  not_before timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  attempts int not null default 0 check (attempts >= 0),
  outcome text check (outcome is null or length(outcome) <= 300),
  cache_id bigint references public.career_provider_cache(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'running' or (lease_token is not null and lease_until is not null))
);
create unique index if not exists career_provider_jobs_active on public.career_provider_jobs (provider, query_key) where state in ('queued', 'running');
create index if not exists career_provider_jobs_claim on public.career_provider_jobs (vrank, id) where state = 'queued';
create index if not exists career_provider_jobs_lease on public.career_provider_jobs (lease_until) where state = 'running';
create table if not exists public.career_provider_waiters (
  job_id bigint not null references public.career_provider_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (job_id, user_id)
);
create index if not exists career_provider_waiters_user on public.career_provider_waiters (user_id, job_id);
create table if not exists public.career_provider_user_clock (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_rank bigint not null default 0
);
create table if not exists public.career_provider_state (
  provider text primary key check (provider = 'web'),
  blocked_until timestamptz,
  reason text check (reason is null or reason in ('rate_limited', 'out_of_credits')),
  detail text check (detail is null or length(detail) <= 300),
  updated_at timestamptz not null default now()
);
create table if not exists public.career_provider_lookups (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  provider text not null check (provider = 'web'),
  query_key text check (query_key is null or length(query_key) <= 600),
  company text not null default '' check (length(company) <= 200),
  kind text not null check (kind in ('api', 'cache')),
  http_calls int not null default 0 check (http_calls >= 0),
  results int not null default 0 check (results >= 0),
  cost_usd numeric check (cost_usd is null or cost_usd >= 0),
  waiters int not null default 0 check (waiters >= 0),
  outcome text not null check (length(outcome) between 1 and 300),
  created_at timestamptz not null default now()
);
create index if not exists career_provider_lookups_time on public.career_provider_lookups (created_at, provider);
create index if not exists career_provider_lookups_user on public.career_provider_lookups (user_id) where user_id is not null;

alter table public.career_provider_cache enable row level security;
alter table public.career_provider_people enable row level security;
alter table public.career_provider_jobs enable row level security;
alter table public.career_provider_waiters enable row level security;
alter table public.career_provider_user_clock enable row level security;
alter table public.career_provider_state enable row level security;
alter table public.career_provider_lookups enable row level security;
alter table public.career_email_formats enable row level security;
alter table public.career_email_format_evidence enable row level security;
alter table public.career_email_domains enable row level security;
alter table public.career_email_bad enable row level security;
revoke all on public.career_provider_cache, public.career_provider_people, public.career_provider_jobs, public.career_provider_waiters,
  public.career_provider_user_clock, public.career_provider_state, public.career_provider_lookups,
  public.career_email_formats, public.career_email_format_evidence, public.career_email_domains, public.career_email_bad from public, anon, authenticated;
grant all on public.career_provider_cache, public.career_provider_people, public.career_provider_jobs, public.career_provider_waiters,
  public.career_provider_user_clock, public.career_provider_state, public.career_provider_lookups,
  public.career_email_formats, public.career_email_format_evidence, public.career_email_domains, public.career_email_bad to service_role;

-- ---------------------------------------------------------------------------------------------- deliver (copy, deduped)
-- One cache entry's people into one person's career_people, in one statement, under the person's people lock.
-- The address: the published one, else one inferred from the domain's best format (2+ evidence), never a bounced one.
-- Against everything the person already has:
--   same address (any source)                                  -> already known (their own address is "known")
--   same name at the same firm, and that row has an address    -> already known
--   same name at the same firm without an address, and an address here -> kept, linked (same_as) to their row
--   the same discovered person from an earlier discovery       -> refreshed in place (address, status, MX, sendable)
--   otherwise                                                  -> a new provider row
-- The person's own addresses at that firm's domain are learned as format evidence first (formats only, shared).
create or replace function public.career_provider_deliver(p_user uuid, p_cache bigint)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare out jsonb; c record;
begin
  if p_user is null or p_cache is null then raise exception 'invalid provider delivery'; end if;
  perform pg_advisory_xact_lock(hashtextextended('career_people:' || p_user::text, 0));
  select * into c from career_provider_cache where id = p_cache;
  if c.domain is not null then
    perform career_email_learn(x.name, x.email) from career_people x
    where x.user_id = p_user and x.company_key = c.company_key and x.source <> 'provider' and x.name is not null and x.email like '%@' || c.domain;
  end if;
  with src0 as (
    select pp.*, 'p:' || pp.provider || ':' || pp.provider_id as dkey, c.fetched_at as c_fetched,
           bf.format as bf_format, bf.evidence as bf_evidence, bf.confidence as bf_confidence,
           coalesce((select d.mx from career_email_domains d where d.domain = pp.domain), 'not_run') as dmx
    from career_provider_people pp
    left join lateral career_email_best_format(pp.domain) bf on pp.email is null and pp.domain is not null
    where pp.cache_id = p_cache
  ), src1 as (
    select s.*,
           coalesce(s.email, case when s.bf_format is not null and career_email_local(s.bf_format, s.name) is not null then career_email_local(s.bf_format, s.name) || '@' || s.domain end) as eff_email
    from src0 s
  ), src as (
    select distinct on (coalesce(s.eff_email, 'id:' || s.provider_id)) s.*,
           case when s.email is not null then 'published' when s.eff_email is not null then 'inferred' else 'none' end as basis,
           (s.eff_email is not null and exists (select 1 from career_email_bad b where b.addr_hash = career_email_hash(s.eff_email))) as bad
    from src1 s order by coalesce(s.eff_email, 'id:' || s.provider_id), s.id
  ), src2 as (
    select s.*, case when s.bad then null else s.eff_email end as e,
           case when s.bad then 'bounced' else s.basis end as status,
           (not s.bad and s.eff_email is not null and s.dmx = 'pass' and split_part(s.eff_email, '@', 2) = coalesce(s.domain, split_part(s.eff_email, '@', 2))) as can_send
    from src s
  ), up as (
    update career_people cp set email = s.e, email_status = s.status, email_evidence = case when s.status = 'inferred' then s.bf_evidence end,
           email_confidence = case when s.status = 'inferred' then s.bf_confidence end, mx = s.dmx, sendable = s.can_send,
           position = s.position, fetched_at = s.c_fetched, retrieved_at = now(), source_ref = s.source_ref, source_url = s.source_url, profile_text = s.profile_text
    from src2 s where cp.user_id = p_user and cp.source = 'provider' and cp.dedupe_key = s.dkey
    returning cp.id
  ), m as (
    select s.*, n.id as n_id, n.email as n_email,
           (s.e is not null and exists (select 1 from career_people x where x.user_id = p_user and x.email = s.e)) as known_email
    from src2 s
    left join lateral (
      select x.id, x.email from career_people x
      where x.user_id = p_user and x.name is not null and career_people_name_key(x.name, x.company_key) = career_people_name_key(s.name, s.company_key)
        and x.dedupe_key <> s.dkey
      order by (x.source = 'provider'), x.id limit 1) n on true
    where not exists (select 1 from career_people p where p.user_id = p_user and p.source = 'provider' and p.dedupe_key = s.dkey)
  ), ins as (
    insert into career_people (user_id, source, name, email, company, company_key, position, source_ref, source_url, dedupe_key, provider, provider_id, domain,
                               email_status, email_evidence, email_confidence, mx, sendable, fetched_at, profile_text, same_as)
    select p_user, 'provider', m.name, m.e, m.company, m.company_key, m.position, m.source_ref, m.source_url, m.dkey, m.provider, m.provider_id, m.domain,
           m.status, case when m.status = 'inferred' then m.bf_evidence end, case when m.status = 'inferred' then m.bf_confidence end, m.dmx, m.can_send,
           m.c_fetched, m.profile_text, m.n_id
    from m
    where not m.known_email and not (m.n_id is not null and (m.n_email is not null or m.e is null))
    on conflict (user_id, source, dedupe_key) do nothing
    returning same_as, email_status
  )
  select jsonb_build_object('inserted', (select count(*) from ins), 'refreshed', (select count(*) from up),
    'already_known', (select count(*) from m) - (select count(*) from ins), 'linked', (select count(*) from ins where same_as is not null),
    'inferred', (select count(*) from ins where email_status = 'inferred')) into out;
  return out;
end $$;
revoke all on function public.career_provider_deliver(uuid, bigint) from public, anon, authenticated;
grant execute on function public.career_provider_deliver(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------------------------------- request
-- A person asks for one discovery. A fresh cache entry (anyone's inside its window): delivered now, recorded as a cache
-- lookup, no search. Otherwise the person waits on the one active job for that query (made if none), ranked fairly:
-- max(their own last rank + 1, the lowest rank still queued).
create or replace function public.career_provider_request(p_user uuid, p_provider text, p_query_key text, p_query jsonb, p_cache_seconds int)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare c record; j bigint; rank bigint; floor_rank bigint; d jsonb;
begin
  if p_user is null or p_provider is distinct from 'web' or p_query_key is null or length(p_query_key) not between 1 and 600
     or jsonb_typeof(p_query) is distinct from 'object' or p_cache_seconds is null or p_cache_seconds < 0 then
    raise exception 'invalid provider request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('career_provider:' || p_provider || ':' || p_query_key, 0));
  select * into c from career_provider_cache where provider = p_provider and query_key = p_query_key and expires_at > now();
  if c.id is not null then
    d := career_provider_deliver(p_user, c.id);
    insert into career_provider_lookups (user_id, provider, query_key, company, kind, results, outcome)
    values (p_user, p_provider, p_query_key, c.company, 'cache', c.results, 'cache hit');
    return jsonb_build_object('state', 'cached', 'cache_id', c.id, 'company_key', c.company_key, 'fetched_at', c.fetched_at) || d;
  end if;
  select id into j from career_provider_jobs where provider = p_provider and query_key = p_query_key and state in ('queued', 'running');
  if j is null then
    select min(vrank) into floor_rank from career_provider_jobs where state = 'queued';
    insert into career_provider_user_clock (user_id, last_rank) values (p_user, 0) on conflict (user_id) do nothing;
    select greatest(last_rank + 1, coalesce(floor_rank, 0)) into rank from career_provider_user_clock where user_id = p_user for update;
    update career_provider_user_clock set last_rank = rank where user_id = p_user;
    insert into career_provider_jobs (provider, query_key, query, cache_seconds, vrank) values (p_provider, p_query_key, p_query, p_cache_seconds, rank)
    returning id into j;
  end if;
  insert into career_provider_waiters (job_id, user_id) values (j, p_user) on conflict do nothing;
  return jsonb_build_object('state', 'queued', 'job_id', j);
end $$;
revoke all on function public.career_provider_request(uuid, text, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.career_provider_request(uuid, text, text, jsonb, int) to service_role;

-- ---------------------------------------------------------------------------------------------- claim / reclaim
-- Up to p_n queued jobs (one worker's batch size, not a volume limit: the next call takes more), lowest rank first,
-- skipping rows another worker holds and a service that refused (blocked_until in the future). p_user: only jobs that
-- person waits on (the chat turn runs its own asks first; the scheduled drain passes null).
create or replace function public.career_provider_claim(p_n int, p_lease_seconds int, p_user uuid default null)
returns setof public.career_provider_jobs language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_n is null or p_n < 1 or p_lease_seconds is null or p_lease_seconds < 1 then raise exception 'invalid provider claim'; end if;
  return query
  with pick as (
    select j.id from career_provider_jobs j
    where j.state = 'queued' and j.not_before <= now()
      and not exists (select 1 from career_provider_state s where s.provider = j.provider and s.blocked_until > now())
      and (p_user is null or exists (select 1 from career_provider_waiters w where w.job_id = j.id and w.user_id = p_user))
    order by j.vrank, j.id
    limit p_n
    for update of j skip locked
  )
  update career_provider_jobs j set state = 'running', lease_token = gen_random_uuid(), lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1, updated_at = now()
  from pick where j.id = pick.id
  returning j.*;
end $$;
revoke all on function public.career_provider_claim(int, int, uuid) from public, anon, authenticated;
grant execute on function public.career_provider_claim(int, int, uuid) to service_role;

create or replace function public.career_provider_reclaim()
returns int language plpgsql security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  with x as (select id from career_provider_jobs where state = 'running' and lease_until < now() for update skip locked)
  update career_provider_jobs j set state = 'queued', lease_token = null, lease_until = null, updated_at = now() from x where j.id = x.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.career_provider_reclaim() from public, anon, authenticated;
grant execute on function public.career_provider_reclaim() to service_role;

-- ---------------------------------------------------------------------------------------------- complete
-- The discovery's people into the shared cache (replacing that query's earlier rows), the domain's MX, the published
-- addresses learned as format evidence, the job done, every waiter's copy made, one row on the ledger. Only the lease
-- holder completes it (exactly once): a stale or wrong lease changes nothing.
create or replace function public.career_provider_complete(p_job bigint, p_lease uuid, p_company text, p_company_key text, p_domain text, p_mx text,
  p_people jsonb, p_http_calls int, p_cost_usd numeric)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare j career_provider_jobs; cid bigint; n int; w record; out jsonb := '[]'::jsonb; d jsonb; nw int; dom text := nullif(lower(btrim(coalesce(p_domain, ''))), '');
begin
  if jsonb_typeof(p_people) is distinct from 'array' or p_job is null or p_lease is null or coalesce(p_mx, 'not_run') not in ('pass', 'fail', 'not_run') then
    raise exception 'invalid provider completion';
  end if;
  select * into j from career_provider_jobs where id = p_job;
  if j.id is null then return jsonb_build_object('state', 'lost_lease'); end if;
  perform pg_advisory_xact_lock(hashtextextended('career_provider:' || j.provider || ':' || j.query_key, 0));
  select * into j from career_provider_jobs where id = p_job and state = 'running' and lease_token = p_lease for update;
  if j.id is null then return jsonb_build_object('state', 'lost_lease'); end if;
  if dom is not null and p_mx is not null and p_mx <> 'not_run' then
    insert into career_email_domains (domain, mx, checked_at) values (dom, p_mx, now())
    on conflict (domain) do update set mx = excluded.mx, checked_at = now();
  end if;
  insert into career_provider_cache (provider, query_key, company, company_key, domain, results, fetched_at, expires_at)
  values (j.provider, j.query_key, coalesce(p_company, ''), coalesce(p_company_key, ''), dom, jsonb_array_length(p_people), now(), now() + make_interval(secs => j.cache_seconds))
  on conflict (provider, query_key) do update set company = excluded.company, company_key = excluded.company_key, domain = excluded.domain, results = excluded.results,
     fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
  returning id into cid;
  delete from career_provider_people where cache_id = cid;
  insert into career_provider_people (cache_id, provider, provider_id, name, email, company, company_key, domain, position, source_ref, source_url, profile_text)
  select cid, j.provider, r->>'provider_id', r->>'name', nullif(r->>'email', ''), coalesce(r->>'company', ''), coalesce(r->>'company_key', ''), dom,
         coalesce(r->>'position', ''), r->>'source_ref', r->>'source_url', nullif(r->>'profile_text', '')
  from jsonb_array_elements(p_people) r
  on conflict (cache_id, provider_id) do nothing;
  get diagnostics n = row_count;
  -- every published, named address at the domain is format evidence (formats only)
  perform career_email_learn(name, email) from career_provider_people where cache_id = cid and email is not null and dom is not null and email like '%@' || dom;
  update career_provider_cache set results = n where id = cid;
  update career_provider_jobs set state = 'done', cache_id = cid, outcome = 'found ' || n, lease_token = null, lease_until = null, updated_at = now() where id = j.id;
  select count(*) into nw from career_provider_waiters where job_id = j.id;
  insert into career_provider_lookups (provider, query_key, company, kind, http_calls, results, cost_usd, waiters, outcome)
  values (j.provider, j.query_key, coalesce(p_company, ''), 'api', greatest(coalesce(p_http_calls, 0), 0), n, p_cost_usd, nw, 'found ' || n);
  for w in select user_id from career_provider_waiters where job_id = j.id order by created_at loop
    d := career_provider_deliver(w.user_id, cid);
    out := out || jsonb_build_array(jsonb_build_object('user_id', w.user_id) || d);
  end loop;
  delete from career_provider_waiters where job_id = j.id;
  return jsonb_build_object('state', 'done', 'cache_id', cid, 'results', n, 'delivered', out);
end $$;
revoke all on function public.career_provider_complete(bigint, uuid, text, text, text, text, jsonb, int, numeric) from public, anon, authenticated;
grant execute on function public.career_provider_complete(bigint, uuid, text, text, text, text, jsonb, int, numeric) to service_role;

-- The outside service refused or failed. rate_limited / out_of_credits: blocked for every instance until the time it gave
-- (the job back in the queue, same rank, no attempt spent). error: retried after p_retry_seconds; failed after p_fail_after
-- attempts (said to its waiters). not_wired: failed at once (nothing to call).
create or replace function public.career_provider_fail(p_job bigint, p_lease uuid, p_kind text, p_detail text, p_retry_seconds int, p_http_calls int, p_fail_after int)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare j career_provider_jobs; final boolean;
begin
  if p_kind not in ('rate_limited', 'out_of_credits', 'error', 'not_wired') then raise exception 'invalid provider failure'; end if;
  select * into j from career_provider_jobs where id = p_job and state = 'running' and lease_token = p_lease for update;
  if j.id is null then return jsonb_build_object('state', 'lost_lease'); end if;
  if p_kind in ('rate_limited', 'out_of_credits') then
    insert into career_provider_state (provider, blocked_until, reason, detail, updated_at)
    values (j.provider, now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 60), 1)), p_kind, left(p_detail, 300), now())
    on conflict (provider) do update set blocked_until = greatest(coalesce(career_provider_state.blocked_until, now()), excluded.blocked_until),
       reason = excluded.reason, detail = excluded.detail, updated_at = now();
    update career_provider_jobs set state = 'queued', attempts = greatest(attempts - 1, 0), lease_token = null, lease_until = null,
       not_before = now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 60), 1)), outcome = p_kind, updated_at = now() where id = j.id;
    final := false;
  else
    final := p_kind = 'not_wired' or j.attempts >= greatest(coalesce(p_fail_after, 1), 1);
    update career_provider_jobs set state = case when final then 'failed' else 'queued' end, lease_token = null, lease_until = null,
       not_before = now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 1), 1)), outcome = left(p_kind || ': ' || coalesce(p_detail, ''), 300), updated_at = now() where id = j.id;
  end if;
  insert into career_provider_lookups (provider, query_key, kind, http_calls, results, waiters, outcome)
  values (j.provider, j.query_key, 'api', greatest(coalesce(p_http_calls, 0), 0), 0, (select count(*) from career_provider_waiters where job_id = j.id), left(p_kind || coalesce(': ' || p_detail, ''), 300));
  return jsonb_build_object('state', case when final then 'failed' else 'queued' end);
end $$;
revoke all on function public.career_provider_fail(bigint, uuid, text, text, int, int, int) from public, anon, authenticated;
grant execute on function public.career_provider_fail(bigint, uuid, text, text, int, int, int) to service_role;

-- ---------------------------------------------------------------------------------------------- reads
create or replace function public.career_provider_status(p_user uuid, p_provider text)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'waiting', (select count(*) from career_provider_waiters w join career_provider_jobs j on j.id = w.job_id where w.user_id = p_user and j.state in ('queued', 'running')),
    'failed', (select coalesce(jsonb_agg(jsonb_build_object('job_id', j.id, 'outcome', j.outcome)), '[]'::jsonb) from career_provider_waiters w join career_provider_jobs j on j.id = w.job_id where w.user_id = p_user and j.state = 'failed'),
    'blocked_until', (select blocked_until from career_provider_state where provider = p_provider and blocked_until > now()),
    'blocked_reason', (select reason from career_provider_state where provider = p_provider and blocked_until > now()))
$$;
revoke all on function public.career_provider_status(uuid, text) from public, anon, authenticated;
grant execute on function public.career_provider_status(uuid, text) to service_role;

-- A person's people at these firms, provider rows and their own, one keyset page at a time (indexed, bounded per call).
create or replace function public.career_provider_candidates(p_user uuid, p_keys text[], p_after bigint, p_page int)
returns setof jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select to_jsonb(x) from (
    select p.id, p.source, p.name, p.email, p.company, p.company_key, p.position, p.school, p.source_ref, p.source_url, p.provider, p.provider_id, p.domain,
           p.email_status, p.email_evidence, p.email_confidence, p.mx, p.sendable, p.fetched_at, p.same_as, p.connected_on, p.profile_text
    from career_people p
    where p.user_id = p_user and p.company_key = any(p_keys) and p.id > coalesce(p_after, 0)
    order by p.id limit greatest(least(coalesce(p_page, 500), 5000), 1)) x
$$;
revoke all on function public.career_provider_candidates(uuid, text[], bigint, int) from public, anon, authenticated;
grant execute on function public.career_provider_candidates(uuid, text[], bigint, int) to service_role;

-- "Every company I applied to": the firms on the person's applications (career_apply_jobs, the ones that went out or are
-- going) and on their tracker (the account record's memory.tracker.rows[].company). Names only; none invented.
create or replace function public.career_provider_applied_companies(p_user uuid)
returns setof text language sql stable security invoker set search_path = public, pg_temp as $$
  select distinct on (lower(btrim(c))) btrim(c) from (
    select company as c from career_apply_jobs where user_id = p_user and state not in ('failed', 'not_submitted')
    union all
    select r->>'company' from career_watch_kv kv, jsonb_array_elements(case when jsonb_typeof(kv.value #> '{memory,tracker,rows}') = 'array' then kv.value #> '{memory,tracker,rows}' else '[]'::jsonb end) r
    where kv.user_id = p_user and kv.key = 'career:account'
  ) x where c is not null and btrim(c) <> '' and length(btrim(c)) <= 200
  order by lower(btrim(c))
$$;
revoke all on function public.career_provider_applied_companies(uuid) from public, anon, authenticated;
grant execute on function public.career_provider_applied_companies(uuid) to service_role;

-- The owner's spend view: per day, searches made, calls (search + pages read), results, the model cost the gateway priced,
-- cache hits (free) and refusals.
create or replace function public.career_provider_spend(p_since timestamptz)
returns setof jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('provider', provider, 'day', day,
    'api_lookups', count(*) filter (where kind = 'api'), 'http_calls', sum(http_calls), 'results', coalesce(sum(results) filter (where kind = 'api'), 0),
    'cost_usd', sum(cost_usd), 'cache_hits', count(*) filter (where kind = 'cache'), 'refusals', count(*) filter (where outcome like 'rate_limited%' or outcome like 'out_of_credits%'))
  from (select l.*, (l.created_at at time zone 'utc')::date as day from career_provider_lookups l where l.created_at >= p_since) x
  group by provider, day order by day, provider
$$;
revoke all on function public.career_provider_spend(timestamptz) from public, anon, authenticated;
grant execute on function public.career_provider_spend(timestamptz) to service_role;

-- "Forget the people you found for me": the person's provider rows, their waits, their name on the ledger.
create or replace function public.career_provider_forget(p_user uuid)
returns int language plpgsql security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  delete from career_people where user_id = p_user and source = 'provider';
  get diagnostics n = row_count;
  delete from career_people_imports where user_id = p_user and source = 'provider';
  delete from career_provider_waiters where user_id = p_user;
  update career_provider_lookups set user_id = null where user_id = p_user;
  if exists (select 1 from career_people where user_id = p_user and source = 'provider') then raise exception 'forget the provider people: rows remain'; end if;
  return n;
end $$;
revoke all on function public.career_provider_forget(uuid) from public, anon, authenticated;
grant execute on function public.career_provider_forget(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------- erase
create or replace function public.career_provider_on_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.key = 'career:account' and coalesce((new.value->>'epoch')::bigint, 0) >
    (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end) then
  delete from public.career_people where user_id = new.user_id and source = 'provider';
  delete from public.career_provider_waiters where user_id = new.user_id;
  delete from public.career_provider_user_clock where user_id = new.user_id;
  update public.career_provider_lookups set user_id = null where user_id = new.user_id;
 end if;
 return new;
end $$;
revoke all on function public.career_provider_on_erase() from public, anon, authenticated;
drop trigger if exists career_provider_on_erase on public.career_watch_kv;
create trigger career_provider_on_erase after insert or update on public.career_watch_kv
 for each row when (new.key = 'career:account') execute function public.career_provider_on_erase();
