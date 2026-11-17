-- Reverses 20261116140000 (D-094): career_apply_card_answer_for exactly as 20261108100000 left it and
-- career_apply_prepare_request_put exactly as 20261026230017 left it; the batch push, the batch reads, the File hash, the
-- split trigger and the new columns removed; the job_ids check back to 1..25 (NOT VALID: a row an older part left is kept;
-- every new row is held to it). A File-bound card still open is closed first (its yes could no longer be checked against its
-- File), so nothing approves it after the rollback.
update public.career_apply_cards set state = 'answered', answered_at = now(), answer = '{"closed":"batch File cards rolled back"}'
 where state = 'open' and file_id is not null;
drop function if exists public.career_apply_card_push_batch_for(uuid, uuid, uuid[], text, text, timestamptz);
drop function if exists public.career_apply_batch_file_sha(uuid, text);
drop function if exists public.career_apply_prepare_batch_ready(uuid, uuid);
drop function if exists public.career_apply_prepare_batch_done(uuid, uuid);
drop trigger if exists career_apply_prepare_request_batch_of on public.career_apply_prepare_requests;
drop function if exists public.career_apply_prepare_request_batch_of();
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
 -- R9-G2 (D-MS-1, paged): a card pushed in pages is approved only when every page of it was delivered, and only while the
 -- set of applications it showed is still exactly that set: the hash over every item's payload hash, in order.
 if cardinality(coalesce(p_approve, '{}')) > 0 and c.pages is not null then
  if (select count(*) from public.career_apply_card_pages g where g.card_id = c.id and g.delivered_at is not null) <> c.pages then
   raise exception 'card_pages_undelivered'; end if;
  if public.career_apply_card_set_hash(c.id) is distinct from c.set_hash then raise exception 'APPROVAL_SET_CHANGED'; end if;
 end if;
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
create or replace function public.career_apply_prepare_request_put(p_user uuid, p_job_ids text[], p_per_person_day integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare ids text[]; part text[]; r public.career_apply_prepare_requests; used int; parts uuid[] := '{}'; first public.career_apply_prepare_requests;
 i int; waits boolean;
begin
 if p_user is null or p_job_ids is null or cardinality(p_job_ids) < 1 or p_per_person_day < 1 then raise exception 'invalid prepare request'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 7));
 ids := array(select distinct w.posting_key from public.career_apply_wanted w where w.user_id = p_user and w.state = 'waiting'
  and w.posting_key = any(p_job_ids) and not public.career_apply_never_automated(w.url) order by 1);
 if cardinality(ids) = 0 then raise exception 'nothing_to_prepare'; end if;
 used := public.career_apply_prepare_postings_today(p_user, clock_timestamp());
 waits := p_per_person_day is not null and used >= p_per_person_day;
 i := 1;
 while i <= cardinality(ids) loop
  part := ids[i : i + 24];
  select * into r from public.career_apply_prepare_requests where user_id = p_user and state in ('queued', 'running')
   and job_ids @> part and job_ids <@ part and created_at > clock_timestamp() - interval '15 minutes' order by created_at desc limit 1;
  if r.id is null then
   insert into public.career_apply_prepare_requests (user_id, job_ids, hosts, outcome)
   values (p_user, part, array(select coalesce(public.career_apply_url_host(w.url), '') from unnest(part) with ordinality k(pk, n)
    join public.career_apply_wanted w on w.user_id = p_user and w.posting_key = k.pk order by k.n),
    case when waits then '{"waiting_for":"per_person_day"}'::jsonb else '{}'::jsonb end)
   returning * into r;
  end if;
  if first.id is null then first := r; end if;
  parts := parts || r.id;
  i := i + 25;
 end loop;
 return jsonb_build_object('id', first.id, 'state', first.state, 'accepted', not waits,
  'waiting_for', case when waits then 'per_person_day' end, 'requests', to_jsonb(parts), 'postings', cardinality(ids));
end $$;
revoke all on function public.career_apply_prepare_request_put(uuid, text[], integer) from public, anon, authenticated, service_role;
grant execute on function public.career_apply_prepare_request_put(uuid, text[], integer) to service_role;
alter table public.career_apply_cards drop constraint if exists career_apply_cards_file;
alter table public.career_apply_cards drop column if exists file_sha;
alter table public.career_apply_cards drop column if exists file_id;
drop index if exists public.career_apply_prepare_requests_batch;
alter table public.career_apply_prepare_requests drop column if exists batch_done_at;
alter table public.career_apply_prepare_requests drop column if exists batch_id;
alter table public.career_apply_prepare_requests drop constraint if exists career_apply_prepare_requests_job_ids_check;
alter table public.career_apply_prepare_requests add constraint career_apply_prepare_requests_job_ids_check check (cardinality(job_ids) between 1 and 25) not valid;
