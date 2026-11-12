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
that would change reply words with nothing measuring them stay OFF (reply writer, search judge); the knowledge library and web research are ON by the owner's D-060.

**Model and caps (D-046, owner, 2026-11-09).** Every model call that produces Trainee's output or decides what it does uses
`claude-sonnet-5-5` (`_shared/model_gateway.ts` `TRAINEE_MODEL`; `agent-chat/release_model.ts` `CAREER_MODEL_DEFAULT`, whose
`ROLLBACK_MODELS` is Sonnet 5.5 alone; `_shared/career_reader_model.ts`). `CAREER_REPLY_MODEL`, `CAREER_MODEL`,
`MODEL_PROVIDER` and `ANTHROPIC_MODEL` naming anything else are ignored with one log line; nothing falls back to Haiku. There
is no per-person AI cap: `CAREER_MODEL_DAILY_USD` and `CAREER_MODEL_DAILY_CALLS` are ignored (one log line if set). What
stays: the global $70 model budget (D-038a: a reservation before every call, the hard stop, `MODEL_BUDGET_PAUSED`) and the
safety limits on external actions (200 applications a day, D-R9-1; the per-employer pace; 20 new contacts a day and 2
follow-ups, D-043). Tested by `tests/architect/d046-sonnet-only-no-person-cap.test.ts`.

Columns: default before D-036 → served now; what it enables; what it needs; risk; class.
(a) = ON for end-to-end testing; (a′) = pending; (b) = stays OFF; (c) = unchanged default, not a release flag.

## (a) ON in the release config

| Switch | Before → now | Enables | Needs | Risk / why safe |
|---|---|---|---|---|
| `CAREER_BRAIN` | router → staged (D-035) | question/advice turns to the model; actions stay code's | `OPENAI_API_KEY` (present; without it the router answers) | S3-measured; rollback `CAREER_BRAIN=router` |
| `CAREER_TEXTING_NATIVE` | off → on | channel-native delivery: split like a person texts, links on their own line, typing indicator, "on it" interim | none | shapes and paces what is already sent; words unchanged |
| `CAREER_FILE_CARD` | off → on (D-049, architect ruling 2026-11-09; architect amendment of `tests/architect/release-flags.test.ts`) | the chat File card of spec C.2 (`_shared/file_card.ts`): a message that is exactly one File link goes as one card (caps kicker, title, freshness line with real counts, up to 3 chips, one button, "Opens your private File - nothing is submitted from chat") and a follow-up naming the decision; Telegram carries the link as the one inline button, WhatsApp and iMessage as the plain last line, the web chat gets the card as data; rollback `CAREER_FILE_CARD=off` (the link alone, as before) | `TRAINEE_FILE_BASE_URL`, `TRAINEE_FILE_LINK_SECRET` (no link, no card) | shapes what is already sent; counts read from the File's own record, never from taps |
| `CAREER_KNOWLEDGE` | off → on (D-060, owner 2026-11-11, in chat: "Web research"; architect amendment of `tests/architect/release-flags.test.ts`) | the knowledge layer (context pack and playbooks in the brain's prompt) and web research: Claude's web search (`_shared/model_gateway.ts` `webSearch`, proven live in `evals/research-live/`, `WEB_SEARCH_AVAILABLE`) feeds `research_market`, `research_company` and `research_career_question` through `_shared/research_web.ts`, official sources first, anecdotes and self-reported figures labelled, one topic per message with its link on its own line, and the posting re-check on the boards Trainee reads | `ANTHROPIC_API_KEY` | market and company research: one web search call a turn, at most 2 searches (about $0.044 each, measured), cached 24 hours; open questions: `ground.ts`'s caps (4 searches, $0.25 an answer, 14-day cache); reserved at the $70 ledger before it is sent; facts only from quoted passages and pages the reader opened (D-007); rollback `CAREER_KNOWLEDGE=off` (free sources alone, no playbooks). People search, Workday reading and Gmail/tracker stay off |
| `CAREER_PEOPLE_SEARCH` | off → on (D-062, owner 2026-11-11, in chat: "find alumni, do all of it"; accepts D-043; architect amendment of `tests/architect/release-flags.test.ts`) | public people search from web search results (`_shared/career_alumni_search.ts`, the brain's `find_people`): one Claude web search call a turn (at most 2 searches, cached 24 hours), LinkedIn, Indeed, Handshake and the never-list blocked in the search, no page fetched; a lead stands only on its own page's quoted words, each "not verified; current employment needs confirming"; nobody contacted. Also the contact connector's resolution and search (`_shared/career_contact_*.ts`) | model key (the gateway's web search, D-060) | rollback `CAREER_PEOPLE_SEARCH=off`; the older background people provider stays dark (`PEOPLE_WEB_SEARCH_WIRED = false`) |
| `CAREER_CONTACT_OUTREACH` | off → on (D-062, accepts D-043/D-048) | the contact connector: public professional facts, a scored work address, a cited draft, sent from the person's own Gmail or Outlook on the send rail only after their yes to that exact card (`_shared/career_contact_*.ts`, `career_contact_turn.ts`) | `CAREER_SENDER_POSTAL_ADDRESS` (owner-set); D-048's test mode is the owner's `CAREER_CONTACT_TEST_RECIPIENTS` | rollback `CAREER_CONTACT_OUTREACH=off`; every send stays a yes to the exact hash (D-MN-2) |
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
| `CAREER_JUDGE` | model-judged search ranking | D-037 (3): same rule; not measured yet | the measurement |
| `CAREER_MAIL_MODEL` | the model reads ambiguous mail | sends mail bodies to the model; the Google verification data-use statement (#196) must name it first | owner |
| `CAREER_PEOPLE_SWEEP` | scheduled Gmail people sweeps | the chat never arms a sweep (handler passes no `sweepPush`): half-wired | after the chat side is wired |
| `CAREER_PDL` | hired-candidate aggregates from People Data Labs | licensed people source (D-018a); needs `PDL_API_KEY` (paid) | owner |
| `CAREER_VOICE` | voice practice calls | voice minutes cost far more than text; no per-minute ceiling set | owner (spend) |
| `CAREER_PREPARE_AHEAD`, `CAREER_PREPARE_AHEAD_COVER` | the worker prepares applications ahead | runs on the worker host; needs `CAREER_PREPARE_AHEAD_URL`, `CAREER_PREPARE_AHEAD_TOKEN` | owner (host) |
| `CAREER_RESEARCH_REPLY`, `CAREER_RESEARCH_BRIEF` | market and company research on the reply path (R9-C; R10 WO-H): the staged brain takes research asks and has `research_market` and `research_company` (free first-party sources, every point cited to a page fetched this turn, through the facts guard); `CAREER_RESEARCH_BRIEF` adds the research brief File | `CAREER_RESEARCH_REPLY`: **on since D-047** (architect ruling 2026-11-09 on the owner's order that research work in production; verified by the post-deploy production replay, WO-I; rollback `CAREER_RESEARCH_REPLY=off`). `CAREER_RESEARCH_BRIEF`: **on since D-047 amended** (architect ruling 2026-11-09: the File ships with the reply; rubric 30/30; rollback `CAREER_RESEARCH_BRIEF=off`, then the answer is given in chat with its sources) | both: verified by the post-deploy production replay (WO-I) |
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
| `CAREER_MODEL`, `CAREER_REPLY_MODEL`, `CAREER_MODEL_DAILY_*` | ignored (D-046) | the model is always `claude-sonnet-5-5`; no per-person cap; one log line when set |
| `CHANNEL_APPROVAL_TTL_MIN`, `INGEST_*`, `LOOPMESSAGE_DAILY_CONTACTS`, `WHATSAPP_DAILY_TEMPLATES`, `CAREER_SEND_BOUNCE_*`, `CAREER_PEOPLE_CACHE_DAYS`, `CLOUD_MAX_*`, `CLOUD_PREPARE_*` limits | tuning values | not switches |
| Secrets (`OPENAI_API_KEY`, `TELEGRAM_*`, `LOOPMESSAGE_*`, `WHATSAPP_*`, `GOOGLE_OAUTH_*`, `STRIPE_*`, `HUNTER_API_KEY`, ...) | per `scripts/launch/secrets-audit.sh` | their presence wires a feature (S5); none is set by this change |

Not in the deployed code at this SHA (so nothing to switch here): an outreach personalization default and the results
page (crisis replies by code, `agent-chat/crisis.ts`, are always on; the gateway screen is `CAREER_CRISIS_MODERATION`); the
typing indicator and interim message are part of `CAREER_TEXTING_NATIVE`.
