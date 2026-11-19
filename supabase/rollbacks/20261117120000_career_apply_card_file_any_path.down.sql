-- Reverses 20261117120000: career_apply_card_confirm_for exactly as 20261030010000 left it; the chat's File-bound card open
-- removed. A card it opened stays as it is (20261116140000's answer still binds it to its File).
drop function if exists public.career_apply_card_open_batch_as(uuid, uuid[], text);
drop function if exists public.career_apply_card_open_batch_for(uuid, uuid[], text, timestamptz);
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
revoke all on function public.career_apply_card_confirm_for(uuid, uuid[], text[], timestamptz) from public, anon, authenticated, service_role;
