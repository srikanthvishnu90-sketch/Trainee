#!/usr/bin/env bash
# VERIFICATION-15, "The 95% bars" (D-068): re-measure every $0 bar and print its literal count, in one place.
#
#   bash scripts/verification/measure-95.sh --ci-run <id>          # the trunk CI run of the commit measured (push to trunk)
#   bash scripts/verification/measure-95.sh --ci-run <id> --local   # also run the local $0 evals (about 15 minutes)
#
# Part 1 reads the summary lines the gate's own suites print (architect shards, core, browser, telegram acceptance) from
# that CI run's job logs, through the GitHub REST API (`gh api`). Nothing is re-scored: the lines are the suites' own.
# Part 2 (--local) runs the offline evals on this checkout: no model, nothing sent; discovery-live reads public job boards
# (read only) and the mirror held-out run sends nothing off the machine. They need Deno 2.9.6 and Postgres 16 (PGBIN).
# Results go to $OUT (default: a new temp directory), which the script prints and leaves for the reader.
# The browser benchmark (item 4) and the held-out 60 (item 2) need CI: push this commit to a bench/browser-* branch with the
# workflow in VERIFICATION-15 (the sandboxes have no proxy for Chromium).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO=${REPO:-srikanthvishnu90-sketch/Trainee}
run="" local=0
while [ $# -gt 0 ]; do
  case $1 in --ci-run) run=$2; shift 2 ;; --local) local=1; shift ;; *) echo "unknown argument $1" >&2; exit 2 ;; esac
done
OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/measure-95-XXXXXX")}
mkdir -p "$OUT"
echo "commit $(git rev-parse --short=8 HEAD)  out $OUT"

if [ -n "$run" ]; then
  echo "== part 1: the gate's own summary lines, CI run $run"
  gh api "repos/$REPO/actions/runs/$run" --jq '"run \(.id) \(.event) \(.head_branch) \(.head_sha[0:8]) \(.conclusion)"'
  for j in $(gh api "repos/$REPO/actions/runs/$run/jobs?per_page=100" --jq '.jobs[] | select(.name | test("^gate \\((architect shard|core shard|browser)|^acceptance")) | .id'); do
    gh api "repos/$REPO/actions/jobs/$j/logs" > "$OUT/job-$j.log" 2>/dev/null || echo "job $j: log not readable" >&2
  done
  sed 's/\x1b\[[0-9;]*m//g; s/^[0-9TZ:.-]* //' "$OUT"/job-*.log 2>/dev/null | grep -aE \
    '^(APP-LAYER (LOOP|REVIEW|DOB):|ASK-TO-QUEUE:|RESUME (DESIGN|LOOP):|LOOP05 TOTAL|FILES LOOP: families|FILES LIVE LOOP: families|FILES LIVE RECORDS LOOP: pages|BATTERY (ROUTER|STAGED): 1000|LOOP item=|LOOP-1[0-3]|ACCOUNTS_LOOP store|CHANNEL_PARITY channels_on|TELEGRAM_ACCEPTANCE known_gap|TELEGRAM_LOOP conversations)' \
    | sort -u | cut -c1-400 | tee "$OUT/ci-lines.txt"
  grep -ahE "fix 12: .*\.\.\. (ok|FAILED)" "$OUT"/job-*.log | sed 's/\x1b\[[0-9;]*m//g; s/^[0-9TZ:.-]* //' | sort -u | tee -a "$OUT/ci-lines.txt"
fi

if [ "$local" = 1 ]; then
  echo "== part 2: local \$0 evals"
  export CI=true NO_COLOR=1
  unset ANTHROPIC_API_KEY
  r() { local n=$1; shift; if "$@" > "$OUT/$n.log" 2>&1; then echo "$n ok"; else echo "$n exit $?"; fi; }
  r question-map deno run --allow-read evals/apply/question-map.ts
  r sensitive-loop deno run -A --no-check evals/apply/sensitive-loop.ts
  r mass-apply-outcomes deno run --allow-read evals/career/mass-apply-outcomes/run.ts
  r mail-eval deno run --allow-read evals/career/mail-eval.ts
  r advice-wide deno run -A --no-check evals/career/advice-wide.ts
  r discovery-live deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/discovery-live/run.ts --out "$OUT/discovery-live"
  r mirror-heldout deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/heldout/run.ts --split both --label "m95-$(git rev-parse --short=8 HEAD)"
  grep -ah "Precision:\|Fill precision" "$OUT/question-map.log" || true
  grep -ah "SENSITIVE real\|REUSED on card" "$OUT/sensitive-loop.log" || true
  grep -ah "Applications fully clean\|Wrong answers" "$OUT/mass-apply-outcomes.log" || true
  grep -ah "SYNTHETIC set, all:" -A2 "$OUT/mail-eval.log" || true
  grep -ah "seeds clean" "$OUT/advice-wide.log" || true
  grep -ah "^DISCOVERY-LIVE\|^INGEST" "$OUT/discovery-live.log" || true
  grep -ah "MIRROR-HELDOUT\|^| G[0-9]" "$OUT/mirror-heldout.log" | head -40 || true
fi
