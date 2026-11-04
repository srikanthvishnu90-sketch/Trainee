-- ACK FAST (2026-11-02, scale plan bottleneck 2; owner: "must serve 90,000 users"): a chat webhook (Telegram, iMessage) used to
-- run the whole turn (a model call of 3 to 20 seconds) before it answered the provider, so a burst of texts held one edge
-- invocation each, past the 3 s the provider waits, and a crash lost the message. With CHAT_QUEUE=on the webhook verifies,
-- dedupes by the provider's message id, writes ONE row here and answers 200; the trainee-turn-worker claims rows, runs the
-- same turn code as before (_shared/channel_inbound.ts runInbound), and marks them done. Off (the default) none of this is
-- touched: the table stays empty and the webhooks run the turn inline as they always did.
--
--   provider_msg_id  unique: "<provider>:<message id>" (a Telegram update id and an iMessage id never collide). The webhook's
--                    dedupe: a retried delivery inserts nothing and is answered as a duplicate.
--   contact          the ordering key (tg:<chat>, +E.164, wa:<id>): a person's second message waits for the first. The claim
--                    never hands out a row while an older row of the same contact is queued or claimed. Nulled when the row
--                    ends (the number is not kept past the turn: channel_inbound keeps ids only, and so does this).
--   payload          the parsed InboundMessage (its text). Emptied when the row is done; kept on a failed row for the owner
--                    to read and replay, and removed with the row by inbound_turn_purge.
--   status           queued -> claimed -> done | failed. A claimed row whose lease passed is claimable again (a crashed or
--                    timed-out worker); attempts counts claims; after p_max_attempts (3) the row is FAILED, never dropped:
--                    ops-monitor reads inbound_turn_health and alerts the owner (_shared/ops_monitor.ts turn_queue_failed).
--   claim_token      the claim's own token: only the worker that holds it can finish the row, so a worker whose lease was
--                    taken over cannot mark the newer attempt done or failed.
--   available_at     retry backoff: a released row is not claimable until then (20 s, then 60 s).
--   done_steps       the side effects of the turn that go straight to the person (a Yes/No prompt, job cards, documents, a long
--                    answer's rest, files, links) are each recorded here BEFORE they are sent, under the claim's token, so a retry
--                    skips what a dead attempt already did (at most once, never twice) and a stale attempt (its lease taken over,
--                    or timed out) records nothing and so sends nothing: inbound_turn_step is the fence.
--   told             a failed row's person has been told (the turn said it itself, or the worker's sweep queued the neutral line).
-- Every function is SECURITY DEFINER with a fixed search_path and service_role only; the table is RLS-on with no policy.
-- Rollback: supabase/rollbacks/20261102170000_inbound_turn_queue.down.sql

create table if not exists public.inbound_turn_queue (
  id bigint generated always as identity primary key,
  channel text not null check (length(channel) between 1 and 20),
  provider_msg_id text not null unique check (length(provider_msg_id) between 1 and 300),
  contact text check (contact is null or length(contact) between 1 and 300),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  lease_until timestamptz,
  claim_token uuid,
  available_at timestamptz not null default now(),
  done_steps text[] not null default '{}',
  told boolean not null default false,
  last_error text check (last_error is null or length(last_error) <= 500),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  -- an active row always has its ordering key; a finished one has let it go
  check (status in ('done', 'failed') or contact is not null)
);
-- The claim's two reads: the oldest active row of a contact, and the oldest claimable rows overall.
create index if not exists inbound_turn_queue_contact_active on public.inbound_turn_queue (contact, id) where status in ('queued', 'claimed');
create index if not exists inbound_turn_queue_claimable on public.inbound_turn_queue (id) where status in ('queued', 'claimed');
create index if not exists inbound_turn_queue_failed on public.inbound_turn_queue (finished_at) where status = 'failed';
create index if not exists inbound_turn_queue_finished on public.inbound_turn_queue (finished_at) where status = 'done';
alter table public.inbound_turn_queue enable row level security;
revoke all on public.inbound_turn_queue from public, anon, authenticated;
grant all on public.inbound_turn_queue to service_role;

-- The webhook's write. true: queued; false: this provider message id was queued before (a retried delivery).
create or replace function public.inbound_turn_enqueue(p_channel text, p_msg_id text, p_contact text, p_payload jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.inbound_turn_queue (channel, provider_msg_id, contact, payload)
  values (p_channel, p_msg_id, p_contact, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider_msg_id) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- The worker's claim. Fails first the rows whose last allowed attempt ran out of lease (nothing dropped: they stay, failed,
-- for the alert). Then claims up to p_limit rows with FOR UPDATE SKIP LOCKED, oldest first, never a row that has an older
-- queued or claimed row of the same contact (one in flight per person, in order). Two workers never get the same row, and
-- never two rows of one contact in one call (the second has the first as its older row).
create or replace function public.inbound_turn_claim(p_limit integer default 5, p_lease_seconds integer default 180,
  p_now timestamptz default now(), p_max_attempts integer default 3, p_max_inflight integer default 20)
returns setof public.inbound_turn_queue language plpgsql security definer set search_path = public, pg_temp as $$
declare room integer;
begin
  -- Claims are serialized for the few milliseconds of the count and the update, so the global cap holds under concurrent workers
  -- (the row locks below still skip rows another transaction holds).
  perform pg_advisory_xact_lock(hashtext('inbound_turn_claim'));
  update public.inbound_turn_queue q
     set status = 'failed', finished_at = p_now, contact = null, lease_until = null, claim_token = null,
         last_error = left(coalesce(q.last_error || '; ', '') || 'lease expired on the last attempt', 500)
   where q.status = 'claimed' and q.lease_until <= p_now and q.attempts >= p_max_attempts;
  -- Global in-flight cap: rows under a live lease count; at the cap nothing new is claimed (the queue absorbs the burst).
  select greatest(0, least(coalesce(p_limit, 0), coalesce(p_max_inflight, 20) - count(*)))::integer into room
    from public.inbound_turn_queue where status = 'claimed' and lease_until > p_now;
  return query
  with c as (
    select q.id from public.inbound_turn_queue q
     where (q.status = 'queued' or (q.status = 'claimed' and q.lease_until <= p_now))
       and q.attempts < p_max_attempts and q.available_at <= p_now
       and not exists (select 1 from public.inbound_turn_queue o
                        where o.contact = q.contact and o.id < q.id and o.status in ('queued', 'claimed'))
     order by q.id
     limit room
     for update of q skip locked)
  update public.inbound_turn_queue u
     set status = 'claimed', attempts = u.attempts + 1, claimed_at = p_now,
         lease_until = p_now + make_interval(secs => greatest(10, p_lease_seconds)), claim_token = gen_random_uuid()
    from c where u.id = c.id
  returning u.*;
end $$;

-- The worker's end of a claim. p_outcome: 'done' (the turn ran), 'failed' (it ran and could not answer: surfaced to ops, not
-- retried), 'retry' (it did not finish: back to queued after a backoff, or failed when no attempt is left). Returns the row's
-- new status, or 'stale' when the token is not the row's current claim (the lease was taken over: this worker changes nothing).
create or replace function public.inbound_turn_finish(p_id bigint, p_token uuid, p_outcome text, p_error text default null,
  p_now timestamptz default now(), p_max_attempts integer default 3, p_told boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.inbound_turn_queue; s text; err text := left(p_error, 500);
begin
  if p_outcome not in ('done', 'failed', 'retry') then raise exception 'inbound_turn_finish: outcome must be done, failed or retry'; end if;
  select * into r from public.inbound_turn_queue where id = p_id and claim_token = p_token and status = 'claimed' for update;
  if not found then return 'stale'; end if;
  if p_outcome = 'retry' and r.attempts < p_max_attempts then
    update public.inbound_turn_queue set status = 'queued', lease_until = null, claim_token = null, last_error = err,
           available_at = p_now + make_interval(secs => case r.attempts when 1 then 20 else 60 end) where id = p_id;
    return 'queued';
  end if;
  s := case when p_outcome = 'done' then 'done' else 'failed' end;
  update public.inbound_turn_queue
     set status = s, finished_at = p_now, contact = null, lease_until = null, claim_token = null,
         payload = case when s = 'done' then '{}'::jsonb else payload end, told = (s = 'failed' and coalesce(p_told, false)),
         last_error = case when p_outcome = 'retry' then left(coalesce(err, 'out of attempts'), 500) else err end
   where id = p_id;
  return s;
end $$;

-- The fence and the once-only record of one side effect. true: this claim's attempt may do it now (it is recorded first). false: it
-- was done by an earlier attempt, or this token is no longer the row's claim (stale: do nothing).
create or replace function public.inbound_turn_step(p_id bigint, p_token uuid, p_step text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.inbound_turn_queue set done_steps = done_steps || p_step
   where id = p_id and claim_token = p_token and status = 'claimed' and not (p_step = any(done_steps));
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Failed rows whose person has not been told (the worker queues a neutral line for each, then marks it).
create or replace function public.inbound_turn_untold(p_limit integer default 10)
returns setof public.inbound_turn_queue language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.inbound_turn_queue where status = 'failed' and not told order by id limit greatest(0, coalesce(p_limit, 0))
$$;
create or replace function public.inbound_turn_told(p_id bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.inbound_turn_queue set told = true where id = p_id and status = 'failed' and not told;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- What ops-monitor reads: how many wait, how long the oldest has waited, how many are in flight, and the failed rows the owner
-- has not been told about (failed within p_window, and the newest one's id so a new failure is a new alert).
create or replace function public.inbound_turn_health(p_now timestamptz default now(), p_window interval default interval '24 hours')
returns table (queued bigint, claimed bigint, oldest_queued_at timestamptz, failed_recent bigint, newest_failed_id bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*) filter (where status = 'queued'),
         count(*) filter (where status = 'claimed'),
         min(created_at) filter (where status in ('queued', 'claimed')),
         count(*) filter (where status = 'failed' and finished_at > p_now - p_window),
         max(id) filter (where status = 'failed' and finished_at > p_now - p_window)
  from public.inbound_turn_queue where status in ('queued', 'claimed') or (status = 'failed' and finished_at > p_now - p_window)
$$;

-- Retention: finished rows hold no text (done) or a payload for the owner to read (failed); both go, with their ids.
create or replace function public.inbound_turn_purge(p_now timestamptz default now(), p_done interval default interval '7 days',
  p_failed interval default interval '30 days')
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.inbound_turn_queue
   where (status = 'done' and finished_at < p_now - p_done) or (status = 'failed' and finished_at < p_now - p_failed);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.inbound_turn_enqueue(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.inbound_turn_claim(integer, integer, timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.inbound_turn_finish(bigint, uuid, text, text, timestamptz, integer, boolean) from public, anon, authenticated;
revoke all on function public.inbound_turn_step(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.inbound_turn_untold(integer) from public, anon, authenticated;
revoke all on function public.inbound_turn_told(bigint) from public, anon, authenticated;
revoke all on function public.inbound_turn_health(timestamptz, interval) from public, anon, authenticated;
revoke all on function public.inbound_turn_purge(timestamptz, interval, interval) from public, anon, authenticated;
grant execute on function public.inbound_turn_enqueue(text, text, text, jsonb) to service_role;
grant execute on function public.inbound_turn_claim(integer, integer, timestamptz, integer, integer) to service_role;
grant execute on function public.inbound_turn_finish(bigint, uuid, text, text, timestamptz, integer, boolean) to service_role;
grant execute on function public.inbound_turn_step(bigint, uuid, text) to service_role;
grant execute on function public.inbound_turn_untold(integer) to service_role;
grant execute on function public.inbound_turn_told(bigint) to service_role;
grant execute on function public.inbound_turn_health(timestamptz, interval) to service_role;
grant execute on function public.inbound_turn_purge(timestamptz, interval, interval) to service_role;
