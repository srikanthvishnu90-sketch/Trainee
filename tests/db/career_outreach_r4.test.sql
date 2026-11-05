-- OUTREACH R4 (20261105100000_career_outreach_r4.sql), in the database alone: the older one-at-a-time outreach claim
-- (career_outreach_claim) leaves a draft the sending rail has to the rail ('on_rail': queued, handed back for a retry after
-- a 5xx, or cancelled there for an opt-out or a bounce), never sends to an address that bounced for anyone ('bad_address'),
-- and still claims a draft that never reached the rail (approved before Gmail could send). Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000c4001';
  d1 uuid := '00000000-0000-4000-8000-0000000c4d01'; d2 uuid := '00000000-0000-4000-8000-0000000c4d02';
  d3 uuid := '00000000-0000-4000-8000-0000000c4d03'; d4 uuid := '00000000-0000-4000-8000-0000000c4d04';
  r jsonb; c jsonb; it jsonb; x text;
begin
  insert into auth.users(id, email) values (a, 'r4-a@example.test');
  insert into public.profiles(id) values (a);
  insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values (a, 'google_career', 'oauth_google_career_' || a, 'openid email');
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at) values
    (d1, a, gen_random_uuid(), 1, '{}', 'queued@example.test', 'S', 'B', 'F', repeat('a', 64), 'approved', repeat('a', 64), now()),
    (d2, a, gen_random_uuid(), 1, '{}', 'offrail@example.test', 'S', 'B', 'F', repeat('b', 64), 'approved', repeat('b', 64), now()),
    (d3, a, gen_random_uuid(), 1, '{}', 'bounced@example.test', 'S', 'B', 'F', repeat('c', 64), 'approved', repeat('c', 64), now()),
    (d4, a, gen_random_uuid(), 1, '{}', 'retried@example.test', 'S', 'B', 'F', repeat('d', 64), 'approved', repeat('d', 64), now());

  -- (1) Queued on the rail (the chat's hand-off): the older claim leaves it, and the draft is untouched.
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', d1, 'approval_hash', repeat('a', 64), 'to', 'queued@example.test', 'subject', 'S', 'body', 'B'),
    jsonb_build_object('kind', 'outreach', 'source_id', d4, 'approval_hash', repeat('d', 64), 'to', 'retried@example.test', 'subject', 'S', 'body', 'B'))));
  if r->0->>'status' <> 'queued' or r->1->>'status' <> 'queued' then raise exception 'FAIL setup: %', r; end if;
  x := public.career_outreach_claim(a, d1, repeat('a', 64), now(), now());
  if x <> 'on_rail' then raise exception 'FAIL a draft queued on the rail is the rail''s: %', x; end if;
  if (select status || '|' || coalesce(sent_at::text, '-') from public.career_outreach_drafts where id = d1) <> 'approved|-' then raise exception 'FAIL the draft on the rail is untouched'; end if;
  raise notice 'ok a draft queued on the rail is left to the rail';

  -- (2) The rail tried it, Gmail answered 5xx (it may have gone): the draft is 'approved' again for the retry. Still the rail's.
  c := public.career_send_claim(jsonb_build_object('worker', 'w1', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  select i into it from jsonb_array_elements(c->'accounts'->0->'items') i where i->>'source_id' = d4::text;
  if it is null then raise exception 'FAIL setup claim: %', c; end if;
  perform public.career_send_complete(jsonb_build_object('worker', 'w1', 'id', it->>'id', 'outcome', 'retry', 'detail', 'HTTP 503', 'retry_at', now() + interval '1 minute'));
  if (select status from public.career_outreach_drafts where id = d4) <> 'approved' then raise exception 'FAIL setup: the retried draft is approved again'; end if;
  x := public.career_outreach_claim(a, d4, repeat('d', 64), now(), now());
  if x <> 'on_rail' then raise exception 'FAIL a draft the rail is retrying is never sent by the older claim as well: %', x; end if;
  raise notice 'ok a draft the rail is retrying after a 5xx is not sent a second time by the older claim';

  -- (3) Cancelled on the rail for a bounce of its address: neither sender writes to it.
  insert into public.career_send_bad_addresses(email_hash) values (public.career_send_email_hash('queued@example.test'));
  x := public.career_outreach_claim(a, d1, repeat('a', 64), now(), now());
  if x <> 'on_rail' then raise exception 'FAIL still the rail''s: %', x; end if;
  -- Never on the rail, bounced for anyone: refused.
  insert into public.career_send_bad_addresses(email_hash) values (public.career_send_email_hash('Bounced@Example.test '));
  x := public.career_outreach_claim(a, d3, repeat('c', 64), now(), now());
  if x <> 'bad_address' then raise exception 'FAIL an address that bounced for anyone is never claimed: %', x; end if;
  if (select status from public.career_outreach_drafts where id = d3) <> 'approved' then raise exception 'FAIL the claim itself changes nothing on a refusal'; end if;
  raise notice 'ok an address that bounced for anyone is refused (bad_address)';

  -- (4) Never on the rail (approved before Gmail could send): the older claim still sends it, under the same rules.
  x := public.career_outreach_claim(a, d2, repeat('b', 64), now(), now());
  if x <> 'ok' then raise exception 'FAIL a draft that never reached the rail is still claimed: %', x; end if;
  if (select status from public.career_outreach_drafts where id = d2) <> 'sending' then raise exception 'FAIL claimed draft is sending'; end if;
  x := public.career_outreach_claim(a, d2, repeat('b', 64), now(), now());
  if x <> 'not_approved' then raise exception 'FAIL claimed once: %', x; end if;
  raise notice 'ok a draft never on the rail is still claimed once';

  -- Service only.
  if has_function_privilege('authenticated', 'public.career_outreach_claim(uuid, uuid, text, timestamptz, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.career_outreach_claim(uuid, uuid, text, timestamptz, timestamptz)', 'execute')
     or has_function_privilege('public', 'public.career_outreach_claim(uuid, uuid, text, timestamptz, timestamptz)', 'execute') then
    raise exception 'FAIL a signed-in caller can claim a send';
  end if;
  raise notice 'ok service only';
end $$;
rollback;
