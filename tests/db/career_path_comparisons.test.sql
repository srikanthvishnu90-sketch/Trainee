-- D-072 files writers (20261112150000_career_path_comparisons.sql), in the database alone: a path comparison is a version, never
-- overwritten; 2 to 4 directions; the owner reads only their own rows, another account and anon read nothing, and no client
-- writes. Deleting the account deletes the rows. Everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000f7201','pc-a@example.test'),('00000000-0000-4000-8000-0000000f7202','pc-b@example.test');
do $$
declare a uuid := '00000000-0000-4000-8000-0000000f7201'; d jsonb := '[{"letter":"A","name":"consulting","said":"consulting","rows":[]},{"letter":"B","name":"product management","said":"product management","rows":[]}]';
begin
  insert into public.career_path_comparisons(user_id,version,title,directions,said,confirmed_facts) values (a,1,'Consulting vs product management',d,'consulting or product management?',2);
  begin update public.career_path_comparisons set title = 'Changed' where user_id = a; raise exception 'FAIL a comparison was overwritten';
  exception when check_violation then null; end;
  begin insert into public.career_path_comparisons(user_id,version,title,directions,said) values (a,1,'again',d,'x'); raise exception 'FAIL a version written twice';
  exception when unique_violation then null; end;
  begin insert into public.career_path_comparisons(user_id,version,title,directions,said) values (a,2,'one',jsonb_build_array(d->0),'x'); raise exception 'FAIL one direction is not a comparison';
  exception when check_violation then null; end;
  begin insert into public.career_path_comparisons(user_id,version,title,directions,said) values (a,2,'five',d||d||jsonb_build_array(d->0),'x'); raise exception 'FAIL five directions accepted';
  exception when check_violation then null; end;
  insert into public.career_path_comparisons(user_id,version,title,directions,said) values (a,2,'Consulting vs product management',d,'compare them again');
  raise notice 'ok   path comparisons: versions, never overwritten; 2 to 4 directions';
end $$;
-- The owner reads their own rows; another account and anon read nothing; no client writes.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000f7201', true);
do $$ begin if (select count(*) from public.career_path_comparisons) <> 2 then raise exception 'FAIL the owner reads both versions'; end if; end $$;
do $$ begin insert into public.career_path_comparisons(user_id,version,title,directions,said) values ('00000000-0000-4000-8000-0000000f7201',9,'x','[{},{}]','x'); raise exception 'FAIL a client wrote';
exception when insufficient_privilege then null; end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000f7202', true);
do $$ begin if (select count(*) from public.career_path_comparisons) <> 0 then raise exception 'FAIL another account reads a comparison'; end if; end $$;
reset role;
set local role anon;
do $$ begin perform 1 from public.career_path_comparisons; raise exception 'FAIL anon reads comparisons';
exception when insufficient_privilege then null; end $$;
reset role;
do $$ begin
  delete from auth.users where id = '00000000-0000-4000-8000-0000000f7201';
  if exists (select 1 from public.career_path_comparisons where user_id = '00000000-0000-4000-8000-0000000f7201') then raise exception 'FAIL rows outlived the account'; end if;
  raise notice 'ok   owner reads own rows; another account and anon read nothing; no client writes; deleted with the account';
end $$;
rollback;
