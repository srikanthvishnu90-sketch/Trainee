-- Review of PR #814, round 2 (20261113130000_career_outreach_adopt_skip_mail_reply.sql), in the database alone: of two sent drafts
-- with a provider thread, the outreach draft's thread is adopted into the replies lane and the mail reply's (recipient.kind =
-- 'mail_reply': an answer to an email already in the person's inbox) is not, on this call or the next. Everything rolls back.
\set ON_ERROR_STOP on
begin;
reset role;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000d8141','mr-a@example.test');
insert into public.profiles(id) values ('00000000-0000-4000-8000-0000000d8141') on conflict do nothing;
do $$
declare a uuid := '00000000-0000-4000-8000-0000000d8141'; n int;
begin
  insert into public.career_outreach_drafts(user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, sent_at, gmail_id, gmail_thread, result) values
    (a, gen_random_uuid(), 1, '{"name":"Lee","firm":"Acme","email":"lee@example.test","source":"list"}', 'lee@example.test', 'Hello', 'Hi Lee', 'Sam', repeat('a', 64), 'sent', now() - interval '1 hour', 'g1', 'thr-outreach', 'sent'),
    (a, gen_random_uuid(), 1, '{"name":"Dana","email":"dana@example.test","source":"reply to their email","kind":"mail_reply","reply":{"from":null,"in_reply_to":"<m1@example.test>","thread_id":"thr-inbox"}}', 'dana@example.test', 'Re: Chat', 'Hi Dana', 'Sam', repeat('b', 64), 'sent', now() - interval '2 hours', 'g2', 'thr-inbox', 'sent');
  perform public.career_outreach_threads_adopt(50);
  perform public.career_outreach_threads_adopt(50);
  select count(*) into n from public.career_outreach_threads where user_id = a and provider_thread = 'thr-outreach';
  if n <> 1 then raise exception 'FAIL the outreach draft''s thread was adopted % times, not once', n; end if;
  raise notice 'ok   an outreach draft''s sent thread is adopted once';
  select count(*) into n from public.career_outreach_threads where user_id = a and (provider_thread = 'thr-inbox' or recipient_email = 'dana@example.test');
  if n <> 0 then raise exception 'FAIL a mail reply''s thread was adopted into the replies lane'; end if;
  raise notice 'ok   a mail reply''s thread is never adopted (the older one of the two, so it was first in line)';
end $$;
rollback;
