-- trainee-file sign-in (owner, 2026-10-29): a link says WHICH list, never WHO opened it. A link opens a phone sign-in; a
-- session starts only after a code texted to the account's own confirmed phone proves that same account (or Telegram's signed
-- Mini App data proves the linked Telegram identity). Sessions live here, server side: the browser holds a random id, this
-- table holds only its SHA-256; each is revocable alone or all at once, and the page checks it against the account again on
-- every request (supabase/functions/_shared/file_session.ts). Additive and idempotent; service role only.
create table if not exists public.trainee_file_sessions (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  via text not null check (via in ('phone', 'telegram')),
  phone text check (phone is null or phone ~ '^\+[0-9]{8,15}$'),
  telegram_id text check (telegram_id is null or telegram_id ~ '^[1-9][0-9]{0,19}$'),
  list text not null check (list ~ '^[0-9a-f]{10}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint trainee_file_sessions_bound check ((via = 'phone' and phone is not null and telegram_id is null) or (via = 'telegram' and telegram_id is not null and phone is null)),
  constraint trainee_file_sessions_span check (expires_at > created_at and expires_at <= created_at + interval '1 day')
);
create index if not exists trainee_file_sessions_user on public.trainee_file_sessions (user_id) where revoked_at is null;

-- One row per link (its token id): the number typed, whether it is the account's, texts sent, codes tried, and when the link
-- was used up. A link is used once: done_at is set once.
create table if not exists public.trainee_file_logins (
  jti text primary key check (jti ~ '^[0-9a-f]{16}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  list text not null check (list ~ '^[0-9a-f]{10}$'),
  phone text check (phone is null or phone ~ '^\+[0-9]{8,15}$'),
  matched boolean not null default false,
  sends int not null default 0 check (sends between 0 and 100),
  tries int not null default 0 check (tries between 0 and 100),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  done_at timestamptz
);
create index if not exists trainee_file_logins_user on public.trainee_file_logins (user_id);

alter table public.trainee_file_sessions enable row level security;
alter table public.trainee_file_logins enable row level security;
revoke all on public.trainee_file_sessions, public.trainee_file_logins from anon, authenticated;

-- Begin (or read back) the sign-in for a link. A second open of the same link returns the same row, never a fresh one.
create or replace function public.trainee_file_login_begin(p_jti text, p_user uuid, p_list text, p_at timestamptz, p_expires timestamptz)
returns setof public.trainee_file_logins language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.trainee_file_logins (jti, user_id, list, created_at, expires_at)
  values (p_jti, p_user, p_list, p_at, p_expires) on conflict (jti) do nothing;
  return query select * from public.trainee_file_logins where jti = p_jti;
end $$;

-- Count a text or a code try, atomically under the cap; false (and nothing changed) once the cap is reached or the link is used.
create or replace function public.trainee_file_login_count(p_jti text, p_what text, p_max int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_what = 'send' then
    update public.trainee_file_logins set sends = sends + 1 where jti = p_jti and done_at is null and sends < p_max returning sends into n;
  elsif p_what = 'try' then
    update public.trainee_file_logins set tries = tries + 1 where jti = p_jti and done_at is null and tries < p_max returning tries into n;
  else
    raise exception 'trainee_file_login_count: unknown count %', p_what;
  end if;
  return n is not null;
end $$;

-- Use the link up: true only the first time.
create or replace function public.trainee_file_login_finish(p_jti text, p_at timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare j text;
begin
  update public.trainee_file_logins set done_at = p_at where jti = p_jti and done_at is null returning jti into j;
  return j is not null;
end $$;

-- Sign out everywhere: every open session of the account ends now. Returns how many ended.
create or replace function public.trainee_file_sessions_revoke_all(p_user uuid, p_at timestamptz default now())
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.trainee_file_sessions set revoked_at = p_at where user_id = p_user and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.trainee_file_login_begin(text, uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.trainee_file_login_count(text, text, int) from public, anon, authenticated;
revoke all on function public.trainee_file_login_finish(text, timestamptz) from public, anon, authenticated;
revoke all on function public.trainee_file_sessions_revoke_all(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.trainee_file_login_begin(text, uuid, text, timestamptz, timestamptz) to service_role;
grant execute on function public.trainee_file_login_count(text, text, int) to service_role;
grant execute on function public.trainee_file_login_finish(text, timestamptz) to service_role;
grant execute on function public.trainee_file_sessions_revoke_all(uuid, timestamptz) to service_role;
grant select, insert, update on public.trainee_file_sessions, public.trainee_file_logins to service_role;
