-- D-048 option (a), architect amendment (2026-11-10): CAREER_CONTACT_OUTREACH alone may send, but only to a recipient the
-- person supplied or confirmed (an address they typed, or a person on a page they gave). Resolution, people search and web
-- search stay behind CAREER_PEOPLE_SEARCH. Each contact now records who put the recipient there:
--   supplied_by  'search'  found by the pipeline's own resolution or search (the default, and every row saved before this)
--                'person'  the person typed the address or gave the page that names them
-- career_contact_save reads person.supplied_by (absent: 'search'); career_contact_get returns it in person. Idempotent.
-- A person-supplied contact is saved by the chat ingress (career_contact_supply.ts) only after the person confirms it.
-- Rollback: supabase/rollbacks/20261110130000_career_contact_supplied_by.down.sql.

alter table public.career_contact_profiles add column if not exists supplied_by text not null default 'search';
alter table public.career_contact_profiles drop constraint if exists career_contact_profiles_supplied_by_check;
alter table public.career_contact_profiles add constraint career_contact_profiles_supplied_by_check check (supplied_by in ('search', 'person'));

-- What the person said is kept as what they said, never dressed up as a web source:
--   career_contact_profiles / career_contact_facts.source_type 'person_stated'  their own words about the recipient (a title line from a pasted
--                                                     signature) or what they want to ask; source_url is '' for these
--   career_contact_email_evidence.method 'person_supplied'  an address the person typed and confirmed (score 95, and
--                                                     approvable only with the domain's mail server confirmed, as before)
alter table public.career_contact_profiles drop constraint if exists career_contact_profiles_source_type_check;
alter table public.career_contact_profiles add constraint career_contact_profiles_source_type_check check (source_type in ('company_page', 'sec_edgar', 'person_stated'));
alter table public.career_contact_profiles drop constraint if exists career_contact_profiles_source_url_check;
alter table public.career_contact_profiles add constraint career_contact_profiles_source_url_check
  check ((length(source_url) <= 2048 and source_url ~ '^https://') or (source_type = 'person_stated' and source_url = ''));
alter table public.career_contact_facts drop constraint if exists career_contact_facts_source_type_check;
alter table public.career_contact_facts add constraint career_contact_facts_source_type_check
  check (source_type in ('company_page', 'personal_page', 'sec_edgar', 'github', 'openalex', 'semantic_scholar', 'uspto', 'conference', 'news', 'person_stated'));
alter table public.career_contact_facts drop constraint if exists career_contact_facts_source_url_check;
alter table public.career_contact_facts add constraint career_contact_facts_source_url_check
  check ((length(source_url) <= 2048 and source_url ~ '^https://') or (source_type = 'person_stated' and source_url = ''));
alter table public.career_contact_email_evidence drop constraint if exists career_contact_email_evidence_method_check;
alter table public.career_contact_email_evidence add constraint career_contact_email_evidence_method_check
  check (method in ('first_party_published', 'github_public', 'pattern_rcpt_valid', 'finder_verified', 'pattern_unverified', 'guess', 'person_supplied'));
alter table public.career_contact_email_evidence drop constraint if exists career_contact_email_evidence_score_check;
alter table public.career_contact_email_evidence add constraint career_contact_email_evidence_score_check
  check (score = 0 or score = case method when 'first_party_published' then 95 when 'person_supplied' then 95 when 'github_public' then 90
    when 'pattern_rcpt_valid' then 80 when 'finder_verified' then 75 when 'pattern_unverified' then 50 when 'guess' then 30 end);

create or replace function public.career_contact_save(p jsonb) returns uuid
language plpgsql security invoker set search_path = public, pg_temp as $$
declare u uuid := (p->>'user')::uuid; id_ uuid; e jsonb := p->'email'; exp timestamptz := coalesce((p->>'expires_at')::timestamptz, now() + interval '90 days');
begin
  insert into public.career_contact_profiles(user_id, name, title, company, domain, source_url, source_type, supplied_by, expires_at)
  values (u, p->'person'->>'name', coalesce(p->'person'->>'title', ''), p->'person'->>'company', p->'person'->>'domain', p->'person'->>'source_url', p->'person'->>'source_type', coalesce(nullif(p->'person'->>'supplied_by', ''), 'search'), exp)
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

create or replace function public.career_contact_get(p jsonb) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('id', c.id, 'expires_at', c.expires_at,
    'person', jsonb_build_object('name', c.name, 'title', c.title, 'company', c.company, 'domain', c.domain, 'source_url', c.source_url, 'source_type', c.source_type, 'supplied_by', c.supplied_by),
    'facts', coalesce((select jsonb_agg(to_jsonb(f) - 'id' - 'contact_id' - 'user_id' order by f.confidence desc, f.id) from public.career_contact_facts f where f.contact_id = c.id and f.expires_at > now()), '[]'::jsonb),
    'email', (select to_jsonb(e) - 'contact_id' - 'user_id' - 'expires_at' from public.career_contact_email_evidence e where e.contact_id = c.id))
  from public.career_contact_profiles c where c.id = (p->>'id')::uuid and c.user_id = (p->>'user')::uuid and c.expires_at > now()
$$;
