# Release flags, 2026-11-01 (D-036)

Owner ruling, 2026-11-01 18:42 CT, in chat: "turn everything on that u believe is needed, to test everything end to end".
Built on D-035 (PR #371: production serves `CAREER_BRAIN=staged` from the committed release config).

**Mechanism.** `supabase/functions/agent-chat/release_config.ts` `RELEASE_FLAGS` lists the switches this commit serves ON
in production. Each reader goes through `releaseFlagOn` (`tests/architect/release-flags.test.ts` fails on a raw read).
The environment can only roll one back: `supabase secrets set <FLAG>=off` (any value but `on` rolls back; unset returns to
the release value). Everything else is read from the environment exactly as before; `RELEASE_NEVER_ON` lists the switches
the config may never turn on. The release config is reply code, and every module an ON flag switches on is listed in
`scripts/launch/reply-code.ts` `RELEASE_FLAG_PATHS`, so the deploy standard's S3 asks for a fresh measurement when a flag
or a flagged module changes, and prints both SHAs' release flags beside their brains. The Telegram acceptance suite (S4)
runs the real handler with every switch unset (production) and asserts the release config before its first step.

**What S3's eval does not reach.** `evals/career/run.ts` (on `ci/brain-eval`) runs the router and the brain, not the
handler, so the planner, texting-native delivery and the drafting features are not in its score; the planner is measured by
the task eval (`evals/career/tasks/run.ts`, real handler), delivery and the approval paths by the acceptance suite. Features
that would change reply words with nothing measuring them stay OFF (reply writer, knowledge library, search judge).

Columns: default before D-036 → served now; what it enables; what it needs; risk; class.
(a) = ON for end-to-end testing; (a′) = pending; (b) = stays OFF; (c) = unchanged default, not a release flag.

## (a) ON in the release config

| Switch | Before → now | Enables | Needs | Risk / why safe |
|---|---|---|---|---|
| `CAREER_BRAIN` | router → staged (D-035) | question/advice turns to the model; actions stay code's | `OPENAI_API_KEY` (present; without it the router answers) | S3-measured; rollback `CAREER_BRAIN=router` |
| `CAREER_TEXTING_NATIVE` | off → on | channel-native delivery: split like a person texts, links on their own line, typing indicator, "on it" interim | none | shapes and paces what is already sent; words unchanged |
| `CAREER_NETWORKING_DRAFT` | off → on | model drafts outreach under the fact-lock | model key | approved by the hash of the exact text; delivered by the person (copy or mailto); never sent by Trainee |
| `CAREER_TAILOR_REWRITE` | off → on | truthful bullet rewrite toward a posting | model key | each bullet audited against its one confirmed fact; failing bullets keep their words; the resume is approved as an exact payload |
| `CAREER_MOCK_JUDGE` | off → on | the model grades the person's own mock-interview answers | model key | feedback to the person only; no fact about them is written |
| `CAREER_MAIL_TRACKING` | off → on | application status from the person's Gmail | person's Google grant (`gmail.readonly`, in verification); migration in repo | read only; nothing sent; a person without Gmail connected is skipped |
| `CAREER_BRIEF_DIGEST` | off → on | interview briefs, interview drafts, weekly digest | `20261021050000_career_brief_digest.sql` (applied by go-live) | to the person only |
| `CAREER_OUTREACH_FOLLOWUPS` | on by go-live → on by config | follow-up reminders on mail the person sent | none (no Gmail) | to the person's own outbox only |
| `CAREER_INTRO_REMINDERS` | off → on | introduction reminders the person asked for, pushed at their date | `20261027020000_career_intro_reminder_push.sql` (applied by go-live) | only the reminder text, to a person with a texting channel; the introduction itself is never sent |

## (a′) Pending: OFF until the condition is met (`RELEASE_PENDING`), never reported as live

| Switch | Enables | Waits for |
|---|---|---|
| `CAREER_PLANNER` | compound asks ("find 5, tailor 2, apply, remind me Friday") planned into steps over existing code paths | the task eval (`brain-eval` suite=tasks), planner on against off, no worse; and #371's fix (a crisis message with two asks gets the 988 reply before the planner; planner reminders are delivered) |
| `CAREER_BATCH_EXECUTOR` | batch asks handed to the worker's executor | the executor deployed: nothing in production loads `workers/career-browser/batch-executor.cjs`, so a batch ask would commit an intent nobody runs (D-007, WO-106). The entry point now exists (`scripts/career/batch-executor-main.cjs`, 2026-11-04) but nothing in production runs it; until it does, a batch ask commits no intent and the reply says the batch was not started and names the ask that runs on the deployed path ("apply to the top N <role> in <city>", or a pick from a list). Owner's switch: see "Turning on the batch executor" below |
| `CAREER_CRISIS_MODERATION` | the gateway's moderation screen on each turn (second crisis layer; code's `agent-chat/crisis.ts` is always on) | its reader, which lands with #354 (no code reads it at this SHA) |

### Turning on the batch executor (owner only; MASS APPLY END TO END, 2026-11-04)

Nothing here is done by an agent. Every guard still decides each application: the exact card set hash on the approve
intent (`APPROVAL_SET_CHANGED` otherwise), 149's re-verify of each payload at click time, captchas handed to the person,
LinkedIn, Indeed and Handshake dropped from the pool and refused by 149, the database kill switches.
1. On the worker host (beside the board service), with its own environment: `CAREER_BATCH_EXECUTOR=on`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `UPMORE_CAREER_WORKER_URL`, `UPMORE_CAREER_WORKER_SECRET` (optional
   `BATCH_EXECUTOR_INTERVAL_MS`, default 15000; `0` drains once), then run `node scripts/career/batch-executor-main.cjs`
   as a service. Without `CAREER_BATCH_EXECUTOR=on` it exits having claimed nothing; a missing setting stops it at start.
2. In the same release commit, wire that service into a production entry point (a `workers/` service file or workflow) and
   move `CAREER_BATCH_EXECUTOR` from `RELEASE_PENDING` into `RELEASE_FLAGS` (`release_config.ts`).
   `tests/architect/d037-live-effects.test.ts` (D-037/1e) fails until both are true together, by design.
3. Release through `release/production` (D-034). Rollback: `supabase secrets set CAREER_BATCH_EXECUTOR=off` for agent-chat
   (no new intents; batch asks get the not-started reply again) and stop the service (SIGTERM: no new claims; an execute
   intent in flight finishes and is recorded, never re-driven).

## (a2) ON by D-037 (owner, 2026-11-01 20:04 CT: "turn these on: Real submissions … Sending email as the person … Reply rewriters")

Every guard is unchanged and still decides each item: the person's approval of the exact payload, the cloud gate and its
waiver, the opt-in and pauses, any per-person or per-site number the owner sets (Trainee has none of its own, D-MS-2),
captchas handed to the person, LinkedIn/Indeed/Handshake never opened. Each env flag rolls back with `=off`.

| Switch | Before → now | Enables | Needs | Fails closed how |
|---|---|---|---|---|
| `UPMORE_SCRIPT_SUBMIT_LIVE` | unset → `1` | the cloud sandbox presses Submit on an approved application | the cloud runner (below) | `=0`/`off` makes every sandbox a dry run |
| `CLOUD_RUNNER_ENABLED`, `CLOUD_PREPARE_ENABLED` | off → on | the cloud runner's send and preparation ticks | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `CLOUD_SANDBOX_SNAPSHOT_ID`, `CLOUD_BRIDGE_URL` (the owner's credentials) | 503 "needs setup: <secret> is not set"; no sandbox started |
| `CAREER_AGENT_SUBMIT` (DB) | off → on (go-live, missing rows only) | the agent finishes an approved application | `release-db-switches.sql` after `verify-claim-guards.sql` | row ≠ `on` stops every claim at once, and a plain go-live (or `--brain router`) never changes an existing row; only `--real-submit on\|off` overwrites |
| `CAREER_CLOUD_APPLY` (DB) | off → on (go-live) | cloud applying | same | same |
| `APPLY_VM` (DB) | off → on (go-live) | the VM worker | same, plus `APPLY_VM_USER_IDS` (nobody until the owner names people or `*`) | same |
| `CAREER_EMAIL_SEND` | off → on | an approved apply-by-email or follow-up email | the person's grant with gmail.send | no gmail.send on the grant: no token, nothing sent, the person told to reconnect |
| `CAREER_OUTREACH_SEND` | off → on | the scheduled send of approved outreach | same | same |
| `CAREER_SEND_RAIL` | off → on | the sending rail for every approved email | same | same; a changed message (to, subject or body) is refused against its approval hash |

**gmail.send, incrementally.** The normal connect asks only for the submitted scopes (openid, email, gmail.readonly) plus
whatever the owner lists in `GOOGLE_APPROVED_EXTRA_SCOPES` (several allowed; not a release flag), so a read-only connect never
shows Google's unverified-scope warning. When a person approves a send and their grant lacks gmail.send, the reply says
"To send this from your Gmail, allow sending: <link>": a connect link with reason `send` whose consent asks for gmail.send
with `include_granted_scopes=true`. **Google has not verified gmail.send: until it does, only Google test users can grant it.
The owner adds them in the Google Cloud console (APIs & Services → OAuth consent screen → Test users); that is his step.**

Mail leaves only from the person's own Google account (Gmail sets From; Trainee writes none), one recipient, no Cc or Bcc.
Nothing sends from Trainee's own identity and there is no switch that could. `verify-apply-schema.sql` reports
`switches at rest | f` once go-live has written the database switches: that is the released state, not a fault.

## (b) Stays OFF

| Switch | Enables | Why off | Who turns it on |
|---|---|---|---|
| `CAREER_OUTREACH_REPLIES`, `CAREER_OUTREACH_REPLIES_MODEL` | reads replies on rail-sent outreach (the model drafts answers) | not in the D-037 ruling; the owner's call now that the rail is on | owner |
| `CAREER_BRAIN=agent` | the full agent brain | not measured; pinned off in code (`AGENT_BRAIN_RELEASED = false`) | owner, after it passes D-030 |
| `CAREER_REPLY_WRITER` | the model rewrites every final reply | D-037 (3): on only after `evals/career/rewriters/run.ts` shows no lower pass rate and no added invented-fact failure; not run yet (brain-eval suite=rewriters, $5 cap, inside the owner's $20 eval budget) | the measurement |
| `CAREER_KNOWLEDGE` | knowledge library and grounded web research in the brain | D-037 (3): same rule; not measured yet | the measurement |
| `CAREER_JUDGE` | model-judged search ranking | D-037 (3): same rule; not measured yet | the measurement |
| `CAREER_MAIL_MODEL` | the model reads ambiguous mail | sends mail bodies to the model; the Google verification data-use statement (#196) must name it first | owner |
| `CAREER_PEOPLE_SEARCH` | model web search for people | D-033: Trainee does no web search for people; D-042 (proposed) would turn it on for the free-first contact connector | owner |
| `CAREER_CONTACT_OUTREACH` | the contact connector: public professional facts, a scored work address, a cited draft, sent from the person's Gmail after their yes (`_shared/career_contact_*.ts`) | D-042 is a proposal; read only together with `CAREER_PEOPLE_SEARCH`; migration 20261107120200's tables are empty and unread while it is off | owner (accept D-042, apply the migration, set the postal address) |
| `CAREER_PEOPLE_SWEEP` | scheduled Gmail people sweeps | the chat never arms a sweep (handler passes no `sweepPush`): half-wired | after the chat side is wired |
| `CAREER_PDL` | hired-candidate aggregates from People Data Labs | licensed people source (D-018a); needs `PDL_API_KEY` (paid) | owner |
| `CAREER_VOICE` | voice practice calls | voice minutes cost far more than text; no per-minute ceiling set | owner (spend) |
| `CAREER_PREPARE_AHEAD`, `CAREER_PREPARE_AHEAD_COVER` | the worker prepares applications ahead | runs on the worker host; needs `CAREER_PREPARE_AHEAD_URL`, `CAREER_PREPARE_AHEAD_TOKEN` | owner (host) |
| `CAREER_RESEARCH_REPLY`, `CAREER_RESEARCH_BRIEF` | research answer layout | no deployed caller (research_reply.ts is not on the reply path) | when wired |
| `TRAINEE_LOGO_GUESS` | logo guessed from a company name | can show another company's logo | — |
| `CHANNEL_UNKNOWN_REPLY` | a "not authorized" text to unknown senders | messages strangers; no gain for signed-up testers | owner |
| `TRAINEE_SIGNUP` | open sign-up (default `closed`, allowlist `TRAINEE_ALLOWED_CONTACTS`) | who may use the product is the owner's call | owner |
| `WHATSAPP_TEMPLATE_UPDATES` | WhatsApp template messages outside 24 h | needs a Meta-approved template name | owner |
| `UPMORE_LEGACY_GMAIL_CONNECT` | the legacy finance Gmail connect | legacy product | — |
| LinkedIn / Indeed | (no switch) | never automated (CLAUDE.md) | never |

## (c) Unchanged, not release flags

| Switch | Default | Note |
|---|---|---|
| `CAREER_APPLY_HERE`, `CAREER_APPLY_LINK` | on (`off` disables) | already on |
| `CAREER_ACCOUNT_MEMORY` | auto (on for texting-linked people) | `off` is its kill switch |
| `CAREER_BRAIN_ROUTER_INTENTS`, `CAREER_PLANNER_USERS` | unset | per-class and per-person limits, still honored |
| `CHANNEL_APPROVAL_TTL_MIN`, `CAREER_MODEL*`, `CAREER_MODEL_DAILY_*`, `INGEST_*`, `LOOPMESSAGE_DAILY_CONTACTS`, `WHATSAPP_DAILY_TEMPLATES`, `CAREER_SEND_BOUNCE_*`, `CAREER_PEOPLE_CACHE_DAYS`, `CLOUD_MAX_*`, `CLOUD_PREPARE_*` limits | tuning values | not switches |
| Secrets (`OPENAI_API_KEY`, `TELEGRAM_*`, `LOOPMESSAGE_*`, `WHATSAPP_*`, `GOOGLE_OAUTH_*`, `STRIPE_*`, `HUNTER_API_KEY`, ...) | per `scripts/launch/secrets-audit.sh` | their presence wires a feature (S5); none is set by this change |

Not in the deployed code at this SHA (so nothing to switch here): an outreach personalization default and the results
page (crisis replies by code, `agent-chat/crisis.ts`, are always on; the gateway screen is `CAREER_CRISIS_MODERATION`); the
typing indicator and interim message are part of `CAREER_TEXTING_NATIVE`.
