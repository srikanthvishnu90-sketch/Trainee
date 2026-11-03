-- A RESEND IS THE LATEST UPLOAD (architect, 2026-11-01; found by tests/architect/flow-scenarios-onboarding-r3.test.ts). NOT
-- APPLIED: the owner applies migrations.
--
-- The person's yes to the resume entries shown records the FILE that showed them (career_router_evidence.ts, then
-- channel_resume_upload.ts fileUploadFor): the upload whose text was the message that carried the entries. Two files
-- with the same text (a PDF and the .docx it was saved from) give the same message, so the chat now takes the newest
-- upload received no later than that message (an upload is stored before its message). A file sent AGAIN kept its first
-- created_at here (on conflict the row was left as it was), so after "A, then B, then A again" the yes to A's entries
-- (shown last) recorded B, a file the person was not shown last. A resend now stamps the upload as received now; nothing
-- else about the row changes (its bytes and sha256 are the same by the unique key).
-- Idempotent: create or replace only. Service role only, as before.

create or replace function public.career_resume_upload_record_as(p_user uuid, p_channel text, p_ref text, p_filename text, p_mime text,
 p_bytes integer, p_sha256 text, p_content_b64 text, p_message_sha256 text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare rid uuid;
begin
 if p_user is null then raise exception 'invalid resume upload'; end if;
 -- Review of #194 (folds in #206): a claimed fingerprint is not proof of a file. The decoded bytes must be the declared
 -- size and hash to the declared sha256, or nothing is stored.
 if p_content_b64 is null or p_sha256 is null or p_bytes is null
    or octet_length(decode(p_content_b64, 'base64')) <> p_bytes
    or encode(sha256(decode(p_content_b64, 'base64')), 'hex') <> p_sha256 then
  raise exception 'invalid resume upload: content does not match size and sha256';
 end if;
 insert into public.career_resume_uploads (user_id, channel, provider_ref, filename, mime, bytes, sha256, content_b64, message_sha256)
 values (p_user, p_channel, p_ref, p_filename, p_mime, p_bytes, p_sha256, p_content_b64, p_message_sha256)
 on conflict (user_id, sha256, message_sha256) do update set created_at = greatest(now(), public.career_resume_uploads.created_at),
  provider_ref = excluded.provider_ref, filename = excluded.filename, channel = excluded.channel
 returning id into rid;
 return rid;
end $$;
revoke all on function public.career_resume_upload_record_as(uuid, text, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.career_resume_upload_record_as(uuid, text, text, text, text, integer, text, text, text) to service_role;
