-- Reverses 20261107120200_career_contact_outreach.sql: the contact outreach tables and functions go, with every row in them
-- (contacts, facts, email evidence, the connector's send log and its global suppression list). The sending rail's own
-- opt-outs (career_outreach_dnc) and bounced addresses (career_send_bad_addresses) are not touched, so a stop still holds.
drop function if exists public.career_contact_record_send(jsonb);
drop function if exists public.career_contact_suppress(jsonb);
drop function if exists public.career_contact_suppressed(jsonb);
drop function if exists public.career_contact_purge_expired(jsonb);
drop function if exists public.career_contact_forget(jsonb);
drop function if exists public.career_contact_get(jsonb);
drop function if exists public.career_contact_save(jsonb);
drop table if exists public.career_contact_sends;
drop table if exists public.career_contact_suppression;
drop table if exists public.career_contact_email_evidence;
drop table if exists public.career_contact_facts;
drop table if exists public.career_contact_profiles;
