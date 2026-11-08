-- R9-G2 (e2e E05, D-MS-1 paged): a batch too big for one card text is pushed as numbered pages ("1/3", "2/3", "3/3"),
-- each within the outbox's 4,000 characters, as ONE card. Before this, a batch whose card did not fit one text was not
-- pushed at all (cloud_prepare.ts: "say show my applications"), so a person who pasted 20 links got no card to answer.
--   1. career_apply_cards.set_hash / pages: the card's one hash, sha256 over every item's payload hash in card order
--      (career_apply_card_set_hash), and how many pages it was pushed in (null: a one-text card, unchanged).
--   2. career_apply_card_pages: one row per page pushed: its text's sha256, the outbox key that delivers it, and when it was
--      delivered (the web chat's own thread: when it was written there; a texting channel: when the outbox delivered it,
--      recorded by career_apply_card_page_delivered from career_outbox.delivered_at).
--   3. career_apply_card_push_paged_for: career_apply_card_push_requested_for's rules (a requested preparation's own ready
--      applications, every line of every application in the text, nothing while the person is mid-answer), for pages: each
--      page opens with "<i>/<n>", is 1 to 4,000 characters, and the pages together carry every line.
--   4. career_apply_card_answer_for: a yes to a paged card approves only when every page was delivered
--      ('card_pages_undelivered') and the set is the set shown ('APPROVAL_SET_CHANGED'). A no is never refused. Everything
--      else is exactly 20261026210016's.
-- Idempotent. NOT APPLIED: the owner applies migrations. Rollback: supabase/rollbacks/20261108100000_career_apply_card_pages.down.sql.

alter table public.career_apply_cards add column if not exists set_hash text;
alter table public.career_apply_cards add column if not exists pages integer;
alter table public.career_apply_cards drop constraint if exists career_apply_cards_paged;
alter table public.career_apply_cards add constraint career_apply_cards_paged check (
 (pages is null and set_hash is null) or (pages >= 2 and set_hash ~ '^[0-9a-f]{64}$'));

create table if not exists public.career_apply_card_pages (
 card_id uuid not null references public.career_apply_cards(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 page integer not null check (page >= 1),
 pages integer not null check (pages >= 2),
 text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
 outbox_key text,
 delivered_at timestamptz,
 created_at timestamptz not null default now(),
 primary key (card_id, page),
 check (page <= pages)
);
create index if not exists career_apply_card_pages_outbox on public.career_apply_card_pages (outbox_key) where outbox_key is not null;
alter table public.career_apply_card_pages enable row level security;
revoke all on public.career_apply_card_pages from public, anon, authenticated;
-- Service only: the pages' texts are the card's own messages (agent_messages), which the person already reads and exports.
grant all on public.career_apply_card_pages to service_role;

-- The card's one hash: every item's CURRENT payload hash, in card order (a changed or missing application changes it).
create or replace function public.career_apply_card_set_hash(p_card uuid) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
 select encode(sha256(convert_to(string_agg(coalesce(p.payload_hash, 'missing'), ',' order by (it->>'n')::int), 'UTF8')), 'hex')
 from public.career_apply_cards c cross join lateral jsonb_array_elements(c.items) it
 left join public.career_apply_prepared p on p.id = (it->>'prepared_id')::uuid and p.user_id = c.user_id
 where c.id = p_card
$$;

create or replace function public.career_apply_card_push_paged_for(p_user uuid, p_request uuid, p_ids uuid[], p_pages text[], p_now timestamptz)
returns uuid language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare thread uuid; c public.career_apply_cards; home_contact text; seen timestamptz; req public.career_apply_prepare_requests;
 web_only boolean := false; n int; i int; all_text text; k text;
begin
 n := coalesce(cardinality(p_pages), 0);
 if p_user is null or p_request is null or p_ids is null or cardinality(p_ids) < 1 or p_now is null or n < 2 then raise exception 'invalid card push'; end if;
 for i in 1..n loop
  if p_pages[i] is null or length(p_pages[i]) not between 1 and 4000 or left(p_pages[i], length(i || '/' || n)) <> i || '/' || n then
   raise exception 'invalid card push'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select * into req from public.career_apply_prepare_requests where id = p_request and user_id = p_user and created_at > p_now - interval '2 hours';
 if req.id is null then raise exception 'not a requested preparation'; end if;
 if exists (select from unnest(p_ids) x where not exists (select from public.career_apply_prepare_attempts t
   where t.user_id = p_user and t.prepared_id = x and t.posting_job_id = any(req.job_ids))) then
  raise exception 'not a requested preparation'; end if;
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
 all_text := array_to_string(p_pages, E'\n\n');
 if exists (select from public.career_apply_prepared p, unnest(p.card_lines) l
            where p.id = any(p_ids) and position(btrim(regexp_replace(l, '\s+', ' ', 'g')) in all_text) = 0) then
  raise exception 'card text does not carry every line'; end if;
 c := public.career_apply_card_open_for(p_user, p_ids, p_now);
 update public.career_apply_cards set pages = n, set_hash = public.career_apply_card_set_hash(c.id) where id = c.id returning * into c;
 for i in 1..n loop
  k := 'card:' || c.id || ':' || i;
  insert into public.agent_messages (thread_id, role, content, meta)
  values (thread, 'assistant', p_pages[i], jsonb_build_object('career', true, 'intent', 'career_apply_card', 'card_id', c.id, 'requested', true,
   'prepare_request', p_request, 'page', i, 'pages', n, 'set_hash', c.set_hash));
  if not web_only then
   insert into public.career_outbox (user_id, key, kind, text, deliver_at, card_id)
   values (p_user, k, 'card', p_pages[i], p_now + (i - 1) * interval '1 millisecond', c.id);
  end if;
  -- The web chat's thread is where a web-only person reads it: written there is delivered. A texting channel's page is
  -- delivered when the outbox delivers it.
  insert into public.career_apply_card_pages (card_id, user_id, page, pages, text_sha256, outbox_key, delivered_at)
  values (c.id, p_user, i, n, encode(sha256(convert_to(p_pages[i], 'UTF8')), 'hex'), case when web_only then null else k end,
   case when web_only then clock_timestamp() end);
 end loop;
 return c.id;
end $$;

-- A card page the outbox delivered: recorded on its page row (only the page that key names); a later held or failed report un-records it.
create or replace function public.career_apply_card_page_delivered() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if new.delivered_at is not null and old.delivered_at is null and new.kind = 'card' and new.card_id is not null then
  update public.career_apply_card_pages set delivered_at = new.delivered_at
   where card_id = new.card_id and outbox_key = new.key and user_id = new.user_id and delivered_at is null;
 -- The provider later reported it held or failed (delivered_at cleared): that page is not delivered any more.
 elsif new.delivered_at is null and old.delivered_at is not null and new.kind = 'card' and new.card_id is not null then
  update public.career_apply_card_pages set delivered_at = null where card_id = new.card_id and outbox_key = new.key and user_id = new.user_id;
 end if;
 return new;
end $$;
drop trigger if exists career_apply_card_page_delivered on public.career_outbox;
create trigger career_apply_card_page_delivered after update of delivered_at on public.career_outbox
 for each row execute function public.career_apply_card_page_delivered();

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

revoke all on function public.career_apply_card_answer_for(uuid, uuid, int[], timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.career_apply_card_set_hash(uuid), public.career_apply_card_push_paged_for(uuid, uuid, uuid[], text[], timestamptz),
 public.career_apply_card_page_delivered() from public, anon, authenticated, service_role;
grant execute on function public.career_apply_card_set_hash(uuid), public.career_apply_card_push_paged_for(uuid, uuid, uuid[], text[], timestamptz) to service_role;
