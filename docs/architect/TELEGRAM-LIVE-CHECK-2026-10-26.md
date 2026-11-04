# Telegram end to end: what the owner runs, and how the outcome is proven (2026-10-26)

FEATURE 16. Proven in CI by `tests/architect/flow-telegram-e2e.test.ts` (real handler, real Postgres, fake Bot API, a
local copy of a captured Ashby form, the real engine). This page is for the owner's own run on the live bot.

## Which function the bot's webhook uses

- Live today: `telegram-inbound` (the test bridge, `_shared/telegram_bridge.ts`). It answers only the allow-listed test
  chat as `CHANNEL_TEST_USER_ID`, does not read files, and its buttons drive the old batch approval, not the apply card.
- Trunk deploys `trainee-telegram` (`trainee-telegram/handler.ts` -> `_shared/channel_inbound.ts` -> agent-chat
  `handleChat` through `chatThroughAgent`). FEATURE 16 completes this one. The deploy never repoints the webhook.

## Before the run (owner only)

1. Apply migration `20261026210016_career_resume_required.sql` (go-live lists it; mark: `career_resume_uploads` exists
   and the trigger `career_apply_jobs_resume_guard` exists).
2. Apply `20261026220016_channel_telegram_login.sql` too; deploy `agent-chat`, `trainee-telegram`, `trainee-deliver`
   (`--no-verify-jwt` for the last two) and `trainee-telegram-link` (JWT on). The launch is on hold: these are for when the owner lifts it.
3. Either set `TRAINEE_ALLOWED_CONTACTS` to include `telegram:<your chat id>` (the chat gets its own account), or use
   Telegram's login (step 6) to link the chat to your existing web account.
4. `setWebhook` to `https://<ref>.supabase.co/functions/v1/trainee-telegram` with the SAME `secret_token`, and
   `allowed_updates` `["message","callback_query","my_chat_member"]` (button taps arrive as `callback_query`).
   `getWebhookInfo` must show the new URL. Going back is the same call with `.../telegram-inbound`.
5. BotFather: `/setdomain` for the bot, set to the web domain that serves `/telegram-link` (the Trainee site). Telegram
   opens a `login_url` button only on that domain. Inline keyboards and documents need no setting.
6. Telegram's login (owner decision 2026-10-26): deploy `trainee-telegram-link` (go-live deploys it, JWT on); set
   `TELEGRAM_LOGIN_URL=https://<web domain>/telegram-link` on `trainee-telegram` and `TRAINEE_WEB_ORIGIN=https://<web domain>`
   on `trainee-telegram-link`. A chat that sign-up does not allow then gets a "Link your Trainee account" button instead of
   "invite-only"; "link my account" in the chat shows it again; "unlink telegram" lets the chat go. To link the bot to
   your existing web account, keep your chat id OUT of `TRAINEE_ALLOWED_CONTACTS` (otherwise the chat signs up its own
   channel-only account first; linking later moves the chat to your web account, and what that chat did before stays on
   the channel-only account).
7. The sender: the engine runs on your computer (`approve-first.ts` loop signed in as you) or the cloud runner; nothing
   is sent until it claims the approved row.

## The run

`/start`, send the resume PDF, "yes, that's my resume", "apply me to this: <link>", "what do you need from me" and the
numbered answers, "show my applications", tap Approve, wait for the sender, "did it go through?".

## The queries that prove it (replace `:chat` with your chat id)

```sql
-- 0. who you are on Telegram
select user_id, thread_id, last_inbound_at from channel_contacts where contact = 'tg:' || :chat;

-- 1. the resume file you sent: its reference, size and sha256 (compare with `shasum -a 256 resume.pdf`)
select provider_ref, filename, mime, bytes, sha256, message_sha256, created_at
from career_resume_uploads where user_id = :user order by created_at desc;

-- 2. your yes: one fact_confirmed event per entry, each naming that file
select count(*), bool_and(detail->'upload'->>'kind' = 'file'),
       bool_and(detail->'upload'->>'sha256' = (select sha256 from career_resume_uploads where user_id = :user order by created_at desc limit 1))
from career_events where user_id = :user and kind = 'fact_confirmed' and at > now() - interval '1 day';
select public.career_resume_on_file(:user);   -- must be true

-- 3. the queued posting
select posting_key, state, queued_at from career_apply_wanted where user_id = :user order by queued_at desc;

-- 4. the prepared application and the card you were shown (the card's hash must equal the prepared hash)
select id, company, payload_hash, payload->>'resume_sha256' as resume_sha256, state from career_apply_prepared where user_id = :user order by created_at desc;
select id, state, shown_at, answered_at, items, answer from career_apply_cards where user_id = :user order by shown_at desc;

-- 5. your tap: exactly one row, bound to the hash the card showed, with the resume bound
select id, state, company, payload_hash, approval_hash, payload_hash = approval_hash as bound,
       public.career_apply_payload_hash(payload) = payload_hash as intact, payload->>'resume_sha256' as resume_sha256,
       source, attempts, confirmation_id, reason, created_at, updated_at
from career_apply_jobs where user_id = :user order by created_at desc;
-- exactly one job per job_id (duplicates would show here)
select job_id, count(*) from career_apply_jobs where user_id = :user group by job_id having count(*) > 1;

-- 6. what was sent and its proof (FEATURE 14 receipt)
select * from career_apply_receipts where user_id = :user;

-- 7. every message Trainee sent you, delivered to your chat, with Telegram's message ids
select key, kind, status, contact, provider_id, provider_ids, card_id, error, created_at, delivered_at
from career_outbox where user_id = :user and created_at > now() - interval '1 day' order by id;
-- nothing stuck or failed
select status, count(*) from career_outbox where user_id = :user and created_at > now() - interval '1 day' group by status;

-- 7b. Telegram's login: each sign-in used once, and the chat's owner
select telegram_id, user_id, auth_date, used_at, outcome from channel_telegram_logins where user_id = :user order by used_at;

-- 8. the inbound updates handled (each Telegram update_id once)
select provider_message_id, received_at from channel_inbound where provider = 'telegram' and received_at > now() - interval '1 day' order by received_at;
```

What must hold: (1) the sha256 equals your file's; (2) the count equals the entries shown and every event names the
file; (5) one row, `bound` and `intact` true, `resume_sha256` set, and its final state is what the employer's page
showed (`submitted_unconfirmed` with the page's confirmation id, or `confirmed` only from the employer's email); (7)
every row `delivered` to `tg:<chat>` with a provider id, the card row carrying `card_id`, a `receipt:<job id>` row after
the finish; and the "did it go through?" reply states exactly the state in (5).
