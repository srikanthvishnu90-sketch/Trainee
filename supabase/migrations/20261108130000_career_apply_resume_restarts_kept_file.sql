-- S2 follow-up (2026-11-08, on 20261108110000): the resume-file restart (20261102140000) fires on every insert or update of
-- career_apply_cloud_resumes. Since 20261108110000 that table also holds a resume tailored for ONE posting
-- (career_apply_posting_resume_put) and the payload hash of the prepared application that carries it
-- (career_apply_posting_resume_link, a trigger on career_apply_prepared). Each of those writes restarted the person's whole
-- waiting queue: a preparation makes a prepared row, its link writes the hash, the restart asks for preparation again, and
-- the next preparation's new hash links again, with no end (career_apply_prepare_request_put only folds a repeat while the
-- last request is still queued or running).
-- Now the restart runs only when the person's own kept resume FILE is stored or changed: a posting's tailored copy and an
-- update that only links a payload hash restart nothing. What it does is unchanged: it forgets their "no_resume" tries and
-- asks for preparation of the postings waiting in their queue. Nothing is approved, queued for sending or sent by it.
-- Additive, idempotent. Rollback: supabase/rollbacks/20261108130000_career_apply_resume_restarts_kept_file.down.sql
create or replace function public.career_apply_resume_file_restarts() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 -- A posting's tailored copy is not their resume file (to_jsonb: the column exists only once 20261108110000 is applied).
 if to_jsonb(new)->>'posting_job_id' is not null then return new; end if;
 -- The same row with only its payload hash linked (or nothing) changed: the file is not new.
 if tg_op = 'UPDATE' and (to_jsonb(new) - 'payload_hash') = (to_jsonb(old) - 'payload_hash') then return new; end if;
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
