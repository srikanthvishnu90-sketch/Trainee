-- Launch readiness S2 (2026-10-26): an erase removes everything Trainee keeps about the person.
--
-- Two erases exist, and both missed records:
--   "forget everything" in chat (career_host_commit raises the account's privacy epoch). Its triggers deleted events,
--     interviews, digest preferences, outreach, mail and the cloud's rows, but kept the applications (career_apply_jobs,
--     _prepared, _questions, _wanted, _cards: the answers and the resume hash), the receipts with their screenshots
--     (career_apply_receipts, career_apply_receipt_files), extension_submission_reports, channel_artifacts and the rest.
--   account deletion (delete-account removes auth.users). extension_submission_reports had no foreign key and outlived the
--     account; career_task_effects_v1 referenced its intent with NO ACTION, so deleting a person who had one failed.
--
-- 1. career_erase_person(user): deletes the person's rows from every table whose name starts with career_, channel_ or
--    extension_ and that has a user_id column (and connector_profiles), found from the catalog at run time, so a table
--    added later is erased without a change here. Tables that reference each other are deleted in passes until nothing is
--    left. It runs from a trigger on the account write of a real erase: career_host_commit's erase branch always writes
--    the account with a higher epoch AND paused (an epoch raised without the pause is the approval-staleness signal the
--    apply queue reads, and keeps its rows: tests/db/career_apply_jobs.test.sql).
--    The two apply rules survive the erase without the record: before the applications go, one row per application in
--    career_apply_erased keeps only sha256 hashes of its posting key and employer key and when it went, and a trigger on
--    career_apply_jobs refuses a new application to that posting ever ('duplicate_job') and to that employer within 30 days
--    ('company_cooldown'), as the queue did before the erase (D-011). No name, link, answer, resume hash or text is kept.
--    A hash of a well-known employer can be matched by someone who guesses the name and can read the table (service role
--    only), so the employer hash is cleared once its 30 days are over (career_apply_erased_expire, run by each erase).
--    Kept, each for a reason, and nothing identifying in them after the erase:
--      career_watch_kv            the account row itself (epoch, version, paused) and turn receipts whose responses
--                                 career_host_commit has already removed (they refuse a replay of an erased turn);
--      career_task_intents_v1, career_task_effects_v1, career_batch_intents_v1
--                                 the effect ledger that stops an external effect from running twice; the epoch hooks
--                                 clear private_input, result and the binding, leaving hashes and states only;
--      career_reminder_outbox     already emptied by career_host_commit (payload and record null, cancelled);
--      career_mail_cursors        a time only; keeping it stops the next mail run re-creating what was erased;
--      career_mail_model_calls    a count of model calls per day; erasing it would reset a spend cap;
--      career_apply_cloud_pauses  a safety pause on the person's cloud applications; erasing it would lift the pause;
--      career_outreach_dnc        hashed addresses of people who asked never to be emailed again; an erase must never
--                                 re-open someone who said stop (tests/db/career_outreach.test.sql);
--      career_apply_erased        the apply rules' tombstone above: hashes and times only;
--      channel_contacts, channel_link_nonces, channel_link_requests
--                                 the address the person is texting from, so the reply to "forget everything" reaches
--                                 them; removed with the account.
-- 2. extension_submission_reports.user_id and career_task_effects_v1.user_id reference auth.users on delete cascade, so
--    account deletion removes them. Reports already orphaned (their account is gone) are deleted first: they are exactly
--    the records that should not exist.
-- Idempotent. Tested by tests/db/career_erase_complete.test.sql.
create table if not exists public.career_apply_erased (
  user_id uuid not null references auth.users(id) on delete cascade,
  posting_hash text not null check (posting_hash ~ '^[a-f0-9]{64}$'),
  company_hash text check (company_hash is null or company_hash ~ '^[a-f0-9]{64}$'),
  at timestamptz not null,
  primary key (user_id, posting_hash)
);
alter table public.career_apply_erased enable row level security;
revoke all on public.career_apply_erased from anon, authenticated;
grant all on public.career_apply_erased to service_role;

-- The employer hash is needed only for its 30 days.
create or replace function public.career_apply_erased_expire() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.career_apply_erased set company_hash = null where company_hash is not null and at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.career_apply_erased_expire() from public, anon, authenticated;
grant execute on function public.career_apply_erased_expire() to service_role;

-- A new application to an erased one's posting, ever, or its employer within 30 days, is refused as it was before.
create or replace function public.career_apply_erased_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.career_apply_erased e where e.user_id = new.user_id
             and e.posting_hash = encode(sha256(convert_to(new.job_id, 'UTF8')), 'hex')) then
    raise exception 'duplicate_job';
  end if;
  if public.career_apply_company_key(new.company) <> '' and exists (select 1 from public.career_apply_erased e
      where e.user_id = new.user_id and e.at > now() - interval '30 days'
      and e.company_hash = encode(sha256(convert_to(public.career_apply_company_key(new.company), 'UTF8')), 'hex')) then
    raise exception 'company_cooldown';
  end if;
  return new;
end $$;
revoke all on function public.career_apply_erased_guard() from public, anon, authenticated;
drop trigger if exists career_apply_erased_guard on public.career_apply_jobs;
create trigger career_apply_erased_guard before insert on public.career_apply_jobs
  for each row execute function public.career_apply_erased_guard();

create or replace function public.career_erase_kept_tables() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['career_watch_kv','career_task_intents_v1','career_task_effects_v1','career_batch_intents_v1',
    'career_reminder_outbox','career_mail_cursors','career_mail_model_calls','career_apply_cloud_pauses',
    'channel_contacts','channel_link_nonces','channel_link_requests','career_apply_erased','career_outreach_dnc']
$$;
revoke all on function public.career_erase_kept_tables() from public, anon, authenticated;
grant execute on function public.career_erase_kept_tables() to service_role;

-- The tables an erase empties for one person, from the catalog: the person's career and channel records.
create or replace function public.career_erase_tables() returns text[]
language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(format('%I.%I', c.table_schema, c.table_name) order by c.table_schema, c.table_name), '{}')
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where t.table_type = 'BASE TABLE' and c.column_name = 'user_id'
    and ((c.table_schema = 'public' and (c.table_name ~ '^(career_|channel_|extension_)' or c.table_name = 'connector_profiles'))
      or c.table_schema = 'career_message_approval_private')
    and not (c.table_schema = 'public' and c.table_name = any(public.career_erase_kept_tables()))
$$;
revoke all on function public.career_erase_tables() from public, anon, authenticated;
grant execute on function public.career_erase_tables() to service_role;

create or replace function public.career_erase_person(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  todo text[] := public.career_erase_tables();
  left_over text[];
  tbl text;
  n bigint;
  deleted jsonb := '{}'::jsonb;
  pass int := 0;
begin
  if p_user is null then raise exception 'career erase: no person'; end if;
  -- The apply rules' tombstone: hashes and a time, from the queue and the extension's employer reports.
  insert into public.career_apply_erased(user_id, posting_hash, company_hash, at)
  select j.user_id, encode(sha256(convert_to(j.job_id, 'UTF8')), 'hex'),
    nullif(encode(sha256(convert_to(public.career_apply_company_key(j.company), 'UTF8')), 'hex'), encode(sha256(''::bytea), 'hex')),
    coalesce(j.claimed_at, j.created_at)
  from public.career_apply_jobs j where j.user_id = p_user
  on conflict (user_id, posting_hash) do nothing;
  insert into public.career_apply_erased(user_id, posting_hash, company_hash, at)
  select r.user_id, encode(sha256(convert_to('report:' || r.posting_url, 'UTF8')), 'hex'),
    nullif(encode(sha256(convert_to(public.career_apply_company_key(r.employer), 'UTF8')), 'hex'), encode(sha256(''::bytea), 'hex')),
    coalesce(r.observed_at, r.reported_at)
  from public.extension_submission_reports r where r.user_id = p_user
  on conflict (user_id, posting_hash) do nothing;
  perform public.career_apply_erased_expire();
  -- A row another table still references (no cascade) is deleted on a later pass, after the row referencing it.
  while array_length(todo, 1) > 0 and pass < 10 loop
    pass := pass + 1; left_over := '{}';
    foreach tbl in array todo loop
      begin
        execute format('delete from %s where user_id = $1', tbl) using p_user;
        get diagnostics n = row_count;
        if n > 0 then deleted := deleted || jsonb_build_object(tbl, coalesce((deleted->>tbl)::bigint, 0) + n); end if;
      exception when foreign_key_violation then
        left_over := left_over || tbl;
      end;
    end loop;
    todo := left_over;
  end loop;
  if array_length(todo, 1) > 0 then raise exception 'career erase: could not empty %', todo; end if;
  return deleted;
end $$;
revoke all on function public.career_erase_person(uuid) from public, anon, authenticated;
grant execute on function public.career_erase_person(uuid) to service_role;

create or replace function public.career_erase_on_epoch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.key = 'career:account' and new.value->'paused' = 'true'::jsonb and coalesce((new.value->>'epoch')::bigint, 0) >
     (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end) then
    perform public.career_erase_person(new.user_id);
  end if;
  return new;
end $$;
revoke all on function public.career_erase_on_epoch() from public, anon, authenticated;
drop trigger if exists career_erase_on_epoch on public.career_watch_kv;
create trigger career_erase_on_epoch after insert or update on public.career_watch_kv
  for each row when (new.key = 'career:account') execute function public.career_erase_on_epoch();

-- 2. Account deletion reaches the two tables it missed.
delete from public.extension_submission_reports r where not exists (select 1 from auth.users u where u.id = r.user_id);
delete from public.career_task_effects_v1 e where not exists (select 1 from auth.users u where u.id = e.user_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'extension_submission_reports_user_fk') then
    alter table public.extension_submission_reports add constraint extension_submission_reports_user_fk
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'career_task_effects_v1_user_fk') then
    alter table public.career_task_effects_v1 add constraint career_task_effects_v1_user_fk
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;
