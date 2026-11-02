#!/usr/bin/env bash
# Trainee go-live: one command from the OWNER's own shell, never an agent's (AGENTS.md: agents never deploy, apply
# migrations to a live project or create credentials). From the repo, checked out at the exact commit to ship:
#   bash scripts/launch/trainee-go-live.sh --sha <40-character commit> [--label <who>] [--dry-run] [--skip-migrations]
#                                          [--skip-deploy] [--only-smoke] [--brain agent|staged|router] [--allow-send] [--no-wait]
#   bash scripts/launch/trainee-go-live.sh --verify <40-character commit>     (reads only; exit 1 on any mismatch)
#   bash scripts/launch/trainee-go-live.sh --sha <sha> --non-interactive      (CI: .github/workflows/deploy-production.yml)
# WO-093 provenance: a run that changes anything ships exactly the commit named by --sha. It refuses a dirty tree, a HEAD
# that is not that sha, and a stale router bundle (build-router-core.py --check and --career-only --check), then stages
# only `git archive <sha>` into a fresh temp dir, works from there (never from this checkout), prints the provenance
# manifest (the sha, every function's entry and bundle sha256, the migrations, the time, the tool versions; saved under
# ~/trainee-provenance/), and writes public.career_deploy_ledger: one row per migration mark read live, one per function
# deployed. --verify <sha> compares that ledger and every live MIGRATION_MARK to the manifest of <sha>, listing each
# mismatch. --label names who deployed in the ledger (default: owner; no secret, no personal data).
# Read from the environment, or asked on a hidden prompt (read -s: never shown, never written to a file or the log):
#   SUPABASE_PROJECT_REF, SUPABASE_DB_URL        the live project and its database (Settings > Database > URI)
#   CAREER_INGEST_SECRET, CAREER_PROACTIVE_SECRET, TRAINEE_DELIVER_SECRET, TRAINEE_INBOUND_SECRET
#                                                the four function secrets (32+ of A-Z a-z 0-9 . _ ~ -, because the inbound
#                                                one rides in a URL); Enter generates a 48-character one (openssl rand -hex 24)
#   LOOPMESSAGE_API_KEY, OPENAI_API_KEY          Enter keeps the one already set on the project
#   INGEST_CONTACT_EMAIL, TRAINEE_ALLOWED_CONTACTS, LOOPMESSAGE_DAILY_CONTACTS   settings; Enter keeps what is set
#   UPMORE_TEST_JWT (optional), TRAINEE_SMOKE_CONTACT (with --allow-send)        for the smoke checks
#   PDL_API_KEY (optional)                       People Data Labs, hired-candidate aggregates (WO-036, D-018); Enter keeps
# Optional, one channel each (WO-038); a channel left empty stays NOT_WIRED (its rows wait, its webhook answers 503):
#   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (Enter generates one when a token is given), TELEGRAM_BOT_USERNAME
#   WHATSAPP_TOKEN (the permanent system-user token), WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
#   WHATSAPP_VERIFY_TOKEN (Enter generates one when a token is given), WHATSAPP_TEMPLATE_UPDATES (the approved template's
#   name), WHATSAPP_TEMPLATE_LANGUAGE (default en_US), WHATSAPP_DAILY_TEMPLATES (default 250)
# FEATURE 17, the cloud runner (preparation and sending without anyone's computer; docs/launch/CLOUD-RUNNER.md). Wired
# only when VERCEL_TOKEN is given (or CLOUD_RUNNER_SECRET is set on the project); otherwise nothing of it is touched:
#   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID    the sandbox host (a team-scoped token)
#   CLOUD_SANDBOX_SNAPSHOT_ID                          the runner snapshot; or --build-snapshot builds one at --sha
#                                                      (one sandbox for ~25 minutes, Vercel spend) and uses its id
#   CLOUD_RUNNER_SECRET, CLOUD_DISPATCH_SECRET, CAREER_PREPARE_AHEAD_TOKEN   function secrets (Enter generates each)
#   CLOUD_BRIDGE_URL and CAREER_PREPARE_AHEAD_URL      derived from the project ref, never asked
#   the numbers, each optional. Infrastructure sizing not given is set to the runner's default (CLOUD_WAVE1 below, the
#   same numbers as cloud_runner_http.ts LIMIT_DEFAULTS and docs/launch/CLOUD-RUNNER.md):
#     CLOUD_MAX_CONCURRENT CLOUD_MAX_PER_PORTAL CLOUD_MAX_STARTS_PER_TICK CLOUD_PREPARE_MAX_CONCURRENT CLOUD_PREPARE_STARTS_PER_TICK
#   The per-person and per-site numbers are never set unless given (owner, 2026-10-27, NO LIMITS: no number of Trainee's
#   own; the brake is an outside system's refusal); given, any whole number from 1:
#     CLOUD_MAX_PER_PERSON_DAY CLOUD_MAX_PER_SITE_MINUTE CLOUD_PREPARE_PER_PERSON_DAY CLOUD_PREPARE_PER_SITE_MINUTE
#   CLOUD_RUNNER_ENABLED, CLOUD_PREPARE_ENABLED        'on' turns sending / preparation on; unset: not touched (off
#                                                      until set). The database's own switches still decide every claim.
# Steps, each a numbered STEP line ending OK or FAILED; the run stops at the first failure:
#   1 preflight   tools, inputs, a clean tree at HEAD = --sha, the commit staged from git archive, the router bundle
#                 checks and deno check of the entry points there, the provenance manifest printed
#   2 migrations  every Trainee migration in order, each once (the ledger or the live schema says it is there), each
#                 in one transaction; the earlier career migrations are only checked (plain `create table`, so not safe
#                 to replay), and one missing live stops the run before anything is deployed on top of it; then every
#                 mark is read again and any missing one fails the run (a ledger row never stands in for the schema)
#   3 secrets     one `supabase secrets set --env-file` from a 0600 temp file removed at once; CAREER_BRAIN=agent only
#                 with --brain agent, CAREER_BRAIN=staged only with --brain staged (--brain router unsets it; without
#                 --brain it is not touched)
#   4 deploy      agent-chat from the staged career-only tree (index-career.ts as agent-chat/index.ts, JWT on), then
#                 career-ingest, career-proactive, trainee-deliver, trainee-inbound, trainee-telegram, trainee-whatsapp
#                 with --no-verify-jwt (pg_cron, LoopMessage, Telegram and Meta carry no JWT; each checks its own secret),
#                 all from the staged commit; each deploy writes its ledger row (sha, bundle sha256, platform version)
#   5 schedules   the three pg_cron jobs, each secret passed by env exactly as the script's header says (it goes to Vault);
#                 then ONLY the cron jobs the owner names with --unschedule-cron are unscheduled (an explicit allowlist
#                 of exact job names; by default NO job is removed: scripts/launch/unschedule-legacy-finance.sql)
#   6 smoke       scripts/launch/trainee-smoke.cjs against the live project (waits for each schedule to fire once
#                 unless --no-wait; --allow-send also texts HELP's reply to TRAINEE_SMOKE_CONTACT through LoopMessage)
# --skip-migrations / --skip-deploy skip step 2 / 4; --only-smoke runs only 1 and 6.
# --unschedule-cron <name[,name...]> unschedules exactly those pg_cron jobs in step 5 (exact names, A-Za-z0-9 _ . -; the
#   owner reads cron.job first). Without it step 5 removes nothing, whatever else is scheduled on the project.
# Step 4 never deploys an Upmore-only function: preflight stops if DEPLOY_FNS names one (UPMORE_ONLY_FNS below).
# --dry-run prints every command with each secret as *** and runs nothing (tests/trainee-go-live.test.cjs).
# --non-interactive (or TRAINEE_NON_INTERACTIVE=1; the production workflow passes it): nothing is ever asked and no terminal
#   is opened. Every required value missing (SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SUPABASE_DB_URL, --sha) fails
#   preflight at once, each named. An optional value not given keeps what the project has. The project's secret names are
#   read once (`supabase secrets list`, never printed): a function secret not given that is already set is KEPT, never
#   generated or rotated (its pg_cron job and Vault copy stay as they are, and the smoke skips its gate); one not set is
#   generated, except TRAINEE_INBOUND_SECRET, TELEGRAM_WEBHOOK_SECRET and WHATSAPP_VERIFY_TOKEN, which live outside the
#   project too (LoopMessage's URL, setWebhook, Meta) and so must be given: a generated one could never be shown.
# What each step changes, the rollback and the LoopMessage setup: docs/launch/TRAINEE-GO-LIVE.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

REPO="$(pwd)"
DRY=""; SKIP_MIG=""; SKIP_DEPLOY=""; ONLY_SMOKE=""; BRAIN=""; ALLOW_SEND=""; NOWAIT=""; WANT_SHA=""; VERIFY=""; VERIFY_MODE=""; BUILD_SNAPSHOT=""
NONINT=""; [[ "${TRAINEE_NON_INTERACTIVE:-}" == 1 ]] && NONINT=1
UNSCHEDULE_CRON=""
DEPLOY_LABEL="${TRAINEE_DEPLOY_LABEL:-owner}"
while (( $# )); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --skip-migrations) SKIP_MIG=1 ;;
    --skip-deploy) SKIP_DEPLOY=1 ;;
    --only-smoke) ONLY_SMOKE=1 ;;
    --brain) shift; BRAIN="${1:-}" ;;
    --brain=*) BRAIN="${1#--brain=}" ;;
    --allow-send) ALLOW_SEND=1 ;;
    --no-wait) NOWAIT=1 ;;
    --build-snapshot) BUILD_SNAPSHOT=1 ;;
    --non-interactive) NONINT=1 ;;
    --unschedule-cron) shift; UNSCHEDULE_CRON="${1:-}" ;;
    --unschedule-cron=*) UNSCHEDULE_CRON="${1#--unschedule-cron=}" ;;
    --sha) shift; WANT_SHA="${1:-}" ;;
    --sha=*) WANT_SHA="${1#--sha=}" ;;
    --verify) shift; VERIFY="${1:-}"; VERIFY_MODE=1 ;;
    --verify=*) VERIFY="${1#--verify=}"; VERIFY_MODE=1 ;;
    --label) shift; DEPLOY_LABEL="${1:-}" ;;
    --label=*) DEPLOY_LABEL="${1#--label=}" ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 64 ;;
  esac
  shift
done
[[ -z "$BRAIN" || "$BRAIN" == agent || "$BRAIN" == staged || "$BRAIN" == router ]] || { echo "--brain takes agent, staged or router"; exit 64; }
SHA40_RE='^[0-9a-f]{40}$'; LABEL_RE='^[A-Za-z0-9 ._@:+-]{1,100}$'
[[ "$DEPLOY_LABEL" =~ $LABEL_RE ]] || { echo "--label: 1 to 100 of A-Z a-z 0-9 space . _ @ : + -"; exit 64; }
if [[ -n "$VERIFY_MODE" ]]; then
  [[ "$VERIFY" =~ $SHA40_RE ]] || { echo "--verify takes the full 40-character commit (lowercase hex)"; exit 64; }
  [[ -z "$WANT_SHA$SKIP_MIG$SKIP_DEPLOY$ONLY_SMOKE$BRAIN$ALLOW_SEND" ]] || { echo "--verify reads only: it takes no other option but --dry-run"; exit 64; }
fi

# Every migration from the Trainee set on, in order, each with its proof on the live schema: one object it creates (a
# file runs in one transaction, so one is enough). tests/trainee-go-live.test.cjs fails when a migration file from
# 20261019 on is not listed here, so a new one cannot ship without go-live applying it.
# A mark must survive every later migration: 20261025160000 redefines career_apply_daily_limit and
# career_apply_ledger_refusal, so 20261025140000's mark reads its enqueue (no later file redefines it) and 20261025150000's
# reads PACE_RE in either function (tests/db/rehearse_live_migrations.sh reads every mark after a full apply).
# 20261019020000_site_capture.sql is main's landing-page capture, already live (WO-081): its mark skips it there. Trunk's
# channel delivery moved to 20261019020001 so the two never share a version.
MIGRATIONS=(
  20261019000000_channel_threads.sql
  20261019000001_career_postings.sql
  20261019010000_channel_pending_approvals.sql
  20261019010001_career_alerts.sql
  20261019020000_site_capture.sql
  20261019020001_channel_delivery.sql
  20261019030000_channel_inbound.sql
  20261020000000_channel_artifacts.sql
  20261020000001_career_apply_jobs.sql
  20261020010000_career_apply_own_worker.sql
  20261020010001_extension_submission_reports.sql
  20261020020000_career_apply_receipts.sql
  20261020030000_career_apply_cards.sql
  20261020040000_career_apply_card_push.sql
  20261020050000_career_apply_daily_limit.sql
  20261020060000_career_apply_questions.sql
  20261020070000_career_apply_questions_ai_policy.sql
  20261020100000_career_mail_tracking.sql
  20261020110000_career_connector.sql
  20261020120000_career_events.sql
  20261020120100_career_events_erase.sql
  20261020130000_career_resume_tailoring.sql
  20261021000000_career_apply_extension.sql
  20261021010000_career_outreach.sql
  20261021020000_career_voice_mock.sql
  20261021030000_career_hired_backgrounds.sql
  20261021050000_career_brief_digest.sql
  20261021070000_channel_parity.sql
  20261021075000_career_apply_ops.sql
  20261021080000_career_apply_cloud.sql
  20261021090000_career_mail_erase.sql
  20261021100000_career_proactive_last_word.sql
  20261021110000_career_board_state.sql
  20261021120000_career_apply_form_answers.sql
  20261021130000_career_mail_model_calls.sql
  20261021220430_career_apply_message_cards.sql
  20261022100000_career_apply_wanted.sql
  20261022110000_career_postings_pay.sql
  20261022120000_career_control_state.sql
  20261022120500_career_deploy_ledger.sql
  20261022150000_career_apply_authority.sql
  20261023100000_career_events_apply_queued.sql
  20261024090000_career_apply_agent_submit.sql
  20261024100000_career_apply_agent_contract.sql
  20261024110000_career_apply_cloud_ask.sql
  20261024120000_career_apply_cloud_gate_waiver.sql
  20261024130000_career_apply_card_cloud_bridge.sql
  20261024140000_career_batch_approve_exclude.sql
  20261025100000_career_apply_one_ledger.sql
  20261025110000_career_apply_bridge_reconcile.sql
  20261025120000_career_apply_prepare_ahead.sql
  20261025130000_career_apply_wanted_candidates.sql
  20261025140000_career_apply_no_volume_ceiling.sql
  20261025150000_career_apply_pace_parse.sql
  20261025160000_career_apply_pace_state.sql
  20261025170000_career_apply_card_yes_window.sql
  20261025180000_career_outbox_card_id.sql
  20261026060006_career_more_providers.sql
  20261026060106_career_ingest_runs.sql
  20261026070007_career_alert_min_fit.sql
  20261026080008_career_mail_drafts_sent.sql
  20261026090009_career_account_memory.sql
  20261026100000_career_apply_cloud_runner.sql
  20261026100001_career_apply_want_guard.sql
  20261026120018_career_resume_one_record.sql
  20261026140000_career_apply_receipt_store.sql
  20261026200011_google_disconnect_erase.sql
  20261026210016_career_resume_required.sql
  20261026210017_career_resume_on_file_one_record.sql
  20261026220016_channel_telegram_login.sql
  20261026230017_career_cloud_hosted_apply.sql
  20261026230100_career_erase_complete.sql
  20261026230300_career_turn_gate.sql
  20261026230400_career_kb_postings_recency_index.sql
  20261026230500_definer_execute_lockdown.sql
  20261027010000_career_people.sql
  20261027020000_career_intro_reminder_push.sql
  20261027140000_career_apply_host_backoff.sql
  20261027141000_career_apply_mass_submit.sql
  20261027160000_career_outreach_followup_claim.sql
  20261027160100_career_account_contacts.sql
  20261027170000_career_people_scale.sql
  20261027170100_career_people_gmail_sweep.sql
  20261027200000_career_send_queue.sql
  20261027210000_career_people_provider.sql
  20261027230000_career_outlook_connector.sql
  20261027240000_career_outreach_replies.sql
  20261028050000_agent_turn_costs_always_recorded.sql
  20261028070000_global_daily_model_budget.sql
  20261028110000_career_connector_framework.sql
  20261028120000_career_apply_host_gate.sql
  20261028130000_billing_cancel_at_period_end.sql
  20261028180000_career_apply_vm_worker.sql
  20261029100000_career_outreach_reply_rules.sql
  20261029160000_career_email_format_guards.sql
  20261029170000_career_resume_on_file_quarantine.sql
  20261029180000_career_apply_refusal_requeue.sql
  20261029190000_career_apply_unstarted_requeue.sql
  20261029200000_career_connector_disconnect_rules.sql
  20261029230000_trainee_file_sessions.sql
  20261030000000_career_outbox_parts_order.sql
  20261030010000_career_apply_card_confirm.sql
  20261030020000_billing_webhook_sync.sql
  20261030030000_career_ingest_bounded.sql
  20261030040000_career_send_claim_guards.sql
  20261030050000_account_erase_r2.sql
  20261030060000_career_resume_confirm_atomic.sql
  20261030070000_proactive_r2.sql
  20261030080000_career_evidence_every_confirmation.sql
  20261030090000_career_outreach_stop_address.sql
  20261030100000_channel_delivery_r2.sql
  20261030110000_career_ingest_r2.sql
  20261030120000_channel_identity.sql
  20261030130000_billing_r2.sql
  20261030140000_career_apply_submit_worker.sql
  20261030150000_career_ingest_reread_gap.sql
  20261030160000_referral_credit_service_only.sql
  20261030180000_career_alert_no_weekly_cap.sql
  20261030190000_approval_rate.sql
  20261031000000_career_apply_cloud_authorize_closed.sql
  20261031010000_clock_sweep.sql
  20261031020000_career_outreach_r3.sql
  20261031030000_telegram_link_code_kept.sql
  20261031040000_telegram_link_confirm.sql
  20261031050000_career_account_memory_one_copy.sql
  20261031070000_career_resume_upload_resend.sql
)
MIGRATION_MARK=(
  "to_regclass('public.channel_threads') is not null"
  "to_regclass('public.career_ingest_state') is not null"
  "to_regclass('public.channel_pending_approvals') is not null"
  "to_regclass('public.career_proactive_runs') is not null"
  "to_regclass('public.site_waitlist') is not null and to_regclass('public.site_careers_applications') is not null and exists (select 1 from storage.buckets where id = 'careers-resumes')"
  "exists (select 1 from pg_proc where proname = 'career_outbox_contacts_on')"
  "exists (select 1 from pg_proc where proname = 'career_outbox_claim_key')"
  "to_regclass('public.channel_artifacts') is not null"
  "to_regclass('public.career_apply_jobs') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_claim_own')"
  "to_regclass('public.extension_submission_reports') is not null"
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_proactive_runs' and column_name = 'receipts')"
  "to_regclass('public.career_apply_cards') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_card_push_for')"
  "exists (select 1 from pg_proc where proname = 'career_apply_daily_limit')"
  "to_regclass('public.career_apply_questions') is not null"
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_apply_questions' and column_name = 'ai_policy')"
  "to_regclass('public.career_mail_events') is not null"
  "to_regclass('public.connector_intros') is not null"
  "to_regclass('public.career_events') is not null"
  "exists (select 1 from pg_proc where proname = 'career_host_commit' and prosrc like '%career_events%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_resume_tag')"
  "exists (select 1 from pg_proc where proname = 'career_apply_extension_begin_own')"
  "exists (select 1 from pg_proc where proname = 'career_outreach_claim')"
  "exists (select 1 from pg_proc where proname = 'career_voice_create')"
  "to_regclass('public.career_pdl_calls') is not null"
  "exists (select 1 from pg_proc where proname = 'career_host_commit' and prosrc like '%career_interviews%')"
  "exists (select 1 from pg_proc where proname = 'channel_link_nonce_redeem')"
  "exists (select 1 from pg_proc where proname = 'career_apply_gate_status')"
  "exists (select 1 from pg_proc where proname = 'career_apply_cloud_open')"
  "exists (select 1 from pg_proc where proname = 'career_mail_on_erase')"
  "exists (select 1 from pg_proc where proname = 'career_outbox_to_thread')"
  "to_regclass('public.career_board_state') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_questions_answer_from_form_own')"
  "exists (select 1 from pg_proc where proname = 'career_mail_model_claim')"
  "to_regclass('public.career_apply_message_cards') is not null"
  "to_regclass('public.career_apply_wanted') is not null"
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_postings' and column_name = 'pay')"
  "exists (select 1 from pg_proc where proname = 'career_quiet_users')"
  "to_regclass('public.career_deploy_ledger') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_sweep_stale')"
  "exists (select 1 from pg_constraint where conname = 'career_events_kind_check' and pg_get_constraintdef(oid) like '%apply_queued%')"
  "to_regclass('public.career_apply_batch_approvals') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_extension_begin_agent_own' and prosrc like '%agent contract%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_cloud_ask')"
  "to_regclass('public.career_apply_cloud_gate_waivers') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_message_cloud_authorize')"
  "exists (select 1 from pg_proc where proname = 'career_batch_turn_commit_v1' and prosrc like '%exclude_keys%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_ledger')"
  "exists (select 1 from pg_proc where proname = 'career_apply_reconcile_bridge')"
  "to_regclass('public.career_apply_prepare_attempts') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_prepare_candidates' and prosrc like '%career_apply_wanted%')"
  "(exists (select 1 from pg_proc where proname = 'career_apply_enqueue' and prosrc like '%ledger_refusal(u, p_payload->>%, null, now(), null)%')) or (exists (select 1 from pg_proc where proname = 'career_apply_mass_submit_install') and to_regclass('public.career_apply_claim_turns') is not null)"
  "exists (select 1 from pg_proc where proname in ('career_apply_daily_limit', 'career_apply_pace_state') and prosrc like '%PACE_RE%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_pace_set')"
  "exists (select 1 from pg_proc where proname = 'career_apply_card_answer_for' and prosrc like '%card_stale%')"
  "exists (select 1 from information_schema.columns where table_name = 'career_outbox' and column_name = 'card_id')"
  "exists (select 1 from pg_constraint where conname = 'career_board_state_provider_check' and pg_get_constraintdef(oid) like '%workday%')"
  "to_regclass('public.career_ingest_runs') is not null and exists (select 1 from pg_proc where proname = 'career_ingest_coverage')"
  "exists (select 1 from pg_constraint where conname = 'career_alert_prefs_min_fit')"
  "exists (select 1 from information_schema.columns where table_name = 'career_mail_drafts' and column_name = 'outreach_draft')"
  "exists (select 1 from pg_proc where proname = 'career_host_commit' and prosrc like '%invalid account memory%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_cloud_dispatch_claim')"
  "(exists (select 1 from pg_proc where proname = 'career_apply_want_put_for' and prosrc like '%company_cooldown%')) or (exists (select 1 from pg_proc where proname = 'career_apply_mass_submit_install') and to_regclass('public.career_apply_claim_turns') is not null)"
  "to_regclass('public.career_resume_record') is not null and exists (select 1 from pg_trigger where tgname = 'career_resume_from_event') and exists (select 1 from pg_trigger where tgname = 'career_resume_jobs_guard')"
  "to_regclass('public.career_apply_receipt_files') is not null"
  "exists (select 1 from pg_trigger where tgname = 'user_oauth_connections_google_erase')"
  "to_regclass('public.career_resume_uploads') is not null and exists (select 1 from pg_trigger where tgname = 'career_apply_jobs_resume_guard') and exists (select 1 from pg_proc where proname = 'career_resume_ok') and exists (select 1 from pg_proc where proname = 'career_apply_card_answer_for' and prosrc like '%no_resume%')"
  "exists (select 1 from pg_proc where proname = 'career_resume_on_file' and prosrc like '%career_resume_rule_on%' and prosrc like '%career_resume_record%')"
  "to_regclass('public.channel_telegram_logins') is not null and exists (select 1 from pg_proc where proname = 'channel_telegram_link_as')"
  "exists (select 1 from pg_proc where proname = 'career_apply_cloud_dispatch_claim2') and to_regclass('public.career_apply_prepare_requests') is not null"
  "exists (select 1 from pg_proc where proname = 'career_erase_person') and exists (select 1 from pg_constraint where conname = 'extension_submission_reports_user_fk')"
  "to_regclass('public.career_turn_gate') is not null and exists (select 1 from pg_proc where proname = 'career_turn_gate_ready')"
  "to_regclass('public.career_kb_postings_posted_at_recent') is not null"
  "not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and ((p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')) or (p.proname in ('exec_vault_read', 'plaid_month_spend') and has_function_privilege('authenticated', p.oid, 'EXECUTE'))))"
  "to_regclass('public.career_intro_requests') is not null"
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_proactive_runs' and column_name = 'intro_reminders')"
  "to_regclass('public.career_apply_host_backoff') is not null"
  "exists (select 1 from pg_proc where proname = 'career_apply_mass_submit_install') and to_regclass('public.career_apply_claim_turns') is not null"
  "exists (select 1 from pg_proc where proname = 'career_outreach_followups_claim') and to_regclass('public.career_watch_kv_followups_due') is not null"
  "to_regclass('public.career_account_contacts') is not null and exists (select 1 from pg_proc where proname = 'career_account_contacts_put')"
  "to_regprocedure('public.career_people_import_part(uuid,text,text,text,jsonb,integer,integer,boolean,bigint)') is not null and to_regclass('public.agent_flow_state_user') is not null"
  "to_regclass('public.career_people_gmail_sweeps') is not null and exists (select 1 from pg_proc where proname = 'career_people_sweep_claim')"
  "to_regclass('public.career_send_queue') is not null and exists (select 1 from pg_proc where proname = 'career_send_complete_one') and exists (select 1 from pg_trigger where tgname = 'user_oauth_connections_send_rail')"
  "to_regclass('public.career_provider_jobs') is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_people' and column_name = 'sendable')"
  "to_regclass('public.career_outlook_sends') is not null and exists (select 1 from pg_proc where proname = 'career_outlook_claim') and exists (select 1 from pg_trigger where tgname = 'user_oauth_connections_outlook_erase')"
  "to_regclass('public.career_outreach_turns') is not null and exists (select 1 from pg_proc where proname = 'career_outreach_action_claim' and prosrc like '%skip locked%')"
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agent_turn_costs' and column_name = 'meter_state')"
  "to_regclass('public.model_budget_days') is not null and to_regclass('public.model_budget_reservations') is not null and exists (select 1 from pg_proc where proname = 'model_budget_reserve')"
  "to_regclass('public.career_parked_tasks') is not null and to_regclass('public.career_connector_links') is not null and exists (select 1 from pg_proc where proname = 'career_parked_due') and exists (select 1 from pg_trigger where tgname = 'user_oauth_connections_connector_cancel')"
  "exists (select 1 from pg_proc where proname = 'career_apply_host_backoff_get' and prosrc like '%scope = ''cloud''%')"
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_subscriptions' and column_name = 'cancel_at_period_end')"
  "exists (select 1 from pg_proc where proname = 'career_apply_vm_claim') and exists (select 1 from pg_proc where proname = 'career_apply_vm_approval_refusal')"
  "exists (select 1 from pg_proc where proname = 'career_outreach_reply_apply' and prosrc like '%(2) A follow-up of this person''s already queued%') and exists (select 1 from pg_proc where proname = 'career_outreach_rail_takeback' and prosrc like '%(3) What the rail itself already cancelled%')"
  "exists (select 1 from pg_proc where proname = 'career_email_is_webmail') and exists (select 1 from pg_proc where proname = 'career_email_is_role')"
  "exists (select 1 from pg_proc where proname = 'career_resume_on_file' and prosrc like '%owner-delegated%')"
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_apply_jobs' and column_name = 'not_before') and exists (select 1 from pg_proc where proname = 'career_apply_requeue_refused_for') and exists (select 1 from pg_trigger where tgname = 'career_apply_jobs_not_before') and exists (select 1 from pg_proc where proname = 'career_apply_jobs_fixed' and prosrc like '%career.apply_requeue%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_requeue_unstarted_for') and exists (select 1 from pg_proc where proname = 'career_apply_requeue_unstarted_own')"
  "exists (select 1 from pg_proc where proname = 'career_send_go') and exists (select 1 from pg_proc where proname = 'career_connector_waiting')"
  "to_regclass('public.trainee_file_sessions') is not null and to_regclass('public.trainee_file_logins') is not null and exists (select 1 from pg_proc where proname = 'trainee_file_login_count') and exists (select 1 from pg_proc where proname = 'trainee_file_sessions_revoke_all')"
  "exists (select 1 from pg_proc where proname = 'career_outbox_claim' and prosrc like '%e.id not in (select x.id from cand x)%') and exists (select 1 from pg_proc where proname = 'career_outbox_claim_user' and prosrc like '%e.id not in (select x.id from cand x)%') and exists (select 1 from pg_constraint where conname = 'career_outbox_part' and pg_get_constraintdef(oid) not like '%<= 50%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_card_confirm_for') and exists (select 1 from pg_proc where proname = 'career_apply_card_confirm_as')"
  "exists (select 1 from pg_proc where proname = 'billing_sync_subscription') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_subscriptions' and column_name = 'stripe_synced_at')"
  "exists (select 1 from pg_proc where proname = 'career_postings_known') and exists (select 1 from pg_class where relname = 'career_postings_search' and reloptions::text like '%fastupdate=off%') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_ingest_runs' and column_name = 'status') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_board_state' and column_name = 'pass_offset')"
  "exists (select 1 from pg_proc where proname = 'career_send_claim' and prosrc like '%approval lapsed (more than 7 days)%' and prosrc like '%''sequence''%')"
  "exists (select 1 from pg_proc where proname = 'oauth_vault_refresh') and exists (select 1 from pg_proc where proname = 'career_account_gone') and exists (select 1 from pg_proc where proname = 'career_connection_switched') and to_regclass('public.account_deletion_log') is not null"
  "exists (select 1 from pg_proc where proname = 'career_host_commit_evidenced' and prosrc like '%evidence without state%')"
  "exists (select 1 from pg_proc where proname = 'career_alert_enqueue') and exists (select 1 from pg_proc where proname = 'channel_template_claim') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_outbox' and column_name = 'held_at') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_interviews' and column_name = 'cancelled_at')"
  "exists (select 1 from pg_proc where proname = 'career_host_commit_evidenced' and prosrc like '%or stated fact this commit saves%')"
  "exists (select 1 from pg_proc where proname = 'career_send_stop_address') and exists (select 1 from pg_proc where proname = 'career_provider_candidates' and prosrc like '%as blocked%') and exists (select 1 from pg_proc where proname = 'career_send_complete_one' and prosrc like '%stopped by you%')"
  "exists (select 1 from pg_proc where proname = 'career_outbox_reroute') and exists (select 1 from pg_proc where proname = 'career_outbox_fail_sent') and exists (select 1 from pg_proc where proname = 'channel_wa_number_moved') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_outbox' and column_name = 'sent_parts')"
  "exists (select 1 from pg_proc where proname = 'career_board_state_claim') and exists (select 1 from pg_trigger where tgname = 'career_postings_closed_apply' and tgrelid = 'public.career_postings'::regclass)"
  "exists (select 1 from pg_proc where proname = 'channel_refused_before') and exists (select 1 from pg_proc where proname = 'channel_link_pending') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'channel_contacts' and column_name = 'refused_at')"
  "exists (select 1 from pg_proc where proname = 'billing_sync_subscription' and pronargs = 13) and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_subscriptions' and column_name = 'live_subscriptions')"
  "exists (select 1 from pg_proc where proname = 'career_apply_close_unsendable') and exists (select 1 from pg_proc where proname = 'career_apply_submit_worker_install') and exists (select 1 from pg_proc where proname = 'career_apply_confirm_as' and prosrc like '%''driving''%')"
  "exists (select 1 from pg_proc where proname = 'career_board_state_claim' and pronargs = 4 and pg_get_functiondef(oid) like '%p_reread_gap_ms%')"
  "exists (select 1 from pg_proc where proname = 'credit_pending_referral' and pg_get_functiondef(oid) like '%service-role only%')"
  "exists (select 1 from pg_proc where proname = 'career_alert_enqueue' and prosrc not like '%max_per_week%' and prosrc not like '%week_cap%' and prosrc not like '%p_week_since%' and prosrc like '%today >= cap%')"
  "to_regclass('public.approval_rate_v') is not null and exists (select 1 from pg_proc where proname = 'approval_rate') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'career_outreach_drafts' and column_name = 'accepted_unchanged_at')"
  "exists (select 1 from pg_proc where proname = 'career_apply_cloud_authorize_closed_install') and exists (select 1 from pg_proc where proname = 'career_apply_reconcile_bridge' and prosrc like '%career_apply_cloud_authorize_closed_install%')"
  "exists (select 1 from pg_proc where proname = 'career_apply_card_open_for' and pg_get_functiondef(oid) like '%least(p_now, now())%')"
  "exists (select 1 from pg_proc where proname = 'career_send_go' and pg_get_functiondef(oid) like '%career_send_bad_addresses%')"
  "exists (select 1 from pg_proc where proname = 'channel_link_nonce_redeem' and prosrc like '%the code stays unused%')"
  "exists (select 1 from pg_proc where proname = 'channel_link_nonce_ask') and exists (select 1 from pg_proc where proname = 'channel_link_code_pending') and exists (select 1 from pg_proc where proname = 'channel_link_confirm' and prosrc like '%ambiguous%') and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'channel_link_requests' and column_name = 'by_code')"
  "exists (select 1 from pg_trigger where tgname = 'career_account_memory_one_copy' and tgrelid = 'public.agent_flow_state'::regclass)"
  "exists (select 1 from pg_proc where proname = 'career_resume_upload_record_as' and prosrc like '%greatest(now(), public.career_resume_uploads.created_at)%')"
)
# The career chat (agent-chat's career entry) already reads these; checked, never applied here.
EARLIER=(20261015010000_career_knowledge_base.sql 20261015020000_career_watch_kv.sql 20261015234000_career_task_intents_v1.sql
  20261016010000_career_batch_intents_v1.sql 20261016120000_career_account_stated_facts.sql)
EARLIER_MARK=("to_regclass('public.career_kb_roles') is not null"
  "to_regclass('public.career_reminder_outbox') is not null"
  "to_regclass('public.career_task_intents_v1') is not null"
  "to_regclass('public.career_batch_ledgers_v1') is not null"
  "exists (select 1 from pg_proc where proname = 'career_host_commit' and prosrc like '%stated_facts%')")
SCHEDULED=(career-ingest career-proactive trainee-deliver trainee-inbound)
SCHED_VARS=(CAREER_INGEST_SECRET CAREER_PROACTIVE_SECRET TRAINEE_DELIVER_SECRET TRAINEE_INBOUND_SECRET)
# WO-038: the Telegram and WhatsApp webhooks (deployed always; without their secrets they answer 503 NOT_WIRED).
CHANNEL_FNS=(trainee-telegram trainee-whatsapp)
# M4: the Outlook connect link and Microsoft's redirect (public: the one-time link, the signed state and the jobs secret
# authenticate; without MICROSOFT_OAUTH_CLIENT_ID it answers "not switched on" and connects nothing).
OAUTH_FNS=(outlook-oauth)
CHANNEL_HIDDEN=(TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET WHATSAPP_TOKEN WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN)
CHANNEL_PLAIN=(TELEGRAM_BOT_USERNAME WHATSAPP_PHONE_NUMBER_ID WHATSAPP_TEMPLATE_UPDATES WHATSAPP_TEMPLATE_LANGUAGE WHATSAPP_DAILY_TEMPLATES)
# Every function step 4 deploys, in its order: the provenance manifest hashes each, the ledger records each.
# FEATURE 16: Telegram's login, verified, links a chat to the signed-in person; it takes the person's own session (JWT on).
JWT_FNS=(trainee-telegram-link)
# FEATURE 17: the cloud runner (sending and preparation), deployed always; without its secrets it answers 503 not configured.
CLOUD_FN=career-cloud-runner
CLOUD_HIDDEN=(CLOUD_RUNNER_SECRET CLOUD_DISPATCH_SECRET CAREER_PREPARE_AHEAD_TOKEN VERCEL_TOKEN)
CLOUD_PLAIN=(VERCEL_TEAM_ID VERCEL_PROJECT_ID CLOUD_SANDBOX_SNAPSHOT_ID CLOUD_MAX_CONCURRENT CLOUD_MAX_PER_PORTAL CLOUD_MAX_STARTS_PER_TICK
  CLOUD_MAX_PER_PERSON_DAY CLOUD_MAX_PER_SITE_MINUTE CLOUD_PREPARE_MAX_CONCURRENT CLOUD_PREPARE_STARTS_PER_TICK CLOUD_PREPARE_PER_PERSON_DAY
  CLOUD_PREPARE_PER_SITE_MINUTE CLOUD_RUNNER_ENABLED CLOUD_PREPARE_ENABLED)
# The runner's infrastructure sizing, set by name when not given. No per-person or per-site number (NO LIMITS, 2026-10-27).
declare -A CLOUD_WAVE1=([CLOUD_MAX_CONCURRENT]=2 [CLOUD_MAX_PER_PORTAL]=1 [CLOUD_MAX_STARTS_PER_TICK]=2
  [CLOUD_PREPARE_MAX_CONCURRENT]=2 [CLOUD_PREPARE_STARTS_PER_TICK]=2)
# Mass networking (lane M1): the sending rail's sender, started by pg_cron (trainee-career-send) with the proactive
# secret; it sends nothing until CAREER_SEND_RAIL=on is set (docs/architect/OUTREACH-SEND-2026-10-27.md).
SEND_FNS=(career-send)
DEPLOY_FNS=(agent-chat "${SCHEDULED[@]}" career-voice "${CHANNEL_FNS[@]}" "${JWT_FNS[@]}" "${OAUTH_FNS[@]}" "${SEND_FNS[@]}" "$CLOUD_FN")
# Secret-gated, public (verify_jwt = false) functions, each deployed only when its secret is among the project's function
# secrets (in a dry run: given in the environment). Absent secret: skipped with a log line, never a failure. Nothing here
# sets the secret. gate_fns (run by make_manifest) appends the enabled ones to DEPLOY_FNS and GATED_ON.
GATED=(trainee-file:TRAINEE_FILE_LINK_SECRET ops-monitor:OPS_MONITOR_TOKEN)
GATED_ON=(); GATED_DONE=""
# The Upmore finance functions still in supabase/functions. Trainee never deploys them (production stops drifting toward
# the finance app); retiring them on the live project is the owner's decision (docs/architect/REMOVAL-LIST-2026-10-28.md).
UPMORE_ONLY_FNS=(agent-exec agent-message-inbound agent-message-turn agent-message-worker agent-payments agent-proactive
  agent-workflows broker-oauth-callback broker-oauth-start cancel-watcher exec-vault-store manual-connect news-feed plaid
  plaid-sync simplefin-claim simplefin-proxy stripe-checkout stripe-credits stripe-webhook)
[[ -z "$UNSCHEDULE_CRON" || "$UNSCHEDULE_CRON" =~ ^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$ ]] || { echo "--unschedule-cron takes exact job names, comma-separated (A-Za-z0-9 _ . -)"; exit 64; }
for fn in "${DEPLOY_FNS[@]}"; do
  [[ " ${UPMORE_ONLY_FNS[*]} " != *" $fn "* ]] || { echo "go-live: $fn is an Upmore finance function; Trainee never deploys it"; exit 64; }
done
LEGACY_CRON_SQL=scripts/launch/unschedule-legacy-finance.sql
# WO-093: what is staged from `git archive <sha>`: everything a deploy, a migration, a schedule or the smoke reads.
STAGE_PATHS=(supabase scripts packages corpus)
PROV="$REPO/scripts/launch/deploy-provenance.cjs"

CUR=""; REPORTED=""; ENVF=""; STAGE=""; WORK=""
cleanup() {
  local rc=$?
  [[ -n "$ENVF" ]] && rm -f "$ENVF"
  [[ -n "$STAGE" ]] && rm -rf "$STAGE"
  [[ -n "$WORK" ]] && { cd / && rm -rf "$WORK"; }
  if (( rc != 0 )) && [[ -n "$CUR" && -z "$REPORTED" ]]; then echo "STEP $CUR: FAILED (exit $rc)"; fi
}
trap cleanup EXIT
step() { CUR="$1"; echo; echo "STEP $1"; }
ok() { echo "STEP $CUR: OK"; CUR=""; }
skipped() { echo; echo "STEP $1: SKIPPED ($2)"; }
fail() { echo "STEP $CUR: FAILED: $1"; REPORTED=1; exit 1; }

# Every value that must never be shown. Command output passes through mask(), so a value echoed back by an error (psql
# prints the failing statement, with the secret the schedule script interpolated) never reaches the terminal or the log.
mask_values() {
  local v
  for v in SUPABASE_ACCESS_TOKEN SUPABASE_DB_URL CAREER_INGEST_SECRET CAREER_PROACTIVE_SECRET TRAINEE_DELIVER_SECRET TRAINEE_INBOUND_SECRET \
    LOOPMESSAGE_API_KEY OPENAI_API_KEY UPMORE_TEST_JWT TRAINEE_ALLOWED_CONTACTS TRAINEE_SMOKE_CONTACT INGEST_CONTACT_EMAIL PDL_API_KEY \
    TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET WHATSAPP_TOKEN WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN \
    CLOUD_RUNNER_SECRET CLOUD_DISPATCH_SECRET CAREER_PREPARE_AHEAD_TOKEN VERCEL_TOKEN CAREER_PREPARE_AHEAD_URL; do
    [[ -n "${!v:-}" ]] && printf '%s\n' "${!v}"
  done
  # The database password on its own too (an error may print the URL's parts, never the whole URL).
  if [[ "${SUPABASE_DB_URL:-}" =~ $DB_PASS_RE ]]; then printf '%s\n' "${BASH_REMATCH[1]}"; fi
  return 0
}
mask() {
  TGL_MASK="$(mask_values)" awk 'BEGIN { n = split(ENVIRON["TGL_MASK"], s, "\n") }
    { for (i = 1; i <= n; i++) if (length(s[i]) >= 4) while ((p = index($0, s[i])) > 0) $0 = substr($0, 1, p - 1) "***" substr($0, p + length(s[i]))
      print; fflush() }'
}
# run "<what is printed, secrets as ***>" command...: printed always, run only for real.
run() {
  local shown="$1"; shift
  if [[ -n "$DRY" ]]; then echo "DRY: $shown"; return 0; fi
  echo "  > $shown"
  "$@" 2>&1 | mask
}

have_tty() { [[ -z "$DRY" && -z "$NONINT" ]] && { : </dev/tty; } 2>/dev/null; }
# ask VAR "prompt" hidden|plain [required]: only when VAR is empty and this is a real run; the value stays in this
# process. With no terminal to ask on, an optional one is taken as Enter and a required one stops the run.
# --non-interactive never asks: a required one stops the run by name, an optional one keeps what the project has.
ask() {
  local v="$1" p="$2" how="$3" req="${4:-}"
  [[ -n "${!v:-}" || -n "$DRY" ]] && return 0
  if [[ -n "$NONINT" ]]; then
    [[ -z "$req" ]] || fail "$v is required and not set (--non-interactive asks nothing: set it in the environment)"
    echo "  not given: $v (--non-interactive: what the project has stays)"; return 0
  fi
  if ! have_tty; then
    [[ -z "$req" ]] || fail "$v is not set and there is no terminal to ask on"
    echo "  no terminal: $v taken as Enter"; return 0
  fi
  printf '%s: ' "$p" >/dev/tty
  if [[ "$how" == hidden ]]; then IFS= read -rs "$v" </dev/tty; printf '\n' >/dev/tty; else IFS= read -r "$v" </dev/tty; fi
  return 0
}
# --non-interactive: the project's secret names, read once (names and digests only; never printed).
LIVE_SECRETS=""; LIVE_READ=""
live_has() {
  if [[ "$LIVE_READ" != 1 ]]; then
    LIVE_SECRETS="$(supabase secrets list --project-ref "$REF" 2>/dev/null)" \
      || fail "could not read the project's secret names (supabase secrets list --project-ref $REF; check SUPABASE_ACCESS_TOKEN): nothing is generated without knowing what is set"
    LIVE_READ=1
  fi
  grep -qw -- "$1" <<<"$LIVE_SECRETS"
}
# Generated in --non-interactive mode only when the project has none, and never for one that lives outside the project.
OUTSIDE=(TRAINEE_INBOUND_SECRET TELEGRAM_WEBHOOK_SECRET WHATSAPP_VERIFY_TOKEN)
KEEP_LIVE=()
nonint_absent() { # nonint_absent VAR: kept (0) when the project has it; generate (1) when not; fails for an OUTSIDE one
  local v="$1" o
  if live_has "$v"; then KEEP_LIVE+=("$v"); echo "  kept: $v (not given; set on the project, so it is neither generated nor rotated)"; return 0; fi
  for o in "${OUTSIDE[@]}"; do
    [[ "$o" == "$v" ]] && fail "$v is not given and not set on the project; --non-interactive never generates it (it also goes into a webhook outside the project, and a generated one could not be shown): set it and re-run"
  done
  return 1
}
gen_secret() { if command -v openssl >/dev/null; then openssl rand -hex 24; else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# A value the env file and a URL both carry safely (dotenv cuts at spaces, quotes and #).
env_safe() { case "$1" in *[[:space:]]*|*\'*|*\"*|*\#*|*\\*) return 1 ;; esac; [[ -n "$1" ]]; }
SECRET_RE='^[A-Za-z0-9._~-]{32,}$'; REF_RE='^[a-z]{20}$'; DB_RE='^postgres(ql)?://'; DB_PASS_RE='^[a-z]+://[^:/@]+:([^@]+)@'

# The live database: one value read with sql_to; a failed read stops the run (the error passes through mask).
P=()
db_init() { export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"; P=(psql "${SUPABASE_DB_URL:-}" -X -q -v ON_ERROR_STOP=1); }
sql_to() { # sql_to VAR "query": one value read from the live database
  local out
  if ! out="$("${P[@]}" -tAc "$2" 2>&1 </dev/null)"; then printf '%s\n' "$out" | mask; fail "a read of the live database failed"; fi
  printf -v "$1" '%s' "$out"
}

# --- WO-093 provenance ------------------------------------------------------------------------------------------------
# stage_commit <sha>: a fresh temp dir holding only `git archive <sha>` (STAGE_PATHS); nothing comes from this checkout.
SRC=""; MANIFEST=""; MANIFEST_SHA256=""; SHIP_SHA=""
stage_commit() {
  local out
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/trainee-go-live-stage.XXXXXX")"; SRC="$WORK/src"; mkdir -p "$SRC"
  echo "  > git archive $1 -- ${STAGE_PATHS[*]} | tar -x into a fresh temp dir ($WORK)"
  if ! out="$( (git archive --format=tar "$1" -- "${STAGE_PATHS[@]}" | tar -x -C "$SRC") 2>&1)"; then
    printf '%s\n' "$out"; fail "git archive $1 could not be staged"
  fi
  [[ -f "$SRC/supabase/config.toml" && -d "$SRC/supabase/functions" ]] || fail "the staged commit $1 has no supabase/ tree"
}
# kind<TAB>file<TAB>mark per migration, in apply order (the earlier ones are only checked, never applied).
migration_list() {
  local i
  for i in "${!EARLIER[@]}"; do printf 'earlier\t%s\t%s\n' "${EARLIER[$i]}" "${EARLIER_MARK[$i]}"; done
  for i in "${!MIGRATIONS[@]}"; do printf 'trainee\t%s\t%s\n' "${MIGRATIONS[$i]}" "${MIGRATION_MARK[$i]}"; done
}
gate_fns() {
  local pair fn var on
  [[ -z "$GATED_DONE" ]] || return 0
  GATED_DONE=1
  for pair in "${GATED[@]}"; do
    fn="${pair%%:*}"; var="${pair##*:}"; on=""
    if [[ -n "$DRY" ]]; then [[ -z "${!var:-}" ]] || on=1
    elif [[ -z "${REF:-}" || "$REF" == "<ref>" ]]; then
      echo "  gated: $fn SKIPPED (secrets list unavailable: no project ref)"; continue
    else
      # A failed listing skips the gated functions (never deployed ungated, never aborts the run).
      if [[ -z "$LIVE_READ" ]]; then
        if LIVE_SECRETS="$(supabase secrets list --project-ref "$REF" 2>/dev/null)"; then LIVE_READ=1; else LIVE_READ=0; fi
      fi
      if [[ "$LIVE_READ" != 1 ]]; then echo "  gated: $fn SKIPPED (secrets list unavailable)"; continue; fi
      grep -qw -- "$var" <<<"$LIVE_SECRETS" && on=1
    fi
    if [[ -n "$on" ]]; then GATED_ON+=("$fn"); DEPLOY_FNS+=("$fn"); echo "  gated: $fn will be deployed ($var is set)"
    else echo "  gated: $fn SKIPPED ($var is not among the function secrets)"; fi
  done
  return 0
}
# make_manifest <sha>: the provenance manifest of the staged commit, printed, with its tsv views for the ledger.
make_manifest() {
  local fns
  gate_fns
  migration_list >"$WORK/migrations.tsv"
  fns="$(IFS=,; echo "${DEPLOY_FNS[*]}")"
  if ! node "$PROV" manifest --stage "$SRC" --sha "$1" --functions "$fns" --migrations "$WORK/migrations.tsv" --out "$WORK/manifest.json" \
    ${VERIFY_MODE:+--allow-absent} >"$WORK/manifest.out" 2>&1; then
    cat "$WORK/manifest.out"; fail "the provenance manifest of $1 could not be computed"
  fi
  node "$PROV" tsv --manifest "$WORK/manifest.json" functions >"$WORK/functions.tsv"
  node "$PROV" tsv --manifest "$WORK/manifest.json" migrations >"$WORK/manifest-migrations.tsv"
  MANIFEST="$WORK/manifest.json"; MANIFEST_SHA256="$(sha256 "$MANIFEST")"
  echo "  PROVENANCE MANIFEST $1 (sha256 $MANIFEST_SHA256):"
  sed 's/^/    /' "$MANIFEST"
  echo "  bundles:"; sed 's/^/    /' "$WORK/functions.tsv"
}
# Every mark read on the live schema; any one missing fails the run, each named (a ledger row never stands in for it).
check_all_marks() {
  local i n=0 live m missing=()
  for i in "${!EARLIER[@]}"; do
    sql_to live "select (${EARLIER_MARK[$i]})"; n=$((n + 1)); [[ "$live" == t ]] || missing+=("${EARLIER[$i]}: ${EARLIER_MARK[$i]}")
  done
  for i in "${!MIGRATIONS[@]}"; do
    sql_to live "select (${MIGRATION_MARK[$i]})"; n=$((n + 1)); [[ "$live" == t ]] || missing+=("${MIGRATIONS[$i]}: ${MIGRATION_MARK[$i]}")
  done
  if (( ${#missing[@]} )); then
    for m in "${missing[@]}"; do echo "  MISSING on the live schema: $m"; done
    fail "${#missing[@]} of $n migration marks are missing on the live project (each listed above); nothing is deployed on a schema without them"
  fi
  echo "  marks: all $n read true on the live project"
}
# One ledger row per migration whose mark was just read true, for this sha.
ledger_migrations() {
  local vals="" f sum rest
  while IFS=$'\t' read -r f sum rest; do
    vals+="${vals:+,}('$SHIP_SHA','migration','$f','$sum','$MANIFEST_SHA256','$DEPLOY_LABEL')"
  done <"$WORK/manifest-migrations.tsv"
  [[ -n "$vals" ]] || fail "the manifest lists no migration"
  if ! "${P[@]}" -c "insert into public.career_deploy_ledger(sha,kind,migration_file,bundle_sha256,manifest_sha256,deployed_by_label) values $vals" 2>&1 | mask; then
    fail "the migration rows of public.career_deploy_ledger were not written"
  fi
  echo "  ledger: $(wc -l <"$WORK/manifest-migrations.tsv" | tr -d ' ') migration rows for $SHIP_SHA"
}
# ledger_function <fn>: its row right after its deploy (the bundle sha256 from the manifest, the platform's version now).
ledger_function() {
  local fn="$1" sum ver
  sum="$(awk -F'\t' -v f="$fn" '$1 == f { print $2 }' "$WORK/functions.tsv")"
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || fail "$fn has no bundle sha256 in the manifest"
  ver="$(supabase functions list --project-ref "$REF" 2>/dev/null | node "$PROV" platform-versions 2>/dev/null | awk -F'\t' -v f="$fn" '$1 == f { print $2 }')" || ver=""
  [[ "$ver" =~ ^[1-9][0-9]*$ ]] || ver=""
  if ! "${P[@]}" -c "insert into public.career_deploy_ledger(sha,kind,function_name,bundle_sha256,platform_version,manifest_sha256,deployed_by_label) values ('$SHIP_SHA','function','$fn','$sum',${ver:-null},'$MANIFEST_SHA256','$DEPLOY_LABEL')" 2>&1 | mask; then
    fail "$fn was deployed but its row in public.career_deploy_ledger was not written"
  fi
  echo "  ledger: $fn at $SHIP_SHA, bundle $sum, platform version ${ver:-not read}"
}

if [[ -z "$DRY" ]]; then
  LOG="${TRAINEE_GO_LIVE_LOG:-$HOME/trainee-go-live-$(date -u +%Y%m%dT%H%M%SZ).log}"
  exec > >(tee -a "$LOG") 2>&1
  echo "log: $LOG (no secret is written to it)"
fi

# ---------------------------------------------------------------------------------------------------------------------
# --verify <sha>: reads only. The manifest of <sha> (staged from git archive, as a deploy would), the latest ledger row
# per function and per migration, and every mark on the live schema; one line per check, exit 1 on any mismatch.
if [[ -n "$VERIFY_MODE" ]]; then
  step "verify $VERIFY"
  for t in git node psql tar; do
    command -v "$t" >/dev/null && continue
    if [[ -n "$DRY" ]]; then echo "  tool $t: missing here (the real run needs it)"; else fail "missing: $t"; fi
  done
  ask SUPABASE_DB_URL "Database connection string (Supabase > Project Settings > Database > URI)" hidden required
  [[ -z "${SUPABASE_DB_URL:-}" || "$SUPABASE_DB_URL" =~ $DB_RE ]] || fail "SUPABASE_DB_URL is not a postgres:// connection string"
  [[ -n "${SUPABASE_DB_URL:-}" || -n "$DRY" ]] || fail "SUPABASE_DB_URL is empty"
  ask SUPABASE_PROJECT_REF "Supabase project ref (Enter to skip the platform version check)" hidden
  REF="${SUPABASE_PROJECT_REF:-}"
  [[ -z "$REF" || "$REF" =~ $REF_RE ]] || fail "SUPABASE_PROJECT_REF is not a project ref (20 lowercase letters)"
  git cat-file -e "$VERIFY^{commit}" 2>/dev/null || fail "$VERIFY is not a commit in this clone (git fetch origin, then re-run)"
  stage_commit "$VERIFY"; make_manifest "$VERIFY"
  if [[ -n "$DRY" ]]; then
    echo "DRY: psql *** -tA: the latest public.career_deploy_ledger row per function and per migration file"
    echo "DRY: psql *** -tA: every migration mark in the manifest, on the live schema"
    echo "DRY: supabase functions list --project-ref ${REF:-<ref>} (the platform's versions; skipped without a ref)"
    echo "DRY: node scripts/launch/deploy-provenance.cjs compare: exit 1 on any mismatch"
    ok; exit 0
  fi
  db_init
  sql_to has "select to_regclass('public.career_deploy_ledger') is not null"
  : >"$WORK/ledger-functions.txt"; : >"$WORK/ledger-migrations.txt"; : >"$WORK/marks.txt"
  if [[ "$has" == t ]]; then
    sql_to rows "select distinct on (function_name) function_name || '|' || sha || '|' || bundle_sha256 || '|' || to_char(deployed_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') || '|' || coalesce(platform_version::text, '') from public.career_deploy_ledger where kind = 'function' order by function_name, deployed_at desc, id desc"
    printf '%s\n' "$rows" >"$WORK/ledger-functions.txt"
    sql_to rows "select distinct on (migration_file) migration_file || '|' || sha || '|' || bundle_sha256 || '|' || to_char(deployed_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from public.career_deploy_ledger where kind = 'migration' order by migration_file, deployed_at desc, id desc"
    printf '%s\n' "$rows" >"$WORK/ledger-migrations.txt"
  else
    echo "  public.career_deploy_ledger is not on the live project: no deploy is recorded"
  fi
  while IFS=$'\t' read -r f sum mark; do
    sql_to live "select ($mark)"; printf '%s|%s\n' "$f" "$live" >>"$WORK/marks.txt"
  done <"$WORK/manifest-migrations.tsv"
  PLATFORM_ARGS=()
  if [[ -n "$REF" ]] && supabase functions list --project-ref "$REF" 2>/dev/null | node "$PROV" platform-versions >"$WORK/platform.tsv" 2>/dev/null; then
    PLATFORM_ARGS=(--platform "$WORK/platform.tsv")
  fi
  set +e
  node "$PROV" compare --manifest "$MANIFEST" --ledger-functions "$WORK/ledger-functions.txt" --ledger-migrations "$WORK/ledger-migrations.txt" \
    --marks "$WORK/marks.txt" ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} 2>&1 | mask
  code=${PIPESTATUS[0]}
  set -e
  (( code == 0 )) || fail "the live project does not match $VERIFY (each mismatch is listed above)"
  ok
  exit 0
fi

step "1/6 preflight"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"; SHA="${HEAD_SHA:0:8}"; echo "commit $HEAD_SHA"
if [[ -n "$NONINT" ]]; then
  # Every required value at once, each named, before anything else runs.
  NEED=(SUPABASE_PROJECT_REF); [[ -z "$ONLY_SMOKE" ]] && NEED+=(SUPABASE_ACCESS_TOKEN SUPABASE_DB_URL)
  ABSENT=(); for v in "${NEED[@]}"; do [[ -n "${!v:-}" ]] || ABSENT+=("$v"); done
  [[ -z "$ONLY_SMOKE" && -z "$WANT_SHA" ]] && ABSENT+=(--sha)
  [[ -n "$ALLOW_SEND" && -z "${TRAINEE_SMOKE_CONTACT:-}" ]] && ABSENT+=(TRAINEE_SMOKE_CONTACT)
  if (( ${#ABSENT[@]} )); then
    if [[ -n "$DRY" ]]; then echo "  --non-interactive: a real run stops here; not set: ${ABSENT[*]}"
    else fail "--non-interactive: required and not set: ${ABSENT[*]}"; fi
  else echo "  --non-interactive: every required value is set; nothing will be asked"; fi
fi
if [[ -n "$ONLY_SMOKE" ]]; then TOOLS=(node); else TOOLS=(supabase psql node deno git python3 tar); fi
for t in "${TOOLS[@]}"; do
  command -v "$t" >/dev/null && continue
  if [[ -n "$DRY" ]]; then echo "  tool $t: missing here (the real run needs it)"; else fail "missing: $t (brew install supabase/tap/supabase libpq node deno)"; fi
done
ask SUPABASE_PROJECT_REF "Supabase project ref (the 20 letters in https://<ref>.supabase.co)" hidden required
REF="${SUPABASE_PROJECT_REF:-}"
if [[ -z "$REF" ]]; then [[ -n "$DRY" ]] || fail "SUPABASE_PROJECT_REF is empty"; REF="<ref>"
elif [[ ! "$REF" =~ $REF_RE ]]; then fail "SUPABASE_PROJECT_REF is not a project ref (20 lowercase letters)"; fi
BASE="https://$REF.supabase.co"
if [[ -n "$ONLY_SMOKE" ]]; then ask SUPABASE_DB_URL "Database connection string (Enter to skip the run-table checks)" hidden
else ask SUPABASE_DB_URL "Database connection string (Supabase > Project Settings > Database > URI)" hidden required; fi
if [[ -n "${SUPABASE_DB_URL:-}" ]]; then [[ "$SUPABASE_DB_URL" =~ $DB_RE ]] || fail "SUPABASE_DB_URL is not a postgres:// connection string"
elif [[ -z "$ONLY_SMOKE" && -z "$DRY" ]]; then fail "SUPABASE_DB_URL is empty"; fi
if [[ -n "$DRY" ]]; then echo "  tree: $([[ -z "$(git status --porcelain 2>/dev/null)" ]] && echo clean || echo 'has changes (a real run stops on that)')"
elif [[ -z "$ONLY_SMOKE" ]]; then
  [[ -z "$(git status --porcelain)" ]] || fail "the tree has uncommitted changes; go-live ships an exact commit (commit or stash first)"
fi
# WO-093: a run that changes anything ships exactly the commit the owner names, and HEAD must be that commit.
if [[ -z "$ONLY_SMOKE" ]]; then
  if [[ -z "$WANT_SHA" ]]; then
    if [[ -n "$DRY" ]]; then echo "  --sha: not given (a real run stops here: it ships only the exact commit named by --sha)"
    else fail "--sha <40-character commit> is required: go-live ships exactly the commit you name (git rev-parse HEAD prints it)"; fi
  else
    [[ "$WANT_SHA" =~ $SHA40_RE ]] || fail "--sha must be the full 40-character commit in lowercase hex (got ${#WANT_SHA} characters)"
    [[ "$HEAD_SHA" == "$WANT_SHA" ]] || fail "HEAD is $HEAD_SHA, not the --sha $WANT_SHA: check out that exact commit (git checkout --detach $WANT_SHA) and re-run"
    SHIP_SHA="$WANT_SHA"; echo "  --sha: HEAD is $SHIP_SHA"
  fi
fi

GENERATED=()
for v in "${SCHED_VARS[@]}"; do
  if [[ -n "$ONLY_SMOKE" ]]; then ask "$v" "$v (Enter to skip the checks that need it)" hidden
  else ask "$v" "$v (Enter to generate a new 48-character one)" hidden; fi
  if [[ -z "${!v:-}" && -z "$DRY" && -z "$ONLY_SMOKE" ]]; then
    if [[ -n "$NONINT" ]] && nonint_absent "$v"; then continue; fi
    printf -v "$v" '%s' "$(gen_secret)"; GENERATED+=("$v")
  fi
  if [[ -n "${!v:-}" && ! "${!v}" =~ $SECRET_RE ]]; then fail "$v must be 32 or more of A-Z a-z 0-9 . _ ~ - (the value is not shown)"; fi
done
# The inbound secret lives outside this project too: it is in the webhook URL pasted into LoopMessage. Enter on a re-run
# would replace it and every inbound text would then be refused (403) without a sound, so an existing one is replaced
# only on purpose (TRAINEE_ROTATE_INBOUND=1, then paste the new URL into LoopMessage).
if [[ -z "$DRY" && -z "$ONLY_SMOKE" && " ${GENERATED[*]} " == *" TRAINEE_INBOUND_SECRET "* && "${TRAINEE_ROTATE_INBOUND:-}" != 1 ]]; then
  if supabase secrets list --project-ref "$REF" 2>/dev/null | grep -qw TRAINEE_INBOUND_SECRET; then
    fail "TRAINEE_INBOUND_SECRET is already set on the project and LoopMessage's webhook URL carries it: give the same value, or set TRAINEE_ROTATE_INBOUND=1 to replace it and then update the webhook URL"
  fi
fi
if [[ -z "$ONLY_SMOKE" ]]; then
  ask LOOPMESSAGE_API_KEY "LoopMessage API key (Enter to keep the one already set)" hidden
  ask OPENAI_API_KEY "OpenAI key (Enter to keep the one already set)" hidden
  ask INGEST_CONTACT_EMAIL "Contact email the job boards see in the User-Agent (Enter to keep the one already set)" plain
  ask TRAINEE_ALLOWED_CONTACTS "Phone numbers allowed to sign up, comma-separated (Enter to keep what is set)" hidden
  ask LOOPMESSAGE_DAILY_CONTACTS "LoopMessage contacts a day, 300 or 1000 by plan (Enter to keep; unset means 300)" plain
  ask PDL_API_KEY "People Data Labs API key for hired-candidate backgrounds (Enter to keep; without one Trainee says it has no data)" hidden
  # Audit B2 (phone-only preparation): the preparation host's door and its token, once the host is up
  # (docs/launch/CLOUD-RUNNER.md, Preparation host). Optional: without them the chat says nothing is prepared yet.
  ask CAREER_PREPARE_AHEAD_URL "Preparation host URL, https://<host>/prepare (Enter to keep; unset: phone-only preparation stays NOT_WIRED)" plain
  ask CAREER_PREPARE_AHEAD_TOKEN "Preparation host token, the host's own CAREER_PREPARE_AHEAD_TOKEN (Enter to keep)" hidden
  for v in LOOPMESSAGE_API_KEY OPENAI_API_KEY INGEST_CONTACT_EMAIL TRAINEE_ALLOWED_CONTACTS PDL_API_KEY CAREER_PREPARE_AHEAD_URL CAREER_PREPARE_AHEAD_TOKEN; do
    if [[ -n "${!v:-}" ]] && ! env_safe "${!v}"; then fail "$v has a space, quote, # or backslash (the value is not shown)"; fi
  done
  [[ -z "${INGEST_CONTACT_EMAIL:-}" || "$INGEST_CONTACT_EMAIL" == *@* ]] || fail "INGEST_CONTACT_EMAIL is not an email address"
  [[ -z "${CAREER_PREPARE_AHEAD_URL:-}" || "$CAREER_PREPARE_AHEAD_URL" =~ ^https://[^/[:space:]]+(/[^[:space:]]*)?$ ]] || fail "CAREER_PREPARE_AHEAD_URL must be an https URL (the value is not shown)"
  [[ -z "${CAREER_PREPARE_AHEAD_TOKEN:-}" || "$CAREER_PREPARE_AHEAD_TOKEN" =~ $SECRET_RE ]] || fail "CAREER_PREPARE_AHEAD_TOKEN must be 32 or more of A-Z a-z 0-9 . _ ~ - (the value is not shown)"
  # A host URL needs its token. A token alone is the cloud runner's (FEATURE 17): its URL is derived from the project.
  if [[ -n "${CAREER_PREPARE_AHEAD_URL:-}" && -z "${CAREER_PREPARE_AHEAD_TOKEN:-}" ]]; then
    fail "CAREER_PREPARE_AHEAD_URL needs CAREER_PREPARE_AHEAD_TOKEN: give both, or only the token for the cloud runner"
  fi
  [[ -z "${LOOPMESSAGE_DAILY_CONTACTS:-}" || "$LOOPMESSAGE_DAILY_CONTACTS" =~ ^[1-9][0-9]*$ ]] || fail "LOOPMESSAGE_DAILY_CONTACTS must be a whole number of contacts a day"
  # WO-038: Telegram and WhatsApp, each optional (docs/launch/TRAINEE-GO-LIVE.md has where each value comes from).
  ask TELEGRAM_BOT_TOKEN "Telegram bot token from @BotFather (Enter: Telegram stays NOT_WIRED or keeps what is set)" hidden
  ask TELEGRAM_BOT_USERNAME "Telegram bot username, without @ (Enter to keep)" plain
  ask WHATSAPP_TOKEN "WhatsApp permanent system-user token (Enter: WhatsApp stays NOT_WIRED or keeps what is set)" hidden
  ask WHATSAPP_PHONE_NUMBER_ID "WhatsApp phone number ID from WhatsApp Manager > API Setup (Enter to keep)" plain
  ask WHATSAPP_APP_SECRET "Meta app secret, App settings > Basic (Enter to keep)" hidden
  ask WHATSAPP_TEMPLATE_UPDATES "Approved WhatsApp template name, e.g. trainee_updates (Enter to keep; unset: outside the window nothing is sent)" plain
  ask WHATSAPP_TEMPLATE_LANGUAGE "That template's language code (Enter to keep; unset means en_US)" plain
  ask WHATSAPP_DAILY_TEMPLATES "WhatsApp templates a day, your messaging limit (Enter to keep; unset means 250)" plain
  # A webhook secret lives outside this project too (Telegram's setWebhook, Meta's webhook settings): generated only
  # when its channel is being wired now, and never in place of one already set (TRAINEE_ROTATE_CHANNELS=1 replaces it).
  for pair in TELEGRAM_BOT_TOKEN:TELEGRAM_WEBHOOK_SECRET WHATSAPP_TOKEN:WHATSAPP_VERIFY_TOKEN; do
    tok="${pair%%:*}"; v="${pair##*:}"
    [[ -n "${!tok:-}" ]] && ask "$v" "$v (Enter to generate a new 48-character one)" hidden
    if [[ -n "${!tok:-}" && -z "${!v:-}" && -z "$DRY" ]]; then
      if [[ -n "$NONINT" ]] && nonint_absent "$v"; then continue; fi
      if [[ "${TRAINEE_ROTATE_CHANNELS:-}" != 1 ]] && supabase secrets list --project-ref "$REF" 2>/dev/null | grep -qw "$v"; then
        fail "$v is already set on the project and the platform's webhook carries it: give the same value, or set TRAINEE_ROTATE_CHANNELS=1 to replace it and then update the webhook"
      fi
      printf -v "$v" '%s' "$(gen_secret)"; GENERATED+=("$v")
    fi
  done
  [[ -z "${TELEGRAM_WEBHOOK_SECRET:-}" || "$TELEGRAM_WEBHOOK_SECRET" =~ ^[A-Za-z0-9_-]{32,256}$ ]] || fail "TELEGRAM_WEBHOOK_SECRET must be 32 to 256 of A-Z a-z 0-9 _ - (Telegram's rule; the value is not shown)"
  [[ -z "${WHATSAPP_VERIFY_TOKEN:-}" || "$WHATSAPP_VERIFY_TOKEN" =~ ^[A-Za-z0-9_-]{32,}$ ]] || fail "WHATSAPP_VERIFY_TOKEN must be 32 or more of A-Z a-z 0-9 _ - (the value is not shown)"
  [[ -z "${TELEGRAM_BOT_USERNAME:-}" || "$TELEGRAM_BOT_USERNAME" =~ ^@?[A-Za-z0-9_]{5,32}$ ]] || fail "TELEGRAM_BOT_USERNAME is not a bot username"
  [[ -z "${WHATSAPP_PHONE_NUMBER_ID:-}" || "$WHATSAPP_PHONE_NUMBER_ID" =~ ^[0-9]{5,30}$ ]] || fail "WHATSAPP_PHONE_NUMBER_ID is the numeric ID, not the phone number"
  [[ -z "${WHATSAPP_TEMPLATE_UPDATES:-}" || "$WHATSAPP_TEMPLATE_UPDATES" =~ ^[a-z0-9_]{1,512}$ ]] || fail "WHATSAPP_TEMPLATE_UPDATES is not a template name (lowercase letters, digits, _)"
  [[ -z "${WHATSAPP_TEMPLATE_LANGUAGE:-}" || "$WHATSAPP_TEMPLATE_LANGUAGE" =~ ^[a-z]{2,3}(_[A-Z]{2})?$ ]] || fail "WHATSAPP_TEMPLATE_LANGUAGE is not a language code such as en_US"
  [[ -z "${WHATSAPP_DAILY_TEMPLATES:-}" || "$WHATSAPP_DAILY_TEMPLATES" =~ ^[1-9][0-9]*$ ]] || fail "WHATSAPP_DAILY_TEMPLATES must be a whole number of templates a day"
  for v in "${CHANNEL_HIDDEN[@]}"; do
    if [[ -n "${!v:-}" ]] && ! env_safe "${!v}"; then fail "$v has a space, quote, # or backslash (the value is not shown)"; fi
  done
fi
# FEATURE 17: the cloud runner, wired only when its host token is given (or its secret is already on the project).
CLOUD_WIRE=""
if [[ -z "$ONLY_SMOKE" ]]; then
  ask VERCEL_TOKEN "Vercel token scoped to the team, for the cloud runner's sandboxes (Enter: the cloud runner is not wired now)" hidden
  if [[ -n "${VERCEL_TOKEN:-}" || -n "${CLOUD_RUNNER_SECRET:-}" ]]; then CLOUD_WIRE=1; fi
  if [[ -n "$CLOUD_WIRE" ]]; then
    ask VERCEL_TEAM_ID "Vercel team id (team_...)" plain
    ask VERCEL_PROJECT_ID "Vercel project id (prj_...)" plain
    [[ -n "$BUILD_SNAPSHOT" ]] || ask CLOUD_SANDBOX_SNAPSHOT_ID "Runner snapshot id (snap_...; Enter keeps what is set; --build-snapshot builds one)" plain
    for v in CLOUD_RUNNER_SECRET CLOUD_DISPATCH_SECRET CAREER_PREPARE_AHEAD_TOKEN; do
      ask "$v" "$v (Enter to generate a new 48-character one)" hidden
      if [[ -z "${!v:-}" && -z "$DRY" ]]; then
        if [[ -n "$NONINT" ]] && nonint_absent "$v"; then continue; fi
        printf -v "$v" '%s' "$(gen_secret)"; GENERATED+=("$v")
      fi
      if [[ -n "${!v:-}" && ! "${!v}" =~ $SECRET_RE ]]; then fail "$v must be 32 or more of A-Z a-z 0-9 . _ ~ - (the value is not shown)"; fi
    done
    [[ -z "${VERCEL_TEAM_ID:-}" || "$VERCEL_TEAM_ID" =~ ^team_[A-Za-z0-9]{8,64}$ ]] || fail "VERCEL_TEAM_ID is not a team id (team_...)"
    [[ -z "${VERCEL_PROJECT_ID:-}" || "$VERCEL_PROJECT_ID" =~ ^prj_[A-Za-z0-9]{8,64}$ ]] || fail "VERCEL_PROJECT_ID is not a project id (prj_...)"
    [[ -z "${CLOUD_SANDBOX_SNAPSHOT_ID:-}" || "$CLOUD_SANDBOX_SNAPSHOT_ID" =~ ^snap_[A-Za-z0-9]{8,64}$ ]] || fail "CLOUD_SANDBOX_SNAPSHOT_ID is not a snapshot id (snap_...)"
    if [[ -n "${VERCEL_TOKEN:-}" ]] && ! env_safe "$VERCEL_TOKEN"; then fail "VERCEL_TOKEN has a space, quote, # or backslash (the value is not shown)"; fi
    for v in CLOUD_MAX_CONCURRENT CLOUD_MAX_PER_PORTAL CLOUD_MAX_STARTS_PER_TICK CLOUD_MAX_PER_PERSON_DAY CLOUD_MAX_PER_SITE_MINUTE \
      CLOUD_PREPARE_MAX_CONCURRENT CLOUD_PREPARE_STARTS_PER_TICK CLOUD_PREPARE_PER_PERSON_DAY CLOUD_PREPARE_PER_SITE_MINUTE; do
      [[ -z "${!v:-}" || "${!v}" =~ ^[1-9][0-9]{0,8}$ ]] || fail "$v must be a whole number from 1"
    done
    for v in CLOUD_RUNNER_ENABLED CLOUD_PREPARE_ENABLED; do
      [[ -z "${!v:-}" || "${!v}" == on || "${!v}" == off ]] || fail "$v takes on or off"
    done
  else
    echo "  cloud runner: not wired now (VERCEL_TOKEN not given); its function is deployed and answers 503 until it is"
  fi
fi
ask UPMORE_TEST_JWT "Test user JWT for the agent-chat check (Enter to skip that check)" hidden
if [[ -n "$ALLOW_SEND" ]]; then
  ask TRAINEE_SMOKE_CONTACT "Your own phone number for the HELP text (--allow-send texts it)" hidden required
  [[ -n "${TRAINEE_SMOKE_CONTACT:-}" || -n "$DRY" ]] || fail "--allow-send needs TRAINEE_SMOKE_CONTACT, the number the HELP reply goes to"
fi
# WO-093: stage the commit from git archive into a fresh temp dir and work from there for the rest of the run; refuse a
# stale router bundle; print the provenance manifest. (These local steps run in --dry-run too when --sha is given.)
if [[ -z "$ONLY_SMOKE" ]]; then
  if [[ -n "$SHIP_SHA" ]]; then
    stage_commit "$SHIP_SHA"
    for c in "" "--career-only "; do
      echo "  > python3 scripts/build-router-core.py ${c}--check (in the staged commit)"
      if ! out="$(cd "$SRC" && python3 scripts/build-router-core.py $c--check 2>&1)"; then
        printf '%s\n' "$out" | mask
        fail "the router bundle at $SHIP_SHA is stale (python3 scripts/build-router-core.py ${c}--check): rebuild it, commit, and name the new commit"
      fi
      printf '    %s\n' "$out"
    done
    make_manifest "$SHIP_SHA"
    if [[ -z "$DRY" ]]; then
      mkdir -p "$HOME/trainee-provenance"
      KEPT="$HOME/trainee-provenance/manifest-$SHIP_SHA-$(date -u +%Y%m%dT%H%M%SZ).json"
      cp "$MANIFEST" "$KEPT"; echo "  manifest kept: $KEPT"
    fi
    cd "$SRC"
  else
    echo "DRY: git archive <--sha> -- ${STAGE_PATHS[*]} | tar -x into a fresh temp dir; the rest of the run works there"
    echo "DRY: python3 scripts/build-router-core.py --check and --career-only --check in the staged commit (stale stops the run)"
    gate_fns
    echo "DRY: node scripts/launch/deploy-provenance.cjs manifest: the provenance manifest printed and kept in ~/trainee-provenance/"
  fi
fi
if [[ -z "$ONLY_SMOKE" && -z "$SKIP_DEPLOY" ]]; then
  CHECK=(supabase/functions/agent-chat/index-career.ts supabase/functions/career-ingest/index.ts supabase/functions/career-proactive/index.ts
    supabase/functions/trainee-deliver/index.ts supabase/functions/trainee-inbound/index.ts
    supabase/functions/trainee-telegram/index.ts supabase/functions/trainee-whatsapp/index.ts supabase/functions/outlook-oauth/index.ts supabase/functions/career-send/index.ts supabase/functions/career-cloud-runner/index.ts)
  for fn in ${GATED_ON[@]+"${GATED_ON[@]}"}; do CHECK+=("supabase/functions/$fn/index.ts"); done
  run "deno check ${CHECK[*]}" deno check "${CHECK[@]}"
fi
ok

# ---------------------------------------------------------------------------------------------------------------------
if [[ -n "$ONLY_SMOKE" || -n "$SKIP_MIG" ]]; then skipped "2/6 migrations" "$([[ -n "$ONLY_SMOKE" ]] && echo --only-smoke || echo --skip-migrations)"
else
  step "2/6 migrations"
  db_init
  if [[ -n "$DRY" ]]; then
    echo "DRY: psql *** -tA: read the ledger public.upmore_migration_ledger (missing or empty: left alone, apply-rails-and-seed.sh --pending backfills it)"
    for i in "${!EARLIER[@]}"; do echo "DRY: psql *** -tA: check ${EARLIER[$i]} is on the live project (ledger or: ${EARLIER_MARK[$i]}); missing stops the run, never applied here"; done
    for i in "${!MIGRATIONS[@]}"; do
      echo "DRY: psql *** -X -q -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/${MIGRATIONS[$i]} (only if neither the ledger nor the live schema has it: ${MIGRATION_MARK[$i]}; its ledger row in the same transaction)"
    done
  else
    sql_to LEDGER "select case when to_regclass('public.upmore_migration_ledger') is null then 'missing' when exists (select 1 from public.upmore_migration_ledger) then 'ok' else 'empty' end"
    # An empty ledger is apply-rails-and-seed.sh's to backfill on its first run; a row written here would stop that backfill.
    [[ "$LEDGER" == ok ]] && echo "  ledger: public.upmore_migration_ledger" || echo "  ledger: $LEDGER, left alone; the live schema decides what is applied"
    in_ledger() { local n; [[ "$LEDGER" == ok ]] || return 1; sql_to n "select count(*) from public.upmore_migration_ledger where filename = '$1'"; [[ "$n" != 0 ]]; }
    MISSING=()
    for i in "${!EARLIER[@]}"; do
      f="${EARLIER[$i]}"; sql_to live "select (${EARLIER_MARK[$i]})"
      if [[ "$live" == t ]]; then echo "  earlier $f: on the live project$(in_ledger "$f" && echo ' (ledger)' || echo ' (not in the ledger)')"
      else echo "  earlier $f: NOT on the live project"; MISSING+=("$f"); fi
    done
    if (( ${#MISSING[@]} )); then
      fail "the career chat needs ${MISSING[*]}; these use plain create table and are not safe to replay, so apply each by hand after checking: psql \"\$SUPABASE_DB_URL\" -X -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/<file>; then re-run"
    fi
    for i in "${!MIGRATIONS[@]}"; do
      f="${MIGRATIONS[$i]}"; path="supabase/migrations/$f"; sum="$(sha256 "$path")"
      if in_ledger "$f"; then echo "  $f: applied before (ledger), skipped"; continue; fi
      sql_to live "select (${MIGRATION_MARK[$i]})"
      if [[ "$live" == t ]]; then
        echo "  $f: already on the live project, not applied again"
        [[ "$LEDGER" == ok ]] && "${P[@]}" -c "insert into public.upmore_migration_ledger(filename,sha256) values ('$f','$sum') on conflict do nothing" 2>&1 | mask
        continue
      fi
      args=(-f "$path"); [[ "$LEDGER" == ok ]] && args+=(-c "insert into public.upmore_migration_ledger(filename,sha256) values ('$f','$sum') on conflict do nothing")
      run "psql *** -X -q -v ON_ERROR_STOP=1 --single-transaction -f $path" "${P[@]}" --single-transaction "${args[@]}"
      sql_to live "select (${MIGRATION_MARK[$i]})"; [[ "$live" == t ]] || fail "$f ran but its objects are not there"
      echo "  $f: applied, sha256 $sum"
    done
  fi
  # WO-093: every mark again, after the applies (a migration the ledger calls applied may never have landed), then the
  # deploy ledger's migration rows for this sha.
  # The draft bridge and the one ledger replace the same two claim functions, so whichever ran last decides them: they
  # are reconciled, and the run stops unless every claim guard is in place (docs/architect/MIGRATION-SEQUENCING-BRIDGE-LEDGER.md).
  if [[ -n "$DRY" ]]; then
    echo "DRY: psql *** -X -q -v ON_ERROR_STOP=1 -f scripts/launch/verify-claim-guards.sql (reconcile the bridge and the one ledger; any missing claim guard fails the run, each named)"
  else
    run "psql *** -X -q -v ON_ERROR_STOP=1 -f scripts/launch/verify-claim-guards.sql" "${P[@]}" -f scripts/launch/verify-claim-guards.sql
  fi
  if [[ -n "$DRY" ]]; then
    echo "DRY: psql *** -tA: every migration mark (${#EARLIER[@]} earlier + ${#MIGRATIONS[@]}) read again on the live schema; any missing one fails the run, each named"
    echo "DRY: psql *** -c: insert into public.career_deploy_ledger one migration row per mark (sha, file, sha256, manifest sha256, --label)"
  else
    check_all_marks
    ledger_migrations
  fi
  ok
fi

# ---------------------------------------------------------------------------------------------------------------------
if [[ -n "$ONLY_SMOKE" ]]; then skipped "3/6 secrets" "--only-smoke"
else
  step "3/6 secrets"
  NAMES=(); LINES=()
  add() { NAMES+=("$1=$3"); LINES+=("$1=$2"); }
  for v in "${SCHED_VARS[@]}"; do
    if [[ -n "${!v:-}" ]]; then add "$v" "${!v}" "***"
    elif [[ " ${KEEP_LIVE[*]} " == *" $v "* ]]; then echo "  kept: $v (set on the project; not given, so not touched)"
    else add "$v" "" "<generated>"; fi
  done
  if [[ -n "${INGEST_CONTACT_EMAIL:-}" ]]; then add INGEST_CONTACT_EMAIL "$INGEST_CONTACT_EMAIL" "***"; else echo "  kept: INGEST_CONTACT_EMAIL (not given; career-ingest answers 503 until it is set)"; fi
  if [[ -n "${LOOPMESSAGE_API_KEY:-}" ]]; then add LOOPMESSAGE_API_KEY "$LOOPMESSAGE_API_KEY" "***"; else echo "  kept: LOOPMESSAGE_API_KEY (not given; without one, delivery and inbound answer 503 NOT_WIRED)"; fi
  if [[ -n "${LOOPMESSAGE_DAILY_CONTACTS:-}" ]]; then add LOOPMESSAGE_DAILY_CONTACTS "$LOOPMESSAGE_DAILY_CONTACTS" "***"; else echo "  kept: LOOPMESSAGE_DAILY_CONTACTS (unset means 300 a day)"; fi
  if [[ -n "${TRAINEE_ALLOWED_CONTACTS:-}" ]]; then add TRAINEE_ALLOWED_CONTACTS "$TRAINEE_ALLOWED_CONTACTS" "***"; else echo "  kept: TRAINEE_ALLOWED_CONTACTS (sign-up stays closed to anyone not listed or already linked)"; fi
  if [[ -n "${PDL_API_KEY:-}" ]]; then add PDL_API_KEY "$PDL_API_KEY" "***"; else echo "  kept: PDL_API_KEY (not given; hired-candidate backgrounds say NO DATA until it is set)"; fi
  # Audit B2: the chat's door to the preparation host (both or neither, checked in preflight).
  if [[ -n "${CAREER_PREPARE_AHEAD_URL:-}" ]]; then add CAREER_PREPARE_AHEAD_URL "$CAREER_PREPARE_AHEAD_URL" "***"; add CAREER_PREPARE_AHEAD_TOKEN "$CAREER_PREPARE_AHEAD_TOKEN" "***"
  else echo "  kept: CAREER_PREPARE_AHEAD_URL, CAREER_PREPARE_AHEAD_TOKEN (not given; what the project has stays: with neither set, phone-only preparation is NOT_WIRED and the chat says so)"; fi
  # OpenAI only (owner, 2026-10-12): the key goes with MODEL_PROVIDER=openai, as in go-live.sh.
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then add OPENAI_API_KEY "$OPENAI_API_KEY" "***"; add MODEL_PROVIDER openai openai; else echo "  kept: OPENAI_API_KEY (not given; an already-set key stays as it is)"; fi
  # WO-038: each channel's values when given; a channel never given stays NOT_WIRED.
  for v in "${CHANNEL_HIDDEN[@]}" "${CHANNEL_PLAIN[@]}"; do
    if [[ -n "${!v:-}" ]]; then add "$v" "${!v}" "***"; else echo "  kept: $v (not given; what is set stays, and with nothing set that channel is NOT_WIRED)"; fi
  done
  # FEATURE 17: the cloud runner's secrets and numbers, by name; the URLs are derived from the project ref.
  if [[ -n "$CLOUD_WIRE" ]]; then
    if [[ -n "$BUILD_SNAPSHOT" ]]; then
      if [[ -n "$DRY" ]]; then echo "DRY: VERCEL_TOKEN=*** VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... deno run -A scripts/cloud-runner/build-snapshot.ts ${SHIP_SHA:-<sha>} (one sandbox, ~25 min; prints SNAPSHOT snap_...)"
      else
        [[ -n "${VERCEL_TOKEN:-}" && -n "${VERCEL_TEAM_ID:-}" && -n "${VERCEL_PROJECT_ID:-}" && -n "$SHIP_SHA" ]] || fail "--build-snapshot needs VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID and --sha"
        echo "  > deno run -A scripts/cloud-runner/build-snapshot.ts $SHIP_SHA"
        snap_out="$(VERCEL_TOKEN="$VERCEL_TOKEN" VERCEL_TEAM_ID="$VERCEL_TEAM_ID" VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID" deno run -A scripts/cloud-runner/build-snapshot.ts "$SHIP_SHA" 2>&1)" \
          || { printf '%s\n' "$snap_out" | mask; fail "the runner snapshot was not built"; }
        printf '%s\n' "$snap_out" | mask
        CLOUD_SANDBOX_SNAPSHOT_ID="$(printf '%s\n' "$snap_out" | sed -n 's/^SNAPSHOT \(snap_[A-Za-z0-9]*\).*/\1/p' | tail -1)"
        [[ "$CLOUD_SANDBOX_SNAPSHOT_ID" =~ ^snap_ ]] || fail "the snapshot build printed no SNAPSHOT id"
      fi
    fi
    for v in "${CLOUD_HIDDEN[@]}"; do
      if [[ -n "${!v:-}" ]]; then add "$v" "${!v}" "***"
      elif [[ " ${KEEP_LIVE[*]} " == *" $v "* ]]; then echo "  kept: $v (set on the project; not given, so not touched)"
      elif [[ -n "$DRY" && "$v" != VERCEL_TOKEN ]]; then add "$v" "" "<generated>"
      else echo "  kept: $v (not given)"; fi
    done
    for v in "${CLOUD_PLAIN[@]}"; do
      if [[ -n "${!v:-}" ]]; then add "$v" "${!v}" "${!v}"
      elif [[ -n "${CLOUD_WAVE1[$v]:-}" ]]; then add "$v" "${CLOUD_WAVE1[$v]}" "${CLOUD_WAVE1[$v]}"; echo "  $v: not given, set to the first wave's ${CLOUD_WAVE1[$v]}"
      else echo "  kept: $v (not given; off for a switch, no number for a per-person or per-site limit)"; fi
    done
    add CLOUD_BRIDGE_URL "$BASE/functions/v1/$CLOUD_FN" "$BASE/functions/v1/$CLOUD_FN"
    add CAREER_PREPARE_AHEAD_URL "$BASE/functions/v1/$CLOUD_FN/prepare" "$BASE/functions/v1/$CLOUD_FN/prepare"
  fi
  # Networking follow-up reminders (architect ruling R2, 2026-10-27): on for launch, so the chat's promise of a texted
  # reminder is kept. career-proactive queues each due one once to career_outbox; trainee-deliver texts it. A person with
  # no texting channel is told plainly that no message comes (career_outreach_track.ts reminderWords). Before the brain
  # lines: CAREER_BRAIN stays the env file's last name, as F13-10 reads it.
  add CAREER_OUTREACH_FOLLOWUPS on on
  # The router answers unless the owner asks for the agent brain on this run (D-008); the environment never decides it.
  if [[ "$BRAIN" == agent ]]; then add CAREER_BRAIN agent agent; fi
  # FEATURE 13: the staged release (question and advice turns to the brain, every action to code) only with --brain staged.
  if [[ "$BRAIN" == staged ]]; then add CAREER_BRAIN staged staged; fi
  if [[ -n "$DRY" ]]; then echo "DRY: supabase secrets set --project-ref $REF --env-file <0600 temp file: ${NAMES[*]}>"
  else
    ENVF="$(umask 077; mktemp "${TMPDIR:-/tmp}/trainee-secrets.XXXXXX")"; chmod 600 "$ENVF"
    printf '%s\n' "${LINES[@]}" >"$ENVF"
    echo "  > supabase secrets set --project-ref $REF --env-file <0600 temp file: ${NAMES[*]}>"
    supabase secrets set --project-ref "$REF" --env-file "$ENVF" 2>&1 | mask
    rm -f "$ENVF"; ENVF=""
  fi
  unset LINES
  case "$BRAIN" in
    agent) echo "  CAREER_BRAIN=agent: the agent brain answers career turns (the router still takes structured tasks and model outages)" ;;
    staged) echo "  CAREER_BRAIN=staged: the brain answers question and advice turns; every action, a model outage and any class in CAREER_BRAIN_ROUTER_INTENTS stay with code and the router (--brain router turns it off)" ;;
    router) run "supabase secrets unset CAREER_BRAIN --project-ref $REF" supabase secrets unset CAREER_BRAIN --project-ref "$REF" ;;
    *) echo "  CAREER_BRAIN not touched (the router answers unless it was set to agent before; --brain agent|router changes it)" ;;
  esac
  if (( ${#GENERATED[@]} )); then
    echo "  generated: ${GENERATED[*]} (48 characters each; kept only in this process$([[ -n "$NONINT" ]] && echo '; --non-interactive never shows them: the function and its Vault schedule hold each'))"
    # Shown once, on the terminal only (never the log), and only when asked: TRAINEE_INBOUND_SECRET goes into
    # LoopMessage's webhook URL, and a lost one is replaced by re-running with a new value.
    if have_tty; then
      printf 'Show the generated secrets once on this terminal? They go nowhere else; anyone who sees the screen can call these functions. [y/N] ' >/dev/tty
      IFS= read -r yn </dev/tty || yn=""
      if [[ "$yn" == y || "$yn" == Y ]]; then
        for v in "${GENERATED[@]}"; do printf '  %s=%s\n' "$v" "${!v}" >/dev/tty; done
        printf 'WARNING: copy what you need now (the inbound one into the LoopMessage webhook URL, the Telegram one into setWebhook, the WhatsApp one into Meta), then clear the screen.\n' >/dev/tty
      fi
    fi
  fi
  ok
fi

# ---------------------------------------------------------------------------------------------------------------------
if [[ -n "$ONLY_SMOKE" || -n "$SKIP_DEPLOY" ]]; then skipped "4/6 deploy" "$([[ -n "$ONLY_SMOKE" ]] && echo --only-smoke || echo --skip-deploy)"
else
  step "4/6 deploy"
  # The live agent-chat is the career-only artifact (owner, 2026-10-15): the import graph of index-career.ts, staged with
  # it as agent-chat/index.ts. Deploying agent-chat from the repo tree would ship the shelved finance entry instead.
  RB="$HOME/trainee-rollback/agent-chat-$(date -u +%Y%m%dT%H%M%SZ)"
  # WO-093: with step 2 skipped, the marks are still read before anything is deployed on top of the schema.
  if [[ -n "$SKIP_MIG" ]]; then
    if [[ -n "$DRY" ]]; then echo "DRY: psql *** -tA: every migration mark read on the live schema first (--skip-migrations applies none; a missing one stops the deploy)"
    else db_init; check_all_marks; ledger_migrations; fi
  fi
  if [[ -n "$DRY" ]]; then
    echo "DRY: supabase functions download agent-chat --project-ref $REF (into $HOME/trainee-rollback/agent-chat-<UTC>; best effort, the rollback copy)"
    echo "DRY: node scripts/career/stage-career.cjs <stage>/supabase/functions (index-career.ts staged as agent-chat/index.ts)"
    echo "DRY: (cd <stage> && supabase functions deploy agent-chat --project-ref $REF --use-docker) (verify_jwt = true; bundled locally: the 20 MB limit, not the 5 MB server-side one)"
    echo "DRY: psql *** -c: insert into public.career_deploy_ledger (${SHIP_SHA:-<sha>}, agent-chat, its bundle sha256 from the manifest, the platform version, --label)"
  else
    db_init
    mkdir -p "$RB"
    if (cd "$RB" && supabase functions download agent-chat --project-ref "$REF" 2>&1 | mask); then echo "  rollback copy of the live agent-chat: $RB"
    else echo "  WARN: could not download the live agent-chat; the rollback is re-deploying the previous commit (docs/launch/TRAINEE-GO-LIVE.md)"; fi
    STAGE="$(mktemp -d "${TMPDIR:-/tmp}/trainee-agent-chat.XXXXXX")"
    run "node scripts/career/stage-career.cjs $STAGE/supabase/functions" node scripts/career/stage-career.cjs "$STAGE/supabase/functions"
    printf '[functions.agent-chat]\nverify_jwt = true\n' >"$STAGE/supabase/config.toml"
    echo "  > (cd $STAGE && supabase functions deploy agent-chat --project-ref $REF --use-docker)"
    (cd "$STAGE" && supabase functions deploy agent-chat --project-ref "$REF" --use-docker) 2>&1 | mask
    ledger_function agent-chat
  fi
  # career-voice (WO-035) authorizes each call with its own signed link; it stays off until CAREER_VOICE=on is set.
  for fn in "${SCHEDULED[@]}" career-voice "${CHANNEL_FNS[@]}" "${OAUTH_FNS[@]}" "$CLOUD_FN"; do
    run "supabase functions deploy $fn --project-ref $REF --no-verify-jwt --use-docker" supabase functions deploy "$fn" --project-ref "$REF" --no-verify-jwt --use-docker
    if [[ -n "$DRY" ]]; then echo "DRY: psql *** -c: insert into public.career_deploy_ledger (${SHIP_SHA:-<sha>}, $fn, its bundle sha256, the platform version, --label)"
    else ledger_function "$fn"; fi
  done
  for fn in "${JWT_FNS[@]}"; do
    run "supabase functions deploy $fn --project-ref $REF --use-docker" supabase functions deploy "$fn" --project-ref "$REF" --use-docker
    if [[ -n "$DRY" ]]; then echo "DRY: psql *** -c: insert into public.career_deploy_ledger (${SHIP_SHA:-<sha>}, $fn, its bundle sha256, the platform version, --label)"
    else ledger_function "$fn"; fi
  done
  # pg_cron carries no JWT; career-send checks the proactive secret itself.
  for fn in "${SEND_FNS[@]}"; do
    run "supabase functions deploy $fn --project-ref $REF --no-verify-jwt --use-docker" supabase functions deploy "$fn" --project-ref "$REF" --no-verify-jwt --use-docker
    if [[ -n "$DRY" ]]; then echo "DRY: psql *** -c: insert into public.career_deploy_ledger (${SHIP_SHA:-<sha>}, $fn, its bundle sha256, the platform version, --label)"
    else ledger_function "$fn"; fi
  done
  # Public by design (verify_jwt = false in supabase/config.toml): trainee-file's signed link and ops-monitor's token authenticate.
  for fn in ${GATED_ON[@]+"${GATED_ON[@]}"}; do
    run "supabase functions deploy $fn --project-ref $REF --no-verify-jwt --use-docker" supabase functions deploy "$fn" --project-ref "$REF" --no-verify-jwt --use-docker
    if [[ -n "$DRY" ]]; then echo "DRY: psql *** -c: insert into public.career_deploy_ledger (${SHIP_SHA:-<sha>}, $fn, its bundle sha256, the platform version, --label)"
    else ledger_function "$fn"; fi
  done
  ok
fi

# ---------------------------------------------------------------------------------------------------------------------
if [[ -n "$ONLY_SMOKE" ]]; then skipped "5/6 schedules" "--only-smoke"
else
  step "5/6 schedules"
  # Each script's header: SECRET=... psql "$SUPABASE_DB_URL" -v url=https://<ref>.supabase.co/functions/v1/<fn> -f <file>.
  sched() {
    local var="$1" fn="$2" file="$3"
    # A kept secret is not known to this run: its job and Vault copy stay (re-scheduling with an empty one would break it).
    if [[ " ${KEEP_LIVE[*]} " == *" $var "* ]]; then echo "  kept: the $fn schedule and its Vault secret ($var not given)"; return 0; fi
    run "$var=*** psql *** -X -q -v ON_ERROR_STOP=1 -v url=$BASE/functions/v1/$fn -f $file" \
      env "$var=${!var:-}" psql "${SUPABASE_DB_URL:-}" -X -q -v ON_ERROR_STOP=1 -v url="$BASE/functions/v1/$fn" -f "$file"
  }
  sched CAREER_INGEST_SECRET career-ingest scripts/launch/schedule-career-ingest.sql
  sched CAREER_PROACTIVE_SECRET career-proactive scripts/launch/schedule-career-proactive.sql
  sched TRAINEE_DELIVER_SECRET trainee-deliver scripts/launch/schedule-trainee-deliver.sql
  # Removing a schedule is the owner's call, by exact name: with no --unschedule-cron, nothing is removed.
  if [[ -z "$UNSCHEDULE_CRON" ]]; then echo "  kept: every other pg_cron job (none named with --unschedule-cron)"
  else
    run "psql *** -X -q -v ON_ERROR_STOP=1 -v allow=$UNSCHEDULE_CRON -f $LEGACY_CRON_SQL (unschedules only: $UNSCHEDULE_CRON)" \
      psql "${SUPABASE_DB_URL:-}" -X -q -v ON_ERROR_STOP=1 -v allow="$UNSCHEDULE_CRON" -f "$LEGACY_CRON_SQL"
  fi
  # FEATURE 17: the cloud runner's two ticks (sending and preparation), only when it is wired on this run.
  if [[ -n "$CLOUD_WIRE" ]]; then sched CLOUD_DISPATCH_SECRET "$CLOUD_FN" scripts/launch/schedule-career-cloud.sql
  else echo "  cloud runner schedules: not touched (not wired on this run)"; fi
  ok
fi

# ---------------------------------------------------------------------------------------------------------------------
step "6/6 smoke"
SMOKE_ENV=("SUPABASE_URL=$BASE"); SMOKE_SHOWN="SUPABASE_URL=$BASE"
for v in "${SCHED_VARS[@]}" TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET WHATSAPP_VERIFY_TOKEN SUPABASE_DB_URL UPMORE_TEST_JWT TRAINEE_SMOKE_CONTACT CAREER_PREPARE_AHEAD_URL CAREER_PREPARE_AHEAD_TOKEN TRAINEE_FILE_BASE_URL; do
  if [[ -n "${!v:-}" ]]; then SMOKE_ENV+=("$v=${!v}"); SMOKE_SHOWN+=" $v=***"; fi
done
SMOKE_ARGS=()
[[ -n "$ALLOW_SEND" ]] && SMOKE_ARGS+=(--allow-send)
# A function secret kept on the project is not known here: the smoke reports its gate NOT RUN instead of refusing to run.
(( ${#KEEP_LIVE[@]} )) && SMOKE_ARGS+=(--kept "$(IFS=,; echo "${KEEP_LIVE[*]}")")
# Right after scheduling, the jobs have not fired yet: wait for each to fire once (ingest and alerts run every 5 minutes).
[[ -z "$NOWAIT" && -z "$ONLY_SMOKE" ]] && SMOKE_ARGS+=(--wait-runs 420)
SMOKE_SHOWN+=" node scripts/launch/trainee-smoke.cjs${SMOKE_ARGS[*]+ ${SMOKE_ARGS[*]}}"
if [[ -n "$DRY" ]]; then echo "DRY: $SMOKE_SHOWN"
else
  echo "  > $SMOKE_SHOWN"
  set +e
  env "${SMOKE_ENV[@]}" node scripts/launch/trainee-smoke.cjs ${SMOKE_ARGS[@]+"${SMOKE_ARGS[@]}"} 2>&1 | mask
  code=${PIPESTATUS[0]}
  set -e
  (( code == 2 )) && fail "smoke NOT RUN: an input it needs is missing (see above)"
  (( code == 0 )) || fail "a smoke check failed (see above); nothing was rolled back, see docs/launch/TRAINEE-GO-LIVE.md"
fi
ok

echo
[[ -n "$SHIP_SHA" ]] && echo "provenance: shipped $SHIP_SHA (manifest sha256 $MANIFEST_SHA256); check it any time: bash scripts/launch/trainee-go-live.sh --verify $SHIP_SHA"
echo "done on $SHA. LoopMessage webhook: $BASE/functions/v1/trainee-inbound?secret=<TRAINEE_INBOUND_SECRET>"
echo "Telegram webhook (setWebhook with secret_token=<TELEGRAM_WEBHOOK_SECRET>): $BASE/functions/v1/trainee-telegram"
echo "WhatsApp callback URL (verify token <WHATSAPP_VERIFY_TOKEN>, subscribe to messages): $BASE/functions/v1/trainee-whatsapp"
echo "rollback, the Telegram and WhatsApp steps and what each step changed: docs/launch/TRAINEE-GO-LIVE.md"
