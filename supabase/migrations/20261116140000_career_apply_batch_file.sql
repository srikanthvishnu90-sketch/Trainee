-- D-094 (owner, 2026-11-16): a large batch is shown as a short chat summary plus a File listing every application with its
-- exact payload; the one yes approves exactly what the File lists, bound by the payload hashes; a File changed after it was
-- shown approves nothing. Before this, 122 postings became 5 preparation requests (parts of 25), each pushed its own card
-- (about 9 chat messages in all) and the yes approved only the last card (eval MA14: 25 approved of 122).
--   1. career_apply_prepare_requests.job_ids: the 1..25 check is raised to 1..10000 (a sanity bound, as CANDIDATES_READ in
--      cloud_prepare.ts). A request is still split into parts of 25 (one sandbox each, each inside its 15-minute lease): a
--      part is the parallelism unit, never what one card shows.
--   2. batch_id: every part of one request carries the first part's id (career_apply_prepare_request_put); a part the claim
--      splits off (outcome.split_from) inherits its parent's batch (trigger). A batch's key is coalesce(batch_id, id), so a
--      request made before this file is a batch of one. batch_done_at: when that part's preparation finished.
--   3. career_apply_prepare_batch_done: one part finished; under the batch's lock, true for exactly the last part to finish
--      (no part of the batch still queued or running unfinished). career_apply_prepare_batch_ready: every application the
--      batch's parts made ready, for the one card.
--   4. career_apply_cards.file_id / file_sha: the card is bound to the File that lists it; file_sha is sha256 over the File's
--      stored data (career_watch_kv 'tf:file:<id>', value->'data'), taken when the card is pushed.
--   5. career_apply_card_push_batch_for: the batch's ONE card, a summary text plus the File: every check of
--      career_apply_card_push_requested_for (opted out, no thread, WhatsApp's 23 hours, a questions turn open, every id
--      ready), but instead of "the text carries every line" the File must list exactly these applications, in this order,
--      each at its current payload hash (the File is the shown batch, D-094).
--   6. career_apply_card_answer_for: 20261108100000's, plus: an approval of a File-bound card is refused ('FILE_CHANGED')
--      when the File's data no longer hashes to file_sha, or the File is gone or revoked. A no is never refused.
-- Idempotent. NOT APPLIED: the owner applies migrations. Rollback: supabase/rollbacks/20261116140000_career_apply_batch_file.down.sql.

alter table public.career_apply_prepare_requests drop constraint if exists career_apply_prepare_requests_job_ids_check;
alter table public.career_apply_prepare_requests add constraint career_apply_prepare_requests_job_ids_check check (cardinality(job_ids) between 1 and 10000);
alter table public.career_apply_prepare_requests add column if not exists batch_id uuid;
alter table public.career_apply_prepare_requests add column if not exists batch_done_at timestamptz;
create index if not exists career_apply_prepare_requests_batch on public.career_apply_prepare_requests (batch_id) where batch_id is not null;

-- A part the claim splits off a request (career_apply_prepare_request_claim: outcome.split_from) stays in that request's batch.
create or replace function public.career_apply_prepare_request_batch_of() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.batch_id is null and new.outcome ? 'split_from' and (new.outcome->>'split_from') ~ '^[0-9a-f-]{36}$' then
  select coalesce(r.batch_id, r.id) into new.batch_id from public.career_apply_prepare_requests r where r.id = (new.outcome->>'split_from')::uuid;
 end if;
 return new;
end $$;
drop trigger if exists career_apply_prepare_request_batch_of on public.career_apply_prepare_requests;
create trigger career_apply_prepare_request_batch_of before insert on public.career_apply_prepare_requests
 for each row execute function public.career_apply_prepare_request_batch_of();

-- 20261026230017's put, unchanged but for the batch: every part made by this call carries the first part's batch.
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
   insert into public.career_apply_prepare_requests (user_id, job_ids, hosts, outcome, batch_id)
   values (p_user, part, array(select coalesce(public.career_apply_url_host(w.url), '') from unnest(part) with ordinality k(pk, n)
    join public.career_apply_wanted w on w.user_id = p_user and w.posting_key = k.pk order by k.n),
    case when waits then '{"waiting_for":"per_person_day"}'::jsonb else '{}'::jsonb end,
    case when first.id is null then null else coalesce(first.batch_id, first.id) end)
   returning * into r;
   if first.id is null and r.batch_id is null then update public.career_apply_prepare_requests set batch_id = id where id = r.id returning * into r; end if;
  end if;
  if first.id is null then first := r; end if;
  parts := parts || r.id;
  i := i + 25;
 end loop;
 return jsonb_build_object('id', first.id, 'state', first.state, 'accepted', not waits,
  'waiting_for', case when waits then 'per_person_day' end, 'requests', to_jsonb(parts), 'postings', cardinality(ids),
  'batch', coalesce(first.batch_id, first.id));
end $$;

-- One part's preparation finished (under its lease). Returns the batch, how many parts it has, and how many are still to
-- finish (queued, or running and not yet finished). Serialized per batch, so exactly the last part to finish sees 0.
create or replace function public.career_apply_prepare_batch_done(p_id uuid, p_lease uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.career_apply_prepare_requests; k uuid; n int; open int;
begin
 select * into r from public.career_apply_prepare_requests where id = p_id and state = 'running' and p_lease is not null and lease_token = p_lease;
 if r.id is null then raise exception 'invalid prepare lease'; end if;
 k := coalesce(r.batch_id, r.id);
 perform pg_advisory_xact_lock(hashtextextended('career-prepare-batch:' || k::text, 0));
 update public.career_apply_prepare_requests set batch_done_at = clock_timestamp() where id = r.id;
 select count(*), count(*) filter (where x.id <> r.id and (x.state = 'queued' or (x.state = 'running' and x.batch_done_at is null)))
  into n, open from public.career_apply_prepare_requests x where x.user_id = r.user_id and coalesce(x.batch_id, x.id) = k;
 return jsonb_build_object('batch', k, 'requests', n, 'open', open);
end $$;

-- Every application the batch's parts made ready (the batch's one card), only under one of its parts' running lease.
create or replace function public.career_apply_prepare_batch_ready(p_id uuid, p_lease uuid)
returns table (id uuid, company text, card_lines text[], created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
 select p.id, p.company, p.card_lines, p.created_at
 from public.career_apply_prepare_requests r
 join public.career_apply_prepared p on p.user_id = r.user_id and p.state = 'ready'
 where r.id = p_id and r.state = 'running' and p_lease is not null and r.lease_token = p_lease
  and p.id in (select t.prepared_id from public.career_apply_prepare_attempts t join public.career_apply_prepare_requests b
   on b.user_id = r.user_id and coalesce(b.batch_id, b.id) = coalesce(r.batch_id, r.id)
   where t.user_id = r.user_id and t.outcome = 'ready' and t.posting_job_id = any(b.job_ids))
 order by p.created_at, p.id
$$;

alter table public.career_apply_cards add column if not exists file_id text;
alter table public.career_apply_cards add column if not exists file_sha text;
alter table public.career_apply_cards drop constraint if exists career_apply_cards_file;
alter table public.career_apply_cards add constraint career_apply_cards_file check (
 (file_id is null and file_sha is null) or (file_id ~ '^[0-9a-f]{10}$' and file_sha ~ '^[0-9a-f]{64}$'));

-- The hash of a batch File as stored (its data, which a page's own state, such as a flag, never changes); null when the
-- File is not this person's batch File, or it was revoked.
create or replace function public.career_apply_batch_file_sha(p_user uuid, p_file text) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
 select encode(sha256(convert_to((k.value->'data')::text, 'UTF8')), 'hex') from public.career_watch_kv k
 where k.user_id = p_user and p_file ~ '^[0-9a-f]{10}$' and k.key = 'tf:file:' || p_file and k.value->>'kind' = 'application_review'
  and k.value->>'userId' = p_user::text and k.value->>'id' = p_file and jsonb_typeof(k.value->'data'->'batch'->'items') = 'array'
  and (k.value->'revoked_at' is null or k.value->'revoked_at' = 'null'::jsonb)
$$;

create or replace function public.career_apply_card_push_batch_for(p_user uuid, p_request uuid, p_ids uuid[], p_text text, p_file text, p_now timestamptz)
returns uuid language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare thread uuid; c public.career_apply_cards; home_contact text; seen timestamptz; req public.career_apply_prepare_requests; web_only boolean := false;
 jobs text[]; items jsonb; sha text;
begin
 if p_user is null or p_request is null or p_ids is null or cardinality(p_ids) < 1 or p_now is null or p_file is null
  or p_text is null or length(p_text) not between 1 and 4000 then raise exception 'invalid card push'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select * into req from public.career_apply_prepare_requests where id = p_request and user_id = p_user and created_at > p_now - interval '2 hours';
 if req.id is null then raise exception 'not a requested preparation'; end if;
 jobs := array(select distinct j from public.career_apply_prepare_requests b, unnest(b.job_ids) j
  where b.user_id = p_user and coalesce(b.batch_id, b.id) = coalesce(req.batch_id, req.id));
 if exists (select from unnest(p_ids) x where not exists (select from public.career_apply_prepare_attempts t
   where t.user_id = p_user and t.prepared_id = x and t.posting_job_id = any(jobs))) then
  raise exception 'not a requested preparation'; end if;
 -- D-094: the File is the shown batch. It lists exactly these applications, numbered 1..N in this order, each at the payload
 -- hash it has now; anything else is not this card's File.
 select k.value->'data'->'batch'->'items' into items from public.career_watch_kv k
  where k.user_id = p_user and p_file ~ '^[0-9a-f]{10}$' and k.key = 'tf:file:' || p_file;
 sha := public.career_apply_batch_file_sha(p_user, p_file);
 if sha is null or items is null or jsonb_array_length(items) <> cardinality(p_ids) or exists (
   select from unnest(p_ids) with ordinality o(id, n)
   left join public.career_apply_prepared p on p.id = o.id and p.user_id = p_user
   where (items->(o.n::int - 1)->>'n') is distinct from o.n::text or (items->(o.n::int - 1)->>'prepared_id') is distinct from o.id::text
    or p.id is null or (items->(o.n::int - 1)->>'payload_hash') is distinct from p.payload_hash) then
  raise exception 'the File does not list exactly this batch'; end if;
 if exists (select from public.channel_contacts where user_id = p_user and opted_out) then return null; end if;
 select thread_id into thread from public.channel_contacts where user_id = p_user and thread_id is not null order by last_inbound_at desc nulls last, created_at limit 1;
 if thread is null then
  select m.thread_id into thread from public.agent_messages m join public.agent_threads t on t.id = m.thread_id
   where t.user_id = p_user order by m.id desc limit 1;
  web_only := thread is not null;
 end if;
 if thread is null then return null; end if;
 home_contact := public.channel_target(p_user, null);
 if home_contact like 'wa:%' then
  select last_inbound_at into seen from public.channel_contacts where contact = home_contact;
  if seen is null or seen < p_now - interval '23 hours' then return null; end if;
 end if;
 if coalesce((select m.meta->>'intent' in ('career_apply_questions', 'career_apply_confirm_which', 'career_apply_email')
               and m.created_at >= p_now - interval '24 hours'
              from public.agent_messages m where m.thread_id = thread and m.role = 'assistant' order by m.id desc limit 1), false)
  or (select count(*) from public.career_apply_prepared where user_id = p_user and state = 'ready' and id = any(p_ids)) <> cardinality(p_ids)
 then return null; end if;
 c := public.career_apply_card_open_for(p_user, p_ids, p_now);
 update public.career_apply_cards set file_id = p_file, file_sha = sha where id = c.id returning * into c;
 insert into public.agent_messages (thread_id, role, content, meta)
 values (thread, 'assistant', p_text, jsonb_build_object('career', true, 'intent', 'career_apply_card', 'card_id', c.id, 'requested', true,
  'prepare_request', p_request, 'batch', coalesce(req.batch_id, req.id), 'file_id', p_file, 'file_sha', sha, 'items', cardinality(p_ids)));
 if not web_only then
  insert into public.career_outbox (user_id, key, kind, text, deliver_at, card_id) values (p_user, 'card:' || c.id, 'card', p_text, p_now, c.id);
 end if;
 return c.id;
end $$;

-- 20261108100000's answer, plus the File binding (D-094).
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
 -- D-094: a card shown as a summary plus a File approves only while the File is exactly the File shown.
 if cardinality(coalesce(p_approve, '{}')) > 0 and c.file_id is not null
  and public.career_apply_batch_file_sha(p_user, c.file_id) is distinct from c.file_sha then raise exception 'FILE_CHANGED'; end if;
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

revoke all on function public.career_apply_card_answer_for(uuid, uuid, int[], timestamptz), public.career_apply_prepare_request_batch_of(),
 public.career_apply_prepare_request_put(uuid, text[], integer), public.career_apply_prepare_batch_done(uuid, uuid),
 public.career_apply_prepare_batch_ready(uuid, uuid), public.career_apply_batch_file_sha(uuid, text),
 public.career_apply_card_push_batch_for(uuid, uuid, uuid[], text, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.career_apply_prepare_request_put(uuid, text[], integer), public.career_apply_prepare_batch_done(uuid, uuid),
 public.career_apply_prepare_batch_ready(uuid, uuid), public.career_apply_batch_file_sha(uuid, text),
 public.career_apply_card_push_batch_for(uuid, uuid, uuid[], text, text, timestamptz) to service_role;
