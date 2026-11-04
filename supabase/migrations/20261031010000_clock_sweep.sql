-- CLOCK SWEEP (2026-10-31): a card is never shown later than the transaction that shows it.
--
-- The same class as 20261030040000 (the outreach send claim: the worker's millisecond against Postgres's microseconds),
-- 20261030140000 (the apply not-before) and PR #341 (the outreach batch a chat showed): a time from one clock compared with
-- a time from another. Here both are the database's, but not the same instant of it: rows written in one transaction carry
-- the transaction's start (now(), every created_at default), while clock_timestamp() moves on during it.
--
-- One Confirm (career_apply_card_confirm_as, 20261030010000: the file page's Apply, Telegram's Confirm) opens a card and
-- answers it in one transaction at clock_timestamp(): the card's shown_at is the moment of the call, and the applications its
-- answer queues are created at now(), the transaction's start, a few microseconds EARLIER. career_apply_cloud_text_card_of
-- (20261026230017) binds an application to the card that approved it only if it was created between the card's showing and
-- its answer (j.created_at >= c.shown_at), so every application approved by one Confirm read as approved by no card: the
-- cloud's text route refused it as not_card_approved and never sent what the person approved. The same comparison held for a
-- card pushed by a worker whose clock runs ahead of the database's (career_apply_card_push_for, p_now from the worker).
--
-- Fixed where the time is made: career_apply_card_open_for (as 20261027141000 left it, unchanged otherwise) records shown_at
-- as least(p_now, now()): never after the start of the transaction that shows the card, so anything the answer creates (in
-- that transaction or a later one) is at or after it. A caller's earlier time (a test's back-dated card) is kept as given.
-- answered_at is unchanged (the answer's own time, at or after its applications). Idempotent; service role only, as before.
create or replace function public.career_apply_card_open_for(p_user uuid, p_ids uuid[], p_now timestamptz)
returns public.career_apply_cards language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.career_apply_cards; items jsonb;
begin
 if p_user is null or p_ids is null or cardinality(p_ids) < 1 or p_now is null then raise exception 'invalid card'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 if (select count(*) from public.career_apply_prepared where user_id = p_user and state in ('ready', 'shown') and id = any(p_ids)) <> cardinality(p_ids)
  or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) then raise exception 'invalid card'; end if;
 select jsonb_agg(jsonb_build_object('n', o.n, 'prepared_id', p.id, 'payload_hash', p.payload_hash) order by o.n) into items
  from unnest(p_ids) with ordinality as o(id, n) join public.career_apply_prepared p on p.id = o.id;
 update public.career_apply_prepared set state = 'shown', updated_at = p_now where id = any(p_ids);
 update public.career_apply_cards set state = 'answered', answered_at = p_now, answer = '{"closed":"a newer card was shown"}'
  where user_id = p_user and state = 'open';
 -- 2026-10-31: shown no later than this transaction's start (now()), the time every row the answer creates carries.
 insert into public.career_apply_cards (user_id, items, shown_at) values (p_user, items, least(p_now, now())) returning * into c;
 return c;
end $$;
revoke all on function public.career_apply_card_open_for(uuid, uuid[], timestamptz) from public, anon, authenticated, service_role;
