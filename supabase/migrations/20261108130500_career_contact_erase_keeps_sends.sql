-- CONTACT OUTREACH (proposal D-043), S2 review of #590: "forget everything" (career_erase_person) must not reset the
-- contact connector's send limits. career_erase_person empties every career_* table with a user_id that
-- career_erase_kept_tables() does not name (20261026230100_career_erase_complete.sql), and career_contact_sends
-- (20261107120200) was not named: send 20 new people, forget everything, resume, and 20 more went the same day, with
-- every follow-up sequence restarted. The send log holds no name, address or fact, only the address's SHA-256, the step
-- (0 first email, 1-2 follow-ups) and the day, which the daily new-contact limit and the two-follow-up limit count; it
-- stays through an erase as career_outreach_dnc does, and goes with the account (on delete cascade). Its contact link
-- is cleared when the contact goes (on delete set null). Every existing entry is kept, in order. Idempotent.
-- Rollback: supabase/rollbacks/20261108130500_career_contact_erase_keeps_sends.down.sql.
create or replace function public.career_erase_kept_tables() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['career_watch_kv','career_task_intents_v1','career_task_effects_v1','career_batch_intents_v1',
    'career_reminder_outbox','career_mail_cursors','career_mail_model_calls','career_apply_cloud_pauses',
    'channel_contacts','channel_link_nonces','channel_link_requests','career_apply_erased','career_outreach_dnc',
    'career_contact_sends']
$$;
revoke all on function public.career_erase_kept_tables() from public, anon, authenticated;
grant execute on function public.career_erase_kept_tables() to service_role;
