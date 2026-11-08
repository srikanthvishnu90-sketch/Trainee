-- CONTACT OUTREACH (20261107120200_career_contact_outreach.sql), in the database alone: a contact saves with its facts and
-- evidence in one call; a score that is not its method's is refused; at most 25 facts; another person reads nothing; the
-- client roles reach nothing; the global suppression list and the rail's opt-outs and bounces all suppress; the daily
-- new-contact limit holds (follow-ups do not count); forget removes one contact or all; expired rows purge. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000c701'; b uuid := '00000000-0000-4000-8000-00000000c702';
  id1 uuid; id2 uuid; j jsonb; facts jsonb := '[]'; hs text[]; r text; n int;
  h1 text := repeat('1', 64); h2 text := repeat('2', 64); h3 text := repeat('3', 64); h4 text := repeat('4', 64);
  ev jsonb := '{"email":"jane.doe@acme.io","method":"pattern_rcpt_valid","score":80,"syntax":"pass","mx":"pass","provider":"other","catch_all":false,"rcpt":"accept","format":"first.last","format_evidence":2,"checked_at":"2026-11-07T00:00:00Z","why":"the address format of the company (seen 2+ times), accepted by its mail server"}';
begin
  insert into auth.users(id, email) values (a, 'cc-a@example.test'), (b, 'cc-b@example.test');
  insert into public.profiles(id) values (a), (b) on conflict do nothing;
  for i in 1..30 loop
    facts := facts || jsonb_build_object('claim', 'Fact number ' || i, 'source_url', 'https://acme.io/team', 'source_type', 'company_page', 'retrieved_at', now(),
      'published_at', null, 'quote_snippet', 'Jane Doe, VP Engineering', 'confidence', 0.9, 'method', 'company page card', 'expires_at', now() + interval '90 days');
  end loop;
  id1 := public.career_contact_save(jsonb_build_object('user', a, 'person', jsonb_build_object('name', 'Jane Doe', 'title', 'VP Engineering', 'company', 'Acme', 'domain', 'acme.io',
    'source_url', 'https://acme.io/team', 'source_type', 'company_page'), 'facts', facts, 'email', ev));
  j := public.career_contact_get(jsonb_build_object('user', a, 'id', id1));
  if jsonb_array_length(j->'facts') <> 25 then raise exception 'FAIL at most 25 facts kept: %', jsonb_array_length(j->'facts'); end if;
  if (j->'email'->>'score')::int <> 80 or (j->'email'->>'approvable')::boolean is not true then raise exception 'FAIL evidence: %', j->'email'; end if;
  if public.career_contact_get(jsonb_build_object('user', b, 'id', id1)) is not null then raise exception 'FAIL another person reads the contact'; end if;
  raise notice 'ok   a contact saves with 25 facts and its evidence; only its owner reads it';
  if j->'email'->>'why' is distinct from ev->>'why' then raise exception 'FAIL the evidence keeps its explanation: %', j->'email'; end if;
  id2 := public.career_contact_save(jsonb_build_object('user', a, 'person', j->'person', 'facts', '[]'::jsonb, 'email', ev || '{"method":"github_public","score":90,"mx":"fail","provider":"none","why":"on their public GitHub profile; no mail server confirmed for janedoe.dev"}'));
  j := public.career_contact_get(jsonb_build_object('user', a, 'id', id2));
  if (j->'email'->>'approvable')::boolean is not false or j->'email'->>'why' not like '%no mail server%' then raise exception 'FAIL no mail server is never approvable: %', j->'email'; end if;
  perform public.career_contact_forget(jsonb_build_object('user', a, 'id', id2));
  raise notice 'ok   the evidence keeps its explanation; an address without a confirmed mail server is never approvable';

  begin
    perform public.career_contact_save(jsonb_build_object('user', a, 'person', j->'person', 'facts', '[]'::jsonb, 'email', ev || '{"score":79}'));
    raise exception 'FAIL a score between the method''s values was stored';
  exception when check_violation then null; end;
  begin
    perform public.career_contact_save(jsonb_build_object('user', a, 'person', (j->'person') || '{"source_url":"http://acme.io/team"}', 'facts', '[]'::jsonb, 'email', ev));
    raise exception 'FAIL a non-https source was stored';
  exception when check_violation then null; end;
  raise notice 'ok   a score that is not its method''s, and a non-https source, are refused';

  set local role authenticated;
  begin perform 1 from public.career_contact_profiles; raise exception 'FAIL authenticated reads profiles'; exception when insufficient_privilege then null; end;
  begin perform public.career_contact_suppressed(jsonb_build_object('hashes', to_jsonb(array[h1]))); raise exception 'FAIL authenticated runs suppressed()'; exception when insufficient_privilege then null; end;
  reset role;
  set local role anon;
  begin perform 1 from public.career_contact_suppression; raise exception 'FAIL anon reads suppression'; exception when insufficient_privilege then null; end;
  reset role;
  raise notice 'ok   anon and authenticated reach no table and no function';

  perform public.career_contact_suppress(jsonb_build_object('hash', h1, 'reason', 'asked not to be contacted'));
  perform public.career_contact_suppress(jsonb_build_object('hash', h1, 'reason', 'again'));
  insert into public.career_outreach_dnc(user_id, email_hash) values (b, h2);
  insert into public.career_send_bad_addresses(email_hash) values (h3);
  hs := public.career_contact_suppressed(jsonb_build_object('hashes', to_jsonb(array[h1, h2, h3, h4])));
  if not (hs @> array[h1, h2, h3]) or h4 = any(hs) then raise exception 'FAIL suppressed: %', hs; end if;
  raise notice 'ok   the global list, anyone''s opt-out and any bounce suppress an address for everyone';

  for i in 1..3 loop
    r := public.career_contact_record_send(jsonb_build_object('user', a, 'contact', id1, 'email_hash', repeat(i::text, 63) || 'a', 'step', 0, 'day', '2026-11-07', 'cap', 2));
    if (i <= 2 and r <> 'recorded') or (i = 3 and r <> 'daily_limit') then raise exception 'FAIL daily limit at %: %', i, r; end if;
  end loop;
  r := public.career_contact_record_send(jsonb_build_object('user', a, 'contact', id1, 'email_hash', repeat('1', 63) || 'a', 'step', 1, 'day', '2026-11-07', 'cap', 2));
  if r <> 'recorded' then raise exception 'FAIL a follow-up counts toward the new-contact limit: %', r; end if;
  r := public.career_contact_record_send(jsonb_build_object('user', a, 'contact', id1, 'email_hash', repeat('4', 63) || 'a', 'step', 0, 'day', '2026-11-08', 'cap', 2));
  if r <> 'recorded' then raise exception 'FAIL the next day starts over: %', r; end if;
  raise notice 'ok   the daily new-contact limit holds; follow-ups do not count; the next day starts over';

  id2 := public.career_contact_save(jsonb_build_object('user', a, 'person', j->'person', 'facts', '[]'::jsonb, 'email', ev));
  n := public.career_contact_forget(jsonb_build_object('user', a, 'id', id1));
  if n <> 1 or exists (select 1 from public.career_contact_facts where contact_id = id1) or exists (select 1 from public.career_contact_email_evidence where contact_id = id1)
    or exists (select 1 from public.career_contact_sends where contact_id = id1) then raise exception 'FAIL forget one'; end if;
  if public.career_contact_get(jsonb_build_object('user', a, 'id', id2)) is null then raise exception 'FAIL forget one took another'; end if;
  if public.career_contact_forget(jsonb_build_object('user', b, 'id', id2)) <> 0 then raise exception 'FAIL another person forgot a contact'; end if;
  update public.career_contact_profiles set expires_at = now() - interval '1 second' where id = id2;
  if public.career_contact_get(jsonb_build_object('user', a, 'id', id2)) is not null then raise exception 'FAIL an expired contact is read'; end if;
  n := public.career_contact_purge_expired(); -- assigned first: an OR's operands may run in any order
  if n <> 1 or exists (select 1 from public.career_contact_profiles where id = id2) then raise exception 'FAIL purge'; end if;
  n := public.career_contact_forget(jsonb_build_object('user', a));
  if n <> 0 or exists (select 1 from public.career_contact_sends where user_id = a) then raise exception 'FAIL forget all'; end if;
  if not exists (select 1 from public.career_contact_suppression where email_hash = h1) then raise exception 'FAIL forgetting removed an opt-out'; end if;
  raise notice 'ok   forget one, forget all, expiry purge; an opt-out outlives every forget';
end $$;
rollback;
