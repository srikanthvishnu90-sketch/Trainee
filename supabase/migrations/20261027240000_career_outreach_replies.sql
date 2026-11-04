-- MASS NETWORKING M5 (2026-10-27): what happens after outreach is sent. Replies understood, the person's own follow-up
-- sequence (any length) on a non-reply, and calls scheduled from the person's own calendar. Code enforces; the model only
-- classifies and writes. Needs M1's sending rail (20261027200000_career_send_queue.sql): every approved email here is
-- handed to career_send_queue (kind 'general', source_id = the action's id, approval_hash = its approved hash), and a
-- bounce lands on career_send_bad_addresses (never emailed again by anyone).
--   career_outreach_threads        one row per sent outreach thread (Gmail or Outlook): the contact's status and next step
--   career_outreach_turns          the whole conversation: every message once, who said it, what was asked or promised
--   career_outreach_sync           one cursor per person and mailbox (Gmail history id / Graph delta link), leased
--   career_outreach_followup_prefs the person's own follow-up sequence (no Trainee default; asked once when unset)
--   career_outreach_actions        what needs the person's approval: a follow-up, a scheduling reply, a calendar event,
--                                  each bound to the SHA-256 of its exact payload (D-MN-2)
-- No product volume limit anywhere (owner, 2026-10-27 "never set a limit"): p_limit arguments are how many rows one worker
-- call leases, so many workers share the queue; they bound a turn, never a person.
-- Rules that are not limits and hold here: a "stop"/"not interested" or a bounce puts the address on the do-not-contact list
-- (career_outreach_dnc, kept through an erase; a bounce also on career_send_bad_addresses) and nothing is ever sent to it
-- again; each step of the person's follow-up sequence at most once per thread, never after a reply (one still waiting on
-- the rail is cancelled there); an out-of-office pushes the follow-up past the return date; a calendar event is created at most once per
-- thread and only from an approved exact payload; an action whose lease expired is taken again, which is safe because each
-- effect is idempotent by the action itself (the rail's key is the action id and its approved hash; the event's id is
-- derived from the action id; #226's send key is the same pair).

-- ---------------------------------------------------------------------------------------------- threads
create table if not exists public.career_outreach_threads (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 draft_id uuid references public.career_outreach_drafts(id) on delete set null,
 provider text not null check (provider in ('gmail', 'outlook')),
 provider_thread text check (provider_thread is null or length(provider_thread) between 1 and 300),
 recipient_email text not null check (recipient_email ~ '^[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$'),
 recipient_name text not null default '' check (length(recipient_name) <= 200),
 recipient_firm text not null default '' check (length(recipient_firm) <= 200),
 subject text not null default '' check (length(subject) <= 200),
 contact_tz text check (contact_tz is null or length(contact_tz) between 1 and 64),
 sent_at timestamptz not null,
 status text not null default 'awaiting' check (status in ('awaiting', 'interested', 'wants_call', 'call_proposed', 'call_scheduled',
   'not_interested', 'out_of_office', 'bounced', 'referral', 'other')),
 status_at timestamptz not null default now(),
 replied_at timestamptz,
 ooo_until timestamptz,
 summary text check (summary is null or length(summary) <= 400),
 referral jsonb check (referral is null or (jsonb_typeof(referral) = 'object' and octet_length(referral::text) <= 1024)),
 their_times jsonb not null default '[]'::jsonb check (jsonb_typeof(their_times) = 'array' and octet_length(their_times::text) <= 4096),
 offered jsonb not null default '[]'::jsonb check (jsonb_typeof(offered) = 'array' and octet_length(offered::text) <= 4096),
 event jsonb check (event is null or (jsonb_typeof(event) = 'object' and octet_length(event::text) <= 2048)),
 open_asks jsonb not null default '[]'::jsonb check (jsonb_typeof(open_asks) = 'array' and octet_length(open_asks::text) <= 4096),
 commitments jsonb not null default '[]'::jsonb check (jsonb_typeof(commitments) = 'array' and octet_length(commitments::text) <= 4096),
 next_step text check (next_step is null or length(next_step) <= 300),
 turns int not null default 0,
 -- The follow-up sequence on this thread: how many went, when the last touch was, and whether the next may be drafted
 -- (none), one is waiting for the yes (drafted), the sequence ended on a reply, a stop or the person's own follow-up (off),
 -- or every step the person set has gone (done).
 followups_sent int not null default 0 check (followups_sent >= 0),
 last_touch_at timestamptz,
 followup_state text not null default 'none' check (followup_state in ('none', 'drafted', 'off', 'done')),
 lease_owner text check (lease_owner is null or length(lease_owner) <= 100),
 lease_until timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists career_outreach_threads_provider on public.career_outreach_threads (user_id, provider, provider_thread) where provider_thread is not null;
create unique index if not exists career_outreach_threads_draft on public.career_outreach_threads (draft_id) where draft_id is not null;
create index if not exists career_outreach_threads_user_status on public.career_outreach_threads (user_id, status, status_at desc);
create index if not exists career_outreach_threads_wants_call on public.career_outreach_threads (status_at) where status = 'wants_call';
create index if not exists career_outreach_threads_user_email on public.career_outreach_threads (user_id, recipient_email);
-- The follow-up queue's hot read: open threads with no follow-up yet, by when they were sent.
create index if not exists career_outreach_threads_followup_due on public.career_outreach_threads (sent_at)
 where status in ('awaiting', 'out_of_office') and followup_state = 'none';
alter table public.career_outreach_threads enable row level security;
revoke all on public.career_outreach_threads from public, anon, authenticated;
grant select on public.career_outreach_threads to authenticated;
grant all on public.career_outreach_threads to service_role;
drop policy if exists career_outreach_threads_owner_read on public.career_outreach_threads;
create policy career_outreach_threads_owner_read on public.career_outreach_threads for select to authenticated using ((select auth.uid()) = user_id);

-- The conversation, turn by turn (owner, 2026-10-27 20:40: "understand conversational workflow"): every message on the
-- thread once, who wrote it (the person, the contact, someone else on the thread, or a mail system), what it was, a plain
-- summary, and what it asked of the person or promised. The thread row carries the running state the planner reads:
-- open_asks (asked of the person, not yet answered), commitments (by either side, with done), next_step (code's).
create table if not exists public.career_outreach_turns (
 thread_id uuid not null references public.career_outreach_threads(id) on delete cascade,
 provider_msg text not null check (length(provider_msg) between 1 and 300),
 user_id uuid not null references public.profiles(id) on delete cascade,
 who text not null check (who in ('person', 'contact', 'other', 'system')),
 class text check (class is null or class in ('interested', 'wants_call', 'confirms_time', 'not_interested', 'out_of_office', 'bounce', 'referral', 'other', 'sent')),
 summary text check (summary is null or length(summary) <= 400),
 asks jsonb not null default '[]'::jsonb check (jsonb_typeof(asks) = 'array' and octet_length(asks::text) <= 2048),
 commitments jsonb not null default '[]'::jsonb check (jsonb_typeof(commitments) = 'array' and octet_length(commitments::text) <= 2048),
 at timestamptz not null default now(),
 primary key (thread_id, provider_msg)
);
create index if not exists career_outreach_turns_thread_at on public.career_outreach_turns (thread_id, at);
create index if not exists career_outreach_turns_user on public.career_outreach_turns (user_id, at desc);
alter table public.career_outreach_turns enable row level security;
revoke all on public.career_outreach_turns from public, anon, authenticated;
grant select on public.career_outreach_turns to authenticated;
grant all on public.career_outreach_turns to service_role;
drop policy if exists career_outreach_turns_owner_read on public.career_outreach_turns;
create policy career_outreach_turns_owner_read on public.career_outreach_turns for select to authenticated using ((select auth.uid()) = user_id);

create table if not exists public.career_outreach_sync (
 user_id uuid not null references public.profiles(id) on delete cascade,
 provider text not null check (provider in ('gmail', 'outlook')),
 cursor text check (cursor is null or length(cursor) <= 4096),
 next_at timestamptz not null default now(),
 lease_owner text check (lease_owner is null or length(lease_owner) <= 100),
 lease_until timestamptz,
 last_ok_at timestamptz,
 last_error text check (last_error is null or length(last_error) <= 300),
 primary key (user_id, provider)
);
create index if not exists career_outreach_sync_due on public.career_outreach_sync (next_at);
alter table public.career_outreach_sync enable row level security;
revoke all on public.career_outreach_sync from public, anon, authenticated;
grant all on public.career_outreach_sync to service_role;

create table if not exists public.career_outreach_followup_prefs (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 -- The person's own interval. Null: not set (asked once, then nothing is drafted until they say). off: no follow-ups.
 -- The person's own sequence: the days to wait before each follow-up, each counted from the touch before it (the first
 -- email, then each follow-up). Any length, any spacing; Trainee sets none. Null: not set (asked once, three touches
 -- offered as the suggestion). off: no follow-ups.
 steps int[] check (steps is null or (cardinality(steps) >= 1 and 1 <= all(steps) and 3650 >= all(steps))),
 off boolean not null default false,
 asked_at timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.career_outreach_followup_prefs enable row level security;
revoke all on public.career_outreach_followup_prefs from public, anon, authenticated;
grant all on public.career_outreach_followup_prefs to service_role;

create table if not exists public.career_outreach_actions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 thread_id uuid not null references public.career_outreach_threads(id) on delete cascade,
 kind text not null check (kind in ('followup', 'schedule_reply', 'calendar_event')),
 step int check (step is null or step >= 1),
 batch_id uuid not null,
 n int not null check (n >= 1),
 payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384),
 hash text not null check (hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'shown' check (status in ('shown', 'approved', 'running', 'done', 'failed', 'cancelled', 'refused')),
 approved_hash text check (approved_hash is null or approved_hash ~ '^[a-f0-9]{64}$'),
 approved_at timestamptz,
 lease_owner text check (lease_owner is null or length(lease_owner) <= 100),
 lease_until timestamptz,
 result text check (result is null or length(result) <= 300),
 provider_ref text check (provider_ref is null or length(provider_ref) <= 300),
 link text check (link is null or length(link) <= 500),
 created_at timestamptz not null default now(),
 done_at timestamptz,
 updated_at timestamptz not null default now(),
 unique (batch_id, n),
 constraint career_outreach_actions_approved_is_exact check (status not in ('approved', 'running', 'done') or (approved_hash is not null and approved_hash = hash))
);
-- One follow-up per thread, ever (a cancelled or refused one does not count); one calendar event per thread, ever.
-- One follow-up open per thread at a time, and each step of the sequence sent at most once.
create unique index if not exists career_outreach_actions_one_followup on public.career_outreach_actions (thread_id)
 where kind = 'followup' and status in ('shown', 'approved', 'running');
create unique index if not exists career_outreach_actions_followup_step on public.career_outreach_actions (thread_id, step)
 where kind = 'followup' and status = 'done';
create unique index if not exists career_outreach_actions_one_event on public.career_outreach_actions (thread_id)
 where kind = 'calendar_event' and status in ('running', 'done');
create index if not exists career_outreach_actions_approved on public.career_outreach_actions (user_id, approved_at, n) where status = 'approved';
create index if not exists career_outreach_actions_running on public.career_outreach_actions (lease_until) where status = 'running';
create index if not exists career_outreach_actions_user_batch on public.career_outreach_actions (user_id, batch_id, n);
create index if not exists career_outreach_actions_thread on public.career_outreach_actions (thread_id, kind, status);
alter table public.career_outreach_actions enable row level security;
revoke all on public.career_outreach_actions from public, anon, authenticated;
grant select on public.career_outreach_actions to authenticated;
grant all on public.career_outreach_actions to service_role;
drop policy if exists career_outreach_actions_owner_read on public.career_outreach_actions;
create policy career_outreach_actions_owner_read on public.career_outreach_actions for select to authenticated using ((select auth.uid()) = user_id);
-- When the rail's row for an approved email was looked at for its provider thread (career_outreach_threads_adopt).
alter table public.career_outreach_actions add column if not exists rail_seen_at timestamptz;
create index if not exists career_outreach_actions_rail_unseen on public.career_outreach_actions (done_at)
 where status = 'done' and kind in ('followup', 'schedule_reply') and rail_seen_at is null;

-- The rail sends each follow-up and each reply with times as a new message, so a reply to one lands on a new provider
-- thread: that thread is this conversation's too, and the sync reads it as such.
create table if not exists public.career_outreach_thread_aliases (
 user_id uuid not null references public.profiles(id) on delete cascade,
 provider text not null check (provider in ('gmail', 'outlook')),
 provider_thread text not null check (length(provider_thread) between 1 and 300),
 thread_id uuid not null references public.career_outreach_threads(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key (user_id, provider, provider_thread)
);
create index if not exists career_outreach_thread_aliases_thread on public.career_outreach_thread_aliases (thread_id);
alter table public.career_outreach_thread_aliases enable row level security;
revoke all on public.career_outreach_thread_aliases from public, anon, authenticated;
grant all on public.career_outreach_thread_aliases to service_role;

-- The do-not-contact list is read by address across every person (a stop to anyone stops everyone's mail to it): its
-- primary key leads with user_id, so the hot lookup gets its own index.
create index if not exists career_outreach_dnc_email on public.career_outreach_dnc (email_hash);

-- ---------------------------------------------------------------------------------------------- helpers
create or replace function public.career_outreach_email_hash(p_email text) returns text
language sql immutable set search_path = public, pg_temp as $$
 select encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex')
$$;
revoke all on function public.career_outreach_email_hash(text) from public, anon, authenticated;
grant execute on function public.career_outreach_email_hash(text) to service_role;

-- A thread to watch, from a send (Gmail or Outlook) or a draft the person sent themselves. Idempotent per draft and per
-- provider thread. Its mailbox gets a sync row (due now) when it has none.
create or replace function public.career_outreach_thread_track(p_user uuid, p_draft uuid, p_provider text, p_thread text,
  p_email text, p_name text, p_firm text, p_subject text, p_sent_at timestamptz, p_contact_tz text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare tid uuid;
begin
 if p_user is null or p_provider not in ('gmail', 'outlook') or p_sent_at is null then raise exception 'invalid outreach thread'; end if;
 select t.id into tid from public.career_outreach_threads t
  where t.user_id = p_user and ((p_draft is not null and t.draft_id = p_draft) or (p_thread is not null and t.provider = p_provider and t.provider_thread = p_thread))
  limit 1;
 if tid is null then
  insert into public.career_outreach_threads(user_id, draft_id, provider, provider_thread, recipient_email, recipient_name, recipient_firm, subject, sent_at, contact_tz)
  values (p_user, p_draft, p_provider, nullif(p_thread, ''), lower(btrim(p_email)), left(coalesce(p_name, ''), 200), left(coalesce(p_firm, ''), 200),
    left(regexp_replace(coalesce(p_subject, ''), '[\r\n]+', ' ', 'g'), 200), p_sent_at, p_contact_tz)
  returning career_outreach_threads.id into tid;
 else
  update public.career_outreach_threads set provider_thread = coalesce(provider_thread, nullif(p_thread, '')), updated_at = now() where career_outreach_threads.id = tid;
 end if;
 insert into public.career_outreach_sync(user_id, provider, next_at) values (p_user, p_provider, now()) on conflict (user_id, provider) do nothing;
 return tid;
end $$;
revoke all on function public.career_outreach_thread_track(uuid, uuid, text, text, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.career_outreach_thread_track(uuid, uuid, text, text, text, text, text, text, timestamptz, text) to service_role;

-- Outreach already sent (career_outreach_drafts status 'sent' with its provider thread, by the sending rail or the older
-- WO-033 run) that is not watched yet: adopted, oldest first, p_limit per call, on the mailbox the rail sent it from.
create or replace function public.career_outreach_threads_adopt(p_limit int)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; n int := 0;
begin
 for d in select x.* from public.career_outreach_drafts x
   where x.status in ('sent', 'replied', 'bounced') and x.gmail_thread is not null and x.sent_at is not null
     and not exists (select 1 from public.career_outreach_threads t where t.draft_id = x.id)
   order by x.sent_at limit greatest(coalesce(p_limit, 1), 1) loop
  perform public.career_outreach_thread_track(d.user_id, d.id,
    coalesce((select q.provider from public.career_send_queue q where q.user_id = d.user_id and q.recipient_email = lower(d.recipient_email)
      and q.kind = 'outreach' and q.source_id = d.id limit 1), 'gmail'), d.gmail_thread, d.recipient_email,
    coalesce(d.recipient->>'name', ''), coalesce(d.recipient->>'firm', ''), d.subject, d.sent_at, nullif(d.recipient->>'tz', ''));
  n := n + 1;
 end loop;
 -- Emails this lane handed to the rail: once the rail has sent one, its provider thread becomes the conversation's alias;
 -- one the rail never sent (refused, cancelled, failed) is recorded on the action so the person's view says so.
 for d in select a.id, a.user_id, a.thread_id, q.provider, q.state, q.gmail_thread, q.result from public.career_outreach_actions a
   join public.career_send_queue q on a.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and q.id = a.provider_ref::uuid
   where a.status = 'done' and a.kind in ('followup', 'schedule_reply') and a.rail_seen_at is null
     and q.state in ('sent', 'replied', 'bounced', 'refused', 'cancelled', 'failed')
   order by a.done_at limit greatest(coalesce(p_limit, 1), 1) loop
  if d.gmail_thread is not null then
   insert into public.career_outreach_thread_aliases(user_id, provider, provider_thread, thread_id)
   values (d.user_id, d.provider, d.gmail_thread, d.thread_id) on conflict do nothing;
  end if;
  update public.career_outreach_actions set rail_seen_at = now(), updated_at = now(),
    result = case when d.state in ('refused', 'cancelled', 'failed') then left('not sent by the rail: ' || coalesce(d.result, d.state), 300) else result end
   where id = d.id;
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function public.career_outreach_threads_adopt(int) from public, anon, authenticated;
grant execute on function public.career_outreach_threads_adopt(int) to service_role;

-- The watched threads among a mailbox's provider thread ids (a thread's own id or an alias), each with the id it matched.
create or replace function public.career_outreach_threads_watched(p_user uuid, p_provider text, p_ids text[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object('matched', m.id)), '[]'::jsonb)
 from (select distinct on (x.id) x.id, coalesce(
         (select t1.id from public.career_outreach_threads t1 where t1.user_id = p_user and t1.provider = p_provider and t1.provider_thread = x.id),
         (select a.thread_id from public.career_outreach_thread_aliases a where a.user_id = p_user and a.provider = p_provider and a.provider_thread = x.id)) tid
       from unnest(p_ids[1:500]) x(id)) m
 join public.career_outreach_threads t on t.id = m.tid
$$;
revoke all on function public.career_outreach_threads_watched(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.career_outreach_threads_watched(uuid, text, text[]) to service_role;

-- ---------------------------------------------------------------------------------------------- mailbox sync leases
-- Due mailboxes, each leased to one worker (FOR UPDATE SKIP LOCKED): many workers on many instances share the queue, an
-- expired lease is taken again, one row per person and mailbox so no person can starve another.
create or replace function public.career_outreach_sync_claim(p_worker text, p_limit int, p_now timestamptz, p_lease_seconds int)
returns setof public.career_outreach_sync language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if p_worker is null or p_now is null or coalesce(p_lease_seconds, 0) < 1 then raise exception 'invalid sync claim'; end if;
 return query
 update public.career_outreach_sync s set lease_owner = p_worker, lease_until = p_now + make_interval(secs => p_lease_seconds)
 from (select s2.user_id, s2.provider from public.career_outreach_sync s2
       where s2.next_at <= p_now and (s2.lease_until is null or s2.lease_until < p_now)
       order by s2.next_at limit greatest(coalesce(p_limit, 1), 1) for update skip locked) due
 where s.user_id = due.user_id and s.provider = due.provider
 returning s.*;
end $$;
revoke all on function public.career_outreach_sync_claim(text, int, timestamptz, int) from public, anon, authenticated;
grant execute on function public.career_outreach_sync_claim(text, int, timestamptz, int) to service_role;

-- The lease's end: the new cursor and when to look again. Only the worker holding the lease may write it.
create or replace function public.career_outreach_sync_release(p_user uuid, p_provider text, p_worker text, p_cursor text,
  p_next_at timestamptz, p_error text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
 update public.career_outreach_sync set cursor = coalesce(p_cursor, cursor), next_at = p_next_at, lease_owner = null, lease_until = null,
   last_error = left(p_error, 300), last_ok_at = case when p_error is null then now() else last_ok_at end
 where user_id = p_user and provider = p_provider and lease_owner = p_worker;
 get diagnostics n = row_count;
 return n = 1;
end $$;
revoke all on function public.career_outreach_sync_release(uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.career_outreach_sync_release(uuid, text, text, text, timestamptz, text) to service_role;

-- What this lane handed to the sending rail on a thread and the rail has not sent yet (still queued): taken back on the
-- rail, and its action marked cancelled, so it never goes and is never counted as sent. Followups only, or every email.
-- Returns how many follow-ups were taken back (the thread's count goes down by as many).
create or replace function public.career_outreach_rail_takeback(p_thread uuid, p_followups_only boolean, p_why text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare k int;
begin
 with q as (
  update public.career_send_queue set state = 'cancelled', result = left(p_why, 300), updated_at = now()
  where state = 'queued' and kind = 'general' and id in (select x.provider_ref::uuid from public.career_outreach_actions x
    where x.thread_id = p_thread and x.status = 'done' and x.provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and (not p_followups_only or x.kind = 'followup'))
  returning source_id
 ), a as (
  update public.career_outreach_actions x set status = 'cancelled', result = left('not sent: ' || p_why, 300), updated_at = now()
  from q where x.id = q.source_id returning x.kind
 )
 select count(*) filter (where kind = 'followup') into k from a;
 if k > 0 then
  update public.career_outreach_threads set followups_sent = greatest(followups_sent - k, 0), updated_at = now() where id = p_thread;
 end if;
 return k;
end $$;
revoke all on function public.career_outreach_rail_takeback(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.career_outreach_rail_takeback(uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------------------------- a reply understood
-- One provider message, once. Returns 'seen' (already counted), 'terminal' (the contact already said stop or bounced; it
-- stays so), or the thread's new status. A stop or not-interested, and a bounce, put the address on the do-not-contact
-- list and cancel every open action on the thread. Any real reply ends the follow-up: it is turned off and an open one
-- is cancelled. An out-of-office keeps the thread open and records the return date (the follow-up waits past it).
create or replace function public.career_outreach_reply_apply(p_user uuid, p_thread uuid, p_msg text, p_class text, p_at timestamptz, p_detail jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.career_outreach_threads; n int; d jsonb := coalesce(p_detail, '{}'::jsonb); s text; back timestamptz; k int;
begin
 if p_class not in ('interested', 'wants_call', 'confirms_time', 'not_interested', 'out_of_office', 'bounce', 'referral', 'other') then
  raise exception 'unknown reply class'; end if;
 select * into t from public.career_outreach_threads where id = p_thread and user_id = p_user for update;
 if not found then raise exception 'no such outreach thread'; end if;
 insert into public.career_outreach_turns(thread_id, provider_msg, user_id, who, class, summary, asks, commitments, at)
  values (p_thread, p_msg, p_user, case when p_class = 'bounce' then 'system' else coalesce(nullif(d->>'who', ''), 'contact') end, p_class, left(d->>'summary', 400),
   case when jsonb_typeof(d->'asks') = 'array' then d->'asks' else '[]'::jsonb end,
   case when jsonb_typeof(d->'commitments') = 'array' then d->'commitments' else '[]'::jsonb end, coalesce(p_at, now()))
  on conflict do nothing;
 get diagnostics n = row_count;
 if n = 0 then return 'seen'; end if;
 -- The conversation's running state, as code computed it from every turn (the caller's merge): written on every turn.
 update public.career_outreach_threads set turns = turns + 1,
  open_asks = case when jsonb_typeof(d->'conversation'->'open_asks') = 'array' then d->'conversation'->'open_asks' else open_asks end,
  commitments = case when jsonb_typeof(d->'conversation'->'commitments') = 'array' then d->'conversation'->'commitments' else commitments end,
  next_step = coalesce(left(d->'conversation'->>'next_step', 300), next_step), updated_at = now()
  where id = p_thread;
 if t.status in ('not_interested', 'bounced') then return 'terminal'; end if;
 if p_class in ('not_interested', 'bounce') then
  insert into public.career_outreach_dnc(user_id, email_hash, reason, at)
   values (p_user, public.career_outreach_email_hash(t.recipient_email), case when p_class = 'bounce' then 'bounced: the address does not work' else 'recipient asked to stop' end, now())
   on conflict (user_id, email_hash) do nothing;
  if p_class = 'bounce' then
   insert into public.career_send_bad_addresses(email_hash, reason) values (public.career_send_email_hash(t.recipient_email), 'bounced')
   on conflict (email_hash) do nothing;
  end if;
  update public.career_outreach_actions set status = 'cancelled', result = 'cancelled: ' || p_class, lease_owner = null, lease_until = null, updated_at = now()
   where thread_id = p_thread and status in ('shown', 'approved');
  k := public.career_outreach_rail_takeback(p_thread, false, case when p_class = 'bounce' then 'bad_address' else 'opted_out' end);
  s := case when p_class = 'bounce' then 'bounced' else 'not_interested' end;
  update public.career_outreach_threads set status = s, status_at = now(), replied_at = case when p_class = 'bounce' then replied_at else coalesce(replied_at, p_at) end,
   followup_state = case when followup_state = 'done' and k = 0 then 'done' else 'off' end, summary = left(coalesce(d->>'summary', summary), 400), updated_at = now()
   where id = p_thread;
  return s;
 end if;
 if p_class = 'out_of_office' then
  back := case when coalesce(d->>'return_at', '') ~ '^\d{4}-\d{2}-\d{2}' then (d->>'return_at')::timestamptz else null end;
  if t.status in ('awaiting', 'out_of_office') then
   update public.career_outreach_threads set status = 'out_of_office', status_at = now(), ooo_until = coalesce(back, ooo_until),
    summary = left(coalesce(d->>'summary', summary), 400), updated_at = now() where id = p_thread;
   return 'out_of_office';
  end if;
  return t.status;
 end if;
 -- A person answered: no follow-up after this, ever.
 update public.career_outreach_actions set status = 'cancelled', result = 'cancelled: they replied', lease_owner = null, lease_until = null, updated_at = now()
  where thread_id = p_thread and kind = 'followup' and status in ('shown', 'approved');
 -- and a follow-up already handed to the rail but not sent yet never goes (and is not counted as sent).
 k := public.career_outreach_rail_takeback(p_thread, true, 'they replied');
 s := case
  when p_class = 'confirms_time' then (case when t.status in ('call_proposed', 'call_scheduled') then t.status else 'wants_call' end)
  when t.status = 'call_scheduled' then 'call_scheduled'
  when t.status = 'call_proposed' and p_class in ('wants_call', 'interested', 'other') then 'call_proposed'
  else p_class end;
 update public.career_outreach_threads set status = s, status_at = now(), replied_at = coalesce(replied_at, p_at), ooo_until = null,
  followup_state = case when followup_state = 'done' and k = 0 then 'done' else 'off' end,
  summary = left(coalesce(d->>'summary', summary), 400),
  referral = case when p_class = 'referral' and jsonb_typeof(d->'referral') = 'object' then d->'referral' else referral end,
  their_times = case when jsonb_typeof(d->'their_times') = 'array' then d->'their_times' else their_times end,
  contact_tz = coalesce(nullif(d->>'contact_tz', ''), contact_tz),
  updated_at = now()
  where id = p_thread;
 return s;
end $$;
revoke all on function public.career_outreach_reply_apply(uuid, uuid, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.career_outreach_reply_apply(uuid, uuid, text, text, timestamptz, jsonb) to service_role;

-- The person's own message on the thread (Trainee's send, or one they wrote themselves): recorded once, the conversation
-- state replaced by the caller's merge. A message the person wrote themselves after the first one is their own follow-up:
-- no automatic follow-up is drafted after it, and an open one is cancelled.
create or replace function public.career_outreach_person_turn(p_user uuid, p_thread uuid, p_msg text, p_at timestamptz, p_detail jsonb, p_by_trainee boolean)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.career_outreach_threads; n int; d jsonb := coalesce(p_detail, '{}'::jsonb); by_trainee boolean := coalesce(p_by_trainee, false); rail_src uuid;
begin
 select * into t from public.career_outreach_threads where id = p_thread and user_id = p_user for update;
 if not found then raise exception 'no such outreach thread'; end if;
 -- A message the sending rail sent (its Gmail id is on the rail's row, found through the rail's (user, recipient) index) is
 -- Trainee's, never the person's own follow-up; one this lane already recorded when it handed it over ('queued:<action>')
 -- is not counted twice.
 select q.source_id into rail_src from public.career_send_queue q
  where q.user_id = p_user and q.recipient_email = t.recipient_email and q.gmail_id = p_msg limit 1;
 if rail_src is not null then
  by_trainee := true;
  if exists (select 1 from public.career_outreach_turns x where x.thread_id = p_thread and x.provider_msg = 'queued:' || rail_src) then return 'seen'; end if;
 end if;
 insert into public.career_outreach_turns(thread_id, provider_msg, user_id, who, class, summary, asks, commitments, at)
  values (p_thread, p_msg, p_user, 'person', 'sent', left(d->>'summary', 400), '[]'::jsonb,
   case when jsonb_typeof(d->'commitments') = 'array' then d->'commitments' else '[]'::jsonb end, coalesce(p_at, now()))
  on conflict do nothing;
 get diagnostics n = row_count;
 if n = 0 then return 'seen'; end if;
 update public.career_outreach_threads set turns = turns + 1,
  open_asks = case when jsonb_typeof(d->'conversation'->'open_asks') = 'array' then d->'conversation'->'open_asks' else open_asks end,
  commitments = case when jsonb_typeof(d->'conversation'->'commitments') = 'array' then d->'conversation'->'commitments' else commitments end,
  next_step = coalesce(left(d->'conversation'->>'next_step', 300), next_step),
  followup_state = case when not by_trainee and t.turns > 0 and followup_state = 'none' then 'off' else followup_state end,
  updated_at = now()
  where id = p_thread;
 if not by_trainee and t.turns > 0 then
  update public.career_outreach_actions set status = 'cancelled', result = 'cancelled: you followed up yourself', updated_at = now()
   where thread_id = p_thread and kind = 'followup' and status in ('shown', 'approved');
 end if;
 return 'recorded';
end $$;
revoke all on function public.career_outreach_person_turn(uuid, uuid, text, timestamptz, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.career_outreach_person_turn(uuid, uuid, text, timestamptz, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------- follow-ups due
-- Threads whose follow-up is due by the person's own interval, leased to one drafting worker. Never a thread with a reply,
-- a stop, a bounce, a do-not-contact address, a follow-up already made, or an out-of-office return date still ahead.
create or replace function public.career_outreach_followups_due(p_worker text, p_limit int, p_now timestamptz, p_lease_seconds int)
returns setof public.career_outreach_threads language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if p_worker is null or p_now is null or coalesce(p_lease_seconds, 0) < 1 then raise exception 'invalid follow-up claim'; end if;
 return query
 update public.career_outreach_threads t set lease_owner = p_worker, lease_until = p_now + make_interval(secs => p_lease_seconds)
 from (select t2.id from public.career_outreach_threads t2
       join public.career_outreach_followup_prefs p on p.user_id = t2.user_id and not p.off and p.steps is not null
       where t2.status in ('awaiting', 'out_of_office') and t2.followup_state = 'none' and t2.replied_at is null
         and cardinality(p.steps) > t2.followups_sent
         and coalesce(t2.last_touch_at, t2.sent_at) + make_interval(days => p.steps[t2.followups_sent + 1]) <= p_now
         and (t2.ooo_until is null or t2.ooo_until + interval '1 day' <= p_now)
         and (t2.lease_until is null or t2.lease_until < p_now)
         and not exists (select 1 from public.career_outreach_dnc x where x.email_hash = public.career_outreach_email_hash(t2.recipient_email))
         and not exists (select 1 from public.career_send_bad_addresses b where b.email_hash = public.career_send_email_hash(t2.recipient_email))
       order by t2.sent_at limit greatest(coalesce(p_limit, 1), 1) for update of t2 skip locked) due
 where t.id = due.id
 returning t.*;
end $$;
revoke all on function public.career_outreach_followups_due(text, int, timestamptz, int) from public, anon, authenticated;
grant execute on function public.career_outreach_followups_due(text, int, timestamptz, int) to service_role;

-- People with a thread waiting for a follow-up and no interval set, asked once: the row records the ask in the same
-- statement, so two workers never ask twice.
create or replace function public.career_outreach_followup_ask_due(p_limit int, p_now timestamptz)
returns setof uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
 return query
 insert into public.career_outreach_followup_prefs(user_id, asked_at)
 select distinct t.user_id, p_now from public.career_outreach_threads t
  where t.status in ('awaiting', 'out_of_office') and t.followup_state = 'none'
    and not exists (select 1 from public.career_outreach_followup_prefs p where p.user_id = t.user_id)
  limit greatest(coalesce(p_limit, 1), 1)
 on conflict (user_id) do nothing
 returning user_id;
end $$;
revoke all on function public.career_outreach_followup_ask_due(int, timestamptz) from public, anon, authenticated;
grant execute on function public.career_outreach_followup_ask_due(int, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------- approvals (D-MN-2)
-- One yes approves exactly the items named, each only if its hash is still the one shown. p_items: [{"n":1,"hash":"..."}].
create or replace function public.career_outreach_actions_approve(p_user uuid, p_batch uuid, p_items jsonb, p_now timestamptz)
returns int[] language plpgsql security definer set search_path = public, pg_temp as $$
declare out int[] := '{}'; it jsonb; k int;
begin
 if jsonb_typeof(p_items) <> 'array' then raise exception 'invalid approval'; end if;
 for it in select * from jsonb_array_elements(p_items) loop
  update public.career_outreach_actions set status = 'approved', approved_hash = hash, approved_at = p_now, updated_at = now()
   where user_id = p_user and batch_id = p_batch and n = (it->>'n')::int and status = 'shown' and hash = it->>'hash'
   returning n into k;
  if k is not null then out := out || k; end if;
  k := null;
 end loop;
 return out;
end $$;
revoke all on function public.career_outreach_actions_approve(uuid, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.career_outreach_actions_approve(uuid, uuid, jsonb, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------- the action claim
-- Approved actions, at most p_per_user per person per call (fair: a person with ten thousand approvals never starves the
-- next; each step is one probe of the approved index, so the call's cost does not grow with the queue), each checked again here and leased to one worker. Refused for good: a changed payload, a do-not-contact address,
-- a follow-up on a thread that has a reply (or already has its follow-up sent), a scheduling reply on a thread that no
-- longer wants a call, a second calendar event. Left approved for a later run: a follow-up whose out-of-office return
-- date is still ahead. An expired lease: a calendar event is taken again (its provider id makes the retry idempotent); an
-- email is marked failed and never re-sent automatically (it may have gone).
create or replace function public.career_outreach_action_claim(p_worker text, p_limit int, p_per_user int, p_now timestamptz, p_lease_seconds int)
returns setof public.career_outreach_actions language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.career_outreach_actions; t public.career_outreach_threads; why text; took int := 0; lim int := greatest(coalesce(p_limit, 1), 1);
  per int := greatest(coalesce(p_per_user, 1), 1); start uuid := gen_random_uuid(); cur uuid; u uuid; wrapped boolean := false; steps int := 0; took_before int; round_done boolean;
begin
 if p_worker is null or p_now is null or coalesce(p_lease_seconds, 0) < 1 then raise exception 'invalid action claim'; end if;
 -- A worker that died mid-action: back to approved, checked again by this claim. Taking it again never doubles the effect
 -- (the rail's enqueue answers already_queued for the same action and hash; the calendar event id comes from the action id).
 update public.career_outreach_actions set status = 'approved', result = 'lease expired; taken again (idempotent)',
   lease_owner = null, lease_until = null, updated_at = now()
  where id in (select id from public.career_outreach_actions where status = 'running' and lease_until < p_now
               order by lease_until limit 1000 for update skip locked);
 -- People in turn, from a random point round the user ids (each step one index probe on the approved partial index),
 -- p_per_user of each person's oldest approvals per pass: no person, however many approvals they hold, starves another.
 -- When a pass has gone round everyone and the call still has room, another pass fills it (fairness, never a cap: one
 -- person alone gets the whole call).
 <<passes>>
 loop
 took_before := took; cur := start; wrapped := false; steps := 0; round_done := false;
 loop
  steps := steps + 1;
  exit when took >= lim or steps > lim * 4 + 8;
  if not wrapped then select x.user_id into u from public.career_outreach_actions x where x.status = 'approved' and x.user_id >= cur and (steps = 1 or x.user_id > cur) order by x.user_id limit 1;
  else select x.user_id into u from public.career_outreach_actions x where x.status = 'approved' and x.user_id > cur and x.user_id < start order by x.user_id limit 1; end if;
  if u is null then
   if wrapped then round_done := true; exit; end if;
   wrapped := true; cur := '00000000-0000-0000-0000-000000000000'::uuid;
   select x.user_id into u from public.career_outreach_actions x where x.status = 'approved' and x.user_id >= cur and x.user_id < start order by x.user_id limit 1;
   if u is null then round_done := true; exit; end if;
  end if;
  cur := u;
  for a in select x.* from public.career_outreach_actions x where x.user_id = u and x.status = 'approved'
    order by x.approved_at, x.n limit per for update skip locked loop
   select * into t from public.career_outreach_threads where id = a.thread_id;
   why := null;
   if a.approved_hash is null or a.approved_hash <> a.hash then why := 'changed';
   elsif a.kind <> 'calendar_event' and exists (select 1 from public.career_outreach_dnc d where d.email_hash = public.career_outreach_email_hash(t.recipient_email)) then why := 'do_not_contact';
   elsif exists (select 1 from public.career_send_bad_addresses b where b.email_hash = public.career_send_email_hash(t.recipient_email)) then why := 'bad_address';
   elsif t.status in ('not_interested', 'bounced') then why := 'do_not_contact';
   elsif a.kind = 'followup' and (t.replied_at is not null or t.status not in ('awaiting', 'out_of_office')) then why := 'replied';
   elsif a.kind = 'followup' and (t.followup_state in ('off', 'done') or coalesce(a.step, 0) <= t.followups_sent
     or exists (select 1 from public.career_outreach_actions o where o.thread_id = a.thread_id and o.kind = 'followup' and (o.status = 'running' or (o.status = 'done' and o.step = a.step)) and o.id <> a.id)) then why := 'already_followed_up';
   elsif a.kind = 'schedule_reply' and t.status not in ('wants_call', 'interested', 'call_proposed') then why := 'no_call_wanted';
   elsif a.kind = 'calendar_event' and exists (select 1 from public.career_outreach_actions o where o.thread_id = a.thread_id and o.kind = 'calendar_event' and o.status in ('running', 'done') and o.id <> a.id) then why := 'already_created';
   end if;
   if why is not null then
    update public.career_outreach_actions set status = 'refused', result = why, updated_at = now() where id = a.id;
    if a.kind = 'followup' then update public.career_outreach_threads set followup_state = 'off', updated_at = now() where id = a.thread_id and followup_state in ('none', 'drafted'); end if;
    continue;
   end if;
   if a.kind = 'followup' and t.ooo_until is not null and t.ooo_until + interval '1 day' > p_now then continue; end if;
   exit when took >= lim;
   update public.career_outreach_actions set status = 'running', lease_owner = p_worker, lease_until = p_now + make_interval(secs => p_lease_seconds), updated_at = now()
    where id = a.id returning * into a;
   took := took + 1;
   return next a;
  end loop;
 end loop;
 -- Only a pass that went round everyone may start another: one cut short (rows other workers hold) never gives a person a second share.
 exit passes when took >= lim or took = took_before or not round_done;
 end loop;
end $$;
revoke all on function public.career_outreach_action_claim(text, int, int, timestamptz, int) from public, anon, authenticated;
grant execute on function public.career_outreach_action_claim(text, int, int, timestamptz, int) to service_role;

-- The worker's report. done: the effect happened (the thread moves on); retry: it did not happen and may (a provider's
-- rate limit or a mailbox not connected), back to approved; failed: it did not happen and will not be retried.
create or replace function public.career_outreach_action_finish(p_id uuid, p_worker text, p_outcome text, p_ref text, p_link text, p_result text, p_event jsonb default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.career_outreach_actions;
begin
 if p_outcome not in ('done', 'retry', 'failed') then raise exception 'invalid outcome'; end if;
 select * into a from public.career_outreach_actions where id = p_id and status = 'running' and lease_owner = p_worker for update;
 if not found then return false; end if;
 if p_outcome = 'done' then
  update public.career_outreach_actions set status = 'done', provider_ref = left(p_ref, 300), link = left(p_link, 500), result = left(coalesce(p_result, 'done'), 300),
   done_at = now(), lease_owner = null, lease_until = null, updated_at = now() where id = p_id;
  if a.kind = 'followup' then
   update public.career_outreach_threads t set followups_sent = t.followups_sent + 1, last_touch_at = now(),
    followup_state = case when t.followup_state = 'off' then 'off'
      when t.followups_sent + 1 >= coalesce((select cardinality(p.steps) from public.career_outreach_followup_prefs p where p.user_id = t.user_id), 0) then 'done' else 'none' end,
    updated_at = now() where t.id = a.thread_id;
  elsif a.kind = 'schedule_reply' then
   update public.career_outreach_threads set status = case when status = 'call_scheduled' then status else 'call_proposed' end, status_at = now(),
    offered = coalesce(a.payload->'slots', offered), updated_at = now() where id = a.thread_id;
  else
   update public.career_outreach_threads set status = 'call_scheduled', status_at = now(),
    event = coalesce(p_event, jsonb_build_object('ref', left(p_ref, 300), 'link', left(p_link, 500), 'start', a.payload->>'start', 'end', a.payload->>'end')), updated_at = now()
    where id = a.thread_id;
  end if;
 else
  update public.career_outreach_actions set status = case when p_outcome = 'retry' then 'approved' else 'failed' end, result = left(p_result, 300),
   lease_owner = null, lease_until = null, updated_at = now() where id = p_id;
  if p_outcome = 'failed' and a.kind = 'followup' then
   update public.career_outreach_threads set followup_state = 'off', updated_at = now() where id = a.thread_id and followup_state = 'drafted';
  end if;
 end if;
 return true;
end $$;
revoke all on function public.career_outreach_action_finish(uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.career_outreach_action_finish(uuid, text, text, text, text, text, jsonb) to service_role;

-- Threads that want a call and have no scheduling reply yet, any person, oldest ask first (p_limit per call).
create or replace function public.career_outreach_wanting_call(p_limit int)
returns setof public.career_outreach_threads language sql stable security definer set search_path = public, pg_temp as $$
 select t.* from public.career_outreach_threads t
 where t.status = 'wants_call'
   and not exists (select 1 from public.career_outreach_actions a where a.thread_id = t.id and a.kind = 'schedule_reply' and a.status in ('shown', 'approved', 'running', 'done'))
 order by t.status_at limit greatest(coalesce(p_limit, 1), 1)
$$;
revoke all on function public.career_outreach_wanting_call(int) from public, anon, authenticated;
grant execute on function public.career_outreach_wanting_call(int) to service_role;

-- The person declines waiting actions by number. A declined follow-up ends that thread's sequence.
create or replace function public.career_outreach_actions_cancel(p_user uuid, p_batch uuid, p_ns int[])
returns int[] language plpgsql security definer set search_path = public, pg_temp as $$
declare out int[];
begin
 with c as (update public.career_outreach_actions set status = 'cancelled', result = 'cancelled by you', updated_at = now()
   where user_id = p_user and batch_id = p_batch and n = any(p_ns) and status in ('shown', 'approved') returning n, thread_id, kind),
  t as (update public.career_outreach_threads x set followup_state = 'off', updated_at = now()
   from c where c.kind = 'followup' and x.id = c.thread_id and x.followup_state = 'drafted' returning x.id)
 select coalesce(array_agg(n order by n), '{}') into out from c;
 return out;
end $$;
revoke all on function public.career_outreach_actions_cancel(uuid, uuid, int[]) from public, anon, authenticated;
grant execute on function public.career_outreach_actions_cancel(uuid, uuid, int[]) to service_role;
