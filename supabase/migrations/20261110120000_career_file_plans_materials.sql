-- Item 6 S3 (FILE-RECORDS.md sections 1 and 5): the real records the F-04 Search plan and F-07 Materials studio Files are drawn from,
-- and the two approvals those Files serve (approveplan, approvedoc).
--
--   career_search_plans        a person's search plan, one row per version. hard (cannot be overridden by fit) and prefs (influence
--                              ranking, never gate) are separate columns; each entry carries its source. Approving a version
--                              authorizes searching and shortlisting only: nothing here can queue an application.
--   career_material_versions   resume and letter versions, one row per version of one document (doc_key), each with a human label
--                              ("the one-page data analyst draft", E.4 40), the role it is for, its change summary and its file.
--
-- Both: owner only (RLS select own rows; no client writes); delete with the account. Versions, not overwrites: a row's content never
-- changes after insert (a trigger refuses it), and an approved row is never changed again or deleted while its owner exists (E.4 40).
-- payload_hash is computed here, on insert, from the row's content (sha256 of the canonical jsonb text). An approval is the
-- *_approve_as function with the exact hash the person saw: a different hash is 'stale' and changes nothing; an older version
-- of a plan than the newest is 'superseded'; a document approval names its role and covers no other ('wrong_role').
-- Additive and reversible (supabase/rollbacks/20261110120000_career_file_plans_materials.down.sql). Idempotent.

create table if not exists public.career_search_plans (
 id bigserial primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 version integer not null check (version >= 1),
 title text not null check (length(title) between 1 and 120),
 hard jsonb not null check (jsonb_typeof(hard) = 'array'),
 prefs jsonb not null check (jsonb_typeof(prefs) = 'array'),
 batch_cap integer not null check (batch_cap between 1 and 50),
 watch jsonb check (watch is null or jsonb_typeof(watch) = 'object'),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 approved_at timestamptz,
 approved_hash text,
 created_at timestamptz not null default now(),
 unique (user_id, version),
 constraint career_search_plans_approved check ((approved_at is null) = (approved_hash is null) and (approved_hash is null or approved_hash = payload_hash))
);

create table if not exists public.career_material_versions (
 id bigserial primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 doc_key text not null check (doc_key ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
 doc_kind text not null check (doc_kind in ('resume', 'letter')),
 version integer not null check (version >= 1),
 label text not null check (length(label) between 1 and 120),
 based_on text check (length(based_on) between 1 and 120),
 role_job_id text check (length(role_job_id) between 1 and 200),
 rid text check (rid ~ '^R-[0-9]{1,4}$'),
 changes jsonb not null default '[]'::jsonb check (jsonb_typeof(changes) = 'array'),
 format_check text check (length(format_check) between 1 and 200),
 file_sha256 text check (file_sha256 ~ '^[a-f0-9]{64}$'),
 file_name text check (length(file_name) between 1 and 200 and file_name !~ '[/\\]'),
 file_bytes bytea check (octet_length(file_bytes) between 1 and 10485760),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 approved_at timestamptz,
 approved_hash text,
 approved_role text,
 created_at timestamptz not null default now(),
 unique (user_id, doc_key, version),
 constraint career_material_versions_file check ((file_bytes is null) = (file_sha256 is null) and (file_bytes is null or encode(sha256(file_bytes), 'hex') = file_sha256)),
 constraint career_material_versions_approved check ((approved_at is null) = (approved_hash is null) and (approved_at is null) = (approved_role is null)
  and (approved_hash is null or approved_hash = payload_hash))
);
create index if not exists career_material_versions_role on public.career_material_versions (user_id, role_job_id, doc_kind);

-- The payload hash, from the content only (never the approval columns or the id).
create or replace function public.career_search_plan_hash(p public.career_search_plans) returns text
language sql immutable set search_path = public, pg_temp as $$
 select encode(sha256(convert_to(jsonb_build_object('title', p.title, 'hard', p.hard, 'prefs', p.prefs, 'batch_cap', p.batch_cap, 'watch', p.watch, 'version', p.version)::text, 'UTF8')), 'hex')
$$;
create or replace function public.career_material_version_hash(m public.career_material_versions) returns text
language sql immutable set search_path = public, pg_temp as $$
 select encode(sha256(convert_to(jsonb_build_object('doc_key', m.doc_key, 'doc_kind', m.doc_kind, 'version', m.version, 'label', m.label, 'based_on', m.based_on,
  'role_job_id', m.role_job_id, 'rid', m.rid, 'changes', m.changes, 'format_check', m.format_check, 'file_sha256', m.file_sha256, 'file_name', m.file_name)::text, 'UTF8')), 'hex')
$$;

-- Versions, not overwrites: content is set once, at insert; the approval columns go from empty to set once; an approved row is
-- never deleted while its owner exists (a deleted account cascades).
create or replace function public.career_file_versions_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
 if tg_op = 'INSERT' then
  if new.approved_at is not null then raise exception 'a version is approved by its approve function, never at insert' using errcode = 'check_violation'; end if;
  if tg_table_name = 'career_search_plans' then new.payload_hash := public.career_search_plan_hash(new);
  else new.payload_hash := public.career_material_version_hash(new); end if;
  return new;
 end if;
 if tg_op = 'DELETE' then
  if old.approved_at is not null and exists (select 1 from auth.users where id = old.user_id) then
   raise exception 'an approved version is never deleted' using errcode = 'check_violation';
  end if;
  return old;
 end if;
 if old.approved_at is not null then raise exception 'an approved version is never changed' using errcode = 'check_violation'; end if;
 if (to_jsonb(new) - array['approved_at', 'approved_hash', 'approved_role']) is distinct from (to_jsonb(old) - array['approved_at', 'approved_hash', 'approved_role']) then
  raise exception 'a version is never overwritten; insert a new version' using errcode = 'check_violation';
 end if;
 return new;
end $$;
drop trigger if exists career_search_plans_guard on public.career_search_plans;
create trigger career_search_plans_guard before insert or update or delete on public.career_search_plans for each row execute function public.career_file_versions_guard();
drop trigger if exists career_material_versions_guard on public.career_material_versions;
create trigger career_material_versions_guard before insert or update or delete on public.career_material_versions for each row execute function public.career_file_versions_guard();

-- approveplan: 'approved' | 'already' | 'stale' (the hash shown is not this version's) | 'superseded' (a newer version exists) | 'missing'.
create or replace function public.career_search_plan_approve_as(p_user uuid, p_version integer, p_hash text, p_at timestamptz) returns text
language plpgsql set search_path = public, pg_temp as $$
declare r public.career_search_plans;
begin
 select * into r from public.career_search_plans where user_id = p_user and version = p_version for update;
 if not found then return 'missing'; end if;
 if r.approved_at is not null then return case when r.approved_hash = p_hash then 'already' else 'stale' end; end if;
 if p_hash is distinct from r.payload_hash then return 'stale'; end if;
 if exists (select 1 from public.career_search_plans where user_id = p_user and version > p_version) then return 'superseded'; end if;
 update public.career_search_plans set approved_at = p_at, approved_hash = p_hash where id = r.id;
 return 'approved';
end $$;

-- approvedoc: the exact version, for the exact role it was made for. 'approved' | 'already' | 'stale' | 'wrong_role' | 'missing'.
-- Approving a version never touches another version: an earlier approved one stays as it was.
create or replace function public.career_material_version_approve_as(p_user uuid, p_doc text, p_version integer, p_role text, p_hash text, p_at timestamptz) returns text
language plpgsql set search_path = public, pg_temp as $$
declare r public.career_material_versions;
begin
 select * into r from public.career_material_versions where user_id = p_user and doc_key = p_doc and version = p_version for update;
 if not found then return 'missing'; end if;
 if r.approved_at is not null then return case when r.approved_hash = p_hash and r.approved_role = p_role then 'already' else 'stale' end; end if;
 if p_hash is distinct from r.payload_hash then return 'stale'; end if;
 if p_role is null or p_role is distinct from coalesce(r.role_job_id, r.rid) then return 'wrong_role'; end if;
 update public.career_material_versions set approved_at = p_at, approved_hash = p_hash, approved_role = p_role where id = r.id;
 return 'approved';
end $$;

alter table public.career_search_plans enable row level security;
alter table public.career_material_versions enable row level security;
drop policy if exists career_search_plans_own on public.career_search_plans;
create policy career_search_plans_own on public.career_search_plans for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists career_material_versions_own on public.career_material_versions;
create policy career_material_versions_own on public.career_material_versions for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.career_search_plans, public.career_material_versions from public, anon, authenticated;
grant select on public.career_search_plans, public.career_material_versions to authenticated;
grant all on public.career_search_plans, public.career_material_versions to service_role;
grant usage, select on sequence public.career_search_plans_id_seq, public.career_material_versions_id_seq to service_role;
revoke all on function public.career_search_plan_approve_as(uuid, integer, text, timestamptz), public.career_material_version_approve_as(uuid, text, integer, text, text, timestamptz),
 public.career_file_versions_guard() from public, anon, authenticated;
grant execute on function public.career_search_plan_approve_as(uuid, integer, text, timestamptz), public.career_material_version_approve_as(uuid, text, integer, text, text, timestamptz) to service_role;
