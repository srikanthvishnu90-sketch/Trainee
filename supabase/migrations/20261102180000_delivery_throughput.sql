-- DELIVERY THROUGHPUT AND TABLE HYGIENE (2026-11-02, scale-90k bottlenecks 5, 6 and 8). Additive and idempotent; no existing
-- function changes its signature or its rules. Service_role only. Rollback: supabase/rollbacks/20261102180000_delivery_throughput.down.sql
--
-- 1. channel_rate_buckets + channel_rate_acquire: ONE token bucket per key, shared by every invocation, taken atomically in the
--    database (the row lock serializes takers; the database's own clock is used, never a caller's). Telegram's ~30 messages a
--    second overall and one a second per chat were enforced by a pacer built per request, so 200 concurrent invocations each
--    believed they had the whole 30/s. A caller takes the global key and the chat's key in ONE call: both have a token, or
--    neither is spent and the answer is how many milliseconds to wait. Over any window of T seconds a key hands out at most
--    burst + rate * T tokens (the test proves it with parallel sessions).
-- 2. career_outbox_claim_lane: the claim of 20261030000000 (same parts-in-order rules, same skip locked) with two additions:
--    a LANE ('priority': replies, approval cards, login links and apply questions; 'bulk': everything else, i.e. alerts,
--    reports, receipts) so one 4,500-row alert wave can never sit in front of a person's reply, and a SHARD (a stable hash
--    of the person, so a person's rows, and the order of a reply's parts, stay inside one shard) so several delivery
--    invocations can run side by side. The old three claims are untouched; the code falls back to career_outbox_claim on a
--    project without this file.
-- 3. Retention: career_outbox_purge deletes finished rows older than 30 days (delivered, skipped, failed for good) in
--    batches. Safe for the unique (user_id, key) that stops a repeat: alerts are matched against postings first seen in the
--    last 26 hours (career_proactive_run.ts) and receipts against applications finished recently, so a key older than 30
--    days is never offered again. NOTE: deleting a row frees its (user_id, key): if the same key were enqueued again after that, it would be sent again;
--    the 26-hour posting window and the recent-finished window are what make that not happen, so do not shorten the retention below them. It never touches queued, sending, held or retrying rows. Scheduled by
--    scripts/launch/schedule-outbox-retention.sql (owner runs it).
-- 4. Indexes: the 4 outbox indexes the scale report calls unused (career_outbox_parts, _provider_id, _provider_ids, _card_id)
--    are KEPT, deliberately: the repo shows every one of them is read (see the comment above the retention index below), and
--    the "unused" count came from a table with 4 rows, where the planner never needs an index. Two small partial indexes
--    are ADDED: the priority lane's, and the one retention reads. Plain CREATE INDEX (not CONCURRENTLY: go-live applies each
--    migration in one transaction, where CONCURRENTLY cannot run); the tables are small today (career_outbox 4 rows, the
--    three foreign-key tables hundreds), so the share lock is held for milliseconds. Apply this BEFORE the tables grow.
-- 5. Foreign keys with no index on their referencing column (a delete of a parent row, and every account erase, scans the
--    child table): agent_threads.user_id, agent_tasks.user_id, channel_threads.thread_id, the hot ones the report names. An
--    index that already leads with the column (any name) is left alone.
-- 6. Autovacuum at 2% (the default 20% waits for millions of dead rows on a table this hot) on the outbox, the apply tables,
--    career_watch_kv and career_postings. Metadata only: no rewrite, no long lock.

-- 1. ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.channel_rate_buckets (
  key text primary key check (length(key) between 1 and 200),
  tokens double precision not null check (tokens >= 0),
  refilled_at timestamptz not null default clock_timestamp()
) with (fillfactor = 70, autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100, autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 1000);
alter table public.channel_rate_buckets enable row level security;
revoke all on public.channel_rate_buckets from public, anon, authenticated;
grant select, insert, update, delete on public.channel_rate_buckets to service_role;

-- p_keys / p_rates (tokens a second) / p_bursts (bucket size) are parallel arrays; p_cost tokens are taken from EVERY key.
-- Returns 0 when taken, otherwise the milliseconds until all keys would have p_cost (nothing was taken). p_now is for tests;
-- production passes nothing and the database's clock is used.
create or replace function public.channel_rate_acquire(p_keys text[], p_rates double precision[], p_bursts double precision[],
  p_cost double precision default 1, p_now timestamptz default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  n int := coalesce(cardinality(p_keys), 0);
  rec record;
  avail double precision;
  wait_ms double precision := 0;
begin
  if n = 0 or n <> coalesce(cardinality(p_rates), -1) or n <> coalesce(cardinality(p_bursts), -1) then
    raise exception 'channel_rate_acquire: keys, rates and bursts are three lists of one length';
  end if;
  if (select count(distinct k) from unnest(p_keys) k) <> n or exists (select 1 from unnest(p_keys) k where k is null) then
    raise exception 'channel_rate_acquire: keys are distinct and not null';
  end if;
  if p_cost is null or p_cost <= 0 or exists (select 1 from unnest(p_rates) r where r is null or r <= 0)
     or exists (select 1 from unnest(p_bursts) b where b is null or b < p_cost) then
    raise exception 'channel_rate_acquire: a rate is above 0 and a burst at least the cost';
  end if;
  -- A key seen for the first time starts full. Inserted in key order, and locked below in key order: two callers never
  -- wait on each other in a circle.
  insert into public.channel_rate_buckets (key, tokens, refilled_at)
    select u.k, u.b, v_now from unnest(p_keys, p_bursts) as u(k, b) order by u.k
    on conflict (key) do nothing;
  for rec in
    select b.key, b.tokens, b.refilled_at, u.r as rate, u.cap as burst
    from public.channel_rate_buckets b join unnest(p_keys, p_rates, p_bursts) as u(k, r, cap) on u.k = b.key
    order by b.key for update of b
  loop
    avail := least(rec.burst, rec.tokens + rec.rate * greatest(0, extract(epoch from (v_now - rec.refilled_at))));
    if avail < p_cost then wait_ms := greatest(wait_ms, (p_cost - avail) / rec.rate * 1000); end if;
  end loop;
  if wait_ms > 0 then return greatest(1, ceil(wait_ms)::int); end if;
  update public.channel_rate_buckets b
     set tokens = least(u.cap, b.tokens + u.r * greatest(0, extract(epoch from (v_now - b.refilled_at)))) - p_cost,
         refilled_at = greatest(b.refilled_at, v_now)
    from unnest(p_keys, p_rates, p_bursts) as u(k, r, cap) where b.key = u.k;
  return 0;
end $$;

-- Chat buckets nobody has touched for 10 minutes are full again anyway; dropping them keeps the table to the chats of the
-- last few minutes (a row per active chat, not per person ever). The global bucket is never dropped.
create or replace function public.channel_rate_buckets_prune(p_idle interval default interval '10 minutes') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
  delete from public.channel_rate_buckets where key like '%:chat:%' and refilled_at < clock_timestamp() - greatest(p_idle, interval '1 minute');
  get diagnostics n = row_count;
  return n;
end $$;

-- 2. ---------------------------------------------------------------------------------------------------------------------
-- (link and questions are kinds the table allows: 20261026230017 career_outbox_kind_check lists alert, report, reply, receipt, card,
-- status, followup, mock, brief, digest, link, questions.)
-- The priority lane's kinds: what a person is waiting for (a reply, the card they approve, the link that signs them in,
-- a question an application needs answered). Everything else is bulk.
create index if not exists career_outbox_due_priority on public.career_outbox (deliver_at, id)
  where status in ('queued', 'failed') and kind in ('reply', 'card', 'link', 'questions');

create or replace function public.career_outbox_claim_lane(p_now timestamptz, p_limit int, p_lane text, p_shard int default 0, p_shards int default 1)
returns table (id bigint, user_id uuid, contact text, key text, text text, deliver_at timestamptz, attempts int, prior_status text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_lane not in ('priority', 'bulk') then raise exception 'career_outbox_claim_lane: the lane is priority or bulk'; end if;
  if p_shards is null or p_shards < 1 or p_shards > 64 or p_shard is null or p_shard < 0 or p_shard >= p_shards then
    raise exception 'career_outbox_claim_lane: the shard is 0 up to the number of shards (1 to 64)';
  end if;
  if p_lane = 'priority' then
    return query
    with cand as (
      select o.id, o.user_id, o.part_of, o.part, t.contact, o.status as prior_status
      from career_outbox o cross join lateral (select public.channel_target(o.user_id, o.channel) as contact) t
      where t.contact is not null and o.deliver_at <= p_now
        and (o.status = 'queued' or (o.status = 'failed' and o.retry_at is not null and o.retry_at <= p_now))
        and o.kind in ('reply', 'card', 'link', 'questions')
        and (p_shards = 1 or (hashtextextended(o.user_id::text, 0) & 2147483647) % p_shards = p_shard)
        and (o.part is null or not exists (select 1 from career_outbox e where e.user_id = o.user_id and e.part_of = o.part_of and e.part < o.part
          and (e.status in ('sending', 'held') or (e.status = 'failed' and e.retry_at is not null and e.retry_at > p_now) or (e.status = 'queued' and e.deliver_at > p_now))))
      order by o.deliver_at, o.id
      limit least(greatest(p_limit, 0), 500)
      for update of o skip locked),
    due as (
      select c.* from cand c
      where c.part is null or not exists (select 1 from career_outbox e where e.user_id = c.user_id and e.part_of = c.part_of and e.part < c.part
        and (e.status = 'queued' or (e.status = 'failed' and e.retry_at is not null))
        and e.id not in (select x.id from cand x)))
    update career_outbox o set status = 'sending', claimed_at = p_now, contact = due.contact
    from due where o.id = due.id
    returning o.id, o.user_id, o.contact, o.key, o.text, o.deliver_at, o.attempts, due.prior_status;
  else
    return query
    with cand as (
      select o.id, o.user_id, o.part_of, o.part, t.contact, o.status as prior_status
      from career_outbox o cross join lateral (select public.channel_target(o.user_id, o.channel) as contact) t
      where t.contact is not null and o.deliver_at <= p_now
        and (o.status = 'queued' or (o.status = 'failed' and o.retry_at is not null and o.retry_at <= p_now))
        and o.kind not in ('reply', 'card', 'link', 'questions')
        and (p_shards = 1 or (hashtextextended(o.user_id::text, 0) & 2147483647) % p_shards = p_shard)
        and (o.part is null or not exists (select 1 from career_outbox e where e.user_id = o.user_id and e.part_of = o.part_of and e.part < o.part
          and (e.status in ('sending', 'held') or (e.status = 'failed' and e.retry_at is not null and e.retry_at > p_now) or (e.status = 'queued' and e.deliver_at > p_now))))
      order by o.deliver_at, o.id
      limit least(greatest(p_limit, 0), 500)
      for update of o skip locked),
    due as (
      select c.* from cand c
      where c.part is null or not exists (select 1 from career_outbox e where e.user_id = c.user_id and e.part_of = c.part_of and e.part < c.part
        and (e.status = 'queued' or (e.status = 'failed' and e.retry_at is not null))
        and e.id not in (select x.id from cand x)))
    update career_outbox o set status = 'sending', claimed_at = p_now, contact = due.contact
    from due where o.id = due.id
    returning o.id, o.user_id, o.contact, o.key, o.text, o.deliver_at, o.attempts, due.prior_status;
  end if;
end $$;

-- 3. ---------------------------------------------------------------------------------------------------------------------
-- Why the four "unused" outbox indexes stay (read from the repo, not from the advisor's empty-table count):
--   career_outbox_parts        (user_id, part_of, part): the "an earlier part is still waiting" check inside all three claims.
--   career_outbox_provider_id  (provider_id) and career_outbox_provider_ids (gin): the delivery-status callbacks
--     career_outbox_rehold / _sent_back / _fail_sent (20261030100000) find the delivered row by provider id.
--   career_outbox_card_id      (card_id): the foreign key to career_apply_cards (on delete set null); without it a card delete scans the outbox.
-- This index serves the retention below: terminal rows that are not "delivered" (that case is career_outbox_sent).
create index if not exists career_outbox_terminal_old on public.career_outbox (created_at)
  where status = 'skipped_opt_out' or (status = 'failed' and retry_at is null);

create or replace function public.career_outbox_purge(p_older interval default interval '30 days', p_batch int default 5000, p_max_batches int default 10)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare total bigint := 0; got bigint; i int := 0; sz int := least(greatest(coalesce(p_batch, 5000), 1), 20000);
begin
  if p_older is null or p_older < interval '7 days' then raise exception 'career_outbox_purge: finished rows are kept at least 7 days'; end if;
  loop
    -- delivered (career_outbox_sent), then skipped or failed for good (career_outbox_terminal_old); skip locked, so a row a
    -- delivery run holds is never waited for.
    delete from career_outbox o using (select d.id from career_outbox d where d.status = 'delivered' and d.delivered_at < now() - p_older
      order by d.delivered_at limit sz for update skip locked) x where o.id = x.id;
    get diagnostics got = row_count; total := total + got;
    if got < sz then
      delete from career_outbox o using (select d.id from career_outbox d
        where (d.status = 'skipped_opt_out' or (d.status = 'failed' and d.retry_at is null)) and d.created_at < now() - p_older
        order by d.created_at limit sz for update skip locked) x where o.id = x.id;
      get diagnostics got = row_count; total := total + got;
    end if;
    i := i + 1;
    exit when got < sz or i >= greatest(coalesce(p_max_batches, 10), 1);
  end loop;
  return total;
end $$;

-- 5. ---------------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values ('agent_threads', 'user_id', 'agent_threads_user_id_idx'), ('agent_tasks', 'user_id', 'agent_tasks_user_id_idx'),
      ('channel_threads', 'thread_id', 'channel_threads_thread_id_idx')) v(tbl, col, idx) loop
    continue when to_regclass('public.' || r.tbl) is null;
    continue when exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = to_regclass('public.' || r.tbl) and a.attname = r.col and i.indisvalid and i.indpred is null);
    execute format('create index if not exists %I on public.%I (%I)', r.idx, r.tbl, r.col);
  end loop;
end $$;

-- 6. ---------------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['career_outbox', 'career_apply_jobs', 'career_apply_cards', 'career_apply_wanted', 'career_watch_kv', 'career_postings'] loop
    continue when to_regclass('public.' || t) is null;
    execute format('alter table public.%I set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', t);
  end loop;
end $$;

revoke all on function public.channel_rate_acquire(text[], double precision[], double precision[], double precision, timestamptz),
  public.channel_rate_buckets_prune(interval),
  public.career_outbox_claim_lane(timestamptz, int, text, int, int),
  public.career_outbox_purge(interval, int, int) from public, anon, authenticated;
grant execute on function public.channel_rate_acquire(text[], double precision[], double precision[], double precision, timestamptz),
  public.channel_rate_buckets_prune(interval),
  public.career_outbox_claim_lane(timestamptz, int, text, int, int),
  public.career_outbox_purge(interval, int, int) to service_role;
