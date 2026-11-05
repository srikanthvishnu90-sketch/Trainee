-- Reverses 20261105160000_channel_delivery_r4.sql: an opted-out contact leaving a person no longer carries its STOP to the
-- person's other contacts (as before). STOPs already carried stay recorded on those contacts (a START clears them).
drop trigger if exists channel_contacts_keep_stop on public.channel_contacts;
drop function if exists public.channel_contacts_keep_stop();
