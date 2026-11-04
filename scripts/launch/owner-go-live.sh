#!/usr/bin/env bash
# The owner's whole part of go-live, one command, one terminal (owner, 2026-10-12: "one terminal window and under 15
# minutes"). From the repo on his own machine:
#   bash scripts/launch/owner-go-live.sh [--no-wait]
# It checks the tools, puts the branch at its latest pushed commit, asks for each secret on a hidden prompt (typed, never
# shown, never saved, never in chat), runs scripts/launch/go-live.sh with a log, forgets the secrets, and pushes the
# gauntlet results so every failure becomes a replay test. It stops at the first problem and says which.
set -euo pipefail
cd "$(dirname "$0")/../.."
BRANCH=claude/upmore-16-spec-instinct-0qyuqj
for t in supabase psql jq node curl git; do command -v "$t" >/dev/null || { echo "missing: $t (brew install supabase/tap/supabase libpq jq node; then export PATH=\"\$(brew --prefix libpq)/bin:\$PATH\")"; exit 1; }; done
[[ -z "$(git status --porcelain)" ]] || { echo "uncommitted changes here; commit or stash them first (git stash)"; exit 1; }
git fetch -q origin "$BRANCH" && git checkout -q "$BRANCH" && git pull -q --ff-only origin "$BRANCH"
SHA="$(git rev-parse --short HEAD)"; echo "commit $SHA"
ask() { local v="$1" p="$2"; printf '%s: ' "$p"; IFS= read -rs "${v?}"; echo; }
ask SUPABASE_DB_URL "Database connection string (Supabase > Project Settings > Database > URI)"
ask GAUNTLET_PASSWORD "Password of gauntlet-test@upmore.test"
ask ANTHROPIC_API_KEY "Anthropic key (Enter to keep the one already set)"
ask ALPACA_OAUTH_CLIENT_ID "Alpaca OAuth client id (Enter to skip)"
ask ALPACA_OAUTH_CLIENT_SECRET "Alpaca OAuth client secret (Enter to skip)"
export SUPABASE_DB_URL GAUNTLET_PASSWORD
[[ -n "$ANTHROPIC_API_KEY" ]] && export ANTHROPIC_API_KEY || unset ANTHROPIC_API_KEY
[[ -n "$ALPACA_OAUTH_CLIENT_ID" && -n "$ALPACA_OAUTH_CLIENT_SECRET" ]] && export ALPACA_OAUTH_CLIENT_ID ALPACA_OAUTH_CLIENT_SECRET || unset ALPACA_OAUTH_CLIENT_ID ALPACA_OAUTH_CLIENT_SECRET
LOG="$HOME/upmore-go-live-$SHA.log"
set +e; bash scripts/launch/go-live.sh "$@" 2>&1 | tee "$LOG"; CODE=${PIPESTATUS[0]}; set -e
unset SUPABASE_DB_URL GAUNTLET_PASSWORD ANTHROPIC_API_KEY ALPACA_OAUTH_CLIENT_ID ALPACA_OAUTH_CLIENT_SECRET
if [[ -n "$(git status --porcelain evals/gauntlet/results evals/gauntlet/replays 2>/dev/null)" ]]; then
  git add evals/gauntlet/results evals/gauntlet/replays && git commit -q -m "go-live $SHA: live gauntlet results" && git push -q origin "$BRANCH" && echo "results pushed"
fi
echo "log: $LOG (no secrets in it). go-live exit code: $CODE"
exit "$CODE"
