-- The workers' shared host gate (20261028120000): a refusal holds that host for every worker instance, for the portal's
-- Retry-After or 30 s doubling (at most an hour); an accepted request starts the doubling over. No number of Trainee's own.
-- Each refusal is evaluated once (BETWEEN repeats its left side).
\set ON_ERROR_STOP on
begin;
set role service_role;
select t.ok((select count(*) = 0 from career_apply_host_backoff_get(array['jobs.example.com'])), 'a host that never refused is never held');
select t.ok((select u between clock_timestamp() + interval '119 seconds' and clock_timestamp() + interval '121 seconds' from (select career_apply_host_refused('WWW.Jobs.Example.com', '429 too many requests', 120) u) x),
 'a 429 with Retry-After 120: held 120 s, the host normalized');
select t.ok((select count(*) = 1 from career_apply_host_backoff_get(array['jobs.example.com','other.example.com'])), 'every instance sees it; other hosts are free');
select t.ok((select last_reason = 'rate_limited' and scope = 'cloud' from career_apply_host_backoff where host = 'jobs.example.com'), 'kept as a rate limit, in the cloud scope');
select t.ok((select u between clock_timestamp() + interval '29 seconds' and clock_timestamp() + interval '31 seconds' from (select career_apply_host_refused('slow.example.com', '503 busy', null) u) x), 'no Retry-After: 30 s');
select t.ok((select u between clock_timestamp() + interval '59 seconds' and clock_timestamp() + interval '61 seconds' from (select career_apply_host_refused('slow.example.com', '503 busy', null) u) x), 'again: doubled to 60 s');
select t.ok((select last_reason = 'server_busy' from career_apply_host_backoff where host = 'slow.example.com'), 'a 503 is kept as busy');
select career_apply_host_refused('wall.example.com', 'verification check (captcha)', null);
select t.ok((select last_reason = 'bot_wall' from career_apply_host_backoff where host = 'wall.example.com'), 'a check is kept as a bot wall (never solved)');
update career_apply_host_backoff set until = clock_timestamp() - interval '1 second' where host = 'slow.example.com';
select career_apply_host_ok('slow.example.com');
select t.ok((select refusals = 0 from career_apply_host_backoff where host = 'slow.example.com'), 'accepted again: the doubling starts over');
select t.must_fail($$select career_apply_host_refused('', 'x', null)$$, 'invalid host', 'an empty host is refused');
reset role;
select t.ok(not has_function_privilege('authenticated', 'public.career_apply_host_refused(text,text,integer)', 'EXECUTE')
 and not has_function_privilege('anon', 'public.career_apply_host_backoff_get(text[])', 'EXECUTE'), 'service role only');
rollback;
