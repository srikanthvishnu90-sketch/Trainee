-- D-094 follow-up (architect, 2026-11-17): a File changed after it was shown approves nothing on ANY path, and the chat's
-- "show my applications" can show a batch that would page as a summary plus its File.
--   1. career_apply_card_confirm_for (the one-transaction Confirm: the jobs page's Apply, a File page's Approve, Telegram's
--      single-application Confirm; career_apply_card_confirm_as): 20261030010000's, plus: when any application it confirms is
--      on the person's open File-bound card (20261116140000) whose File no longer hashes to the card's file_sha, or is gone or
--      revoked, nothing is confirmed ('FILE_CHANGED'). (The card's own Approve button and the texted yes answer the card through
--      career_apply_card_answer_for, which 20261116140000 already binds to the File.)
--   2. career_apply_card_open_batch_for / _as: open a card bound to a batch File for the chat's "show my applications": the
--      File must list exactly these applications, numbered 1..N in this order, each at its current payload hash; the card
--      records the File and its hash (as career_apply_card_push_batch_for does for a pushed batch).
-- Builds on 20261116140000. Idempotent. NOT APPLIED: the owner applies migrations.
-- Rollback: supabase/rollbacks/20261117120000_career_apply_card_file_any_path.down.sql.

create or replace function public.career_apply_card_confirm_for(p_user uuid, p_ids uuid[], p_hashes text[], p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.career_apply_cards; res jsonb; k int := coalesce(cardinality(p_ids), 0);
begin
 if p_user is null or p_ids is null or p_hashes is null or k < 1 or cardinality(p_hashes) <> k or p_now is null then raise exception 'invalid card'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 if exists (select from unnest(p_ids, p_hashes) as x(id, h)
            left join public.career_apply_prepared p on p.id = x.id and p.user_id = p_user
            where p.id is null or p.payload_hash is distinct from x.h) then raise exception 'card_changed'; end if;
 -- D-094: an application shown on an open File-bound card goes only while that File is the File shown.
 if exists (select from public.career_apply_cards f cross join lateral jsonb_array_elements(f.items) it
            where f.user_id = p_user and f.state = 'open' and f.file_id is not null and (it->>'prepared_id')::uuid = any(p_ids)
              and public.career_apply_batch_file_sha(p_user, f.file_id) is distinct from f.file_sha) then raise exception 'FILE_CHANGED'; end if;
 -- career_apply_card_open_for: every item ready or shown (else invalid card), the card holds each item's hash, older open cards close.
 c := public.career_apply_card_open_for(p_user, p_ids, p_now);
 res := public.career_apply_card_answer_for(p_user, c.id, (select array_agg(g order by g) from generate_series(1, k) g), p_now);
 return jsonb_build_object('card', jsonb_build_object('id', c.id, 'items', c.items, 'shown_at', c.shown_at), 'results', res);
end $$;

create or replace function public.career_apply_card_open_batch_for(p_user uuid, p_ids uuid[], p_file text, p_now timestamptz)
returns public.career_apply_cards language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare c public.career_apply_cards; items jsonb; sha text;
begin
 if p_user is null or p_ids is null or cardinality(p_ids) < 1 or p_file is null or p_now is null then raise exception 'invalid card'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select k.value->'data'->'batch'->'items' into items from public.career_watch_kv k
  where k.user_id = p_user and p_file ~ '^[0-9a-f]{10}$' and k.key = 'tf:file:' || p_file;
 sha := public.career_apply_batch_file_sha(p_user, p_file);
 if sha is null or items is null or jsonb_array_length(items) <> cardinality(p_ids) or exists (
   select from unnest(p_ids) with ordinality o(id, n)
   left join public.career_apply_prepared p on p.id = o.id and p.user_id = p_user
   where (items->(o.n::int - 1)->>'n') is distinct from o.n::text or (items->(o.n::int - 1)->>'prepared_id') is distinct from o.id::text
    or p.id is null or (items->(o.n::int - 1)->>'payload_hash') is distinct from p.payload_hash) then
  raise exception 'the File does not list exactly this batch'; end if;
 c := public.career_apply_card_open_for(p_user, p_ids, p_now);
 update public.career_apply_cards set file_id = p_file, file_sha = sha where id = c.id returning * into c;
 return c;
end $$;
create or replace function public.career_apply_card_open_batch_as(p_user uuid, p_ids uuid[], p_file text) returns public.career_apply_cards
language sql security definer set search_path = public, pg_temp as $$ select public.career_apply_card_open_batch_for(p_user, p_ids, p_file, clock_timestamp()) $$;

revoke all on function public.career_apply_card_confirm_for(uuid, uuid[], text[], timestamptz), public.career_apply_card_open_batch_for(uuid, uuid[], text, timestamptz),
 public.career_apply_card_open_batch_as(uuid, uuid[], text) from public, anon, authenticated, service_role;
grant execute on function public.career_apply_card_open_batch_as(uuid, uuid[], text) to service_role;
