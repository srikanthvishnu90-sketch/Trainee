-- 20261110200000 (x-audit, E.11 #9): a correction in chat also reopens the answer library's answers that carry the
-- corrected-away words: open again, never rewritten, with a reason; its readers then skip them. Another answer, another
-- kind of event and another person: untouched. Everything rolls back.
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000015c0001','cr-a@example.test'), ('00000000-0000-4000-8000-0000015c0002','cr-b@example.test');
insert into profiles(id) values ('00000000-0000-4000-8000-0000015c0001'), ('00000000-0000-4000-8000-0000015c0002');
insert into career_apply_questions (user_id, key, kind, label, type, state, answer, answered_at)
 select u, k, 'fact', l, 'input_text', 'answered', a, now() - interval '1 day' from (values
  ('00000000-0000-4000-8000-0000015c0001'::uuid, 'fact:graduation_date', 'Expected graduation date', 'May 2026'),
  ('00000000-0000-4000-8000-0000015c0001'::uuid, 'fact:work_authorization', 'Are you authorized to work in the US?', 'Yes'),
  ('00000000-0000-4000-8000-0000015c0002'::uuid, 'fact:graduation_date', 'Expected graduation date', 'May 2026')) v(u, k, l, a);
-- Another kind of event carrying the same words: nothing reopened.
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000015c0001', 'note', 'TEST', '{"corrected":{"from":"May 2026","to":"May 2027"}}');
do $$ begin
  if (select count(*) from career_apply_questions where state = 'answered') <> 3 then raise exception 'FAIL a note reopened an answer'; end if;
end $$;
-- A's correction of the graduation date in chat (the router's fact_confirmed event with detail.corrected).
insert into career_events (user_id, kind, subject, detail) values ('00000000-0000-4000-8000-0000015c0001', 'fact_confirmed', 'TEST graduation',
 jsonb_build_object('via', 'router: their correction of a confirmed resume entry', 'corrected', jsonb_build_object('from', 'May 2026', 'to', 'May 2027')));
do $$
declare g record;
begin
  select state, answer, answered_at, reopened_at, reopened_reason into g from career_apply_questions
   where user_id = '00000000-0000-4000-8000-0000015c0001' and key = 'fact:graduation_date';
  if g.state <> 'open' or g.answer is not null or g.answered_at is not null or g.reopened_at is null
     or g.reopened_reason !~ '^you corrected this on \d{4}-\d{2}-\d{2}$' then
    raise exception 'FAIL the corrected-away answer is not reopened with its reason: %', row_to_json(g); end if;
  if (select answer from career_apply_questions where user_id = '00000000-0000-4000-8000-0000015c0001' and key = 'fact:work_authorization') is distinct from 'Yes' then
    raise exception 'FAIL another answer of A changed'; end if;
  if (select answer from career_apply_questions where user_id = '00000000-0000-4000-8000-0000015c0002' and key = 'fact:graduation_date') is distinct from 'May 2026' then
    raise exception 'FAIL another person''s answer changed'; end if;
  raise notice 'ok   the corrected-away answer reopened (open, no answer, "you corrected this on <date>"); others untouched';
  -- the readers hand only answered rows to later forms
  if exists (select 1 from public.career_apply_answers_for('00000000-0000-4000-8000-0000015c0001') where answer = 'May 2026') then
    raise exception 'FAIL career_apply_answers_for still hands out the old answer'; end if;
  if position('May 2026' in coalesce((public.career_apply_message_cloud_sources('00000000-0000-4000-8000-0000015c0001')->'rows')::text, '')) > 0 then
    raise exception 'FAIL the cloud card''s sources still carry the old answer'; end if;
  raise notice 'ok   neither reader (career_apply_answers_for, cloud sources) hands out the reopened answer';
  if (select (detail->>'reopened_answers')::int from career_events where user_id = '00000000-0000-4000-8000-0000015c0001' and kind = 'note'
      and subject = 'entry corrected: approvals with the old words stopped' order by at desc limit 1) is distinct from 1 then
    raise exception 'FAIL the timeline note does not count the reopened answer'; end if;
  raise notice 'ok   the timeline note counts it (reopened_answers 1)';
end $$;
rollback;
