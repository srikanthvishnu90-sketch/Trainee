-- CHANNEL DELIVERY SCENARIOS (2026-10-29): a reply in parts, at any length and in order. Additive and idempotent; every
-- function keeps its signature and every other rule of 20261021070000_channel_parity.sql.
--
-- 1. No ceiling on parts. The owner's rule (NO LIMITS, 2026-10-27 19:55 CDT) removed the 30-part cut in the code
--    (channel_inbound.ts replyParts: "a card of 500 applications is about 40 messages"), but career_outbox_part still held
--    part between 1 and 50: a reply of 51 or more parts failed on its 51st insert, after 50 parts were queued, and the
--    person read 50 parts and then "I couldn't answer that just now". A part is now any number from 1; its key is still
--    its reply's key and its number (and the key's own 310-character bound still holds).
-- 2. A part is never claimed while an earlier part of its reply is still waiting. The claims already skipped a part whose
--    earlier part was sending, held, waiting for a retry or not yet due; but "for update skip locked" skips a row another
--    claim has locked, and that earlier part, still read as queued, did not count as waiting: the every-minute run
--    claimed part 2 while the head start (career_outbox_claim_key) was claiming part 1, and the two went out in either
--    order. Now an earlier part that is not finished and not claimed in the same statement holds every later part.
alter table public.career_outbox drop constraint if exists career_outbox_part;
alter table public.career_outbox add constraint career_outbox_part check (
  (part is null) = (part_of is null) and (part is null or (part >= 1 and part_of ~ '^reply:.+$' and key = part_of || ':' || part)));

create or replace function public.career_outbox_claim(p_now timestamptz, p_limit int)
returns table (id bigint, user_id uuid, contact text, key text, text text, deliver_at timestamptz, attempts int, prior_status text)
language sql security definer set search_path = public as $$
  with cand as (
    select o.id, o.user_id, o.part_of, o.part, t.contact, o.status as prior_status
    from career_outbox o cross join lateral (select public.channel_target(o.user_id, o.channel) as contact) t
    where t.contact is not null and o.deliver_at <= p_now
      and (o.status = 'queued' or (o.status = 'failed' and o.retry_at is not null and o.retry_at <= p_now))
      and (o.part is null or not exists (select 1 from career_outbox e where e.user_id = o.user_id and e.part_of = o.part_of and e.part < o.part
        and (e.status in ('sending', 'held') or (e.status = 'failed' and e.retry_at is not null and e.retry_at > p_now) or (e.status = 'queued' and e.deliver_at > p_now))))
    order by o.deliver_at, o.id
    limit least(greatest(p_limit, 0), 100)
    for update of o skip locked),
  due as (
    select c.* from cand c
    where c.part is null or not exists (select 1 from career_outbox e where e.user_id = c.user_id and e.part_of = c.part_of and e.part < c.part
      and (e.status = 'queued' or (e.status = 'failed' and e.retry_at is not null))
      and e.id not in (select x.id from cand x)))
  update career_outbox o set status = 'sending', claimed_at = p_now, contact = due.contact
  from due where o.id = due.id
  returning o.id, o.user_id, o.contact, o.key, o.text, o.deliver_at, o.attempts, due.prior_status;
$$;
-- One row by key (the head start): an earlier part that is queued at all, locked or not, already holds it.
create or replace function public.career_outbox_claim_key(p_user uuid, p_key text, p_now timestamptz)
returns table (id bigint, user_id uuid, contact text, key text, text text, deliver_at timestamptz, attempts int, prior_status text)
language sql security definer set search_path = public as $$
  with due as (
    select o.id, t.contact, o.status as prior_status
    from career_outbox o cross join lateral (select public.channel_target(o.user_id, o.channel) as contact) t
    where o.user_id = p_user and o.key = p_key and t.contact is not null and o.deliver_at <= p_now
      and (o.status = 'queued' or (o.status = 'failed' and o.retry_at is not null and o.retry_at <= p_now))
      and (o.part is null or not exists (select 1 from career_outbox e where e.user_id = o.user_id and e.part_of = o.part_of and e.part < o.part
        and (e.status in ('sending', 'held', 'queued') or (e.status = 'failed' and e.retry_at is not null))))
    for update of o skip locked)
  update career_outbox o set status = 'sending', claimed_at = p_now, contact = due.contact
  from due where o.id = due.id
  returning o.id, o.user_id, o.contact, o.key, o.text, o.deliver_at, o.attempts, due.prior_status;
$$;
create or replace function public.career_outbox_claim_user(p_user uuid, p_now timestamptz, p_limit int)
returns table (id bigint, user_id uuid, contact text, key text, text text, deliver_at timestamptz, attempts int, prior_status text)
language sql security definer set search_path = public as $$
  with cand as (
    select o.id, o.user_id, o.part_of, o.part, t.contact, o.status as prior_status
    from career_outbox o cross join lateral (select public.channel_target(o.user_id, o.channel) as contact) t
    where o.user_id = p_user and t.contact is not null and o.deliver_at <= p_now
      and (o.status = 'queued' or (o.status = 'failed' and o.retry_at is not null and o.retry_at <= p_now))
      and (o.part is null or not exists (select 1 from career_outbox e where e.user_id = o.user_id and e.part_of = o.part_of and e.part < o.part
        and (e.status in ('sending', 'held') or (e.status = 'failed' and e.retry_at is not null and e.retry_at > p_now) or (e.status = 'queued' and e.deliver_at > p_now))))
    order by o.deliver_at, o.id
    limit least(greatest(p_limit, 0), 40)
    for update of o skip locked),
  due as (
    select c.* from cand c
    where c.part is null or not exists (select 1 from career_outbox e where e.user_id = c.user_id and e.part_of = c.part_of and e.part < c.part
      and (e.status = 'queued' or (e.status = 'failed' and e.retry_at is not null))
      and e.id not in (select x.id from cand x)))
  update career_outbox o set status = 'sending', claimed_at = p_now, contact = due.contact
  from due where o.id = due.id
  returning o.id, o.user_id, o.contact, o.key, o.text, o.deliver_at, o.attempts, due.prior_status;
$$;

revoke all on function public.career_outbox_claim(timestamptz, int), public.career_outbox_claim_key(uuid, text, timestamptz),
  public.career_outbox_claim_user(uuid, timestamptz, int) from public, anon, authenticated;
grant execute on function public.career_outbox_claim(timestamptz, int), public.career_outbox_claim_key(uuid, text, timestamptz),
  public.career_outbox_claim_user(uuid, timestamptz, int) to service_role;
