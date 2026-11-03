-- The apply VM never takes a queue row on a hash alone (review of #279). career_apply_vm_approval_refusal answers from the stored
-- approval record (the card-cloud bridge's cloud_bound_refusal): present, this person's, this exact payload, unrevoked, unexpired.
-- Run after 20261028180000, with the bridge applied.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000fa001','vmappr-a@example.test'),('00000000-0000-4000-8000-0000000fa002','vmappr-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000000fa001'),('00000000-0000-4000-8000-0000000fa002');
insert into career_watch_kv(user_id,key,value) select u,'career:account','{"epoch":1,"version":1,"paused":false}' from unnest(array['00000000-0000-4000-8000-0000000fa001','00000000-0000-4000-8000-0000000fa002']::uuid[]) u;
insert into career_message_approval_private.test_users(user_id) values ('00000000-0000-4000-8000-0000000fa001'),('00000000-0000-4000-8000-0000000fa002');
create function pg_temp.pl(u text, job text) returns jsonb language sql as $$
 select jsonb_build_object('version',1,'user_id',u,'job_id',job,'company','Appr Co','url','https://jobs.lever.co/apprco/'||job,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at','2099-01-01T00:00:00Z','engine_approval',repeat('e',64),'resume_sha256',repeat('a',64),'destination','https://jobs.lever.co/apprco/'||job) $$;
-- an approval as a tapped card leaves it: used batch approval + bound approval, made before the queue insert (the queue trigger binds the row)
create function pg_temp.approve(u text, job text, p jsonb) returns uuid language plpgsql as $$
declare a uuid; h text := public.career_apply_payload_hash(p);
begin
 insert into career_apply_batch_approvals(user_id,job_id,batch_hash,entry,approved_at,used_at) values (u::uuid,job,h,p,now(),now()) returning id into a;
 insert into career_message_approval_private.cloud_bound_approvals(approval_id,user_id,card_id,item_index,payload_hash,approved_at,expires_at)
  values (a,u::uuid,gen_random_uuid(),0,h,now(),now()+interval '23 hours');
 return a;
end $$;
create function pg_temp.enq(p jsonb) returns uuid language plpgsql as $$
declare id uuid;
begin
 insert into career_apply_jobs(user_id,job_id,company,url,payload,payload_hash,approval_hash)
  values ((p->>'user_id')::uuid,p->>'job_id',p->>'company',p->>'url',p,public.career_apply_payload_hash(p),public.career_apply_payload_hash(p)) returning career_apply_jobs.id into id;
 return id;
end $$;
create function pg_temp.refusal(job text) returns text language sql as $$
 select public.career_apply_vm_approval_refusal(j, now()) from career_apply_jobs j where j.job_id = job $$;

select pg_temp.approve('00000000-0000-4000-8000-0000000fa001','APPR-OK',pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-OK'));
select pg_temp.enq(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-OK'));
select t.ok(pg_temp.refusal('APPR-OK') is null, 'a stored approval for this person and this exact payload: approved');

select pg_temp.enq(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-NONE'));
select t.ok(pg_temp.refusal('APPR-NONE') = 'NOT_APPROVED', 'missing: a direct enqueue with matching hashes and a 64-hex engine_approval token is not an approval');

select pg_temp.approve('00000000-0000-4000-8000-0000000fa001','APPR-HASH',pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-HASH') || '{"changed":true}');
select pg_temp.enq(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-HASH'));
select t.ok(pg_temp.refusal('APPR-HASH') = 'NOT_APPROVED', 'wrong hash: an approval of a different payload does not approve this one');

select pg_temp.approve('00000000-0000-4000-8000-0000000fa001','APPR-REV',pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-REV'));
select pg_temp.enq(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-REV'));
update career_message_approval_private.cloud_bound_approvals set revoked_at = now() where payload_hash = public.career_apply_payload_hash(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-REV'));
select t.ok(pg_temp.refusal('APPR-REV') = 'NOT_APPROVED', 'revoked: refused');

select pg_temp.approve('00000000-0000-4000-8000-0000000fa001','APPR-EXP',pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-EXP'));
select pg_temp.enq(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-EXP'));
update career_message_approval_private.cloud_bound_approvals set approved_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
 where payload_hash = public.career_apply_payload_hash(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-EXP'));
select t.ok(pg_temp.refusal('APPR-EXP') = 'NOT_APPROVED', 'expired: refused');

-- another person's approval (person B approved the identical application) does not approve person A's row
select pg_temp.approve('00000000-0000-4000-8000-0000000fa002','APPR-OTH',pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-OTH'));
select pg_temp.enq(pg_temp.pl('00000000-0000-4000-8000-0000000fa001','APPR-OTH'));
select t.ok(pg_temp.refusal('APPR-OTH') = 'NOT_APPROVED', 'another person''s approval: refused');

-- The settings key list is additive (20261028180000 read it from pg_constraint): every key allowed before is still allowed, rows survive,
-- and a second application changes nothing.
\set vmmig `echo "$UPMORE_ROOT/supabase/migrations/20261028180000_career_apply_vm_worker.sql"`
delete from career_cloud_settings;
insert into career_cloud_settings(key,value) values ('CAREER_CLOUD_APPLY','off'),('owner_user_id','x'),('gate_user_ids','x'),('CAREER_AGENT_SUBMIT','off'),('CAREER_CLOUD_TEXT_CARDS','on');
\i :vmmig
\i :vmmig
select t.ok((select count(*) = 5 from career_cloud_settings), 'existing settings rows survive the migration, twice');
select t.ok((select bool_and(pg_get_constraintdef((select oid from pg_constraint where conname = 'career_cloud_settings_key_check')) like '%' || k || '%')
 from unnest(array['CAREER_CLOUD_APPLY','owner_user_id','gate_user_ids','CAREER_AGENT_SUBMIT','CAREER_CLOUD_TEXT_CARDS','APPLY_VM','APPLY_VM_USER_IDS','APPLY_VM_ALLOW_LOCAL']) k),
 'every key allowed before (CAREER_CLOUD_TEXT_CARDS included) is still allowed, and the three VM keys are added');
insert into career_cloud_settings(key,value) values ('APPLY_VM','off'),('APPLY_VM_USER_IDS','x'),('APPLY_VM_ALLOW_LOCAL','off');
update career_cloud_settings set value = 'off' where key = 'CAREER_CLOUD_TEXT_CARDS';
select t.must_fail($$insert into career_cloud_settings(key,value) values ('NOT_A_KEY','x')$$, 'career_cloud_settings_key_check', 'an unknown key is still refused');

select t.ok(not has_function_privilege('authenticated', 'public.career_apply_vm_approval_refusal(public.career_apply_jobs,timestamptz)', 'EXECUTE')
 and not has_function_privilege('anon', 'public.career_apply_vm_approval_refusal(public.career_apply_jobs,timestamptz)', 'EXECUTE')
 and not has_function_privilege('apply_vm_worker', 'public.career_apply_vm_approval_refusal(public.career_apply_jobs,timestamptz)', 'EXECUTE'), 'the check is not callable by the people or the worker role');
rollback;
