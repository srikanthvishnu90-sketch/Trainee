-- 20261116140000 (D-094): a large batch is ONE card, a summary plus a File listing every application; the yes approves
-- exactly what the File lists, by payload hash; a File changed after it was shown approves nothing.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000194a1','batchfile-w@example.test');
insert into profiles(id) select id from auth.users where email like 'batchfile-%@example.test';
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}' from auth.users where email like 'batchfile-%@example.test';
insert into agent_threads(id,user_id,title) values ('00000000-0000-4000-8000-0000000194b1','00000000-0000-4000-8000-0000000194a1','Web');
insert into agent_messages(thread_id,role,content,meta) values ('00000000-0000-4000-8000-0000000194b1','assistant','Queued 30.','{"intent":"career_apply_queue"}');
insert into agent_flow_state(thread_id,user_id,state) select t.id, t.user_id,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-'||t.user_id,'text','BF Intern'))))))
 from agent_threads t where t.id='00000000-0000-4000-8000-0000000194b1';
insert into career_events(user_id,kind,subject,detail) select id,'fact_confirmed','BF Intern',jsonb_build_object('confirmation_event_id','ev-'||id) from auth.users where email like 'batchfile-%@example.test';
insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch)
 select id,encode(sha256('%PDF-bf'::bytea),'hex'),'BF.pdf','%PDF-bf'::bytea,1 from auth.users where email like 'batchfile-%@example.test';
-- 30 postings waiting: put makes two parts (25 and 5), ONE batch.
insert into career_apply_wanted(user_id,posting_key,url,company,title)
 select '00000000-0000-4000-8000-0000000194a1', 'lever:bf:'||lpad(n::text,3,'0'), 'https://jobs.lever.co/bf/'||n, 'BF Employer '||n, 'Operations Associate' from generate_series(1,30) n;
set role service_role;
create temp table put as select career_apply_prepare_request_put('00000000-0000-4000-8000-0000000194a1',
 array(select 'lever:bf:'||lpad(n::text,3,'0') from generate_series(1,30) n), null) r;
reset role;
select t.ok((select jsonb_array_length(r->'requests')=2 and (r->>'postings')::int=30 from put),'30 postings: two parts');
select t.ok((select count(*)=2 and count(distinct batch_id)=1 and bool_and(batch_id=(select (r->>'batch')::uuid from put)) from career_apply_prepare_requests
 where user_id='00000000-0000-4000-8000-0000000194a1'),'both parts carry one batch id (the first part''s)');
select t.ok((select batch_id=id from career_apply_prepare_requests where id=(select (r->>'id')::uuid from put)),'the batch id is the first part''s own id');
-- A part the claim splits off stays in the batch.
insert into career_apply_prepare_requests(user_id,job_ids,hosts,outcome) select user_id, array['lever:bf:999'], array['jobs.lever.co'], jsonb_build_object('split_from', id)
 from career_apply_prepare_requests where id=(select (r->>'id')::uuid from put);
select t.ok((select batch_id=(select (r->>'batch')::uuid from put) from career_apply_prepare_requests where job_ids=array['lever:bf:999']),'a split-off part inherits its batch');
delete from career_apply_prepare_requests where job_ids=array['lever:bf:999'];
-- More than 25 postings in one row is allowed now (the parts stay 25 by put; the table no longer encodes a card's size).
select t.ok((select count(*)=0 from pg_constraint where conname='career_apply_prepare_requests_job_ids_check' and pg_get_constraintdef(oid) like '%25%'),'the 1..25 check is raised');

-- Both parts run; each posting made ready.
update career_apply_prepare_requests set state='running', claimed_at=now(), lease_token=gen_random_uuid() where user_id='00000000-0000-4000-8000-0000000194a1';
insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 select '00000000-0000-4000-8000-0000000194a1', 'lever:bf:'||lpad(n::text,3,'0'), 'BF Employer '||n, 'https://jobs.lever.co/bf/'||n,
  jsonb_build_object('resume_sha256',encode(sha256('%PDF-bf'::bytea),'hex'),'n',n), md5(n::text)||md5(n::text), array['BF Employer '||n, 'Email: t@example.test']
 from generate_series(1,30) n;
insert into career_apply_prepare_attempts(user_id,posting_job_id,outcome,prepared_id)
 select user_id, job_id, 'ready', id from career_apply_prepared where user_id='00000000-0000-4000-8000-0000000194a1';
create temp table parts as select id, lease_token, cardinality(job_ids) n from career_apply_prepare_requests where user_id='00000000-0000-4000-8000-0000000194a1' order by created_at, id;
grant select on parts to service_role;
set role service_role;
create temp table d1 as select career_apply_prepare_batch_done(id, lease_token) d from parts where n=25;
create temp table d2 as select career_apply_prepare_batch_done(id, lease_token) d from parts where n=5;
create temp table rd as select * from career_apply_prepare_batch_ready((select id from parts where n=5),(select lease_token from parts where n=5));
reset role;
select t.ok((select (d->>'open')::int=1 and (d->>'requests')::int=2 from d1),'the first part to finish: one still to finish');
select t.ok((select (d->>'open')::int=0 from d2),'the last part to finish sees none left: it shows the batch');
select t.ok((select count(*)=30 from rd),'the batch''s ready applications are all 30, across both parts');
select t.must_fail($$select career_apply_prepare_batch_done((select id from parts where n=5), gen_random_uuid())$$,'invalid prepare lease','another lease finishes nothing');

-- The File: a batch File listing all 30 in order, each at its payload hash.
create temp table ord as select id, row_number() over (order by created_at, id) n, payload_hash from career_apply_prepared where user_id='00000000-0000-4000-8000-0000000194a1';
grant select on ord to service_role;
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-0000000194a1','tf:file:0123456789',
 jsonb_build_object('id','0123456789','userId','00000000-0000-4000-8000-0000000194a1','kind','application_review','state','{}'::jsonb,'revoked_at',null,
  'data', jsonb_build_object('from_prepared',true,'title','Applications to approve','batch',jsonb_build_object('count',30,'items',
   (select jsonb_agg(jsonb_build_object('n',n,'prepared_id',id,'payload_hash',payload_hash,'employer','x') order by n) from ord)))));
insert into career_watch_kv(user_id,key,value) values ('00000000-0000-4000-8000-0000000194a1','tf:file:aaaaaaaaaa',
 jsonb_build_object('id','aaaaaaaaaa','userId','00000000-0000-4000-8000-0000000194a1','kind','application_review','state','{}'::jsonb,'revoked_at',null,
  'data', jsonb_build_object('from_prepared',true,'title','Applications to approve','batch',jsonb_build_object('count',29,'items',
   (select jsonb_agg(jsonb_build_object('n',n,'prepared_id',id,'payload_hash',payload_hash) order by n) from ord where n<30)))));
create temp table allids as select array_agg(id order by n) ids from ord;
grant select on allids to service_role;
set role service_role;
select t.must_fail($$select career_apply_card_push_batch_for('00000000-0000-4000-8000-0000000194a1',(select id from parts where n=5),(select ids from allids),'30 ready. File: https://file.test/x','aaaaaaaaaa',now())$$,'does not list exactly this batch','a File missing one application is not this batch''s File');
select t.must_fail($$select career_apply_card_push_batch_for('00000000-0000-4000-8000-0000000194a1',(select id from parts where n=5),(select ids[2:30] || ids[1:1] from allids),'30 ready. File: https://file.test/x','0123456789',now())$$,'does not list exactly this batch','the File''s numbering is the card''s numbering');
select t.must_fail($$select career_apply_card_push_batch_for('00000000-0000-4000-8000-0000000194a1',(select id from parts where n=5),(select ids from allids),repeat('x',4001),'0123456789',now())$$,'invalid card push','the summary is one text');
create temp table card as select career_apply_card_push_batch_for('00000000-0000-4000-8000-0000000194a1',(select id from parts where n=5),(select ids from allids),
 '30 applications are ready. Every one, with its exact answers: https://file.test/x. Reply "yes" to send all 30.','0123456789',now()) c;
reset role;
select t.ok((select c is not null from card),'ONE card for the whole batch (both parts), the summary plus its File');
select t.ok((select jsonb_array_length(items)=30 and file_id='0123456789' and file_sha=career_apply_batch_file_sha(user_id,'0123456789') from career_apply_cards where id=(select c from card)),'the card carries all 30 and is bound to its File by hash');
select t.ok((select count(*)=1 and bool_and(meta->>'file_id'='0123456789' and (meta->>'items')::int=30) from agent_messages where meta->>'card_id'=(select c from card)::text),'one chat message, naming its File');
-- A File edited after it was shown approves nothing; a no is still taken.
update career_watch_kv set value=jsonb_set(value,'{data,batch,items,1,employer}','"someone else"') where key='tf:file:0123456789';
select t.must_fail($$select career_apply_card_answer_for('00000000-0000-4000-8000-0000000194a1',(select c from card),array(select generate_series(1,30)),now())$$,'FILE_CHANGED','an edited File approves nothing');
select t.must_fail($$select career_apply_card_answer_for('00000000-0000-4000-8000-0000000194a1',(select c from card),array[1],now())$$,'FILE_CHANGED','nor a subset of it');
select t.ok((select state='open' from career_apply_cards where id=(select c from card)),'the refused yes answered nothing');
update career_watch_kv set value=jsonb_set(value,'{data,batch,items,1,employer}','"x"') where key='tf:file:0123456789';
-- A page's own state (a flag) is not the File's listing: it changes nothing.
update career_watch_kv set value=jsonb_set(value,'{state}','{"flags":[{"note":"check 3"}]}') where key='tf:file:0123456789';
update career_watch_kv set value=jsonb_set(value,'{revoked_at}','1') where key='tf:file:0123456789';
select t.must_fail($$select career_apply_card_answer_for('00000000-0000-4000-8000-0000000194a1',(select c from card),array[1],now())$$,'FILE_CHANGED','a revoked File approves nothing');
update career_watch_kv set value=jsonb_set(value,'{revoked_at}','null') where key='tf:file:0123456789';
create temp table ans as select career_apply_card_answer_for('00000000-0000-4000-8000-0000000194a1',(select c from card),array(select generate_series(1,30) except select 2),now()) a;
select t.ok((select jsonb_array_length(a)=30 from ans),'the File unchanged: the yes answers every item of the File');
select t.ok((select (e->>'result')='declined' from ans, jsonb_array_elements(a) e where (e->>'n')::int=2),'"yes except 2": number 2 of the File is left out');
select t.ok((select count(*)=29 from ans, jsonb_array_elements(a) e where e->>'result'<>'declined' and e->>'result'<>'changed'),'every other one of the File is taken by its own hash');
-- An unbound card is unchanged.
select t.ok(not exists (select from career_apply_cards where file_id is null and file_sha is not null),'a card without a File carries no File hash');
set role authenticated;
select t.must_fail($$select career_apply_card_push_batch_for('00000000-0000-4000-8000-0000000194a1',null,null,null,null,null)$$,'permission denied','the batch push is the service''s, not the person''s');
reset role;
rollback;
