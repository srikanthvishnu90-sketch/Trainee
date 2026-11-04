-- CHANNEL DELIVERY SCENARIOS (20261030000000_career_outbox_parts_order.sql): a reply in parts at any length (part 51 and
-- part 500 are rows like part 1; a part's key is still its reply's key and its number), and in order: a later part is never
-- claimed while an earlier one is queued, sending, held or waiting for its retry, by the run, by one person's run or by the
-- head start; a part whose earlier part failed for good goes on; only the service role claims. (A claim racing another
-- claim's lock is a two-session test: tests/architect/flow-scenarios-channel-delivery.test.ts.) Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-00000000c0d1','cd-a@example.test'),('00000000-0000-4000-8000-00000000c0d2','cd-b@example.test');
insert into profiles(id) select id from auth.users where email like 'cd-_@example.test';
insert into channel_contacts(contact,user_id,last_inbound_at,created_at) values
 ('+15550004101','00000000-0000-4000-8000-00000000c0d1',now(),now()),('tg:4102','00000000-0000-4000-8000-00000000c0d2',now(),now());
set role service_role;

-- Any number of parts: 120 parts of one reply are 120 rows.
insert into career_outbox(user_id,key,kind,text,deliver_at,channel,part_of,part)
select '00000000-0000-4000-8000-00000000c0d1','reply:big:'||n,'reply','part '||n,now() - interval '1 minute','imessage','reply:big',n from generate_series(1,120) n;
select t.ok((select count(*)=120 and max(part)=120 from career_outbox where part_of='reply:big'),'a reply of 120 parts is 120 rows (it was cut at 50: part 51 failed career_outbox_part)');
select t.must_fail($$insert into career_outbox(user_id,key,kind,text,deliver_at,part_of,part) values('00000000-0000-4000-8000-00000000c0d1','reply:big:0','reply','x',now(),'reply:big',0)$$,'career_outbox_part','a part is numbered from 1');
select t.must_fail($$insert into career_outbox(user_id,key,kind,text,deliver_at,part_of,part) values('00000000-0000-4000-8000-00000000c0d1','reply:big:7','reply','x',now(),'reply:big',700)$$,'career_outbox_part','a part''s key is its reply''s key and its number');
select t.must_fail($$insert into career_outbox(user_id,key,kind,text,deliver_at,part_of,part) values('00000000-0000-4000-8000-00000000c0d1','card:x:2','card','x',now(),'card:x',2)$$,'career_outbox_part','only a reply has parts');
-- One run claims at most 100 rows: the parts go run by run, each run's parts in order and after the last run's.
do $$
declare got int[]; done int := 0; runs int := 0;
begin
  loop
    select array_agg(o.part order by c.deliver_at, c.id) into got from career_outbox_claim(now(), 100) c join career_outbox o on o.id = c.id where o.part_of = 'reply:big';
    exit when got is null;
    if got <> array(select generate_series(done + 1, done + cardinality(got))) then raise exception 'FAIL run % claimed parts % after part %', runs + 1, got, done; end if;
    done := done + cardinality(got);
    update career_outbox set status = 'delivered', delivered_at = now(), claimed_at = null where part_of = 'reply:big' and status = 'sending';
    runs := runs + 1;
    exit when runs > 10;
  end loop;
  if done <> 120 then raise exception 'FAIL only % of 120 parts were claimed', done; end if;
  raise notice 'ok   120 parts claimed run by run, in order (% runs)', runs;
end $$;

-- In order: an earlier part waiting in any way holds every later part, in each of the three claims.
insert into career_outbox(user_id,key,kind,text,deliver_at,channel,part_of,part) values
 ('00000000-0000-4000-8000-00000000c0d2','reply:tg:9:1','reply','one',now() - interval '1 minute','telegram','reply:tg:9',1),
 ('00000000-0000-4000-8000-00000000c0d2','reply:tg:9:2','reply','two',now() - interval '1 minute','telegram','reply:tg:9',2),
 ('00000000-0000-4000-8000-00000000c0d2','reply:tg:9:3','reply','three',now() - interval '1 minute','telegram','reply:tg:9',3);
-- a retry that is due: part 1 goes first, and part 2 is not claimed by the head start before it
update career_outbox set status='failed', attempts=1, retry_at=now() - interval '1 second' where key='reply:tg:9:1';
select t.ok((select count(*)=0 from career_outbox_claim_key('00000000-0000-4000-8000-00000000c0d2','reply:tg:9:2',now())),'the head start does not claim part two while part one''s retry is due (it did)');
select t.ok((select array_agg(key order by deliver_at, id)=array['reply:tg:9:1','reply:tg:9:2','reply:tg:9:3'] from career_outbox_claim_user('00000000-0000-4000-8000-00000000c0d2', now(), 40)),'one person''s run claims the retry first, then the rest, in order');
update career_outbox set status='queued', claimed_at=null, retry_at=null where part_of='reply:tg:9';
-- held (WhatsApp's window), sending (another run), a retry not yet due, a later deliver_at: each holds part two
update career_outbox set status='held' where key='reply:tg:9:1';
select t.ok((select count(*)=0 from career_outbox_claim(now(), 20) where key like 'reply:tg:9:%'),'held part one holds the rest');
update career_outbox set status='sending', claimed_at=now() where key='reply:tg:9:1';
select t.ok((select count(*)=0 from career_outbox_claim_user('00000000-0000-4000-8000-00000000c0d2', now(), 40) where key like 'reply:tg:9:%'),'part one with another run holds the rest');
update career_outbox set status='failed', claimed_at=null, retry_at=now() + interval '5 minutes' where key='reply:tg:9:1';
select t.ok((select count(*)=0 from career_outbox_claim_key('00000000-0000-4000-8000-00000000c0d2','reply:tg:9:3',now())),'part one waiting for its retry holds part three');
-- failed for good: the rest goes on (nothing is waiting for it any more)
update career_outbox set retry_at=null where key='reply:tg:9:1';
select t.ok((select array_agg(key order by deliver_at, id)=array['reply:tg:9:2','reply:tg:9:3'] from career_outbox_claim(now(), 20) where key like 'reply:tg:9:%'),'after a final failure the later parts go, in order');

-- Only the service role claims.
reset role;
set role authenticated;
select t.must_fail($$select * from career_outbox_claim(now(), 1)$$,'permission denied','a person cannot run the claim');
select t.must_fail($$select * from career_outbox_claim_user('00000000-0000-4000-8000-00000000c0d1', now(), 1)$$,'permission denied','a person cannot run one person''s claim');
select t.must_fail($$select * from career_outbox_claim_key('00000000-0000-4000-8000-00000000c0d1','reply:big:1', now())$$,'permission denied','a person cannot run the head start''s claim');
reset role;
rollback;
