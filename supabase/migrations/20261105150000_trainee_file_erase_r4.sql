-- trainee-file sign-in round 4 (2026-11-05): "forget everything" ends the person's file page sign-ins.
--
-- The erase (career_erase_person, run by career_erase_on_epoch when the account is written with a higher epoch AND paused)
-- empties every career_, channel_ and extension_ table, but the file page's own tables start with trainee_file_: after an
-- erase, every page session the person had open stayed live for up to two hours (checked against the confirmed phone, which
-- an erase keeps), every link's pending sign-in could still be finished, and both tables kept the phone numbers typed into
-- them (the person's own, and any stranger's typed on a forwarded link).
-- Now the same write of the account also:
--   trainee_file_sessions  deletes the person's sessions (a page open anywhere is signed out at its next request; the row held
--                          the phone the session was opened with);
--   trainee_file_logins    clears every typed number and uses every link up (done_at), so no link sent before the erase opens
--                          a sign-in again. The rows themselves stay, with their counts: they are the per-link and per-account
--                          limits on texts and code tries (20261031100000), which an erase must not reset.
-- Account deletion already removes both (on delete cascade). A separate trigger beside career_erase_on_epoch, with the same
-- condition; nothing else changes. Idempotent; service role only. Reverse: supabase/rollbacks/20261105150000_trainee_file_erase_r4.down.sql.
create or replace function public.trainee_file_erase_on_epoch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.key = 'career:account' and new.value->'paused' = 'true'::jsonb and coalesce((new.value->>'epoch')::bigint, 0) >
     (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end) then
    delete from public.trainee_file_sessions where user_id = new.user_id;
    update public.trainee_file_logins set phone = null, done_at = coalesce(done_at, now())
     where user_id = new.user_id and (phone is not null or done_at is null);
  end if;
  return new;
end $$;
revoke all on function public.trainee_file_erase_on_epoch() from public, anon, authenticated;
drop trigger if exists trainee_file_erase_on_epoch on public.career_watch_kv;
create trigger trainee_file_erase_on_epoch after insert or update on public.career_watch_kv
  for each row when (new.key = 'career:account') execute function public.trainee_file_erase_on_epoch();
