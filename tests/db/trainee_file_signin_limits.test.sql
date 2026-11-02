-- trainee-file sign-in limits per account (20261031100000_trainee_file_signin_limits.sql): across all of one account's links
-- whose typed number is the account's, at most 10 texts and 15 code tries among sign-ins begun within an hour of each other;
-- each link keeps its own caps (3 and 5); a stranger's number on a link checks nothing and does not use the account's budget;
-- another account is untouched; an hour apart the budget is whole again; nobody but the service role runs it.
-- Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000f5f01','tfl-a@example.test'),('00000000-0000-4000-8000-0000000f5f02','tfl-b@example.test');
do $$
declare sends int := 0; tries int := 0; j text; n int;
begin
  -- six links of account A, a minute apart, the account's own number on each
  for i in 0..5 loop
    j := '00000000000f5f' || lpad(i::text, 2, '0');
    perform public.trainee_file_login_begin(j, '00000000-0000-4000-8000-0000000f5f01', '0123456789', now() + make_interval(mins => i), now() + make_interval(mins => i + 15));
    update public.trainee_file_logins set phone = '+15125550100', matched = true where jti = j;
    for k in 1..5 loop if public.trainee_file_login_count(j, 'send', 3) then sends := sends + 1; end if; end loop;
    for k in 1..9 loop if public.trainee_file_login_count(j, 'try', 5) then tries := tries + 1; end if; end loop;
  end loop;
  if sends <> 10 or tries <> 15 then raise exception 'FAIL the account got % texts and % tries (want 10 and 15)', sends, tries; end if;
  if exists (select 1 from public.trainee_file_logins where user_id = '00000000-0000-4000-8000-0000000f5f01' and (sends > 3 or tries > 5)) then raise exception 'FAIL a link passed its own cap'; end if;
  raise notice 'ok   six links of one account: 10 texts and 15 tries in all, no link past its own 3 and 5';

  -- a stranger's number on another link of A: its own tries only (it checks nothing)
  perform public.trainee_file_login_begin('00000000000f5fa0', '00000000-0000-4000-8000-0000000f5f01', '0123456789', now(), now() + interval '15 minutes');
  update public.trainee_file_logins set phone = '+14155550123', matched = false where jti = '00000000000f5fa0';
  n := 0; for k in 1..7 loop if public.trainee_file_login_count('00000000000f5fa0', 'try', 5) then n := n + 1; end if; end loop;
  if n <> 5 then raise exception 'FAIL a stranger''s number link counted % tries', n; end if;
  -- account B is untouched by A's budget
  perform public.trainee_file_login_begin('00000000000f5fb0', '00000000-0000-4000-8000-0000000f5f02', '9876543210', now(), now() + interval '15 minutes');
  update public.trainee_file_logins set phone = '+15125550199', matched = true where jti = '00000000000f5fb0';
  if not public.trainee_file_login_count('00000000000f5fb0', 'send', 3) or not public.trainee_file_login_count('00000000000f5fb0', 'try', 5) then raise exception 'FAIL another account was capped by A'; end if;
  -- two hours later, A's new link has its whole budget
  perform public.trainee_file_login_begin('00000000000f5fa1', '00000000-0000-4000-8000-0000000f5f01', '0123456789', now() + interval '2 hours', now() + interval '2 hours 15 minutes');
  update public.trainee_file_logins set phone = '+15125550100', matched = true where jti = '00000000000f5fa1';
  if not public.trainee_file_login_count('00000000000f5fa1', 'send', 3) or not public.trainee_file_login_count('00000000000f5fa1', 'try', 5) then raise exception 'FAIL the budget did not come back an hour on'; end if;
  -- the per-link rules still hold: a used link counts nothing, an unknown count raises, an unknown link is false
  perform public.trainee_file_login_finish('00000000000f5fa1', now());
  if public.trainee_file_login_count('00000000000f5fa1', 'try', 5) then raise exception 'FAIL counted after the link was used'; end if;
  if public.trainee_file_login_count('00000000000f5fff', 'try', 5) then raise exception 'FAIL an unknown link was counted'; end if;
  begin perform public.trainee_file_login_count('00000000000f5fa0', 'other', 5); raise exception 'FAIL an unknown count ran'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'ok   a stranger''s number uses no account budget; other accounts untouched; the budget returns an hour on; per-link rules kept';
end $$;

do $$
declare who text;
begin
  foreach who in array array['anon','authenticated'] loop
    execute format('set local role %I', who);
    begin perform public.trainee_file_login_count('00000000000f5fa0', 'try', 99); raise exception 'FAIL % counted a try', who; exception when insufficient_privilege then null; end;
    reset role;
  end loop;
  if has_function_privilege('public', 'public.trainee_file_login_count(text, text, int)', 'execute') then raise exception 'FAIL public can run it'; end if;
  if (select prosecdef from pg_proc where oid = 'public.trainee_file_login_count(text, text, int)'::regprocedure) is not true then raise exception 'FAIL not a definer function'; end if;
  raise notice 'ok   only the service role runs the count';
end $$;
rollback;
