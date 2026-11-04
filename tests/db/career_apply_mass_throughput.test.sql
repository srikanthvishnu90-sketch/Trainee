-- 20261101120000 + 20261101121000 (mass apply throughput, review of #384): the cloud throttle's failure-rate rule waits
-- for 20 attempts, a site that is really down pauses after 3 failures in a row, a closed posting (not_sent) is never a
-- failure; a preparation that failed on our side is a candidate again after 30 minutes (a refusal: after 7 days).
-- Everything rolls back.
begin;
reset role;
delete from career_apply_cloud_pauses; delete from career_outbox where key like 'status:cloud-pause:%'; delete from career_apply_cloud_events;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000011a0001','tp-a@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000011a0001');

-- 1. One error in a fresh window of 5: no pause (was: paused for 6 hours).
insert into career_apply_cloud_events(user_id,portal,outcome,at) select '00000000-0000-4000-8000-0000011a0001','lever','submitted',now()-interval '1 minute' from generate_series(1,4);
insert into career_apply_cloud_events(user_id,portal,outcome,error_kind,at) values ('00000000-0000-4000-8000-0000011a0001','lever','error','FORM_DID_NOT_SETTLE',now());
select career_apply_cloud_throttle('lever',null,clock_timestamp());
select t.ok(not exists(select from career_apply_cloud_pauses where portal='lever'),'one error in 5 attempts does not pause the ATS for everyone');
-- 2. Two in a row: still no pause; the third in a row: paused, named.
insert into career_apply_cloud_events(user_id,portal,outcome,error_kind,at) values ('00000000-0000-4000-8000-0000011a0001','lever','error','FORM_DID_NOT_SETTLE',now());
select career_apply_cloud_throttle('lever',null,clock_timestamp());
select t.ok(not exists(select from career_apply_cloud_pauses where portal='lever'),'two failures in a row do not pause');
insert into career_apply_cloud_events(user_id,portal,outcome,error_kind,at) values ('00000000-0000-4000-8000-0000011a0001','lever','error','FORM_DID_NOT_SETTLE',now());
select career_apply_cloud_throttle('lever',null,clock_timestamp());
select t.ok((select count(*)=1 and bool_and(reason like 'consecutive_errors%') from career_apply_cloud_pauses where portal='lever'),'three failures in a row pause the ATS (a site that is down)');
-- 3. A closed posting (not_sent) between failures is no failure and breaks no run of them; 3 errors with a success between: no pause.
delete from career_apply_cloud_pauses; delete from career_apply_cloud_events;
insert into career_apply_cloud_events(user_id,portal,outcome,error_kind,at) values
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','X',now()-interval '4 minute'),('00000000-0000-4000-8000-0000011a0001','greenhouse','not_sent','POSTING_CLOSED',now()-interval '3 minute'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','submitted',null,now()-interval '2 minute'),('00000000-0000-4000-8000-0000011a0001','greenhouse','error','X',now()-interval '1 minute'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','X',now());
select career_apply_cloud_throttle('greenhouse',null,clock_timestamp());
select t.ok(not exists(select from career_apply_cloud_pauses where portal='greenhouse'),'errors broken by a success do not pause; a closed posting is not a failure');
-- 3b. Our own browser crashing is not the site failing: 3 DRIVER_ERRORs in a row (one at Submit, and one engine with no
--     result) do not pause; between them, they do not break a run of the site's own failures either.
delete from career_apply_cloud_pauses; delete from career_apply_cloud_events;
insert into career_apply_cloud_events(user_id,portal,outcome,error_kind,at) values
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','submitted',null,now()-interval '5 minute'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','DRIVER_ERROR',now()-interval '4 minute'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','DRIVER_ERROR_AT_SUBMIT',now()-interval '3 minute'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','ENGINE_NO_RESULT',now()-interval '2 minute'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','DRIVER_ERROR',now()-interval '1 minute');
select career_apply_cloud_throttle('greenhouse',null,clock_timestamp());
select t.ok(not exists(select from career_apply_cloud_pauses where portal='greenhouse'),'our own browser crashing 4 times in a row does not pause the ATS for everyone');
insert into career_apply_cloud_events(user_id,portal,outcome,error_kind,at) values
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','FORM_DID_NOT_SETTLE',now()-interval '50 second'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','DRIVER_ERROR',now()-interval '40 second'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','FORM_DID_NOT_SETTLE',now()-interval '30 second'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','DRIVER_ERROR',now()-interval '20 second'),
 ('00000000-0000-4000-8000-0000011a0001','greenhouse','error','FORM_DID_NOT_SETTLE',now());
select career_apply_cloud_throttle('greenhouse',null,clock_timestamp());
select t.ok((select count(*)=1 and bool_and(reason like 'consecutive_errors%') from career_apply_cloud_pauses where portal='greenhouse'),'3 site failures in a row pause, with our crashes between them left out');
-- 4. The 2% rule at a real sample, as before: 1 error in the last 50.
delete from career_apply_cloud_pauses; delete from career_apply_cloud_events;
insert into career_apply_cloud_events(user_id,portal,outcome,at) select '00000000-0000-4000-8000-0000011a0001','ashby','submitted',now()-interval '1 minute' from generate_series(1,49);
insert into career_apply_cloud_events(user_id,portal,outcome,error_kind,at) values('00000000-0000-4000-8000-0000011a0001','ashby','error','X',now());
select career_apply_cloud_throttle('ashby',null,clock_timestamp());
select t.ok((select count(*)=1 and bool_and(reason like 'failure_rate: 1 of the last 50%') from career_apply_cloud_pauses where portal='ashby'),'1 failure in the last 50 still pauses (2%)');

-- 5. Preparation: our error retried after 30 minutes; the employer's refusal after 7 days.
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-0000011a0001','career:account','{"epoch":0,"version":0,"paused":false}') on conflict do nothing;
insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at) values
 ('lever:tpco:1','lever','tpco','1','TP Co','Analyst','https://jobs.lever.co/tpco/1',now(),now()),
 ('lever:tpco2:2','lever','tpco2','2','TP Two','Analyst','https://jobs.lever.co/tpco2/2',now(),now());
insert into career_apply_wanted(user_id,posting_key,url,company,title) values
 ('00000000-0000-4000-8000-0000011a0001','lever:tpco:1','https://jobs.lever.co/tpco/1','TP Co','Analyst'),
 ('00000000-0000-4000-8000-0000011a0001','lever:tpco2:2','https://jobs.lever.co/tpco2/2','TP Two','Analyst');
insert into career_apply_prepare_attempts(user_id,posting_job_id,outcome,detail,at) values
 ('00000000-0000-4000-8000-0000011a0001','lever:tpco:1','error','DRIVER_ERROR',now()-interval '40 minutes'),
 ('00000000-0000-4000-8000-0000011a0001','lever:tpco2:2','refused','IDENTITY_NUMBER_REQUESTED',now()-interval '40 minutes');
select t.ok((select array_agg(job_id order by job_id) from career_apply_prepare_candidates(now(),25,500) where user_id='00000000-0000-4000-8000-0000011a0001')='{lever:tpco:1}',
 'our error is a candidate again after 30 minutes; a refusal is not (7 days)');
update career_apply_prepare_attempts set at = now() - interval '10 minutes' where posting_job_id = 'lever:tpco:1';
select t.ok(not exists(select from career_apply_prepare_candidates(now(),25,500) where user_id='00000000-0000-4000-8000-0000011a0001'),'within 30 minutes of our error: not yet');
rollback;
