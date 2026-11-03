-- OUTREACH SCENARIOS (20261030040000_career_send_claim_guards.sql), in the database alone: an approved outreach email never
-- tried whose approval is more than 7 days old is not handed to a worker (cancelled; its draft lapses as skipped/'expired',
-- the state "show lapsed" reads), while one inside its 7 days is; a follow-up is handed over with its sequence's emails
-- already sent from Gmail (their threads), and the first email alone is handed over with none. Service only. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000cf001';
  old_d uuid := '00000000-0000-4000-8000-0000000cfd01'; new_d uuid := '00000000-0000-4000-8000-0000000cfd02';
  r jsonb; c jsonb; items jsonb; it jsonb; root uuid; fu uuid; n int;
begin
  insert into auth.users(id, email) values (a, 'cf-a@example.test');
  insert into public.profiles(id) values (a);
  insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values (a, 'google_career', 'oauth_google_career_' || a, 'openid email');
  -- Two approved drafts: one approved 8 days ago (it waited on a pause), one approved an hour ago.
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at, created_at) values
    (old_d, a, gen_random_uuid(), 1, '{}', 'old@example.test', 'S', 'B', 'F', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '8 days', now() - interval '8 days'),
    (new_d, a, gen_random_uuid(), 1, '{}', 'new@example.test', 'S', 'B', 'F', repeat('b', 64), 'approved', repeat('b', 64), now() - interval '1 hour', now() - interval '1 hour');
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'outreach', 'source_id', old_d, 'approval_hash', repeat('a', 64), 'to', 'old@example.test', 'subject', 'S', 'body', 'B'),
    jsonb_build_object('kind', 'outreach', 'source_id', new_d, 'approval_hash', repeat('b', 64), 'to', 'new@example.test', 'subject', 'S', 'body', 'B'))));
  if r->0->>'status' <> 'queued' or r->1->>'status' <> 'queued' then raise exception 'FAIL setup: %', r; end if;
  c := public.career_send_claim(jsonb_build_object('worker', 'w1', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  items := c->'accounts'->0->'items';
  if jsonb_array_length(items) <> 1 or items->0->>'source_id' <> new_d::text then raise exception 'FAIL only the approval inside its 7 days is handed over: %', c; end if;
  if (select state || '|' || result from public.career_send_queue where source_id = old_d) <> 'cancelled|approval lapsed (more than 7 days)' then
    raise exception 'FAIL the lapsed approval is cancelled on the rail: %', (select state || '|' || result from public.career_send_queue where source_id = old_d);
  end if;
  if (select status || '|' || result || '|' || coalesce(approved_hash, '-') from public.career_outreach_drafts where id = old_d) <> 'skipped|expired|-' then
    raise exception 'FAIL the lapsed draft reads as lapsed (skipped, expired, no approval)';
  end if;
  if (select status from public.career_outreach_drafts where id = new_d) <> 'sending' then raise exception 'FAIL the fresh one is being sent'; end if;
  perform public.career_send_complete(jsonb_build_object('worker', 'w1', 'results', jsonb_build_array(jsonb_build_object('id', items->0->>'id', 'outcome', 'sent', 'gmail_id', 'g-new', 'thread_id', 'th-new')),
    'release', jsonb_build_object('user', a, 'provider', 'gmail')));

  -- A sequence: the first email (sent, thread th-root) and its follow-up, due now.
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('c', 64), 'to', 'seq@example.test', 'subject', 'Hello', 'body', 'B'))));
  root := (r->0->>'id')::uuid;
  c := public.career_send_claim(jsonb_build_object('worker', 'w2', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  it := c->'accounts'->0->'items'->0;
  if (it->>'id')::uuid <> root or it->'sequence' <> 'null'::jsonb then raise exception 'FAIL the first email has no sequence: %', it; end if;
  perform public.career_send_complete(jsonb_build_object('worker', 'w2', 'results', jsonb_build_array(jsonb_build_object('id', root, 'outcome', 'sent', 'gmail_id', 'g-root', 'thread_id', 'th-root')),
    'release', jsonb_build_object('user', a, 'provider', 'gmail')));
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('d', 64), 'to', 'seq@example.test', 'subject', 'Re: Hello', 'body', 'B2', 'follow_up_of', root))));
  fu := (r->0->>'id')::uuid;
  c := public.career_send_claim(jsonb_build_object('worker', 'w3', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  it := c->'accounts'->0->'items'->0;
  if (it->>'id')::uuid <> fu then raise exception 'FAIL the follow-up is handed over: %', c; end if;
  if jsonb_array_length(it->'sequence') <> 1 or it->'sequence'->0->>'gmail_thread' <> 'th-root' or (it->'sequence'->0->>'id')::uuid <> root
     or it->'sequence'->0->>'recipient_email' <> 'seq@example.test' or it->'sequence'->0->>'gmail_id' <> 'g-root' then
    raise exception 'FAIL the follow-up carries its sequence''s sent emails: %', it->'sequence';
  end if;
  -- The answer the worker found is recorded there: the sequence stops, and the handed-back follow-up is then cancelled.
  if public.career_send_record(jsonb_build_object('id', root, 'kind', 'reply')) <> 'reply' then raise exception 'FAIL record the reply'; end if;
  perform public.career_send_complete(jsonb_build_object('worker', 'w3', 'results', jsonb_build_array(jsonb_build_object('id', fu, 'outcome', 'retry', 'untried', true, 'detail', 'reply on the thread', 'retry_at', now())),
    'release', jsonb_build_object('user', a, 'provider', 'gmail')));
  c := public.career_send_claim(jsonb_build_object('worker', 'w4', 'accounts', 10, 'per_account', 10, 'lease_seconds', 60));
  if jsonb_array_length(c->'accounts') <> 0 then raise exception 'FAIL nothing more is handed over: %', c; end if;
  if (select state || '|' || result || '|' || attempts from public.career_send_queue where id = fu) <> 'cancelled|sequence stopped|0' then
    raise exception 'FAIL the follow-up is cancelled, never tried: %', (select state || '|' || result || '|' || attempts from public.career_send_queue where id = fu);
  end if;
  select count(*) into n from information_schema.routine_privileges where routine_name = 'career_send_claim' and grantee in ('anon', 'authenticated', 'PUBLIC');
  if n <> 0 then raise exception 'FAIL career_send_claim is the service role''s only'; end if;
  raise notice 'PASS career_send_claim_guards: a lapsed approval is cancelled and lapses; a follow-up carries its sequence; an answer recorded stops it';
end $$;

-- A worker's clock is in milliseconds; next_at is in microseconds. An email whose next_at falls later in the same
-- millisecond as the worker's time is due (CI found one left unclaimed, the worker then stopping with work queued).
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000cf101';
  q uuid; r jsonb; c jsonb; ms timestamptz;
begin
  insert into auth.users(id, email) values (a, 'cf-ms@example.test');
  insert into public.profiles(id) values (a);
  insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values (a, 'google_career', 'oauth_google_career_' || a, 'openid email');
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('c', 64), 'to', 'ms@example.test', 'subject', 'S', 'body', 'B'))));
  if r->0->>'status' <> 'queued' then raise exception 'FAIL setup: %', r; end if;
  q := (r->0->>'id')::uuid;
  ms := date_trunc('milliseconds', clock_timestamp()) - interval '1 second';
  update public.career_send_queue set next_at = ms + interval '467 microseconds' where id = q;
  c := public.career_send_claim(jsonb_build_object('worker', 'w-ms', 'accounts', 50, 'per_account', 50, 'lease_seconds', 60,
    'now', to_char(ms at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  if not exists (select 1 from jsonb_array_elements(c->'accounts') x, jsonb_array_elements(x->'items') i where (i->>'id')::uuid = q) then
    raise exception 'FAIL an email due earlier in the same millisecond was not claimed: %', c;
  end if;
  raise notice 'ok   an email due within the worker''s millisecond is claimed';
end $$;
rollback;
