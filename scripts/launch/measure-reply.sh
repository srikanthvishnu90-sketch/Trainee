#!/usr/bin/env bash
# Measure one commit's reply quality on ci/brain-eval for the deploy standard's S3 (D-034), and wait for the score.
#
#   bash scripts/launch/measure-reply.sh <40-hex sha>
#
# 1. Waits until no brain-eval run is queued or running (each one pushes its results to ci/brain-eval at the end; a commit
#    pushed under it would make that push fail and lose its scores).
# 2. Builds a measurement commit on the ci/brain-eval tip: ci/brain-eval's tree (the eval harness, its results and score
#    log) with the measured commit's MEASURE_ROOTS (scripts/launch/reply-code.ts: packages/ and supabase/functions/) taken
#    whole, so its reply code is the measured commit's file for file; first parent the ci/brain-eval tip, SECOND PARENT
#    THE MEASURED COMMIT (the brain-eval convention: run.ts logs HEAD^2 as the brain commit, and S3 maps the commit back
#    through its second parent). evals/career/eval-request.json asks for the dev set, MEASURE_BRAINS, five passes.
# 3. Pushes it (a push by the Actions token starts no workflow), then starts brain-eval on ci/brain-eval with
#    workflow_dispatch (set dev, brains MEASURE_BRAINS) unless a push-started run for the commit already exists (a push
#    by a personal token does start one, from the request file).
# 4. Waits for that run to finish and prints its conclusion. The score is judged by deploy-standard.ts S3, not here.
#
# Spend: the run is capped by brain-eval.yml's EVAL_BUDGET_USD (the owner's ceiling); the router brain makes no model call,
# only the two judges do (about $0.02 a pass, $0.10 for five; run 41226453344). Five passes: brain-eval.yml refuses any
# other count (the owner's rule), and S3 compares means, which one pass cannot resolve (16-18 points pass to pass).
# Env: GITHUB_REPOSITORY, GH_TOKEN (contents: write for the push, actions: write for the dispatch); MEASURE_BRAINS
# (default: DEPLOY_STANDARD_BRAIN or router); MEASURE_WAIT_MIN (default 80). Never prints the token.
# Exit 0: the run finished (any conclusion; S3 reads the score log). 1: it could not be started or did not finish.
set -euo pipefail
cd "$(dirname "$0")/../.."
export GIT_AUTHOR_NAME="deploy-standard[ci]" GIT_AUTHOR_EMAIL="deploy-standard@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
BRAINS="${MEASURE_BRAINS:-${DEPLOY_STANDARD_BRAIN:-router}}"

# The measurement commit for $1 on tip $2, printed (written to the object store, pushed nowhere). Fails when its reply code
# is not $1's file for file.
build_commit() {
  local sha="$1" tip="$2" idx req blob tree commit r
  local -a roots paths
  mapfile -t roots < <(deno run -A scripts/launch/reply-code.ts roots)
  mapfile -t paths < <(deno run -A scripts/launch/reply-code.ts paths)
  ((${#roots[@]} && ${#paths[@]})) || { echo "reply-code.ts listed nothing" >&2; return 1; }
  idx=$(mktemp); rm -f "$idx"
  GIT_INDEX_FILE="$idx" git read-tree "$tip"
  GIT_INDEX_FILE="$idx" git rm -r -q -f --cached --ignore-unmatch -- "${roots[@]}" >/dev/null
  for r in "${roots[@]}"; do
    if git cat-file -e "$sha:$r" 2>/dev/null; then GIT_INDEX_FILE="$idx" git read-tree --prefix="$r/" "$sha:$r"; fi
  done
  req=$(BRAINS="$BRAINS" deno eval 'console.log(JSON.stringify({ note: "deploy standard S3 (scripts/launch/measure-reply.sh): measure the second parent", action: "eval", set: "dev", brains: String(Deno.env.get("BRAINS")).split(",").map((b) => b.trim()).filter(Boolean), passes: 5 }, null, 1))')
  blob=$(printf '%s\n' "$req" | git hash-object -w --stdin)
  GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$blob,evals/career/eval-request.json"
  tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
  commit=$(git commit-tree "$tree" -p "$tip" -p "$sha" -m "Measure ${sha:0:10} for the deploy standard (S3): reply code of ${sha:0:10}, second parent" -m "brains: $BRAINS; set dev; five passes. scripts/launch/measure-reply.sh")
  if ! git diff --quiet "$sha" "$commit" -- "${paths[@]}"; then
    echo "the measurement commit's reply code differs from ${sha:0:10}" >&2; return 1
  fi
  echo "$commit"
}

if [[ "${1:-}" == --build-only ]]; then
  # Offline: build the measurement commit for <sha> on <tip> and print it (tests/architect/deploy-evidence.test.ts).
  [[ "${2:-}" =~ ^[0-9a-f]{40}$ && -n "${3:-}" ]] || { echo "usage: measure-reply.sh --build-only <40-hex sha> <tip>" >&2; exit 2; }
  build_commit "$2" "$(git rev-parse "$3^{commit}")"; exit
fi

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: measure-reply.sh <40-hex sha>" >&2; exit 2; }
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
WAIT_MIN="${MEASURE_WAIT_MIN:-80}"
BRANCH=ci/brain-eval
API="repos/$GITHUB_REPOSITORY/actions/workflows/brain-eval.yml/runs"
deadline=$(( $(date +%s) + WAIT_MIN * 60 ))

# In Actions the checkout keeps no credentials (persist-credentials: false): authenticate git per command, as the other
# deploy steps do. Elsewhere, git's own credentials are used.
GIT=(git)
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  GIT=(git -c "http.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)")
fi
git cat-file -e "$SHA^{commit}" 2>/dev/null || "${GIT[@]}" fetch --no-tags -q origin "$SHA"

busy() { gh api "$API?status=$1&per_page=1" -q '.total_count'; }
while :; do
  n=$(( $(busy queued) + $(busy in_progress) + $(busy waiting) ))
  (( n == 0 )) && break
  (( $(date +%s) >= deadline )) && { echo "::error::brain-eval stayed busy ($n runs) for $WAIT_MIN min; nothing was measured"; exit 1; }
  echo "waiting: $n brain-eval runs queued or running"; sleep 30
done

commit=""
for attempt in 1 2 3; do
  "${GIT[@]}" fetch --no-tags -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  tip=$(git rev-parse "refs/remotes/origin/$BRANCH")
  commit=$(build_commit "$SHA" "$tip") || { echo "::error::could not build a measurement commit for ${SHA:0:10}"; exit 1; }
  if "${GIT[@]}" push -q origin "$commit:refs/heads/$BRANCH"; then break; fi
  commit=""; echo "the $BRANCH tip moved (attempt $attempt); rebuilding on the new tip"; sleep 5
done
[[ -n "$commit" ]] || { echo "::error::could not push a measurement commit to $BRANCH"; exit 1; }
echo "measurement commit $commit (parents $tip $SHA) pushed to $BRANCH"

run_of() { gh api "$API?head_sha=$commit&per_page=5" -q '.workflow_runs | sort_by(.id) | last | .id // empty'; }
run=""
# A push by the Actions token starts no workflow: dispatch at once. A push by a personal token starts brain-eval from the
# request file: wait for that run instead of paying for a second one.
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then for _ in $(seq 1 12); do sleep 5; run=$(run_of); [[ -n "$run" ]] && break; done; fi
if [[ -z "$run" ]]; then
  gh workflow run brain-eval.yml --repo "$GITHUB_REPOSITORY" --ref "$BRANCH" -f set=dev -f brains="$BRAINS" >/dev/null
  for _ in $(seq 1 20); do sleep 6; run=$(run_of); [[ -n "$run" ]] && break; done
fi
[[ -n "$run" ]] || { echo "::error::no brain-eval run started for $commit (the $BRANCH tip may have moved before the dispatch)"; exit 1; }
echo "brain-eval run $run measures ${SHA:0:10}: https://github.com/$GITHUB_REPOSITORY/actions/runs/$run"
while :; do
  read -r status conclusion < <(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" -q '"\(.status) \(.conclusion // "none")"')
  [[ "$status" == completed ]] && break
  (( $(date +%s) >= deadline )) && { echo "::error::brain-eval run $run still $status after $WAIT_MIN min"; exit 1; }
  sleep 30
done
echo "brain-eval run $run: $conclusion (S3 reads its scores from $BRANCH's evals/career/SCORE-LOG.md)"
