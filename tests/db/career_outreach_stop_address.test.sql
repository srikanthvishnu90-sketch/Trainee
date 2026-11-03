-- NETWORKING ROUND 2 (20261030090000_career_outreach_stop_address.sql), in the database alone: "stop emailing X" stops
-- every email of this person's to X that has not gone (queued on the rail, held by a worker, outreach drafts shown or
-- approved, replies-lane follow-ups shown or approved) and turns follow-ups to X off; their email to Y and another
-- person's email to X are untouched; the held email stops at the worker's last check, or, when it had already reached
-- Gmail, is recorded as sent (the truth); discovery marks an opted-out or bounced address as blocked. Service only.
-- Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000ed001'; b uuid := '00000000-0000-4000-8000-0000000ed002';
  d_x uuid := '00000000-0000-4000-8000-0000000edd01'; d_shown uuid := '00000000-0000-4000-8000-0000000edd02'; d_x2 uuid := '00000000-0000-4000-8000-0000000edd03';
  th uuid; th_y uuid; r jsonb; c jsonb; items jsonb; held uuid; root uuid; fu uuid; n int;
begin
  insert into auth.users(id, email) values (a, 'ed-a@example.test'), (b, 'ed-b@example.test');
  insert into public.profiles(id) values (a), (b);
  insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values
    (a, 'google_career', 'oauth_google_career_' || a, 'openid email'), (b, 'google_career', 'oauth_google_career_' || b, 'openid email');
  -- Already sent to x: the first email of a sequence.
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('1', 64), 'to', 'x@example.test', 'subject', 'Hello', 'body', 'B'))));
  root := (r->0->>'id')::uuid;
  c := public.career_send_claim(jsonb_build_object('worker', 'w0', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  perform public.career_send_complete(jsonb_build_object('worker', 'w0', 'results', jsonb_build_array(jsonb_build_object('id', root, 'outcome', 'sent', 'gmail_id', 'g-root', 'thread_id', 'th-root')),
    'release', jsonb_build_object('user', a, 'provider', 'gmail')));
  -- Waiting: an approved outreach draft to x on the rail (a worker will hold it), another approved one not queued yet (the
  -- rail takes one outreach email per address), one shown draft to x, a follow-up of
  -- the first email; this person's email to y; another person's email to x.
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at) values
    (d_x, a, gen_random_uuid(), 1, '{}', 'x@example.test', 'S', 'B', 'F', repeat('a', 64), 'approved', repeat('a', 64), now()),
    (d_x2, a, gen_random_uuid(), 1, '{}', 'x@example.test', 'S2', 'B', 'F', repeat('c', 64), 'approved', repeat('c', 64), now()),
    (d_shown, a, gen_random_uuid(), 1, '{}', 'x@example.test', 'S', 'B', 'F', repeat('b', 64), 'shown', null, null);
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', d_x, 'approval_hash', repeat('a', 64), 'to', 'x@example.test', 'subject', 'S', 'body', 'B'),
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('2', 64), 'to', 'x@example.test', 'subject', 'Re: Hello', 'body', 'F', 'follow_up_of', root, 'send_at', now() + interval '2 days'),
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('3', 64), 'to', 'y@example.test', 'subject', 'Hi y', 'body', 'B', 'send_at', now() + interval '1 minute'))));
  if exists (select 1 from jsonb_array_elements(r) e where e->>'status' <> 'queued') then raise exception 'FAIL setup: %', r; end if;
  -- The replies lane: a conversation with x (a follow-up shown) and one with y (approved).
  insert into public.career_outreach_threads (user_id, provider, provider_thread, recipient_email, recipient_name, recipient_firm, subject, sent_at, status, followup_state)
    values (a, 'gmail', 'th-ed-x', 'x@example.test', 'Xena X', 'Acme', 'Hello', now() - interval '5 days', 'awaiting', 'none') returning id into th;
  insert into public.career_outreach_threads (user_id, provider, provider_thread, recipient_email, recipient_name, recipient_firm, subject, sent_at, status, followup_state)
    values (a, 'gmail', 'th-ed-y', 'y@example.test', 'Yuri Y', 'Acme', 'Hi y', now() - interval '5 days', 'awaiting', 'none') returning id into th_y;
  insert into public.career_outreach_actions (user_id, thread_id, kind, step, batch_id, n, payload, hash, status) values
    (a, th, 'followup', 1, gen_random_uuid(), 1, '{"to":"x@example.test"}', repeat('5', 64), 'shown');
  insert into public.career_outreach_actions (user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at) values
    (a, th_y, 'followup', 1, gen_random_uuid(), 1, '{"to":"y@example.test"}', repeat('6', 64), 'approved', repeat('6', 64), now());
  -- By name: the conversation's address (full name or first name, any case), once.
  if public.career_outreach_addresses_named(jsonb_build_object('user', a, 'name', ' xena  X ')) <> jsonb_build_array(jsonb_build_object('email', 'x@example.test', 'name', 'Xena X'))
     or jsonb_array_length(public.career_outreach_addresses_named(jsonb_build_object('user', a, 'name', 'Xena'))) <> 1
     or jsonb_array_length(public.career_outreach_addresses_named(jsonb_build_object('user', b, 'name', 'Xena'))) <> 0 then
    raise exception 'FAIL the address by name: %', public.career_outreach_addresses_named(jsonb_build_object('user', a, 'name', 'xena x'));
  end if;
  -- A worker holds the due email to x (the claim takes it before y's: queued first).
  c := public.career_send_claim(jsonb_build_object('worker', 'w1', 'accounts', 10, 'per_account', 1, 'lease_seconds', 60));
  items := (select e->'items' from jsonb_array_elements(c->'accounts') e where (e->>'user_id')::uuid = a);
  held := (items->0->>'id')::uuid;
  if items->0->>'to' <> 'x@example.test' or items->0->>'source_id' <> d_x::text then raise exception 'FAIL setup: the held email is the one to x: %', c; end if;
  r := public.career_send_enqueue(jsonb_build_object('user', b, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('4', 64), 'to', 'x@example.test', 'subject', 'From b', 'body', 'B'))));

  r := public.career_send_stop_address(jsonb_build_object('user', a, 'email', ' X@Example.test '));
  if (r->>'queued')::int <> 2 or (r->>'drafts')::int <> 3 or (r->>'actions')::int <> 1 or (r->>'threads')::int <> 1 or (r->>'sent')::int <> 1 then
    raise exception 'FAIL the counts: 2 on the rail (the held one too), 3 drafts, 1 follow-up, 1 conversation, 1 already sent: %', r;
  end if;
  if exists (select 1 from public.career_send_queue where user_id = a and recipient_email = 'x@example.test' and id <> root and (state <> 'cancelled' or result <> 'stopped by you')) then
    raise exception 'FAIL every waiting email to x is cancelled';
  end if;
  if (select state from public.career_send_queue where id = root) <> 'sent' then raise exception 'FAIL what went stays sent'; end if;
  if (select lease_owner from public.career_send_queue where id = held) is distinct from 'w1' then raise exception 'FAIL the holder keeps its hold, so a send it already made is recorded'; end if;
  if exists (select 1 from public.career_outreach_drafts where user_id = a and recipient_email = 'x@example.test' and (status <> 'skipped' or result <> 'stopped by you')) then
    raise exception 'FAIL the drafts to x are skipped: %', (select jsonb_agg(jsonb_build_object('s', status, 'r', result)) from public.career_outreach_drafts where user_id = a);
  end if;
  if (select status from public.career_outreach_actions where thread_id = th) <> 'cancelled' or (select followup_state from public.career_outreach_threads where id = th) <> 'off' then
    raise exception 'FAIL the follow-up to x is cancelled and follow-ups are off';
  end if;
  if (select status from public.career_outreach_actions where thread_id = th_y) <> 'approved' or (select followup_state from public.career_outreach_threads where id = th_y) <> 'none' then
    raise exception 'FAIL y is untouched';
  end if;
  if (select state from public.career_send_queue where user_id = a and recipient_email = 'y@example.test') <> 'queued' then raise exception 'FAIL this person''s email to y still waits'; end if;
  if (select state from public.career_send_queue where user_id = b) <> 'queued' then raise exception 'FAIL another person''s email to x still waits'; end if;
  if exists (select 1 from public.career_outreach_dnc where email_hash = public.career_outreach_email_hash('x@example.test')) then raise exception 'FAIL the person''s stop is no opt-out of the contact'; end if;
  -- The holder's last check says stop; had it already handed the email over, the send is recorded as sent.
  if public.career_send_go(jsonb_build_object('worker', 'w1', 'id', held)) <> 'stop' then raise exception 'FAIL the held email stops at its last check'; end if;
  perform public.career_send_complete(jsonb_build_object('worker', 'w1', 'results', jsonb_build_array(jsonb_build_object('id', held, 'outcome', 'sent', 'gmail_id', 'g-held', 'thread_id', 'th-held')),
    'release', jsonb_build_object('user', a, 'provider', 'gmail')));
  if (select state || '|' || result from public.career_send_queue where id = held) <> 'sent|sent before stopped by you' then
    raise exception 'FAIL a send that went before the stop is recorded as sent: %', (select state || '|' || result from public.career_send_queue where id = held);
  end if;
  -- Nothing more to x is ever handed to a worker from this person.
  c := public.career_send_claim(jsonb_build_object('worker', 'w2', 'accounts', 10, 'per_account', 50, 'lease_seconds', 60, 'now', now() + interval '3 days'));
  if exists (select 1 from jsonb_array_elements(c->'accounts') e, jsonb_array_elements(e->'items') i where (e->>'user_id')::uuid = a and i->>'to' = 'x@example.test') then
    raise exception 'FAIL an email to x was handed over after the stop: %', c;
  end if;
  -- Stopping an address with nothing waiting changes nothing and says so.
  r := public.career_send_stop_address(jsonb_build_object('user', a, 'email', 'nobody@example.test'));
  if (r->>'queued')::int + (r->>'drafts')::int + (r->>'actions')::int + (r->>'threads')::int + (r->>'sent')::int <> 0 then raise exception 'FAIL nothing to stop: %', r; end if;
  begin
    perform public.career_send_stop_address(jsonb_build_object('user', a, 'email', 'not an address'));
    raise exception 'FAIL a malformed address is refused';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- Discovery: an opted-out (anyone's) and a bounced address are marked blocked; a clean one is not.
  insert into public.career_people (user_id, source, name, email, company, company_key, position, source_ref, source_url, dedupe_key, provider, provider_id, domain, email_status, mx, sendable, fetched_at) values
    (a, 'provider', 'P One', 'p1@example.test', 'Acme', 'acme-ed', 'Recruiter', 'public page', 'https://acme.example.com/team', 'p:web:ed1', 'web', 'ed1', 'example.test', 'published', 'pass', true, now()),
    (a, 'provider', 'P Two', 'p2@example.test', 'Acme', 'acme-ed', 'Recruiter', 'public page', 'https://acme.example.com/team', 'p:web:ed2', 'web', 'ed2', 'example.test', 'published', 'pass', true, now()),
    (a, 'provider', 'P Three', 'p3@example.test', 'Acme', 'acme-ed', 'Recruiter', 'public page', 'https://acme.example.com/team', 'p:web:ed3', 'web', 'ed3', 'example.test', 'published', 'pass', true, now());
  insert into public.career_outreach_dnc (user_id, email_hash, reason) values (b, public.career_outreach_email_hash('p1@example.test'), 'recipient asked to stop');
  insert into public.career_send_bad_addresses (email_hash, reason) values (public.career_send_email_hash('p2@example.test'), 'bounced') on conflict do nothing;
  select count(*) filter (where (x->>'blocked')::boolean) into n from public.career_provider_candidates(a, array['acme-ed'], 0, 100) x;
  if n <> 2 or exists (select 1 from public.career_provider_candidates(a, array['acme-ed'], 0, 100) x where x->>'email' = 'p3@example.test' and (x->>'blocked')::boolean) then
    raise exception 'FAIL the opted-out and the bounced address are blocked, the clean one is not (%)', n;
  end if;
end $$;
-- Service only.
do $$ begin
  if has_function_privilege('anon', 'public.career_send_stop_address(jsonb)', 'execute') or has_function_privilege('authenticated', 'public.career_send_stop_address(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.career_outreach_addresses_named(jsonb)', 'execute') or has_function_privilege('authenticated', 'public.career_outreach_addresses_named(jsonb)', 'execute') then
    raise exception 'FAIL career_send_stop_address and career_outreach_addresses_named are service role only';
  end if;
end $$;
\echo PASS career_outreach_stop_address
rollback;
