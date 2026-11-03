-- NETWORKING SCENARIOS (architect, 2026-10-29): the address rules of people discovery (20261027210000_career_people_provider),
-- held to the owner's words: "never invent an email (an inferred one is labeled inferred); never a guessed format for a
-- domain whose format bounced; role addresses never stand for a person". Three gaps the generated scenarios found
-- (tests/architect/flow-scenarios-networking.test.ts), each closed here (and a fourth, below: no inbox inferred for a team):
--   1. A role inbox learned as a person's format. A contact row "Stripe Careers <careers@stripe.com>" or a page's
--      "Careers Team <careers@...>" matched the format "first" (careers = the first name), so two such inboxes made
--      "first" the domain's format and every discovered person got first@domain. Now a role inbox (career_email_is_role,
--      the same rule as career_contacts.ts isRoleAddress) is never format evidence.
--   2. A personal webmail domain (gmail.com, outlook.com, ...) learned as a company's format: a firm whose name is its
--      webmail brand (Yahoo, Outlook) or a page publishing people's gmail addresses could make first.last@gmail.com the
--      "format" of a company. Webmail domains never have a learned format and nothing is inferred there.
--   3. A format that bounced kept being guessed. A bounce lowered the format's confidence but it was still the domain's
--      best format, so the next person discovered there got an address in the format that just bounced. Now a format
--      with more bounces than replies is not used to infer anyone (a reply confirming an address in that format
--      restores it), and the addresses already inferred in that format at that domain stop being sendable at the bounce.
-- Formats only, never addresses (as before). Idempotent.

create or replace function public.career_email_is_webmail(p_domain text)
returns boolean language sql immutable parallel safe as $$
  select pg_catalog.lower(pg_catalog.btrim(coalesce(p_domain, ''))) = any (array[
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.com.br', 'yahoo.com.mx', 'ymail.com',
    'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.es', 'hotmail.it', 'live.com', 'msn.com', 'icloud.com', 'me.com',
    'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com',
    'qq.com', '163.com', '126.com', 'naver.com', 'web.de', 'rediffmail.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'comcast.net', 'verizon.net',
    'att.net', 'sbcglobal.net'])
$$;
revoke all on function public.career_email_is_webmail(text) from public, anon, authenticated;
grant execute on function public.career_email_is_webmail(text) to service_role;

-- A role inbox: the local part (a +tag dropped) is an inbox word, or splits on . _ - (and as a whole word run) into inbox
-- words and their qualifiers with at least one inbox word: careers@, careers.us@, recruiting-team@, talentacquisition@.
create or replace function public.career_email_is_role(p_email text)
returns boolean language plpgsql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
declare
  core text[] := array['info', 'admin', 'administrator', 'support', 'sales', 'contact', 'contactus', 'hello', 'hi', 'team', 'office', 'hr',
    'careers', 'career', 'jobs', 'job', 'recruiting', 'recruitment', 'recruiter', 'talent', 'hiring', 'help', 'marketing', 'press', 'media', 'pr', 'billing',
    'accounts', 'finance', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'abuse', 'webmaster', 'hostmaster', 'enquiries', 'inquiries',
    'ir', 'investor', 'investors', 'investorrelations', 'legal', 'compliance', 'privacy', 'security', 'service', 'customerservice', 'feedback', 'events',
    'general', 'people', 'recruit', 'staffing'];
  qual text[] := array['acquisition', 'us', 'uk', 'eu', 'emea', 'apac', 'latam', 'na', 'global', 'university', 'campus', 'college', 'grad',
    'graduate', 'graduates', 'early', 'intern', 'interns', 'internships', 'internship', 'ops', 'operations', 'employment',
    'resumes', 'resume', 'cv', 'apply', 'applications', 'application', 'eng', 'engineering', 'tech', 'notifications', 'notification', 'mail', 'desk',
    'hq', 'relations', 'partnerships', 'partners', 'programs', 'program', 'student', 'students', 'new', 'newgrad', 'dept', 'department', 'center'];
  local text := regexp_replace(split_part(lower(btrim(coalesce(p_email, ''))), '@', 1), '\+.*$', '');
  bare text := regexp_replace(local, '[._-]+', '', 'g');
  -- a part run together from inbox words: only words of 3+ letters, longest first (as isRoleAddress)
  run text := '^(?:' || (select string_agg(w, '|' order by length(w) desc, w) from unnest(core || qual) w where length(w) >= 3 and w ~ '^[a-z]+$') || ')+$';
  core_in text := '(?:' || (select string_agg(w, '|' order by length(w) desc, w) from unnest(core) w where length(w) >= 3 and w ~ '^[a-z]+$') || ')';
  part text; any_core boolean := false;
begin
  if local = '' then return false; end if;
  if local = any (core) or bare = any (core) then return true; end if;
  foreach part in array regexp_split_to_array(local, '[._-]+') loop
    continue when part = '' or part ~ '^[0-9]+$';
    if part = any (core) then any_core := true; continue; end if;
    continue when part = any (qual);
    if part !~ run then return false; end if;
    if part ~ core_in then any_core := true; end if;
  end loop;
  return any_core;
end $$;
revoke all on function public.career_email_is_role(text) from public, anon, authenticated;
grant execute on function public.career_email_is_role(text) to service_role;

-- 4. Never infer a role inbox for a "person": a team marked up as a Person ("Talent Acquisition") would get
-- talent.acquisition@ in the first.last format. A local part built from a name that is an inbox is no address.
create or replace function public.career_email_local(p_format text, p_name text)
returns text language plpgsql immutable parallel safe set search_path = public, pg_temp as $$
declare parts text[]; f text; l text; v text;
begin
  if p_name is null or p_name !~ '^[A-Za-z][A-Za-z .''-]*$' then return null; end if;
  parts := regexp_split_to_array(btrim(regexp_replace(replace(replace(lower(p_name), '''', ''), '-', ''), '\s+', ' ', 'g')), ' ');
  f := regexp_replace(parts[1], '[^a-z]', '', 'g');
  l := regexp_replace(parts[array_length(parts, 1)], '[^a-z]', '', 'g');
  if f = '' then return null; end if;
  if array_length(parts, 1) < 2 or l = '' then
    v := case when p_format = 'first' then f else null end;
  else
    v := case p_format
      when 'first.last' then f || '.' || l when 'firstlast' then f || l when 'flast' then left(f, 1) || l when 'f.last' then left(f, 1) || '.' || l
      when 'first' then f when 'last' then l when 'first_last' then f || '_' || l when 'first-last' then f || '-' || l
      when 'firstl' then f || left(l, 1) when 'last.first' then l || '.' || f when 'lastf' then l || left(f, 1) end;
  end if;
  if v is not null and career_email_is_role(v || '@x.io') then return null; end if;
  return v;
end $$;
revoke all on function public.career_email_local(text, text) from public, anon, authenticated;
grant execute on function public.career_email_local(text, text) to service_role;

-- 1 and 2: a role inbox or a webmail address is never format evidence.
create or replace function public.career_email_learn(p_name text, p_email text)
returns text language plpgsql security invoker set search_path = public, pg_temp as $$
declare d text := lower(split_part(p_email, '@', 2)); f text; n int;
begin
  if career_email_is_role(p_email) or career_email_is_webmail(d) then return null; end if;
  f := career_email_format_of(p_name, p_email);
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

-- 2 and 3: the domain's best format, from 2+ distinct addresses, never on a webmail domain, never one that bounced more
-- than it was confirmed by a reply.
create or replace function public.career_email_best_format(p_domain text)
returns table (format text, evidence int, confidence int) language sql stable set search_path = public, pg_temp as $$
  select f.format, f.evidence, least(99, round(100.0 * (f.evidence + 2 * f.replies) / (f.evidence + 2 * f.replies + 3 * f.bounces + 1)))::int
  from career_email_formats f where f.domain = lower(p_domain) and f.evidence >= 2 and f.bounces <= f.replies and not career_email_is_webmail(p_domain)
  order by 3 desc, f.evidence desc, f.format limit 1
$$;
revoke all on function public.career_email_best_format(text) from public, anon, authenticated;
grant execute on function public.career_email_best_format(text) to service_role;

-- 3: a bounce marks the address bad forever and, when it followed a learned format, every address inferred in that format
-- at that domain stops being sendable (each was the same guess). A reply confirms the format again.
create or replace function public.career_email_feedback(p_email text, p_name text, p_outcome text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare d text := lower(split_part(p_email, '@', 2)); f text := career_email_format_of(p_name, p_email); n int := 0;
begin
  if p_outcome not in ('bounce', 'reply') or p_email is null then raise exception 'invalid email feedback'; end if;
  if p_outcome = 'bounce' then
    insert into career_email_bad (addr_hash, reason) values (career_email_hash(p_email), 'bounce') on conflict do nothing;
    update career_people set sendable = false, email_status = 'bounced' where email = lower(btrim(p_email)) and source = 'provider';
    get diagnostics n = row_count;
    if f is not null then
      update career_email_formats set bounces = bounces + 1, updated_at = now() where domain = d and format = f;
      update career_people set sendable = false
      where source = 'provider' and email_status = 'inferred' and sendable and domain = d and career_email_format_of(name, email) = f;
    end if;
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

-- The delivery (20261027210000), unchanged but for two lines: with a bounced format suspended, a person whose address in
-- that format bounced is still "bounced" (the reply says "their address bounced before: not used"), not "none"; and a
-- person who is one of their own contacts by that address is still recognized as them (never stored twice).
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
           bf.format as bf_format, bf.evidence as bf_evidence, bf.confidence as bf_confidence, af.format as af_format,
           coalesce((select d.mx from career_email_domains d where d.domain = pp.domain), 'not_run') as dmx
    from career_provider_people pp
    left join lateral career_email_best_format(pp.domain) bf on pp.email is null and pp.domain is not null
    left join lateral (select f.format from career_email_formats f where f.domain = lower(pp.domain) and f.evidence >= 2
                       order by f.evidence desc, f.format limit 1) af on pp.email is null and pp.domain is not null
    where pp.cache_id = p_cache
  ), src1 as (
    select s.*,
           coalesce(s.email, case when s.bf_format is not null and career_email_local(s.bf_format, s.name) is not null then career_email_local(s.bf_format, s.name) || '@' || s.domain end) as eff_email,
           -- the address this person had (published, or in the domain's format even while that format is suspended by a
           -- bounce): when it bounced, they are "bounced" (said so in the reply), not merely "none"
           coalesce(s.email, case when s.af_format is not null and career_email_local(s.af_format, s.name) is not null then career_email_local(s.af_format, s.name) || '@' || s.domain end) as cand
    from src0 s
  ), src as (
    select distinct on (coalesce(s.eff_email, 'id:' || s.provider_id)) s.*,
           case when s.email is not null then 'published' when s.eff_email is not null then 'inferred' else 'none' end as basis,
           (coalesce(s.eff_email, s.cand) is not null and exists (select 1 from career_email_bad b where b.addr_hash = career_email_hash(coalesce(s.eff_email, s.cand)))) as bad
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
           -- the same person as a contact of theirs by address: the address they have, or (while the format is suspended) the one
           -- they would have had in it; never sent to on that account, only recognized
           (coalesce(s.e, s.cand) is not null and exists (select 1 from career_people x where x.user_id = p_user and x.email = coalesce(s.e, s.cand))) as known_email
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
