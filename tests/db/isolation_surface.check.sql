-- ISOLATION (workstream ISOLATION + SCALE, 2026-10-30): two people, A and B, on the schema every migration built. Nothing A (signed in),
-- anon, or a different chat can do reads, writes, approves, queues or finishes anything of B's. Run last by tests/db/run.sh
-- (after the definer lockdown), against the real schema; everything rolls back. Named .check.sql so the *.test.sql loop (which
-- runs on the early schema) does not pick it up.
--
-- 1. Catalog sweeps: RLS on every table; every policy bound to auth.uid(); no definer function a signed-in person can call that
--    takes an identity without binding it to the caller (the hole this file found: credit_pending_referral).
-- 2. Rows: A sees none of B's rows (prepared applications, cards, queued jobs, flow state, model calls, channel contacts), cannot
--    change them, cannot insert one in B's name; anon sees nothing.
-- 3. RPCs: A cannot open, answer, finish, read or approve B's card / question / job / message card, with B's real ids.
-- 4. Service-only paths (the _as/_for family, trainee-file sign-in, the vault, the model budget) are closed to A and anon.
-- 5. A different chat id: a Telegram chat linked to one account cannot be taken by another; a stranger's chat resolves to nobody.
\set ON_ERROR_STOP on
begin;
reset role;

-- 1a. Row level security on every table the migrations make. (agent_threads, agent_messages, profiles and simplefin_connections
--     are production's own tables, stood in by stubs.sql with no grants to anon or authenticated, so they are listed, not exempt.)
select t.ok((select coalesce(string_agg(c.relname, ', '), '') = '' from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    and c.relname not in ('agent_threads', 'agent_messages', 'profiles', 'simplefin_connections')),
  'every table the migrations make has row level security on');
select t.ok((select coalesce(string_agg(c.relname, ', '), '') = '' from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname in ('agent_threads', 'agent_messages', 'profiles', 'simplefin_connections')
    and (has_table_privilege('anon', c.oid, 'select,insert,update,delete') or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'))),
  'the stand-in tables without row level security are not open to anon or signed-in people in this suite');

-- 1b. Every policy that anon, authenticated or PUBLIC can be under is bound to auth.uid() (or to a column of the row that the
--     owner reads), except the three that are public by design: the postings every signed-in person browses, the lessons with no
--     owner, and the service role's own policies.
select t.ok((select coalesce(string_agg(tablename || '.' || policyname, ', '), '') = '' from pg_policies
  where schemaname = 'public'
    and (roles && array['public', 'anon', 'authenticated']::name[])
    and coalesce(qual, with_check) !~ 'auth\.uid\(\)'
    and (tablename, policyname) not in (('career_postings', 'career_postings_read'))),
  'every policy open to signed-in people or anon is bound to auth.uid(), except career_postings_read');
select t.ok((select count(*) = 1 from pg_policies where schemaname = 'public' and tablename = 'agent_lessons' and cmd = 'SELECT'
  and qual ~ 'user_id IS NULL' and qual ~ 'user_id = auth\.uid\(\)'), 'lessons: a signed-in person reads the ownerless ones and their own, nothing else');
select t.ok((select coalesce(string_agg(tablename || '.' || policyname, ', '), '') = '' from pg_policies
  where schemaname = 'public' and (roles && array['public', 'anon']::name[]) and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and coalesce(with_check, qual) !~ 'auth\.uid\(\)'), 'no write policy open to anon or PUBLIC is unbound');

-- 1c. A definer function a signed-in person can call, that takes an id or a text key, binds the caller to auth.uid() (directly, or
--     through its _own wrapper, or by being service-only). Three are on purpose: connector_open() and generate_referral_code()
--     take no argument; is_eligible_referrer(uuid) is the one oracle qualify_referral hands the referee (it only says whether a
--     referrer pays), recorded here so a fourth cannot join unseen.
select t.ok((select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') = '' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
    and p.pronargs > 0
    and p.prosrc !~* 'auth\.uid\(\)|auth\.role\(\)|_own\(|request\.jwt'
    and p.oid::regprocedure::text not in ('is_eligible_referrer(uuid)')),
  'every definer function a signed-in person can call binds the caller to auth.uid()');
-- The service-role family: nothing named _as / _for, no vault, no trainee-file sign-in, no budget, no model reservation, no
-- Telegram link is executable by anon or a signed-in person.
select t.ok((select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') = '' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and (p.proname ~ '(_as|_for)$' or p.proname ~ '^(trainee_file_|oauth_vault_|manual_vault_|model_budget_|agent_model_call_|channel_telegram_)')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  'the _as / _for family, the vaults, trainee-file sign-in, the budget, model reservations and the Telegram link are service-role only');

-- Fixtures: A and B, each with a confirmed resume on file and two prepared applications; A's and B's first is confirmed (a card
-- opened, answered, a job queued, as the file page's Apply does); the second stays prepared. One thread each, one channel each.
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-0000015a0001', 'iso-a@example.test'), ('00000000-0000-4000-8000-0000015a0002', 'iso-b@example.test'),
  ('00000000-0000-4000-8000-0000015a0003', 'iso-c@example.test'), ('00000000-0000-4000-8000-0000015a0004', 'iso-d@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000015a0001'), ('00000000-0000-4000-8000-0000015a0002'), ('00000000-0000-4000-8000-0000015a0003'), ('00000000-0000-4000-8000-0000015a0004');
insert into career_watch_kv(user_id, key, value)
  select u, 'career:account', '{"epoch":1,"version":1,"paused":false}' from unnest(array['00000000-0000-4000-8000-0000015a0001', '00000000-0000-4000-8000-0000015a0002']::uuid[]) u;
create function public.zz_iso_fixture(u uuid, th uuid, tag text) returns void language plpgsql as $$
begin
 insert into agent_threads(id, user_id) values (th, u);
 insert into agent_flow_state(thread_id, user_id, state) values (th, u,
  jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
   jsonb_build_object('id', 'f1', 'kind', 'experience', 'status', 'confirmed', 'needs_confirmation', false, 'confirmation_event_id', 'ev-iso-' || tag, 'text', 'ISO ' || tag)))))));
 insert into career_events(user_id, kind, subject, detail) values (u, 'fact_confirmed', 'ISO ' || tag, jsonb_build_object('confirmation_event_id', 'ev-iso-' || tag));
 insert into storage.objects(bucket_id, name) values ('career-resumes', u::text || '/' || repeat('a', 64) || '.pdf');
end $$;
select public.zz_iso_fixture('00000000-0000-4000-8000-0000015a0001', '00000000-0000-4000-8000-0000015a00b1', 'a');
select public.zz_iso_fixture('00000000-0000-4000-8000-0000015a0002', '00000000-0000-4000-8000-0000015a00b2', 'b');
create function public.zz_iso_prep(u uuid, job text) returns career_apply_prepared language plpgsql as $$
declare p jsonb; r career_apply_prepared;
begin
 p := jsonb_build_object('version', 1, 'user_id', u, 'job_id', job, 'company', 'ISO Co ' || job, 'url', 'https://jobs.lever.co/isoco/' || job,
  'fields', '[]'::jsonb, 'privacy_epoch', 1, 'account_version', 1, 'expires_at', now() + interval '1 day', 'resume_sha256', repeat('a', 64));
 insert into career_apply_prepared(user_id, job_id, company, url, payload, payload_hash, card_lines)
  values (u, job, 'ISO Co ' || job, 'https://jobs.lever.co/isoco/' || job, p, career_apply_payload_hash(p), array['ISO Co ' || job]) returning * into r;
 return r;
end $$;
create temp table pr as
  select * from (values ('a', 1, '00000000-0000-4000-8000-0000015a0001'::uuid), ('a', 2, '00000000-0000-4000-8000-0000015a0001'::uuid),
                        ('b', 1, '00000000-0000-4000-8000-0000015a0002'::uuid), ('b', 2, '00000000-0000-4000-8000-0000015a0002'::uuid)) v(who, n, u);
create function public.zz_iso_pid(who text, n int) returns uuid language sql security definer set search_path = public, pg_temp as $$ select (select id from career_apply_prepared where job_id = 'iso-' || who || '-' || n) $$;
create function public.zz_iso_ph(who text, n int) returns text language sql security definer set search_path = public, pg_temp as $$ select (select payload_hash from career_apply_prepared where job_id = 'iso-' || who || '-' || n) $$;
select public.zz_iso_prep(u, 'iso-' || who || '-' || n) from pr;
create function public.zz_iso_try(sql text) returns text language plpgsql as $$ declare r text; begin execute sql into r; return coalesce(r, 'null'); exception when others then return 'ERR ' || sqlerrm; end $$;
-- Each person's first application is confirmed (service role acting for them, as the file page does).
set role service_role;
create temp table cb as select public.career_apply_card_confirm_as('00000000-0000-4000-8000-0000015a0002', array[public.zz_iso_pid('b', 1)], array[public.zz_iso_ph('b', 1)]) as r;
create temp table ca as select public.career_apply_card_confirm_as('00000000-0000-4000-8000-0000015a0001', array[public.zz_iso_pid('a', 1)], array[public.zz_iso_ph('a', 1)]) as r;
reset role;
select t.ok((select count(*) = 1 from career_apply_jobs where user_id = '00000000-0000-4000-8000-0000015a0002') and (select count(*) = 1 from career_apply_jobs where user_id = '00000000-0000-4000-8000-0000015a0001'),
  'fixture: one queued application each');
-- A model reservation, a channel contact and an open card for B (B's second application, shown on a card but not answered).
select public.career_apply_card_open_for('00000000-0000-4000-8000-0000015a0002', array[public.zz_iso_pid('b', 2)], now());
set role service_role;
select public.agent_model_call_reserve('00000000-0000-4000-8000-0000015a0002', '00000000-0000-4000-8000-0000015a00b2', '00000000-0000-4000-8000-0000015a0f02', 0, 'm');
select public.agent_model_call_reserve('00000000-0000-4000-8000-0000015a0001', '00000000-0000-4000-8000-0000015a00b1', '00000000-0000-4000-8000-0000015a0f01', 0, 'm');
reset role;
insert into channel_contacts(contact, user_id, thread_id) values ('tg:5150001', '00000000-0000-4000-8000-0000015a0001', '00000000-0000-4000-8000-0000015a00b1'),
  ('tg:5150002', '00000000-0000-4000-8000-0000015a0002', '00000000-0000-4000-8000-0000015a00b2');

-- 2. Rows. A signed in as A reads every one of its own rows and none of B's; anon reads none.
create function public.zz_iso_seen(tbl text, who uuid) returns int language plpgsql as $$
declare n int;
begin
 execute format('select count(*) from public.%I where user_id = %L', tbl, who) into n;
 return n;
exception when insufficient_privilege then return -1;
end $$;
select t.as_user('00000000-0000-4000-8000-0000015a0001');
set role authenticated;
select t.ok((select bool_and(public.zz_iso_seen(tbl, '00000000-0000-4000-8000-0000015a0002') = 0 and public.zz_iso_seen(tbl, '00000000-0000-4000-8000-0000015a0001') > 0)
  from unnest(array['career_apply_prepared', 'career_apply_cards', 'career_apply_jobs', 'agent_flow_state', 'agent_model_calls', 'channel_contacts', 'career_events']) tbl),
  'A reads each of its own rows and none of B''s: prepared applications, cards, queued jobs, flow state, model calls, channel contacts, timeline');
select t.ok((select count(*) = 0 from career_apply_prepared where user_id <> '00000000-0000-4000-8000-0000015a0001'), 'no row of anyone else comes back from a plain select');
select t.ok((select count(*) = 0 from career_apply_prepared where id = public.zz_iso_pid('b', 2)), 'B''s prepared application, asked for by its id, is not there');
-- Writes: not a row of B's, not a row in B's name.
select t.must_fail($$update career_apply_jobs set state = 'queued'$$, 'permission denied', 'A cannot write the queue');
select t.must_fail($$delete from career_apply_prepared$$, 'permission denied', 'A cannot delete prepared applications');
select t.ok(public.zz_iso_try($$with u as (update agent_flow_state set state = '{}' where user_id = '00000000-0000-4000-8000-0000015a0002' returning 1) select count(*)::text from u$$) = '0',
  'A changes none of B''s flow state');
select t.must_fail($$insert into agent_flow_state(thread_id, user_id, state) values ('00000000-0000-4000-8000-0000015a00b2', '00000000-0000-4000-8000-0000015a0002', '{}')$$, 'row-level security|violates|duplicate', 'A cannot insert flow state in B''s name');
select t.must_fail($$insert into channel_contacts(contact, user_id) values ('tg:1', '00000000-0000-4000-8000-0000015a0001')$$, 'permission denied', 'A cannot write channel contacts (not even their own)');
select t.ok((select state from agent_flow_state where thread_id = '00000000-0000-4000-8000-0000015a00b1') is not null, 'A still reads their own thread''s state');
-- 3. RPCs with B's real ids.
select t.ok(public.zz_iso_try(format($q$select public.career_apply_card_open_own(array[%L::uuid])$q$, public.zz_iso_pid('b', 2))) like 'ERR %', 'A cannot open a card for B''s prepared application');
select t.ok(public.zz_iso_try(format($q$select public.career_apply_card_answer_own(%L::uuid, array[1])$q$, (select id from career_apply_cards where user_id = '00000000-0000-4000-8000-0000015a0002' and state = 'open' limit 1))) like 'ERR %'
  or (select count(*) = 0 from career_apply_cards where user_id = '00000000-0000-4000-8000-0000015a0002'), 'A cannot answer B''s card (it is not even visible to A)');
select t.must_fail(format($q$select public.career_apply_card_confirm_as(%L, array[%L::uuid], array[%L])$q$, '00000000-0000-4000-8000-0000015a0001', public.zz_iso_pid('b', 2), public.zz_iso_ph('b', 2)), 'permission denied', 'A cannot reach the service path with B''s ids');
select t.ok(public.zz_iso_try(format($q$select public.career_apply_message_card_read_own(%L::uuid)$q$, gen_random_uuid())) is not null, 'A reading a card that is not theirs gets nothing (or an error), not B''s payload');
select t.ok(public.zz_iso_try(format($q$select public.career_apply_question_answer_own(%L::uuid, 'No')$q$, gen_random_uuid())) like 'ERR %', 'A answers no question of anyone else''s');
select public.career_apply_claim_own(10);
-- credit_pending_referral: the hole this file found. A signed-in person could credit any referee's referrer.
select t.must_fail($q$select public.credit_pending_referral('00000000-0000-4000-8000-0000015a0002')$q$, 'service-role only', 'A cannot trigger a referral payout for anyone (credit_pending_referral)');
reset role;

-- B's rows are exactly as the fixture left them.
select t.ok((select state = 'queued' and payload_hash = public.zz_iso_ph('b', 1) from career_apply_jobs where user_id = '00000000-0000-4000-8000-0000015a0002'), 'B''s queued application is unchanged after A claimed its own queue');
select t.ok((select state = 'shown' from career_apply_prepared where id = public.zz_iso_pid('b', 2)), 'B''s second application is still waiting on its card, untouched');

-- anon: no row of anyone's, no call.
set role anon;
select set_config('request.jwt.claim.sub', '', true);
select t.ok((select bool_and(public.zz_iso_seen(tbl, '00000000-0000-4000-8000-0000015a0002') <= 0 and public.zz_iso_seen(tbl, '00000000-0000-4000-8000-0000015a0001') <= 0)
  from unnest(array['career_apply_prepared', 'career_apply_cards', 'career_apply_jobs', 'agent_flow_state', 'agent_model_calls', 'channel_contacts', 'career_events',
                     'trainee_file_sessions', 'trainee_file_logins', 'user_oauth_connections', 'agent_usage', 'agent_obligations']) tbl),
  'anon reads no row of anyone''s, in any table a person''s data lives in');
select t.must_fail($$select public.career_apply_claim_own(5)$$, 'permission denied', 'anon cannot claim');
select t.must_fail($$select public.credit_pending_referral('00000000-0000-4000-8000-0000015a0002')$$, 'permission denied', 'anon cannot trigger a payout');
reset role;
-- A person who exists but is not signed in as anyone (no sub): the _own family returns nothing or refuses, never everything.
set role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select t.ok((select count(*) = 0 from career_apply_prepared) and (select count(*) = 0 from career_apply_jobs) and (select count(*) = 0 from agent_flow_state),
  'a session with no identity reads nothing');
select t.ok(public.zz_iso_try($q$select count(*)::text from public.career_apply_claim_own(10)$q$) in ('0') or public.zz_iso_try($q$select count(*)::text from public.career_apply_claim_own(10)$q$) like 'ERR %',
  'and claims nothing');
reset role;

-- 4. Service-only paths closed to A (the file page's sign-in, the vault, the budget, model reservations).
select t.as_user('00000000-0000-4000-8000-0000015a0001');
set role authenticated;
select t.must_fail($$select public.trainee_file_sessions_revoke_all('00000000-0000-4000-8000-0000015a0002', now())$$, 'permission denied', 'A cannot sign B out of the file page');
select t.must_fail($$select * from public.trainee_file_login_begin('00000000000015a1', '00000000-0000-4000-8000-0000015a0002', '0123456789', now(), now() + interval '15 minutes')$$, 'permission denied', 'A cannot begin a file sign-in for B');
select t.must_fail($$select * from public.trainee_file_sessions$$, 'permission denied', 'A cannot read file sessions');
select t.must_fail($$select public.oauth_vault_read('oauth_google_00000000-0000-4000-8000-0000015a0002')$$, 'permission denied|does not exist', 'A cannot read B''s vault');
select t.must_fail($$select public.agent_model_call_reserve('00000000-0000-4000-8000-0000015a0002', '00000000-0000-4000-8000-0000015a00b2', gen_random_uuid(), 1, 'm')$$, 'permission denied', 'A cannot spend B''s model calls');
select t.must_fail($$select public.model_budget_reserve(1, 'm', 'chat')$$, 'permission denied', 'A cannot touch the global budget');
select t.must_fail($$select public.channel_telegram_link_as('00000000-0000-4000-8000-0000015a0001', '5150002', repeat('b', 64), now(), now())$$, 'permission denied', 'A cannot link a Telegram chat');
reset role;

-- trainee-file sessions: signing one account out leaves every other account''s sessions.
insert into trainee_file_sessions(id_hash, user_id, via, phone, list, expires_at) values
  (repeat('7', 64), '00000000-0000-4000-8000-0000015a0001', 'phone', '+15125550171', '0123456789', now() + interval '2 hours'),
  (repeat('8', 64), '00000000-0000-4000-8000-0000015a0002', 'phone', '+15125550172', '0123456789', now() + interval '2 hours');
set role service_role;
select public.trainee_file_sessions_revoke_all('00000000-0000-4000-8000-0000015a0001', now());
reset role;
select t.ok((select count(*) = 1 from trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000015a0002' and revoked_at is null)
  and (select count(*) = 0 from trainee_file_sessions where user_id = '00000000-0000-4000-8000-0000015a0001' and revoked_at is null), 'sign out everywhere ends A''s sessions and B''s are untouched');
-- The model reservation is the owner's: another person's thread is refused, and the same request id is a different slot per person.
set role service_role;
select t.must_fail($$select public.agent_model_call_reserve('00000000-0000-4000-8000-0000015a0001', '00000000-0000-4000-8000-0000015a00b2', gen_random_uuid(), 0, 'm')$$, 'owner mismatch', 'a model reservation on someone else''s thread is refused');
select t.ok((public.agent_model_call_reserve('00000000-0000-4000-8000-0000015a0001', '00000000-0000-4000-8000-0000015a00b1', '00000000-0000-4000-8000-0000015a0f02', 0, 'm') ->> 'ok')::boolean,
  'the same request id from another person is its own slot, not B''s');
select t.ok((public.agent_model_call_reserve('00000000-0000-4000-8000-0000015a0001', '00000000-0000-4000-8000-0000015a00b1', '00000000-0000-4000-8000-0000015a0f02', 0, 'm') ->> 'state') = 'already_reserved', 'and a retry of A''s own is idempotent');
-- The Apply payload is what the person was shown: B's hash on A's id, or A's on B's, approves nothing.
select t.ok(public.zz_iso_try(format($q$select public.career_apply_card_confirm_as(%L, array[%L::uuid], array[%L])$q$, '00000000-0000-4000-8000-0000015a0001', public.zz_iso_pid('b', 2), public.zz_iso_ph('b', 2))) like 'ERR %card_changed%',
  'A confirming B''s prepared application (id and hash both B''s): refused, card_changed');
select t.ok(public.zz_iso_try(format($q$select public.career_apply_card_confirm_as(%L, array[%L::uuid], array[%L])$q$, '00000000-0000-4000-8000-0000015a0001', public.zz_iso_pid('a', 2), public.zz_iso_ph('b', 2))) like 'ERR %card_changed%',
  'A''s id with B''s hash: refused');
select t.ok(public.zz_iso_try(format($q$select public.career_apply_card_confirm_as(%L, array[%L::uuid], array[%L])$q$, '00000000-0000-4000-8000-0000015a0003', public.zz_iso_pid('a', 2), public.zz_iso_ph('a', 2))) like 'ERR %card_changed%',
  'a third person with A''s id and hash: refused');
select t.ok(public.zz_iso_try(format($q$select public.career_apply_question_answer_as(%L, gen_random_uuid(), 'No')$q$, '00000000-0000-4000-8000-0000015a0003')) like 'ERR %', 'an answer to a question that is not the person''s is refused');
reset role;
select t.ok((select count(*) = 0 from career_apply_jobs where job_id in ('iso-a-2', 'iso-b-2')), 'none of those refusals queued anything');

-- 5. A different chat id. The Telegram link is one chat to one account.
set role service_role;
select t.ok((public.channel_telegram_link_as('00000000-0000-4000-8000-0000015a0003', '5150003', repeat('c', 64), now(), now()) ->> 'outcome') = 'linked', 'a new chat links to its first account');
select t.ok((public.channel_telegram_link_as('00000000-0000-4000-8000-0000015a0001', '5150003', repeat('d', 64), now(), now()) ->> 'error') in ('linked_elsewhere', 'account_has_other'), 'a second account cannot take that chat (refused: it has a chat of its own already)');
select t.ok((public.channel_telegram_link_as('00000000-0000-4000-8000-0000015a0004', '5150003', repeat('f', 64), now(), now()) ->> 'error') = 'linked_elsewhere', 'an account with no chat of its own still cannot take a chat linked to another account');
select t.ok((public.channel_telegram_link_as('00000000-0000-4000-8000-0000015a0002', '5150001', repeat('e', 64), now(), now()) ->> 'error') in ('linked_elsewhere', 'account_has_other'), 'B cannot take A''s chat (tg:5150001)');
select t.ok((public.channel_telegram_link_as('00000000-0000-4000-8000-0000015a0003', '5150003', repeat('c', 64), now(), now()) ->> 'error') = 'replay', 'a signed login is taken once');
reset role;
select t.ok((select user_id = '00000000-0000-4000-8000-0000015a0001' from channel_contacts where contact = 'tg:5150001')
  and (select user_id = '00000000-0000-4000-8000-0000015a0002' from channel_contacts where contact = 'tg:5150002')
  and (select user_id = '00000000-0000-4000-8000-0000015a0003' from channel_contacts where contact = 'tg:5150003')
  and (select user_id = '00000000-0000-4000-8000-0000015a0003' from channel_contacts where contact = 'tg:5150003')
  and not exists (select from channel_contacts where contact = 'tg:9999999'), 'each chat still belongs to its own account; a chat nobody linked resolves to nobody');
rollback;
