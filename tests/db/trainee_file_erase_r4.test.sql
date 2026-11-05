-- trainee-file sign-in round 4 (20261105150000_trainee_file_erase_r4.sql): "forget everything" (the account written with a
-- higher epoch AND paused) deletes the person's file page sessions and uses up every sign-in of theirs with its typed number
-- cleared, keeping the counts (the per-link and per-account limits); an epoch raised without the pause, a paused write at the same
-- epoch, and another person's rows are untouched; only the trigger runs the function. Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000fe401','tfe-a@example.test'),('00000000-0000-4000-8000-0000000fe402','tfe-b@example.test');
insert into public.trainee_file_sessions(id_hash,user_id,via,phone,telegram_id,list,created_at,expires_at) values
  (repeat('a',64),'00000000-0000-4000-8000-0000000fe401','phone','+15125550100',null,'0123456789',now(),now()+interval '2 hours'),
  (repeat('b',64),'00000000-0000-4000-8000-0000000fe401','telegram',null,'777','0123456789',now(),now()+interval '2 hours'),
  (repeat('c',64),'00000000-0000-4000-8000-0000000fe402','phone','+15125550199',null,'9876543210',now(),now()+interval '2 hours');
insert into public.trainee_file_logins(jti,user_id,list,phone,matched,sends,tries,created_at,expires_at,done_at) values
  ('00000000000fe4a1','00000000-0000-4000-8000-0000000fe401','0123456789','+15125550100',true,2,3,now(),now()+interval '15 minutes',null),
  ('00000000000fe4a2','00000000-0000-4000-8000-0000000fe401','0123456789','+14155550123',false,0,4,now(),now()+interval '15 minutes',null),
  ('00000000000fe4a3','00000000-0000-4000-8000-0000000fe401','0123456789','+15125550100',true,1,1,now()-interval '1 hour',now()-interval '45 minutes',now()-interval '50 minutes'),
  ('00000000000fe4b1','00000000-0000-4000-8000-0000000fe402','9876543210','+15125550199',true,1,1,now(),now()+interval '15 minutes',null);

do $$
begin
  -- the account row as the chat writes it, then an epoch raise WITHOUT the pause (the approval-staleness signal): nothing here
  insert into public.career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-0000000fe401','career:account','{"version":1,"epoch":0,"paused":false}');
  update public.career_watch_kv set value = '{"version":2,"epoch":1,"paused":false}' where user_id = '00000000-0000-4000-8000-0000000fe401' and key = 'career:account';
  if (select count(*) from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000fe401') <> 2 then raise exception 'FAIL an epoch raise without the pause signed the person out'; end if;
  if exists (select 1 from public.trainee_file_logins where jti = '00000000000fe4a1' and (phone is null or done_at is not null)) then raise exception 'FAIL an epoch raise without the pause touched a sign-in'; end if;
  -- paused at the SAME epoch (a pause, not an erase): nothing here
  update public.career_watch_kv set value = '{"version":3,"epoch":1,"paused":true}' where user_id = '00000000-0000-4000-8000-0000000fe401' and key = 'career:account';
  if (select count(*) from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000fe401') <> 2 then raise exception 'FAIL a pause alone signed the person out'; end if;
  raise notice 'ok   an epoch raise without the pause, and a pause at the same epoch, leave the file page sign-ins alone';

  -- the erase: a higher epoch AND paused
  update public.career_watch_kv set value = '{"version":4,"epoch":2,"paused":true}' where user_id = '00000000-0000-4000-8000-0000000fe401' and key = 'career:account';
  if exists (select 1 from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000fe401') then raise exception 'FAIL a session of the erased person is left'; end if;
  if exists (select 1 from public.trainee_file_logins where user_id = '00000000-0000-4000-8000-0000000fe401' and (phone is not null or done_at is null)) then raise exception 'FAIL a sign-in of the erased person still holds a number or can still be finished'; end if;
  if (select string_agg(jti || ':' || matched || ':' || sends || ':' || tries, ',' order by jti) from public.trainee_file_logins where user_id = '00000000-0000-4000-8000-0000000fe401')
     <> '00000000000fe4a1:true:2:3,00000000000fe4a2:false:0:4,00000000000fe4a3:true:1:1' then raise exception 'FAIL the erase changed the counts the limits read'; end if;
  if (select done_at from public.trainee_file_logins where jti = '00000000000fe4a3') > now() - interval '49 minutes' then raise exception 'FAIL a used link got a new used time'; end if;
  -- the limits still hold after the erase: a used link counts nothing
  if public.trainee_file_login_count('00000000000fe4a1', 'try', 5) then raise exception 'FAIL a try counted on a link the erase used up'; end if;
  if public.trainee_file_login_finish('00000000000fe4a1', now()) then raise exception 'FAIL a link the erase used up finished a sign-in'; end if;
  raise notice 'ok   the erase deletes the person''s sessions, clears every typed number, uses every link up and keeps the counts';

  -- another person is untouched
  if (select count(*) from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000fe402') <> 1 then raise exception 'FAIL another person''s session went'; end if;
  if not exists (select 1 from public.trainee_file_logins where jti = '00000000000fe4b1' and phone = '+15125550199' and done_at is null) then raise exception 'FAIL another person''s sign-in changed'; end if;
  -- an erase as the account's FIRST write (insert, epoch above 0, paused)
  insert into public.career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-0000000fe402','career:account','{"version":1,"epoch":1,"paused":true}');
  if exists (select 1 from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000fe402') or exists (select 1 from public.trainee_file_logins where user_id = '00000000-0000-4000-8000-0000000fe402' and (phone is not null or done_at is null))
    then raise exception 'FAIL an erase written as the account''s first row left a sign-in'; end if;
  raise notice 'ok   another person is untouched; an erase written as the first account row works too';
end $$;

do $$
declare who text;
begin
  if (select prosecdef from pg_proc where oid = 'public.trainee_file_erase_on_epoch()'::regprocedure) is not true then raise exception 'FAIL not a definer function'; end if;
  if has_function_privilege('public', 'public.trainee_file_erase_on_epoch()', 'execute') then raise exception 'FAIL public can run it'; end if;
  foreach who in array array['anon','authenticated'] loop
    if has_function_privilege(who, 'public.trainee_file_erase_on_epoch()', 'execute') then raise exception 'FAIL % can run it', who; end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'trainee_file_erase_on_epoch' and tgrelid = 'public.career_watch_kv'::regclass and not tgisinternal) then raise exception 'FAIL no trigger'; end if;
  raise notice 'ok   only the trigger runs it (definer, revoked from public, anon and authenticated)';
end $$;
rollback;
