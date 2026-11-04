-- Contacts belong to the person's account, not a chat (architect ruling R1, 2026-10-27), at any size (owner, 19:52 / 19:55
-- CDT: large scale, no limit of Trainee's own). Before this, the contacts lived in each chat's state (agent_flow_state
-- snapshot, at most 1 MB, so a copy had to be capped), and a list imported in one chat was invisible in another.
--
--   career_account_contacts            one row per contact row the person gave Trainee (a file's row, or one typed in
--                                      chat): the row as career_contacts.ts ContactRow (`data`) and the keys every read
--                                      uses, each indexed: by firm (who do I know at X, a group draft), by name (email
--                                      Maya, remove Maya from my contacts), by person (address, else name at firm), by
--                                      file. Reads are keyset-paged on row_key; nothing reads the whole list on a turn.
--   career_account_contacts_forgotten  the people the person told Trainee to forget: a chat state saved before this (a
--                                      legacy per-chat copy, moved here once) never brings one back. Importing the person
--                                      again on purpose lifts it.
--   career_account_contacts_put(user, epoch, rows, replace_file, unless_forgotten)
--   career_account_contacts_forget(user, epoch, all, linkedin, row_keys)
--                                      the only writes, each refused (returns null) when the account's privacy epoch is
--                                      no longer the one the turn started with: a turn that began before "forget
--                                      everything" never writes contacts after it.
--   career_account_contacts_summary(user)  how many, from how many files (and up to three file names).
-- Both tables start with career_ and have user_id, so "forget everything" (career_erase_person) and account deletion
-- (on delete cascade) remove them with no change elsewhere. Service role only. Idempotent.

create table if not exists public.career_account_contacts (
  user_id      uuid not null references auth.users(id) on delete cascade,
  row_key      text not null check (length(row_key) between 1 and 400),
  person_key   text not null check (length(person_key) between 1 and 400),
  file         text not null,
  name_key     text not null default '',
  email        text,
  firm_key     text not null default '',
  firm_raw_key text not null default '',
  data         jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at   timestamptz not null default now(),
  primary key (user_id, row_key)
);
create index if not exists career_account_contacts_firm on public.career_account_contacts (user_id, firm_key, row_key);
create index if not exists career_account_contacts_firm_raw on public.career_account_contacts (user_id, firm_raw_key, row_key);
create index if not exists career_account_contacts_name on public.career_account_contacts (user_id, name_key text_pattern_ops);
create index if not exists career_account_contacts_person on public.career_account_contacts (user_id, person_key);
create index if not exists career_account_contacts_email on public.career_account_contacts (user_id, email) where email is not null; -- stored lowercased
create index if not exists career_account_contacts_file on public.career_account_contacts (user_id, file);

create table if not exists public.career_account_contacts_forgotten (
  user_id    uuid not null references auth.users(id) on delete cascade,
  person_key text not null check (length(person_key) between 1 and 400),
  at         timestamptz not null default now(),
  primary key (user_id, person_key)
);

alter table public.career_account_contacts enable row level security;
alter table public.career_account_contacts_forgotten enable row level security;
revoke all on public.career_account_contacts, public.career_account_contacts_forgotten from public, anon, authenticated;
grant select, insert, update, delete on public.career_account_contacts, public.career_account_contacts_forgotten to service_role;

create or replace function public.career_account_contacts_epoch(p_user uuid) returns bigint
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce((select (w.value->>'epoch')::bigint from career_watch_kv w where w.user_id = p_user and w.key = 'career:account'), 0)
$$;
revoke all on function public.career_account_contacts_epoch(uuid) from public, anon, authenticated;
grant execute on function public.career_account_contacts_epoch(uuid) to service_role;

-- p_rows: [{row_key, person_key, file, name_key, email, firm_key, firm_raw_key, data}]. Returns how many rows were written,
-- or null when the epoch moved (nothing written). unless_forgotten: skip people on the forgotten list (a legacy chat copy
-- being moved); otherwise the import is on purpose and lifts their tombstone.
create or replace function public.career_account_contacts_put(p_user uuid, p_epoch bigint, p_rows jsonb, p_replace_file text, p_unless_forgotten boolean)
returns int language plpgsql security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  if p_user is null or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'invalid contacts'; end if;
  perform 1 from career_watch_kv where user_id = p_user and key = 'career:account' for share;
  if career_account_contacts_epoch(p_user) <> coalesce(p_epoch, 0) then return null; end if;
  if p_replace_file is not null then delete from career_account_contacts where user_id = p_user and file = p_replace_file; end if;
  with r as (
    select x->>'row_key' row_key, x->>'person_key' person_key, x->>'file' file, coalesce(x->>'name_key', '') name_key, nullif(x->>'email', '') email,
           coalesce(x->>'firm_key', '') firm_key, coalesce(x->>'firm_raw_key', '') firm_raw_key, x->'data' data
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
    where not (coalesce(p_unless_forgotten, false) and exists (select 1 from career_account_contacts_forgotten f where f.user_id = p_user and f.person_key = x->>'person_key'))
  ), lifted as (
    delete from career_account_contacts_forgotten f using r where not coalesce(p_unless_forgotten, false) and f.user_id = p_user and f.person_key = r.person_key
  ), w as (
    insert into career_account_contacts (user_id, row_key, person_key, file, name_key, email, firm_key, firm_raw_key, data, updated_at)
    select distinct on (row_key) p_user, row_key, person_key, file, name_key, email, firm_key, firm_raw_key, data, now() from r
    on conflict (user_id, row_key) do update set person_key = excluded.person_key, file = excluded.file, name_key = excluded.name_key, email = excluded.email,
      firm_key = excluded.firm_key, firm_raw_key = excluded.firm_raw_key, data = excluded.data, updated_at = now()
    returning 1)
  select count(*) into n from w;
  return n;
end $$;
revoke all on function public.career_account_contacts_put(uuid, bigint, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.career_account_contacts_put(uuid, bigint, jsonb, text, boolean) to service_role;

-- Deletes the rows named (all of them, the LinkedIn export's, or these row keys) and every other row of the same people,
-- and remembers each person as forgotten. Returns how many rows went, or null when the epoch moved (nothing deleted).
create or replace function public.career_account_contacts_forget(p_user uuid, p_epoch bigint, p_all boolean, p_linkedin boolean, p_row_keys text[])
returns int language plpgsql security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  if p_user is null then raise exception 'invalid forget'; end if;
  perform 1 from career_watch_kv where user_id = p_user and key = 'career:account' for share;
  if career_account_contacts_epoch(p_user) <> coalesce(p_epoch, 0) then return null; end if;
  with picked as (
    select person_key from career_account_contacts c where c.user_id = p_user and (coalesce(p_all, false)
      or (coalesce(p_linkedin, false) and (c.file ~* 'connections' or c.data->>'linkedin_export' = 'true'))
      or c.row_key = any(coalesce(p_row_keys, '{}'::text[])))
  ), tomb as (
    insert into career_account_contacts_forgotten (user_id, person_key) select distinct p_user, person_key from picked on conflict do nothing
  ), gone as (
    delete from career_account_contacts c using (select distinct person_key from picked) p where c.user_id = p_user and c.person_key = p.person_key returning 1)
  select count(*) into n from gone;
  return n;
end $$;
revoke all on function public.career_account_contacts_forget(uuid, bigint, boolean, boolean, text[]) from public, anon, authenticated;
grant execute on function public.career_account_contacts_forget(uuid, bigint, boolean, boolean, text[]) to service_role;

create or replace function public.career_account_contacts_summary(p_user uuid)
returns table (total bigint, file_count bigint, files text[])
language sql stable security invoker set search_path = public, pg_temp as $$
  select count(*), count(distinct file), (select array_agg(f order by f) from (select distinct file f from career_account_contacts where user_id = p_user order by 1 limit 3) x)
  from career_account_contacts where user_id = p_user
$$;
revoke all on function public.career_account_contacts_summary(uuid) from public, anon, authenticated;
grant execute on function public.career_account_contacts_summary(uuid) to service_role;
