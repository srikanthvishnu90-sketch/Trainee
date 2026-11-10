-- Rollback of 20261110200000_career_correction_reopens_answers.sql: the correction trigger as 20261102000000 defines it
-- (answers are no longer reopened). Answers reopened while it was live stay open (their old words are not restored: they
-- were corrected); the two columns are dropped.

create or replace function public.career_correction_stop_stale() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare old_words text := nullif(btrim(coalesce(new.detail->'corrected'->>'from', '')), ''); q int := 0; d int := 0; s int := 0; gone text[];
begin
 if new.kind <> 'fact_confirmed' or coalesce(new.detail->>'via', '') <> 'router: their correction of a confirmed resume entry' then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
 -- Their prepare attempts go (so the posting is prepared again); the rows are kept, expired, so a card that showed one still
 -- names its employer when it answers "changed after the card was shown".
 delete from public.career_apply_prepare_attempts a using public.career_apply_prepared p
  where a.user_id = new.user_id and a.prepared_id = p.id and p.user_id = new.user_id and p.state in ('ready', 'shown');
 with x as (update public.career_apply_prepared p set state = 'expired', updated_at = now() where p.user_id = new.user_id and p.state in ('ready', 'shown') returning 1)
 select count(*) into d from x;
 if old_words is not null and length(old_words) >= 2 then
  with x as (delete from public.career_apply_jobs j where j.user_id = new.user_id and j.state = 'queued' and j.attempts = 0
    and position(old_words in coalesce(j.payload->'fields', '[]'::jsonb)::text) > 0 returning j.company)
  select count(*), array_agg(distinct company) into q, gone from x;
  select count(*) into s from public.career_apply_jobs j where j.user_id = new.user_id and j.state = 'driving'
   and position(old_words in coalesce(j.payload->'fields', '[]'::jsonb)::text) > 0;
 end if;
 if q + d + s > 0 then
  insert into public.career_events (user_id, kind, subject, detail, source)
  values (new.user_id, 'note', 'entry corrected: approvals with the old words stopped',
   jsonb_build_object('why', 'corrected', 'cancelled', q, 'discarded', d, 'being_sent', s, 'companies', to_jsonb(coalesce(gone, '{}'))), 'resume');
 end if;
 return new;
end $$;
revoke all on function public.career_correction_stop_stale() from public, anon, authenticated;
drop trigger if exists career_correction_stop_stale on public.career_events;
create trigger career_correction_stop_stale after insert on public.career_events
 for each row when (new.kind = 'fact_confirmed') execute function public.career_correction_stop_stale();
alter table public.career_apply_questions drop column if exists reopened_reason;
alter table public.career_apply_questions drop column if exists reopened_at;
