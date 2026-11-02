-- ONBOARDING ROUND 3 (20261031070000_career_resume_upload_resend.sql), in the database alone: two files with the same text
-- (one message sha256), A then B, then A sent again: A's row is the same row, now the latest upload (so the chat's "newest
-- upload no later than the message" is the file that showed the entries); bytes that do not hash to the sha256 are refused;
-- service only. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000c3b01';
  a_b64 text := encode(convert_to('%PDF-1.4 resume A (TEST)', 'UTF8'), 'base64');
  b_b64 text := encode(convert_to('PK resume B docx (TEST)', 'UTF8'), 'base64');
  a_sha text := encode(sha256(convert_to('%PDF-1.4 resume A (TEST)', 'UTF8')), 'hex');
  b_sha text := encode(sha256(convert_to('PK resume B docx (TEST)', 'UTF8')), 'hex');
  msg text := encode(sha256(convert_to('here is my resume:\nsame text', 'UTF8')), 'hex');
  ida uuid; idb uuid; ida2 uuid; ta timestamptz; tb timestamptz; ta2 timestamptz; n int; ok boolean;
begin
  insert into auth.users(id, email) values (u, 'onb3@example.test');
  insert into public.profiles(id) values (u);
  ida := public.career_resume_upload_record_as(u, 'telegram', 'telegram:UA', 'resume.pdf', 'application/pdf', 24, a_sha, a_b64, msg);
  -- created_at is now() (the transaction's start); the rows are backdated to stand for files received a minute apart.
  update public.career_resume_uploads set created_at = now() - interval '2 minutes' where id = ida;
  idb := public.career_resume_upload_record_as(u, 'telegram', 'telegram:UB', 'resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 23, b_sha, b_b64, msg);
  update public.career_resume_uploads set created_at = now() - interval '1 minute' where id = idb;
  ida2 := public.career_resume_upload_record_as(u, 'telegram', 'telegram:UA2', 'resume.pdf', 'application/pdf', 24, a_sha, a_b64, msg);
  if ida2 is distinct from ida then raise exception 'FAIL a resend made a second row (% vs %)', ida2, ida; end if;
  select created_at into ta2 from public.career_resume_uploads where id = ida;
  select created_at into tb from public.career_resume_uploads where id = idb;
  if not ta2 > tb then raise exception 'FAIL a resent file is not the latest upload (A % <= B %)', ta2, tb; end if;
  select count(*) into n from public.career_resume_uploads where user_id = u;
  if n <> 2 then raise exception 'FAIL want 2 uploads, got %', n; end if;
  if (select provider_ref from public.career_resume_uploads where id = ida) <> 'telegram:UA2' then raise exception 'FAIL the resend''s reference was not kept'; end if;
  raise notice 'ok   a file sent again is the same row, now the latest upload (after a newer file with the same text)';
  -- the newest upload no later than a message received between B and the resend is B
  select id into ida2 from public.career_resume_uploads where user_id = u and message_sha256 = msg and created_at <= now() - interval '30 seconds' order by created_at desc limit 1;
  if ida2 is distinct from idb then raise exception 'FAIL the upload before the message is not B'; end if;
  raise notice 'ok   the upload received no later than a message is the one that message came from';
  begin
    perform public.career_resume_upload_record_as(u, 'telegram', 'telegram:UX', 'x.pdf', 'application/pdf', 24, b_sha, a_b64, msg);
    raise exception 'FAIL bytes that do not hash to the sha256 were stored';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'ok   bytes that do not hash to the declared sha256 are refused';
  select has_function_privilege('anon', 'public.career_resume_upload_record_as(uuid, text, text, text, text, integer, text, text, text)', 'execute')
      or has_function_privilege('authenticated', 'public.career_resume_upload_record_as(uuid, text, text, text, text, integer, text, text, text)', 'execute') into ok;
  if ok then raise exception 'FAIL anon or authenticated can record an upload'; end if;
  raise notice 'ok   service role only';
end $$;
rollback;
