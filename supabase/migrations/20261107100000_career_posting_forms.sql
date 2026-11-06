-- WO-121 (D-042 M4): each Greenhouse, Lever and Ashby posting's application form, read once soon after the ingest first
-- sees it (the career-form-schema lane, every minute), with the fields' person-independent map. A row is `captured` (the
-- form, its source and its SHA-256) or `unread` with the reason no form was read. Written and read by the service role
-- only (RLS on, no policy for anon or authenticated). Nothing here is a person's answer.
--   career_posting_forms_todo(since, limit)  open GH/Lever/Ashby postings first seen since `since` with no row, or unread
--                                             for a retryable reason, fewer than 5 attempts, 15 min x attempts after the
--                                             last; newest first
--   career_posting_forms_put(rows)           upsert; the same SHA-256 changes nothing, a changed one replaces fields and map
--   career_form_readiness(window)            M4 per provider: first seen, captured, captured within 1 h, unread by reason
create table if not exists public.career_posting_forms (
  job_id text primary key references public.career_postings(job_id) on delete cascade,
  provider text not null,
  state text not null check (state in ('captured', 'unread')),
  source text,
  unread text,
  detail text check (detail is null or length(detail) <= 300),
  fields jsonb not null default '[]',
  mapped jsonb not null default '[]',
  uploads text[] not null default '{}',
  captcha_expected boolean,
  schema_sha256 text check (schema_sha256 is null or schema_sha256 ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz not null,
  read_at timestamptz not null,
  attempts int not null default 1 check (attempts between 1 and 5),
  constraint career_posting_forms_captured check (state <> 'captured' or (source is not null and schema_sha256 is not null)),
  constraint career_posting_forms_unread check (state <> 'unread' or unread is not null)
);
create index if not exists career_posting_forms_state_seen on public.career_posting_forms (state, first_seen_at);
alter table public.career_posting_forms enable row level security;
revoke all on public.career_posting_forms from public, anon, authenticated;
grant select, insert, update, delete on public.career_posting_forms to service_role;

create or replace function public.career_posting_forms_todo(p_since timestamptz, p_limit int)
returns table(job_id text, provider text, board text, ats_id text, url text, first_seen_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.job_id, p.provider, p.board, p.ats_id, p.url, p.first_seen_at
  from public.career_postings p
  left join public.career_posting_forms f on f.job_id = p.job_id
  where p.closed_at is null
    and p.first_seen_at >= p_since
    and p.provider in ('greenhouse', 'lever', 'ashby')
    and (f.job_id is null
      or (f.state = 'unread' and f.unread in ('http_error', 'rate_limited', 'parse_error') and f.attempts < 5
          and f.read_at < now() - make_interval(mins => 15 * f.attempts)))
  order by p.first_seen_at desc, p.job_id
  limit greatest(0, least(coalesce(p_limit, 600), 2000))
$$;

create or replace function public.career_posting_forms_put(p_rows jsonb)
returns int
language sql volatile security definer set search_path = public, pg_temp as $$
  with src as (
    select distinct on (x.job_id) x.*
    from jsonb_to_recordset(case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end) as x(
      job_id text, provider text, state text, source text, unread text, detail text, fields jsonb, mapped jsonb, uploads text[],
      captcha_expected boolean, schema_sha256 text, first_seen_at timestamptz, read_at timestamptz)
    where exists (select 1 from public.career_postings p where p.job_id = x.job_id)
    order by x.job_id, x.read_at desc
  ), up as (
    insert into public.career_posting_forms as f (job_id, provider, state, source, unread, detail, fields, mapped, uploads,
      captcha_expected, schema_sha256, first_seen_at, read_at, attempts)
    select job_id, provider, state, source, unread, left(detail, 300), coalesce(fields, '[]'), coalesce(mapped, '[]'),
      coalesce(uploads, '{}'), captcha_expected, schema_sha256, first_seen_at, read_at, 1
    from src
    on conflict (job_id) do update set
      state = excluded.state, source = excluded.source, unread = excluded.unread, detail = excluded.detail,
      fields = excluded.fields, mapped = excluded.mapped, uploads = excluded.uploads, captcha_expected = excluded.captcha_expected,
      schema_sha256 = excluded.schema_sha256, read_at = excluded.read_at, attempts = least(f.attempts + 1, 5)
    -- A capture is never replaced by a failed read, and the same form read again changes nothing.
    where not (f.state = 'captured' and excluded.state = 'unread')
      and not (f.state = 'captured' and excluded.state = 'captured' and f.schema_sha256 = excluded.schema_sha256)
    returning 1
  )
  select count(*)::int from up
$$;

create or replace function public.career_form_readiness(p_window interval)
returns table(provider text, first_seen bigint, captured bigint, captured_within_1h bigint, unread_by_reason jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  with j as (
    select p.provider, f.state, f.read_at - p.first_seen_at as lag,
      case when f.state = 'captured' then null
           when f.state = 'unread' then f.unread
           when p.provider = 'smartrecruiters' then 'needs_partner_key'
           when p.provider = 'workday' then 'sign_in_required'
           else 'not_read_yet' end as reason
    from public.career_postings p
    left join public.career_posting_forms f on f.job_id = p.job_id
    where p.first_seen_at >= now() - p_window
      and p.provider in ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday')
  ), r as (
    select j.provider, j.reason, count(*) as n from j where j.reason is not null group by j.provider, j.reason
  )
  select j.provider, count(*), count(*) filter (where j.state = 'captured'),
    count(*) filter (where j.state = 'captured' and j.lag <= interval '1 hour'),
    coalesce((select jsonb_object_agg(r.reason, r.n) from r where r.provider = j.provider), '{}'::jsonb)
  from j group by j.provider order by j.provider
$$;

revoke all on function public.career_posting_forms_todo(timestamptz, int) from public, anon, authenticated;
revoke all on function public.career_posting_forms_put(jsonb) from public, anon, authenticated;
revoke all on function public.career_form_readiness(interval) from public, anon, authenticated;
grant execute on function public.career_posting_forms_todo(timestamptz, int) to service_role;
grant execute on function public.career_posting_forms_put(jsonb) to service_role;
grant execute on function public.career_form_readiness(interval) to service_role;
