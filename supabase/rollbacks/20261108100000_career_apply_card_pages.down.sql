-- Reverses 20261108100000: career_apply_card_answer_for exactly as 20261026210016 left it; the paged push, the page
-- delivery trigger, the page rows and the card's set_hash/pages columns removed. A paged card still open is closed first
-- (its yes could no longer be checked page by page), so nothing approves it after the rollback.
update public.career_apply_cards set state = 'answered', answered_at = now(), answer = '{"closed":"paged cards rolled back"}'
 where state = 'open' and pages is not null;
drop trigger if exists career_apply_card_page_delivered on public.career_outbox;
drop function if exists public.career_apply_card_page_delivered();
drop function if exists public.career_apply_card_push_paged_for(uuid, uuid, uuid[], text[], timestamptz);
create or replace function public.career_apply_card_answer_for(p_user uuid, p_card uuid, p_approve int[], p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare c public.career_apply_cards; it jsonb; p public.career_apply_prepared; out jsonb := '[]'; res text; n int;
begin
 if p_user is null or p_card is null or p_now is null then raise exception 'invalid card answer'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select * into c from public.career_apply_cards where id = p_card and user_id = p_user for update;
 if not found then raise exception 'invalid card answer'; end if;
 if c.state <> 'open' then raise exception 'card_answered'; end if;
 if c.shown_at < p_now - interval '24 hours' then raise exception 'card_expired'; end if;
 -- D-031 / SERIAL-1451: an approval counts only within 10 minutes of the card's showing.
 if cardinality(coalesce(p_approve, '{}')) > 0 and c.shown_at < p_now - interval '10 minutes' then raise exception 'card_stale'; end if;
 if exists (select from unnest(coalesce(p_approve, '{}')) a where a not between 1 and jsonb_array_length(c.items)) then
  raise exception 'not_on_card'; end if;
 for it in select * from jsonb_array_elements(c.items) loop
  n := (it->>'n')::int;
  select * into p from public.career_apply_prepared where id = (it->>'prepared_id')::uuid and user_id = p_user for update;
  if p.payload_hash is distinct from it->>'payload_hash' then res := 'changed';
  elsif n = any(coalesce(p_approve, '{}')) then
   begin
    perform public.career_apply_enqueue(p.payload, p.payload_hash, p.payload_hash, public.career_apply_daily_limit(p_user));
    res := 'queued';
   exception when others then
    res := case when sqlerrm like '%pace_unreadable%' then 'pace_unreadable' when sqlerrm like '%daily_cap%' then 'daily_cap'
     when sqlerrm like '%company_cooldown%' then 'company_cooldown'
     when sqlerrm like '%duplicate_job%' then 'duplicate' when sqlerrm like '%no_resume%' then 'no_resume' when sqlerrm like '%stale%' then 'stale' else 'refused' end;
   end;
  else res := 'declined'; end if;
  update public.career_apply_prepared set state = case res when 'queued' then 'approved' when 'stale' then 'expired' else 'declined' end, updated_at = p_now where id = p.id;
  out := out || jsonb_build_object('n', n, 'company', p.company, 'result', res);
 end loop;
 update public.career_apply_cards set state = 'answered', answered_at = p_now, answer = jsonb_build_object('approve', to_jsonb(coalesce(p_approve, '{}')), 'results', out) where id = c.id;
 return out;
end $$;
revoke all on function public.career_apply_card_answer_for(uuid, uuid, int[], timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.career_apply_card_answer_for(uuid, uuid, int[], timestamptz) from public, anon, authenticated, service_role;
drop function if exists public.career_apply_card_set_hash(uuid);
drop table if exists public.career_apply_card_pages;
alter table public.career_apply_cards drop constraint if exists career_apply_cards_paged;
alter table public.career_apply_cards drop column if exists pages;
alter table public.career_apply_cards drop column if exists set_hash;
