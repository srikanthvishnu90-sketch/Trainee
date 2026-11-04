-- Launch readiness R1 (2026-10-26): two texts sent close together are both answered, in the order they arrived.
--
-- Each inbound text runs its own agent-chat turn. Two turns for one person read the same thread revision, and the second
-- to commit got revision_conflict from career_host_commit; chatThroughAgent threw on the 409, and the person read
-- "I couldn't answer that just now" for a message that was already claimed and never retried.
--
-- The fix: a conversation's turns run one at a time, in the order agent-chat received them. Each turn takes a ticket
-- (career_turn_gate_enter) before it reads the thread, waits until no earlier live ticket of the same person and thread remains
-- (career_turn_gate_ready), and gives its ticket back after it commits (career_turn_gate_leave). A ticket lapses after
-- its lease (a crashed turn never blocks the next one for longer than that). Service role only: agent-chat calls these
-- with its own key for every turn, the person's app never does.
-- Limits, stated: a ticket's lease is 90 s and a turn waits at most 60 s behind an earlier one. A turn that runs longer than
-- its lease (a very slow model call) stops holding the line; the next turn then goes ahead on the same thread revision, and
-- if the earlier one commits first, career_host_commit refuses the later write (revision_conflict) and the channel retries
-- it once with a fresh read. Turns of different threads of one account are not ordered by this gate (the account version
-- check in career_host_commit orders them).
-- Idempotent. Tested by tests/db/career_turn_gate.test.sql and, end to end, tests/architect/launch-readiness-handler.test.ts.
create table if not exists public.career_turn_gate (
  ticket bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  turn_key text not null check (length(turn_key) between 1 and 128),
  thread_id text not null default '' check (length(thread_id) <= 128),
  entered_at timestamptz not null default now(),
  lease_until timestamptz not null
);
-- Tables created by an earlier draft of this file have no thread column.
alter table public.career_turn_gate add column if not exists thread_id text not null default '' check (length(thread_id) <= 128);
create index if not exists career_turn_gate_user_ticket on public.career_turn_gate (user_id, ticket);
alter table public.career_turn_gate enable row level security;
revoke all on public.career_turn_gate from anon, authenticated;
grant all on public.career_turn_gate to service_role;
-- Supabase's default privileges hand new sequences to anon and authenticated; only the service role uses this one.
revoke all on sequence public.career_turn_gate_ticket_seq from public, anon, authenticated;
grant usage, select on sequence public.career_turn_gate_ticket_seq to service_role;

-- A ticket for this turn; lapsed tickets of the person are cleared on the way in. Turns of different threads of one account
-- do not wait for each other: a stale account commit across threads is refused by career_host_commit and retried by the channel.
drop function if exists public.career_turn_gate_enter(uuid, text, integer);
create or replace function public.career_turn_gate_enter(p_user uuid, p_turn_key text, p_lease_seconds integer default 90, p_thread text default '')
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare t bigint;
begin
  if p_user is null or p_turn_key is null or p_lease_seconds is null or p_lease_seconds not between 5 and 600 then
    raise exception 'invalid turn gate ticket';
  end if;
  -- Tickets of one person and thread are taken one at a time, and the number is drawn after the lock is held, so a later
  -- ticket number is always a later commit: a turn that enters second can never see itself first because the earlier
  -- turn's row had not committed yet (the enter-then-ready race).
  perform pg_advisory_xact_lock(hashtextextended('career_turn_gate:' || p_user::text || ':' || coalesce(p_thread, ''), 0));
  delete from career_turn_gate where user_id = p_user and lease_until < now();
  insert into career_turn_gate(user_id, turn_key, thread_id, lease_until) values (p_user, p_turn_key, coalesce(p_thread, ''), now() + make_interval(secs => p_lease_seconds))
  returning ticket into t;
  return t;
end $$;

-- True when this ticket is the oldest live one of its person and thread: the turns before it have committed, or lapsed.
create or replace function public.career_turn_gate_ready(p_user uuid, p_ticket bigint)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (select 1 from career_turn_gate g join career_turn_gate me on me.ticket = p_ticket and me.user_id = p_user
    where g.user_id = p_user and g.thread_id = me.thread_id and g.ticket < p_ticket and g.lease_until >= now())
$$;

create or replace function public.career_turn_gate_leave(p_user uuid, p_ticket bigint)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from career_turn_gate where user_id = p_user and ticket = p_ticket
$$;

revoke all on function public.career_turn_gate_enter(uuid, text, integer, text), public.career_turn_gate_ready(uuid, bigint),
  public.career_turn_gate_leave(uuid, bigint) from public, anon, authenticated;
grant execute on function public.career_turn_gate_enter(uuid, text, integer, text), public.career_turn_gate_ready(uuid, bigint),
  public.career_turn_gate_leave(uuid, bigint) to service_role;
