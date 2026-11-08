-- 20261108100000 (R9-G2, D-MS-1 paged): a batch too big for one text is ONE card in numbered pages; its yes approves only
-- once every page was delivered, and only while the set of applications is the set it showed (APPROVAL_SET_CHANGED).
begin;
reset role;
-- W reads in the web chat only (no texting thread); X texts (a thread on a texting contact): its pages go through the outbox.
insert into auth.users(id,email) values('00000000-0000-4000-8000-0000000108a1','pages-w@example.test'),('00000000-0000-4000-8000-0000000108a2','pages-x@example.test');
insert into profiles(id) select id from auth.users where email like 'pages-%@example.test';
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}' from auth.users where email like 'pages-%@example.test';
insert into agent_threads(id,user_id,title) values ('00000000-0000-4000-8000-0000000108b1','00000000-0000-4000-8000-0000000108a1','Web'),
 ('00000000-0000-4000-8000-0000000108b2','00000000-0000-4000-8000-0000000108a2','Texts');
insert into agent_messages(thread_id,role,content,meta) values ('00000000-0000-4000-8000-0000000108b1','assistant','Queued 3.','{"intent":"career_apply_queue"}'),
 ('00000000-0000-4000-8000-0000000108b2','assistant','Queued 3.','{"intent":"career_apply_queue"}');
insert into channel_contacts(contact,user_id,thread_id,opted_out) values ('+15550108002','00000000-0000-4000-8000-0000000108a2','00000000-0000-4000-8000-0000000108b2',false);
-- Both have a confirmed resume on file and keep one in the cloud (a card shows only applications that send a resume).
insert into agent_flow_state(thread_id,user_id,state) select t.id, t.user_id,
 jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('id','f1','kind','experience','status','confirmed','needs_confirmation',false,'confirmation_event_id','ev-'||t.user_id,'text','Pages Intern'))))))
 from agent_threads t where t.id in ('00000000-0000-4000-8000-0000000108b1','00000000-0000-4000-8000-0000000108b2');
insert into career_events(user_id,kind,subject,detail) select id,'fact_confirmed','Pages Intern',jsonb_build_object('confirmation_event_id','ev-'||id) from auth.users where email like 'pages-%@example.test';
insert into career_apply_cloud_resumes(user_id,sha256,filename,bytes,privacy_epoch)
 select id,encode(sha256('%PDF-pages'::bytea),'hex'),'Pages.pdf','%PDF-pages'::bytea,1 from auth.users where email like 'pages-%@example.test';
insert into career_apply_prepared(user_id,job_id,company,url,payload,payload_hash,card_lines)
 select u, 'TEST-PAGES-'||right(u::text,1)||'-'||n, 'Pages Employer '||n, 'https://jobs.lever.co/pages/'||n, jsonb_build_object('resume_sha256',encode(sha256('%PDF-pages'::bytea),'hex')), repeat(n::text,64),
  array['Pages Employer '||n, 'Email: t@example.test', 'Sends to https://jobs.lever.co/pages/'||n]
 from unnest(array['00000000-0000-4000-8000-0000000108a1','00000000-0000-4000-8000-0000000108a2']::uuid[]) u, generate_series(1,3) n;
insert into career_apply_prepare_requests(id,user_id,job_ids,hosts,state)
 select ('00000000-0000-4000-8000-0000000108c'||right(u::text,1))::uuid, u, array['p1','p2','p3'], array['jobs.lever.co','jobs.lever.co','jobs.lever.co'], 'running'
 from unnest(array['00000000-0000-4000-8000-0000000108a1','00000000-0000-4000-8000-0000000108a2']::uuid[]) u;
insert into career_apply_prepare_attempts(user_id,posting_job_id,outcome,prepared_id)
 select p.user_id, 'p'||right(p.job_id,1), 'ready', p.id from career_apply_prepared p where p.job_id like 'TEST-PAGES-%';
create temp table ids as select user_id, array_agg(id order by job_id) as all3 from career_apply_prepared where job_id like 'TEST-PAGES-%' group by user_id;
create temp table pg as select user_id,
 array['1/2'||E'\n'||'3 applications are ready.'||E'\n\n'||'1. Pages Employer 1'||E'\n'||'Email: t@example.test'||E'\n'||'Sends to https://jobs.lever.co/pages/1'||E'\n\n'||'2. Pages Employer 2'||E'\n'||'Email: t@example.test'||E'\n'||'Sends to https://jobs.lever.co/pages/2',
       '2/2'||E'\n'||'3. Pages Employer 3'||E'\n'||'Email: t@example.test'||E'\n'||'Sends to https://jobs.lever.co/pages/3'||E'\n\n'||'Reply "yes" to send all 3.'] as pages
 from ids;
grant select on ids, pg to service_role;
create function pg_temp.req(u uuid) returns uuid language sql as $$ select ('00000000-0000-4000-8000-0000000108c'||right(u::text,1))::uuid $$;

set role service_role;
select t.must_fail($$select career_apply_card_push_paged_for('00000000-0000-4000-8000-0000000108a1',pg_temp.req('00000000-0000-4000-8000-0000000108a1'),(select all3 from ids where user_id='00000000-0000-4000-8000-0000000108a1'),array['1/1 one page'],now())$$,'invalid card push','one page is a one-text card, not a paged one');
select t.must_fail($$select career_apply_card_push_paged_for('00000000-0000-4000-8000-0000000108a1',pg_temp.req('00000000-0000-4000-8000-0000000108a1'),(select all3 from ids where user_id='00000000-0000-4000-8000-0000000108a1'),array[(select pages[2] from pg limit 1),(select pages[1] from pg limit 1)],now())$$,'invalid card push','every page opens with its own number, in order');
select t.must_fail($$select career_apply_card_push_paged_for('00000000-0000-4000-8000-0000000108a1',pg_temp.req('00000000-0000-4000-8000-0000000108a1'),(select all3 from ids where user_id='00000000-0000-4000-8000-0000000108a1'),array['1/2 x',repeat('y',4001)],now())$$,'invalid card push','a page is one text: at most 4,000 characters');
select t.must_fail($$select career_apply_card_push_paged_for('00000000-0000-4000-8000-0000000108a1',pg_temp.req('00000000-0000-4000-8000-0000000108a1'),(select all3 from ids where user_id='00000000-0000-4000-8000-0000000108a1'),array[(select pages[1] from pg limit 1),'2/2 the rest'],now())$$,'carry every line','the pages together carry every line of every application');
create temp table w as select career_apply_card_push_paged_for(i.user_id,pg_temp.req(i.user_id),i.all3,p.pages,now()) as card from ids i join pg p using (user_id) where i.user_id='00000000-0000-4000-8000-0000000108a1';
create temp table x as select career_apply_card_push_paged_for(i.user_id,pg_temp.req(i.user_id),i.all3,p.pages,now()) as card from ids i join pg p using (user_id) where i.user_id='00000000-0000-4000-8000-0000000108a2';
reset role;
select t.ok((select card is not null from w) and (select card is not null from x),'a paged card is pushed for both');
select t.ok((select pages=2 and jsonb_array_length(items)=3 and set_hash=career_apply_card_set_hash(id) from career_apply_cards where id=(select card from w)),'ONE card of all three, its one hash over every payload hash in order');
select t.ok((select set_hash=encode(sha256(convert_to(repeat('1',64)||','||repeat('2',64)||','||repeat('3',64),'UTF8')),'hex') from career_apply_cards where id=(select card from w)),'the set hash is sha256 of the payload hashes in card order');
select t.ok((select count(*)=2 and bool_and(meta->>'intent'='career_apply_card' and meta->>'card_id'=(select card from w)::text) from agent_messages where thread_id='00000000-0000-4000-8000-0000000108b1' and meta ? 'page'),'each page is its own message in the thread, naming the card');
select t.ok((select array_agg(content order by id) = (select pages from pg where user_id='00000000-0000-4000-8000-0000000108a1') from agent_messages where thread_id='00000000-0000-4000-8000-0000000108b1' and meta ? 'page'),'the pages exactly as given, in order');
select t.ok((select count(*)=2 and bool_and(delivered_at is not null) from career_apply_card_pages where card_id=(select card from w)),'web chat: written in the thread is delivered');
select t.ok((select count(*)=0 from career_outbox where user_id='00000000-0000-4000-8000-0000000108a1'),'web chat: nothing in the texting outbox');
select t.ok((select count(*)=2 and bool_and(card_id=(select card from x)) from career_outbox where user_id='00000000-0000-4000-8000-0000000108a2' and kind='card'),'texting: each page into the outbox, bound to the card');
select t.ok((select count(*)=2 and bool_and(delivered_at is null) from career_apply_card_pages where card_id=(select card from x)),'texting: no page counts as delivered before the outbox delivers it');

-- X: a yes before every page reached them approves nothing; a no is always taken.
select t.must_fail($$select career_apply_card_answer_for('00000000-0000-4000-8000-0000000108a2',(select card from x),array[1,2,3],now())$$,'card_pages_undelivered','a yes with no page delivered approves nothing');
update career_outbox set status='delivered', delivered_at=now() where user_id='00000000-0000-4000-8000-0000000108a2' and key like '%:1';
select t.ok((select delivered_at is not null from career_apply_card_pages where card_id=(select card from x) and page=1),'the outbox delivering page 1 records it');
select t.must_fail($$select career_apply_card_answer_for('00000000-0000-4000-8000-0000000108a2',(select card from x),array[1,2,3],now())$$,'card_pages_undelivered','one page of two delivered still approves nothing');
update career_outbox set status='delivered', delivered_at=now() where user_id='00000000-0000-4000-8000-0000000108a2' and key like '%:2';
update career_outbox set status='held', delivered_at=null where user_id='00000000-0000-4000-8000-0000000108a2' and key like '%:2';
select t.ok((select delivered_at is null from career_apply_card_pages where card_id=(select card from x) and page=2),'a page the provider later held is not delivered any more');
update career_outbox set status='delivered', delivered_at=now() where user_id='00000000-0000-4000-8000-0000000108a2' and key like '%:2';
-- The set changes after the showing: the whole yes is refused.
update career_apply_prepared set payload_hash=repeat('f',64) where user_id='00000000-0000-4000-8000-0000000108a2' and job_id like '%-2';
select t.must_fail($$select career_apply_card_answer_for('00000000-0000-4000-8000-0000000108a2',(select card from x),array[1,2,3],now())$$,'APPROVAL_SET_CHANGED','a changed application changes the set: the yes is refused');
select t.ok((select state='open' from career_apply_cards where id=(select card from x)),'a refused yes leaves the card open and answers nothing');
update career_apply_prepared set payload_hash=repeat('2',64) where user_id='00000000-0000-4000-8000-0000000108a2' and job_id like '%-2';
create temp table ans as select career_apply_card_answer_for('00000000-0000-4000-8000-0000000108a2',(select card from x),array[1,2,3],now()) a;
select t.ok((select jsonb_array_length(a)=3 from ans) and (select state='answered' from career_apply_cards where id=(select card from x)),'every page delivered and the set unchanged: the yes answers the card, every item by its own hash');
-- W: a no needs no delivery check.
create temp table no as select career_apply_card_answer_for('00000000-0000-4000-8000-0000000108a1',(select card from w),array[]::int[],now()) a;
select t.ok((select bool_and(e->>'result'='declined') from no, jsonb_array_elements(a) e),'a no declines every item');
-- A one-text card is unchanged: no pages, no set hash.
select t.ok(not exists (select from career_apply_cards where pages is null and set_hash is not null),'a one-text card carries no set hash');
select t.must_fail($$insert into career_apply_card_pages(card_id,user_id,page,pages,text_sha256) values ((select card from w),'00000000-0000-4000-8000-0000000108a1',3,2,repeat('a',64))$$,'check','a page past the last is refused');
set role authenticated;
select t.must_fail($$select * from career_apply_card_pages$$,'permission denied','the page rows are the service''s, not the person''s');
select t.must_fail($$select career_apply_card_push_paged_for('00000000-0000-4000-8000-0000000108a1',gen_random_uuid(),array[gen_random_uuid()],array['1/2 a','2/2 b'],now())$$,'permission denied','a person cannot push a card');
reset role;
rollback;
