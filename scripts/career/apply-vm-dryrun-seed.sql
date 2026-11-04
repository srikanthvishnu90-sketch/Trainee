-- Stage 1 of docs/launch/APPLY-VM-RUNBOOK.md: five TEST applications for YOU only, pointing at the mock Greenhouse/Lever forms
-- that run on the VM itself (http://127.0.0.1:8787). Nothing here reaches an employer.
-- Paste into the Supabase SQL editor after replacing OWNER_USER_ID (your Upmore user id) in the one line marked <<<.
-- Each test application gets a REAL stored approval (what a tapped approval card leaves), because the VM only claims a row whose
-- stored approval is bound to you and this exact payload (an enqueue alone is not an approval). Needs the card-cloud bridge
-- (20261024130000) applied, and you on its eligibility list (test_users for this dry run on mock forms; a real posting needs the
-- bridge's own enrollment, stage 3).
-- Needs: your account exists and you have already uploaded your resume (deno run -A workers/career-browser/approve-first.ts cloud-resume <resume.pdf>).
-- The dry run uses YOUR kept resume (it only ever goes to 127.0.0.1) and obviously fake answers (Test Person, example.invalid).
do $$
declare u uuid := 'OWNER_USER_ID'::uuid;   -- <<<
 a jsonb; h text; p jsonb; i int; kind text; aid uuid; ph text;
begin
 select value into a from public.career_watch_kv where user_id = u and key = 'career:account';
 if a is null then raise exception 'no account for this user id'; end if;
 select sha256 into h from public.career_apply_cloud_resumes where user_id = u order by created_at desc limit 1;
 if h is null then raise exception 'upload your resume first (approve-first.ts cloud-resume)'; end if;
 insert into career_message_approval_private.test_users(user_id) values (u) on conflict do nothing;
 for i in 1..5 loop
  kind := case when i % 2 = 1 then 'greenhouse' else 'lever' end;
  p := jsonb_build_object('version', 1, 'user_id', u, 'job_id', 'DRYRUN-' || i, 'company', 'Mock Employer ' || i,
   'url', 'http://127.0.0.1:8787/' || kind || '/dry' || i,
   'fields', jsonb_build_array(
     jsonb_build_object('label', 'First Name', 'value', 'Test', 'factId', 'dryrun'),
     jsonb_build_object('label', 'Last Name', 'value', 'Person', 'factId', 'dryrun'),
     jsonb_build_object('label', 'Full name', 'value', 'Test Person', 'factId', 'dryrun'),
     jsonb_build_object('label', 'Email', 'value', 'test.person@example.invalid', 'factId', 'dryrun'),
     jsonb_build_object('label', 'Are you legally authorized to work in the United States?', 'value', 'Yes', 'factId', 'dryrun'),
     jsonb_build_object('label', 'Will you now or in the future require sponsorship for employment visa status?', 'value', 'No', 'factId', 'dryrun')),
   'privacy_epoch', (a->>'epoch')::bigint, 'account_version', (a->>'version')::bigint, 'expires_at', to_jsonb(now() + interval '1 day'),
   'engine_approval', repeat('d', 64), 'resume_sha256', h, 'destination', 'http://127.0.0.1:8787/' || kind || '/dry' || i);
  ph := public.career_apply_payload_hash(p);
  insert into public.career_apply_batch_approvals(user_id, job_id, batch_hash, entry, approved_at, used_at) values (u, p->>'job_id', ph, p, now(), now()) returning id into aid;
  insert into career_message_approval_private.cloud_bound_approvals(approval_id, user_id, card_id, item_index, payload_hash, approved_at, expires_at)
   values (aid, u, gen_random_uuid(), 0, ph, now(), now() + interval '23 hours');
  perform public.career_apply_enqueue(p, ph, ph, null);
 end loop;
end $$;
-- Watch them:  select job_id, state, reason, vm_phase, vm_worker from career_apply_jobs where job_id like 'DRYRUN-%' order by job_id;
-- Or what the bot would say:  select jsonb_pretty(career_apply_status_for('OWNER_USER_ID'::uuid, 'DRYRUN-1'));
