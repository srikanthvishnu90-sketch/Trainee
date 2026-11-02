#!/bin/bash
# Rehearses go-live's migration step (scripts/launch/trainee-go-live.sh, step 2) on a throwaway local Postgres whose
# schema mimics the live project, then compares the result with a database built from every migration in file order.
# Nothing here touches the live project. Run as a non-root user with the Postgres binaries on PATH or in PGBIN:
#   PGBIN=/usr/lib/postgresql/16/bin bash tests/db/rehearse_live_migrations.sh
#
# The live snapshot (2026-10-26, read-only queries of project mrwngntwmnaqrqhupvlt): every MIGRATION_MARK read true but
# the 16 below, plus the 2026-10-25 files after 20261025100000 (not yet applied anywhere live), plus the eight
# 2026-10-26 files trunk added the same day (the launch-readiness audit, PR #192, read all 32 as missing live: 33 of
# go-live's 65 marks true). Without those eight the mimic applied them before what they need and the job failed on
# trunk itself. Override with LIVE_MISSING="<file> <file> ..." when the live project moves on.
#   And one hand edit: 20261021050000_career_brief_digest.sql was applied live as a "live_safe" variant that skipped
#   its career_outbox kind/key check changes (the career_host_commit with career_interviews is there; the outbox
#   constraints are what the migrations before it left). LIVE_SAFE_BRIEF_DIGEST=0 applies the full file instead.
#
# Phases (each line ends ok or FAIL; exit 1 on any FAIL):
#   1 live mimic   stubs, the base migrations as production has them, then each Trainee migration whose mark is live,
#                  in file order, the missing ones skipped; every mark then reads exactly as the snapshot says
#   2 go-live      the MIGRATIONS and MIGRATION_MARK arrays read from trainee-go-live.sh, applied exactly as step 2 does:
#                  in order, only when the mark is false, psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f, the mark
#                  read again after; then scripts/launch/verify-claim-guards.sql; then every mark must read true
#   3 parity       a second database from every migration in file order (what the repo means); every public function
#                  body, constraint, trigger, column and policy compared with the rehearsed one, each difference named
set -euo pipefail
export LC_ALL=C LANG=C
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GO_LIVE="$ROOT/scripts/launch/trainee-go-live.sh"
PGBIN="${PGBIN:-$(dirname "$(command -v postgres)")}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/trainee-rehearse.XXXXXX")"
PORT="${PGTEST_PORT:-54331}"; PORT2=$((PORT + 1))
cleanup() {
  "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  "$PGBIN/pg_ctl" -D "$WORK/data2" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 20261026120018 (one confirmed resume) is NOT APPLIED and replaces career_apply_profile_for, created by 20261025120000.
LIVE_MISSING_DEFAULT="20261026120018_career_resume_one_record.sql 20261020110000_career_connector.sql 20261020130000_career_resume_tailoring.sql
  20261021020000_career_voice_mock.sql 20261021030000_career_hired_backgrounds.sql 20261021090000_career_mail_erase.sql
  20261021100000_career_proactive_last_word.sql 20261021110000_career_board_state.sql
  20261021130000_career_mail_model_calls.sql 20261021220430_career_apply_message_cards.sql
  20261022110000_career_postings_pay.sql 20261022120000_career_control_state.sql 20261022120500_career_deploy_ledger.sql
  20261023100000_career_events_apply_queued.sql 20261024130000_career_apply_card_cloud_bridge.sql
  20261024140000_career_batch_approve_exclude.sql 20261025100000_career_apply_one_ledger.sql
  20261025110000_career_apply_bridge_reconcile.sql 20261025120000_career_apply_prepare_ahead.sql
  20261025130000_career_apply_wanted_candidates.sql 20261025140000_career_apply_no_volume_ceiling.sql
  20261025150000_career_apply_pace_parse.sql 20261025160000_career_apply_pace_state.sql
  20261025170000_career_apply_card_yes_window.sql 20261025180000_career_outbox_card_id.sql
  20261026060006_career_more_providers.sql 20261026060106_career_ingest_runs.sql 20261026070007_career_alert_min_fit.sql
  20261026080008_career_mail_drafts_sent.sql 20261026090009_career_account_memory.sql
  20261026100000_career_apply_cloud_runner.sql 20261026100001_career_apply_want_guard.sql
  20261026140000_career_apply_receipt_store.sql 20261026200011_google_disconnect_erase.sql
  20261026210016_career_resume_required.sql 20261026210017_career_resume_on_file_one_record.sql 20261026220016_channel_telegram_login.sql
  20261026230100_career_erase_complete.sql 20261026230300_career_turn_gate.sql
  20261026230400_career_kb_postings_recency_index.sql
  20261026230017_career_cloud_hosted_apply.sql 20261027140000_career_apply_host_backoff.sql 20261027141000_career_apply_mass_submit.sql 20261028050000_agent_turn_costs_always_recorded.sql 20261028070000_global_daily_model_budget.sql 20261028120000_career_apply_host_gate.sql
  20261028130000_billing_cancel_at_period_end.sql 20261029100000_career_outreach_reply_rules.sql 20261029160000_career_email_format_guards.sql
  20261029170000_career_resume_on_file_quarantine.sql 20261029180000_career_apply_refusal_requeue.sql 20261029190000_career_apply_unstarted_requeue.sql 20261029200000_career_connector_disconnect_rules.sql 20261029230000_trainee_file_sessions.sql 20261030000000_career_outbox_parts_order.sql 20261030010000_career_apply_card_confirm.sql 20261030020000_billing_webhook_sync.sql 20261030030000_career_ingest_bounded.sql 20261030040000_career_send_claim_guards.sql 20261030050000_account_erase_r2.sql 20261030060000_career_resume_confirm_atomic.sql 20261030070000_proactive_r2.sql 20261030080000_career_evidence_every_confirmation.sql 20261030090000_career_outreach_stop_address.sql 20261030100000_channel_delivery_r2.sql 20261030110000_career_ingest_r2.sql 20261030120000_channel_identity.sql 20261030130000_billing_r2.sql 20261030140000_career_apply_submit_worker.sql 20261030150000_career_ingest_reread_gap.sql 20261031000000_career_apply_cloud_authorize_closed.sql 20261031010000_clock_sweep.sql 20261031020000_career_outreach_r3.sql 20261031030000_telegram_link_code_kept.sql 20261031040000_telegram_link_confirm.sql 20261031050000_career_account_memory_one_copy.sql 20261031070000_career_resume_upload_resend.sql"
# 20261026210016 and 20261026220016 (FEATURE 16, NOT APPLIED) are new here, not live; 20261026210016 reads
# career_apply_profile_for, created by 20261025120000 (missing above).
# The last four are not live: 20261026060006 and 20261026060106 alter career_board_state, created by 20261021110000
# (missing above); 20261026100000 says NOT APPLIED in its header, and applied to the live mimic before the one ledger it
# would generate its portal claim from the older claim_at; 20261026230017 (FEATURE 17) is NOT APPLIED and reads
# career_apply_prepare_attempts, created by 20261025120000 (missing above). The same entries as PR #194's, plus 230017.
[[ -n "${LIVE_MISSING:-}" ]] && LIVE_MISSING_GIVEN=1
read -r -a LIVE_MISSING <<<"$(echo ${LIVE_MISSING:-$LIVE_MISSING_DEFAULT})"
LIVE_SAFE="${LIVE_SAFE_BRIEF_DIGEST:-1}"
BRIEF=20261021050000_career_brief_digest.sql

# The same lists go-live applies and checks (never a copy that could drift).
eval "$(sed -n '/^MIGRATIONS=(/,/^)/p; /^MIGRATION_MARK=(/,/^)/p' "$GO_LIVE")"
(( ${#MIGRATIONS[@]} == ${#MIGRATION_MARK[@]} && ${#MIGRATIONS[@]} > 0 )) || { echo "FAIL could not read MIGRATIONS from $GO_LIVE"; exit 1; }
# Everything from 2026-10-27 on is new since the live snapshot (no deploy since): missing live unless LIVE_MISSING is given.
LIVE_NEW_FROM="${LIVE_NEW_FROM:-20261027000000}"
is_missing() {
  local m
  for m in "${LIVE_MISSING[@]}"; do [[ "$m" == "$1" ]] && return 0; done
  [[ -z "${LIVE_MISSING_GIVEN:-}" && "${1:0:14}" > "$LIVE_NEW_FROM" ]] && return 0
  return 1
}
for m in "${LIVE_MISSING[@]}"; do [[ -f "$ROOT/supabase/migrations/$m" ]] || { echo "FAIL LIVE_MISSING names $m, which is not a migration file"; exit 1; }; done

# Two clusters (the stubs create roles, which a cluster shares): live_mimic on PORT, file_order on PORT + 1.
for d in data:$PORT data2:$PORT2; do
  "$PGBIN/initdb" -D "$WORK/${d%%:*}" -U postgres --auth=trust >/dev/null
  "$PGBIN/pg_ctl" -D "$WORK/${d%%:*}" -o "-p ${d##*:} -k $WORK -c listen_addresses=''" -l "$WORK/${d%%:*}.log" -w start >/dev/null
done
psql_db() { local db="$1" p="$PORT"; shift; [[ "$db" == file_order ]] && p="$PORT2"; "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$p" -U postgres -d "$db" "$@"; }
export PGOPTIONS="-c client_min_messages=warning"
psql_db postgres -c "create database live_mimic"
"$PGBIN/psql" -X -q -h "$WORK" -p "$PORT2" -U postgres -d postgres -c "create database file_order"
FAILS=0
bad() { echo "  FAIL $*"; FAILS=$((FAILS + 1)); }

# The base production has under the Trainee set: tests/db/run.sh's first list (the baseline apply-rails-and-seed.sh
# backfills), then every later file in file order (what its --pending applies), up to the first Trainee file.
BASE_FIRST=(20260923_000001_agent_rate_limits.sql 20260923_000006_rate_limiter_hardening.sql 20260927_000003_agent_usage.sql
  20260926_000001_agent_exec.sql 20260926_000002_agent_exec_otp.sql 20260928_000001_chat_reminders.sql
  20260928_000002_exec_runs_revoked.sql 20260928_000004_exec_trust.sql 20260928_000006_agent_lessons.sql
  20260928_000007_lesson_upsert_rpc.sql 20260928_000011_oauth_connections.sql 20261008_000002_agent_rl_bump_as.sql
  20261010010000_agent_permissions_ledger.sql 20261010020000_execution_integrity.sql 20261010030000_obligation_workflows.sql
  20261010040000_financial_evidence.sql 20261010050000_biller_lifecycle.sql 20261010060000_payment_execution.sql
  20261010070000_message_inbox.sql 20261010080000_message_delivery.sql 20261010090000_chat_bridge_rate.sql
  20261010100000_message_turns.sql 20261010110000_model_call_budget.sql 20261010120000_chat_lesson_ownership.sql
  20261010130000_transaction_reviews.sql 20261010140000_linked_transaction_review.sql 20261010150000_obligation_edits.sql
  20261010160000_applied_payment_reconciliation.sql 20261010170000_payment_queue_fairness.sql
  20261010180000_recovery_snapshot.sql 20261010190000_recovery_cases.sql 20261011010000_flow_state.sql
  20261011020000_saved_recipients.sql 20261011030000_brokerage_accounts_per_user.sql)
build_base() { # build_base <db>
  local db="$1" f b
  psql_db "$db" -f "$HERE/stubs.sql" >/dev/null 2>&1
  for b in "${BASE_FIRST[@]}"; do psql_db "$db" -f "$ROOT/supabase/migrations/$b" >/dev/null; done
  for f in "$ROOT"/supabase/migrations/*.sql; do
    b="$(basename "$f")"
    [[ "$b" > 20261011030000_brokerage_accounts_per_user.sql && "$b" < 20261019 ]] || continue
    psql_db "$db" --single-transaction -f "$f" >/dev/null
  done
}
apply_file() { # apply_file <db> <file> [live_safe]: one transaction, as go-live applies it
  local db="$1" f="$2" src="$ROOT/supabase/migrations/$2"
  if [[ "${3:-}" == live_safe ]]; then
    # The live variant: the file without its career_outbox kind/key constraint statements.
    src="$WORK/live_safe_$f"
    grep -v -E '^alter table public\.career_outbox (drop|add) constraint (if exists )?career_outbox_(kind|key)_check' "$ROOT/supabase/migrations/$f" \
      | grep -v -E "^  check \(key ~ '\^\(alert\|report" >"$src"
    grep -q 'career_outbox_kind_check\|career_outbox_key_check' "$src" && { echo "FAIL the live_safe variant of $f still touches the outbox checks"; exit 1; }
  fi
  psql_db "$db" --single-transaction -f "$src" 2>&1
}
mark_of() { psql_db "$1" -tAc "select ($2)"; }

echo "== 1 live mimic (${#LIVE_MISSING[@]} migrations missing live; $BRIEF $([[ "$LIVE_SAFE" == 1 ]] && echo 'as its live_safe variant' || echo 'in full'))"
build_base live_mimic
for i in "${!MIGRATIONS[@]}"; do
  f="${MIGRATIONS[$i]}"
  is_missing "$f" && continue
  if [[ "$f" == "$BRIEF" && "$LIVE_SAFE" == 1 ]]; then out="$(apply_file live_mimic "$f" live_safe)" || { echo "$out"; bad "live mimic: $f (live_safe) does not apply on the live-like schema"; continue; }
  else out="$(apply_file live_mimic "$f")" || { echo "$out"; bad "live mimic: $f does not apply on the live-like schema"; continue; }; fi
done
PRE=()
for i in "${!MIGRATIONS[@]}"; do
  f="${MIGRATIONS[$i]}"; live="$(mark_of live_mimic "${MIGRATION_MARK[$i]}")"; PRE[$i]="$live"
  if is_missing "$f"; then [[ "$live" == f ]] || bad "mark of $f reads true before it is applied (the snapshot says missing)"
  else [[ "$live" == t ]] || bad "mark of $f reads false though it was applied (index $i)"; fi
done
(( FAILS == 0 )) && echo "  ok   every mark reads as the live snapshot: $(printf '%s\n' "${PRE[@]}" | grep -c t) true, $(printf '%s\n' "${PRE[@]}" | grep -c f) false"
OUTBOX_LIVE="$(psql_db live_mimic -tAc "select pg_get_constraintdef(oid) from pg_constraint where conname = 'career_outbox_kind_check'")"
echo "  live-like career_outbox_kind_check: $OUTBOX_LIVE"
# Live has rows: one outbox row of every kind the live check takes, so a migration that narrows a check fails here the
# way it would fail live (a row of a later kind violates the narrower list).
if out="$(psql_db live_mimic -c "insert into auth.users(id, email) values ('00000000-0000-4000-8000-00000000d001', 'rehearsal@example.test')" \
  -c "insert into public.career_outbox(user_id, key, kind, text, deliver_at)
      select '00000000-0000-4000-8000-00000000d001', k || ':rehearsal', k, 'rehearsal row', now()
      from (select (regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''::text', 'g'))[1] k
            from pg_constraint where conname = 'career_outbox_kind_check') x" 2>&1)"; then
  echo "  ok   one outbox row of each live kind seeded ($(psql_db live_mimic -tAc "select count(*) from public.career_outbox"))"
else echo "$out" | sed 's/^/      /'; bad "could not seed the live-like outbox rows"; fi

echo "== 2 go-live's migration step on the live-like schema"
for i in "${!MIGRATIONS[@]}"; do
  f="${MIGRATIONS[$i]}"
  live="$(mark_of live_mimic "${MIGRATION_MARK[$i]}")"
  if [[ "$live" == t ]]; then
    is_missing "$f" && echo "  [$i] $f: mark already true (an earlier apply created it), not applied: CHECK"
    continue
  fi
  if out="$(apply_file live_mimic "$f")"; then
    if [[ "$(mark_of live_mimic "${MIGRATION_MARK[$i]}")" == t ]]; then echo "  [$i] $f: APPLIED, mark true"
    else bad "[$i] $f ran but its mark is still false"; fi
  else
    echo "$out" | sed 's/^/      /'; bad "[$i] $f: FAILED to apply on the live-like schema (go-live would stop here)"
    break
  fi
done
if out="$(psql_db live_mimic -f "$ROOT/scripts/launch/verify-claim-guards.sql" 2>&1)"; then echo "  ok   verify-claim-guards.sql: every claim guard in place"
else echo "$out" | sed 's/^/      /'; bad "verify-claim-guards.sql failed"; fi
n=0; for i in "${!MIGRATIONS[@]}"; do [[ "$(mark_of live_mimic "${MIGRATION_MARK[$i]}")" == t ]] || bad "after go-live, mark of ${MIGRATIONS[$i]} is false"; n=$((n + 1)); done
echo "  marks read again: $n checked"

echo "== 3 parity with a database built from every migration in file order"
build_base file_order
for f in "${MIGRATIONS[@]}"; do out="$(apply_file file_order "$f")" || { echo "$out"; bad "file order: $f does not apply"; }; done
psql_db file_order -f "$ROOT/scripts/launch/verify-claim-guards.sql" >/dev/null 2>&1 || bad "file order: verify-claim-guards.sql failed"
SHAPE="select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  union all select 'constraint ' || c.conrelid::regclass || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
  union all select 'trigger ' || t.tgrelid::regclass || '.' || t.tgname || ' ' || md5(pg_get_triggerdef(t.oid)) from pg_trigger t join pg_class r on r.oid = t.tgrelid join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and not t.tgisinternal
  union all select 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || coalesce(column_default, '') || ' ' || is_nullable from information_schema.columns where table_schema = 'public'
  union all select 'policy ' || tablename || '.' || policyname || ' ' || md5(coalesce(qual, '') || coalesce(with_check, '') || cmd) from pg_policies where schemaname = 'public'
  union all select 'index ' || indexname || ' ' || md5(indexdef) from pg_indexes where schemaname = 'public'
  order by 1"
psql_db live_mimic -tAc "$SHAPE" >"$WORK/rehearsed.txt"
psql_db file_order -tAc "$SHAPE" >"$WORK/file_order.txt"
if diff -u "$WORK/file_order.txt" "$WORK/rehearsed.txt" >"$WORK/shape.diff"; then
  echo "  ok   $(wc -l <"$WORK/rehearsed.txt" | tr -d ' ') objects identical (functions, constraints, triggers, columns, policies, indexes)"
else
  # Name each difference: '-' is what file order has, '+' what the rehearsal left.
  grep -E '^[-+][a-z]' "$WORK/shape.diff" | sed 's/^-/  file order only: /; s/^+/  rehearsal only:  /'
  for obj in $(grep -E '^[-+][a-z]' "$WORK/shape.diff" | awk '{print $1 "|" $2}' | sed 's/^[-+]//' | sort -u); do
    kind="${obj%%|*}"; name="${obj#*|}"
    if [[ "$kind" == function ]]; then
      fn="${name%%(*}"
      who=""; for f in "${MIGRATIONS[@]}"; do grep -qiE "function (public\.)?$fn *\(" "$ROOT/supabase/migrations/$f" && who+=" $f"; done
      echo "    $name is defined by:$who"
    fi
  done
  bad "the rehearsed schema differs from file order ($(grep -cE '^[-+][a-z]' "$WORK/shape.diff") lines above)"
fi
(( FAILS == 0 )) && { echo "REHEARSAL OK"; exit 0; }
echo "REHEARSAL FAILED: $FAILS"; exit 1
