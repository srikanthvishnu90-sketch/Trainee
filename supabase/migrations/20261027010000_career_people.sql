-- PEOPLE FINDING (D-033, 2026-10-26): the person's own people, kept per person (not per thread), and the introductions
-- they ask for. Nothing here is fetched from LinkedIn or Indeed, and nothing is sent by Trainee.
--
--   career_people           one row per person the person can name: from their own LinkedIn data export
--                           (Connections.csv, uploaded by them), from their own Gmail headers (people they have written
--                           to or heard from, gmail.readonly), or published by a company or a person on a public page
--                           the person sent (names marked up as people, addresses published as mailto links; source_url
--                           kept). Never a guessed address: email is only what the source itself carried.
--   career_people_imports   what each import read and kept, so a reply's counts are the database's.
--   career_people_prefs     when the export was asked for (asked once, then pointed back to).
--   career_job_emails       postings read from the person's own Handshake and Indeed alert emails, each with the link
--                           exactly as the email carried it; nothing logs in to those sites.
--   career_intro_requests   introduction and direct-note requests: to whom, via whom, the exact text shown, the hash
--                           the person approved, the status they report or Gmail shows, and a follow-up date only when
--                           they asked for one. Delivery is always the person's own: copy-ready text or a mailto link.
--
-- Row security on, no policies: only the service role (the chat handler) reads and writes. Erased by "forget
-- everything" (the account epoch trigger below; #200's career_erase_person also finds every career_* table with a
-- user_id), by account deletion (on delete cascade), and the Gmail-derived rows by disconnecting Gmail.
-- Idempotent: if not exists / create or replace / drop trigger if exists.

create table if not exists public.career_people (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('linkedin_export', 'gmail', 'company_page')),
  name text check (name is null or length(name) between 1 and 200),
  email text check (email is null or (length(email) between 3 and 254 and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  company text not null default '' check (length(company) <= 200),
  company_key text not null default '' check (length(company_key) <= 200),
  position text not null default '' check (length(position) <= 300),
  school text not null default '' check (length(school) <= 200),
  connected_on date,
  last_seen_at timestamptz,
  source_ref text not null check (length(source_ref) between 1 and 600),
  source_url text check (source_url is null or (length(source_url) <= 2048 and source_url ~ '^https://')),
  dedupe_key text not null check (length(dedupe_key) between 1 and 500),
  retrieved_at timestamptz not null default now(), -- when Trainee read it from its source (recipientSourced reads it)
  created_at timestamptz not null default now(),
  check (name is not null or email is not null),
  check (source <> 'company_page' or source_url is not null),
  unique (user_id, source, dedupe_key)
);
create index if not exists career_people_company on public.career_people (user_id, company_key);

create table if not exists public.career_people_imports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('linkedin_export', 'gmail', 'company_page')),
  file_name text not null check (length(file_name) between 1 and 300),
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[a-f0-9]{64}$'),
  rows_read int not null check (rows_read >= 0),
  imported int not null check (imported >= 0),
  duplicates int not null default 0 check (duplicates >= 0),
  skipped int not null default 0 check (skipped >= 0),
  with_email int not null default 0 check (with_email >= 0),
  created_at timestamptz not null default now()
);
create index if not exists career_people_imports_user on public.career_people_imports (user_id, created_at desc);

create table if not exists public.career_people_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  export_asked_at timestamptz,
  -- a long export pasted in parts: the header line of the last part that had one, so the next parts (rows only) read
  -- under it for an hour
  paste_header text check (paste_header is null or length(paste_header) <= 2000),
  paste_file text check (paste_file is null or length(paste_file) <= 300),
  paste_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.career_job_emails (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('handshake', 'indeed')),
  title text not null check (length(title) between 2 and 200),
  detail text not null default '' check (length(detail) <= 300),
  url text not null check (length(url) <= 2048 and url ~ '^https://'),
  message_hash text not null check (message_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, url)
);
create index if not exists career_job_emails_user on public.career_job_emails (user_id, received_at desc);

create table if not exists public.career_intro_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  n int not null check (n between 1 and 100000),
  route text not null check (route in ('mutual', 'direct')),
  target_name text not null check (length(target_name) between 1 and 200),
  target_company text not null default '' check (length(target_company) <= 200),
  target_title text not null default '' check (length(target_title) <= 300),
  target_ref text not null check (length(target_ref) between 1 and 600),
  via_name text check (via_name is null or length(via_name) between 1 and 200),
  via_ref text check (via_ref is null or length(via_ref) between 1 and 600),
  to_name text not null check (length(to_name) between 1 and 200),
  to_email text check (to_email is null or (length(to_email) <= 254 and to_email = lower(to_email))),
  delivery text not null check (delivery in ('mailto', 'copy')),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) between 1 and 3000),
  blurb text check (blurb is null or length(blurb) between 1 and 3000),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'drafted' check (status in ('drafted', 'approved', 'sent', 'replied', 'no_reply', 'cancelled')),
  status_source text check (status_source is null or status_source in ('person', 'gmail')),
  approved_hash text check (approved_hash is null or approved_hash ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz,
  sent_at timestamptz,
  follow_up_days int check (follow_up_days is null or follow_up_days between 1 and 60),
  follow_up_at timestamptz,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (route <> 'mutual' or (via_name is not null and blurb is not null)),
  check (delivery <> 'mailto' or to_email is not null),
  check (status <> 'approved' or approved_hash = payload_hash),
  unique (user_id, n)
);

alter table public.career_people enable row level security;
alter table public.career_people_imports enable row level security;
alter table public.career_people_prefs enable row level security;
alter table public.career_job_emails enable row level security;
alter table public.career_intro_requests enable row level security;
revoke all on public.career_people, public.career_people_imports, public.career_people_prefs, public.career_job_emails, public.career_intro_requests from public, anon, authenticated;
grant all on public.career_people, public.career_people_imports, public.career_people_prefs, public.career_job_emails, public.career_intro_requests to service_role;

-- ---------------------------------------------------------------------------------------------- one import, atomic
-- A LinkedIn export is the person's whole list: a new one replaces the last (rows they removed on LinkedIn go too).
-- Gmail and page rows are added (a second read of the same person is one row). Duplicates inside the batch and against
-- what is kept are counted, never kept twice. Returns what the database holds after, so the reply says the database's
-- numbers.
create or replace function public.career_people_import(p_user uuid, p_source text, p_file text, p_sha text, p_rows jsonb, p_read int, p_skipped int, p_replace boolean)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare inserted int; kept int; mailed int; removed int := 0; n_in int;
begin
  if p_user is null or p_source not in ('linkedin_export', 'gmail', 'company_page') or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) > 50000 or p_file is null or length(p_file) not between 1 and 300 then
    raise exception 'invalid people import';
  end if;
  n_in := jsonb_array_length(p_rows);
  perform pg_advisory_xact_lock(hashtextextended('career_people:' || p_user::text, 0));
  if p_replace then
    delete from career_people where user_id = p_user and source = p_source;
    get diagnostics removed = row_count;
  end if;
  insert into career_people (user_id, source, name, email, company, company_key, position, school, connected_on, last_seen_at, source_ref, source_url, dedupe_key)
  select p_user, p_source, nullif(r->>'name', ''), nullif(r->>'email', ''), coalesce(r->>'company', ''), coalesce(r->>'company_key', ''),
         coalesce(r->>'position', ''), coalesce(r->>'school', ''), (r->>'connected_on')::date, (r->>'last_seen_at')::timestamptz,
         r->>'source_ref', nullif(r->>'source_url', ''), r->>'dedupe_key'
  from jsonb_array_elements(p_rows) r
  on conflict (user_id, source, dedupe_key) do nothing;
  get diagnostics inserted = row_count;
  select count(*), count(email) into kept, mailed from career_people where user_id = p_user and source = p_source;
  insert into career_people_imports (user_id, source, file_name, file_sha256, rows_read, imported, duplicates, skipped, with_email)
  values (p_user, p_source, p_file, p_sha, greatest(coalesce(p_read, n_in), 0), inserted, greatest(n_in - inserted, 0), greatest(coalesce(p_skipped, 0), 0),
          (select count(email) from career_people where user_id = p_user and source = p_source and created_at = now()));
  return jsonb_build_object('inserted', inserted, 'duplicates', n_in - inserted, 'kept', kept, 'with_email', mailed, 'replaced', removed);
end $$;
revoke all on function public.career_people_import(uuid, text, text, text, jsonb, int, int, boolean) from public, anon, authenticated;
grant execute on function public.career_people_import(uuid, text, text, text, jsonb, int, int, boolean) to service_role;

-- How many people the person has given Trainee, by source (one round trip; no 1,000-row page cap).
create or replace function public.career_people_counts(p_user uuid)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select source, count(*) n from career_people where user_id = p_user group by source) x
$$;
revoke all on function public.career_people_counts(uuid) from public, anon, authenticated;
grant execute on function public.career_people_counts(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------- erase
-- "Forget everything" moves the account epoch (career_host_commit); that write deletes everything above.
create or replace function public.career_people_on_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.key = 'career:account' and coalesce((new.value->>'epoch')::bigint, 0) >
    (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end) then
  delete from public.career_intro_requests where user_id = new.user_id;
  delete from public.career_people where user_id = new.user_id;
  delete from public.career_people_imports where user_id = new.user_id;
  delete from public.career_people_prefs where user_id = new.user_id;
  delete from public.career_job_emails where user_id = new.user_id;
 end if;
 return new;
end $$;
revoke all on function public.career_people_on_erase() from public, anon, authenticated;
drop trigger if exists career_people_on_erase on public.career_watch_kv;
create trigger career_people_on_erase after insert or update on public.career_watch_kv
 for each row when (new.key = 'career:account') execute function public.career_people_on_erase();

-- Disconnecting Gmail (the career grant's row deleted) deletes what was read from that Gmail.
create or replace function public.career_people_on_gmail_disconnect() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if old.provider = 'google_career' then
  delete from public.career_people where user_id = old.user_id and source = 'gmail';
  delete from public.career_people_imports where user_id = old.user_id and source = 'gmail';
  delete from public.career_job_emails where user_id = old.user_id;
 end if;
 return old;
end $$;
revoke all on function public.career_people_on_gmail_disconnect() from public, anon, authenticated;
drop trigger if exists career_people_on_gmail_disconnect on public.user_oauth_connections;
create trigger career_people_on_gmail_disconnect after delete on public.user_oauth_connections
 for each row execute function public.career_people_on_gmail_disconnect();
