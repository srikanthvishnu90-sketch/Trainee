#!/usr/bin/env bash
# WO-001: career code and its shared boundaries; no live/provider calls.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
failed=0
results=()
details=()
# Each step's output is printed in full, and a failed step's last lines are printed again at the end: the CI log API
# returns only a log's last 5,000 lines, so an early step's own error was unreadable there (2026-10-19).
step() {
  local label=$1 status out started elapsed
  shift
  out=$(mktemp)
  # Each step's wall time is in its result line (and so in the CI "gate steps" annotation): the job log is not
  # always readable through the API, and the partition balance in .github/workflows/ci.yml is set from these.
  started=$SECONDS
  if "$@" >"$out" 2>&1; then
    elapsed=$((SECONDS - started))
    cat "$out"
    printf 'STEP %s OK (%s s)\n' "$label" "$elapsed"
    results+=("OK      $label (${elapsed} s)")
  else
    status=$?
    elapsed=$((SECONDS - started))
    cat "$out"
    printf 'STEP %s FAILED (exit %s, %s s)\n' "$label" "$status" "$elapsed" >&2
    results+=("FAILED  $label (exit $status, ${elapsed} s)")
    # The failed tests by name, wherever they are in a long log (a CI log read from its tail may not reach them), each
    # with its whole TAP block: a multi-line error (an assertion's diff, a call log) was cut at "error: |-" (2026-10-20).
    details+=("--- $label, its failed tests:" "$(awk '/=> [^ ]+:[0-9]+:[0-9]+/ { print; next }
      /^[[:space:]]*not ok / { block = 1 }
      block { print }
      block && /^[[:space:]]*\.\.\.[[:space:]]*$/ { block = 0 }' "$out" | sed -n '1,200p')")
    details+=("--- $label, its last 20 lines:" "$(tail -n 20 "$out")")
    failed=1
  fi
  rm -f "$out"
}

# A missing browser must fail the gate rather than turn driver tests into skips. The first launch on a fresh runner
# pays the cold start; how long the launch took is printed either way.
browser_ready() {
  node <<'JS'
const pw = require(process.env.UPMORE_PLAYWRIGHT_PATH || 'playwright');
const started = Date.now();
(async () => {
  const browser = await pw.chromium.launch({headless:true, chromiumSandbox:true,
    ...(process.env.UPMORE_CHROMIUM_PATH ? {executablePath:process.env.UPMORE_CHROMIUM_PATH} : {}), timeout:60000});
  await browser.close();
  console.log(`browser launched and closed in ${Date.now() - started} ms`);
})().catch(error => {
  console.error(`browser did not launch after ${Date.now() - started} ms: ${error.message}`);
  process.exitCode=1;
});
JS
}

shared_tests=(
  tests/router-bundle.test.cjs
  tests/chat-request-controller.test.cjs
  tests/chat-request-integration.test.cjs
  tests/photo-only.test.cjs
  tests/no-password-storage.test.cjs
  tests/no-secrets.test.cjs
  tests/export-coverage.test.cjs
  tests/trainee-go-live.test.cjs
  tests/deploy-provenance.test.cjs
  tests/outbox-kinds.test.cjs
  tests/career-bundle-data.test.cjs
  tests/depth-CAREER-WRITING.test.cjs
  tests/extension-package.test.cjs
  tests/extension-package-agent.test.cjs
  tests/edge-runtime-globals.test.cjs
)
# Architect ruling: historical external-file evidence stays archived, not
# edited or deleted. Every other career test remains in the automatic selection.
declare -A archive_tests=(
  [tests/career-a4-carriage-w5.test.cjs]=1
  [tests/career-clock-source-guard.test.cjs]=1
  [tests/career-gauntlet-cvar-a.test.cjs]=1
  [tests/career-gauntlet-cvarb.test.cjs]=1
  [tests/career-gauntlet-pilot.test.cjs]=1
  [tests/career-gauntlet-r2.test.cjs]=1
  [tests/career-gauntlet-r2a.test.cjs]=1
  [tests/career-gauntlet-regressions.test.cjs]=1
  [tests/career-gauntlet-rerun.test.cjs]=1
  [tests/career-gauntlet-u.test.cjs]=1
  [tests/career-quality-onboarding.test.cjs]=1
  [tests/career-quality-routing.test.cjs]=1
  [tests/career-spec-gates.test.cjs]=1
  [tests/career-template-breakup-guard.test.cjs]=1
  [tests/career-wording-backlog-guard.test.cjs]=1
)
career_tests=(tests/career-apply-script.test.cjs)
for test_file in tests/career-*.test.cjs; do
  if [[ "$test_file" != tests/career-apply-script.test.cjs && ${archive_tests[$test_file]:-0} != 1 ]]; then
    career_tests+=("$test_file")
  fi
done
# Career host/bridge/persistence contracts also run in the Node staged-entry
# suites. Explicit shared Edge files keep finance suites out of this selection.
edge_tests=(
  tests/edge/chat-input.test.ts
  tests/edge/gmail-code-window.test.ts
  tests/edge/chat-cors.test.ts
  tests/edge/chat-session.test.ts
  tests/edge/identity-redact.test.ts
  tests/edge/model-gateway.test.ts
  tests/edge/model-calls.test.ts
  tests/edge/model-errors.test.ts
  tests/edge/agent-guards.test.ts
  tests/edge/conversation-hardening.test.ts
  tests/edge/career-ingest.test.ts
  tests/edge/career-ingest-scale.test.ts
  tests/edge/career-ingest-bounded.test.ts
  tests/edge/career-alerts.test.ts
  tests/edge/career-proactive.test.ts
  tests/edge/channel.test.ts
  tests/edge/channel-delivery.test.ts tests/edge/channel-integrity.test.ts
  tests/edge/channel-inbound.test.ts
  tests/edge/telegram-link-reply-code.test.ts
  tests/edge/capability-journey.test.ts
  tests/edge/eval-judge.test.ts
  tests/edge/career-apply-store.test.ts
  tests/edge/career-coverage-personas.test.ts
  tests/edge/career-backlog-alerts.test.ts
  tests/edge/career-conversations-eval.test.ts
  tests/edge/career-compare.test.ts
  tests/edge/career-ask-once.test.ts
  tests/edge/control-state.test.ts
  tests/edge/fact-quarantine.test.ts
)

portable_test_paths() {
  python3 - "$@" <<'PY'
from pathlib import Path
import sys
files = {Path(name) for name in sys.argv[1:]}
for path in Path('tests/architect').rglob('*'):
    if path.is_file() and 'pending' not in path.parts and ('.test.' in path.name or '_test.' in path.name):
        files.add(path)
bad = []
for path in sorted(files):
    text = path.read_text()
    if 'your_files' in text or '/workspace/' in text:
        bad.append(str(path))
        print('Non-portable gated test: ' + str(path), file=sys.stderr)
sys.exit(bool(bad))
PY
}

# CI partition (2026-10-23): the single gate job's 30-minute cap cancelled every run on the widget-carrying
# branches (see .github/workflows/ci.yml's comment history). Attribution, corrected the same day: the arch
# line's gate — this same script, byte-identical — succeeds at 19.0-19.2 min; what crossed the cap is
# test-time growth, and the heavy add is ONE suite, tests/career-forms-ci-coverage.test.cjs (40 serial fixture
# drives). The react-select battery is not the cause (it runs in ~11 s, and pre-battery trees cancelled too).
# GATE_PARTITION splits ONLY the node step's suite list between parallel CI jobs: core (everything else, all
# other steps included), browser (the remaining suites that drive a real Chromium, listed here) and coverage
# (the forms-ci suite alone, in its own job, so its drive time is nobody else's sum). Scheduling only: the
# union of the partitions is the full list, and a listed suite missing from the gate's selection fails the
# gate outright rather than silently dropping out of CI. Unset, the gate is exactly what it was — one step,
# every suite.
# Fourth partition (2026-10-26): architect. With the 15 feature PRs of 2026-10-25 merged, core ran 22.0-26.6 min
# and was cancelled at the 30-minute cap on one head (b90495eba); the architect step (Deno, its handler and flow
# tests each provisioning a throwaway Postgres and several driving Chromium) moves to its own job, gate
# (architect), with its companion Deno check of scripts/apply.ts. Core keeps every other step. Scheduling only,
# as above: the steps and their commands are unchanged, and the union of core and architect is the old core.
browser_node_tests=(
  tests/career-apply-dryrun.test.cjs
  tests/career-apply-exact-option.test.cjs
  tests/career-approval-card-browser.test.cjs
  tests/career-dashboard-browser.test.cjs
  tests/career-extension-agent-submits.test.cjs
  tests/career-extension-browser.test.cjs
  tests/career-extension-person-submits.test.cjs
  tests/career-extension-react-select.test.cjs
  tests/career-extension-workday.test.cjs
  tests/career-extension-yesno.test.cjs
  tests/career-fact-import-panel.test.cjs
  tests/career-greenhouse-savedform.test.cjs
  tests/career-owned-worker-browser.test.cjs
  tests/career-parallel-apply.test.cjs
  tests/career-portal-browser.test.cjs
  tests/career-portal-lever-radio.test.cjs
  tests/career-portal-submit-integrity.test.cjs
  tests/career-posting-location.test.cjs
  tests/career-qa-bug04-resolver.test.cjs
  tests/career-react-select-menu-first.test.cjs
  tests/career-resume-upload.test.cjs
  tests/career-widget-attach.test.cjs
  tests/career-workday-native-fields.test.cjs
)
coverage_node_tests=(
  tests/career-forms-ci-coverage.test.cjs
)
partition=${GATE_PARTITION:-all}
if [[ $partition != all && $partition != core && $partition != browser && $partition != coverage && $partition != architect ]]; then
  echo "GATE_PARTITION must be all, core, browser, coverage or architect (got: $partition)" >&2
  exit 1
fi
node_all_tests=("${career_tests[@]}" "${shared_tests[@]}")
declare -A browser_node_set=()
for test_file in "${browser_node_tests[@]}"; do browser_node_set["$test_file"]=1; done
declare -A coverage_node_set=()
for test_file in "${coverage_node_tests[@]}"; do coverage_node_set["$test_file"]=1; done
node_core_tests=()
node_browser_tests=()
node_coverage_tests=()
for test_file in "${node_all_tests[@]}"; do
  if [[ ${coverage_node_set[$test_file]:-0} == 1 ]]; then
    node_coverage_tests+=("$test_file")
  elif [[ ${browser_node_set[$test_file]:-0} == 1 ]]; then
    node_browser_tests+=("$test_file")
  else
    node_core_tests+=("$test_file")
  fi
done
if (( ${#node_browser_tests[@]} != ${#browser_node_tests[@]} || ${#node_coverage_tests[@]} != ${#coverage_node_tests[@]} )); then
  echo "GATE PARTITION BROKEN: ${#node_browser_tests[@]} of ${#browser_node_tests[@]} browser-listed and ${#node_coverage_tests[@]} of ${#coverage_node_tests[@]} coverage-listed suites are in the gate's selection; a listed suite was renamed or removed without updating the partition" >&2
  exit 1
fi
if [[ $partition != all ]]; then
  printf 'GATE PARTITION %s: core %s suites, browser %s suites, coverage %s suites, total %s\n' "$partition" "${#node_core_tests[@]}" "${#node_browser_tests[@]}" "${#node_coverage_tests[@]}" "${#node_all_tests[@]}"
fi
# Core shards (2026-10-30): GATE_CORE_SHARD=i/n runs shard i of n of the core node suites, packed by measured seconds
# (scripts/node-shards.cjs, table scripts/core-shard-durations.json); the other core steps (edge tests, pay importers,
# bundle check, typecheck) run in shard 1 only. Same node command, flags and concurrency as unsharded core; only the
# file list is a slice. GATE_CORE_VERIFY=n checks that n shards partition the core suites exactly and stops there (the
# aggregate gate (core) job runs it). GATE_CORE_LIST=1 prints the core suites and stops (tests/career-ci-core-shards.test.cjs).
if [[ -n ${GATE_CORE_LIST:-} ]]; then
  printf '%s\n' "${node_core_tests[@]}"
  exit 0
fi
if [[ -n ${GATE_CORE_VERIFY:-} ]]; then
  node scripts/node-shards.cjs verify "$GATE_CORE_VERIFY" "${node_core_tests[@]}"
  node scripts/node-shards.cjs plan "$GATE_CORE_VERIFY" "${node_core_tests[@]}"
  exit 0
fi
core_shard=1
core_shard_count=1
if [[ $partition == core && -n ${GATE_CORE_SHARD:-} ]]; then
  core_shard=${GATE_CORE_SHARD%/*}
  core_shard_count=${GATE_CORE_SHARD#*/}
  node scripts/node-shards.cjs verify "$core_shard_count" "${node_core_tests[@]}"
  core_shard_list=$(node scripts/node-shards.cjs list "$core_shard" "$core_shard_count" "${node_core_tests[@]}")
  mapfile -t node_core_tests <<<"$core_shard_list"
  printf 'GATE CORE SHARD %s: %s suites\n' "$GATE_CORE_SHARD" "${#node_core_tests[@]}"
fi
# Each node suite's seconds (JSON lines) for the shard tables, from an extra reporter; TAP stays on stdout as before.
node_durations_file=${GATE_NODE_DURATIONS:-$(mktemp)}
node_reporters=(--test-reporter=tap --test-reporter-destination=stdout
  --test-reporter=./scripts/node-test-durations.mjs "--test-reporter-destination=$node_durations_file")

step test-paths portable_test_paths "${career_tests[@]}" "${shared_tests[@]}" "${edge_tests[@]}"
step browser-runtime browser_ready
if [[ $partition == all || $partition == architect ]]; then
  # Pending orders stay excluded; every landed architect test runs (an empty folder is a failure).
  if [[ -z ${GATE_ARCHITECT_SHARD:-} ]]; then
    step architect-tests deno test -A --no-check --ignore=tests/architect/pending tests/architect/
    step apply-cli-typecheck deno check scripts/apply.ts
  else
    # Architect shards (2026-10-29): GATE_ARCHITECT_SHARD=i/n runs shard i of n of the architect files, packed by measured
    # duration since 2026-10-30 (scripts/architect-shards.ts and its table scripts/architect-shard-durations.json;
    # tests/architect/ci-shard-partition.test.ts proves the shards partition the suite and stay balanced). Same command
    # and flags as above, only the file list is a slice. The aggregate job (gate (architect)) fails unless every shard
    # passed. The apply.ts typecheck runs in shard 1 only.
    shard=${GATE_ARCHITECT_SHARD%/*}
    shard_count=${GATE_ARCHITECT_SHARD#*/}
    deno run -A scripts/architect-shards.ts verify "$shard_count"
    mapfile -t architect_files < <(deno run -A scripts/architect-shards.ts list "$shard" "$shard_count")
    printf 'GATE ARCHITECT SHARD %s: %s files\n' "$GATE_ARCHITECT_SHARD" "${#architect_files[@]}"
    deno run -A scripts/architect-shards.ts plan "$shard_count" | sed -n "${shard}p"
    step "architect-tests-shard-$shard" deno test -A --no-check "${architect_files[@]}"
    if [[ $shard == 1 ]]; then step apply-cli-typecheck deno check scripts/apply.ts; fi
  fi
fi
if [[ $partition == all ]]; then
  step career-and-shared-tests node --test --test-concurrency=2 "${node_all_tests[@]}"
elif [[ $partition == core ]]; then
  if (( core_shard_count > 1 )); then
    step "career-and-shared-tests-core-shard-$core_shard" node --test --test-concurrency=2 "${node_reporters[@]}" "${node_core_tests[@]}"
  else
    step career-and-shared-tests-core node --test --test-concurrency=2 "${node_reporters[@]}" "${node_core_tests[@]}"
  fi
elif [[ $partition == architect ]]; then
  : # the architect partition runs no node suites; core, browser and coverage hold all of them
elif [[ $partition == browser ]]; then
  step career-and-shared-tests-browser node --test --test-concurrency=2 "${node_reporters[@]}" "${node_browser_tests[@]}"
elif [[ -z ${GATE_COVERAGE_SHARD:-} ]]; then
  step career-and-shared-tests-coverage node --test --test-concurrency=2 "${node_coverage_tests[@]}"
else
  # Coverage shards (2026-10-26): GATE_COVERAGE_SHARD=i/n runs shard i of n of the forms-ci suite's tests in this
  # job, selected by node's own test-name patterns (scripts/forms-ci-shards.cjs holds the table and its
  # completeness rules; the last shard runs every test not named elsewhere, and the read-only proof runs in all).
  # The suite file and its assertions are unchanged; the aggregate gate (forms-ci coverage) job checks that every
  # test of the suite passed in some shard.
  if (( ${#node_coverage_tests[@]} != 1 )); then
    echo "GATE COVERAGE SHARD: sharding expects exactly one coverage suite, got ${#node_coverage_tests[@]}" >&2
    exit 1
  fi
  shard_args=()
  shard_list=$(node scripts/forms-ci-shards.cjs args "${GATE_COVERAGE_SHARD%/*}" "${GATE_COVERAGE_SHARD#*/}")
  mapfile -t shard_args <<<"$shard_list"
  printf 'GATE COVERAGE SHARD %s: %s\n' "$GATE_COVERAGE_SHARD" "${shard_args[*]}"
  step "career-and-shared-tests-coverage-shard-${GATE_COVERAGE_SHARD%/*}" node --test --test-concurrency=2 "${shard_args[@]}" "${node_coverage_tests[@]}"
fi
if [[ $partition == all || ( $partition == core && $core_shard == 1 ) ]]; then
  step career-edge-tests deno test -A --no-check "${edge_tests[@]}"
  step pay-importers bash -c "python3 tests/pay-importers.test.py && python3 tests/aggregate-lca.test.py"
  step career-bundle python3 scripts/build-router-core.py --career-only --check
  step career-typecheck deno check supabase/functions/agent-chat/index-career.ts supabase/functions/career-ingest/index.ts supabase/functions/career-proactive/index.ts supabase/functions/trainee-deliver/index.ts supabase/functions/trainee-inbound/index.ts supabase/functions/trainee-telegram/index.ts supabase/functions/trainee-telegram-link/index.ts supabase/functions/trainee-whatsapp/index.ts supabase/functions/career-voice/index.ts supabase/functions/career-essay-draft/index.ts supabase/functions/career-email-code/index.ts supabase/functions/site-signup/index.ts supabase/functions/site-careers/index.ts supabase/functions/career-cloud-runner/index.ts supabase/functions/outlook-oauth/index.ts
fi

# Every step's result again at the end: a CI log read from its tail still shows which step failed.
printf 'SUMMARY %s\n' "${results[@]}"
if (( failed )); then
  printf '%s\n' "${details[@]}"
  echo 'GATE FAILED'
  exit 1
fi
echo 'GATE OK'
