-- OUTREACH R3 (20261031020000_career_outreach_r3.sql), in the database alone: a newer approval of the same draft replaces
-- the one waiting on the rail (and is queued, not refused as already emailed); an approved draft refused for good says why
-- (skipped, opted_out / bad_address / already_emailed); the worker's last check (career_send_go) answers stop for an
-- address that opted out or bounced after the claim and for a follow-up whose sequence was answered; a retried outreach
-- email whose approval lapsed is handed over marked lapsed, and 'lapsed' cancels it and lapses its draft; service only.
-- (Two approvals at once on two sessions: tests/architect/outreach-r3-pg.test.ts.) Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000c3001'; b uuid := '00000000-0000-4000-8000-0000000c3002';
  d1 uuid := '00000000-0000-4000-8000-0000000c3d01'; d2 uuid := '00000000-0000-4000-8000-0000000c3d02'; d3 uuid := '00000000-0000-4000-8000-0000000c3d03';
  d4 uuid := '00000000-0000-4000-8000-0000000c3d04'; d5 uuid := '00000000-0000-4000-8000-0000000c3d05'; d6 uuid := '00000000-0000-4000-8000-0000000c3d06';
  r jsonb; c jsonb; items jsonb; root uuid; fu uuid; x text;
begin
  insert into auth.users(id, email) values (a, 'r3-a@example.test'), (b, 'r3-b@example.test');
  insert into public.profiles(id) values (a), (b);
  insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values
    (a, 'google_career', 'oauth_google_career_' || a, 'openid email'), (b, 'google_career', 'oauth_google_career_' || b, 'openid email');

  -- (2) Approved (hash a), queued; then edited and approved again (hash b) while the first still waits.
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at) values
    (d1, a, gen_random_uuid(), 1, '{}', 'edit@example.test', 'S', 'B', 'F', repeat('a', 64), 'approved', repeat('a', 64), now());
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', d1, 'approval_hash', repeat('a', 64), 'to', 'edit@example.test', 'subject', 'S', 'body', 'B'))));
  if r->0->>'status' <> 'queued' then raise exception 'FAIL setup: %', r; end if;
  update public.career_outreach_drafts set body = 'B2', hash = repeat('b', 64), approved_hash = repeat('b', 64), approved_at = now() where id = d1;
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', d1, 'approval_hash', repeat('b', 64), 'to', 'edit@example.test', 'subject', 'S', 'body', 'B2'))));
  if r->0->>'status' <> 'queued' then raise exception 'FAIL the newer approval of the same draft is queued: %', r; end if;
  if (select string_agg(state || '|' || approval_hash || '|' || coalesce(result, '-'), ', ' order by created_at, state) from public.career_send_queue where source_id = d1)
     <> 'cancelled|' || repeat('a', 64) || '|replaced by a newer approval of the same draft, queued|' || repeat('b', 64) || '|-' then
    raise exception 'FAIL the older approval is replaced: %', (select string_agg(state || '|' || coalesce(result, '-'), ', ') from public.career_send_queue where source_id = d1);
  end if;
  raise notice 'ok a newer approval of the same draft replaces the one waiting and is queued';

  -- (3) A second draft to the same address (another batch) is refused and says why; so are an opted-out and a bounced one.
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at) values
    (d2, a, gen_random_uuid(), 1, '{}', 'edit@example.test', 'S2', 'B', 'F', repeat('c', 64), 'approved', repeat('c', 64), now()),
    (d3, a, gen_random_uuid(), 1, '{}', 'opted@example.test', 'S', 'B', 'F', repeat('d', 64), 'approved', repeat('d', 64), now()),
    (d4, a, gen_random_uuid(), 1, '{}', 'bounced@example.test', 'S', 'B', 'F', repeat('e', 64), 'approved', repeat('e', 64), now());
  insert into public.career_outreach_dnc(user_id, email_hash, reason) values (b, public.career_send_email_hash('opted@example.test'), 'test');
  insert into public.career_send_bad_addresses(email_hash) values (public.career_send_email_hash('bounced@example.test'));
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', d2, 'approval_hash', repeat('c', 64), 'to', 'edit@example.test', 'subject', 'S2', 'body', 'B'),
    jsonb_build_object('kind', 'outreach', 'source_id', d3, 'approval_hash', repeat('d', 64), 'to', 'opted@example.test', 'subject', 'S', 'body', 'B'),
    jsonb_build_object('kind', 'outreach', 'source_id', d4, 'approval_hash', repeat('e', 64), 'to', 'bounced@example.test', 'subject', 'S', 'body', 'B'))));
  if r->0->>'reason' is distinct from 'already_emailed' or r->1->>'reason' is distinct from 'opted_out' or r->2->>'reason' is distinct from 'bad_address' then raise exception 'FAIL refusals: %', r; end if;
  select string_agg(status || '|' || coalesce(result, '-') || '|' || coalesce(approved_hash, '-'), ', ' order by id) into x from public.career_outreach_drafts where id in (d2, d3, d4);
  if x <> 'skipped|already_emailed|-, skipped|opted_out|-, skipped|bad_address|-' then raise exception 'FAIL a refused draft says why: %', x; end if;
  raise notice 'ok an approved draft refused for good is skipped with its reason';

  -- (4) Claimed, then the address opts out (anyone's "stop"): the last check stops it; the next claim cancels it, saying why.
  c := public.career_send_claim(jsonb_build_object('worker', 'w1', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  items := c->'accounts'->0->'items';
  if jsonb_array_length(items) <> 1 or items->0->>'source_id' <> d1::text then raise exception 'FAIL setup claim: %', c; end if;
  if public.career_send_go(jsonb_build_object('worker', 'w1', 'id', items->0->>'id')) <> 'go' then raise exception 'FAIL go before the stop'; end if;
  insert into public.career_outreach_dnc(user_id, email_hash, reason) values (b, public.career_send_email_hash('edit@example.test'), 'test');
  if public.career_send_go(jsonb_build_object('worker', 'w1', 'id', items->0->>'id')) <> 'stop' then raise exception 'FAIL an opt-out after the claim stops the send'; end if;
  perform public.career_send_complete(jsonb_build_object('worker', 'w1', 'results', jsonb_build_array(jsonb_build_object('id', items->0->>'id', 'outcome', 'retry', 'untried', true, 'retry_at', now() - interval '1 second')),
    'release', jsonb_build_object('user', a, 'provider', 'gmail')));
  c := public.career_send_claim(jsonb_build_object('worker', 'w2', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  if (select state || '|' || result from public.career_send_queue where id = (items->0->>'id')::uuid) <> 'cancelled|opted_out' then raise exception 'FAIL cancelled with the reason'; end if;
  raise notice 'ok an opt-out recorded after the claim stops the send, and the email says why';

  -- (4) A bounce for anyone after the claim stops it too.
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at) values
    (d5, a, gen_random_uuid(), 1, '{}', 'later@example.test', 'S', 'B', 'F', repeat('f', 64), 'approved', repeat('f', 64), now());
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', d5, 'approval_hash', repeat('f', 64), 'to', 'later@example.test', 'subject', 'S', 'body', 'B'))));
  c := public.career_send_claim(jsonb_build_object('worker', 'w3', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  items := c->'accounts'->0->'items';
  insert into public.career_send_bad_addresses(email_hash) values (public.career_send_email_hash('later@example.test'));
  if public.career_send_go(jsonb_build_object('worker', 'w3', 'id', items->0->>'id')) <> 'stop' then raise exception 'FAIL a bounce after the claim stops the send'; end if;
  perform public.career_send_complete(jsonb_build_object('worker', 'w3', 'results', jsonb_build_array(jsonb_build_object('id', items->0->>'id', 'outcome', 'retry', 'untried', true)), 'release', jsonb_build_object('user', a, 'provider', 'gmail')));
  raise notice 'ok a bounce recorded after the claim stops the send';

  -- (4) A follow-up whose first email was answered after the claim.
  r := public.career_send_enqueue(jsonb_build_object('user', b, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('1', 64), 'to', 'seq@example.test', 'subject', 'Hello', 'body', 'B'))));
  root := (r->0->>'id')::uuid;
  update public.career_send_queue set state = 'sent', sent_at = now() - interval '5 days', gmail_id = 'g-root', gmail_thread = 'th-root' where id = root;
  r := public.career_send_enqueue(jsonb_build_object('user', b, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('2', 64), 'to', 'seq@example.test', 'subject', 'Re: Hello', 'body', 'B2', 'follow_up_of', root))));
  fu := (r->0->>'id')::uuid;
  c := public.career_send_claim(jsonb_build_object('worker', 'w4', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  if not exists (select 1 from jsonb_array_elements(c->'accounts') acc, jsonb_array_elements(acc->'items') it where it->>'id' = fu::text) then raise exception 'FAIL setup follow-up claim: %', c; end if;
  if public.career_send_go(jsonb_build_object('worker', 'w4', 'id', fu)) <> 'go' then raise exception 'FAIL go before the answer'; end if;
  perform public.career_send_record(jsonb_build_object('id', root, 'kind', 'reply'));
  if public.career_send_go(jsonb_build_object('worker', 'w4', 'id', fu)) <> 'stop' then raise exception 'FAIL an answer after the claim stops the follow-up'; end if;
  raise notice 'ok an answer recorded after the claim stops the follow-up';

  -- (5) Tried once (Gmail 5xx), then its approval passed 7 days while it was retried.
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at, created_at) values
    (d6, b, gen_random_uuid(), 1, '{}', 'retried@example.test', 'S', 'B', 'F', repeat('9', 64), 'approved', repeat('9', 64), now() - interval '8 days', now() - interval '8 days');
  r := public.career_send_enqueue(jsonb_build_object('user', b, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', d6, 'approval_hash', repeat('9', 64), 'to', 'retried@example.test', 'subject', 'S', 'body', 'B'))));
  update public.career_send_queue set attempts = 3, first_claimed_at = now() - interval '7 days' where id = (r->0->>'id')::uuid;
  update public.career_send_accounts set lease_owner = null, lease_until = null where user_id = b;
  c := public.career_send_claim(jsonb_build_object('worker', 'w5', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  select it into items from jsonb_array_elements(c->'accounts') acc, jsonb_array_elements(acc->'items') it where it->>'source_id' = d6::text;
  if items is null or (items->>'lapsed')::boolean is not true then raise exception 'FAIL a retried email whose approval lapsed is handed over marked lapsed: %', c; end if;
  if public.career_send_complete(jsonb_build_object('worker', 'w5', 'id', items->>'id', 'outcome', 'lapsed', 'detail', 'approval lapsed (more than 7 days)')) #>> '{}' <> 'cancelled' then raise exception 'FAIL lapsed outcome'; end if;
  if (select state || '|' || result from public.career_send_queue where id = (items->>'id')::uuid) <> 'cancelled|approval lapsed (more than 7 days)' then raise exception 'FAIL lapsed on the rail'; end if;
  if (select status || '|' || result || '|' || coalesce(approved_hash, '-') from public.career_outreach_drafts where id = d6) <> 'skipped|expired|-' then raise exception 'FAIL the draft lapses (show lapsed reads it)'; end if;
  raise notice 'ok a retried email whose approval lapsed is not sent, and its draft lapses';

  -- Service only.
  if has_function_privilege('authenticated', 'public.career_send_enqueue(jsonb)', 'execute') or has_function_privilege('anon', 'public.career_send_go(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.career_send_claim(jsonb)', 'execute') or has_function_privilege('authenticated', 'public.career_send_complete_one(text, jsonb)', 'execute') then
    raise exception 'FAIL a signed-in caller can run the rail';
  end if;
  raise notice 'ok service only';
end $$;
rollback;
