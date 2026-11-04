-- No pace of Trainee's own; only a portal's refusal holds work back (20261027140000_career_apply_host_backoff.sql, applied
-- with 20261027141000; owner, 2026-10-27: "no person limit, never set a limit"). A host with no refusal is never held,
-- however many drives go to it at once. A refusal holds that host back for that address (the cloud, or the person's own
-- computer) for the portal's Retry-After, or 30 s doubling; the first accepted request ends it.
begin;
reset role;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-00000000f101','backoff-a@example.test'),('00000000-0000-4000-8000-00000000f102','backoff-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-00000000f101'),('00000000-0000-4000-8000-00000000f102');
insert into career_watch_kv(user_id,key,value) select id,'career:account','{"epoch":1,"version":1,"paused":false}'::jsonb from profiles
 where id::text like '00000000-0000-4000-8000-00000000f10%';
create function pg_temp.q(u text, job text, url text) returns uuid language plpgsql as $$
declare p jsonb; h text;
begin
 p := jsonb_build_object('version',1,'user_id',u,'job_id',job,'company','Backoff Co '||job,'url',url,'fields','[]'::jsonb,
  'privacy_epoch',1,'account_version',1,'expires_at',now()+interval '1 day');
 h := career_apply_payload_hash(p);
 return (career_apply_enqueue(p,h,h)).id;
end $$;
-- 40 approved applications on one host for one person, 10 on another host.
select pg_temp.q('00000000-0000-4000-8000-00000000f101', 'bo:'||g, 'https://jobs.lever.co/acme/'||g) from generate_series(1,40) g;
select pg_temp.q('00000000-0000-4000-8000-00000000f101', 'bo:x'||g, 'https://jobs.ashbyhq.com/other/'||g) from generate_series(1,10) g;
select pg_temp.q('00000000-0000-4000-8000-00000000f102', 'bo:b'||g, 'https://jobs.lever.co/acme/b'||g) from generate_series(1,5) g;

-- No refusal: the person's computer takes all 50 at once, 40 of them on one host (no spacing, no per-host number).
select t.as_user('00000000-0000-4000-8000-00000000f101');
set role authenticated;
create temp table c1 as select * from career_apply_claim_own(1000, 'own_computer');
reset role;
select t.ok((select count(*) = 50 and count(*) filter (where url like 'https://jobs.lever.co/%') = 40 from c1),
 'no refusal: all 50 claimed at once, 40 on one host (' || (select count(*) from c1) || ')');
select t.ok(not (career_apply_host_wait('https://jobs.lever.co/acme/1', '00000000-0000-4000-8000-00000000f101', now())->>'waiting')::boolean,
 'no refusal: the host is not waiting');

-- The portal answers 429 with Retry-After 120 to one drive: that host, for that person's computer, waits 120 s.
create temp table r1 as select career_apply_host_refused_for((select id from c1 where job_id='bo:1'), (select lease_token from c1 where job_id='bo:1'),
 'rate_limited', 120, now()) v;
select t.ok((select (v->>'wait_seconds')::int = 120 and v->>'reason' = 'rate_limited' and v->>'scope' = '00000000-0000-4000-8000-00000000f101' from r1),
 'a 429 with Retry-After 120: the host waits 120 seconds, for this person''s own computer');
-- Its queued applications on that host are not handed out while it waits; another host's are.
update career_apply_jobs set state='not_submitted' where user_id='00000000-0000-4000-8000-00000000f101' and state='driving';
select pg_temp.q('00000000-0000-4000-8000-00000000f101', 'bo:late1', 'https://jobs.lever.co/acme/late1');
select pg_temp.q('00000000-0000-4000-8000-00000000f101', 'bo:late2', 'https://jobs.ashbyhq.com/other/late2');
select t.as_user('00000000-0000-4000-8000-00000000f101');
set role authenticated;
create temp table c2 as select * from career_apply_claim_own(1000, 'own_computer');
reset role;
select t.ok((select count(*) = 1 and bool_and(job_id = 'bo:late2') from c2), 'while it waits: the refused host''s application stays queued, the other host''s goes');
select t.ok((select state = 'queued' from career_apply_jobs where job_id='bo:late1'), 'the held one is still queued, not refused');
-- The cloud's address is a different scope: the person's refusal does not hold the cloud back.
select t.ok(not (career_apply_host_wait('https://jobs.lever.co/acme/1', 'cloud', now())->>'waiting')::boolean, 'the cloud is not held by a refusal to the person''s own computer');
-- What the person is told, from the record.
select t.ok((select (v->>'waiting')::boolean and v->>'reason' = 'rate_limited' and (v->>'wait_seconds')::int between 100 and 120
 from (select career_apply_host_wait('https://www.jobs.lever.co/acme/9', '00000000-0000-4000-8000-00000000f101', now()) v) x),
 'the wait is readable for the person: why and until when (www. is the same host)');

-- No Retry-After: 30 s, then doubling with each refusal in a row.
select career_apply_host_ok_for((select id from c2), (select lease_token from c2), now());
select t.ok(not (career_apply_host_wait('https://jobs.ashbyhq.com/other/1', '00000000-0000-4000-8000-00000000f101', now())->>'waiting')::boolean, 'an accepted request: no wait');
create temp table r2 as select n, career_apply_host_refused_for((select id from c2), (select lease_token from c2), 'server_busy', null, now() + make_interval(secs => n)) v
 from generate_series(1,3) n;
select t.ok((select array_agg((v->>'refusals')::int order by n) = '{1,2,3}' from r2), 'refusals in a row are counted');
select t.ok((select (v->>'until')::timestamptz = now() + interval '1 second' + interval '30 seconds' from r2 where n = 1)
 and (select (v->>'until')::timestamptz = now() + interval '3 seconds' + interval '120 seconds' from r2 where n = 3),
 'no Retry-After: 30 s, then 60, then 120');
-- The first accepted request ends the wait and starts the doubling over.
select career_apply_host_ok_for((select id from c2), (select lease_token from c2), now() + interval '4 seconds');
select t.ok(not (career_apply_host_wait('https://jobs.ashbyhq.com/other/1', '00000000-0000-4000-8000-00000000f101', now() + interval '5 seconds')->>'waiting')::boolean,
 'the portal accepted again: the host resumes at once');
select t.ok((select (career_apply_host_refused_for((select id from c2), (select lease_token from c2), 'rate_limited', null, now() + interval '6 seconds')->>'refusals')::int = 1),
 'and the next refusal starts again at one');
-- A bot wall is recorded for the host too (the drive itself ends needs_user and is never retried; no captcha solving).
select t.ok((select career_apply_host_refused_for((select id from c2), (select lease_token from c2), 'bot_wall', null, now() + interval '7 seconds')->>'reason') = 'bot_wall',
 'a bot wall holds the host back too');

-- Only the drive holding the lease reports; only for a real refusal; a person only for their own job.
select t.must_fail($$select career_apply_host_refused_for((select id from c2), gen_random_uuid(), 'rate_limited', null, now())$$, 'invalid apply claim',
 'without the lease nothing is recorded');
select t.must_fail($$select career_apply_host_refused_for((select id from c2), (select lease_token from c2), 'too_many_today', null, now())$$, 'invalid portal refusal',
 'only a portal''s own refusal holds a host back: no reason of Trainee''s own');
grant select on c2 to authenticated;
select t.as_user('00000000-0000-4000-8000-00000000f102');
set role authenticated;
select t.must_fail($$select career_apply_host_refused_own((select id from c2), (select lease_token from c2), 'rate_limited', null)$$, 'invalid apply claim',
 'a person cannot hold back another person''s host');
select t.must_fail($$select * from career_apply_host_backoff$$, 'permission denied', 'a person reads no one''s backoff rows');
reset role;
set role anon;
select t.must_fail($$select career_apply_host_wait('https://jobs.lever.co/a/1','cloud',now())$$, 'permission denied', 'anon reads nothing');
reset role;
rollback;
