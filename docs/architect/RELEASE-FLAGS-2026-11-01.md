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
| `CAREER_CRISIS_MODERATION` | the gateway's moderation screen on each turn (second crisis layer; code's `agent-chat/crisis.ts` is always on) | its reader, which lands with #354 (no code reads it at this SHA) |

## (b) Stays OFF

| Switch | Enables | Why off | Who turns it on |
|---|---|---|---|
| `UPMORE_SCRIPT_SUBMIT_LIVE` | the cloud sandbox presses Submit | real submit to employers | owner, at his first live application |
| `CAREER_AGENT_SUBMIT` (DB, `career_cloud_settings`) | the agent submits an approved application | real submit | owner, at his first live application |
| `CAREER_CLOUD_APPLY`, `CAREER_CLOUD_TEXT_CARDS`, `APPLY_VM`, `APPLY_VM_USER_IDS` (DB) | cloud and VM applying | real submit | owner |
| `CLOUD_RUNNER_ENABLED` | cloud runner dispatch (send) | real submit; needs `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `CLOUD_SANDBOX_SNAPSHOT_ID` | owner |
| `CLOUD_PREPARE_ENABLED` | cloud preparation | needs the same Vercel sandbox secrets | owner |
| `CAREER_BATCH_EXECUTOR` | batch asks handed to the worker's executor | drives employer boards; needs `batch-executor.cjs` running on a host | owner |
| `CAREER_EMAIL_SEND` | apply-by-email sends from the person's Gmail | sends as the person; needs `gmail.send`, not approved by Google | owner, after Google approves |
| `CAREER_OUTREACH_SEND` | scheduled outreach sends | sends as the person; `gmail.send` | owner, after Google approves |
| `CAREER_SEND_RAIL` | the Gmail sending rail | sends as the person; `gmail.send` | owner, after Google approves |
| `GOOGLE_APPROVED_EXTRA_SCOPES` | asks for `gmail.send` at consent | not approved by Google | owner, after Google approves |
| `CAREER_OUTREACH_REPLIES`, `CAREER_OUTREACH_REPLIES_MODEL` | reads replies on rail-sent outreach | depends on the send rail (off): nothing to read | with the send rail |
| `CAREER_BRAIN=agent` | the full agent brain | not measured; pinned off in code (`AGENT_BRAIN_RELEASED = false`) | owner, after it passes D-030 |
| `CAREER_REPLY_WRITER` | the model rewrites every final reply | not eval-safe: no measurement covers it (the S3 eval does not run the final-reply boundary) | after a measurement |
| `CAREER_KNOWLEDGE` | knowledge library and grounded web research in the brain | changes brain replies; the S3 eval passes no library, so it would go unmeasured | after the eval harness passes it |
| `CAREER_JUDGE` | model-judged search ranking | changes search replies; unmeasured | after a measurement |
| `CAREER_MAIL_MODEL` | the model reads ambiguous mail | sends mail bodies to the model; the Google verification data-use statement (#196) must name it first | owner |
| `CAREER_PEOPLE_SEARCH` | model web search for people | D-033: Trainee does no web search for people | owner |
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
