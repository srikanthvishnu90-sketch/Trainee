-- SQL tests for 20261028050000_agent_turn_costs_always_recorded.sql. A turn that made no model call leaves a row that
-- says calls = 0; a turn whose cost could not be written leaves a row that says 'unrecorded' with calls NULL. The two
-- can never be confused, and an unrecorded turn is counted, not summed as zero.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-0000-0000-0000000000d1','tc1@example.com');
set role service_role;
insert into public.agent_turn_costs(user_id, calls) values ('00000000-0000-0000-0000-0000000000d1', 0);
select t.ok((select meter_state='metered' and calls=0 from public.agent_turn_costs where user_id='00000000-0000-0000-0000-0000000000d1'), 'a zero-call turn is metered with calls = 0');
insert into public.agent_turn_costs(user_id, calls, provider, models, usd_micros) values ('00000000-0000-0000-0000-0000000000d1', 2, 'openai', '{gpt-5-mini}', 500);
insert into public.agent_turn_costs(user_id, meter_state, calls) values ('00000000-0000-0000-0000-0000000000d1', 'unrecorded', null);
select t.ok((select turns=3 and model_calls=2 and unrecorded_turns=1 and usd_micros=500 from public.agent_daily_costs), 'the day counts 3 turns, 2 known calls, 1 unrecorded turn');
select t.must_fail($$insert into public.agent_turn_costs(user_id, meter_state, calls) values ('00000000-0000-0000-0000-0000000000d1','unrecorded',0)$$, 'check', 'unrecorded can never claim 0 calls');
select t.must_fail($$insert into public.agent_turn_costs(user_id, meter_state, calls) values ('00000000-0000-0000-0000-0000000000d1','metered',null)$$, 'check', 'a metered turn must say how many calls');
select t.must_fail($$insert into public.agent_turn_costs(user_id, meter_state, calls) values ('00000000-0000-0000-0000-0000000000d1','guessed',1)$$, 'check', 'only known states');
reset role;
rollback;
