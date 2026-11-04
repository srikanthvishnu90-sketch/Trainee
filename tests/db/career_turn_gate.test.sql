-- Launch readiness R1 (20261026230300_career_turn_gate.sql): a conversation's turns are let through one at a time in the order
-- they took their tickets; a lapsed ticket never blocks; other people are never held; only the service role uses it.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-00000000a301','gate-a@example.test'),('00000000-0000-4000-8000-00000000a302','gate-b@example.test');
set role service_role;
create temp table tk as select
  career_turn_gate_enter('00000000-0000-4000-8000-00000000a301','turn-1') a1,
  career_turn_gate_enter('00000000-0000-4000-8000-00000000a301','turn-2') a2,
  career_turn_gate_enter('00000000-0000-4000-8000-00000000a302','turn-1') b1;
select t.ok((select career_turn_gate_ready('00000000-0000-4000-8000-00000000a301',a1) and not career_turn_gate_ready('00000000-0000-4000-8000-00000000a301',a2) from tk),
  'the first text goes; the second waits for it');
select t.ok((select career_turn_gate_ready('00000000-0000-4000-8000-00000000a302',b1) from tk), 'another person is never held by A''s turns');
select career_turn_gate_leave('00000000-0000-4000-8000-00000000a301',a1) from tk;
select t.ok((select career_turn_gate_ready('00000000-0000-4000-8000-00000000a301',a2) from tk), 'once the first commits and leaves, the second goes');
-- A lapsed ticket (a turn that crashed) does not block.
create temp table tk2 as select career_turn_gate_enter('00000000-0000-4000-8000-00000000a302','turn-2') b2;
reset role;
update career_turn_gate set lease_until = now() - interval '1 second' where ticket = (select b1 from tk);
set role service_role;
select t.ok((select career_turn_gate_ready('00000000-0000-4000-8000-00000000a302',b2) from tk2), 'a ticket past its lease does not block the next turn');
select t.must_fail($$select career_turn_gate_enter('00000000-0000-4000-8000-00000000a301','x',0)$$,'invalid turn gate','a lease outside 5 to 600 seconds is refused');
reset role;
select t.ok(not has_function_privilege('authenticated','public.career_turn_gate_enter(uuid,text,integer,text)','EXECUTE')
  and not has_function_privilege('anon','public.career_turn_gate_ready(uuid,bigint)','EXECUTE')
  and not has_table_privilege('authenticated','public.career_turn_gate','select')
  and not has_table_privilege('anon','public.career_turn_gate','select'),
  'a person''s session and anon cannot take, check or read tickets');
select t.ok((select relrowsecurity from pg_class where oid = 'public.career_turn_gate'::regclass), 'row level security is on for the ticket table');
select t.ok(not has_sequence_privilege('anon','public.career_turn_gate_ticket_seq','usage')
  and not has_sequence_privilege('authenticated','public.career_turn_gate_ticket_seq','usage')
  and not has_sequence_privilege('anon','public.career_turn_gate_ticket_seq','select')
  and not has_sequence_privilege('authenticated','public.career_turn_gate_ticket_seq','select')
  and has_sequence_privilege('service_role','public.career_turn_gate_ticket_seq','usage'),
  'only the service role can draw tickets from the sequence');
select t.ok((select prosrc ilike '%pg_advisory_xact_lock%' from pg_proc where oid = 'public.career_turn_gate_enter(uuid,text,integer,text)'::regprocedure),
  'a ticket is drawn under a per-person-and-thread lock (the enter-then-ready race is closed)');
-- Two threads of one account do not hold each other; two turns of one thread do.
set role service_role;
create temp table tk3 as select
  career_turn_gate_enter('00000000-0000-4000-8000-00000000a301','t-1',90,'thread-x') x1,
  career_turn_gate_enter('00000000-0000-4000-8000-00000000a301','t-2',90,'thread-y') y1,
  career_turn_gate_enter('00000000-0000-4000-8000-00000000a301','t-3',90,'thread-x') x2;
select t.ok((select career_turn_gate_ready('00000000-0000-4000-8000-00000000a301',y1) from tk3), 'another thread of the same account is not held');
select t.ok((select not career_turn_gate_ready('00000000-0000-4000-8000-00000000a301',x2) from tk3), 'the second text of one thread still waits for the first');
reset role;
rollback;
