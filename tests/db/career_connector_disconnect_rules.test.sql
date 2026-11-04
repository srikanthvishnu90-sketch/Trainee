-- CONNECTOR SCENARIOS (20261029200000_career_connector_disconnect_rules.sql), in the database alone: a disconnect cancels
-- every email of that mailbox, the one a worker holds included; the worker's last check (career_send_go) stops it; an
-- email the provider already accepted is recorded as sent; the lapsed lease of a dead worker never puts a cancelled email
-- back in the queue, even after the person connects again; disconnecting Outlook leaves the emails going from Gmail; the
-- replies lane's approved follow-ups are cancelled and what was read is erased; what waits is counted at any volume;
-- an account deletion keeps the opt-out hash with no owner. Rolled back.
\set ON_ERROR_STOP on
begin;
reset role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000cd001'; b uuid := '00000000-0000-4000-8000-0000000cd002';
  r jsonb; held uuid; dead uuid; waiting uuid; th uuid := gen_random_uuid(); w jsonb; n int; s text;
begin
  insert into auth.users(id, email) values (a, 'cd-a@example.test'), (b, 'cd-b@example.test');
  insert into public.profiles(id) values (a), (b);
  insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values
    (a, 'google_career', 'oauth_google_career_' || a, 'openid email'), (a, 'microsoft', 'oauth_microsoft_' || a, 'Mail.Send'),
    (b, 'google_career', 'oauth_google_career_' || b, 'openid email');
  -- A: three Gmail emails (one held by a live worker, one by a dead worker, one waiting), an outreach email queued on
  -- Outlook, and an approved follow-up of the replies lane on a Gmail thread with the contact's turn read from Gmail.
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('1', 64), 'to', 'held@example.test', 'subject', 'S', 'body', 'B'),
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('2', 64), 'to', 'dead@example.test', 'subject', 'S', 'body', 'B'),
    jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(), 'approval_hash', repeat('3', 64), 'to', 'wait@example.test', 'subject', 'S', 'body', 'B', 'send_at', now() + interval '1 day'))));
  held := (r->0->>'id')::uuid; dead := (r->1->>'id')::uuid; waiting := (r->2->>'id')::uuid;
  insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at)
    values ('00000000-0000-4000-8000-0000000cdd01', a, gen_random_uuid(), 1, '{}', 'via-outlook@example.test', 'S', 'B', 'F', repeat('4', 64), 'approved', repeat('4', 64), now());
  r := public.career_send_enqueue(jsonb_build_object('user', a, 'items', jsonb_build_array(jsonb_build_object('kind', 'outreach', 'source_id', '00000000-0000-4000-8000-0000000cdd01',
    'approval_hash', repeat('4', 64), 'to', 'via-outlook@example.test', 'subject', 'S', 'body', 'B', 'provider', 'outlook', 'send_at', now() + interval '1 day'))));
  if r->0->>'status' <> 'queued' then raise exception 'FAIL setup outlook outreach %', r; end if;
  insert into public.career_outreach_threads(id, user_id, provider, provider_thread, recipient_email, sent_at, turns, followup_state) values (th, a, 'gmail', 'gt-1', 'held@example.test', now(), 2, 'drafted');
  insert into public.career_outreach_turns(thread_id, provider_msg, user_id, who, class) values (th, 'm1', a, 'person', 'sent'), (th, 'm2', a, 'contact', 'interested');
  insert into public.career_outreach_actions(user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at)
    values (a, th, 'followup', 1, gen_random_uuid(), 1, '{"to":"held@example.test"}', repeat('5', 64), 'approved', repeat('5', 64), now());
  insert into public.career_outreach_sync(user_id, provider, cursor, next_at) values (a, 'gmail', 'h-1', now());
  update public.career_send_queue set state = 'sending', lease_owner = 'w-live', lease_until = now() + interval '2 minutes', attempts = 1, first_claimed_at = now() where id = held;
  update public.career_send_queue set state = 'sending', lease_owner = 'w-dead', lease_until = now() - interval '1 minute', attempts = 1, first_claimed_at = now() where id = dead;
  if public.career_send_go(jsonb_build_object('worker', 'w-live', 'id', held)) <> 'go' then raise exception 'FAIL the lease holder of a connected mailbox may go'; end if;
  if public.career_send_go(jsonb_build_object('worker', 'w-other', 'id', held)) <> 'stop' then raise exception 'FAIL only the lease holder may go'; end if;
  w := public.career_connector_waiting(a, 'gmail');
  if w <> '{"queued": 1, "actions": 1, "sending": 2, "approved": 0}'::jsonb then raise exception 'FAIL what waits on Gmail: %', w; end if;
  w := public.career_connector_waiting(a, 'outlook');
  if w <> '{"queued": 0, "actions": 0, "sending": 0, "approved": 1}'::jsonb then raise exception 'FAIL what waits on Outlook: %', w; end if;

  delete from public.user_oauth_connections where user_id = a and provider = 'google_career';

  select string_agg(state || ':' || coalesce(lease_owner, '-'), ',' order by recipient_email) into s from public.career_send_queue where user_id = a and provider = 'gmail';
  if s <> 'cancelled:w-dead,cancelled:w-live,cancelled:-' then raise exception 'FAIL every Gmail email cancelled, the held ones keep their holder: %', s; end if;
  if public.career_send_go(jsonb_build_object('worker', 'w-live', 'id', held)) <> 'stop' then raise exception 'FAIL the worker stops after the disconnect'; end if;
  w := public.career_connector_waiting(a, 'gmail');
  if w <> '{"queued": 0, "actions": 0, "sending": 0, "approved": 0}'::jsonb then raise exception 'FAIL nothing waits on Gmail after: %', w; end if;
  if (select status from public.career_outreach_drafts where id = '00000000-0000-4000-8000-0000000cdd01') <> 'approved'
     or (select state from public.career_send_queue where source_id = '00000000-0000-4000-8000-0000000cdd01') <> 'queued' then
    raise exception 'FAIL disconnecting Gmail leaves the email going from Outlook';
  end if;
  if (select status from public.career_outreach_actions where thread_id = th) <> 'cancelled' then raise exception 'FAIL the replies lane''s approved follow-up is cancelled'; end if;
  if exists (select 1 from public.career_outreach_turns where thread_id = th and who <> 'person') or (select turns from public.career_outreach_threads where id = th) <> 1
     or (select cursor from public.career_outreach_sync where user_id = a and provider = 'gmail') is not null then
    raise exception 'FAIL what was read from Gmail is erased (the contact''s turn, the read position)';
  end if;
  -- The live worker had already handed it to Gmail: recorded as sent (the truth). Another outcome only ends the hold.
  r := public.career_send_complete(jsonb_build_object('worker', 'w-live', 'id', held, 'outcome', 'sent', 'gmail_id', 'g-1', 'thread_id', 't-1'));
  if (r #>> '{}') <> 'sent'
     or (select state from public.career_send_queue where id = held) <> 'sent' then raise exception 'FAIL an email Gmail accepted is recorded as sent'; end if;
  -- The dead worker's lease lapses after the person connected again: the cancelled email is never queued again.
  insert into public.user_oauth_connections(user_id, provider, vault_name, scopes) values (a, 'google_career', 'oauth_google_career_' || a, 'openid email');
  r := public.career_send_claim(jsonb_build_object('worker', 'w-next', 'accounts', 50, 'per_account', 50, 'lease_seconds', 60, 'now', now() + interval '2 days'));
  if exists (select 1 from jsonb_array_elements(r->'accounts') x, jsonb_array_elements(x->'items') i where (i->>'id')::uuid in (held, dead, waiting)) then
    raise exception 'FAIL a cancelled email came back after the reconnect: %', r;
  end if;
  if (select state from public.career_send_queue where id = dead) <> 'cancelled' then raise exception 'FAIL the dead worker''s email stays cancelled'; end if;
  -- Disconnecting Outlook cancels its own email, and only that.
  delete from public.user_oauth_connections where user_id = a and provider = 'microsoft';
  if (select status from public.career_outreach_drafts where id = '00000000-0000-4000-8000-0000000cdd01') <> 'skipped' then raise exception 'FAIL Outlook''s own email is cancelled'; end if;
  -- An account deletion keeps the opt-out hash, with no owner, and it still refuses anyone.
  insert into public.career_outreach_dnc(user_id, email_hash) values (a, public.career_send_email_hash('said-stop@example.test'));
  delete from auth.users where id = a;
  if not exists (select 1 from public.career_outreach_dnc where user_id is null and email_hash = public.career_send_email_hash('said-stop@example.test')) then
    raise exception 'FAIL the opt-out hash outlives the account';
  end if;
  r := public.career_send_enqueue(jsonb_build_object('user', b, 'items', jsonb_build_array(jsonb_build_object('kind', 'general', 'source_id', gen_random_uuid(),
    'approval_hash', repeat('6', 64), 'to', 'said-stop@example.test', 'subject', 'S', 'body', 'B'))));
  if r->0->>'reason' is distinct from 'opted_out' then raise exception 'FAIL another person''s email to them is refused: %', r; end if;
  raise notice 'ok   a disconnect cancels every email of the mailbox (held ones included), stops the worker, records what already went, never re-queues; the other mailbox, the replies lane and the opt-out list hold';
end $$;
rollback;
