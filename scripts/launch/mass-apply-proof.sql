-- READ-ONLY evidence snapshot for the mass-apply proof (docs/architect/mass-apply-proof-runbook.md sections C and D).
-- It writes nothing: one `begin read only` transaction, one SELECT, rolled back. It prints ONE line of JSON for
-- scripts/launch/mass-apply-proof-report.ts. Nothing here is run by the repo's gate or by an agent against production: the OWNER
-- (or a read path the owner grants) runs it. The receipt, receipt-file, cloud-event and cloud-settings tables are service-role
-- only, so the connection must be one the owner chose for this (a read-only role is enough; this file never writes).
--
-- Never selected, on purpose: payload / answers / resume bytes, the screenshots' bytes, mail evidence text, a full phone number.
-- Phone numbers come out as their last 4 digits; page text as its first 200 characters.
--
-- Run it at four moments of the Telegram script (docs/architect/mass-apply-proof-script.md), once per phase, each to its own file:
--   psql "$READ_ONLY_DB_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v me=<owner user id> -v phase=before-search \
--        -v since=2026-11-02T15:00:00Z -f scripts/launch/mass-apply-proof.sql > proof-before-search.json
--   phases: before-search | after-search | after-apply | final     (final is the one the verdict is read from)
--   :me     the owner's profiles.id (uuid)           :phase  a label, any of the four above
--   :since  the moment the owner sent the first message of the run (ISO 8601, UTC): "yes" batch counts and the S4 rows count from it
\set QUIET on
\pset format unaligned
\pset tuples_only on
\if :{?phase}
\else
  \set phase unlabelled
\endif
\if :{?since}
\else
  \set since 1970-01-01T00:00:00Z
\endif

begin read only;

select jsonb_build_object(
  'schema', 'mass-apply-proof/1',
  'phase', :'phase'::text,
  'taken_at', now(),
  'user_id', :'me'::uuid,
  'since', :'since'::timestamptz,

  -- S4 (runbook B2/C1): the search queued nothing. These two totals must not move between before-search and after-search.
  'counts', jsonb_build_object(
    'wanted', (select count(*) from public.career_apply_wanted where user_id = :'me'::uuid),
    'jobs', (select count(*) from public.career_apply_jobs where user_id = :'me'::uuid),
    'wanted_since', (select count(*) from public.career_apply_wanted where user_id = :'me'::uuid and queued_at >= :'since'::timestamptz),
    'jobs_since', (select count(*) from public.career_apply_jobs where user_id = :'me'::uuid and created_at >= :'since'::timestamptz)),
  -- what the search itself is allowed to write: only these keys (telegram_jobs.ts / role_results.ts)
  'kv', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'updated_at', updated_at) order by updated_at desc), '[]'::jsonb)
         from (select key, updated_at from public.career_watch_kv
               where user_id = :'me'::uuid and (key like 'tg:listmeta:%' or key like 'tg:list:%' or key like 'tg:job:%')
               order by updated_at desc limit 10) k),

  -- C0 preconditions
  'settings', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value) order by key), '[]'::jsonb) from public.career_cloud_settings),
  'optin', (select to_jsonb(o) from (select enabled, turned_on_at, turned_off_at from public.career_apply_cloud_optin where user_id = :'me'::uuid) o),
  'waivers', (select coalesce(jsonb_agg(jsonb_build_object('portal', portal, 'max_sends', max_sends, 'expires_at', expires_at, 'revoked_at', revoked_at,
                'left', public.career_apply_cloud_waiver_left(user_id, portal, now())) order by created_at desc), '[]'::jsonb)
              from public.career_apply_cloud_gate_waivers where user_id = :'me'::uuid),
  'pauses', (select coalesce(jsonb_agg(jsonb_build_object('scope', scope, 'portal', portal, 'reason', reason, 'until', until)), '[]'::jsonb)
             from public.career_apply_cloud_pauses where until > now() and (user_id is null or user_id = :'me'::uuid)),

  -- C2/C3 the Apply tap and preparation
  'wanted', (select coalesce(jsonb_agg(to_jsonb(w) order by w.queued_at desc), '[]'::jsonb)
             from (select posting_key, state, queued_at, taken_at from public.career_apply_wanted where user_id = :'me'::uuid order by queued_at desc limit 50) w),
  'prepare_requests', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
             from (select id, state, created_at, claimed_at, finished_at, outcome, card_id from public.career_apply_prepare_requests where user_id = :'me'::uuid order by created_at desc limit 10) r),
  -- C4 the employer's questions (the owner's answers are not selected)
  'questions', (select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc), '[]'::jsonb)
             from (select key, label, state, answered_at, created_at from public.career_apply_questions where user_id = :'me'::uuid order by created_at desc limit 20) q),
  -- C5 the prepared payload (hash only, never the payload)
  'prepared', (select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc), '[]'::jsonb)
             from (select id, job_id, company, state, payload_hash, left(payload_hash, 16) tag, payload->>'destination' destination, created_at
                   from public.career_apply_prepared where user_id = :'me'::uuid order by created_at desc limit 50) p),
  -- C6 the cards (a card is what one tap or one "yes" approves) and the "yes" batch counts
  'cards', (select coalesce(jsonb_agg(to_jsonb(c) order by c.shown_at desc), '[]'::jsonb)
             from (select id, state, shown_at, answered_at, jsonb_array_length(items) items_n from public.career_apply_cards where user_id = :'me'::uuid order by shown_at desc limit 20) c),
  'batch', jsonb_build_object(
    'cards_answered_since', (select coalesce(jsonb_agg(to_jsonb(c) order by c.answered_at), '[]'::jsonb)
             from (select id, jsonb_array_length(items) items_n, answered_at from public.career_apply_cards
                   where user_id = :'me'::uuid and state = 'answered' and answered_at >= :'since'::timestamptz) c),
    'jobs_since_by_state', (select coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
             from (select state, count(*) n from public.career_apply_jobs where user_id = :'me'::uuid and created_at >= :'since'::timestamptz group by state) s)),
  'text_claims', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
             from (select job_id, card_id, item_n, host, claimed_at from public.career_apply_cloud_text_claims where user_id = :'me'::uuid order by claimed_at desc limit 20) t),

  -- C6/C7 the applications themselves, with the evidence fields the proof rules read
  'jobs', (select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at desc), '[]'::jsonb)
             from (select id, job_id, company, url, state, source, attempts, reason,
                          payload_hash, approval_hash, (payload_hash = approval_hash) hashes_agree,
                          confirmation_id, email_confirmed_at, confirmation_mail_hash,
                          claimed_at, created_at, updated_at,
                          evidence->>'page_confirmation' page_confirmation,
                          evidence->'response'->>'status' http_status,
                          evidence->'response'->>'destination' destination,
                          evidence->'response'->>'final_url' final_url,
                          evidence->'screenshots'->'sha256' shot_sha256
                   from public.career_apply_jobs where user_id = :'me'::uuid order by created_at desc limit 50) j),
  'receipts', (select coalesce(jsonb_agg(to_jsonb(r) order by r.finished_at desc), '[]'::jsonb)
             from (select application_id, state, reached_employer, clicked_at, finished_at, confirmation_id, left(confirmation_text, 200) page_text
                   from public.career_apply_receipts where user_id = :'me'::uuid order by finished_at desc limit 50) r),
  'receipt_files', (select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
             from (select application_id, kind, sha256, bound from public.career_apply_receipt_files where user_id = :'me'::uuid) f),
  'cloud_events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.at desc), '[]'::jsonb)
             from (select job_id, outcome, error_kind, portal, at from public.career_apply_cloud_events where user_id = :'me'::uuid order by at desc limit 100) e),
  -- the outbox: the search's own reply rows (reply:tg:*) and the receipt text (receipt:<job id>)
  'outbox', (select coalesce(jsonb_agg(to_jsonb(o) order by o.id desc), '[]'::jsonb)
             from (select id, key, kind, status, right(contact, 4) contact_tail, (provider_id is not null) has_provider_id, delivered_at, left(text, 300) text
                   from public.career_outbox where user_id = :'me'::uuid and (key like 'reply:tg:%' or key like 'receipt:%') order by id desc limit 30) o),
  -- the employer's own email (kind received, not flagged); evidence text is not selected
  'mail_events', (select coalesce(jsonb_agg(to_jsonb(m) order by m.mail_at desc), '[]'::jsonb)
             from (select application_ref, kind, flagged, message_hash, mail_at from public.career_mail_events
                   where user_id = :'me'::uuid and application_ref like 'job:%' order by mail_at desc limit 50) m)
)::text;

rollback;
