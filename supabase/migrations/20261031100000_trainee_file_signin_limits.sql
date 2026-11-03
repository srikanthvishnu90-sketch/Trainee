-- trainee-file sign-in limits PER ACCOUNT (file page web-security round, 2026-11-02). Each link's sign-in was capped (3 texts,
-- 5 code tries), but only per link: whoever holds many forwarded links of one account got 3 texts and 5 guesses from EACH
-- (12 links: 36 texts to the owner's phone, 60 guesses at the code). trainee_file_login_count now also caps the ACCOUNT: at most
-- 10 texts and 15 code tries over the account's sign-ins begun within an hour of this one, counting only sign-ins whose typed
-- number is the account's own (only they text a code or check one; a stranger's number checks nothing). The account's rows are
-- counted under a per-account lock, so guesses on many links at once cannot all get under the cap. A phone number is one
-- account's confirmed phone (Supabase Auth keeps phones unique), so this is also the per-phone cap. The numbers are the ones in
-- supabase/functions/_shared/file_session.ts (ACCOUNT_MAX_SENDS, ACCOUNT_MAX_TRIES, ACCOUNT_WINDOW_MS).
-- Same signature as 20261029230000's: the deployed function keeps calling it unchanged. Idempotent; service role only.
create or replace function public.trainee_file_login_count(p_jti text, p_what text, p_max int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.trainee_file_logins;
  n int;
  used int;
begin
  if p_what is null or p_what not in ('send', 'try') then
    raise exception 'trainee_file_login_count: unknown count %', p_what;
  end if;
  select * into r from public.trainee_file_logins where jti = p_jti;
  if not found or r.done_at is not null then return false; end if;
  -- one account's counts at a time (every link of the account), then this row again under the lock
  perform pg_advisory_xact_lock(hashtextextended('trainee_file_login_account:' || r.user_id::text, 0));
  select * into r from public.trainee_file_logins where jti = p_jti for update;
  if not found or r.done_at is not null then return false; end if;
  if r.matched then
    select coalesce(sum(case when p_what = 'send' then x.sends else x.tries end), 0) into used
      from public.trainee_file_logins x
     where x.user_id = r.user_id and x.matched
       and x.created_at > r.created_at - interval '1 hour' and x.created_at < r.created_at + interval '1 hour';
    if used >= (case when p_what = 'send' then 10 else 15 end) then return false; end if;
  end if;
  if p_what = 'send' then
    update public.trainee_file_logins set sends = sends + 1 where jti = p_jti and done_at is null and sends < p_max returning sends into n;
  else
    update public.trainee_file_logins set tries = tries + 1 where jti = p_jti and done_at is null and tries < p_max returning tries into n;
  end if;
  return n is not null;
end $$;

create index if not exists trainee_file_logins_user_created on public.trainee_file_logins (user_id, created_at);

revoke all on function public.trainee_file_login_count(text, text, int) from public, anon, authenticated;
grant execute on function public.trainee_file_login_count(text, text, int) to service_role;
