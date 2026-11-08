-- Reverses 20261108130500_career_contact_erase_keeps_sends.sql: career_erase_kept_tables() as
-- 20261026230100_career_erase_complete.sql defines it, without career_contact_sends, so "forget everything" empties the
-- contact connector's send log again (and with it the daily new-contact and two-follow-up limits for that person).
create or replace function public.career_erase_kept_tables() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['career_watch_kv','career_task_intents_v1','career_task_effects_v1','career_batch_intents_v1',
    'career_reminder_outbox','career_mail_cursors','career_mail_model_calls','career_apply_cloud_pauses',
    'channel_contacts','channel_link_nonces','channel_link_requests','career_apply_erased','career_outreach_dnc']
$$;
revoke all on function public.career_erase_kept_tables() from public, anon, authenticated;
grant execute on function public.career_erase_kept_tables() to service_role;
