-- 20261031000000_career_apply_cloud_authorize_closed.sql: the card-bound cloud route's last check before Submit
-- (career_apply_message_cloud_authorize) ends an application whose posting closed as not sent, in the person's words, and
-- answers authorized: false; an open posting is not touched by it; the reconcile keeps the rewrite; service only.
-- Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-00000031ac01','races-a@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-00000031ac01');
update career_apply_jobs set state = 'not_submitted', reason = 'TEST closed before the races test' where state in ('queued', 'driving');

-- 1. The card-bound cloud route's check before Submit.
do $$ begin
 if to_regprocedure('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)') is null then
  raise notice 'ok   (skipped: the card-cloud bridge is not installed here)'; end if;
end $$;
insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at,closed_at) values
 ('greenhouse:racesco:1','greenhouse','racesco','1','Races Co','Analyst','https://boards.greenhouse.io/racesco/jobs/1',now(),now(),now()),
 ('greenhouse:racesco:2','greenhouse','racesco','2','Races Co','Analyst','https://boards.greenhouse.io/racesco/jobs/2',now(),now(),null);
alter table public.career_apply_jobs disable trigger user;
insert into career_apply_jobs(id,user_id,job_id,company,url,payload,payload_hash,approval_hash,state,source,attempts,lease_token,claimed_at) values
 ('00000000-0000-4000-8000-00000031ad01','00000000-0000-4000-8000-00000031ac01','greenhouse:racesco:1','Races Co','https://boards.greenhouse.io/racesco/jobs/1',
  '{}',repeat('d',64),repeat('d',64),'driving','cloud',1,'00000000-0000-4000-8000-00000031ae01',clock_timestamp()),
 ('00000000-0000-4000-8000-00000031ad02','00000000-0000-4000-8000-00000031ac01','greenhouse:racesco:2','Races Co','https://boards.greenhouse.io/racesco/jobs/2',
  '{}',repeat('d',64),repeat('d',64),'driving','cloud',1,'00000000-0000-4000-8000-00000031ae02',clock_timestamp());
alter table public.career_apply_jobs enable trigger user;
create temp table auth_closed(r jsonb);
do $$ begin
 if to_regprocedure('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)') is not null then
  insert into auth_closed select public.career_apply_message_cloud_authorize('00000000-0000-4000-8000-00000031ad01',
   '00000000-0000-4000-8000-00000031ae01', repeat('d',64), repeat('0',64));
 end if;
end $$;
select t.ok(to_regprocedure('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)') is null
 or (select r->>'authorized' = 'false' and r->>'refused' = 'posting_closed' and r->>'reason' = 'not sent: the posting closed before we sent it' from auth_closed),
 'the posting closed: not authorized, and it says why');
select t.ok(to_regprocedure('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)') is null
 or (select state = 'not_submitted' and reason = 'not sent: the posting closed before we sent it' and evidence->>'closed' = 'posting_closed'
  and (evidence->>'nothing_sent')::boolean from career_apply_jobs where id = '00000000-0000-4000-8000-00000031ad01'),
 'ended: not sent, the posting closed before we sent it (the claims'' own words)');
select t.ok(to_regprocedure('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)') is null
 or exists (select from career_apply_cloud_events where job_id = '00000000-0000-4000-8000-00000031ad01' and outcome = 'not_sent' and error_kind = 'posting_closed'),
 'the cloud outcome recorded: not sent, posting_closed');
-- An open posting: this check does not end it (whatever else refuses it here, the row is still being driven).
do $$ begin
 if to_regprocedure('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)') is not null then
  begin
   perform public.career_apply_message_cloud_authorize('00000000-0000-4000-8000-00000031ad02', '00000000-0000-4000-8000-00000031ae02', repeat('d',64), repeat('0',64));
  exception when others then
   if sqlerrm ~ 'posting_closed' then raise exception 'FAIL an open posting refused as closed'; end if;
  end;
 end if;
end $$;
select t.ok((select state = 'driving' from career_apply_jobs where id = '00000000-0000-4000-8000-00000031ad02'), 'an open posting: still being driven');
-- The reconcile (run after every apply) keeps the rewrite; the install is idempotent.
select public.career_apply_reconcile_bridge();
select t.ok(to_regprocedure('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)') is null
 or position('posting_closed' in pg_get_functiondef('public.career_apply_message_cloud_authorize(uuid,uuid,text,text)'::regprocedure)) > 0,
 'the reconcile keeps the closed-posting check');
select t.ok(public.career_apply_cloud_authorize_closed_install() in ('rewritten 0', 'not installed'), 'installed once: nothing to rewrite again');

-- 2. Service only.
select t.as_user('00000000-0000-4000-8000-00000031ac01');
set role authenticated;
select t.must_fail($$select public.career_apply_cloud_authorize_closed_install()$$, 'permission denied', 'a person cannot rewrite the check');
reset role;
rollback;
