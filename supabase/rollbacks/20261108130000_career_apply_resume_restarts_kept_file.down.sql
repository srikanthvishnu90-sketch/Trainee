-- Reverses 20261108130000_career_apply_resume_restarts_kept_file.sql: the restart fires on every write to the resumes table
-- again (20261102140000's body). Requests already made stay.
create or replace function public.career_apply_resume_file_restarts() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 delete from public.career_apply_prepare_attempts where user_id = new.user_id and outcome = 'no_resume';
 begin
  perform public.career_apply_prepare_request_put(new.user_id,
   array(select w.posting_key from public.career_apply_wanted w where w.user_id = new.user_id and w.state = 'waiting' order by 1),
   public.career_apply_daily_limit(new.user_id));
 exception when others then
  if sqlerrm <> 'nothing_to_prepare' then raise warning 'resume file restart: %', sqlerrm; end if;
 end;
 return new;
end $$;
revoke all on function public.career_apply_resume_file_restarts() from public, anon, authenticated;
