-- FEATURE 16 (owner decision, 2026-10-26, in writing): a Telegram chat is linked to a Trainee account with Telegram's own
-- login (the "Link your Trainee account" login_url button), verified on the server (trainee-telegram-link,
-- _shared/telegram_login.ts: Telegram's hash over the signed fields, and auth_date at most 10 minutes old), never with a
-- code typed into the chat. This is the database's half:
--   - each signed payload is taken once (its hash is recorded): a replay is refused;
--   - one Telegram user is linked to exactly one account: one already linked to another account is refused, unless that
--     account is the channel-only one the chat signed up with (trainee-inbound/store.ts: tg-<id>@users.trainee.invalid,
--     no email, no password), which then hands the chat over; one account holds at most one Telegram user;
--   - unlinking: the person's Telegram contact keeps its STOP history but no longer belongs to them.
-- A Telegram user's id is the id of their private chat with the bot, so the contact is tg:<id>. Idempotent. NOT APPLIED:
-- the owner applies migrations.
create table if not exists public.channel_telegram_logins (
 hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
 telegram_id text not null check (telegram_id ~ '^[1-9][0-9]{0,19}$'),
 user_id uuid not null references auth.users(id) on delete cascade,
 auth_date timestamptz not null,
 used_at timestamptz not null,
 outcome text not null
);
alter table public.channel_telegram_logins enable row level security;
revoke all on public.channel_telegram_logins from public, anon, authenticated;

create or replace function public.channel_telegram_link_as(p_user uuid, p_telegram_id text, p_hash text, p_auth_date timestamptz, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := 'tg:' || p_telegram_id; other uuid; mine text; t uuid; moved uuid; v_outcome text;
begin
 if p_user is null or p_telegram_id !~ '^[1-9][0-9]{0,19}$' or p_hash !~ '^[a-f0-9]{64}$' or p_auth_date is null or p_now is null then
  return jsonb_build_object('error', 'missing'); end if;
 if p_auth_date < p_now - interval '10 minutes' then return jsonb_build_object('error', 'stale'); end if;
 if p_auth_date > p_now + interval '1 minute' then return jsonb_build_object('error', 'future'); end if;
 -- The replay refusal comes first, so a payload is used once whatever it led to.
 insert into public.channel_telegram_logins(hash, telegram_id, user_id, auth_date, used_at, outcome)
 values (p_hash, p_telegram_id, p_user, p_auth_date, p_now, 'pending') on conflict (hash) do nothing;
 if not found then return jsonb_build_object('error', 'replay'); end if;
 perform pg_advisory_xact_lock(hashtextextended(c, 7));
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 1));
 select user_id into other from public.channel_contacts where contact = c;
 select contact into mine from public.channel_contacts where user_id = p_user and channel = 'telegram' and contact <> c limit 1;
 if other = p_user then v_outcome := 'already';
 elsif mine is not null then v_outcome := 'account_has_other';
 elsif other is not null and not exists (select from auth.users u where u.id = other and u.email = 'tg-' || p_telegram_id || '@users.trainee.invalid') then
  v_outcome := 'linked_elsewhere';
 else
  moved := other;
  select thread_id into t from public.channel_contacts where user_id = p_user and thread_id is not null order by last_inbound_at desc nulls last limit 1;
  insert into public.channel_contacts(contact, user_id, thread_id, created_at, updated_at) values (c, p_user, t, p_now, p_now)
  on conflict (contact) do update set user_id = p_user, thread_id = t, home = false, updated_at = p_now;
  v_outcome := 'linked';
 end if;
 update public.channel_telegram_logins set outcome = v_outcome where hash = p_hash;
 if v_outcome in ('linked', 'already') then
  return jsonb_build_object('outcome', v_outcome, 'contact', c) || case when moved is not null then jsonb_build_object('moved_from', moved) else '{}'::jsonb end;
 end if;
 return jsonb_build_object('error', v_outcome);
end $$;
revoke all on function public.channel_telegram_link_as(uuid, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_telegram_link_as(uuid, text, text, timestamptz, timestamptz) to service_role;

-- Review of PR #194: an account that is only this chat (its channel-only sign-up, tg-<id>@users.trainee.invalid, no email
-- or password to sign in with elsewhere) is never unlinked from it: that would strand the account and the chat. -1 says so.
create or replace function public.channel_telegram_unlink_as(p_user uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
 if p_user is null then raise exception 'invalid unlink'; end if;
 if exists (select from auth.users u where u.id = p_user and u.email like 'tg-%@users.trainee.invalid') then return -1; end if;
 update public.channel_contacts set user_id = null, thread_id = null, home = false, updated_at = p_now where user_id = p_user and channel = 'telegram';
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function public.channel_telegram_unlink_as(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_telegram_unlink_as(uuid, timestamptz) to service_role;

-- Review of PR #194: a chat that once signed up on its own (its channel-only account exists) and was later linked to a
-- web account, then unlinked, comes back to its own account on its next message, instead of a second sign-up that Auth
-- refuses (the address is taken). Returns that account, or null when there is none.
create or replace function public.channel_telegram_reattach_as(p_contact text, p_now timestamptz) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; v_tg text := substr(p_contact, 4);
begin
 if p_contact !~ '^tg:[1-9][0-9]{0,19}$' then return null; end if;
 select a.id into u from auth.users a where a.email = 'tg-' || v_tg || '@users.trainee.invalid';
 if u is null then return null; end if;
 if exists (select from public.channel_contacts c where c.user_id = u and c.channel = 'telegram' and c.contact <> p_contact) then return null; end if;
 insert into public.channel_contacts(contact, user_id, created_at, updated_at) values (p_contact, u, p_now, p_now)
 on conflict (contact) do update set user_id = u, updated_at = p_now where public.channel_contacts.user_id is null or public.channel_contacts.user_id = u;
 return (select user_id from public.channel_contacts where contact = p_contact and user_id = u);
end $$;
revoke all on function public.channel_telegram_reattach_as(text, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_telegram_reattach_as(text, timestamptz) to service_role;
