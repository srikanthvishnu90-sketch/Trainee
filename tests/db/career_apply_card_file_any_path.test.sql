-- 20261117120000 (D-094 follow-up): a File changed after it was shown approves nothing on any path (the one-transaction
-- Confirm included); the chat opens a card bound to a batch File only when the File lists exactly that batch.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000195a1','anypath-w@example.test');
insert into profiles(id) select id from auth.users where email like 'anypath-%@example.test';
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}' from auth.users where email like 'anypath-%@example.test';
insert into agent_threads(id,user_id,title) values ('00000000-0000-4000-8000-0000000195b1','00000000-0000-4000-8000-0000000195a1','Web');
insert into agent_flow_state(thread_id,user_id,state) select t.id, t.user_id,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-'||t.user_id,'text','AP Intern'))))))
 from agent_threads t where t.id='00000000-0000-4000-8000-0000000195b1';
insert into career_events(user_id,kind,subject,detail) select id,'fact_confirmed','AP Intern',jsonb_build_object('confirmation_event_id','ev-'||id) from auth.users where email like 'anypath-%@example.test';
insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch)
 select id,encode(sha256('%PDF-ap'::bytea),'hex'),'AP.pdf','%PDF-ap'::bytea,1 from auth.users where email like 'anypath-%@example.test';
insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 select '00000000-0000-4000-8000-0000000195a1', 'lever:ap:'||n, 'AP Employer '||n, 'https://jobs.lever.co/ap/'||n,
  jsonb_build_object('resume_sha256',encode(sha256('%PDF-ap'::bytea),'hex'),'n',n), md5('ap'||n)||md5('ap'||n), array['AP Employer '||n]
 from generate_series(1,3) n;
create temp table ord as select id, row_number() over (order by job_id) n, payload_hash from career_apply_prepared where user_id='00000000-0000-4000-8000-0000000195a1';
create temp table allids as select array_agg(id order by n) ids from ord;
grant select on ord, allids to service_role;
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-0000000195a1','tf:file:00000000aa',
 jsonb_build_object('id','00000000aa','userId','00000000-0000-4000-8000-0000000195a1','kind','application_review','state','{}'::jsonb,'revoked_at',null,
  'data', jsonb_build_object('from_prepared',true,'title','3 applications to approve','batch',jsonb_build_object('count',3,'items',
   (select jsonb_agg(jsonb_build_object('n',n,'prepared_id',id,'payload_hash',payload_hash,'employer','x') order by n) from ord)))));
set role service_role;
select t.must_fail($$select career_apply_card_open_batch_as('00000000-0000-4000-8000-0000000195a1',(select ids[1:2] from allids),'00000000aa')$$,'does not list exactly this batch','a File listing more than the card is not its File');
select t.must_fail($$select career_apply_card_open_batch_as('00000000-0000-4000-8000-0000000195a1',(select ids from allids),'00000000bb')$$,'does not list exactly this batch','no such File');
create temp table card as select (career_apply_card_open_batch_as('00000000-0000-4000-8000-0000000195a1',(select ids from allids),'00000000aa')).id c;
reset role;
select t.ok((select file_id='00000000aa' and file_sha=career_apply_batch_file_sha(user_id,'00000000aa') and jsonb_array_length(items)=3 and state='open' from career_apply_cards where id=(select c from card)),'the chat''s card of a paged batch is bound to its File');
-- The File is edited after it was shown: a Confirm of one of its applications (another surface's Approve) confirms nothing.
update career_watch_kv set value=jsonb_set(value,'{data,batch,items,0,employer}','"someone else"') where key='tf:file:00000000aa';
set role service_role;
select t.must_fail($$select career_apply_card_confirm_as('00000000-0000-4000-8000-0000000195a1',(select array[id] from ord where n=1),(select array[payload_hash] from ord where n=1))$$,'FILE_CHANGED','a Confirm of an application on a changed File confirms nothing');
reset role;
select t.ok((select state='open' from career_apply_cards where id=(select c from card)) and not exists (select from career_apply_jobs where user_id='00000000-0000-4000-8000-0000000195a1'),'nothing confirmed, nothing queued, the File card untouched');
select t.must_fail($$select career_apply_card_answer_for('00000000-0000-4000-8000-0000000195a1',(select c from card),array[1,2,3],now())$$,'FILE_CHANGED','and the card''s own yes (and its Approve button) approves nothing');
-- The File as shown: the Confirm goes, as before.
update career_watch_kv set value=jsonb_set(value,'{data,batch,items,0,employer}','"x"') where key='tf:file:00000000aa';
set role service_role;
create temp table conf as select career_apply_card_confirm_as('00000000-0000-4000-8000-0000000195a1',(select array[id] from ord where n=1),(select array[payload_hash] from ord where n=1)) r;
reset role;
select t.ok((select jsonb_array_length(r->'results')=1 from conf),'the File unchanged: the Confirm answers exactly its one application');
set role authenticated;
select t.must_fail($$select career_apply_card_open_batch_as('00000000-0000-4000-8000-0000000195a1',null,null)$$,'permission denied','the File-bound open is the service''s');
reset role;
rollback;
