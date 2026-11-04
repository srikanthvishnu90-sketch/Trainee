-- REQS DOC 1 follow-up (2026-10-31): "forget everything" deletes the person's chat messages too.
--
-- The privacy policy (docs/launch/legal-pages/privacy.template.html) keeps the messages a person sends Trainee only until
-- they say "forget everything". The erase (career_host_commit's erase branch, then career_erase_on_epoch ->
-- career_erase_person, 20261026230100) emptied every career_/channel_ record, the outbox included, but kept the chat
-- itself: agent_messages in every thread of theirs, and each thread's title (its first 60 characters, chat_session.ts).
--
-- career_erase_messages(user): deletes every message in every thread the person owns (all channels write to the same
-- threads: the web app, Telegram, WhatsApp and iMessage all run agent-chat, whose commit writes agent_messages) and clears
-- the thread titles. Unsent outbox copies (career_outbox) are already deleted by career_erase_person in the same erase;
-- this adds nothing there. It runs from its own trigger on the same account write and condition as career_erase_on_epoch
-- (a real erase writes the account with a higher epoch AND paused). It runs before career_host_commit inserts the erase
-- turn's own two messages (the account write comes first in that function), so the person keeps the answer that says
-- what was erased, and nothing before it. Another person's threads are never touched: the delete is keyed by the
-- thread's owner.
-- Idempotent; service role only.

create or replace function public.career_erase_messages(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n_messages bigint; n_titles bigint;
begin
  if p_user is null then raise exception 'career erase: no person'; end if;
  delete from public.agent_messages m using public.agent_threads t where m.thread_id = t.id and t.user_id = p_user;
  get diagnostics n_messages = row_count;
  update public.agent_threads set title = null where user_id = p_user and title is not null;
  get diagnostics n_titles = row_count;
  return jsonb_build_object('agent_messages', n_messages, 'agent_threads_titles', n_titles);
end $$;
revoke all on function public.career_erase_messages(uuid) from public, anon, authenticated;
grant execute on function public.career_erase_messages(uuid) to service_role;

create or replace function public.career_erase_messages_on_epoch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.key = 'career:account' and new.value->'paused' = 'true'::jsonb and coalesce((new.value->>'epoch')::bigint, 0) >
     (case when tg_op = 'UPDATE' then coalesce((old.value->>'epoch')::bigint, 0) else 0 end) then
    perform public.career_erase_messages(new.user_id);
  end if;
  return new;
end $$;
revoke all on function public.career_erase_messages_on_epoch() from public, anon, authenticated;
drop trigger if exists career_erase_messages_on_epoch on public.career_watch_kv;
create trigger career_erase_messages_on_epoch after insert or update on public.career_watch_kv
  for each row when (new.key = 'career:account') execute function public.career_erase_messages_on_epoch();
