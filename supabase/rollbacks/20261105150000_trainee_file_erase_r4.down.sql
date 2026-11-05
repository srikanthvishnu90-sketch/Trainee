-- Reverses 20261105150000_trainee_file_erase_r4.sql: an erase no longer touches the file page's sessions and sign-ins (as
-- before). Sessions already deleted and numbers already cleared by an erase stay that way.
drop trigger if exists trainee_file_erase_on_epoch on public.career_watch_kv;
drop function if exists public.trainee_file_erase_on_epoch();
