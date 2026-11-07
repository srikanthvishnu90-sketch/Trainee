# WO-038: WhatsApp and Telegram work the way iMessage does

Status: built on `wo/038-channels`, not merged · Depends on: WO-013, PR #50 (channel integrity) · Decisions: D-019, D-020,
D-023 (proposed) · Assignee: Claude (builder) · Audit: the channel parity audit of 2026-10-20

## Why
Owner, verbatim: "whatsapp and telegram should work the exact same way as iMessage". Another person (Muse, D-020) sets up
the WhatsApp and Telegram accounts and tokens; this order is the code, so that once their secrets are set every Trainee
feature runs on all three channels. Before it, the texting path was LoopMessage end to end: the provider was hard-wired
in both entry points, a person was one phone number, the cap was LoopMessage's, and a WhatsApp or Telegram webhook body
was read as "no text" or "no sender" (audit, Part 1).

## What was built

### 1. A channel field end to end (`20261021070000_channel_parity.sql`, additive, idempotent)
- `channel_contacts` keeps its primary key `contact`, now a **contact key**: the phone or email for iMessage (unchanged,
  so every existing row and test stays as it was), `wa:<wa_id or business-scoped id>`, `tg:<chat id>`. New columns:
  `channel` and `address` (derived from the key by a trigger, so they cannot disagree), `phone` (iMessage's number,
  WhatsApp's `wa_id` when given, never Telegram), `alias` (WhatsApp's other id for the same sender), `home`,
  `last_inbound_at`, `nudged_at`. One contact **per channel** per person (the old one-contact constraint's name is kept
  on the new unique index, so its DB test still reads it). A person may have all three.
- **Home channel**: messages Trainee starts go to the contact the person set (`home`, `channel_set_home(channel)` for the
  app), else the one they wrote on last, else the first linked (`channel_target`). **Replies** go out on the channel the
  message came in on (`career_outbox.channel`, set by the inbound core; null means home at delivery time).
- **Dedupe per provider**: `channel_inbound` gains `provider`; its primary key is `(provider, provider_message_id)`:
  Telegram `update_id`, WhatsApp `messages[].id`, LoopMessage `message_id`. Reply keys of the new providers are namespaced
  (`reply:tg:<id>`, `reply:wa:<id>`) so ids never collide in one person's outbox; LoopMessage keeps `reply:<id>`.
- **One thread per person** on every channel (linking copies it; `setThread` writes it to all the person's contacts).
- **STOP is the person's**: a STOP on any channel holds what Trainee starts on every channel (`channel_opted_out`), and
  START on any channel turns all back on (`channel_set_opt_out`). The STOP reply promises exactly that. A contact with no
  account keeps its own STOP.
- Outbox: `held` status, `provider_ids` (every message id a row went out as), `part_of`/`part` (multi-part replies),
  kinds and keys keep every earlier one (`status`, `followup` from mail tracking, `mock` from PR #52) and add `link`.
- The three claims keep their signatures; the contact they return is the row's target.

### 2. Adapters behind one interface (`_shared/channel_adapters.ts`)
`ChannelAdapter { channel, provider, limits, capabilities, parseInbound(req) -> {messages, statuses} | {response},
render(text) -> string[], send(address, bubbles), sendTemplate?(address, count) }`. Registry from secrets:
`_shared/channel_registry.ts`.

| | iMessage (LoopMessage) | Telegram (Bot API) | WhatsApp (Cloud API, direct) |
|---|---|---|---|
| file | `loopmessage_adapter.ts` (wraps `loopmessage.ts`, unchanged; its tests unedited and passing) | `telegram.ts` | `whatsapp.ts` |
| webhook | `trainee-inbound`, `?secret=` / `x-trainee-secret` | `trainee-telegram`, `X-Telegram-Bot-Api-Secret-Token` | `trainee-whatsapp`, GET `hub.challenge` with the verify token; POST `X-Hub-Signature-256` HMAC of the raw body with the app secret |
| per message | 700-character bubbles (`toBubbles`, unchanged) | 1,500 packed (rule), 4,096 hard limit | 1,500 packed (rule), 4,096 hard limit |
| send | `{contact, text}` per bubble, 250 ms apart | `sendMessage`, **no `parse_mode`**, `link_preview_options.is_disabled=false` | text with `preview_url: true`; `to` for a `wa_id`, `recipient` for a business-scoped id |
| pacing | 250 ms | 1 s per chat, ~30/s overall (injected clock) | 1 s per chat (order; pair limit UNKNOWN), 50/s overall |
| commands | STOP/START/HELP words | the same words, plus `/start`, `/stop`, `/help` | the same words |
| blocked | n/a | 403 "bot was blocked by the user" and `my_chat_member: kicked` = STOP | n/a |
| window | none | none | 24 h (closed 10 min early) |
| cap | LoopMessage contacts a day (300) | none | templates a day (`WHATSAPP_DAILY_TEMPLATES`, 250) |

Every API shape is cited next to its function. **None of the official pages loaded** (core.telegram.org and
developers.facebook.com: DNS failure / proxy 403, 2026-10-20), so each shape is labeled VERIFIED-S, SECONDARY or ASSUMED
there, from the audit and search excerpts. The smoke checks and the owner's first texts check them live.

### 3. WhatsApp's 24-hour window, honestly
- `last_inbound_at` per WhatsApp contact. Inside the window free text goes out as on iMessage.
- Outside it, any message Trainee starts (alert, report, receipt, card, mail status, follow-up) is **held** in the
  outbox, never sent, never dropped; the person gets one utility template per silence: "Trainee has [N] new update(s) for
  you. Reply to see them." (`docs/launch/whatsapp-templates.json`). Their next message puts the held rows back
  (`channel_inbound_seen`), and the WhatsApp webhook sends everything due for them oldest first, then the answer.
- No template name in env: the messages wait and nothing is sent.
- 131047 / 131049 on the send itself: the row is held, not failed. In a later "failed" status: the row goes back from
  delivered to held by its message id (`career_outbox_rehold`). Either way the next message flushes it, once.
- Alerts are once ever (`career_outbox` unique key); a held alert keeps its row and is delivered later (W5).
- A card is **not pushed** while the home channel is WhatsApp and its window is closed (23 h in SQL): a card waiting
  unseen while it is the thread's last word could take a "yes" meant for something else. It is pushed on the first run
  after the person writes.

### 4. Identity linking with no code in chat
- **Telegram**: "connect telegram" texted on a linked channel (or `channel_link_telegram_start()` for the app's button)
  returns `https://t.me/<bot>?start=<token>`, a bare link on its own line. Token: 32 base64url characters (about 180
  random bits from two `gen_random_uuid()`; pgcrypto is not assumed), single use, 10 minutes, bound to the account, stored
  only as SHA-256, at most three live per person. `/start <token>` binds that chat and burns it; a chat already linked to
  another account is never moved; a person's earlier Telegram chat is unlinked. The token travels inside the `/start`
  message: the person never reads or types it, but it is a bearer token in a chat message. **D-023, proposed.**
- **WhatsApp**: a first text creates an account keyed by the `wa_id` (or the business-scoped id), with sign-up closed by
  default and the allow-list as before. If the number matches a linked contact on another channel, nothing is merged: the
  linked channel gets "Someone texted Trainee on WhatsApp from your number. Reply yes to link it." (a `link` outbox row,
  so STOP holds it and caps count it), the WhatsApp sender is told to reply yes there, and only a whole-message yes within
  the hour links it. The same holds the other way (WhatsApp first, then iMessage).
- Nothing binds from message text alone: a made-up token, a typed number, a bare `/start` (L2).

### 5. Multi-part replies (coordinator, 2026-10-20)
agent-chat may answer `{ reply, parts: string[] }`, each part at most 4,000 characters. The inbound core enqueues each as
its own row `reply:<id>:<n>` (`part_of`, `part`), never cut: a part over 4,000 is split on purpose; more than 30 parts
join into the 30th and say so with the cut note. Order: a part is not claimed while an earlier part of the same reply
waits for a retry, the window or another run (SQL), and within a run a person's later replies wait once one stalls
(`deliverDue`). Each part gets its channel's packing; one deliverer per request shares Telegram's pacing across parts.
WO-033 wires its outreach batch to `parts`.

### 6. Deploy wiring (nothing deployed)
- **Two functions, `trainee-telegram` and `trainee-whatsapp`**, not one `trainee-inbound?provider=`: each platform has its
  own door (Meta's GET challenge and HMAC over the raw body; Telegram's secret header; LoopMessage's `?secret=`), a missing
  secret then takes down only that channel, logs stay apart, and `trainee-inbound` stays byte-for-byte LoopMessage's door
  with its tests unedited. Shared logic is one core (`_shared/channel_inbound.ts`).
- Secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, `WHATSAPP_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_TEMPLATE_UPDATES`,
  `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_DAILY_TEMPLATES` (optional `WHATSAPP_GRAPH_VERSION`). Optional inputs in
  `scripts/launch/trainee-go-live.sh`; a missing one leaves that channel `NOT_WIRED`; webhook secrets generated only when
  the channel is being wired and never in place of one already set (`TRAINEE_ROTATE_CHANNELS=1`).
- Smoke (`trainee-smoke.cjs`): each channel's door, and Telegram's `getWebhookInfo`, only when its secrets are given.
- `docs/launch/TRAINEE-GO-LIVE.md`: the exact owner steps for Telegram (BotFather, `setWebhook` with `secret_token`) and
  for Meta's Cloud API direct (business verification, app, WABA, phone number ID, app secret, permanent system-user token
  entered only at the prompt, webhook subscription to `messages`, the utility template submission).
- `trainee-deliver` picks each row's adapter and keeps each provider's cap; with none wired it answers `NOT_WIRED`.

The brain stays channel-blind (P3 asserts agent-chat gets only the person, the thread, the words and a turn key).
Since CHANNEL PARITY (2026-11-05) each webhook also names its own channel to agent-chat once, when it is composed (Telegram
already did; WhatsApp and iMessage were left on the web's formatting and connect-link channel), and agent-chat reads it only
where `tests/edge/channel-parity.test.ts` lists.
agent-chat is not touched.

## Where "exactly the same" is impossible, and what the code does instead
| Platform rule | Closest honest version |
|---|---|
| WhatsApp: free text only within 24 h of the person's last message (D-019) | one short utility template per silence; the full message waits and goes out whole on their reply (W1-W5). It costs Meta's per-template price and needs Meta's approval of the wording; Meta may re-categorize it as marketing (then 131049 limits; still nothing lost) |
| WhatsApp: separate messages' order is not guaranteed (ASSUMED) | one message a second to one person, each awaited |
| Telegram and WhatsApp: 4,096 characters a message vs iMessage's bubbles | the same text, packed at 1,500 (the texting rule) instead of 700 |
| Telegram: no phone number | link from an existing account by a one-time link (D-023), or sign-up by allow-list (`telegram:<chat id>`) |
| Telegram: a person must press Start | their first `/start` is their first text (sign-up gate; welcomed with HELP's words) |
| WhatsApp business-scoped ids (rollout 2026) | keyed by `wa_id` when given, the business-scoped id recorded as alias; a BSUID-only sender is keyed by it and answered via `recipient` (SECONDARY) |

## Tests (written with the code; architect suite runs them in the gate)
- `tests/architect/wo-038-channels.test.ts` (24): parity P1-P9 (first text refused/allowed, HELP/STOP/START, a chat turn,
  an approval card and its yes, report, alert, receipt, ask-once, a reply after STOP) through each real handler and
  adapter, the text compared across channels; W1-W5 (template then full text, no template, one per silence,
  131047/131049 on send and by status, once-ever alerts); D1 (dedupe per provider); T1 (Telegram pacing on an injected
  clock); T2 (request shapes); B1 (block = STOP); G1-G2 (doors, NOT_WIRED, per-provider caps); L1-L3 (Telegram link,
  text never binds, same number on WhatsApp); H1 (reply channel, home channel, STOP across channels); M1-M2 (a
  10-draft, ~9,000-character reply in parts arrives whole and in order everywhere; a failed part holds the rest).
- `tests/db/channel_parity.test.sql` (65 checks): derivation and shapes, one per channel, dedupe, targets, held rows and
  their release, rehold by id, STOP across channels, per-channel counts, link tokens, link questions, the card push and
  the window, part order, access, deletion. Wired into `tests/db/run.sh` (applied twice; run after the career ledger,
  which also replays the migration on top of every earlier one).
- `tests/career-channels-launch.test.cjs` (6): go-live inputs masked, deploys, migration last, NOT_WIRED when absent, bad
  shapes stop the run, the smoke's channel checks, the template the doc and the code agree on.

## Planted defects (each a one-line change, each caught, each reverted)
| # | Defect | Caught by |
|---|---|---|
| D1 | Telegram per-chat pacing 0 | WO-038/T1, M1 |
| D2 | WhatsApp window not checked | WO-038/W1, W2, W3, W5 |
| D3 | Telegram dedupe on `message_id` | WO-038/D1 |
| D4 | Telegram's first `/start` skips sign-up | WO-038/L2 |
| D5 | WhatsApp signature not checked | WO-038/G1 |
| D6 | 131047 treated as a failure | WO-038/W4 |
| D7 | reply not bound to its channel | WO-038/H1 |
| D8 | Telegram sent with `parse_mode: MarkdownV2` | WO-038/T2 |
| D9 | a Telegram block is not a STOP | WO-038/B1 |
| D10 | the brain is told the channel | WO-038/P3 |
| D11 | a link question answered by any message, not only yes | WO-038/L3 |
| D12 | the template sent on every run | WO-038/W3 |
| D13 | `parts` ignored (one reply, cut at 4,000) | WO-038/M1, M2 |
| D14 | a part over 4,000 cut instead of split | WO-038/M2 |
| D15 | a later reply overtakes a failed one in the same run | WO-038/M2 |
| S1 | (SQL) card pushed into a closed WhatsApp window | channel_parity.test.sql "the window is closed: no card" |
| S2 | (SQL) a link token works twice | channel_parity.test.sql "once only" |
| S3 | (SQL) a part claimed while an earlier part waits for its retry | channel_parity.test.sql "while part one waits for its retry, nothing after it goes" |

## Numbers
- VERIFIED: architect suite 245 passed, 0 failed (`deno test -A --no-check --ignore=tests/architect/pending tests/architect/`).
- VERIFIED: gate edge list 129 passed, 0 failed (the 25 files in `scripts/gate.sh` `edge_tests`).
- VERIFIED: DB suite "db tests passed", 1,182 ok lines, including every earlier channel and card-push test unedited
  (`tests/db/run.sh` as the tester user, Postgres 16).
- VERIFIED: `node --test tests/trainee-go-live.test.cjs tests/export-coverage.test.cjs tests/no-secrets.test.cjs
  tests/career-channels-launch.test.cjs`: 26 passed; staged suites (batch delegation, staged size, bundle
  reachability): 3 passed.
- VERIFIED: `deno check` of the seven entry points against local stubs of the two remote imports (the sandbox cannot
  fetch deno.land); CI checks them for real.
- NOT_RUN: anything against Telegram or Meta (no tokens here; no deploys by builders). ASSUMED: every platform shape
  labeled so in `telegram.ts` and `whatsapp.ts`.

## Not built, and why
- **The app's Connect Telegram button**: the RPC (`channel_link_telegram_start`) and `channel_set_home` exist; the button
  belongs to the Trainee web app (WO-012, drafting). The texted "connect telegram" works today.
- **Buttons** (Telegram inline keyboards, WhatsApp reply buttons for "yes"/"no" on a card), **documents**
  (`sendDocument`, WhatsApp document messages for a tailored resume) and **typing indicators**: capabilities are declared
  in each adapter; sending them needs a card-id-bound approval path (the "last word" rule must not be bypassed by a tap)
  and an outbox shape for documents. A follow-up order.
- **Async turns**: the webhook still runs the turn before answering (as LoopMessage does). Telegram and Meta retries of
  a slow turn are answered "duplicate" and run nothing; a queue and worker would answer at once.
- **WhatsApp opt-in record**: Meta asks for opt-in before business-initiated messages; Trainee only ever messages people
  who wrote first, but a dated opt-in record with copy naming the business is the owner's wording to decide.
- **A re-nudge** after a long silence: one template per silence, by design (cost, spam). Owner's call if wanted.
- **Supabase accounts with neither email nor phone** (Telegram sign-up, WhatsApp username-only senders): UNKNOWN whether
  `auth.admin.createUser` accepts one; if it refuses, the person is told once ("couldn't answer") and the run logs it.
  Linking from an existing account does not need it.
- **WhatsApp identity-change events** (`user_id_update`, SECONDARY) are not read.
- A link question and an open approval card can both wait for "yes"; the link takes a yes given within its hour (its
  question is the newer message). Noted for review.

## Demo the owner can run (no accounts needed)
`deno test -A --no-check tests/architect/wo-038-channels.test.ts` prints each flow on each channel; P1-P9 compare the
text a person reads on iMessage, WhatsApp and Telegram.
