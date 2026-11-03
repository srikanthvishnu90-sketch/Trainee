-- career-ingest, bounded (20261030030000_career_ingest_bounded.sql): the GIN search index has no pending list (no merge
-- inside a random statement) and new pages keep room for HOT updates; a touch or a close leaves `search` as it was and a
-- changed description is searchable at once (the generated column, unchanged); career_postings_known returns the stored rows without descriptions, the
-- description's SHA-256 in their place, to the service role only, at most 1,000 ids a call; a board read in parts keeps its
-- offset and pass start together; a run's log row carries a status, and a failed one its error.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-0000-0000-0000000000b1','bounded1@example.com');
select t.ok((select reloptions::text like '%fastupdate=off%' from pg_class where oid = 'public.career_postings_search'::regclass),'the GIN index writes through: no pending list to merge inside a statement');
select t.ok((select reloptions::text like '%fillfactor=85%' from pg_class where oid = 'public.career_postings'::regclass),'new pages keep room for HOT updates');
set role service_role;
insert into public.career_postings(job_id,provider,board,ats_id,company,title,location,url,description,first_seen_at,last_seen_at)
values ('workday:usc.wd5/externalkeckusccareers:Patient-Accounts-Rep---Patient-Financial-Services---Full-Time-8-hours_REQ1','workday','usc.wd5/externalkeckusccareers','REQ1','Keck Medicine of USC','Patient Accounts Rep','Los Angeles, CA','https://usc.wd5.myworkdayjobs.com/externalkeckusccareers/job/REQ1','Billing and insurance follow-up for patient accounts.','2026-10-29T12:00:00Z','2026-10-29T12:00:00Z'),
       ('lever:acme:a1','lever','acme','a1','Acme','Nursing Informatics Lead','New York, NY','https://jobs.lever.co/acme/a1','Clinical workflows and EHR data.','2026-10-29T12:00:00Z','2026-10-29T12:00:00Z');
select t.ok((select count(*)=1 from public.career_postings where search @@ websearch_to_tsquery('english','nurse')),'an inserted posting is searchable (stemmed, as before)');
select t.ok((select count(*)=1 from public.career_postings where search @@ websearch_to_tsquery('english','insurance')),'the description is searched');
create temp table before_touch as select job_id, search::text s, xmin::text x from public.career_postings;
update public.career_postings set last_seen_at = '2026-10-29T19:00:00Z' where job_id = 'lever:acme:a1';
select t.ok((select p.search::text = b.s from public.career_postings p join before_touch b using (job_id) where job_id = 'lever:acme:a1'),'a touch leaves search as it was');
update public.career_postings set closed_at = '2026-10-29T20:00:00Z' where job_id = 'lever:acme:a1';
select t.ok((select p.search::text = b.s from public.career_postings p join before_touch b using (job_id) where job_id = 'lever:acme:a1'),'a close leaves search as it was');
select t.must_fail($$update public.career_postings set search = to_tsvector('english','spam') where job_id = 'lever:acme:a1'$$,'can only be updated to DEFAULT|generated','nobody writes search itself: it follows the posting');
update public.career_postings set description = 'Phlebotomy and specimen intake.' where job_id = 'lever:acme:a1';
select t.ok((select count(*)=1 from public.career_postings where search @@ websearch_to_tsquery('english','phlebotomy')),'a changed description is searchable at once');
select t.ok((select count(*)=0 from public.career_postings where search @@ websearch_to_tsquery('english','EHR')),'and the old one no longer matches');
update public.career_postings set title = 'Registered Nurse' where job_id = 'lever:acme:a1';
select t.ok((select ts_rank(search, to_tsquery('english','registered:A')) > 0 from public.career_postings where job_id = 'lever:acme:a1'),'a changed title is weighted A again');
-- An upsert of the same content (what a write of an unchanged row sends) keeps search; a changed one recomputes it.
insert into public.career_postings(job_id,provider,board,company,title,location,url,description,first_seen_at,last_seen_at)
select job_id,provider,board,company,title,location,url,description,first_seen_at,'2026-10-29T21:00:00Z' from public.career_postings where job_id like 'workday:%'
on conflict (job_id) do update set title = excluded.title, company = excluded.company, location = excluded.location, description = excluded.description, last_seen_at = excluded.last_seen_at;
select t.ok((select p.search::text = b.s from public.career_postings p join before_touch b using (job_id) where job_id like 'workday:%'),'an upsert of the same content keeps search');
-- The rows a run compares: no description, its SHA-256 instead, by ids of any length.
select t.ok((select count(*)=2 from public.career_postings_known(array['lever:acme:a1','workday:usc.wd5/externalkeckusccareers:Patient-Accounts-Rep---Patient-Financial-Services---Full-Time-8-hours_REQ1','greenhouse:none:1'])),'known: the stored rows among the ids (a missing id is simply absent)');
select t.ok((select description_sha = encode(sha256(convert_to('Billing and insurance follow-up for patient accounts.','UTF8')),'hex') from public.career_postings_known(array['workday:usc.wd5/externalkeckusccareers:Patient-Accounts-Rep---Patient-Financial-Services---Full-Time-8-hours_REQ1'])),'known: the description as its SHA-256 (the hex the function computes the same way)');
select t.ok((select not exists (select 1 from information_schema.routines r join information_schema.parameters p on p.specific_name = r.specific_name where r.routine_name = 'career_postings_known' and p.parameter_name = 'description')),'known returns no description column');
select t.must_fail($$select * from public.career_postings_known(array(select 'lever:acme:' || g from generate_series(1, 1001) g))$$,'at most 1000 ids','known refuses more than 1,000 ids a call');
reset role;
select t.as_user('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select t.must_fail($$select * from public.career_postings_known(array['lever:acme:a1'])$$,'permission denied','a signed-in person cannot call known');
reset role;
set role anon;
select t.must_fail($$select * from public.career_postings_known(array['lever:acme:a1'])$$,'permission denied','a signed-out visitor cannot call known');
reset role;
-- A board read in parts: offset and pass start together.
set role service_role;
insert into public.career_board_state(provider,board,bucket) values ('lever','boxlunch',5);
select t.ok((select pass_offset = 0 and pass_started_at is null from public.career_board_state where provider='lever' and board='boxlunch'),'a board starts at the top, no pass open');
update public.career_board_state set pass_offset = 617, pass_started_at = '2026-10-30T00:00:00Z' where provider='lever' and board='boxlunch';
select t.must_fail($$update public.career_board_state set pass_offset = 0 where provider='lever' and board='boxlunch'$$,'career_board_state_pass_check','an offset back to 0 closes the pass with it');
select t.must_fail($$update public.career_board_state set pass_offset = -1 where provider='lever' and board='boxlunch'$$,'career_board_state_pass_check','no negative offset');
-- A run's row: started, done or failed; a failed run says why.
insert into public.career_ingest_runs(at,lane,lanes,window_min,ms,boards_due,boards_read,boards_ok,boards_failed,report,status)
values (now(),1,32,60,0,0,0,0,0,'lane 1 of 32: started; no end recorded',  'started');
select t.ok((select count(*)=1 from public.career_ingest_runs where status='started'),'a run is logged when it starts');
select t.must_fail($$insert into public.career_ingest_runs(at,lane,lanes,window_min,ms,boards_due,boards_read,boards_ok,boards_failed,report,status) values (now(),1,32,60,0,0,0,0,0,'x','failed')$$,'career_ingest_runs_status_check','a failed run without its error is refused');
select t.must_fail($$insert into public.career_ingest_runs(at,lane,lanes,window_min,ms,boards_due,boards_read,boards_ok,boards_failed,report,status) values (now(),1,32,60,0,0,0,0,0,'x','lost')$$,'career_ingest_runs_status_check','an unknown status is refused');
update public.career_ingest_runs set status='failed', error='touch postings: canceling statement due to statement timeout' where status='started';
select t.ok((select count(*)=1 from public.career_ingest_runs where status='failed' and error like '%statement timeout%'),'a failed run keeps its error');
reset role;
rollback;
