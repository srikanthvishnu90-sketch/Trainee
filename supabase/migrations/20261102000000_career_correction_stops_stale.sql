-- WHOLE JOURNEYS ROUND 2 (2026-11-02, tests/architect/journeys-r2-*.test.ts): a confirmed entry corrected in chat ("actually my
-- GPA is 3.95", "I graduated 2027") stops what was made from its old words, as a new resume stops what was made from the old
-- resume (20261026120018 career_resume_stop_unbound).
--
-- Found by the journeys: their computer prepared applications from the confirmed entries (GPA 3.75); the person then corrected
-- the GPA in chat and was told "from now on everything I prepare uses the corrected words"; the next "show my applications"
-- showed every prepared application with "GPA: 3.75 ... Every answer below goes exactly as shown", and a "yes" approved the old
-- value for the employer. Telegram's payload page showed the same. The rule (D-007; facts about the person only from confirmed
-- facts): a corrected value is never used again.
--
-- A correction is recorded as its own fact_confirmed event (career_router_evidence.ts evidenceEntryCorrections: detail.via is
-- ENTRY_CORRECTION_VIA, detail.corrected {from, to}), written in the same transaction as the corrected profile. On that event:
--   1. prepared and not yet approved, made before the correction: expired (their prepare attempts removed), so they are
--      prepared again from the corrected entry; a card showing one no longer approves it (its item is no longer ready, and is said by name);
--   2. approved and not yet handed out (queued, never attempted) whose answers carry the corrected-away words: removed from
--      the queue, as a new resume removes them (approve again with the corrected entry); one already being sent cannot be
--      stopped and is counted;
--   3. a note on the person's timeline says what stopped and why.
-- Idempotent. NOT APPLIED: the owner applies migrations.

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
