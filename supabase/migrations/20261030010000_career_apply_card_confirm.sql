-- One Confirm = one card opened AND answered in the same transaction (2026-10-29, the file page's apply race).
--
-- The file page's Apply and Telegram's Confirm approved through two calls: career_apply_card_open_as, then
-- career_apply_card_answer_as. Opening a card closes every other open card of the person ("a newer card was shown"), so two
-- approvals at once (an Apply and Apply to all on the jobs page, two Applies, two devices) could close each other's card between
-- its open and its answer: each answer then raised card_answered and an exact, current approval approved nothing (an Apply to
-- all could lose a row that neither request then approved). career_apply_card_confirm_for does both steps under the person's
-- lock, so no other card can be opened in between. It approves only if every item is still that person's, still ready or
-- shown, and still hashes to exactly the hash the person approved (p_hashes, the payload they were shown); otherwise it raises
-- card_changed (a hash differs or the row is gone) or invalid card (no longer open to approve: approved, declined, expired),
-- and nothing is opened. Once per posting still holds: the answer queues through career_apply_enqueue, which refuses a second
-- application for the same posting (duplicate). Additive and idempotent; the service role only (career_apply_card_confirm_as).
create or replace function public.career_apply_card_confirm_for(p_user uuid, p_ids uuid[], p_hashes text[], p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.career_apply_cards; res jsonb; k int := coalesce(cardinality(p_ids), 0);
begin
 if p_user is null or p_ids is null or p_hashes is null or k < 1 or cardinality(p_hashes) <> k or p_now is null then raise exception 'invalid card'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 if exists (select from unnest(p_ids, p_hashes) as x(id, h)
            left join public.career_apply_prepared p on p.id = x.id and p.user_id = p_user
            where p.id is null or p.payload_hash is distinct from x.h) then raise exception 'card_changed'; end if;
 -- career_apply_card_open_for: every item ready or shown (else invalid card), the card holds each item's hash, older open cards close.
 c := public.career_apply_card_open_for(p_user, p_ids, p_now);
 res := public.career_apply_card_answer_for(p_user, c.id, (select array_agg(g order by g) from generate_series(1, k) g), p_now);
 return jsonb_build_object('card', jsonb_build_object('id', c.id, 'items', c.items, 'shown_at', c.shown_at), 'results', res);
end $$;

create or replace function public.career_apply_card_confirm_as(p_user uuid, p_ids uuid[], p_hashes text[]) returns jsonb
language sql security definer set search_path = public, pg_temp as $$ select public.career_apply_card_confirm_for(p_user, p_ids, p_hashes, clock_timestamp()) $$;

revoke all on function public.career_apply_card_confirm_for(uuid, uuid[], text[], timestamptz), public.career_apply_card_confirm_as(uuid, uuid[], text[])
 from public, anon, authenticated, service_role;
grant execute on function public.career_apply_card_confirm_as(uuid, uuid[], text[]) to service_role;
