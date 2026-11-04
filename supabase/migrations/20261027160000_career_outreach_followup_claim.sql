-- Networking follow-up reminders at scale (lane N2, 2026-10-27; owner: "operate these things at large scale", no
-- product volume limit). The reminders live per person in career_watch_kv key 'career:outreach:followups'
-- (value {items:[...]}, career_outreach_track.ts). Before this, the scheduled run read that key with `limit 500` and no
-- order or index, so past 500 people the same 500 rows came back every run and everyone else's reminders never fired.
--
--   value.next_due_at  the earliest unfired due time of the person's reminders (written by the app with every save;
--                      null when none is waiting), indexed, so a run reads only people with something due now.
--   value.lease_until  a claim's lease: claimed rows are skipped by other runs until it passes (an instance that died
--                      mid-batch frees its rows when the lease expires); FOR UPDATE SKIP LOCKED, so any number of
--                      instances claim disjoint batches in parallel with no global lock.
--   career_outreach_followups_claim(now, batch, lease_seconds)  up to `batch` people with a reminder due, oldest due
--                      first (fair: no one waits behind a heavy user), leased. `batch` is a tuning knob for one call's
--                      size, never a cap on the work: a run loops until a claim comes back empty.
-- Idempotent; touches only rows of that key.

create index if not exists career_watch_kv_followups_due
  on public.career_watch_kv (((value->>'next_due_at')::text))
  where key = 'career:outreach:followups' and value ? 'next_due_at' and value->>'next_due_at' is not null;

create or replace function public.career_outreach_followups_claim(p_now timestamptz, p_batch int, p_lease_seconds int)
returns table (user_id uuid, value jsonb)
language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select w.user_id
    from public.career_watch_kv w
    where w.key = 'career:outreach:followups'
      and w.value ? 'next_due_at' and w.value->>'next_due_at' is not null
      and (w.value->>'next_due_at')::text <= to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      and (w.value->>'lease_until' is null or (w.value->>'lease_until')::timestamptz <= p_now)
    order by (w.value->>'next_due_at')::text, w.user_id
    limit greatest(coalesce(p_batch, 0), 1)
    for update of w skip locked)
  update public.career_watch_kv w
     set value = jsonb_set(w.value, '{lease_until}', to_jsonb(p_now + make_interval(secs => greatest(coalesce(p_lease_seconds, 0), 1)))),
         updated_at = now()
    from due
   where w.user_id = due.user_id and w.key = 'career:outreach:followups'
  returning w.user_id, w.value;
$$;
revoke all on function public.career_outreach_followups_claim(timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.career_outreach_followups_claim(timestamptz, int, int) to service_role;

-- Rows saved before next_due_at existed: computed once here from their items (ISO strings compare in time order).
update public.career_watch_kv w
   set value = w.value || jsonb_build_object('next_due_at',
         (select min(i->>'due_at') from jsonb_array_elements(coalesce(w.value->'items', '[]'::jsonb)) i where i->>'fired_at' is null))
 where w.key = 'career:outreach:followups' and not (w.value ? 'next_due_at');
