-- CONTACT OUTREACH, S2 review of #590 (20261108130500_career_contact_erase_keeps_sends.sql): "forget everything"
-- (career_erase_person) empties the person's contacts but keeps the send log, so the daily new-contact limit and the
-- two-follow-up limit still hold afterwards. Before the fix the erase emptied career_contact_sends: 20 new people, forget
-- everything, and 20 more the same day, every sequence started again. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-00000000c7e1'; other uuid := '00000000-0000-4000-8000-00000000c7e2'; id1 uuid; r text; day date := (now() at time zone 'utc')::date;
  ev jsonb := '{"email":"jane.doe@acme.io","method":"pattern_rcpt_valid","score":80,"syntax":"pass","mx":"pass","provider":"other","catch_all":false,"rcpt":"accept","checked_at":"2026-11-08T00:00:00Z"}';
  hj text := repeat('d', 64); hk text := repeat('e', 64); hl text := repeat('f', 64);
begin
  insert into auth.users(id, email) values (u, 'cc-erase@example.test'), (other, 'cc-erase-other@example.test');
  insert into public.profiles(id) values (u), (other) on conflict do nothing;
  if not ('career_contact_sends' = any(public.career_erase_kept_tables())) then raise exception 'FAIL career_erase_kept_tables does not keep career_contact_sends'; end if;
  if 'public.career_contact_sends' = any(public.career_erase_tables()) then raise exception 'FAIL the erase still owns career_contact_sends'; end if;
  if not ('public.career_contact_profiles' = any(public.career_erase_tables())) then raise exception 'FAIL the erase no longer owns the contacts themselves'; end if;
  if not ('career_outreach_dnc' = any(public.career_erase_kept_tables()) and 'career_watch_kv' = any(public.career_erase_kept_tables())
    and cardinality(public.career_erase_kept_tables()) = 14) then raise exception 'FAIL an existing kept table was dropped: %', public.career_erase_kept_tables(); end if;
  raise notice 'ok   the erase keeps the send log (and every table it kept before); the contacts are still its';

  id1 := public.career_contact_save(jsonb_build_object('user', u, 'person', jsonb_build_object('name', 'Jane Doe', 'title', 'VP Engineering', 'company', 'Acme', 'domain', 'acme.io',
    'source_url', 'https://acme.io/team', 'source_type', 'company_page'), 'facts', '[]'::jsonb, 'email', ev));
  r := public.career_contact_record_send(jsonb_build_object('user', u, 'contact', id1, 'email_hash', hj, 'step', 0, 'day', day, 'cap', 2));
  r := public.career_contact_record_send(jsonb_build_object('user', u, 'email_hash', hk, 'step', 0, 'day', day, 'cap', 2));
  r := public.career_contact_record_send(jsonb_build_object('user', u, 'email_hash', hj, 'step', 1, 'day', day, 'cap', 2));
  r := public.career_contact_record_send(jsonb_build_object('user', u, 'email_hash', hj, 'step', 2, 'day', day, 'cap', 2));
  if r <> 'recorded' then raise exception 'FAIL setup: %', r; end if;
  r := public.career_contact_record_send(jsonb_build_object('user', other, 'email_hash', hl, 'step', 0, 'day', day, 'cap', 2));

  perform public.career_erase_person(u);
  if exists (select 1 from public.career_contact_profiles where user_id = u) or exists (select 1 from public.career_contact_email_evidence where user_id = u)
    then raise exception 'FAIL forget everything left a contact'; end if;
  if (select count(*) from public.career_contact_sends where user_id = u) <> 4 or exists (select 1 from public.career_contact_sends where user_id = u and contact_id is not null)
    then raise exception 'FAIL forget everything emptied (or kept linked) the send log: %', (select jsonb_agg(to_jsonb(s)) from public.career_contact_sends s where user_id = u); end if;
  raise notice 'ok   forget everything removes the contacts and keeps the send log, unlinked';

  r := public.career_contact_record_send(jsonb_build_object('user', u, 'email_hash', hl, 'step', 0, 'day', day, 'cap', 2));
  if r <> 'daily_limit' then raise exception 'FAIL forget everything reset the daily new-contact limit: %', r; end if;
  r := public.career_contact_record_send(jsonb_build_object('user', u, 'email_hash', hj, 'step', 0, 'day', day + 1, 'cap', 2));
  if r <> 'already_recorded' then raise exception 'FAIL forget everything restarted a sent contact''s sequence: %', r; end if;
  r := public.career_contact_record_send(jsonb_build_object('user', u, 'email_hash', hj, 'step', 2, 'day', day + 1, 'cap', 2));
  if r <> 'already_recorded' then raise exception 'FAIL forget everything allowed another follow-up: %', r; end if;
  r := public.career_contact_record_send(jsonb_build_object('user', u, 'email_hash', hl, 'step', 0, 'day', day + 1, 'cap', 2));
  if r <> 'recorded' then raise exception 'FAIL the next day still starts over: %', r; end if;
  if (select count(*) from public.career_contact_sends where user_id = other) <> 1 then raise exception 'FAIL another person''s send log changed'; end if;
  raise notice 'ok   after forget everything the daily limit and the two follow-ups still hold; the next day starts over';

  delete from auth.users where id = u;
  if exists (select 1 from public.career_contact_sends where user_id = u) then raise exception 'FAIL the send log outlived the account'; end if;
  raise notice 'ok   the send log goes with the account';
end $$;
rollback;
