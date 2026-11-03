#!/usr/bin/env bash
# staging/scripts/staging-up.sh — THE one command. Runs the whole staging bring-up
# in order against a staging project the OWNER created:
#   0. secret-name presence check (names only, via sb.py secrets-list — values
#      are never read, printed, or set by this package)
#   1. migrate.sh            (bootstrap + all migrations, in ls order)
#   2. deploy-functions.sh   (agent-chat, gmail-oauth)
#   3. seed.sh               (gauntlet test user + profiles row)
#   4. smoke.sh              (one career message -> oracle-checked reply)
#
# Usage (the exact single command, also in staging/README.md):
#   STAGING_REF=<staging-project-ref> bash staging/scripts/staging-up.sh
#   STAGING_REF=<staging-project-ref> bash staging/scripts/staging-up.sh --dry-run
#
# Secrets must already be set on the staging project by the owner before this
# runs (staging/OWNER-CHECKLIST.md). If a required name is missing, this stops
# BEFORE migrating or deploying anything and names what is missing.
set -euo pipefail

PROD_REF="mrwngntwmnaqrqhupvlt"   # production Upmore project — NEVER a staging target
SPORV_REF="aveqjeafghmwafkbbnor"  # Sporv project — never touched by Upmore work

REF="${STAGING_REF:-${1:-}}"
DRY_RUN=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY_RUN=1; done
[ "$REF" = "--dry-run" ] && REF=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SB="${SB_PY:-$HOME/workspace/skills/supabase/bin/sb.py}"

# Required secret NAMES on the staging project (derived from the deployed code's
# env reads — staging/README.md §Secrets). Values are the owner's; this package
# never invents, sets, or prints one.
#   OPENAI_API_KEY            model gateway default provider (model_gateway.ts)
#   GOOGLE_OAUTH_CLIENT_ID    gmail-oauth career grant
#   GOOGLE_OAUTH_CLIENT_SECRET gmail-oauth career grant
#   OAUTH_STATE_SECRET        gmail-oauth HMAC state signing
# Platform-provided on every Supabase project (never set by hand):
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
REQUIRED_SECRETS=(OPENAI_API_KEY GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET OAUTH_STATE_SECRET)

# --- production / safety guard (must stay in this file; verified by grep) ---
if [ -z "$REF" ]; then
  echo "REFUSE: no staging ref given. Set STAGING_REF=<staging project ref> (never the production ref $PROD_REF)." >&2
  exit 64
fi
if [ "$REF" = "$PROD_REF" ]; then
  echo "REFUSE: ref $REF is the PRODUCTION Upmore project (mrwngntwmnaqrqhupvlt). The staging one-command never touches production." >&2
  exit 64
fi
if [ "$REF" = "$SPORV_REF" ]; then
  echo "REFUSE: ref $REF is the Sporv project. Out of scope for Upmore staging." >&2
  exit 64
fi
case "$REF" in *[!a-z0-9]*|"") echo "REFUSE: ref '$REF' is not a bare Supabase project ref." >&2; exit 64;; esac

export STAGING_REF="$REF"
DRY_ARG=""
[ "$DRY_RUN" = "1" ] && DRY_ARG="--dry-run"

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — staging-up.sh against staging ref: $REF (production ref $PROD_REF refused)"
  echo "step 0: secret-name presence check via sb.py secrets-list (names only): ${REQUIRED_SECRETS[*]} — stop if any missing"
fi

if [ "$DRY_RUN" != "1" ]; then
  SECRETS_OUT="$(SUPABASE_REF="$REF" python3 "$SB" secrets-list)"
  MISSING=()
  for name in "${REQUIRED_SECRETS[@]}"; do
    printf '%s' "$SECRETS_OUT" | grep -q "\"$name\"" || MISSING+=("$name")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "STOP: required secrets missing on staging ref $REF: ${MISSING[*]}" >&2
    echo "Set them first (owner only — see staging/OWNER-CHECKLIST.md). Nothing was migrated or deployed." >&2
    exit 65
  fi
  echo "secrets present (names only): ${REQUIRED_SECRETS[*]}"
fi

# One test-account password for this run, shared by seed + smoke in-process only.
# In --dry-run nothing is generated or printed: a placeholder travels instead.
if [ "$DRY_RUN" = "1" ]; then
  export STAGING_TEST_PASSWORD="${STAGING_TEST_PASSWORD:-<generated-at-run-time>}"
elif [ -z "${STAGING_TEST_PASSWORD:-}" ]; then
  STAGING_TEST_PASSWORD="$(openssl rand -hex 16)"
  export STAGING_TEST_PASSWORD
  echo "generated staging test-account password for this run: $STAGING_TEST_PASSWORD"
  echo "(test account only — keep it in this shell if you want to re-run smoke.sh standalone)"
fi

bash "$SCRIPT_DIR/migrate.sh" "$REF" $DRY_ARG
bash "$SCRIPT_DIR/deploy-functions.sh" "$REF" $DRY_ARG
bash "$SCRIPT_DIR/seed.sh" "$REF" $DRY_ARG
bash "$SCRIPT_DIR/smoke.sh" "$REF" $DRY_ARG

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN complete: staging-up would run migrate -> deploy-functions -> seed -> smoke against $REF. Nothing was executed."
else
  echo "STAGING UP: staging ref $REF migrated, deployed, seeded, and smoke-passed (tier: STAGING)."
  echo "Chat URL for the graded runner: https://$REF.supabase.co/functions/v1/agent-chat (see staging/RUNNER-REPOINT.md)"
fi
