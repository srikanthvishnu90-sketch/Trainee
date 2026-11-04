-- APPROVAL RATE (owner target: 95%), measured, never manufactured.
-- Approval rate = the share of what Trainee showed the person that they accepted as it was shown, over the rolling 7 days.
--   outreach_draft      drafts approved UNCHANGED / drafts shown. A draft the person edited or asked to redo ("edit 3: ...",
--                       "redo 3"; the hash changes) is a miss even if the new version is approved later; a skipped or ignored
--                       draft is a miss. A draft still waiting counts only after 24 hours.
--   application_packet  prepared applications approved / prepared applications shown on a card (approved, declined, or left
--                       unanswered for 24 hours). A packet that expired because the person's resume changed is the system's,
--                       not their answer, and is not counted.
--   advice_answer       no thumbs-up / thumbs-down feedback exists yet, so there is nothing to measure: always 'insufficient data'.
-- Under 20 shown the answer is 'insufficient data' (no percentage). A person still approves every send and every apply:
-- nothing here approves, sends, applies, or changes a draft; it only counts what already happened.
-- Rows written before this migration were not tracked (approval_tracked = false) and are not counted.
-- Idempotent; service role only.
alter table public.career_outreach_drafts add column if not exists revisions int not null default 0;
alter table public.career_outreach_drafts add column if not exists accepted_unchanged_at timestamptz;
alter table public.career_outreach_drafts add column if not exists approval_tracked boolean not null default false;
alter table public.career_outreach_drafts alter column approval_tracked set default true;

create or replace function public.career_outreach_approval_track() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.hash is distinct from old.hash then new.revisions := old.revisions + 1; new.accepted_unchanged_at := null; end if;
  if new.status = 'approved' and old.status is distinct from 'approved' and new.revisions = 0 and new.accepted_unchanged_at is null then
    new.accepted_unchanged_at := now();
  end if;
  return new;
end $$;
drop trigger if exists career_outreach_approval_track on public.career_outreach_drafts;
create trigger career_outreach_approval_track before update on public.career_outreach_drafts
  for each row execute function public.career_outreach_approval_track();

create or replace function public.approval_rate(p_now timestamptz default now(), p_min int default 20, p_target numeric default 95)
returns table (kind text, window_start timestamptz, shown int, approved_unchanged int, rate_pct numeric, status text, note text)
language sql stable set search_path = public, pg_temp as $$
  with o as (
    select count(*)::int as shown, (count(*) filter (where accepted_unchanged_at is not null))::int as ok
    from public.career_outreach_drafts
    where approval_tracked and created_at > p_now - interval '7 days' and created_at <= p_now
      and (status <> 'shown' or revisions > 0 or accepted_unchanged_at is not null or created_at <= p_now - interval '24 hours')
  ), a as (
    select count(*)::int as shown, (count(*) filter (where state = 'approved'))::int as ok
    from public.career_apply_prepared
    where updated_at > p_now - interval '7 days' and updated_at <= p_now
      and (state in ('approved', 'declined') or (state = 'shown' and updated_at <= p_now - interval '24 hours'))
  ), k as (
    select 'outreach_draft'::text as kind, shown, ok, 'drafts approved unchanged / drafts shown'::text as note from o
    union all select 'application_packet', shown, ok, 'packets approved / packets shown on a card' from a
    union all select 'advice_answer', 0, 0, 'no thumbs feedback exists yet: not measured'
  )
  select k.kind, p_now - interval '7 days', k.shown, k.ok,
    case when k.shown >= p_min then round(100.0 * k.ok / k.shown, 1) end,
    case when k.shown < p_min then 'insufficient data' when k.ok * 100 < p_target * k.shown then 'below target' else 'ok' end,
    k.note
  from k order by k.kind;
$$;

create or replace view public.approval_rate_v with (security_invoker = true) as select * from public.approval_rate();

revoke all on function public.approval_rate(timestamptz, int, numeric), public.career_outreach_approval_track() from public, anon, authenticated;
grant execute on function public.approval_rate(timestamptz, int, numeric) to service_role;
revoke all on public.approval_rate_v from public, anon, authenticated;
grant select on public.approval_rate_v to service_role;
