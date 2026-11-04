-- APPROVAL RATE (20261030190000_approval_rate.sql), in the database alone and deterministic: every instant is passed to
-- approval_rate(p_now) and the rows carry fixed created_at / updated_at; nothing reads the wall clock for a result.
-- Rate = drafts approved unchanged / drafts shown over a rolling 7 days; an edit or a redo is a miss; the sample floor is 20;
-- the line is 95. Rolled back.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
reset role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000ad401';
  now0 timestamptz := timestamptz '2026-11-10 12:00:00+00';
  i int; b uuid; r record; did uuid;
begin
  insert into auth.users(id, email) values (u, 'ar-a@example.test');
  insert into public.profiles(id) values (u);

  -- 19 drafts shown, all approved unchanged: under the floor, so no percentage.
  b := gen_random_uuid();
  for i in 1..19 loop
    insert into public.career_outreach_drafts(user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, created_at)
    values (u, gen_random_uuid(), 1, '{"email":"x@example.com"}', format('r%s@example.com', i), 's', 'b', 'f', lpad(to_hex(i), 64, '0'), now0 - interval '2 days');
  end loop;
  update public.career_outreach_drafts set status = 'approved', approved_hash = hash, approved_at = now0 - interval '1 day' where user_id = u;
  select * into r from public.approval_rate(now0) where kind = 'outreach_draft';
  if r.shown <> 19 or r.approved_unchanged <> 19 or r.rate_pct is not null or r.status <> 'insufficient data' then
    raise exception 'FAIL under 20 is insufficient data: % % % %', r.shown, r.approved_unchanged, r.rate_pct, r.status; end if;
  raise notice 'ok   19 shown: insufficient data, no percentage';

  -- The 20th, approved unchanged: 20/20 = 100.0, ok.
  insert into public.career_outreach_drafts(user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, created_at)
  values (u, gen_random_uuid(), 1, '{"email":"x@example.com"}', 'r20@example.com', 's', 'b', 'f', lpad(to_hex(20), 64, '0'), now0 - interval '2 days') returning id into did;
  update public.career_outreach_drafts set status = 'approved', approved_hash = hash, approved_at = now0 where id = did;
  select * into r from public.approval_rate(now0) where kind = 'outreach_draft';
  if r.shown <> 20 or r.approved_unchanged <> 20 or r.rate_pct <> 100.0 or r.status <> 'ok' then raise exception 'FAIL 20/20: % % % %', r.shown, r.approved_unchanged, r.rate_pct, r.status; end if;
  raise notice 'ok   20 of 20 approved unchanged: 100.0, ok';

  -- One edit ("edit 3: ..." changes the hash, back to shown) then approved: a miss. 19/20 = 95.0 is exactly on the line: ok.
  update public.career_outreach_drafts set body = 'my words', hash = lpad(to_hex(901), 64, '0'), status = 'shown', approved_hash = null, approved_at = null where id = did;
  update public.career_outreach_drafts set status = 'approved', approved_hash = hash, approved_at = now0 where id = did;
  select * into r from public.approval_rate(now0) where kind = 'outreach_draft';
  if r.shown <> 20 or r.approved_unchanged <> 19 or r.rate_pct <> 95.0 or r.status <> 'ok' then raise exception 'FAIL 19/20 is on the line: % % % %', r.shown, r.approved_unchanged, r.rate_pct, r.status; end if;
  if (select revisions from public.career_outreach_drafts where id = did) <> 1 then raise exception 'FAIL an edit is counted'; end if;
  raise notice 'ok   an edited draft approved later is a miss; 19 of 20 = 95.0 is ok';

  -- One more shown and skipped: 19/21 = 90.5, below target.
  insert into public.career_outreach_drafts(user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, created_at)
  values (u, gen_random_uuid(), 1, '{"email":"x@example.com"}', 'r21@example.com', 's', 'b', 'f', lpad(to_hex(21), 64, '0'), 'skipped', now0 - interval '3 days');
  select * into r from public.approval_rate(now0) where kind = 'outreach_draft';
  if r.shown <> 21 or r.approved_unchanged <> 19 or r.rate_pct <> 90.5 or r.status <> 'below target' then raise exception 'FAIL 19/21: % % % %', r.shown, r.approved_unchanged, r.rate_pct, r.status; end if;
  raise notice 'ok   a skipped draft is a miss; 19 of 21 = 90.5, below target';

  -- Not counted: a draft only just shown and still waiting; one older than 7 days. Counted: one waiting more than 24 hours.
  insert into public.career_outreach_drafts(user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, created_at)
  values (u, gen_random_uuid(), 1, '{"email":"x@example.com"}', 'w1@example.com', 's', 'b', 'f', lpad(to_hex(31), 64, '0'), now0 - interval '2 hours'),
         (u, gen_random_uuid(), 1, '{"email":"x@example.com"}', 'w2@example.com', 's', 'b', 'f', lpad(to_hex(32), 64, '0'), now0 - interval '8 days');
  select * into r from public.approval_rate(now0) where kind = 'outreach_draft';
  if r.shown <> 21 then raise exception 'FAIL waiting under 24h and older than 7 days are not counted: %', r.shown; end if;
  insert into public.career_outreach_drafts(user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, created_at)
  values (u, gen_random_uuid(), 1, '{"email":"x@example.com"}', 'w3@example.com', 's', 'b', 'f', lpad(to_hex(33), 64, '0'), now0 - interval '30 hours');
  select * into r from public.approval_rate(now0) where kind = 'outreach_draft';
  if r.shown <> 22 or r.approved_unchanged <> 19 then raise exception 'FAIL ignored for 24h counts as shown, not approved: % %', r.shown, r.approved_unchanged; end if;
  raise notice 'ok   waiting under 24h and older than 7 days are not counted; ignored for 24h is a miss';

  -- A row from before tracking began is not counted.
  update public.career_outreach_drafts set approval_tracked = false where recipient_email = 'w3@example.com';
  select * into r from public.approval_rate(now0) where kind = 'outreach_draft';
  if r.shown <> 21 then raise exception 'FAIL untracked rows are not counted: %', r.shown; end if;
  raise notice 'ok   rows from before tracking are not counted';

  -- (The resume guards belong to queuing and preparing; this test only needs rows in each state.)
  alter table public.career_apply_prepared disable trigger user;
  -- Packets: 20 shown on a card, 18 approved, 2 declined = 90.0, below target. An expired one (resume changed) is not counted.
  for i in 1..20 loop
    insert into public.career_apply_prepared(user_id, job_id, company, url, payload, payload_hash, card_lines, state, created_at, updated_at)
    values (u, 'ARJ-' || i, 'Co', 'https://example.com/j', '{}', lpad(to_hex(1000 + i), 64, '0'), array['line'], case when i <= 18 then 'approved' else 'declined' end, now0 - interval '3 days', now0 - interval '2 days');
  end loop;
  insert into public.career_apply_prepared(user_id, job_id, company, url, payload, payload_hash, card_lines, state, created_at, updated_at)
  values (u, 'ARJ-X', 'Co', 'https://example.com/j', '{}', lpad(to_hex(2000), 64, '0'), array['line'], 'expired', now0 - interval '3 days', now0 - interval '2 days');
  select * into r from public.approval_rate(now0) where kind = 'application_packet';
  if r.shown <> 20 or r.approved_unchanged <> 18 or r.rate_pct <> 90.0 or r.status <> 'below target' then raise exception 'FAIL packets: % % % %', r.shown, r.approved_unchanged, r.rate_pct, r.status; end if;
  raise notice 'ok   packets: 18 of 20 = 90.0, below target; expired is not counted';

  -- Advice answers: no feedback exists, so never a rate.
  select * into r from public.approval_rate(now0) where kind = 'advice_answer';
  if r.shown <> 0 or r.rate_pct is not null or r.status <> 'insufficient data' then raise exception 'FAIL advice answers are not measured'; end if;
  if (select count(*) from public.approval_rate_v) <> 3 then raise exception 'FAIL the view has one row per kind'; end if;
  raise notice 'ok   advice answers: insufficient data; the view has one row per kind';

  -- Nothing here approves anything: the measurement changed no draft.
  if (select count(*) from public.career_outreach_drafts where status = 'approved') <> 20 then raise exception 'FAIL measuring changed a draft'; end if;
end $$;

-- Service only.
set local role anon;
do $$ begin perform * from public.approval_rate_v; raise exception 'FAIL anon reads approval_rate_v'; exception when insufficient_privilege then null; end $$;
reset role;
set local role authenticated;
do $$ begin perform * from public.approval_rate(); raise exception 'FAIL a signed-in person runs approval_rate'; exception when insufficient_privilege then null; end $$;
reset role;
set local role service_role;
do $$ begin perform * from public.approval_rate_v; end $$;
reset role;
rollback;
