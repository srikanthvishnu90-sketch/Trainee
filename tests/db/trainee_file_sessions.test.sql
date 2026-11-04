-- trainee-file sign-in (20261029230000_trainee_file_sessions.sql): a link's sign-in begun once and used up once; texts and
-- code tries counted atomically under their caps (and never after the link is used); sign out one session or every session
-- of the account; a deleted account takes its sessions and sign-ins with it; nobody but the service role reads either table.
-- Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000f5e01','tf-a@example.test'),('00000000-0000-4000-8000-0000000f5e02','tf-b@example.test');
do $$
declare r public.trainee_file_logins; n int; ok boolean;
begin
  -- begun once: a second open of the same link reads the same row back
  select * into r from public.trainee_file_login_begin('00000000000000a1','00000000-0000-4000-8000-0000000f5e01','0123456789', now(), now() + interval '15 minutes');
  if r.jti is null or r.sends <> 0 or r.tries <> 0 or r.done_at is not null then raise exception 'FAIL begin: %', r; end if;
  update public.trainee_file_logins set phone = '+15125550100', matched = true where jti = '00000000000000a1';
  select * into r from public.trainee_file_login_begin('00000000000000a1','00000000-0000-4000-8000-0000000f5e01','0123456789', now(), now() + interval '15 minutes');
  if r.phone is distinct from '+15125550100' or not r.matched then raise exception 'FAIL begin again replaced the row: %', r; end if;
  -- texts: three, then refused, unchanged
  for i in 1..3 loop if not public.trainee_file_login_count('00000000000000a1','send',3) then raise exception 'FAIL send % refused', i; end if; end loop;
  if public.trainee_file_login_count('00000000000000a1','send',3) then raise exception 'FAIL a fourth text was allowed'; end if;
  select sends into n from public.trainee_file_logins where jti = '00000000000000a1';
  if n <> 3 then raise exception 'FAIL sends = %', n; end if;
  -- tries: five, then locked
  for i in 1..5 loop if not public.trainee_file_login_count('00000000000000a1','try',5) then raise exception 'FAIL try % refused', i; end if; end loop;
  if public.trainee_file_login_count('00000000000000a1','try',5) then raise exception 'FAIL a sixth try was allowed'; end if;
  begin perform public.trainee_file_login_count('00000000000000a1','other',5); raise exception 'FAIL an unknown count ran'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- used once; nothing counted after
  select * into r from public.trainee_file_login_begin('00000000000000a2','00000000-0000-4000-8000-0000000f5e01','0123456789', now(), now() + interval '15 minutes');
  if not public.trainee_file_login_finish('00000000000000a2', now()) then raise exception 'FAIL the first use was refused'; end if;
  if public.trainee_file_login_finish('00000000000000a2', now()) then raise exception 'FAIL a link was used twice'; end if;
  if public.trainee_file_login_count('00000000000000a2','try',5) or public.trainee_file_login_count('00000000000000a2','send',3) then raise exception 'FAIL counted after the link was used'; end if;
  if public.trainee_file_login_finish('00000000000000ff', now()) then raise exception 'FAIL an unknown link was used'; end if;
  raise notice 'ok   a link''s sign-in is begun once, used once; texts and tries stop at their caps';

  -- sessions: hash only, bound to a phone or a Telegram id, never both or neither
  insert into public.trainee_file_sessions(id_hash,user_id,via,phone,list,expires_at) values
    (repeat('1',64),'00000000-0000-4000-8000-0000000f5e01','phone','+15125550100','0123456789', now() + interval '2 hours'),
    (repeat('2',64),'00000000-0000-4000-8000-0000000f5e01','phone','+15125550100','0123456789', now() + interval '2 hours');
  insert into public.trainee_file_sessions(id_hash,user_id,via,telegram_id,list,expires_at) values
    (repeat('3',64),'00000000-0000-4000-8000-0000000f5e01','telegram','777','0123456789', now() + interval '2 hours'),
    (repeat('4',64),'00000000-0000-4000-8000-0000000f5e02','telegram','888','0123456789', now() + interval '2 hours');
  begin insert into public.trainee_file_sessions(id_hash,user_id,via,list,expires_at) values (repeat('5',64),'00000000-0000-4000-8000-0000000f5e01','phone','0123456789', now() + interval '1 hour'); raise exception 'FAIL a phone session with no phone';
  exception when check_violation then null; end;
  begin insert into public.trainee_file_sessions(id_hash,user_id,via,phone,telegram_id,list,expires_at) values (repeat('5',64),'00000000-0000-4000-8000-0000000f5e01','telegram','+15125550100','777','0123456789', now() + interval '1 hour'); raise exception 'FAIL a session bound two ways';
  exception when check_violation then null; end;
  begin insert into public.trainee_file_sessions(id_hash,user_id,via,phone,list,expires_at) values ('raw-session-id','00000000-0000-4000-8000-0000000f5e01','phone','+15125550100','0123456789', now() + interval '1 hour'); raise exception 'FAIL a raw id stored';
  exception when check_violation then null; end;
  begin insert into public.trainee_file_sessions(id_hash,user_id,via,phone,list,expires_at) values (repeat('6',64),'00000000-0000-4000-8000-0000000f5e01','phone','+15125550100','0123456789', now() + interval '3 days'); raise exception 'FAIL a session longer than a day';
  exception when check_violation then null; end;
  -- sign out everywhere: every open session of that account, nobody else's
  n := public.trainee_file_sessions_revoke_all('00000000-0000-4000-8000-0000000f5e01', now());
  if n <> 3 then raise exception 'FAIL revoke all ended % sessions', n; end if;
  if exists (select 1 from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000f5e01' and revoked_at is null) then raise exception 'FAIL a session survived revoke all'; end if;
  if exists (select 1 from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000f5e02' and revoked_at is not null) then raise exception 'FAIL another account was signed out'; end if;
  if public.trainee_file_sessions_revoke_all('00000000-0000-4000-8000-0000000f5e01', now()) <> 0 then raise exception 'FAIL revoke all twice counted again'; end if;
  raise notice 'ok   sessions are a hash bound one way; sign out everywhere ends exactly that account''s sessions';

  -- the account deleted: its sessions and sign-ins go with it
  delete from auth.users where id = '00000000-0000-4000-8000-0000000f5e01';
  if exists (select 1 from public.trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000000f5e01') or exists (select 1 from public.trainee_file_logins where user_id = '00000000-0000-4000-8000-0000000f5e01') then raise exception 'FAIL a deleted account kept its sessions'; end if;
  raise notice 'ok   a deleted account takes its sessions and sign-ins with it';
end $$;

-- nobody but the service role: not anon, not a signed-in person (not even the session's own account)
do $$
declare who text;
begin
  foreach who in array array['anon','authenticated'] loop
    execute format('set local role %I', who);
    begin perform 1 from public.trainee_file_sessions limit 1; raise exception 'FAIL % read the sessions', who; exception when insufficient_privilege then null; end;
    begin perform 1 from public.trainee_file_logins limit 1; raise exception 'FAIL % read the sign-ins', who; exception when insufficient_privilege then null; end;
    begin perform public.trainee_file_sessions_revoke_all('00000000-0000-4000-8000-0000000f5e02', now()); raise exception 'FAIL % signed someone out', who; exception when insufficient_privilege then null; end;
    begin perform public.trainee_file_login_finish('00000000000000a1', now()); raise exception 'FAIL % used a link', who; exception when insufficient_privilege then null; end;
    begin perform public.trainee_file_login_count('00000000000000a1', 'try', 99); raise exception 'FAIL % counted a try', who; exception when insufficient_privilege then null; end;
    reset role;
  end loop;
  raise notice 'ok   anon and signed-in people cannot read either table or run any of its functions';
end $$;
rollback;
