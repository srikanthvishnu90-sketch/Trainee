-- MASS APPLY, MISSING INFORMATION (2026-11-02, tests/architect/missing-info-e2e.test.ts): a posting that stopped for want of the
-- person's resume FILE (prepare attempt "no_resume") was kept out of every later preparation for 7 days (the candidate rule
-- counts any attempt that is not asked/error for a week), so after they sent the file the applications stayed "getting ready"
-- and "ask again" (chat: already in your queue; page: nothing to do) started nothing.
-- When the person's resume file is stored: their "no_resume" tries are forgotten, and a preparation is asked for the postings
-- waiting in their queue (the same call a needs_answers job makes, career_apply_prepare_request_put). Nothing is approved,
-- queued for sending or sent by it. Additive, idempotent. Rollback: supabase/rollbacks/20261102140000_career_apply_resume_file_restarts_preparation.down.sql

create or replace function public.career_apply_resume_file_restarts() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 delete from public.career_apply_prepare_attempts where user_id = new.user_id and outcome = 'no_resume';
 begin
  perform public.career_apply_prepare_request_put(new.user_id,
   array(select w.posting_key from public.career_apply_wanted w where w.user_id = new.user_id and w.state = 'waiting' order by 1),
   public.career_apply_daily_limit(new.user_id));
 exception when others then
  -- Never lose the resume over the restart (nothing waiting raises nothing_to_prepare): the posting can still be asked for again.
  if sqlerrm <> 'nothing_to_prepare' then raise warning 'resume file restart: %', sqlerrm; end if;
 end;
 return new;
end $$;
revoke all on function public.career_apply_resume_file_restarts() from public, anon, authenticated;

drop trigger if exists career_apply_resume_file_restarts on public.career_apply_cloud_resumes;
create trigger career_apply_resume_file_restarts after insert or update on public.career_apply_cloud_resumes
 for each row execute function public.career_apply_resume_file_restarts();
