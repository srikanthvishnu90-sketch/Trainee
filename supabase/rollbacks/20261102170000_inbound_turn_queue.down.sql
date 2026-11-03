-- Reverses 20261102170000_inbound_turn_queue.sql. Turn CHAT_QUEUE off first (supabase secrets set CHAT_QUEUE=off) and let
-- trainee-turn-worker drain the queue: rows still queued here are texts the provider already got a 200 for.
-- select count(*) from public.inbound_turn_queue where status in ('queued','claimed');   -- must be 0
drop function if exists public.inbound_turn_purge(timestamptz, interval, interval);
drop function if exists public.inbound_turn_health(timestamptz, interval);
drop function if exists public.inbound_turn_finish(bigint, uuid, text, text, timestamptz, integer, boolean);
drop function if exists public.inbound_turn_step(bigint, uuid, text);
drop function if exists public.inbound_turn_untold(integer);
drop function if exists public.inbound_turn_told(bigint);
drop function if exists public.inbound_turn_claim(integer, integer, timestamptz, integer, integer);
drop function if exists public.inbound_turn_enqueue(text, text, text, jsonb);
drop table if exists public.inbound_turn_queue;
