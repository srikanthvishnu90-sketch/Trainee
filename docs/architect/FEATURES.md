# Trainee career agent: every feature, its depth, and its honest status (refreshed 2026-10-30 for trunk 33f7d00)

**This is the single current source of truth for what Trainee does and how deeply.** It replaces the capability
lists, matrices and requirement lists of earlier generations (see "Superseded" at the end). Owner order: know exactly
every feature and the depth at which it operates, because the product deals with external companies and must be accurate.

Owner: the architect. Changed only by the architect, in a commit that names its reason. Frozen archive files
(`docs/bug-ledger.md`, `docs/career/forbidden-rules.md`, `docs/instinct-spec-series/BUILD-STATUS.md`, merge records,
gauntlet ledgers) are not edited by this document or by its PR (D-006).

## 0. How to read this

**Evidence base.**
- Code: `trunk` at `c6fc2e193` (merge of PR #256). Every code path below was read on that commit.
- Live: Supabase project `mrwngntwmnaqrqhupvlt`, read-only, 2026-10-28 about 23:15 UTC: the edge-function list, `career_deploy_ledger`,
  `cron.job`, row counts and the intent label on stored assistant messages. No secret value, no message text and no personal data was read.
- PRs: GitHub REST list of PRs 1 to 269 on 2026-10-28.
- Not read, and so not claimed: the values of function secrets (so every `CAREER_*` switch below says "switch state unreadable"),
  the content of the deployed `agent-chat` bundle (the ledger gives only the commit), and the web app's public domain.

**The five status columns are separate facts. One does not imply the next.**

| Column | Means | How it was decided |
|---|---|---|
| **Impl** | the code exists on `trunk` | read in the file named. `PR #n` means it exists only on that open PR and is not on trunk |
| **Tested** | an automated test in the repo exercises it | a test file exists (named). This is not a pass: the gate step "gate (architect)" is **red on trunk `c6fc2e193`** (the chat-journey test `flow-chat-journey`, "the once-per-employer rule, named", run 40771904962; its fix #265 merged into a side branch, not trunk). Everything else on that commit's CI was green except "deploy (production)" |
| **Merged** | in `trunk` `c6fc2e193` | PR number from the merged list |
| **Deployed** | the function that carries it is ACTIVE in production at that commit (ledger sha `c6fc2e193`, 2026-10-28 22:14 UTC, run 40773074365). "Y" = code live. "Y-off" = code live behind a default-off switch whose state cannot be read. "N" = not deployed (or deployed function does not carry it) | edge-function list plus ledger. **That go-live run's final conclusion was failure** (step "Go live at the pushed commit"); the ledger rows prove which functions were replaced, not that every step (schedules, secrets, migrations) finished. Log not readable here |
| **Live** | a real transcript or row exists on the production database | strict. Test and owner accounts count as "seen", never as "users": production holds 55 auth users, 1 Telegram contact, 1 inbound Telegram update, 0 subscriptions, 0 Google grants, 0 real employer submissions. "Seen" below means an assistant reply carrying that intent label exists, with first and last day. It proves the path ran once, not that the answer was right |

Values: **Y** yes, **P** partial (explained), **N** no, **-** not applicable.

**Headline truths (all verified above):**
1. **Zero real employer submissions have happened.** The only submission-report row is `Example Corp (TEST)`, 2026-10-20.
2. **What people talk to is the regex router, not the model brain.** `AGENT_BRAIN_RELEASED = false` (`agent-chat/career_brain.ts:26`); the staged brain (`CAREER_BRAIN=staged`) and the reply writer (`CAREER_REPLY_WRITER`) are switches whose state is unreadable and whose default is off. Last measured router score: 23/38 (60.5%) on the held-out set, 2026-10-26 (`docs/architect/LAUNCH-READINESS-2026-10-26.md` on PR #192, not re-run). Best brain passes: 89.5 to 94.7%, never 95% with both judges (D-030).
3. **The job index is the one thing running at scale live:** 186,866 postings (190,685 open at the second read, growing), 27,751 boards tracked, 255 ingest runs, 33 ingest cron lanes every 5 minutes, newest first-seen minutes before the read. Open postings come from only five providers: Ashby 58,101, Greenhouse 70,248, Breezy 44,180, BambooHR 17,070, Lever 1,086.
4. **Gmail and Outlook are not connected for anyone** (0 Google grants). That blocks mail-based confirmation, apply by email, outreach sending, reply tracking and calendar in practice, whatever the code can do.
5. **Telegram is the only channel with a live contact** (1). iMessage (LoopMessage) and WhatsApp functions are deployed with no traffic. SMS does not exist.

## 0a. What is on trunk, refreshed 2026-10-30 (code read at trunk `26d35abe`; the deployed production commit is `33f7d00` only)

This section supersedes the per-feature status lines below wherever they disagree. Evidence is the code on trunk `26d35abe`; the deployed production commit is `33f7d00` only, so anything added after it is not deployed, and the values of
function secrets were not read. Statuses: **implemented** = the code is on trunk and tested, behaviour depends on a switch
or setting not read here; **on trunk** = on trunk with no owner switch needed to run, deployed only if it was in `33f7d00` (not verified per item); **needs-owner-setup** = on trunk but inert until the owner sets the named
value or host. Nothing here claims a real user result.

| Item | Status | What the code does, and what it needs |
|---|---|---|
| Researched advice pipeline | implemented, needs-owner-setup | `_shared/agent/research/`: understand, ground (cached, capped web search; guard-accepted facts with URLs), write (a research brief filed as a hosted file), guard (a number or name no source accounts for is dropped by code). Runs only when `CAREER_KNOWLEDGE=on` (off by default); the playbooks in `_shared/agent/knowledge/` are method only and name no company, pay or date |
| Staged brain routing | implemented, needs-owner-setup | `agent-chat/career_staged.ts`: with `CAREER_BRAIN=staged` only questions, advice and conversation go to the model; every action stays with code-first turns and the router; `CAREER_BRAIN_ROUTER_INTENTS` keeps a class on the router; unset or `router` is the kill switch. `CAREER_BRAIN=agent` stays pinned off by `AGENT_BRAIN_RELEASED = false` |
| Apply-here intake | on trunk | `_shared/apply_here.ts`: "apply here <link>" or a pasted posting link resolves the posting (index, else one permitted public Greenhouse, Lever or Ashby fetch), refuses LinkedIn, Indeed and Handshake by name, runs the posting screen, answers in one line and hands the channel one Apply button. At most 25 links per message; nothing is queued by the intake itself |
| One-tap apply, hash-bound approval | on trunk | `_shared/telegram_jobs.ts` (`sendApplyHere`, tap path): the Apply tap carries the payload hash shown, the payload is read again at the tap, a changed payload is refused, and the tap is the approval for exactly that payload (D-MS-1). It says "queued", never "applied". Whether a form is then submitted depends on the apply VM row below |
| Posting screen | on trunk | `career_apply_screen.ts`, `career_apply_screen_answer.ts`: closed, stale, scam and a confirmed conflicting fact hold a posting with the reason; an unconfirmed fact proceeds labelled "not checked"; the tap path fails closed rather than skipping the screen |
| Hosted file pages (`trainee-file`) | implemented, needs-owner-setup | `supabase/functions/trainee-file`, `_shared/file_link.ts`, `file_session.ts`: a signed 24 hour link opens a phone sign-in (code texted to the account's confirmed phone) or a Telegram Mini App login; reads are scoped to the session's account; the page carries the row Apply and "Apply to all N" bound to the exact set. Link minting is skipped until `TRAINEE_FILE_LINK_SECRET` is set |
| Connect page (`trainee-connect`) | implemented, needs-owner-setup | `_shared/connect_link.ts`, `connect_page.ts`: one single-purpose page to connect Gmail or Outlook, with the scopes shown in plain words and no secret rendered. Off until `TRAINEE_CONNECT_BASE_URL` is set to an https address; the link also needs `TRAINEE_CONNECT_LINK_SECRET` or `TRAINEE_FILE_LINK_SECRET`, and a provider with no OAuth configuration shows no button |
| Apply VM | implemented, needs-owner-setup | `workers/career-browser/apply-vm-main.cjs`, `apply-vm.cjs`: a worker process, not a Supabase function. It is not running: it needs a host and `SUPABASE_URL` and `APPLY_VM_KEY`; with no `APPLY_VM_ALLOW_HOSTS` it serves mock forms only. Until a host runs it, no employer form is submitted by it |
| No-download Telegram reply shaping | on trunk | `_shared/channel_shape.ts`: one short answer paragraph (at most 700 characters), detail as named .md or .txt documents (at most 5 per reply, long text split into parts), each link its own message (at most 5), links no tool returned dropped. Text the person approves word for word is never shaped |
| Job alerts: weekly count | removed | Owner rule "no caps": neither the planner (`career_alerts.ts`) nor the database holds alerts by a count per week. `career_alert_enqueue` (migration `20261030180000_career_alert_no_weekly_cap.sql`, replacing the one in `20261030070000_proactive_r2.sql`) no longer returns `capped` on the rolling week; `max_per_week` is still accepted (0 to 25) and ignored, and `tests/db/career_alert_no_weekly_cap.test.sql` queues 30 alerts in a week while a repeated posting stays a duplicate. Kept, because they pace rather than cap usage: the person's daily pacing (`max_instant_per_day`), quiet hours / paused account, once per posting, the fit floor. Outbound email deliverability breakers (bounce and hostile-reply breakers, per-domain daily limit, ramp) are unchanged: they protect the person's own Gmail/Outlook reputation. No cost cap exists in the alert path |
| Approval rate (owner target 95%) | on this PR | Measured, not forced. Rate = approved unchanged / shown over a rolling 7 days, per kind, in `approval_rate()` / `approval_rate_v` (migration `20261030190000_approval_rate.sql`): outreach drafts (an edit or redo, a skip, or 24 hours ignored is a miss), application packets (approved / approved+declined+unanswered 24h; resume-expiry excluded); advice answers have no thumbs feedback yet, so they read `insufficient data`. Under 20 shown the status is `insufficient data`. `ops-monitor` alerts the owner (`approval_below_target`, once a day per kind) when a kind with 20+ shown is under 95%. A person still approves every send and every apply; nothing is auto-approved or loosened |

## 1. Owner decisions that shape the product (current)

Full text in `DECISIONS.md`. Operative ones:

- D-007 never invent a fact about the person. D-024 proof for every external action. D-030 brain bar: 95% held-out, both judges, live.
- D-MS-1 one texted yes approves exactly the shown batch, on any channel, each item bound to its payload hash. D-MS-2 no volume limit of Trainee's own; only an outside system's refusal paces work. D-MS-3 only exact duplicate postings are refused.
- D-033 people come from the person's own sources (LinkedIn export they send, their Gmail, a page they send); never LinkedIn, Indeed or Handshake automation. People discovery at scale uses web search plus public pages, no paid provider (owner, 2026-10-27).
- OpenAI only; no Anthropic spend (also enforced in the gateway, #241). No deploys, live migrations, credentials or spend by agents.
- **Deliberate non-goals (owner, 2026-10-28, stated to the coordinator):** no invite links, no per-member invite limits, no waitlist gate, no 18+ or age gate. **Sign-up stays open.** These are not gaps and no work is queued for them. Two things on the board contradict this and are noted for the owner, not queued: open PR #199 (invite waves) and open PR #195 (sign-up closed by default); and the code default `TRAINEE_SIGNUP` is `closed` unless the env is `open` (`channel_inbound.ts:97`), so "open" is one owner environment value, state unreadable.

## 2. Accuracy contract for external companies (applies to every feature)

The product names employers, shows their postings and acts on their forms. These are the rules, and where each is enforced today.

| Rule | Enforced where | Status |
|---|---|---|
| **Company names** come from the posting record or the board registry (`121 BOARD_REGISTRY`, each verified by a real fetch), else the board's own name in the link. Never from the model. Matching ignores case, punctuation and Inc/LLC and accepts a one-word stand-in only if distinctive (`career_apply_want.ts`, `career_floor.ts`, `career_apply_link.ts`) | code | Y, tested |
| **Roles, pay, places** only as the posting states them. Pay is structured data the board states (`posting_pay.ts`), "never an estimate"; places from `posting_place.ts`/`posting_region.ts`; a search reply says whether results are from the live board or the saved snapshot and how fresh | code | Y, tested |
| **Deadlines**: the postings table has **no apply-by field**; Trainee never states a posting deadline. Deadlines it shows come only from the person's own mail ("deadlines reminded", PR #212) or an invite | by omission | Y (nothing to invent). Gap: a closing date is useful and is not captured |
| **Closed postings**: a posting missing from a successful, complete board read is closed; a failed or partial read closes nothing (`career_ingest.ts`). Every job link is checked just before it is shown, dead ones hidden, unknown ones marked (`link_check.ts`); an apply to a closed or unfound posting is refused by name | code | Y, tested. Link check covers Greenhouse and Lever by board API, others by GET |
| **Stale postings**: not news if the employer posted more than 3 days before Trainee first saw it (`career_fresh.ts`, alerts only). Posting age 45-day stale exclusion and scam-signal exclusion exist in `career_apply_screen.ts` | code | **Alerts: Y. The apply screen is implemented, tested and merged (#231) but nothing imports it** (grep of `supabase/`, `workers/`, `scripts/`: only `tests/architect/apply-screen.test.ts`). So no batch is screened for age, scam or knock-outs by it today. `possibly_stale` repost flag is PR #119 (open) |
| **Logos / brand assets**: only from the employer's own real domain or official brand assets; never invented, never an ATS vendor's logo, never substituted | **no logo code exists on trunk** (grep: none). PR #267 (open) adds logos with default source "Google favicon service" keyed on an employer-hosted domain, and a guess-from-name mode `TRAINEE_LOGO_GUESS` (off) | **Not enforced anywhere live because nothing shows logos live.** Before #267 merges it must prove: domain is the employer's own (never `greenhouse.io`, `lever.co`, `ashbyhq.com`, an aggregator), no guess-from-name, and text card when unsure. A favicon service is not "official brand assets"; owner to decide whether it is acceptable |
| **Never invent a form answer**: answers only from confirmed facts or the person's own words; EEO and legal attestations default to decline or ask; identity numbers never filled (`career_apply.ts`, extension) | code | Y, tested (many suites) |
| **Tailored materials add no skill, employer, title, date or number** the person did not confirm (`career_materials_guard.ts`, wired in `career_tailor.ts`; bullet audit in `career_tailor_rewrite.ts`) | code | Y, tested |
| **Employer replies/confirmation**: "confirmed" only from the employer's own page or authenticated email (dmarc/dkim of that domain); two employers never share a confirmation id | code | Y, tested; mail path needs Gmail (0 grants) |
| **Never LinkedIn, Indeed or Handshake** (automation, links, page reads), on any country domain; no captcha solving; no password or one-time code through chat | code (declined before any apply turn, #259; page reader refuses; engine host allow-list) | Y, tested |
| **Employer rate limits**: a 429, bot wall or 503 backs the host off; bot walls end `needs_user` and are never retried (`career_apply_host_backoff`) | SQL + workers | Y, tested; never exercised on a real employer |

## 3. Status summary (36 features)

| # | Feature | Impl | Tested | Merged | Deployed | Live |
|---|---|---|---|---|---|---|
| F01 | Job ingestion (board index) | Y | Y | Y | Y | **Y** (186,866 postings, 255 runs) |
| F02 | Job search and discovery in chat | Y | Y | Y | Y | seen (`career_discovery`, 39, 10-15..10-28) |
| F03 | Fit ranking, relevance floor, search judge | Y | Y | Y | Y (judge: Y-off) | seen (via discovery); judge N |
| F04 | Job alerts and daily report | Y | Y | Y | Y | seen (watch create/manage 254 replies); **0 alert prefs, 0 alerts ever delivered** |
| F05 | Resume intake and the one confirmed resume | P | Y | P | Y | seen (`career_resume_ingest` 7); 0 uploads, 0 resume records |
| F06 | Resume tailoring (select/order, PDF/DOCX) | Y | Y | Y | Y | seen (`career_tailor` 124, 10-20..10-27) |
| F07 | Truthful bullet rewrite and materials guard | Y | Y | Y | Y-off (rewrite); Y (guard) | N |
| F08 | Cover letters and essay drafts | P | Y | Y | Y-off | N |
| F09 | Posting screen (eligibility, scam, age) | Y | Y | Y | Y (code) but **unwired** | N |
| F10 | Apply from chat: queue, positions, link, batch | Y | Y | Y | Y | seen (`career_apply_queue` 1, `named_role_apply` 4); 0 queued rows ever |
| F11 | Ask-once questions and standing answers | Y | Y | Y | Y | N (0 question rows) |
| F12 | Prepare ahead and the approval card | Y | Y | Y | Y (host: **not configured**) | P (1 card, 3 prepared, test data) |
| F13 | One-yes batch approval (D-MS-1) | Y | Y | Y | Y | N |
| F14 | Apply engine: ATS forms (Greenhouse, Lever, Ashby) | Y | Y | Y | N (runs on the person's computer/VM) | N (0 real submissions) |
| F15 | Browser extension | Y | Y | Y | N (not in Chrome Web Store) | N (one TEST report) |
| F16 | Cloud worker / hosted runner | Y | Y | Y | Y-off (gated) | N |
| F17 | Apply by email | Y | Y | Y | Y-off | N |
| F18 | Account-gated portals (Workday, iCIMS, Taleo, SuccessFactors) | P | P | Y | N | N |
| F19 | Mass apply at volume (queue, fairness, backoff) | Y | Y | Y | P (SQL migrated state unreadable) | N |
| F20 | Tracking, status read-back, receipts, proof | Y | Y | Y | Y | seen (`tracking_*` 212 replies, older router); receipts 0 |
| F21 | Inbox awareness (job mail, confirmation, follow-ups) | Y | Y | Y | Y-off | N (0 grants, 0 mail events) |
| F22 | Connectors: Gmail and Outlook | P | Y | Y | P | N (0 grants) |
| F23 | People finding | Y | Y | Y | Y-off | N (0 people rows) |
| F24 | Outreach drafting and the sending rail | Y | Y | Y | Y-off | seen (drafts, router era `outreach_draft` 53; `career_networking_draft` 2 on 10-27); 0 sends |
| F25 | Replies, follow-up sequences, calls and calendar | Y | Y | Y | Y-off | N |
| F26 | Introductions and referrals (connector, intros) | P | Y | Y | Y-off | N (0 intro rows) |
| F27 | Interview prep: text mock, briefs, thank-you | Y | Y | Y | Y | seen (`prep_brief` 112, `career_mock` 1 on 10-27) |
| F28 | Voice mock interview | Y | Y | Y | Y-off | N |
| F29 | Offers and negotiation | Y | Y | Y | Y | seen (`negotiation_*` 124, router era) |
| F30 | Company research and "how do I get into X" | Y | Y | Y | Y | seen (`company_intel` 124, `path_*` 35) |
| F31 | Reminders, digest, proactive messages | Y | Y | Y | Y | P (2 reminder rows, 13 proactive runs, 0 digests) |
| F32 | Billing and cancel by text | P | Y | Y | Y | N (0 subscriptions) |
| F33 | Privacy: forget, erase, disconnect; (no export) | P | Y | Y | Y | N |
| F34 | Channels: Telegram, iMessage, WhatsApp, SMS, web | P | Y | P | P | Telegram P (1 contact, 1 delivered reply); others N |
| F35 | Memory and the person's situation | Y | Y | Y | Y | seen (`conversation_recall` 30, `profile_recall` 8) |
| F36 | Conversation brain, reply writer, texting voice | P | Y | P | Y-off | N for brain and writer; router replies seen |

Plus cross-cutting systems documented in section 5: files and attachments, link previews, job cards, phone-number login, cost cap and budget, safety guards, admin and monitoring. Each is a numbered feature above or marked in its block (F34, F36, F37-F40 below). **Total counted features: 40** (F01 to F40; F37 to F40 are in section 5).

## 4. Features in depth

Every block: **What it does / Code / Tables / Depth (inputs, limits, failure modes) / Design / Accuracy / Status detail.**

### F01 Job ingestion (the board index)
- **What:** polls public ATS boards into one `career_postings` table that every person's agent reads.
- **Code:** `supabase/functions/career-ingest/{handler,index,local}.ts`, `_shared/career_ingest.ts`, `career_ingest_feeds.ts`, `career_ingest_lanes.mjs`, `career_shards.ts`, `packages/career-data/board-directory.json`, `scripts/launch/schedule-career-ingest.sql`, `build-ingest-schedule.cjs`, `166-career-url-shape.js`.
- **Tables:** `career_postings`, `career_board_state` (27,751), `career_ingest_runs` (255), `career_ingest_state`, `career_kb_postings` (21,688 frozen snapshot), `career_kb_boards` (109).
- **Depth:** readers for Greenhouse, Lever, Ashby, SmartRecruiters (the 121 bundle) plus Workable, Recruitee, BambooHR, Teamtailor, Breezy, Personio, Workday in code; **only Ashby, Greenhouse, Breezy, BambooHR, Lever have open postings live**. Hourly lanes: 33 cron jobs every 5 minutes, 64 buckets, conditional requests (etag, body hash), per-board timeout, run deadline 100 s, honest times (`first_seen_at` never moves, reopened postings are not new). A failed or partial read closes nothing; a board that loses half at once is reported (`large_closes`). URL-shape guard at ingest. Paid aggregator: none (D-003).
- **Failure modes:** a source goes dark (reported in the run record, no alert pushed anywhere); coverage is public-ATS only, so employers on Workday, iCIMS, Taleo and company sites are invisible; Greenhouse/Ashby/Breezy dominate.
- **Design:** none user-facing; the user sees results through F02/F04.
- **Accuracy:** facts about a job only from the posting. No apply-by date captured. Duplicate/repost handling is PR #119 (open).
- **Status:** Impl/Tested/Merged (#180, #180 family, #68) Y; Deployed Y (career-ingest v2, cron live); **Live Y**. Posting index at 150K scale: PR #263 (open).

### F02 Job search and discovery in chat
- **What:** "find me data analyst jobs in Chicago" returns real postings ranked for the person, with links and the source/freshness line.
- **Code:** `career_search.ts`, `career_search_judge.ts`, `career_pool.js`, `career_pool_need.ts`, `link_check.ts`, `agent-chat/handler-career.ts` (router discovery then the search turn), `121-career-jobs.js`.
- **Tables:** reads `career_postings` first, else `career_kb_postings`; `career_watch_kv` (thread state, last shortlist).
- **Depth:** filters by the query's words, role first in the title (WO-073), place or remote, then fit, then newest. Honest tiers: a knocked-out posting ranks last and carries the reason. Link-checked before showing (up to 3 x wanted checks). **Stated parameters (pay, level, type) constraining results is PR #264 (open); the floor in F03 covers part of it.** The reply states "From 37 live postings that match, first seen in the last 6 days."
- **Failure modes:** the pool read is lazy but a turn still reads a window of rows; no semantic/title-synonym matching beyond word rules; the router's own "discovery" can still answer from the snapshot.
- **Design:** plain list, numbered, link bare on its own line (so channels preview it). No cards on trunk.
- **Accuracy:** company, role, place, pay from the posting; dead links never shown.
- **Status:** Y/Y/Y (#183, #93, #238); Deployed Y; Live seen (`career_discovery` 39, `career_internship_discovery` 20).

### F03 Fit ranking, relevance floor, search judge
- **What:** scores each posting against the person's confirmed facts and holds back irrelevant ones.
- **Code:** `121 scoreFit`, `career_search.ts fitOf`, `career_floor.ts` (C-04), `career_alert_fit.ts`, `career_search_judge.ts` (model judge), `career_staffing_agencies.ts`.
- **Depth:** floor filters apply only when the person stated them: level (with traps: "Staff Accountant" is not staff level), employment type, pay (highest stated top; hourly at 2,080 h; bonuses are not pay), company named, staffing agencies. Years known only from dated facts, unknown stays unknown. Judge (`CAREER_JUDGE`, default off) rates the top N (default 20) on a scale with a one-line reason; code keeps a verdict only if the reason names nothing outside the posting and the confirmed facts; cached per posting and profile hash; "18/20 judged" accounting.
- **Failure modes:** a model failure leaves fit order and says "not judged".
- **Accuracy:** an unconfirmed fact is no fact; no raw scores or judge jargon shown (#250).
- **Status:** Y/Y/Y (#31 C-04, #183); Deployed Y (judge Y-off); Live seen via F02 only; judge N.

### F04 Job alerts and daily report
- **What:** the person sets a watch by text; new matching postings reach them within minutes; a daily report carries the rest.
- **Code:** `career-proactive/handler.ts`, `career_proactive_run.ts`, `career_alerts.ts`, `career_alert_store.ts`, `career_watch_alerts.ts` (bridge from the chat's watch record), `career_alert_fit.ts`, `career_fresh.ts`, `trainee-deliver`, `scripts/launch/schedule-career-proactive.sql`.
- **Tables:** `career_alert_prefs` (**0 rows live**), `career_watch_kv` (2,625; holds the watches), `career_outbox`, `career_proactive_runs` (13).
- **Depth:** match = the watch's title terms (whole words), places or remote, levels, firms, exclusions; fit floor and optional `min_fit`; instant alerts freshest/best first; quiet hours move an alert; one report per local day; backlog (posted more than 3 days before first seen) is never news; **no weekly cap anywhere (owner's "no caps" rule): neither the planner nor the database function `career_alert_enqueue` counts a week, see 0a**; the daily pacing per person remains. Cron: every 5 minutes (`4-59/5`).
- **Failure modes:** delivery depends on the channel being live for that person (only Telegram has a contact); the prefs row is written only by the watch bridge (D-032); the agent-brain tool `set_job_alerts` is behind the pinned-off brain.
- **Design:** every alert and report is written by code from posting fields, never by the model; link bare.
- **Accuracy:** only open postings, fresh, passing the person's own gate again at queue time.
- **Status:** Y/Y/Y (#181, #249); Deployed Y; **Live: watches created in chat (seen 254 replies) but 0 alert-pref rows and 0 alerts delivered**, so delivery to a person is unobserved.

### F05 Resume intake and the one confirmed resume
- **What:** the person sends a resume (paste, or a PDF/DOCX on Telegram); Trainee shows each entry, the person confirms it, and the confirmed record is the only resume any apply path reads.
- **Code:** `career_router_evidence.ts`, `channel_resume_upload.ts`, `career_resume_record.ts`, `146-career-intake.js`, `122-career-profile.js`, `148-career-render.js`; migration `20261026120018` (one record), `20261026210016_career_resume_required.sql`.
- **Tables:** `career_resume_uploads`, `career_resume_record`, `career_resume_settings`, `career_events` (`fact_confirmed` with upload hash).
- **Depth:** Telegram file up to 10 MB, PDF or DOCX, text read by code (never a model), sha256 of the bytes stored. Web: paste only, capped at 4,000 characters (files on web/WhatsApp/SMS: PRs #201 and #215 open). Confirmation needs a plain yes to entries that were shown; each entry stamped with the upload. The resume is required before any apply path queues or submits (B4 fix, #211). Asking "which resume do you use" or "delete it" is answered from the one record.
- **Failure modes:** a pasted resume without section headings may become a catch-all; a file that cannot be read is said so and nothing is stored; "yes" on Telegram must be the next word.
- **Accuracy:** nothing confirmed by upload alone (D-007).
- **Status:** Impl P (Telegram and paste; web file, WhatsApp, iMessage attachments are open PRs); Tested Y; Merged P (#194, #211); Deployed Y; Live seen (`career_resume_ingest` 7, router era); 0 uploads, 1 `fact_confirmed` event.

### F06 Resume tailoring
- **What:** a resume tailored to one posting from confirmed facts, as a private PDF (and DOCX) link or an attachment; a changelog from the diff.
- **Code:** `career_tailor.ts`, `148-career-render.js`, `123-career-tailor.js` (truth audit), `154-career-writing.js`, `channel_artifacts.ts`, `career_hosted_prepare.ts`; PR #213 (employer copy PDF and DOCX).
- **Tables:** storage bucket `career-resumes/<user>/<sha256>.pdf` (link signed 7 days), `career_watch_kv` (personas), `channel_artifacts` (1).
- **Depth:** selects, orders, hides confirmed facts; the audit runs twice; the PDF must pass the ATS parse harness; personas ("banking resume") are saved selections only; name/email at top only as typed this turn. Asks which posting if none ("tailor_needs_posting").
- **Failure modes:** the Deno renderer needs node built-ins (loaded on first use); if missing, refuses and stores nothing.
- **Design:** one-line changelog; the document arrives as a file on channels that support it.
- **Accuracy:** no line without a cited fact; `career_materials_guard.ts` is the last check.
- **Status:** Y/Y/Y (#49, #179, #213, #232); Deployed Y; Live seen (`career_tailor` 124, `career_tailor_diff` 28, `career_document_delivery` 7).

### F07 Truthful bullet rewrite and materials guard
- **What:** with `CAREER_TAILOR_REWRITE=on`, one model call rewords selected bullets toward the posting; code decides what prints.
- **Code:** `career_tailor_rewrite.ts`, `career_materials_guard.ts`.
- **Depth:** every content word, number and skill must trace to the one cited fact; a failing bullet keeps its original words; no model or a model error ships the select-and-reorder resume. Metered.
- **Accuracy:** an injected "led a team of 12" is refused (mutation-tested).
- **Status:** Y/Y/Y (#179, #232); Deployed guard Y, rewrite Y-off; Live N.

### F08 Cover letters and essay drafts
- **What:** free-text application answers and cover notes drafted from confirmed facts, shown whole, saved only on "use N".
- **Code:** `career_essay_card.ts`, `essay_draft.ts`, `career-essay-draft` (**function not deployed**), `career_apply_questions.ts`, `workers/career-browser/prepare-ahead.ts` (cover note when a posting asks for one), extension card (WO-049).
- **Depth:** the employer's AI policy decides first; every name and number traced; length met by rewriting not cutting. Full letters appear only on the extension card and in prepare-ahead.
- **Status:** Impl P; Tested Y (WO-030, WO-049); Merged Y (#48, #72); Deployed N for the standalone function, Y-off inside chat; Live N.

### F09 Posting screen (eligibility, scam, age, duplicates)
- **What:** before a posting enters a batch: include with a one-line "why it fits", exclude with a reason, or ask the one missing fact once.
- **Code:** `career_apply_screen.ts` (reasons: already_applied, duplicate_in_batch, closed, stale (45 days), scam, location, sponsorship/citizenship, years, degree).
- **Status:** Impl Y; Tested Y (`apply-screen.test.ts`); Merged Y (#231); **Deployed: code is in the bundle's repo but no module imports it, so it never runs**; Live N. This is competitive-bar gap B6 and the top accuracy risk for mass apply. What does run today on the queue path: `career_apply_want.ts` screens (closed or unfound posting, current employer, exact duplicate, person's own pace) and F03's floor in alerts and prepare-ahead.

### F10 Apply from chat (queue, positions, link, batch)
- **What:** "apply me to this: <link>", "apply to the data role at Acme", "apply to 1 and 3", "apply to all remote ones" put real postings into the person's apply queue; nothing is sent.
- **Code:** `career_apply_chat.ts`, `career_apply_from_chat.ts`, `career_apply_link.ts`, `career_apply_want.ts`, `posting_key.ts`, `career_hosted_prepare.ts`.
- **Tables:** `career_apply_wanted` (0), `career_apply_jobs` (0).
- **Depth:** a pasted Greenhouse/Lever/Ashby link is read from that ATS's public API and stored as ingest would; positions resolved against the last listed shortlist; "all" may carry a filter; each posting checked on file (closed refused; no record and no link is "posting not found"); a confirmed resume is required; reply starts with the coverage line ("3/3 queued; ..."). Declines LinkedIn, Indeed, Handshake before any apply turn (#259). Only exact duplicates refused (D-MS-3). A person's own pace is the only cap.
- **Failure modes:** a board that does not list the id is "not on board"; an unparseable link falls to the router; preparation host absent means "queued, nothing prepared" and the reply must say so (audit Q2; re-verify wording).
- **Design:** one numbered reply listing what queued and what did not, with the reason each.
- **Accuracy:** employer, title and link from the record, never the model (WO-091b).
- **Status:** Y/Y/Y (#66, #91, #175, #186, #223); Deployed Y; Live seen (`career_apply_queue` 1 on 10-28, `named_role_apply` 4); 0 queued rows.

### F11 Ask-once questions and standing answers
- **What:** every question that stops an application is asked once, numbered, answered in one text ("1 no 2 3 years"), checked, and reused.
- **Code:** `career_apply_questions.ts`, `career_standing.ts` (reading), `career_apply.ts` (`classifyField`, `planBatch`), `workers/career-browser/ask-once.ts`.
- **Tables:** `career_apply_questions`, `career_apply_question_drafts`.
- **Depth:** choice questions accept only the employer's own options; yes/no takes yes or no; essays kept word for word. Never asked by text: identity, bank or card numbers, passwords. Measured earlier: confirmed facts answered 56% to 67% of required questions on two real-posting samples, median 3 left (PR #17/#18, REPORTED).
- **Status:** Y/Y/Y (#45, #29 family, #84); Deployed Y; Live N.

### F12 Prepare ahead and the approval card
- **What:** applications are prepared before the person asks (answers from confirmed facts, a tailored resume, a cover note when asked), and shown as one card of exactly what would be sent.
- **Code:** `career_prepare_ahead.ts`, `career_apply_cards.ts`, `career_prepared_card.ts`, `workers/career-browser/prepare-ahead.ts`, `workers/career-cloud/prepare-runner.ts`, `prepare.ts`, `cloud_prepare.ts`, migration `20261025120000_career_apply_prepare_ahead.sql`.
- **Tables:** `career_apply_prepared` (3, test), `career_apply_cards` (1 open), `career_apply_prepare_requests/attempts`, `career_apply_message_cards`.
- **Depth:** candidates are today's best new matches from the person's watches (first seen within 26 h), one per employer per run, minus what they applied to; retried once a week or when the blocking question is answered. Preparation runs the engine's dry run on the employer's form: it needs a host. **A phone-only person gets a card only if the preparation host (`CAREER_PREPARE_AHEAD_URL`) or the hosted sandbox preparer (cron `career-cloud-prepare-dispatch`, every minute) is configured and working; neither is observed working.** The hosted preparer exists since #202/#244 and is deployed; its sandbox account (Vercel) is the owner's.
- **Failure modes:** no resume means not prepared (never a resume the person did not get); a question with no confirmed fact stops that posting and asks.
- **Design:** card = "8/10 applications ready for your yes", each application's exact answers, every unready one named with its reason; paged into messages, one yes covers all pages (D-MS-2).
- **Status:** Y/Y/Y (#172, #202, #244); Deployed Y (preparer unconfigured/unobserved); Live P (test rows).

### F13 One-yes batch approval (D-MS-1)
- **What:** "yes", "yes except 3", "only 1, 2 and 5", "not Acme", "wait", "no" answer the card. Telegram also has Approve/Decline buttons.
- **Code:** `career_apply_cards.ts` (grammar), `channel_card_tap.ts` (buttons: data is `tca:<card>:<digest>`), `src/career-apply-card.js` (web tap), SQL `career_apply_card_answer_as`.
- **Depth:** valid while the card is the thread's last word or the yes replies to its message; within 10 minutes; once; of two cards only the latest. Each item re-hashed; a changed one refused by name, the rest go on. "maybe", "ok", "yes?", "1 or 2" approve nothing and say how to answer. Approve queues; it never sends.
- **Status:** Y/Y/Y (#165 family, #223, #194); Deployed Y; Live N (no real approval).

### F14 Apply engine for ATS forms
- **What:** the engine opens the employer's form, fills from the approved payload, stops at review, sends exactly one POST with the approved body, and records the employer's answer.
- **Code:** `scripts/apply.ts` (host allow-list; families Greenhouse, Lever, Ashby, SmartRecruiters (hand-off)), `scripts/career/{page-functions.cjs,form-bind.ts}`, `portal-browser-helper.cjs`, `workers/career-browser/approve-first.ts`, `mass-run.ts`, `run.cjs`, `packages/domain/149`/`150`, `career_apply.ts`.
- **Tables:** `career_apply_jobs`, `career_apply_receipts`, `career_apply_receipt_files`, `career_apply_host_backoff`.
- **Depth:** 24 captured real forms in CI (6 per family, four families); the engine reads the 17 readable ones; sealed samples E to H scored 97.7% to 98.5% right (REPORTED in PR titles #85, #86). Never fills identity numbers, EEO or legal statements not given; stops on a captcha (`needs_user`, never solved); leases expire at 15 minutes as `unknown_outcome`, never re-sent. Runs on the person's computer (`approve-first.ts` signed in as them) or the owner's VM. Parallel browser worker proven only on local mock forms (PR #262 open).
- **Failure modes:** invisible reCAPTCHA/hCaptcha scores a datacenter browser worse; SmartRecruiters is DataDome-walled so handed to the person; a timeout after click counts as sent with "employer's answer could not be captured".
- **Status:** Y/Y/Y; Deployed N (nothing deployed runs it for a phone-only person); **Live N: 0 real submissions**.

### F15 Browser extension
- **What:** fills Greenhouse, Lever, Ashby (and part of Workday) from confirmed answers, shows a card, presses the site's Submit only after Approve; reads the emailed security code from the person's Gmail.
- **Code:** `extension/` (background, content, panel, `src/apply_core.ts`, `core.ts`), `extension_domain.js`, `extension-sync` function.
- **Depth:** keeps proof on the person's computer (before/after screenshots, hash). Asks for `<all_urls>` host permission although content scripts run only on ATS hosts (audit SEC6). Not in the Chrome Web Store (package built, WO-086).
- **Status:** Y/Y/Y (#62, #76 Workday TEST tenants); Deployed: `extension-sync` Y, the extension N; Live N (one `Example Corp (TEST)` report).

### F16 Cloud worker and hosted runner
- **What:** one Vercel sandbox per approved application; or a VM worker; both only after the person's cloud opt-in and a gate.
- **Code:** `career-cloud-runner/index.ts`, `workers/career-cloud/{worker,sandbox-runner,prepare-runner}.ts`, `_shared/cloud_runner*.ts`, `career_cloud_optin.ts`, `career_cloud_card_chat.ts`, `docs/launch/CLOUD-RUNNER.md`.
- **Tables:** `career_cloud_settings` (cloud kill switch rows 1 to 2), `career_apply_cloud_*` (0 rows), `career_apply_cloud_gate_waivers` (0).
- **Depth:** opt-in terms shown in exact words; gate = 3 hand submissions per portal family confirmed by employer mail (not met: no confirmation possible without Gmail); a family pauses for 6 h at 2% failures; dispatch crons run every minute.
- **Status:** Y/Y/Y (#39, #190, #202); Deployed Y-off; Live N.

### F17 Apply by email
- **What:** for postings whose application is "email your resume to X": a card with the address, subject, a fact-locked body and the tailored resume; "yes" sends from the person's Gmail once.
- **Code:** `career_apply_email.ts`, `career_send_rail.ts`, `career_outreach_gmail.ts`.
- **Depth:** one recipient, no Cc/Bcc; `subject:`/`body:` edits need a new yes; `CAREER_EMAIL_SEND=on` and `gmail.send` required. Resume rule applies.
- **Status:** Y/Y/Y (#64, #229); Deployed Y-off; Live N (no Google grant; `gmail.send` waits on Google verification, #196).

### F18 Account-gated portals
- **What:** Workday, iCIMS, Taleo, SuccessFactors. D-013(b): the person signs in themselves; Trainee fills the rest and never stores a password.
- **Code:** Workday partly in `extension/src` (WO-048, sealed TEST tenants 73/73 correct, real Workday NOT_RUN); reader in ingest for Workday boards.
- **Status:** Impl P; Tested P; Merged Y; Deployed N; Live N. iCIMS, Taleo, SuccessFactors, Oracle, Jobvite: missing.

### F19 Mass apply at volume
- **What:** many applications a day, one approval, fair across people, parallel, paced only by employer refusals.
- **Code:** `workers/career-browser/{approve-first,mass-run}.ts`, SQL `20261027140000_career_apply_host_backoff.sql`, `20261027141000_career_apply_mass_submit.sql`, `career_apply.ts admitApplication`, cron `trainee-apply-sweep` (15 min).
- **Depth:** no per-person, per-claim, per-card or per-company cap (D-MS-2/3); exact duplicates refused across every path; claims use `FOR UPDATE SKIP LOCKED` fair by person; leases 15 min swept to `unknown_outcome`; load measured by `tests/db/career_apply_claim_load.py` and `tests/flow/scale-worker.ts`. `docs/launch/MASS-SUBMISSION.md`.
- **Gaps:** module 149 (old stack) keeps `SPEC_CAPS` 15/day, 5/vendor, 1/company in code that only the old batch stack reaches; the chat can still create old batch intents through the router (REMOVAL-LIST §1). Comments in `cloud_runner.ts` and the extension README still describe "one per company per 30 days".
- **Status:** Y/Y/Y (#243, #244, #236); Deployed P; Live N.

### F20 Tracking, status read-back, receipts and proof
- **What:** "where are my applications", "did Acme go through", "show the receipt for Stripe". Receipt: every answer sent with its fact, approval time and hash, the two screenshots, the employer's confirmation id and words.
- **Code:** `career_apply_status.ts`, `career_standing.ts`, `career_apply_receipts.ts`, `career_apply_receipt_read.ts`, `career_apply_confirm.ts`, `career_inbox_followups.ts`, `126-career-track.js` (tracker), `src/career-dashboard.js` (web dashboard, F15 of the old numbering), PR #234 (per-100 funnel, open).
- **Tables:** `career_apply_jobs`, `career_apply_receipts` (0), `career_apply_receipt_files` (0), `career_mail_events`, `career_events`.
- **Depth:** "submitted" only as recorded; "confirmed" only from the employer's authenticated email; a page's thank-you is "submitted, not confirmed yet"; unknown outcome is unknown and never resent; an employer with no record is said to have none. Receipt pictures are Postgres-stored base64 up to 8 MB each (audit X4; storage design in `docs/launch/RECEIPT-PICTURES-STORAGE.md`).
- **Failure modes:** five readers (queue, mail, thread tracker, drafts, extension report) merged by `career_standing.ts`; if a source cannot be read it is named.
- **Status:** Y/Y/Y (#32, #107 family, #178); Deployed Y; Live seen (older router `tracking_status` 134, `tracking_log` 78); 0 receipts.

### F21 Inbox awareness (job mail)
- **What:** reads the person's job mail (headers and Gmail snippet only, never a body) to classify status, confirm applications, draft follow-ups and remind deadlines; "check my email now".
- **Code:** `career_mail.ts` (1,399 lines), `career_mail_langs.ts` (six more languages), `career_mail_gmail.ts`, `career_mail_store.ts`, `career_mail_model.ts` (second opinion, off), `career_inbox_followups.ts`, `career-proactive` `runMail`.
- **Tables:** `career_mail_events`, `career_mail_drafts`, `career_mail_cursors`, `career_mail_model_calls`, `career_job_emails`.
- **Depth:** sealed blind sets: blind300 95.7% precision / 83.3% recall; blind240 89.1% recall / 99.4% precision (REPORTED, PR titles #73, #77). Only Gmail's own first Authentication-Results trusted; forwards and calendar notices are evidence only. Switch `CAREER_MAIL_TRACKING` (off by default).
- **Status:** Y/Y/Y (#46, #66, #69, #70, #73, #77, #78, #173, #212); Deployed Y-off; Live N (0 grants).

### F22 Connectors: Gmail and Outlook
- **What:** connect from any channel with a one-time link bound to the person; disconnect revokes, erases what was read, cancels pending sends; "what's connected".
- **Code:** `connectors.ts`, `outlook_connector.ts`, `outlook_graph.ts`, `gmail-oauth/{index,career}.ts`, `outlook-oauth/index.ts`, `docs/launch/GOOGLE-VERIFICATION-2026-10-26.md`.
- **Tables:** `user_oauth_connections` (0 Google), `career_outlook_*`, `career_parked_tasks`.
- **Depth/risk:** **live `gmail-oauth` is still the finance-era v34 and not part of this go-live's deploy list** (`OAUTH_FNS` deploys `outlook-oauth`; confirm Gmail callback `verify_jwt` and provider key before the owner tests). `gmail.readonly` is a Google restricted scope (CASA review, external); `gmail.send` sensitive.
- **Status:** Impl P; Tested Y; Merged Y (#196, #226, #247); Deployed P; Live N.

### F23 People finding
- **What:** "who do I know at Ramp": the person's LinkedIn export, their Gmail correspondents (headers only), a public page they send, and web-search public pages.
- **Code:** `career_people.ts`, `career_people_import.ts`, `career_people_gmail.ts`, `career_people_page.ts` (SSRF-guarded reader), `career_people_provider.ts` (OpenAI web_search + page reads), `career_people_sweep.ts`, `career_people_sites.ts`, `career_networking.ts`, `career_contacts.ts`.
- **Tables:** `career_people` (0), `career_people_imports`, `career_people_gmail_sweeps`, `career_people_prefs`, `career_provider_*`.
- **Depth:** a person exists only when a page names them and establishes the employer, with the page URL kept; emails only if the page published them or the person's own mail knows them; no guessed address. Email verification (Hunter) is off/NOT_WIRED; no paid provider (owner decision). Flags `CAREER_PEOPLE_SEARCH`, `CAREER_PEOPLE_SWEEP`.
- **Status:** Y/Y/Y (#177, #222, #228); Deployed Y-off; Live N.

### F24 Outreach drafting and the sending rail
- **What:** drafts emails to named people from confirmed facts (fact-lock), approved by hash, sent from the person's own Gmail or Outlook exactly once.
- **Code:** `career_outreach.ts`, `career_send_rail.ts`, `career-send` function, `career_outreach_gmail.ts`, `outlook_connector.ts`, `career_outreach_track.ts`; flags `CAREER_SEND_RAIL`, `CAREER_OUTREACH_SEND`.
- **Tables:** `career_outreach_drafts`, `career_send_queue`, `career_send_accounts`, `career_send_bad_addresses`, `career_outreach_dnc` (all 0).
- **Depth:** no daily number, warm-up or spacing (NO LIMITS); display page of 10; Gmail's own 429 pauses; recipients protected (do-not-contact, stop honored); bounces never retried. Mailbox-reputation guard (List-Unsubscribe, complaint monitoring) is not built (bar B12).
- **Status:** Y/Y/Y (#55, #177, #225, #229); Deployed Y-off; Live seen drafts only (`career_networking_draft` 2 on 10-27); 0 sends.

### F25 Replies, follow-up sequences, calls and calendar
- **What:** reads replies on watched threads, classifies them, proposes three free slots, creates an approved calendar event with a Meet/Teams link.
- **Code:** `career_outreach_replies.ts`, `career_calendar.ts`, `career_people_reminders.ts`, `career_outreach_track.ts`.
- **Depth:** rule pre-pass for bounce/out-of-office/stop; model gives a class from a fixed list as data; conversation state merged in code; calendar uses free/busy only, event id derived from the action id.
- **Status:** Y/Y/Y (#248); Deployed Y-off; Live N. Needs Google calendar scopes that the consent URL asks only once the owner lists them.

### F26 Introductions and referrals
- **What:** a path = direct contact, else mutual, else a published address, else none; drafts the ask and a forwardable note; tracks sent/replied. Also the Connector (double-opt-in intros between Trainee users).
- **Code:** `career_connector.ts`, `career_referrals.ts`, `135-career-graph.js`, `career_people.ts` intros.
- **Depth:** Trainee never sends from its own identity; weekly intro cap `WEEKLY_CAP = 3` remains (owner to rule); intro reminders pushed only when `CAREER_INTRO_REMINDERS=on` and the person has a channel.
- **Status:** Impl P (the Connector is "built, not wired"); Tested Y; Merged Y (#44, #177, #222); Deployed Y-off; Live N (2 `graph_*` replies, router era).

### F27 Interview prep: text mock, briefs, thank-you
- **What:** text mock tied to a posting, graded against the bank's answer key; weak spots drilled; interview invite becomes a brief; thank-you and nudge drafts.
- **Code:** `career_mock.ts`, `career_mock_prep.ts`, `career_invite.ts`, `career_brief_store.ts`, `127-career-prep.js`, `packages/career-data/interview-banks/*.md` (9 sectors), `cirs/` (38 company records).
- **Tables:** `career_interviews`, `career_events` (`mock_done`), `career_digest_prefs`.
- **Depth:** a question about a company comes only from that company's record, quoted with its source; with no record nothing is said about how it interviews. `CAREER_MOCK_JUDGE=on` adds a metered model judge. Live-interview assist refused 100% (D-015; C-03). Interviewer names are never looked up.
- **Status:** Y/Y/Y (#43, #56, #174); Deployed Y; Live seen (`prep_brief` 112, `career_mock` + `career_mock_debrief` on 10-27).

### F28 Voice mock interview
- **What:** one text returns a single-use link; a 20-minute OpenAI Realtime call; a scored debrief in the thread; transcript words only, audio never kept.
- **Code:** `career-voice/index.ts`, `career_voice.ts`, `career_voice_link.ts`.
- **Depth:** token signed, bound to the person, 10 minutes to start, single use; `CAREER_VOICE=on` needed; OpenAI key on the server.
- **Status:** Y/Y/Y (#53); Deployed Y-off; Live N.

### F29 Offers and negotiation
- **What:** "I got an offer from X for $110k": benchmark against public data and open postings' stated pay; counter drafted on an approval card citing the data.
- **Code:** `career_offer.ts`, `career_offer_chat.ts`, `128-career-negotiation.js`, `packages/career-data/datasets/{dol-lca-wages,bls-oews-metro,bls-labor-data}.json`, `career_hired.ts` (PDL, off).
- **Depth:** a median only from n of 5 or more; every number carries dataset, period and n; no model call. Sending the counter: no send path (map: "no send path").
- **Status:** Y/Y/Y (#58, #170); Deployed Y; Live seen (`negotiation_advice` 76, `negotiation_draft` 41, router era).

### F30 Company research and "how do I get into X"
- **What:** facts about a firm from sourced records; paths and requirements with source and check date; research questions answered with published facts first, interpretation second, unknowns third.
- **Code:** `125-career-intel.js`, `career_path.ts`, `research_reply.ts`, `research_sources.ts`, `trainee-report` function, `packages/career-data/{cirs,firm-guide.json,interview-patterns.json}`.
- **Depth:** 38 curated company records, nothing fetched at runtime for the brief; no record means nothing said. Research reports verify each link by a 200 fetch and each detail by a found quote; the new answer layout is flag-off (#246).
- **Status:** Y/Y/Y (#58, #246); Deployed Y (trainee-report not in this go-live's function list; verify); Live seen (`company_intel` 124, `path_answer` 18).

### F31 Reminders, digest and proactive messages
- **What:** reminders, a weekly digest, post-interview nudges, intro reminders; daily report.
- **Code:** `career_digest.ts`, `career_proactive_run.ts`, `career_people_reminders.ts`, `packages/domain/103-reminders.js`, PR #216 (workflows: reminders by text, open).
- **Tables:** `career_reminder_outbox` (2), `career_outbox`, `career_digest_prefs` (0).
- **Depth:** digest once per ISO week at the person's day/hour, under 1,500 characters, built only from rows; nothing estimated. Outbox is once per (user, key).
- **Status:** Y/Y/Y (#56, #222); Deployed Y; Live P.

### F32 Billing and cancel by text
- **What:** "what am I paying", "cancel my plan", "my invoices" on any channel.
- **Code:** `career_billing.ts` (Stripe by `fetch`), PR #255.
- **Depth:** price/next charge only from the person's `user_subscriptions` row; cancel = one approved step bound to a hash of subscription+period end, at period end, hash as Stripe idempotency key; invoices only Stripe-returned links. **There is no Trainee checkout, pricing page or plan in the product:** `stripe-checkout`, `stripe-credits` and `stripe-webhook` are Upmore finance functions the go-live refuses to deploy (live v46/v47 are legacy). The default price constant is $10/month.
- **Status:** Impl P; Tested Y; Merged Y; Deployed Y (read/cancel); Live N (0 subscriptions).

### F33 Privacy: forget, erase, disconnect (no export)
- **What:** "forget everything" and account deletion remove the person's rows; "forget my LinkedIn contacts/gmail contacts/job emails/intro requests"; Gmail/Outlook disconnect erases what was read.
- **Code:** `career_erase_person` (migration `20261026230100_career_erase_complete.sql`, finds every `career_*`, `channel_*`, `extension_*` table with `user_id` by catalog), `delete-account`, per-feature forget turns, bucket purge.
- **Depth:** exact-posting tombstone (hash) kept so a duplicate cannot be re-sent. **Data export does not exist** (no "export my data" turn or function; the only export code is the LinkedIn import). Competitive-bar flagged this (Sonara lock-out).
- **Status:** Impl P; Tested Y (`launch-readiness-*`, `f10-networking-forget`); Merged Y (#200); Deployed Y; Live N.

### F34 Channels
Per channel: what, code, depth, status. All speak one conversation interface; the brain never knows the channel.
- **Telegram:** `trainee-telegram`, `trainee-telegram-link`, `telegram.ts`, `telegram_login.ts`, `channel_inbound.ts`, `channel_present.ts`, `channel_card_tap.ts`, `channel_runtime.ts`. Resume files up to 10 MB; Approve/Decline inline buttons; Telegram's own login (signed payload, once, 10 minutes); `/start <nonce>` link; hourly-limit 429 spoken as the limit. Phone-share login, job cards: PR #267 (open); reply shape: #268 (open). **Deployed Y; Live P: 1 contact, 1 inbound update, 1 delivered reply.** Owner steps: webhook must point at `trainee-telegram` (not the test bridge `telegram-inbound`), BotFather domain, env values.
- **iMessage:** `trainee-inbound`, `trainee-deliver`, LoopMessage adapter; secret read from the URL (audit SEC4); LoopMessage caps contacts at 300 or 1,000 a day and prohibits cold messaging (D-009). Deployed Y; Live N.
- **WhatsApp:** `trainee-whatsapp`, Meta Cloud API; 24-hour window rule with template fallback; templates in `docs/launch/whatsapp-templates.json`. Deployed Y; Live N. File documents: PR #215 (open).
- **SMS:** not built (channels are `imessage | whatsapp | telegram`, `channel_adapters.ts:11`). STOP/START/HELP handled everywhere; CANCEL/END/QUIT are opt-outs only on SMS.
- **Web:** `index.html` built from `src/upmore-app-template.html` (13,655 lines; titled "Upmore", 9,306 mentions vs 31 of "Trainee" at the 2026-10-26 audit, not re-measured); `agent-chat` is the endpoint; dashboard (matches, queue, tracker, hash-bound approval card, setup: #171). Signs in with email+password or Google; no phone login. CORS allowed only upmore origins at audit; Trainee `/app` and CORS: PR #195 (open). Public domain: owner. Web is **not** launched as Trainee.
- **Rules everywhere:** a message is claimed once per provider id; STOP silences all proactive sends; every outbound text is once per (user, key); turns run one at a time per person (`career_turn_gate`, #200).

### F35 Memory and the person's situation
- **What:** the person's profile, confirmed facts, standing instructions and a timeline persist across threads and channels; the system prompt gets a situation block built by code each turn (every task in flight, what blocks it, who acts).
- **Code:** `career_account_memory.ts`, `agent/memory.ts`, `agent/timeline.ts`, `career_situation.ts`, `career_capabilities.ts`, `career_standing.ts`, `career_host.js`, migration `20261026090009_career_account_memory.sql`; since 2026-10-31 account scope is the default for anyone with a texting contact linked (or whose account already holds the memory), with one profile copy across threads (`20261031050000`); `CAREER_ACCOUNT_MEMORY=on` forces it, `=off` turns it off (root cause 3, `docs/architect/ROOT-CAUSES-2026-10-31.md`).
- **Depth:** model window of the last 40 messages plus a code-written summary; nothing before an erase reaches the model; a correction replaces what it corrects (PR #102, open); pasted text never writes the tracker (PR #111, open). Prompt injection into saved memory (audit S3) fixed partially: the saved instruction must be built from the quote.
- **Status:** Y/Y/Y (#37, #41, #138, #182); Deployed Y (account scope Y-off); Live seen (`conversation_recall` 30, `profile_recall` 8).

### F36 Conversation brain, router, reply writer, texting voice
- **What:** how a message becomes a reply. Order in `handler-career.ts`: auth, 60 turns an hour rate limit, input cap 4,000 characters, turn gate, then about 25 code-first turns (connectors, card, mock, questions, confirm, email, outreach, replies, cloud, pace, billing, apply, receipts, inbox, standing, applications, networking, offers, send status), then the staged brain or the regex router (`142-career-router.js`, 15k lines, ~120 intents), then rewriters, then the reply writer.
- **Brain:** `agent/loop.ts`, `agent/career_tools.ts` (36 tools: search_jobs, tailor_resume, queue_applications, track_application, offer_benchmark, draft_outreach, set_job_alerts, ...), policy at the tool boundary: reads free, own writes free, external effects only as approvals bound to a hash. Pinned off by `AGENT_BRAIN_RELEASED = false`; `CAREER_BRAIN=staged` (PR #176) would send only question/advice turns to it.
- **Reply writer (V1 texting voice, #235):** one writer at the final-reply boundary rewrites the reply from verified facts of the turn; `CAREER_REPLY_WRITER=on`; default off; exact-payload turns never rewritten. Voice spec: `docs/architect/specs/TEXTING-VOICE-2026-10-27.md` (on a branch, not trunk).
- **Task intelligence layer:** plans, registry, planner loop behind `CAREER_PLANNER` (PR #252, open, default off); spec on PR #224 (open).
- **Depth/quality:** router 60.5% on 38 held-out items (REPORTED 2026-10-26); brain 89.5 to 94.7% per pass, unsealed small set (the builder saw 33 of 38); sealed set of 162 on PR #198 (open); held-out 269 and brutal task-context 266 (open). 149 hard-coded reply literals in `_shared/career_*.ts` against the "no canned prose" rule; jargon guard `reply-jargon-guard` and plain-reply fixes #233/#238/#250.
- **Failure modes:** a turn that crashes after the channel claims the message is not retried on Telegram/WhatsApp (audit R2); live latency with zero model calls p50 about 2 s.
- **Status:** Impl P; Tested Y; Merged P; Deployed router Y, brain/writer/planner Y-off or N; Live router replies seen (1,096+ unlabeled and 40 labeled intents); brain and writer N.

## 5. Cross-cutting systems (also features)

### F37 Files and attachments
- Inbound: Telegram resume PDF/DOCX (10 MB). Outbound: tailored resume PDF/DOCX through `channel_artifacts` (a bytes-ref row, never a public link; `CHANNEL_ARTIFACT_SECRET`), receipt pictures, research files (flag off). `.md/.txt` attachments, numbered parts: PR #268 (open). Postgres stores the bytes today (`channel_artifacts.bytes_b64`, receipt files up to 8 MB each; Storage migration design only). iMessage/MMS/WhatsApp attachments inbound: PR #215 (open). Status: Impl P, Tested Y, Merged P, Deployed Y, Live P (1 artifact).

### F38 Link previews and job cards
- **Link previews:** links go on their own line so a platform shows its normal preview; reports are linked alone (`research_reply.ts`); Telegram `link_preview_options`: #268 (open). Verified-link rule: only links a tool fetched with HTTP 200 or the person typed; LinkedIn/Indeed/Handshake never linked.
- **Job cards (logo, role, pay, level, posted, source, fit reasons, Apply/Details/Save):** PR #267 (open); **nothing on trunk**. Logo accuracy rule in section 2 applies. Status: Impl N on trunk, Tested on the PR, Merged N, Deployed N, Live N.

### F39 Phone-number sign-in
- **Today:** on iMessage, WhatsApp and Telegram the contact (phone, wa id, chat id) is the identity: the first message creates the account, no password (`trainee-inbound/store.ts`). **Telegram account creation without email/phone was never proven against real Auth** (audit B3); the live 1 contact came through a test path. Same phone on a second channel never merges silently: the already-linked channel is asked, and only its yes links. Telegram login widget and `/start` nonce for existing accounts (D-023 still "proposed").
- **Web:** email+password and Google only. No phone login page, and no SMS/WhatsApp code provider exists.
- **Owner decision (2026-10-28):** parity means phone-number identity, no password, and, when a provider exists, the user typing their own SMS or WhatsApp code into the login page. Invite links, waitlists and age gates are not goals. A code typed on a login page is consistent with the rule that no one-time code travels through chat.
- Status: Impl P, Tested Y (`telegram-login-link`, wo-038), Merged P, Deployed Y, Live P.

### F40 Cost cap, budget, and admin / monitoring
- **Per-person model ceiling:** `career_spend_cap.ts`, `CAREER_MODEL_DAILY_USD` default $0.05 a UTC day and `CAREER_MODEL_DAILY_CALLS` default 100, through one wrapper before the gateway; D-002 cap $1 per person a month; every turn writes a cost row (`agent_turn_costs` 207 rows; `agent_daily_costs`), zero calls, metered, or "unrecorded" (#251). Global one-day budget: PR #260 (open, $20 for 2026-10-29 America/Chicago). OpenAI-only gateway (#241).
- **Operations:** `trainee-go-live.sh` (provenance from `git archive <sha>`, masked secrets, rollback copy), deploy pipeline on push to `release/production` with owner approval (#187), `career_deploy_ledger` (108 rows, now live), `verify-security-live.cjs`, definer lockdown (#197/#210), `trainee-smoke.cjs`, `docs/launch/TRAINEE-GO-LIVE.md`, legacy finance cron unscheduled (#239; the live cron list has only Trainee jobs). `model-health` and `agent-proactive` (finance) are still deployed.
- **Missing:** error tracker, alerting, uptime check on the career path; a global pause switch; per-person funnel metrics (#234 open); owner-facing admin view. CI: 45-minute gates; "deploy (production)" failed on the last run.
- Status: Impl P, Tested Y, Merged P, Deployed Y, Live Y for cost rows and ledger.

## 6. Parity against Instinct

Instinct = an iMessage-based AI assistant: sign in by texting from your phone number with no password, Claude-like conversational replies, creates and sends files, link preview cards, research summaries, multi-step tasks. Instinct's own capabilities here are as the owner described them, not independently tested. Gap rank 1 is the worst.

| Instinct capability | Trainee today | Gap rank |
|---|---|---|
| Login by texting from your phone, no password | iMessage/WhatsApp/Telegram contact is identity; first message creates the account when sign-up is open; no password. Live only on Telegram (1 contact). Web has no phone login. **Parity scope (owner): phone identity, no password, and later the user typing their own SMS/WhatsApp code on the login page** | 4 |
| Conversational Claude-like replies | Live replies come from a regex router (60.5%); the model brain is pinned off; the reply writer is merged and off | **1** |
| Creates and sends files | Tailored resume PDF/DOCX as a channel file works; `.md/.txt`, research files and general attach tool: flag-off or open PRs (#246, #268); postgres-stored bytes | 5 |
| Link preview cards | Links on their own line; Telegram `link_preview_options` on #268; job cards on #267; none on trunk | 6 |
| Research summaries | `research_reply.ts` (published facts, interpretation, unknowns, verified links) merged and flag-off; company records cover 38 firms | 5 |
| Multi-step tasks | Planner/plans behind `CAREER_PLANNER` (#252, open, off); workflows #216 open; the router handles one turn at a time; compound asks drop the second part (audit) | **2** |
| Works at scale, always on | Index runs at scale; per-turn read window; Telegram only live | 3 |
| Invite links, member invite limits, waitlist gate, 18+ gate | **Deliberate non-goal (owner, 2026-10-28). Sign-up stays open. Not a gap; nothing queued** | - |

## 7. Parity against Tsenta (claims are Tsenta's own, 2026-10-19 research, `docs/competitors/tsenta.md`; Trainee column is this document)

| Tsenta (claimed) | Trainee today | Rank |
|---|---|---|
| Real applications every day, "hundreds a week" | **0 real submissions ever** | **1** |
| 19 to 30+ ATSes incl. Workday, runs in its cloud while the tab is closed | Greenhouse, Lever, Ashby engine; Workday partial (TEST tenants); cloud gated, unobserved; SmartRecruiters handed to the person | **2** |
| Watches 50,000+ career pages, applies "the moment a role goes up" | 27,751 boards, hourly lanes, 190k open postings; five providers; preparation-before-ask needs a host that is not observed working | 3 |
| Inbox routing, status moves on its own | Code complete; 0 mail grants | 3 |
| Web, iOS, Android, extension, iMessage, WhatsApp, MCP, CLI | Telegram live; iMessage/WhatsApp deployed unobserved; web is Upmore-branded; extension not published; no mobile apps, no MCP; CLI exists | 4 |
| Tailoring with a diff | Changelog from the diff, truth guard, provenance per line (stronger than Tsenta's invented-metrics example) | ahead |
| Receipt per application, failures not charged | Receipt with proof design; 0 real receipts | 5 |
| 25 free, $19/600, $39/1,500, $99/4,500 | No Trainee checkout, no pricing, 0 subscriptions | 4 |
| Networking | Tsenta has none; Trainee has people-finding, outreach, replies, calls, intros: code complete, unobserved | ahead on paper |
| Volume | No Trainee cap on applying; unproven | n/a |

## 8. Ordered gap list to a 5/5 product

Type: **code** (agents can build), **owner** (owner decision or action), **external** (outside party, review or paid account). Order is the critical path; earlier items block later proof.

1. **First real, owner-run employer submission with proof, per family (Greenhouse, Lever, Ashby).** Needs the sender: the owner's computer running `approve-first.ts`, or the VM. Without one, nothing downstream can be called working. *owner + code.*
2. **Phone-only preparation and sending that is actually running and observed:** configure `CAREER_PREPARE_AHEAD_URL`/token or the hosted sandbox preparer (Vercel token, snapshot), open the cloud gate with the owner's own confirmed submissions, lift single-enrolment limits, and make the apply reply say plainly when preparation is not running. *owner + code.*
3. **Wire the posting screen (F09) into queue and batch building**, with the eligibility knock-outs, 45-day stale limit, scam signals and a "why it fits" line per card item, and add the apply-by field to postings. Then add a mutation test that an unscreened posting cannot reach a card. *code.*
4. **Release the conversation to the model:** pass 95% on a sealed 200+ item set with both judges on the live build, then flip staged brain and the reply writer; clear the canned reply literals. *code + owner (the flag flip).*
5. **Gmail and Outlook connected for real:** fix live `gmail-oauth` (still finance v34), pass Google verification (restricted scope, CASA cost and weeks), then prove mail confirmation, email apply, outreach send, reply tracking and calendar with the owner's own account. *external + owner + code.*
6. **Telegram end to end with a real person**, including account creation against real Auth, webhook pointed at `trainee-telegram`, and a transcript saved; then iMessage (LoopMessage plan caps) and WhatsApp (Meta verification, templates). *owner + external.*
7. **Job cards with logos from the employer's own domain or official assets, never an ATS vendor's or a guess** (#267, with the section 2 proofs), plus phone-share login there. *code + owner (is a favicon service acceptable).*
8. **Multi-step tasks:** plans per person, resumable across channels and burst-safe, behind `CAREER_PLANNER`, then measured. *code.*
9. **Account-gated ATSes:** Workday live proof, then iCIMS, Taleo, SuccessFactors; honest hand-back card for the rest. *code + owner trials.*
10. **Billing:** decide plans and price, build Trainee checkout and webhook (not the finance functions), prove cancel-by-text against a real subscription. *owner + code.*
11. **Data export** ("send me everything you keep") and a confirmed-erase read-back. *code.*
12. **Outcome measurement:** per-100 funnel (confirmed, interview, reply) per person and for launch (#234), outcome rate over real users. *code.*
13. **Operations:** error tracking, alerting, uptime, a global pause switch, an admin view; keep CI green (trunk's architect gate is red now); verify what the deployed `agent-chat` bundle contains. *code + owner.*
14. **Mailbox reputation guard** (List-Unsubscribe, complaint/bounce monitoring with automatic pause on outside signals). *code.*
15. **Owner rulings to close contradictions with "no limits of our own":** introduction weekly cap 3; module 149's old caps; stale 30-day-per-company comments. *owner.*
16. **Storage for binary files** (receipt pictures, artifacts) in object storage with lifecycle rules; web: Trainee brand, public domain, CORS, per-item approval. *code + owner (domain).*
17. **Files and research outputs** on channels (#246, #268, #215, #201). *code.*
18. **Phone sign-in on the web** (own phone number, no password) with a typed SMS/WhatsApp code once a provider exists. *code + external provider (owner).*

Not on the list by owner decision: invite links, per-member invite limits, waitlist gate, 18+ gate. PRs #195 and #199 conflict with open sign-up; the owner decides whether to close them.

## 9. Open PRs that change this document when merged (2026-10-28)

#267 Telegram job cards and phone-share login; #268 Telegram reply shape; #266 task-context eval; #269 held-out eval; #264 search parameters; #263 posting index; #262 parallel apply proof; #260 daily budget; #257 remove finance; #252 task intelligence; #234 outcome funnel; #227 Instinct e2e harness; #224 specs; #216 workflows; #215 SMS/WhatsApp attachments; #201 resume files; #199 invite waves (conflicts with owner decision); #198 sealed eval; #195 web Trainee at /app; #191 connectors needs; #119 repost/stale; #102/#108/#110/#111 memory and answers fixes.

## Superseded

Replaced by this file for "what exists and how deep": `docs/capability-inventory.md` (finance-heavy, 2026-10-12), `docs/capability-list/`, `docs/upmore-200-capabilities.md`, `docs/upmore-capability-matrix.md`, `docs/upmore-capability-audit.md`, `docs/product/REQUIREMENTS.md`, `docs/product/TARGETS-V2.md`, `docs/architect/BACKEND-GAP-MAP-2026-10-23.md`, `docs/architect/PLAN-2026-10-20.md`, `docs/architect/cards/NOW.md`, `packages/capabilities/registry.json` (296 finance capabilities). Each carries a one-line superseded banner. `ARCHITECTURE.md` and `DECISIONS.md` remain the design and the rulings; this file is the inventory.
