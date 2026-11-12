-- D-069 (20261112130000_career_postings_pay_zones.sql), in the database alone: a posting keeps every pay zone its board states
-- (Robinhood's three, recorded 2026-11-12, the third one Lake Mary, FL), as a jsonb array; a non-array, an empty array and more
-- than 24 zones are refused; a posting with no zones keeps null. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare z jsonb := '[{"text":"$166,000–$195,000 (Zone 1 (Menlo Park, CA; New York, NY; Bellevue, WA; Washington, DC))","label":"Zone 1 (Menlo Park, CA; New York, NY; Bellevue, WA; Washington, DC)","currency":"USD","min":166000,"max":195000,"period":null},{"text":"$147,000–$172,000 (Zone 2 (Denver, CO; Westlake, TX; Chicago, IL))","label":"Zone 2 (Denver, CO; Westlake, TX; Chicago, IL)","currency":"USD","min":147000,"max":172000,"period":null},{"text":"$130,000–$152,000 (Zone 3 (Lake Mary, FL; Clearwater, FL; Gainesville, FL))","label":"Zone 3 (Lake Mary, FL; Clearwater, FL; Gainesville, FL)","currency":"USD","min":130000,"max":152000,"period":null}]';

begin
  insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at,pay,pay_zones)
  values ('greenhouse:robinhood:7263592','greenhouse','robinhood','7263592','Robinhood','TEST','https://boards.greenhouse.io/robinhood/jobs/7263592',now(),now(),'$166,000–$195,000 (Zone 1)', z);
  if (select jsonb_array_length(pay_zones) from career_postings where job_id = 'greenhouse:robinhood:7263592') <> 3 then raise exception 'FAIL all three zones kept'; end if;
  if (select pay_zones->2->>'label' from career_postings where job_id = 'greenhouse:robinhood:7263592') not like 'Zone 3 (Lake Mary, FL%' then raise exception 'FAIL zone 3 kept with its places'; end if;
  insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at) values ('lever:d69:1','lever','d69','1','D69 Co','TEST','https://jobs.lever.co/d69/1',now(),now());
  if (select pay_zones from career_postings where job_id = 'lever:d69:1') is not null then raise exception 'FAIL no zones is null'; end if;
  begin update career_postings set pay_zones = '{"text":"x"}' where job_id = 'lever:d69:1'; raise exception 'FAIL an object is refused'; exception when check_violation then null; end;
  begin update career_postings set pay_zones = '[]' where job_id = 'lever:d69:1'; raise exception 'FAIL an empty array is refused'; exception when check_violation then null; end;
  begin update career_postings set pay_zones = (select jsonb_agg(jsonb_build_object('text', i::text)) from generate_series(1, 25) i) where job_id = 'lever:d69:1'; raise exception 'FAIL 25 zones are refused'; exception when check_violation then null; end;
  raise notice 'ok   three zones kept as an array (zone 3 with its places); none is null; an object, [] and 25 zones refused';
end $$;
rollback;
