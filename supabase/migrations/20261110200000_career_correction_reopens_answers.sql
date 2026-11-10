-- x-audit (E.11 #9, coordinator ruling 2026-11-10): a correction in chat also reopens the answer library's answers that carry
-- the corrected-away words.
--
-- Before: career_correction_stop_stale (20261102000000) stopped prepared and approved applications made from the old
-- words, but an answer the person gave once to an employer's question ("Expected graduation date: May 2026") stayed
-- answered in career_apply_questions, and career_apply_answers_for (prepare-ahead) and career_apply_message_cloud_sources
-- (the cloud card) handed it to every later form. tests/architect/x-audit-correction-e2e.test.ts: 6/7 before, 7/7 after.
-- Now: on the same correction event, each answered row whose answer contains the old words is reopened (state open,
-- answer null) with reopened_at and reopened_reason ("you corrected this on <date>"), so the person is asked again in
-- their own words; it is never rewritten to the new value (D-007). The timeline note counts them (reopened_answers).
-- Additive: two nullable columns; the trigger function re-created with one step more. Idempotent.
-- Rollback: supabase/rollbacks/20261110200000_career_correction_reopens_answers.down.sql. NOT APPLIED: the owner applies it.

alter table public.career_apply_questions add column if not exists reopened_at timestamptz;
alter table public.career_apply_questions add column if not exists reopened_reason text check (reopened_reason is null or length(reopened_reason) between 1 and 200);

create or replace function public.career_correction_stop_stale() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare old_words text := nullif(btrim(coalesce(new.detail->'corrected'->>'from', '')), ''); q int := 0; d int := 0; s int := 0; r int := 0; gone text[];
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
  -- x-audit (20261110200000): an answer the person gave once to an employer's question (the answer library every later
  -- form is filled from) that carries the corrected-away words is reopened, never rewritten: they are asked again, in
  -- their own words (D-007). Its readers take answered rows only (career_apply_answers_for, career_apply_message_cloud_sources).
  with x as (update public.career_apply_questions c set state = 'open', answer = null, answered_at = null,
    reopened_at = now(), reopened_reason = 'you corrected this on ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), updated_at = now()
    where c.user_id = new.user_id and c.state = 'answered' and position(old_words in coalesce(c.answer, '')) > 0 returning 1)
  select count(*) into r from x;
 end if;
 if q + d + s + r > 0 then
  insert into public.career_events (user_id, kind, subject, detail, source)
  values (new.user_id, 'note', 'entry corrected: approvals with the old words stopped',
   jsonb_build_object('why', 'corrected', 'cancelled', q, 'discarded', d, 'being_sent', s, 'reopened_answers', r, 'companies', to_jsonb(coalesce(gone, '{}'))), 'resume');
 end if;
 return new;
end $$;
revoke all on function public.career_correction_stop_stale() from public, anon, authenticated;
drop trigger if exists career_correction_stop_stale on public.career_events;
create trigger career_correction_stop_stale after insert on public.career_events
 for each row when (new.kind = 'fact_confirmed') execute function public.career_correction_stop_stale();
