-- WO-122 (20261110180000_career_apply_answers_own_v2.sql): v2 returns v1's columns and the postings each question was asked
-- for (job_ids); only the caller's own answered rows; v1 is unchanged.
begin;
reset role;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000122a01','v2-a@example.test'),('00000000-0000-4000-8000-000000122a02','v2-b@example.test');
insert into profiles(id) values('00000000-0000-4000-8000-000000122a01'),('00000000-0000-4000-8000-000000122a02');
select t.as_user('00000000-0000-4000-8000-000000122a01');set role authenticated;
select career_apply_questions_put_own('TEST-V2-A','[{"key":"fact:sponsorship","kind":"fact","label":"Will you require sponsorship?","type":"select","options":["Yes","No"]}]'::jsonb);
select career_apply_questions_put_own('TEST-V2-C','[{"key":"fact:sponsorship","kind":"fact","label":"Do you need a visa?","type":"select","options":["Yes","No"]},{"key":"fact:gpa","kind":"fact","label":"GPA","type":"text"}]'::jsonb);
reset role;
select t.as_user('00000000-0000-4000-8000-000000122a02');set role authenticated;
select career_apply_questions_put_own('TEST-V2-B','[{"key":"fact:sponsorship","kind":"fact","label":"Will you require sponsorship?","type":"select","options":["Yes","No"]}]'::jsonb);
reset role;
set role service_role;
select career_apply_question_answer_as('00000000-0000-4000-8000-000000122a01',(select id from career_apply_questions where user_id='00000000-0000-4000-8000-000000122a01' and key='fact:sponsorship'),'No');
select career_apply_question_answer_as('00000000-0000-4000-8000-000000122a02',(select id from career_apply_questions where user_id='00000000-0000-4000-8000-000000122a02' and key='fact:sponsorship'),'Yes');
reset role;

select t.as_user('00000000-0000-4000-8000-000000122a01');set role authenticated;
select t.ok((select count(*) from career_apply_answers_own_v2())=1,'v2 returns the caller''s answered rows only (an open question is not an answer)');
select t.ok((select job_ids from career_apply_answers_own_v2() where key='fact:sponsorship')=array['TEST-V2-A','TEST-V2-C'],'with the postings its question was asked for');
select t.ok((select answer from career_apply_answers_own_v2())='No','and the caller''s own answer, never another person''s');
select t.ok((select answered_at is not null from career_apply_answers_own_v2()),'and when it was answered');
select t.ok((select row(id, key, kind, answer, answered_at)::text from career_apply_answers_own_v2()) = (select row(id, key, kind, answer, answered_at)::text from career_apply_answers_own()),'the same row v1 returns, beside job_ids');
reset role;
select t.ok((select pg_get_function_result('public.career_apply_answers_own()'::regprocedure))='TABLE(id uuid, key text, kind text, answer text, answered_at timestamp with time zone)','v1 is unchanged');
select t.ok(not has_function_privilege('anon','public.career_apply_answers_own_v2()','execute'),'anon cannot call v2');
select t.ok(not has_function_privilege('service_role','public.career_apply_answers_own_v2()','execute'),'nor the service role: it reads auth.uid()''s rows');
select t.ok(has_function_privilege('authenticated','public.career_apply_answers_own_v2()','execute'),'the signed-in person can');
rollback;
