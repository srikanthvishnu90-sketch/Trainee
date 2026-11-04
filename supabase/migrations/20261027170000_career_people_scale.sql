-- PEOPLE FINDING at scale (owner, 2026-10-27 19:52 / 19:55 CDT: large scale, no limits of Trainee's own). Additive only:
-- indexes and three functions, so every people read on a turn or a run is indexed, and none is capped by a number of
-- Trainee's own (the scheduled push pages through every due reminder; it no longer stops at 500).
--
--   agent_flow_state (user_id)                    every "all of this person's chats" read (forget, the tracker, memory)
--                                                 was a sequential scan; 12 readers in _shared filter on it.
--   career_people (user_id, lower(name))          a contact by name ("intro to Maya Chen", "Maya went to DePaul")
--                                                 without reading the person's whole list (tens of thousands of rows).
--   career_intro_requests due, partial            the scheduled push and the in-chat line read only armed, unreminded,
--                                                 approved or sent intros, oldest due first.
--   career_people_named(user, name, limit)        exact name, or a first name alone, case-insensitive, on that index.
--   career_intro_due(now, after_at, after_id, n)  one page of due reminders across people, keyset-paged.
--   career_people_prune_thread_contacts(user, except_thread, all)
--                                                 "forget my LinkedIn contacts" / "forget my contacts": the drafter's copy
--                                                 removed from every OTHER chat of the person in one statement, in the
--                                                 database (no chat state travels to the edge and back); each chat's
--                                                 revision moves, so a turn that loaded the old list can't save it back
--                                                 (career_host_commit refuses a stale revision).
-- Idempotent: if not exists / create or replace.

create index if not exists agent_flow_state_user on public.agent_flow_state (user_id);
create index if not exists career_people_name on public.career_people (user_id, lower(name) text_pattern_ops) where name is not null;
create index if not exists career_intro_requests_due on public.career_intro_requests (follow_up_at, id)
  where follow_up_at is not null and reminded_at is null and status in ('approved', 'sent');
create index if not exists career_intro_requests_due_user on public.career_intro_requests (user_id, follow_up_at)
  where follow_up_at is not null and reminded_at is null and status in ('approved', 'sent');

create or replace function public.career_people_named(p_user uuid, p_name text, p_limit int default 50)
returns setof public.career_people language sql stable security invoker set search_path = public, pg_temp as $$
  with n as (select lower(btrim(p_name)) as v)
  select p.* from career_people p, n
  where p.user_id = p_user and p.name is not null and n.v <> ''
    and (lower(p.name) = n.v or (position(' ' in n.v) = 0 and lower(p.name) like replace(replace(replace(n.v, '\', '\\'), '%', '\%'), '_', '\_') || ' %'))
  order by (lower(p.name) = n.v) desc, p.id
  limit greatest(coalesce(p_limit, 50), 1)
$$;
revoke all on function public.career_people_named(uuid, text, int) from public, anon, authenticated;
grant execute on function public.career_people_named(uuid, text, int) to service_role;

create or replace function public.career_intro_due(p_now timestamptz, p_after_at timestamptz, p_after_id bigint, p_limit int)
returns setof public.career_intro_requests language sql stable security invoker set search_path = public, pg_temp as $$
  select i.* from career_intro_requests i
  where i.follow_up_at is not null and i.reminded_at is null and i.status in ('approved', 'sent') and i.follow_up_at <= p_now
    and (p_after_at is null or (i.follow_up_at, i.id) > (p_after_at, coalesce(p_after_id, 0)))
  order by i.follow_up_at, i.id
  limit greatest(coalesce(p_limit, 1000), 1)
$$;
revoke all on function public.career_intro_due(timestamptz, timestamptz, bigint, int) from public, anon, authenticated;
grant execute on function public.career_intro_due(timestamptz, timestamptz, bigint, int) to service_role;

-- A row is the export's when the drafter's copy says so (linkedin_export) or it came from a Connections.csv file.
create or replace function public.career_people_prune_thread_contacts(p_user uuid, p_except uuid, p_all boolean)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare n_rows bigint := 0; n_threads int := 0;
begin
  if p_user is null then raise exception 'invalid prune'; end if;
  with t as (
    select f.thread_id, f.state,
      coalesce((select jsonb_agg(r order by o) from jsonb_array_elements(f.state #> '{career,stores,contacts}') with ordinality x(r, o)
        where not coalesce(p_all or r->>'linkedin_export' = 'true' or coalesce(r->>'file', '') ~* 'connections\.csv', false)), '[]'::jsonb) as kept,
      jsonb_array_length(f.state #> '{career,stores,contacts}') as had
    from agent_flow_state f
    where f.user_id = p_user and f.thread_id is distinct from p_except
      and jsonb_typeof(f.state #> '{career,stores,contacts}') = 'array'
    for update of f
  ), w as (
    update agent_flow_state f
       set state = jsonb_set(jsonb_set(f.state, '{career,stores,contacts}', t.kept),
                             '{career,revision}', to_jsonb(coalesce((f.state #>> '{career,revision}')::bigint, 0) + 1)),
           updated_at = now()
      from t
     where f.thread_id = t.thread_id and jsonb_array_length(t.kept) < t.had
    returning t.had - jsonb_array_length(t.kept) as gone
  )
  select coalesce(sum(gone), 0), count(*) into n_rows, n_threads from w;
  return jsonb_build_object('rows', n_rows, 'threads', n_threads);
end $$;
revoke all on function public.career_people_prune_thread_contacts(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.career_people_prune_thread_contacts(uuid, uuid, boolean) to service_role;

-- An export of tens of thousands of rows arrives in parts (the edge sends ~2,000 rows per call, so no one request or
-- statement is huge): the first part opens one import record (and, for a new file, replaces the earlier export); each
-- later part names that record and adds its counts to it, so the person's one line still reads the database's totals.
-- Dedupe stays on the unique (user_id, source, dedupe_key) index. No row cap of Trainee's own.
create or replace function public.career_people_import_part(p_user uuid, p_source text, p_file text, p_sha text, p_rows jsonb,
  p_read int, p_skipped int, p_replace boolean, p_import bigint)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare inserted int; mailed int; removed int := 0; n_in int; imp bigint := p_import; kept int; kept_mail int;
begin
  if p_user is null or p_source not in ('linkedin_export', 'gmail', 'company_page') or jsonb_typeof(p_rows) is distinct from 'array'
     or p_file is null or length(p_file) not between 1 and 300 then
    raise exception 'invalid people import';
  end if;
  n_in := jsonb_array_length(p_rows);
  perform pg_advisory_xact_lock(hashtextextended('career_people:' || p_user::text, 0));
  if imp is null then
    if p_replace then
      delete from career_people where user_id = p_user and source = p_source;
      get diagnostics removed = row_count;
    end if;
    insert into career_people_imports (user_id, source, file_name, file_sha256, rows_read, imported, duplicates, skipped, with_email)
    values (p_user, p_source, p_file, p_sha, greatest(coalesce(p_read, n_in), 0), 0, 0, greatest(coalesce(p_skipped, 0), 0), 0)
    returning id into imp;
  elsif not exists (select 1 from career_people_imports where id = imp and user_id = p_user and source = p_source) then
    raise exception 'invalid people import part';
  end if;
  with ins as (
    insert into career_people (user_id, source, name, email, company, company_key, position, school, connected_on, last_seen_at, source_ref, source_url, dedupe_key)
    select p_user, p_source, nullif(r->>'name', ''), nullif(r->>'email', ''), coalesce(r->>'company', ''), coalesce(r->>'company_key', ''),
           coalesce(r->>'position', ''), coalesce(r->>'school', ''), (r->>'connected_on')::date, (r->>'last_seen_at')::timestamptz,
           r->>'source_ref', nullif(r->>'source_url', ''), r->>'dedupe_key'
    from jsonb_array_elements(p_rows) r
    on conflict (user_id, source, dedupe_key) do nothing
    returning email
  ) select count(*), count(email) into inserted, mailed from ins;
  update career_people_imports set imported = imported + inserted, duplicates = duplicates + (n_in - inserted), with_email = with_email + mailed
   where id = imp;
  select count(*), count(email) into kept, kept_mail from career_people where user_id = p_user and source = p_source;
  return jsonb_build_object('inserted', inserted, 'duplicates', n_in - inserted, 'kept', kept, 'with_email', kept_mail, 'replaced', removed, 'import', imp);
end $$;
revoke all on function public.career_people_import_part(uuid, text, text, text, jsonb, int, int, boolean, bigint) from public, anon, authenticated;
grant execute on function public.career_people_import_part(uuid, text, text, text, jsonb, int, int, boolean, bigint) to service_role;

-- How many intro requests a person keeps (not cancelled), and how many people at a company: counts in the database, so
-- a reply's number is true however many rows there are, while the rows a turn reads stay one bounded page.
create or replace function public.career_people_tallies(p_user uuid, p_company_key text)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'intros_open', (select count(*) from career_intro_requests where user_id = p_user and status <> 'cancelled'),
    'at_company', case when coalesce(p_company_key, '') = '' then 0 else (select count(*) from career_people where user_id = p_user and company_key = p_company_key) end)
$$;
revoke all on function public.career_people_tallies(uuid, text) from public, anon, authenticated;
grant execute on function public.career_people_tallies(uuid, text) to service_role;
