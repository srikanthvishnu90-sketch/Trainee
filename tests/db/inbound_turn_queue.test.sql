-- 20261102170000 (ACK FAST): the queue's claim on the suite's schema: dedupe, per-contact order, the lease, the retry cap, no
-- grant to anon. The long concurrent run with dying workers is tests/architect/ack-fast-queue-pg.test.ts.
begin;
reset role;
do $$ declare a public.inbound_turn_queue; n int; ok_ boolean; s text;
begin
  if not public.inbound_turn_enqueue('telegram', 't:1', 'tg:1', '{"text":"a"}') then raise exception 'FAIL first enqueue'; end if;
  if public.inbound_turn_enqueue('telegram', 't:1', 'tg:1', '{"text":"a"}') then raise exception 'FAIL a retried delivery queued twice'; end if;
  perform public.inbound_turn_enqueue('telegram', 't:2', 'tg:1', '{"text":"b"}');
  perform public.inbound_turn_enqueue('telegram', 't:3', 'tg:2', '{"text":"c"}');
  select count(*) into n from public.inbound_turn_claim(10, 60, now(), 3);
  if n <> 2 then raise exception 'FAIL one in flight per contact: claimed %', n; end if;
  raise notice 'ok   a person''s second text waits for the first (2 of 3 claimed)';
  select count(*) into n from public.inbound_turn_claim(10, 60, now() + interval '30 seconds', 3);
  if n <> 0 then raise exception 'FAIL a live lease was taken over'; end if;
  select count(*) into n from public.inbound_turn_claim(10, 60, now() + interval '61 seconds', 3);
  if n <> 2 then raise exception 'FAIL an expired lease was not claimed again: %', n; end if;
  select * into a from public.inbound_turn_queue where provider_msg_id = 't:1';
  if a.attempts <> 2 then raise exception 'FAIL attempts %', a.attempts; end if;
  if public.inbound_turn_finish(a.id, gen_random_uuid(), 'done') <> 'stale' then raise exception 'FAIL a stranger finished a claim'; end if;
  if public.inbound_turn_finish(a.id, a.claim_token, 'done') <> 'done' then raise exception 'FAIL finish'; end if;
  select payload::text into s from public.inbound_turn_queue where id = a.id;
  if s <> '{}' then raise exception 'FAIL text kept on a done row'; end if;
  raise notice 'ok   lease taken over only after it ran out; a stale holder changes nothing; done keeps no text';
  select has_function_privilege('anon', 'public.inbound_turn_claim(integer,integer,timestamptz,integer,integer)', 'execute') into ok_;
  if ok_ then raise exception 'FAIL anon can claim turns'; end if;
  raise notice 'ok   anon cannot run the queue functions';
end $$;
rollback;
