#!/usr/bin/env bash
# staging/scripts/deploy-functions.sh — deploy the career-relevant edge function
# set to a STAGING Supabase project. Owner-run only; shipped dry-run verified.
#
# Usage:
#   STAGING_REF=<staging-project-ref> bash staging/scripts/deploy-functions.sh [--dry-run]
#
# THE SET (enumerated from supabase/functions/ on 2026-10-13 — see staging/README.md):
#   agent-chat    the chat entry (POST /functions/v1/agent-chat {message} -> {reply})
#   gmail-oauth   the career grant flow (start_career / purpose-routed callback /
#                 per-source status+disconnect; packages/domain/120-career-access.js's rail)
# Everything else in supabase/functions/ is deliberately NOT deployed to staging v1. (The Upmore finance functions,
# including agent-exec, were removed from the repo on 2026-10-28.)
#
# THE ENTRYPOINT WORKAROUND (repo-documented, docs/career/deploy-checklist-access.md
# + TOOLS.md 2026-10-12): stock sb.py hardcodes "entrypoint_path": "index.ts".
# agent-chat imports ../_shared/* (the top-level functions/_shared tree), so it can only deploy from the
# supabase/functions ROOT with entrypoint "agent-chat/index.ts". This script
# implements the documented workaround programmatically: it copies sb.py to
# /tmp, rewrites that one field in the COPY (the installed sb.py is never
# modified), verifies the rewrite landed, and deploys with the copy.
# gmail-oauth imports only ./ siblings + remote modules (verified:
# zero "../" imports), so they deploy per-directory with stock sb.py, exactly as
# the access checklist prescribes for gmail-oauth.
set -euo pipefail

PROD_REF="mrwngntwmnaqrqhupvlt"   # production Upmore project — NEVER a staging target
SPORV_REF="aveqjeafghmwafkbbnor"  # Sporv project — never touched by Upmore work

REF="${STAGING_REF:-${1:-}}"
DRY_RUN=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY_RUN=1; done
[ "$REF" = "--dry-run" ] && REF=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SB="${SB_PY:-$HOME/workspace/skills/supabase/bin/sb.py}"
FUNCTIONS_DIR="$REPO_ROOT/supabase/functions"

# JWT settings as data — copied from the production configuration documented in
# docs/career/phase-a-audit-2026-10-13.md §1 and supabase/config.toml:
#   agent-chat   verify_jwt=true   (config.toml [functions.agent-chat]; prod v219 ACTIVE, verify_jwt=true)
#   gmail-oauth  verify_jwt=true   (no config.toml entry -> platform default true; access checklist: "Keep JWT verification ON")
# slug|deploy-mode|verify_jwt
FUNCTION_SET=(
  "agent-chat|tree|true"
  "gmail-oauth|dir|true"
)

# --- production / safety guard (must stay in this file; verified by grep) ---
if [ -z "$REF" ]; then
  echo "REFUSE: no staging ref given. Set STAGING_REF=<staging project ref> (never the production ref $PROD_REF)." >&2
  exit 64
fi
if [ "$REF" = "$PROD_REF" ]; then
  echo "REFUSE: ref $REF is the PRODUCTION Upmore project (mrwngntwmnaqrqhupvlt). Staging scripts never deploy to production." >&2
  exit 64
fi
if [ "$REF" = "$SPORV_REF" ]; then
  echo "REFUSE: ref $REF is the Sporv project. Out of scope for Upmore staging." >&2
  exit 64
fi
case "$REF" in *[!a-z0-9]*|"") echo "REFUSE: ref '$REF' is not a bare Supabase project ref." >&2; exit 64;; esac

jwt_flag() { # $1 = verify_jwt (true|false) -> sb.py flag
  if [ "$1" = "false" ]; then printf '%s' "--no-verify-jwt"; fi
}

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — deploy-functions.sh against staging ref: $REF (production ref $PROD_REF refused)"
  echo "step 0: guard — refuse if ref == $PROD_REF (production) or == $SPORV_REF (Sporv)"
  n=1
  for row in "${FUNCTION_SET[@]}"; do
    IFS='|' read -r slug mode vjwt <<<"$row"
    if [ "$mode" = "tree" ]; then
      echo "step $n: cp $SB /tmp/sb-staging-$slug.py && sed -i 's/\"entrypoint_path\": \"index.ts\"/\"entrypoint_path\": \"$slug\/index.ts\"/' /tmp/sb-staging-$slug.py && grep -q '$slug/index.ts' /tmp/sb-staging-$slug.py (workaround copy; installed sb.py untouched)"
      n=$((n + 1))
      echo "step $n: SUPABASE_REF=$REF python3 /tmp/sb-staging-$slug.py deploy $slug $FUNCTIONS_DIR $(jwt_flag "$vjwt") # whole-tree deploy, entrypoint $slug/index.ts, verify_jwt=$vjwt"
    else
      echo "step $n: SUPABASE_REF=$REF python3 $SB deploy $slug $FUNCTIONS_DIR/$slug $(jwt_flag "$vjwt") # per-directory, stock entrypoint index.ts correct, verify_jwt=$vjwt"
    fi
    n=$((n + 1))
  done
  echo "step $n: verify — SUPABASE_REF=$REF python3 $SB functions; assert agent-chat and gmail-oauth are listed ACTIVE"
  echo "DRY RUN complete: ${#FUNCTION_SET[@]} functions. Nothing was executed."
  exit 0
fi

[ -f "$SB" ] || { echo "FAIL: sb.py not found at $SB" >&2; exit 1; }

deploy_tree() { # $1 slug, $2 verify_jwt — the /tmp-copy entrypoint workaround
  local slug="$1" vjwt="$2" copy="/tmp/sb-staging-$1.py"
  cp "$SB" "$copy"
  sed -i 's/"entrypoint_path": "index.ts"/"entrypoint_path": "'"$slug"'\/index.ts"/' "$copy"
  grep -q "\"entrypoint_path\": \"$slug/index.ts\"" "$copy" || {
    echo "FAIL: entrypoint workaround rewrite did not land in $copy — stock sb.py shape changed? Not deploying $slug." >&2
    exit 1; }
  echo "deploying $slug (tree mode, entrypoint $slug/index.ts, verify_jwt=$vjwt) to staging ref $REF"
  SUPABASE_REF="$REF" python3 "$copy" deploy "$slug" "$FUNCTIONS_DIR" $(jwt_flag "$vjwt")
  rm -f "$copy"
}

deploy_dir() { # $1 slug, $2 verify_jwt — stock sb.py, per-directory
  local slug="$1" vjwt="$2"
  echo "deploying $slug (dir mode, entrypoint index.ts, verify_jwt=$vjwt) to staging ref $REF"
  SUPABASE_REF="$REF" python3 "$SB" deploy "$slug" "$FUNCTIONS_DIR/$slug" $(jwt_flag "$vjwt")
}

for row in "${FUNCTION_SET[@]}"; do
  IFS='|' read -r slug mode vjwt <<<"$row"
  [ -d "$FUNCTIONS_DIR/$slug" ] || { echo "FAIL: function dir missing: $FUNCTIONS_DIR/$slug" >&2; exit 1; }
  if [ "$mode" = "tree" ]; then deploy_tree "$slug" "$vjwt"; else deploy_dir "$slug" "$vjwt"; fi
done

LIST_OUT="$(SUPABASE_REF="$REF" python3 "$SB" functions)"
for slug in agent-chat gmail-oauth; do
  printf '%s' "$LIST_OUT" | grep -q "\"slug\": \"$slug\"" || {
    echo "FAIL verify: $slug not listed on staging ref $REF after deploy" >&2; exit 1; }
done
echo "PASS deploy-functions: agent-chat, gmail-oauth listed on staging ref $REF"
