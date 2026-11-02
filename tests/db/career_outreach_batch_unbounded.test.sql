-- outreach drafts without a batch cap (20261031110000_career_outreach_batch_unbounded.sql): one batch holds drafts 1 to 150
-- (the old check stopped at 10); a number below 1 and a number used twice in one batch are still refused; another batch
-- starts again at 1; a turn of 150 model calls keeps its cost row. Everything rolls back.
begin;
reset role;
insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000b7c01', 'obu-a@example.test');
insert into public.profiles(id) values ('00000000-0000-4000-8000-0000000b7c01');
do $$
declare b uuid := gen_random_uuid(); h text := repeat('a', 64); refused boolean;
begin
  insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash)
  select '00000000-0000-4000-8000-0000000b7c01', b, g, '{"name":"Person"}'::jsonb, 'batch.' || g || '@example.test', 'A quick question', 'Hi,', 'Sam', h
  from generate_series(1, 150) g;
  if (select count(*) from public.career_outreach_drafts where batch_id = b) <> 150 then raise exception 'FAIL a batch of 150 was not stored whole'; end if;
  raise notice 'ok   one batch holds drafts 1 to 150';
  begin
    insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash)
    values ('00000000-0000-4000-8000-0000000b7c01', b, 0, '{}'::jsonb, 'zero@example.test', 'S', 'B', 'F', h);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'FAIL draft number 0 was stored'; end if;
  begin
    insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash)
    values ('00000000-0000-4000-8000-0000000b7c01', b, 120, '{}'::jsonb, 'again@example.test', 'S', 'B', 'F', h);
    refused := false;
  exception when unique_violation then refused := true;
  end;
  if not refused then raise exception 'FAIL a number used twice in one batch was stored'; end if;
  raise notice 'ok   a number below 1, and a number used twice in one batch, are refused';
  insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash)
  values ('00000000-0000-4000-8000-0000000b7c01', gen_random_uuid(), 1, '{}'::jsonb, 'next@example.test', 'S', 'B', 'F', h);
  if exists (select 1 from pg_constraint where conrelid = 'public.career_outreach_drafts'::regclass and conname = 'career_outreach_drafts_n_check' and (not convalidated or pg_get_constraintdef(oid) like '%<= 10%')) then
    raise exception 'FAIL the draft-number check is not the validated n >= 1';
  end if;
  raise notice 'ok   another batch starts at 1; the check is validated and has no upper bound';
  -- a turn that drafted 150 emails made 150 model calls on one meter: its cost row is stored as what it was
  insert into public.agent_turn_costs (user_id, meter_state, provider, models, calls, failed, usd_micros)
  values ('00000000-0000-4000-8000-0000000b7c01', 'metered', 'openai', '{gpt-5-mini}', 150, 3, 12000);
  if (select calls from public.agent_turn_costs where user_id = '00000000-0000-4000-8000-0000000b7c01') <> 150 then raise exception 'FAIL a 150-call turn was not recorded'; end if;
  begin
    insert into public.agent_turn_costs (user_id, meter_state, calls) values ('00000000-0000-4000-8000-0000000b7c01', 'metered', -1);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'FAIL a negative call count was stored'; end if;
  raise notice 'ok   a turn of 150 model calls is recorded as it was; a negative count is refused';
end $$;
rollback;
