#!/bin/bash
# Runs the agent migrations and their SQL tests against a throwaway local
# Postgres. Nothing here touches the live Supabase project.
set -euo pipefail
export LC_ALL=C LANG=C
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# export_coverage.test.sql reads tests/fixtures/export-tables.json through psql from here.
export UPMORE_ROOT="$ROOT"
PGBIN="${PGBIN:-$(dirname "$(command -v postgres)")}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/upmore-db-test.XXXXXX")"
PORT="${PGTEST_PORT:-54329}"
cleanup() {
  "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
PSQL=("$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

# Migrations are full of "if not exists" and "drop ... if exists"; their
# notices are noise here. Tests print their own "ok" lines as notices.
QUIET=("${PSQL[@]}" -c "set client_min_messages = warning")
"${QUIET[@]}" -f "$HERE/stubs.sql"
for m in 20260923_000001_agent_rate_limits.sql 20260923_000006_rate_limiter_hardening.sql \
         20260927_000003_agent_usage.sql \
         20260926_000001_agent_exec.sql 20260926_000002_agent_exec_otp.sql \
         20260928_000001_chat_reminders.sql \
         20260928_000002_exec_runs_revoked.sql \
         20260928_000004_exec_trust.sql \
         20260928_000006_agent_lessons.sql \
         20260928_000007_lesson_upsert_rpc.sql \
         20260928_000011_oauth_connections.sql \
         20261008_000002_agent_rl_bump_as.sql \
         20261010010000_agent_permissions_ledger.sql \
         20261010020000_execution_integrity.sql \
         20261010030000_obligation_workflows.sql \
         20261010040000_financial_evidence.sql \
         20261010050000_biller_lifecycle.sql \
         20261010060000_payment_execution.sql \
         20261010070000_message_inbox.sql \
         20261010080000_message_delivery.sql \
         20261010090000_chat_bridge_rate.sql \
         20261010100000_message_turns.sql \
         20261010110000_model_call_budget.sql \
         20261010120000_chat_lesson_ownership.sql \
         20261010130000_transaction_reviews.sql \
         20261010140000_linked_transaction_review.sql \
         20261010150000_obligation_edits.sql \
         20261010160000_applied_payment_reconciliation.sql \
         20261010170000_payment_queue_fairness.sql \
         20261010180000_recovery_snapshot.sql \
         20261010190000_recovery_cases.sql \
         20261011010000_flow_state.sql \
         20261011020000_saved_recipients.sql \
         20261011030000_brokerage_accounts_per_user.sql \
         20261011040000_model_health_and_turn_costs.sql \
         20261011050000_broker_vault_cascade.sql; do
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
done
# LAUNCH READINESS B1 (2026-10-26): the older files that make SECURITY DEFINER functions and are not part of the career
# list above (referrals, SimpleFIN, Plaid, the action-ledger purge, the exec Vault read), in filename order, as production
# has them: definer_lockdown.test.sql below then sees every definer function the repo makes, with the grants these files
# give, and the lockdown (20261026230500, applied by the ledger step, later in file order) must close each one.
for m in 20260927_000001_referral_program.sql 20260927_000002_simplefin_vault.sql 20260927_000004_simplefin_disconnect.sql \
         20260927_000005_referral_pending_credit.sql 20260927_000006_plaid_spend_governor.sql \
         20260928_000009_purge_user_action_ledger.sql 20260928_000010_exec_vault_read.sql; do
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
done
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010120000_chat_lesson_ownership.sql"
# Idempotent: the agent migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010010000_agent_permissions_ledger.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010020000_execution_integrity.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010030000_obligation_workflows.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010040000_financial_evidence.sql"

"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010050000_biller_lifecycle.sql"

"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010060000_payment_execution.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010070000_message_inbox.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010080000_message_delivery.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010090000_chat_bridge_rate.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010100000_message_turns.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010110000_model_call_budget.sql"

"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010130000_transaction_reviews.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010140000_linked_transaction_review.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010150000_obligation_edits.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010160000_applied_payment_reconciliation.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010170000_payment_queue_fairness.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010180000_recovery_snapshot.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261010190000_recovery_cases.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261011010000_flow_state.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261011020000_saved_recipients.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261011030000_brokerage_accounts_per_user.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261011040000_model_health_and_turn_costs.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261011050000_broker_vault_cascade.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261011060000_proactive.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012010000_manual_connections.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012020000_standing_payments.sql"
# Idempotent: the standing payments migration applies cleanly a second time (the ledger below replays it once more).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012020000_standing_payments.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012030000_saved_recipient_nicknames.sql"
# Idempotent: the nickname migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012030000_saved_recipient_nicknames.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012040000_category_rules.sql"
# Idempotent: the category rules migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012040000_category_rules.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012050000_ious.sql"
# Idempotent: the IOU log migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012050000_ious.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012060000_oauth_vault_cascade.sql"
# Idempotent: the OAuth vault cascade must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261012060000_oauth_vault_cascade.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019000001_career_postings.sql"
# Idempotent: the career postings migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019000001_career_postings.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019010001_career_alerts.sql"
# Idempotent: the career alerts migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019010001_career_alerts.sql"
# WO-081: the landing page's capture (main's file, live in production, kept byte for byte); idempotent, applied twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019020000_site_capture.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019020000_site_capture.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019020001_channel_delivery.sql"
# The table is part of export coverage; its account-authority RPCs run only
# after the complete career migration ledger below has created career_watch_kv.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020000001_career_apply_jobs.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020000001_career_apply_jobs.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020010000_career_apply_own_worker.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020010000_career_apply_own_worker.sql"
# Idempotent: the channel delivery migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019020001_channel_delivery.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019030000_channel_inbound.sql"
# Idempotent: the channel inbound migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261019030000_channel_inbound.sql"
# After channel inbound, as in production order: the receipts migration widens the outbox kinds it set.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020020000_career_apply_receipts.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020020000_career_apply_receipts.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020030000_career_apply_cards.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020030000_career_apply_cards.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020040000_career_apply_card_push.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020040000_career_apply_card_push.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020050000_career_apply_daily_limit.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020050000_career_apply_daily_limit.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020060000_career_apply_questions.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020060000_career_apply_questions.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020070000_career_apply_questions_ai_policy.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020070000_career_apply_questions_ai_policy.sql"
# After the card push migration, as in production order: mail tracking widens the outbox kinds it set.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020100000_career_mail_tracking.sql"
# Idempotent: the mail tracking migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020100000_career_mail_tracking.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020110000_career_connector.sql"
# Idempotent: the connector migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020110000_career_connector.sql"

# The account timeline (WO-027): the table is part of export coverage and the deletion sweep; its erase redefinition
# (20261020120100) needs career_watch_kv, so the ledger below applies it.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020120000_career_events.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020120000_career_events.sql"
# WO-028: the private resume bucket and the tailored tag; idempotent, so it applies cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020130000_career_resume_tailoring.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261020130000_career_resume_tailoring.sql"
# WO-038: WhatsApp and Telegram beside iMessage (contacts per channel, held rows, link tokens); idempotent, so it applies
# cleanly a second time. Its test runs after the career ledger below (the card push it redefines needs that schema), which
# also replays it on top of every earlier migration.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021070000_channel_parity.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021070000_channel_parity.sql"
# WO-036: hired-candidate background aggregates and the PDL credit log. Idempotent: applied twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021030000_career_hired_backgrounds.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021030000_career_hired_backgrounds.sql"
# WO-032 apply operations (source, email confirmation, the gate, apply by email, questions pushed, the card push's busy
# check). After every migration it redefines or widens, the channel parity's card push and outbox lists included;
# applied twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021075000_career_apply_ops.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021075000_career_apply_ops.sql"

# WO-037 (20261021110000, last in file order): board read state, the alert latency report and the weekly count. It adds
# its own table and one outbox column that no later migration touches, so it is applied here, before the tests, twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021110000_career_board_state.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021110000_career_board_state.sql"
# WO-031: the browser extension records the applications approved in it on the same queue; then WO-042's 120000, which
# redefines its begin with source 'extension' (the column exists from 075000) and keeps answers typed on the form. Each
# applied twice (idempotent), the later one last, as production ends.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021000000_career_apply_extension.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021000000_career_apply_extension.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021120000_career_apply_form_answers.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021120000_career_apply_form_answers.sql"
# WO-066: the postings the person asked Trainee to apply to, waiting for the extension (applied twice: idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022100000_career_apply_wanted.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022100000_career_apply_wanted.sql"
# WO-069: the pay a board states for a posting, a column on career_postings (applied twice: idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022110000_career_postings_pay.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022110000_career_postings_pay.sql"
# WO-093: the deploy ledger (RLS on, no client access, the service role reads and appends, append-only for everyone).
# Applied twice: idempotent. Its test, career_deploy_ledger.test.sql, runs in the loop below.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022120500_career_deploy_ledger.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022120500_career_deploy_ledger.sql"
# WO-044 (20261026060006, feature 6): the postings and board-state provider lists widen to the seven new readers; applied twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026060006_career_more_providers.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026060006_career_more_providers.sql"
# Feature 6 (20261026060106): the per-lane ingest run log and its coverage report; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026060106_career_ingest_runs.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026060106_career_ingest_runs.sql"

for t in "$HERE"/*.test.sql; do
  if [[ "$t" == "$HERE/career_apply_jobs.test.sql" || "$t" == "$HERE/career_apply_own.test.sql" || "$t" == "$HERE/career_apply_cards.test.sql" || "$t" == "$HERE/career_apply_card_push.test.sql" || "$t" == "$HERE/career_apply_daily_limit.test.sql" || "$t" == "$HERE/career_apply_questions.test.sql" || "$t" == "$HERE/career_apply_questions_ai_policy.test.sql" || "$t" == "$HERE/career_connector.test.sql" || "$t" == "$HERE/career_events.test.sql" || "$t" == "$HERE/career_resume_tailoring.test.sql" || "$t" == "$HERE/career_voice_mock.test.sql" || "$t" == "$HERE/career_outreach.test.sql" || "$t" == "$HERE/career_brief_digest.test.sql" || "$t" == "$HERE/channel_parity.test.sql" || "$t" == "$HERE/career_mail_erase.test.sql" || "$t" == "$HERE/career_proactive_last_word.test.sql" || "$t" == "$HERE/career_apply_ops.test.sql" || "$t" == "$HERE/career_apply_cloud.test.sql" || "$t" == "$HERE/career_apply_extension.test.sql" || "$t" == "$HERE/career_apply_form_answers.test.sql" || "$t" == "$HERE/career_control_state.test.sql" || "$t" == "$HERE/career_apply_authority.test.sql" || "$t" == "$HERE/career_events_apply_queued.test.sql" || "$t" == "$HERE/career_apply_agent_submit.test.sql" || "$t" == "$HERE/career_apply_agent_contract.test.sql" || "$t" == "$HERE/career_apply_cloud_ask.test.sql" || "$t" == "$HERE/career_apply_cloud_gate_waiver.test.sql" || "$t" == "$HERE/career_apply_message_cards.test.sql" || "$t" == "$HERE/career_batch_approve_exclude.test.sql" || "$t" == "$HERE/career_apply_wanted_candidates.test.sql" || "$t" == "$HERE/career_apply_no_volume_ceiling.test.sql" || "$t" == "$HERE/career_apply_pace_parse.test.sql" || "$t" == "$HERE/career_apply_pace_state.test.sql" || "$t" == "$HERE/career_apply_card_yes_window.test.sql" || "$t" == "$HERE/career_outbox_card_id.test.sql" || "$t" == "$HERE/career_apply_receipt_store.test.sql" || "$t" == "$HERE/career_mail_drafts_sent.test.sql" || "$t" == "$HERE/career_account_memory.test.sql" || "$t" == "$HERE/career_apply_want_guard.test.sql" || "$t" == "$HERE/career_alert_min_fit.test.sql" || "$t" == "$HERE/career_apply_cloud_runner.test.sql" || "$t" == "$HERE/career_erase_complete.test.sql" || "$t" == "$HERE/career_turn_gate.test.sql" || "$t" == "$HERE/career_kb_postings_recency_index.test.sql" || "$t" == "$HERE/career_resume_required.test.sql" || "$t" == "$HERE/channel_telegram_login.test.sql" || "$t" == "$HERE/career_outreach_followup_claim.test.sql" || "$t" == "$HERE/career_send_queue.test.sql" || "$t" == "$HERE/turn_cost_always_recorded.test.sql" || "$t" == "$HERE/global_daily_model_budget.test.sql" || "$t" == "$HERE/definer_lockdown.test.sql" || "$t" == "$HERE/career_outreach_replies.test.sql" || "$t" == "$HERE/google_disconnect_erase.test.sql" || "$t" == "$HERE/career_account_contacts.test.sql" || "$t" == "$HERE/career_people_scale.test.sql" || "$t" == "$HERE/career_apply_mass_submit.test.sql" || "$t" == "$HERE/career_apply_host_backoff.test.sql" || "$t" == "$HERE/career_apply_host_gate.test.sql" || "$t" == "$HERE/career_apply_vm_approval.test.sql" || "$t" == "$HERE/career_cloud_hosted_apply.test.sql" || "$t" == "$HERE/career_outlook_connector.test.sql" || "$t" == "$HERE/billing_cancel_at_period_end.test.sql" || "$t" == "$HERE/career_outreach_reply_rules.test.sql" || "$t" == "$HERE/career_apply_refusal_requeue.test.sql" || "$t" == "$HERE/career_apply_unstarted_requeue.test.sql" || "$t" == "$HERE/trainee_file_sessions.test.sql" || "$t" == "$HERE/career_connector_disconnect_rules.test.sql" || "$t" == "$HERE/career_outbox_parts_order.test.sql" || "$t" == "$HERE/career_apply_card_confirm.test.sql" || "$t" == "$HERE/billing_webhook_sync.test.sql" || "$t" == "$HERE/career_send_claim_guards.test.sql" || "$t" == "$HERE/career_ingest_bounded.test.sql" || "$t" == "$HERE/account_erase_r2.test.sql" || "$t" == "$HERE/proactive_r2.test.sql" || "$t" == "$HERE/channel_delivery_r2.test.sql" || "$t" == "$HERE/career_resume_confirm_atomic.test.sql" || "$t" == "$HERE/career_evidence_every_confirmation.test.sql" || "$t" == "$HERE/career_outreach_stop_address.test.sql" || "$t" == "$HERE/career_ingest_r2.test.sql" || "$t" == "$HERE/billing_r2.test.sql" || "$t" == "$HERE/channel_identity.test.sql" || "$t" == "$HERE/career_ingest_reread_gap.test.sql" || "$t" == "$HERE/career_apply_submit_worker.test.sql" || "$t" == "$HERE/career_alert_no_weekly_cap.test.sql" || "$t" == "$HERE/approval_rate.test.sql" || "$t" == "$HERE/career_apply_cloud_authorize_closed.test.sql" || "$t" == "$HERE/clock_sweep.test.sql" || "$t" == "$HERE/career_outreach_r3.test.sql" || "$t" == "$HERE/telegram_link_code_kept.test.sql" || "$t" == "$HERE/telegram_link_confirm.test.sql" || "$t" == "$HERE/career_resume_upload_resend.test.sql" ]]; then continue; fi
  echo "== $(basename "$t")"
  # -t -A -o /dev/null drops result rows; the "ok" lines arrive as notices.
  "${PSQL[@]}" -t -A -o /dev/null -f "$t" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
done
echo "== migration ledger (--pending): backfill, apply only what is new, then nothing on a re-run"
# This runner deliberately tests historical migration/rollback definitions below before ending on the latest one.
# The bridge's durable FKs and changed claim permission must not be installed halfway through those old phases.
# Only the bridge is deferred; every earlier migration and existing assertion still runs, then bridge tests run last.
BRIDGE_NAME=20261024130000_career_apply_card_cloud_bridge.sql
BRIDGE_PATH="$ROOT/supabase/migrations/$BRIDGE_NAME"
PENDING_ROOT="$ROOT"
if [[ -f "$BRIDGE_PATH" ]]; then
  PENDING_ROOT="$WORK/historical-pending-view"
  mkdir -p "$PENDING_ROOT/scripts/launch" "$PENDING_ROOT/supabase/migrations"
  cp "$ROOT/scripts/launch/apply-rails-and-seed.sh" "$ROOT/scripts/launch/verify-claim-guards.sql" "$PENDING_ROOT/scripts/launch/"
  for file in "$ROOT"/supabase/migrations/*.sql; do
    [[ "$(basename "$file")" == "$BRIDGE_NAME" ]] && continue
    # FEATURE 16: the owner's resume rule (triggers on the queue, the prepared rows and the cards) is deferred the same
    # way: the historical phases below queue synthetic payloads with no resume, and it is applied last, after them.
    # (named by its prefix here, so tests/flow/provision-pg.sh, which reads the file names above the ledger step, keeps
    # it in filename order, after the migrations it reads)
    [[ "$(basename "$file")" == 20261026210016_* ]] && continue
    # 20261026210017 replaces 20261026210016's career_resume_on_file (one confirmed resume, #211), so it follows it.
    [[ "$(basename "$file")" == 20261026210017_* ]] && continue
    # 20261029170000 replaces 20261026210017's career_resume_on_file (a quarantined entry is no resume), so it follows it.
    [[ "$(basename "$file")" == 20261029170000_* ]] && continue
    # 20261029180000 redefines career_apply_jobs_fixed (20261025100000) and gates every claim the mass-submission files
    # rewrite, so it follows them and the resume rule, last.
    [[ "$(basename "$file")" == 20261029180000_* ]] && continue
    # 20261029190000 builds on 20261029180000 (not_before, the requeue's setting), so it follows it.
    [[ "$(basename "$file")" == 20261029190000_* ]] && continue
    # The mass-submission files (2026-10-27, career_apply_host_backoff and career_apply_mass_submit) likewise: the
    # historical phases below re-create the claims and checks they rewrite and assert the old behaviour, so they are
    # applied last. (Matched by prefix, for tests/flow/provision-pg.sh as above.)
    [[ "$(basename "$file")" == 20261027140000_* || "$(basename "$file")" == 20261027141000_* || "$(basename "$file")" == 20261028120000_* ]] && continue
    # The apply VM (20261028180000) grants on career_apply_host_refused_for (20261027140000) and calls the bridge's
    # cloud_bound_refusal: it is applied last, below, after the files it reads (a re-created claim above would drop it).
    [[ "$(basename "$file")" == 20261028180000_* ]] && continue
    # The submit worker round (20261030140000) rewrites the claims the deferred files above install (the fair claim, the VM's,
    # the text route's) and the not-before trigger: applied last, below, after them.
    [[ "$(basename "$file")" == 20261030140000_* ]] && continue
    # 20261031000000 redefines the reconcile 20261030140000 defines (and rewrites the bridge's check): applied last, below.
    [[ "$(basename "$file")" == 20261031000000_* ]] && continue
    # 20261031030000 redefines channel_link_nonce_redeem (20261021070000), which the channel phases below re-create and test as
    # it was: applied last, below.
    [[ "$(basename "$file")" == 20261031030000_* ]] && continue
    # 20261031040000 redefines channel_link_nonce_redeem and channel_link_confirm (20261021070000, 20261030120000, 20261031030000),
    # which the channel phases below re-create and test as they were: applied last, below.
    [[ "$(basename "$file")" == 20261031040000_* ]] && continue
    # 20261031070000 redefines career_resume_upload_record_as (20261026210016, itself applied below): applied last, below.
    [[ "$(basename "$file")" == 20261031070000_* ]] && continue
    cp "$file" "$PENDING_ROOT/supabase/migrations/"
  done
fi
LEDGER_OUT="$(cd "$PENDING_ROOT" && SUPABASE_DB_URL="postgresql://postgres@/postgres?host=$WORK&port=$PORT" bash scripts/launch/apply-rails-and-seed.sh --pending 2>&1)"
grep -q "ledger backfilled up to 20261011030000_brokerage_accounts_per_user.sql" <<<"$LEDGER_OUT" || { echo "$LEDGER_OUT"; echo "FAIL ledger backfill"; exit 1; }
grep -q "pending migrations, one transaction: .*20261011040000_model_health_and_turn_costs.sql 20261011050000_broker_vault_cascade.sql" <<<"$LEDGER_OUT" || { echo "$LEDGER_OUT"; echo "FAIL pending set"; exit 1; }
grep -q "20261011030000" <<<"$(grep 'pending migrations' <<<"$LEDGER_OUT")" && { echo "FAIL an already-applied file was replayed"; exit 1; }
AGAIN="$(cd "$PENDING_ROOT" && SUPABASE_DB_URL="postgresql://postgres@/postgres?host=$WORK&port=$PORT" bash scripts/launch/apply-rails-and-seed.sh --pending 2>&1)"
[[ "$AGAIN" == "== no pending migrations" ]] || { echo "$AGAIN"; echo "FAIL a re-run applied something"; exit 1; }
"${PSQL[@]}" -tAc "select count(*) from public.upmore_migration_ledger where filename='20261011040000_model_health_and_turn_costs.sql'" | grep -qx 1 || { echo "FAIL ledger row"; exit 1; }
echo "  ok   ledger backfilled, only new files applied, a re-run applies nothing"
# Interviews and the weekly digest (WO-034): it redefines career_host_commit, which 20261015020000 creates with a plain
# create, so the ledger above applies it first, in production order; here it is applied twice more: idempotent.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021050000_career_brief_digest.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021050000_career_brief_digest.sql"
# WO-092: an approval goes stale only when something it depends on changed (the ledger above applied it; applied twice more: idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022150000_career_apply_authority.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022150000_career_apply_authority.sql"
echo "== concurrent message workers"
python3 "$HERE/message_concurrency.py" "${PSQL[@]}"
echo "== career_apply_jobs.test.sql (complete career authority schema)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_jobs.test.sql"
echo "== career_apply_own.test.sql (the person's own computer claims only their own applications)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_own.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_cards.test.sql (prepared, shown on a card, approved by one text)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_cards.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_card_push.test.sql (the scheduled run shows the card in the texting thread)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_card_push.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_daily_limit.test.sql (no product daily number; the person's own pace, if set, with no maximum)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_daily_limit.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_questions.test.sql (asked once by text, answered once, read back by the person's computer)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_questions.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_questions_ai_policy.test.sql (the employer's own words about AI help travel with its written questions)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_questions_ai_policy.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_connector.test.sql (double opt-in introductions: every refusal, nothing identifying before both yes)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_connector.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_events.test.sql (the account timeline: own reads, recall, prepared on insert, wiped by an erase)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_events.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_resume_tailoring.test.sql (tailored resumes stay private; every application tagged tailored or not)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_resume_tailoring.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# WO-035: the voice mock needs career_watch_kv, so the ledger above applied it; idempotent, it must apply a second time.
# Idempotent: the voice mock migration must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021020000_career_voice_mock.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021020000_career_voice_mock.sql"
echo "== career_voice_mock.test.sql (one start per link in 10 minutes, one debrief, the text mock once, no audio)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_voice_mock.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# WO-033: outreach drafts, do-not-contact and the claim. The migration needs career_watch_kv (its erase trigger), so the
# ledger above applied it once; it must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021010000_career_outreach.sql"
echo "== career_outreach.test.sql (approval is the exact message; 10 a day the first week, 20 by default, 30 at most; 90 seconds apart; stop is forever)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outreach.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Re-applied after the earlier migrations' re-runs above: each one redefines the outbox lists, and production ends on the
# latest file's (outbox kinds only grow, tests/outbox-kinds.test.cjs), so the last re-run here must be the latest too.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021050000_career_brief_digest.sql"
echo "== career_brief_digest.test.sql (interviews and the weekly digest: own reads, stated starts only, once per key, wiped by an erase)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_brief_digest.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# The latest migration re-applied last, as production ends (see the brief/digest re-run above).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021070000_channel_parity.sql"
echo "== channel_parity.test.sql (WhatsApp and Telegram beside iMessage: per channel, held, linked only on a yes or a one-time link)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/channel_parity.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# The latest migration re-applied last, as production ends (the channel parity re-run above set the outbox lists without
# 'questions').
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021075000_career_apply_ops.sql"
echo "== career_apply_ops.test.sql (who drove it, confirmed only by email, the gate, apply by email, questions pushed)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_ops.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# The test database is SQL_ASCII; production is UTF8. career_text_spaces (the questions push compares labels with it) is
# checked in a UTF8 database of its own: a no-break and a narrow no-break space read as plain spaces.
echo "== career_text_spaces in a UTF8 database"
"${PSQL[@]}" -c "create database wo032_utf8 encoding 'UTF8' template template0 lc_collate 'C' lc_ctype 'C'"
sed -n '/^create or replace function public.career_text_spaces/,/^end \$\$;/p' "$ROOT/supabase/migrations/20261021075000_career_apply_ops.sql" \
  | "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d wo032_utf8 -f -
U8="$("$PGBIN/psql" -X -q -t -A -h "$WORK" -p "$PORT" -U postgres -d wo032_utf8 -c "select public.career_text_spaces(E'Are you 18\u00a0or\u202folder?  ') = 'Are you 18 or older?'")"
[[ "$U8" == t ]] || { echo "FAIL career_text_spaces does not read Unicode spaces as plain spaces in UTF8"; exit 1; }
echo "  ok   a no-break and a narrow no-break space read as plain spaces"
# WO-039: the cloud worker. Its erase trigger needs career_watch_kv, so the ledger above applied it; idempotent, it must
# apply cleanly twice more.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021080000_career_apply_cloud.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021080000_career_apply_cloud.sql"
echo "== career_apply_cloud.test.sql (the cloud worker: the gate at 3 hand submissions, opt-in, every claim limit, the throttle)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_cloud.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# The mail erase trigger sits on career_watch_kv, so the ledger above applied it once; it must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021090000_career_mail_erase.sql"
echo "== career_mail_erase.test.sql (an erase deletes the mail events and drafts; nobody else's)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_mail_erase.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Delivered proactive texts join the texting thread; the trigger sits on career_outbox and reads channel_contacts, so the
# ledger above applied it once; it must apply cleanly a second time.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261021100000_career_proactive_last_word.sql"
echo "== career_proactive_last_word.test.sql (a delivered alert or receipt is the thread's last word; queued, held and replies are not written)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_proactive_last_word.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_extension.test.sql (the extension records an approved application as the person, every queue rule kept)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_extension.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_form_answers.test.sql (answers typed on the form kept once sent; source 'extension' for the gate)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_form_answers.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# WO-091c: the control state the scheduled layer reads, and the outreach claim's expiry and pause. It redefines the claim
# that the outreach re-run above set back, so it is applied here, last, twice (idempotent), as production ends.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022120000_career_control_state.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261022120000_career_control_state.sql"
echo "== career_control_state.test.sql (pause, STOP and erase are one predicate; an approval lasts 7 days; a quiet account sends nothing)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_control_state.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_authority.test.sql (an ordinary chat turn never makes an approval stale; a pause or a facts change does)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_authority.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# P1 text yes: 20261024140000 redefines career_batch_turn_commit_v1 (20261016010000) to accept exclude_keys; applied
# here twice (idempotent), after the authority test that mints batches through the same function, then its own test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024140000_career_batch_approve_exclude.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024140000_career_batch_approve_exclude.sql"
echo "== career_batch_approve_exclude.test.sql (yes but not 2: only this card's applications, at least one left)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_batch_approve_exclude.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# WO-100: the timeline takes 'apply_queued'. The outreach re-run above set the kinds back to its own list, so this is
# applied last, twice (idempotent), as production ends.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261023100000_career_events_apply_queued.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261023100000_career_events_apply_queued.sql"
echo "== career_events_apply_queued.test.sql (a posting queued from chat is on the timeline and recalled by kind)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_events_apply_queued.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# WO-101: the agent submits only a batch the person approved, and only while the owner's CAREER_AGENT_SUBMIT is 'on'.
# It needs career_cloud_settings (20261021080000, applied above after the loop), so it is applied here, last, twice
# (idempotent). The export check skips its table here, as it skips the cloud tables (listed tables not yet created).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024090000_career_apply_agent_submit.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024090000_career_apply_agent_submit.sql"
echo "== career_apply_agent_submit.test.sql (the owner's kill switch; the person's batch approval, its Stop, used once)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_agent_submit.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# The owner's rollback of 20261024090000 (supabase/rollbacks/): up, down, down again, up again; the database ends up.
echo "== career_apply_agent_submit_down.test.sql (the rollback: down is clean and idempotent, up applies again after it)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_agent_submit_down.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# WO-102 at the agent's start: 20261024100000 redefines the agent start over 20261024090000 (re-applied by the rollback
# test above), so it is applied here, last, twice (idempotent), and its test runs after it.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024100000_career_apply_agent_contract.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024100000_career_apply_agent_contract.sql"
echo "== career_apply_agent_contract.test.sql (the agent starts only an approved entry that keeps the WO-102 contract; each refusal its own)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_agent_contract.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Ask, never guess: 20261024110000 needs the cloud jobs (20261021080000) and the questions (20261020070000) above; applied
# here, last, twice (idempotent), then its test and the questions tests again (put_own now goes through put_for).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024110000_career_apply_cloud_ask.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024110000_career_apply_cloud_ask.sql"
echo "== career_apply_cloud_ask.test.sql (a required field with no confirmed fact becomes the job's person's open question; lease-bound)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_cloud_ask.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
for t in career_apply_questions.test.sql career_apply_questions_ai_policy.test.sql; do
  echo "== $t (after 20261024110000)"
  "${PSQL[@]}" -t -A -o /dev/null -f "$HERE/$t" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
done
# D-010 as changed by the owner: 20261024120000 re-creates the cloud refusal and claim from 20261021080000 (above) with
# the gate-waiver condition; applied last, twice, then its test and the cloud test again (no waiver: as before).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024120000_career_apply_cloud_gate_waiver.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261024120000_career_apply_cloud_gate_waiver.sql"
echo "== career_apply_cloud_gate_waiver.test.sql (one person, one family, set sends, set time; every other rule still decides)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_cloud_gate_waiver.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_cloud.test.sql (after 20261024120000: no waiver, the gate exactly as before)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_cloud.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Lane B: TEST-only Messages approval nonce, after the modern batch approval contract.
echo "== career_apply_message_cards.test.sql (exact shown payload, authenticated single-use tap)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_message_cards.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# G3's one ledger (20261025100000) replaces functions the historical phases above re-created from older files; it is
# applied last, twice (idempotent), with the reconcile (20261025110000), and every claim guard must then be in place.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025100000_career_apply_one_ledger.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025100000_career_apply_one_ledger.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025110000_career_apply_bridge_reconcile.sql"
# G4's server prepare (20261025120000) and STEP 4 F1 (20261025130000: the prepare's candidates come from the person's own
# apply queue too), applied after the one ledger they read; each twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025120000_career_apply_prepare_ahead.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025120000_career_apply_prepare_ahead.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025130000_career_apply_wanted_candidates.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025130000_career_apply_wanted_candidates.sql"
echo "== career_apply_wanted_candidates.test.sql (a queued posting is a prepare-ahead candidate under the same gates as an alerted one)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_wanted_candidates.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# CAPS-1390 (20261025140000): no product daily number on the apply path; applied twice (idempotent), after everything it replaces.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025140000_career_apply_no_volume_ceiling.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025140000_career_apply_no_volume_ceiling.sql"
echo "== career_apply_no_volume_ceiling.test.sql (no product daily number; a person's own pace holds with no maximum; the 30-day rule stands)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_no_volume_ceiling.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# SERIAL-1420 (a) (20261025150000): one parse rule for the person's pace, the TypeScript's; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025150000_career_apply_pace_parse.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025150000_career_apply_pace_parse.sql"
echo "== career_apply_pace_parse.test.sql (an explicit number is the pace, floored and bounded; anything else is none; SQL and TypeScript agree)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_pace_parse.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# SERIAL-1430 (20261025160000): absent, set or unreadable; the setter refuses what the column cannot hold; applied twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025160000_career_apply_pace_state.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025160000_career_apply_pace_state.sql"
echo "== career_apply_pace_state.test.sql (only a missing key is no preference; an unreadable pace refuses; the setter refuses what cannot be held)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_pace_state.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# SERIAL-1451 (20261025170000): the card's 10-minute yes window in the database; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025170000_career_apply_card_yes_window.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025170000_career_apply_card_yes_window.sql"
echo "== career_apply_card_yes_window.test.sql (an approval after 10 minutes is refused by the database; a decline is taken; answered once; an unreadable pace named)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_card_yes_window.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# SERIAL-1462 (20261025180000): the outbox row that carried a card records the card; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025180000_career_outbox_card_id.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261025180000_career_outbox_card_id.sql"
echo "== career_outbox_card_id.test.sql (the push's row and a chat reply's row carry the card id; the delivered provider id finds the card)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outbox_card_id.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# F7 (20261026070007): the fit floor a person may set on their job alerts, held in the table; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026070007_career_alert_min_fit.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026070007_career_alert_min_fit.sql"
echo "== career_alert_min_fit.test.sql (min_fit absent or a whole number 0 to 100; anything else refused; the person cannot write it)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_alert_min_fit.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# FEATURE 8 (20261026080008): a follow-up sent from chat is recorded as sent on its mail draft; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026080008_career_mail_drafts_sent.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026080008_career_mail_drafts_sent.sql"
echo "== career_mail_drafts_sent.test.sql (a sent follow-up is dated and tied to its outreach draft; never drafted again)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_mail_drafts_sent.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# FEATURE 14 (20261026140000): the receipt each finished application gets, its pictures under the lease; applied twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026140000_career_apply_receipt_store.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026140000_career_apply_receipt_store.sql"
echo "== career_apply_receipt_store.test.sql (a receipt per finished application; only the bound proof's pictures kept; never another person's)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_receipt_store.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# FEATURE 9 (20261026090009): the profile and tracker on the account. It redefines career_host_commit and the account
# authority trigger, which the phases above re-created from older files, so it is applied here, last, twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026090009_career_account_memory.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026090009_career_account_memory.sql"
echo "== career_account_memory.test.sql (facts and tracker set in one thread are read in another; erase forgets them; a stale concurrent commit is refused)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_account_memory.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# People finding at scale (20261027170000): imports in parts, indexed reads, the push paged with no cap, forget in every chat.
echo "== career_people_scale.test.sql (30,000-row export in parts; indexed, bounded reads; due reminders paged; forget across chats)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_people_scale.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# FEATURE 1 (20261026100001): the chat's apply queue write holds the 30-day employer rule; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026100001_career_apply_want_guard.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026100001_career_apply_want_guard.sql"
echo "== career_apply_want_guard.test.sql (the queue write refuses an employer applied to in 30 days; already queued unchanged; no product number)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_want_guard.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# F-RUNNER (20261026100000): the cloud runner's dispatch claim, per-portal claim and check rates; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026100000_career_apply_cloud_runner.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026100000_career_apply_cloud_runner.sql"
echo "== career_apply_cloud_runner.test.sql (global and per-portal limits through the one claim; a check is needs_user, counted per host; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_cloud_runner.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Google verification (20261026200011): disconnecting Google deletes the mail rows read from that Gmail; applied twice.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026200011_google_disconnect_erase.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026200011_google_disconnect_erase.sql"
echo "== google_disconnect_erase.test.sql (a disconnect deletes the mail events, drafts and cursor; a reconnect keeps them; nobody else's)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/google_disconnect_erase.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# LAUNCH READINESS (2026-10-26, audit PR #192): erase completeness (S2), the per-person turn gate (R1) and the pool's
# index (X3), each applied twice (idempotent) on the latest schema, with their tests. The definer lockdown's checks run
# last, below, over the whole schema.
for m in 20261026230100_career_erase_complete.sql 20261026230300_career_turn_gate.sql 20261026230400_career_kb_postings_recency_index.sql; do
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
done
echo "== career_erase_complete.test.sql (forget everything empties every career and channel table of the person; account deletion leaves no user_id row)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_erase_complete.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_turn_gate.test.sql (a person's turns one at a time, in ticket order; a lapsed ticket never blocks; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_turn_gate.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_turn_gate_race.py (two real sessions enter at once: the second waits; S4)"
python3 "$HERE/career_turn_gate_race.py" "${PSQL[@]}"
echo "== career_account_memory_one_copy_race.py (two threads of one person save at once: no deadlock, one copy; root cause 3)"
python3 "$HERE/career_account_memory_one_copy_race.py" "${PSQL[@]}"
echo "== career_kb_postings_recency_index.test.sql (the pool read walks the posted_at index, no sort)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_kb_postings_recency_index.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Every turn leaves a cost row (20261028050000): zero calls and unrecorded are different rows; applied twice (idempotent).
for m in 20261028050000_agent_turn_costs_always_recorded.sql; do
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
done
echo "== turn_cost_always_recorded.test.sql (a zero-call turn and an unrecorded turn are different rows; unrecorded is never 0)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/turn_cost_always_recorded.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# D-MS-2 / D-MS-3 and the owner's no-limits rule (2026-10-27): no volume limit of Trainee's own, no company rule, only the
# exact same posting refused; a portal's refusal is the only thing that holds work back (20261027140000); every claim
# fair across people and parallel (20261027141000). Applied last (they rewrite the claims every file above re-created),
# each twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027140000_career_apply_host_backoff.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027140000_career_apply_host_backoff.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027141000_career_apply_mass_submit.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027141000_career_apply_mass_submit.sql"
# The workers' shared host gate over the same table (20261028120000), twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028120000_career_apply_host_gate.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028120000_career_apply_host_gate.sql"
echo "== career_apply_host_gate.test.sql (the workers' shared gate: a refusal holds the host for every instance, Retry-After or doubling; ok starts over)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_host_gate.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_mass_submit.test.sql (120 a day queued; 50 claimed at once; a 500-item card approved by one call; two roles at one employer; the same posting refused; every approval, hash and resume check kept)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_mass_submit.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_apply_host_backoff.test.sql (no pace of Trainee's own; a portal's refusal holds its host back, its Retry-After or doubling; resumes when it accepts)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_host_backoff.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Billing by text (20261028130000): user_subscriptions.cancel_at_period_end, twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028130000_billing_cancel_at_period_end.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028130000_billing_cancel_at_period_end.sql"
echo "== billing_cancel_at_period_end.test.sql (a plan ending at period end is on the row; RLS on; no client writes)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/billing_cancel_at_period_end.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# M4 (20261027230000): Outlook as a peer of Gmail. The ledger above applied it once; it must apply cleanly twice more.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027230000_career_outlook_connector.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027230000_career_outlook_connector.sql"
echo "== career_outlook_connector.test.sql (links once and bound; leased claims; sends once; disconnect erases, cancels, burns; no anon access)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outlook_connector.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Task 3 (20261028110000): the connector framework. The ledger above applied it once; it must apply cleanly twice more
# (its behavior is tested on a real Postgres by tests/architect/connector-framework.test.ts and connector-guards.test.ts).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028110000_career_connector_framework.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028110000_career_connector_framework.sql"
# The global daily model budget (20261028070000): one row per Chicago date, reserve/settle/release/expire; applied twice (idempotent).
for m in 20261028070000_global_daily_model_budget.sql; do
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
  "${QUIET[@]}" -f "$ROOT/supabase/migrations/$m"
done
echo "== global_daily_model_budget.test.sql (reserve inside the limit, refuse over it, one alert, missing usage keeps spend, service role only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/global_daily_model_budget.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== claim guards on the latest schema (scripts/launch/verify-claim-guards.sql)"
"${PSQL[@]}" -f "$ROOT/scripts/launch/verify-claim-guards.sql"
if [[ -f "$BRIDGE_PATH" ]]; then
  echo "== card-cloud bridge (latest schema, standalone up twice; no enclosing transaction)"
  "${PSQL[@]}" -f "$BRIDGE_PATH"
  "${PSQL[@]}" -f "$BRIDGE_PATH"
  "${PSQL[@]}" -c "insert into public.upmore_migration_ledger(filename,sha256) values ('$BRIDGE_NAME','$(sha256sum "$BRIDGE_PATH" | cut -d' ' -f1)')"
  # The bridge applied after the one ledger (20261025100000) replaced the claim's approval re-check; the reconcile puts
  # both halves back and the run stops unless every claim guard is in place. The bridge's tests below then run on that.
  echo "== claim guards after the bridge (scripts/launch/verify-claim-guards.sql)"
  "${PSQL[@]}" -f "$ROOT/scripts/launch/verify-claim-guards.sql"
  # F-RUNNER: the bridge replaced claim_at; the per-portal claim is regenerated from it and must match it again.
  "${PSQL[@]}" -tAc "select public.career_apply_cloud_claim_portal_install()" | grep -qx installed || { echo "FAIL runner claim re-install"; exit 1; }
  "${PSQL[@]}" -tAc "select public.career_apply_cloud_runner_missing() = '{}'" | grep -qx t || { echo "FAIL runner claim differs from the bridge's claim_at"; exit 1; }
  echo "  ok   the per-portal claim regenerated from the bridge's claim_at"
  for file in career_apply_card_cloud.test.sql career_apply_card_cloud_lifecycle.test.sql; do
    echo "== $file (latest card-bound cloud semantics, all earlier phases retained)"
    "${PSQL[@]}" -v card_cloud_tests_authorized=true -f "$HERE/pending/$file"
  done
  echo "== career_apply_card_cloud_daily_cap.test.sql (the bridge's claim-time cloud15 as its own text; a tap is refused only by the person's own pace; extension/global unchanged)"
  "${PSQL[@]}" -v card_cloud_tests_authorized=true -v card_cloud_disposable_database=postgres \
    -c "select set_config('upmore.test.disposable','card-cloud-daily-cap',false)" \
    -f "$HERE/pending/career_apply_card_cloud_daily_cap.test.sql"
fi
# FEATURE 17 (20261026230017): hosted apply (the text-card cloud route, preparation requests, the bounded push). Last in
# file order, after the card-cloud bridge as go-live applies it; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026230017_career_cloud_hosted_apply.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026230017_career_cloud_hosted_apply.sql"
echo "== career_cloud_hosted_apply.test.sql (text cards to the cloud behind every switch and cap; hosted preparation limits; the asked-for card shown at once)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_cloud_hosted_apply.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# The apply VM (20261028180000), twice (idempotent), then its test: a row is claimed only with a stored approval (cloud_bound_refusal), so it follows the card-cloud bridge that holds the approvals and the hosted-apply file whose settings key (CAREER_CLOUD_TEXT_CARDS) it must keep.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028180000_career_apply_vm_worker.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261028180000_career_apply_vm_worker.sql"
echo "== career_apply_vm_approval.test.sql (the VM claim refuses NOT_APPROVED: no approval, wrong hash, revoked, expired, another person's)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_vm_approval.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# FEATURE 16 (20261026210016): OWNER RULE 2026-10-26, never queued, claimed, prepared or carded without a resume; applied
# twice (idempotent), last, after every phase (the bridge's pending tests included) that queues synthetic payloads.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026210016_career_resume_required.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026210016_career_resume_required.sql"
"${PSQL[@]}" -c "insert into public.upmore_migration_ledger(filename,sha256) values ('20261026210016_career_resume_required.sql','$(sha256sum "$ROOT/supabase/migrations/20261026210016_career_resume_required.sql" | cut -d' ' -f1)') on conflict do nothing"
# #211 meets the resume rule (20261026210017): a person under the one-record rule has a resume on file only from the
# record's entries; applied twice (idempotent), right after 20261026210016, whose function it replaces.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026210017_career_resume_on_file_one_record.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026210017_career_resume_on_file_one_record.sql"
"${PSQL[@]}" -c "insert into public.upmore_migration_ledger(filename,sha256) values ('20261026210017_career_resume_on_file_one_record.sql','$(sha256sum "$ROOT/supabase/migrations/20261026210017_career_resume_on_file_one_record.sql" | cut -d' ' -f1)') on conflict do nothing"
# APPLY SCENARIOS (20261029170000): a quarantined entry (the owner's bank, the answer-all delegation; D-007) is not a
# resume on file; applied twice (idempotent), right after 20261026210017, whose function it replaces.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029170000_career_resume_on_file_quarantine.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029170000_career_resume_on_file_quarantine.sql"
"${PSQL[@]}" -c "insert into public.upmore_migration_ledger(filename,sha256) values ('20261029170000_career_resume_on_file_quarantine.sql','$(sha256sum "$ROOT/supabase/migrations/20261029170000_career_resume_on_file_quarantine.sql" | cut -d' ' -f1)') on conflict do nothing"
echo "== career_resume_on_file: a quarantined entry is no resume on file (D-007)"
"${PSQL[@]}" -t -A -o /dev/null -c "begin;
  insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000c9a01', 'quarantine-resume@example.test'), ('00000000-0000-4000-8000-0000000c9a02', 'own-resume@example.test');
  insert into public.profiles(id) values ('00000000-0000-4000-8000-0000000c9a01'), ('00000000-0000-4000-8000-0000000c9a02');
  insert into public.career_watch_kv(user_id, key, value) values
   ('00000000-0000-4000-8000-0000000c9a01', 'career:account', '{\"memory\":{\"profile\":{\"facts\":[{\"kind\":\"experience\",\"status\":\"confirmed\",\"needs_confirmation\":false,\"confirmation_event_id\":\"q-ev-1\",\"factId\":\"F-033\",\"text\":\"TEST bank entry\"},{\"kind\":\"education\",\"status\":\"confirmed\",\"needs_confirmation\":false,\"confirmation_event_id\":\"q-ev-2\",\"provenance\":\"owner-delegated answer-all\",\"text\":\"TEST delegated entry\"}]}}}'),
   ('00000000-0000-4000-8000-0000000c9a02', 'career:account', '{\"memory\":{\"profile\":{\"facts\":[{\"kind\":\"experience\",\"status\":\"confirmed\",\"needs_confirmation\":false,\"confirmation_event_id\":\"q-ev-3\",\"factId\":\"F-003\",\"text\":\"TEST own entry\"}]}}}');
  insert into public.career_events(user_id, kind, subject, detail) values
   ('00000000-0000-4000-8000-0000000c9a01', 'fact_confirmed', 'TEST', '{\"confirmation_event_id\":\"q-ev-1\"}'),
   ('00000000-0000-4000-8000-0000000c9a01', 'fact_confirmed', 'TEST', '{\"confirmation_event_id\":\"q-ev-2\"}'),
   ('00000000-0000-4000-8000-0000000c9a02', 'fact_confirmed', 'TEST', '{\"confirmation_event_id\":\"q-ev-3\"}');
  do \$\$ begin
    if public.career_resume_on_file('00000000-0000-4000-8000-0000000c9a01') then raise exception 'FAIL a quarantined entry read as a resume on file'; end if;
    if not public.career_resume_on_file('00000000-0000-4000-8000-0000000c9a02') then raise exception 'FAIL the person''s own confirmed entry is a resume on file'; end if;
    raise notice 'ok   a quarantined entry is no resume on file; the person''s own confirmed entry is';
  end \$\$;
  rollback;" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# BACK OFF, THEN RESUME (20261029180000): a host's refusal before anything was sent puts the same job back, not handed out
# before its not-before time, its approval kept; applied twice (idempotent), after 20261029170000 and every file whose
# claims and guard (career_apply_jobs_fixed) it builds on.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029180000_career_apply_refusal_requeue.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029180000_career_apply_refusal_requeue.sql"
"${PSQL[@]}" -c "insert into public.upmore_migration_ledger(filename,sha256) values ('20261029180000_career_apply_refusal_requeue.sql','$(sha256sum "$ROOT/supabase/migrations/20261029180000_career_apply_refusal_requeue.sql" | cut -d' ' -f1)') on conflict do nothing"
echo "== career_apply_refusal_requeue.test.sql (refused before submit: the same job queued again, not claimed before the host's hold ends, then once; every refusal backs off again, no cap; unknown, finished, checks, the extension never put back)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_refusal_requeue.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# CLAIMED, NEVER STARTED (20261029190000): a claim the worker lets go before its engine started goes back to the queue,
# the same job with its approval, and runs later once; applied twice (idempotent), after 20261029180000.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029190000_career_apply_unstarted_requeue.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029190000_career_apply_unstarted_requeue.sql"
"${PSQL[@]}" -c "insert into public.upmore_migration_ledger(filename,sha256) values ('20261029190000_career_apply_unstarted_requeue.sql','$(sha256sum "$ROOT/supabase/migrations/20261029190000_career_apply_unstarted_requeue.sql" | cut -d' ' -f1)') on conflict do nothing"
echo "== career_apply_unstarted_requeue.test.sql (claimed, never started: the same job queued again with its approval, run later once; a started, finished, proven, lapsed or extension drive never put back; a card-bound cloud job too)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_unstarted_requeue.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# TRAINEE FILE SIGN-IN (20261029230000): sessions held as a hash, revocable one or all; a link's sign-in begun once, its
# texts and code tries counted atomically under their caps, used up once; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029230000_trainee_file_sessions.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029230000_trainee_file_sessions.sql"
echo "== trainee_file_sessions.test.sql (a link's sign-in once; texts and tries capped atomically; sign out one or everywhere; deleted account takes its sessions; anon and signed-in people read nothing)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/trainee_file_sessions.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_resume_required.test.sql (no resume hash: not queued, not claimed, not prepared, not carded; the resume on file needs its events; uploads erased)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_resume_required.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# FEATURE 16 (20261026220016): Telegram's login links a chat once, to one account; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026220016_channel_telegram_login.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261026220016_channel_telegram_login.sql"
echo "== channel_telegram_login.test.sql (a signed sign-in links once; a replay, another account's Telegram, a second Telegram refused; unlink)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/channel_telegram_login.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== claim guards after the resume rule (scripts/launch/verify-claim-guards.sql)"
"${PSQL[@]}" -f "$ROOT/scripts/launch/verify-claim-guards.sql"
# The scale load test, last, on the whole schema (the bridge draft and the owner's resume rule included): 10,000 people x
# 50 approved applications (each with a resume on file) and one person with 2,000, claimed by 20 concurrent workers.
echo "== career_apply_claim_load.py (10,000 people x 50 approved applications, 20 concurrent workers: exactly once, fair, measured)"
python3 "$HERE/career_apply_claim_load.py" "${PSQL[@]}"
# Outreach v2 (lane N2): the leased claim of due networking follow-up reminders; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027160000_career_outreach_followup_claim.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027160000_career_outreach_followup_claim.sql"
echo "== career_outreach_followup_claim.test.sql (due reminders claimed in leased batches, oldest first, everyone reached; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outreach_followup_claim.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Outreach v2 (lane N2, ruling R1): the person's contacts on the account, at any size; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027160100_career_account_contacts.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027160100_career_account_contacts.sql"
echo "== career_account_contacts.test.sql (account contacts: epoch-checked writes, forget remembered, 50,000 rows on indexes, erased; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_account_contacts.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# Mass networking (lane M1, 20261027200000): the sending rail's queue, claim and guards; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027200000_career_send_queue.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027200000_career_send_queue.sql"
echo "== career_send_queue.test.sql (exactly once per approval; skip-locked account leases; Gmail's own backoff; opt-out, bounce, disconnect, erase; no volume number)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_send_queue.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# MASS NETWORKING M5 (20261027240000, after M1's rail, which it hands every approved email to): replies understood as a conversation, follow-ups, calls; applied twice (idempotent).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027240000_career_outreach_replies.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027240000_career_outreach_replies.sql"
echo "== career_outreach_replies.test.sql (a stop is final; one follow-up after the person's own interval, never past a reply or before an OOO return; one event; leases; fairness)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outreach_replies.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_outreach_replies_load.py (10,000 people, 50,000 approved actions, 20 concurrent workers: exactly once, fair)"
python3 "$HERE/career_outreach_replies_load.py" "${PSQL[@]}"
# REPLY SCENARIOS (20261029100000): career_outreach_reply_apply and career_outreach_rail_takeback again (an opt-out or a
# bounce cancels every queued email to the address; an out-of-office with a return date delays a queued follow-up; a
# follow-up the rail cancelled before it went is not counted as sent). After 20261027240000 re-created them just above;
# twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029100000_career_outreach_reply_rules.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029100000_career_outreach_reply_rules.sql"
echo "== career_outreach_reply_rules.test.sql (an opt-out or a bounce cancels anyone's queued email to the address; an out-of-office delays a queued follow-up past its return date; a follow-up never sent is never counted)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outreach_reply_rules.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# D-MN-3 (20261027210000): the people provider's dedupe at 1M people rows and its lookup queue under 20 concurrent
# workers (exactly once, fair across people), measured. The ledger above applied it; applied twice more: idempotent.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027210000_career_people_provider.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261027210000_career_people_provider.sql"
echo "== career_people_provider_scale.py (1M people rows: indexed dedupe; 55,000 lookups, 20 workers: exactly once, fair)"
python3 "$HERE/career_people_provider_scale.py" "${PSQL[@]}"
# NETWORKING SCENARIOS (20261029160000): the address guards over the provider above (a role inbox is never format
# evidence; webmail domains learn no format; a bounced format infers nobody new). After 20261027210000's re-application
# just above, which would otherwise overwrite them; twice (idempotent), then the scale run's functions again.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029160000_career_email_format_guards.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029160000_career_email_format_guards.sql"
echo "== career_email_format_guards (a role inbox teaches no format; webmail learns none; a bounced format is suspended)"
"${PSQL[@]}" -t -A -o /dev/null -c "do \$\$ begin
  if not public.career_email_is_role('careers@stripe.com') then raise exception 'FAIL careers@ is a role inbox'; end if;
  if public.career_email_is_role('jane.doe@stripe.com') then raise exception 'FAIL a person is not a role inbox'; end if;
  if not public.career_email_is_webmail('gmail.com') then raise exception 'FAIL gmail.com is webmail'; end if;
  raise notice 'ok   role inboxes and webmail are recognized by the format guards';
end \$\$;" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# CONNECTOR SCENARIOS (20261029200000): a disconnect cancels every email of the mailbox (one a worker holds included), the
# worker's last check, the other mailbox, the replies lane, what waits counted, opt-outs outlive the account. After the
# re-applications of 20261027200000 and 20261028110000 above, which would otherwise overwrite its functions; twice
# (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029200000_career_connector_disconnect_rules.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261029200000_career_connector_disconnect_rules.sql"
echo "== career_connector_disconnect_rules.test.sql (every email of a disconnected mailbox cancelled, held ones too; nothing re-queued after a reconnect; opt-outs outlive the account)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_connector_disconnect_rules.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# CHANNEL DELIVERY SCENARIOS (20261030000000): a reply in parts at any length, and in order (an earlier part waiting in any
# way, a retry that is due included, holds every later part in each claim). After the re-application of 20261021070000
# above, which would otherwise put back the 50-part ceiling and the old claims; twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030000000_career_outbox_parts_order.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030000000_career_outbox_parts_order.sql"
echo "== career_outbox_parts_order.test.sql (120 parts are 120 rows, claimed run by run in order; any earlier part waiting holds the rest; a final failure lets the rest go; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outbox_parts_order.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# ONE CONFIRM, ONE TRANSACTION (20261030010000): the card opened and answered at once, bound to the hash shown, so two approvals
# at once cannot close each other's card in between. On the final card functions above; twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030010000_career_apply_card_confirm.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030010000_career_apply_card_confirm.sql"
echo "== career_apply_card_confirm.test.sql (the exact hash queued once; a changed hash or someone else's refused; a confirm cannot be closed by another card; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_card_confirm.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# BILLING WEBHOOK SYNC (20261030020000): stripe-webhook writes a subscription only through billing_sync_subscription, so a
# replayed or late event never puts back an older state and a subscription never lands on another person's row. Twice
# (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030020000_billing_webhook_sync.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030020000_billing_webhook_sync.sql"
echo "== billing_webhook_sync.test.sql (the later read wins; an old subscription never replaces a live one; another person's customer refused; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/billing_webhook_sync.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# INGEST, BOUNDED (20261030030000, production 2026-10-29: statement timeouts on touch/write postings, URLs too long, runs
# with no log row): the GIN index without a pending list, room for HOT touches, the rows a run compares without descriptions, a board read in parts, a run's row from its start. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030030000_career_ingest_bounded.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030030000_career_ingest_bounded.sql"
echo "== career_ingest_bounded.test.sql (GIN without a pending list, fill factor 85, a touch leaves search alone; known rows without descriptions, service only; pass and run-status checks)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_ingest_bounded.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# OUTREACH SCENARIOS (20261030040000): the rail's claim hands over no outreach email whose approval is more than 7 days old
# (it lapses), and hands a follow-up over with its sequence's sent emails, read right before it goes. On the claim the send
# queue migration above built; twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030040000_career_send_claim_guards.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030040000_career_send_claim_guards.sql"
echo "== career_send_claim_guards.test.sql (a lapsed approval is cancelled and its draft lapses; a fresh one goes; a follow-up carries its sequence; an answer stops it; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_send_claim_guards.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# ERASE SCENARIOS ROUND 2 (20261030050000): a refreshed token is written back only while its connection exists (and is the
# same account); another account's connect is the old mailbox's disconnect; a deleted account is quiet; the deletion
# record. On the disconnect rules and the claim above; twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030050000_account_erase_r2.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030050000_account_erase_r2.sql"
echo "== account_erase_r2.test.sql (refresh write only while connected and the same account; another account cancels the old mailbox's sends and erases its mail; a deleted account is quiet; the deletion record names nobody; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/account_erase_r2.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# RESUME CONFIRM RACE (20261030060000): a resume confirmation's fact_confirmed events (and so the resume record) commit with
# the turn's save or not at all. On the final career_host_commit and resume record above; twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030060000_career_resume_confirm_atomic.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030060000_career_resume_confirm_atomic.sql"
echo "== career_resume_confirm_atomic.test.sql (a refused save writes no evidence; evidence without state, a failed event write or a malformed list fails the whole commit; accepted once; a replay writes nothing twice; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_resume_confirm_atomic.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# PROACTIVE SCENARIOS ROUND 2 (20261030070000): a job alert queued against the person's settings as they are now, counted in
# the same step; a held row marked; the template budget claimed one at a time; an interview marked moved or cancelled. On
# the outbox, the window and the interviews above; twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030070000_proactive_r2.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030070000_proactive_r2.sql"
echo "== proactive_r2.test.sql (the day's and week's cap, the fit floor, off and paused at the moment of queuing; held rows marked; the template budget claimed; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/proactive_r2.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# EVERY CONFIRMATION WITH ITS SAVE (20261030080000): a fact stated in chat and the brain's confirm_profile_fact commit their
# fact_confirmed events with the turn's save too (career_host_commit_evidenced, replaced). Applied twice; then its test, and
# #318's test again over the replacement (every resume-confirmation rule still holds).
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030080000_career_evidence_every_confirmation.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030080000_career_evidence_every_confirmation.sql"
echo "== career_evidence_every_confirmation.test.sql (a refused save writes no stated fact's event; stated facts and brain confirmations accepted with their save, once; evidence without state fails the whole commit)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_evidence_every_confirmation.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== career_resume_confirm_atomic.test.sql again, over 20261030080000"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_resume_confirm_atomic.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# NETWORKING ROUND 2 (20261030090000): "stop emailing X" stops every email of this person's to X that has not gone (queued,
# held by a worker, approved and shown drafts, follow-ups shown or approved) and turns follow-ups off, and nothing else;
# discovery marks an opted-out or bounced address as blocked; a held email sent before the stop is recorded as sent.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030090000_career_outreach_stop_address.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030090000_career_outreach_stop_address.sql"
echo "== career_outreach_stop_address.test.sql (stop emailing X: exactly this person's waiting emails to X; a held one stops at its last check; a sent one is recorded; candidates marked blocked; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outreach_stop_address.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# CHANNEL DELIVERY ROUND 2 (20261030100000): a row's messages that went (sent_parts), a provider's late "failed" mapped back
# to the message that failed (in any order, once), a row bound to a channel the person no longer has sent home or failed with
# the reason, a WhatsApp number given to someone else or moved, the home channel's held rows. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030100000_channel_delivery_r2.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030100000_channel_delivery_r2.sql"
echo "== channel_delivery_r2.test.sql (sent_parts; rehold and fail_sent from the failed message, out of order, once; reroute or fail with the reason; a number released or moved; set home; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/channel_delivery_r2.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# INGEST ROUND 2 (20261030110000): a lane run's boards claimed in one statement (two runs never read one board), a failing
# board's backoff (1 h at 2 failures, doubling, at most a day), and a closed posting closes the applications still queued
# for it. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030110000_career_ingest_r2.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030110000_career_ingest_r2.sql"
echo "== career_ingest_r2.test.sql (the claim: oldest first, marked reading in the same statement, a failing board waits; service only; a closed posting's queued application not sent)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_ingest_r2.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# IDENTITY SCENARIOS (20261030120000): a Telegram chat may ask to be linked; a Telegram contact keeps the number it shared; the
# number's account comes back with the person's STOP; a yes for a second chat on a channel moves the account to it; a sign-up
# refusal is recorded as such (refused_at); the open question of a chat that asked. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030120000_channel_identity.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030120000_channel_identity.sql"
echo "== channel_identity.test.sql (a Telegram chat asks; its number kept; the number's account with the person's STOP; a second chat on a channel moves on a yes; a refusal said once; the open question; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/channel_identity.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# BILLING ROUND 2 (20261030130000): the webhook writes the price's currency, a discount and how many subscriptions are live
# through billing_sync_subscription's 13-argument form (the 10-argument form kept as a wrapper). Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030130000_billing_r2.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030130000_billing_r2.sql"
echo "== billing_r2.test.sql (currency, discount and live count written; the same rules as before; the 10-argument form still writes; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/billing_r2.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# SUBMIT WORKER ROUND (20261030140000): every claim ends, with its reason, what may never go as approved (a closed posting, an
# expired approval, a changed account, a resume no longer confirmed); a not-before not yet due no longer holds the person's
# place (at the worker's millisecond); the cloud claim never returns a row it did not claim; the employer's email confirms a
# drive still recorded as running; the reconcile keeps the rewrites. Twice (idempotent), the claim guards, then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030140000_career_apply_submit_worker.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030140000_career_apply_submit_worker.sql"
"${PSQL[@]}" -f "$ROOT/scripts/launch/verify-claim-guards.sql"
echo "== career_apply_submit_worker.test.sql (closed, expired, reset, resume gone: ended with words; paused waits; a not-before holds no place; the worker's millisecond; the email for a running drive; the reconcile keeps it; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_submit_worker.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# INGEST RE-READ GAP (20261030150000): a board attempted less than the gap ago, its read finished or not, is not claimed
# (two runs of a lane back to back, the first finished, used to read every board of a small lane twice); the backoff and
# the in-flight rule stay; the 3-argument form is the same claim with the plan's 10 minutes. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030150000_career_ingest_reread_gap.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030150000_career_ingest_reread_gap.sql"
echo "== career_ingest_reread_gap.test.sql (two claims back to back, the first run finished between: disjoint boards; the gap, the backoff and the in-flight rule; the 3-argument form; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_ingest_reread_gap.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# NO WEEKLY ALERT CAP (20261030180000): career_alert_enqueue no longer answers 'capped' on a rolling-week count.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030180000_career_alert_no_weekly_cap.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030180000_career_alert_no_weekly_cap.sql"
echo "== career_alert_no_weekly_cap.test.sql (30 alerts in a week all queue; the daily pacing, a key once, quiet hours, the fit floor stay)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_alert_no_weekly_cap.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# APPROVAL RATE (20261030190000): approval_rate() / approval_rate_v per kind over a rolling 7 days, 'insufficient data' under 20.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030190000_approval_rate.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261030190000_approval_rate.sql"
echo "== approval_rate.test.sql (unchanged approvals / shown, edits and redos are misses, the sample floor, the 95 line, service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/approval_rate.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# CLOUD AUTHORIZE, CLOSED POSTING (20261031000000): the card-bound cloud route's check before Submit ends an application
# whose posting closed as not sent, in the person's words, and answers authorized: false; the reconcile keeps it. Twice
# (idempotent), the claim guards, then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031000000_career_apply_cloud_authorize_closed.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031000000_career_apply_cloud_authorize_closed.sql"
"${PSQL[@]}" -f "$ROOT/scripts/launch/verify-claim-guards.sql"
echo "== career_apply_cloud_authorize_closed.test.sql (a closed posting ended at the cloud check before Submit, in the person's words; an open one untouched; the reconcile keeps it; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_apply_cloud_authorize_closed.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# CLOCK SWEEP (20261031010000): a card is shown no later than the transaction that shows it, so an application one Confirm
# (or a card pushed by a worker whose clock runs ahead) approved is bound to that card and the cloud's text route takes it.
# Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031010000_clock_sweep.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031010000_clock_sweep.sql"
echo "== clock_sweep.test.sql (one Confirm and a card pushed by a worker 2 s ahead: the application bound to its card; an earlier time kept; no client)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/clock_sweep.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# OUTREACH R3 (20261031020000): the sending rail's hand-off takes the person's lock (two approvals to one address queue
# one email), a newer approval of the same draft replaces the one waiting, a refusal for good says why on the draft; the
# worker's last check stops an email to an address that opted out or bounced since the claim, and a follow-up whose
# sequence was answered; a retried email whose approval lapsed is not sent. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031020000_career_outreach_r3.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031020000_career_outreach_r3.sql"
echo "== career_outreach_r3.test.sql (supersede, refusal reasons, the last check after a stop / bounce / answer, the lapsed retry, service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_outreach_r3.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# TELEGRAM ROUND 3 (20261031030000): "/start <code>" from a chat that is another account's links nothing and no longer uses the
# code up, so its owner's own chat can still open it. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031030000_telegram_link_code_kept.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031030000_telegram_link_code_kept.sql"
echo "== telegram_link_code_kept.test.sql (another account's chat links nothing and leaves the code; the owner's chat then links once; used, expired, forged, malformed, a group: nothing; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/telegram_link_code_kept.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# TELEGRAM LINK OWNERSHIP (20261031040000): opening a link code asks the account's own channel and links nothing; only that
# contact's YES links the chat, within 15 minutes, once. Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031040000_telegram_link_confirm.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031040000_telegram_link_confirm.sql"
echo "== telegram_link_confirm.test.sql (a code asks the account's own channel; only its YES links, once; strangers, races, STOP, deletion, expiry: nothing; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/telegram_link_confirm.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# ONBOARDING ROUND 3 (20261031070000): a resume file sent again is the latest upload (the yes binds to the file that showed the
# entries: the newest upload no later than that message). Twice (idempotent), then its test.
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031070000_career_resume_upload_resend.sql"
"${QUIET[@]}" -f "$ROOT/supabase/migrations/20261031070000_career_resume_upload_resend.sql"
echo "== career_resume_upload_resend.test.sql (a resend is the latest upload, same row; bad bytes refused; service only)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/career_resume_upload_resend.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# LAUNCH READINESS B1 (2026-10-26, audit PR #192): the definer lockdown, last, on the schema every phase above left
# (the card-cloud bridge included). The test applies it (twice) over production's shape, then checks the whole schema:
# no SECURITY DEFINER function anon can run, none without a fixed search_path.
# Every SECURITY DEFINER function any migration declares (read by scripts/launch/definer-revoke-scan.cjs) exists in this
# schema, so the lockdown test below covers all of them; a definer-making file the suite does not apply fails here.
echo "== every definer function a migration declares is built by this suite"
node "$ROOT/scripts/launch/definer-revoke-scan.cjs" --definer-keys "$ROOT/supabase/migrations" > "$WORK/definer-keys.tsv"
cat > "$WORK/definer-keys.sql" <<SQL
create temp table k(file text, sch text, fn text, types text);
\\copy k from '$WORK/definer-keys.tsv'
do \$\$
declare missing text; n int;
begin
  select count(*) into n from k;
  select string_agg(file || ' ' || sch || '.' || fn || '(' || types || ')', '; ' order by file) into missing from k
  where case when types = '*' then not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = k.sch and p.proname = k.fn)
             else to_regprocedure(format('%I.%I(%s)', sch, fn, types)) is null end;
  if missing is not null then raise exception 'FAIL definer functions a migration declares but this suite never builds: %', missing; end if;
  raise notice 'ok   all % definer functions the migrations declare exist in the suite''s schema', n;
end \$\$;
SQL
"${PSQL[@]}" -t -A -o /dev/null -f "$WORK/definer-keys.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== definer_lockdown.test.sql (the fourteen functions as set live; no definer function anon can run; every one with a search_path)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/definer_lockdown.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
# ISOLATION + SCALE (2026-10-30), last, on the final schema: two people, anon and a stranger's chat against every table, policy and
# RPC the agent-chat, trainee-file and trainee-connect paths reach (it found credit_pending_referral open to any signed-in person,
# closed by 20261030160000); then 200 people interleaving turns in real concurrent sessions (one model slot each, the global
# budget never overspent, one queued application per Apply however many taps). Rolls back / removes its own rows.
echo "== isolation_surface.check.sql (A, anon and another chat cannot read, write, approve or queue anything of B's)"
"${PSQL[@]}" -t -A -o /dev/null -f "$HERE/isolation_surface.check.sql" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
echo "== isolation_scale.py (200 people interleaving turns: idempotent reservations, no budget overspend, one queued application per Apply)"
python3 "$HERE/isolation_scale.py" "${PSQL[@]}"
echo "db tests passed"
