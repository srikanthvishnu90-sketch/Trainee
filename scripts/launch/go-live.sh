#!/usr/bin/env bash
# One command from the owner's shell: everything between "built" and "tested live" (Option A, BUILD-STATUS).
#
#   SUPABASE_DB_URL='postgresql://...'      the live database (Project Settings > Database > Connection string)
#   GAUNTLET_PASSWORD='...'                 the password of gauntlet-test@upmore.test (mints a fresh 1-hour JWT here;
#                                           the JWT goes into this process's environment only, never a file)
#   ALPACA_OAUTH_CLIENT_ID / ALPACA_OAUTH_CLIENT_SECRET   optional: set as function secrets for Brokerage connect
#   ANTHROPIC_API_KEY='...'                 the model key, set as a function secret (Claude only, owner 2026-11-02: no OpenAI
#                                           key is asked for or set). Skip it only if already set. Type it without shell history: read -rs ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY
#   HEALTH_CHECK_TOKEN='...'                optional: the model-health token; generated (and kept in ~/.upmore/health-token,
#                                           0600) when not given and not already saved
#   bash scripts/launch/go-live.sh [--no-wait]
#
# Needs: the supabase CLI logged in (`supabase login`), psql, node 18+, curl, jq. Stops at the first failure.
#   0. preflight: clean tree, the exact commit, the local checks green (node tests, bundle current)
#   1. migrations: only those not yet in the live ledger (--pending), ONE transaction; a re-run applies nothing
#   2. secrets: the Anthropic key, the health token and the Alpaca OAuth pair, each only if given (values via a 0600 temp
#      file, never echoed)
#   3. deploy: agent-chat, broker-oauth-start, broker-oauth-callback, model-health, agent-proactive, exec-vault-store,
#      agent-exec (no password storage, decision 1) and manual-connect (the live sign-in window, JWT on); broker-oauth-callback, model-health and agent-proactive are
#      --no-verify-jwt: a browser redirect, an uptime monitor and pg_cron carry no JWT; the latter two check their own
#      secret); then schedule agent-proactive hourly with pg_cron (the secret in Vault, read at call time)
#   4. smoke: unauthenticated calls answer 401, the callback answers with the NEW code (proves the deploy took), and ONE
#      live model call through model-health answers; if it does not, the provider's exact error is printed and the run
#      STOPS before the gauntlet (nothing is built around a dead model)
#   5. security checks against the live project (scripts/launch/verify-security-live.cjs; a FAIL stops the run), then the
#      gauntlet against the live handler: spec16, sloppy, l3 (--no-wait reports the timed turns NOT RUN instead of
#      waiting 11 minutes); raw replies in evals/gauntlet/results/<label>*.json
#   6. prints the rollback command
# GO_LIVE_DRY_RUN=1 prints every step without touching anything (tested in tests/go-live.test.cjs).
set -euo pipefail
cd "$(dirname "$0")/../.."
REF=mrwngntwmnaqrqhupvlt
BASE="https://$REF.supabase.co"
DRY="${GO_LIVE_DRY_RUN:-}"
NOWAIT=""; [[ "${1:-}" == "--no-wait" ]] && NOWAIT="--no-wait"
say() { echo "== $*"; }
do_() { if [[ -n "$DRY" ]]; then echo "DRY: $*"; else "$@"; fi; }

say "0. preflight"
SHA="$(git rev-parse --short HEAD)"
if [[ -z "$DRY" ]]; then
  : "${SUPABASE_DB_URL:?set SUPABASE_DB_URL}"; : "${GAUNTLET_PASSWORD:?set GAUNTLET_PASSWORD (gauntlet-test@upmore.test)}"
  for t in supabase psql node curl jq; do command -v "$t" >/dev/null || { echo "missing: $t"; exit 1; }; done
  [[ -z "$(git status --porcelain)" ]] || { echo "the tree has uncommitted changes; the live test must run on an exact commit"; exit 1; }
  node --test tests/*.cjs >/tmp/upmore-go-live-tests.log 2>&1 || { echo "local tests are red (see /tmp/upmore-go-live-tests.log); nothing was touched"; exit 1; }
  python3 scripts/build-router-core.py --check
fi
echo "commit $SHA"

say "1. migrations not yet applied (one transaction, recorded in the ledger)"
do_ bash scripts/launch/apply-rails-and-seed.sh --pending

say "2. secrets"
TOKF="$HOME/.upmore/health-token"
if [[ -z "${HEALTH_CHECK_TOKEN:-}" && -f "$TOKF" ]]; then HEALTH_CHECK_TOKEN="$(cat "$TOKF")"; fi
NEW_TOKEN=""
if [[ -z "${HEALTH_CHECK_TOKEN:-}" ]]; then HEALTH_CHECK_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; NEW_TOKEN=1; fi
NAMES=(); LINES=()
add() { NAMES+=("$1"); LINES+=("$1=$2"); }
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then add ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"; else echo "skipped: no ANTHROPIC_API_KEY given (an already-set secret stays as it is)"; fi
if [[ -n "${ALPACA_OAUTH_CLIENT_ID:-}" && -n "${ALPACA_OAUTH_CLIENT_SECRET:-}" ]]; then add ALPACA_OAUTH_CLIENT_ID "$ALPACA_OAUTH_CLIENT_ID"; add ALPACA_OAUTH_CLIENT_SECRET "$ALPACA_OAUTH_CLIENT_SECRET"
else echo "skipped: no Alpaca OAuth pair given; Connect will say it isn't switched on yet (honest, 503)"; fi
add HEALTH_CHECK_TOKEN "$HEALTH_CHECK_TOKEN"
# The proactive scheduler's header secret: kept in ~/.upmore/proactive-secret (0600), generated on the first run.
PSF="$HOME/.upmore/proactive-secret"; NEW_PS=""
if [[ -z "${PROACTIVE_SECRET:-}" && -f "$PSF" ]]; then PROACTIVE_SECRET="$(cat "$PSF")"; fi
if [[ -z "${PROACTIVE_SECRET:-}" ]]; then PROACTIVE_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; NEW_PS=1; fi
add PROACTIVE_SECRET "$PROACTIVE_SECRET"; export PROACTIVE_SECRET
if [[ -n "$DRY" ]]; then echo "DRY: supabase secrets set --project-ref $REF --env-file <0600 temp file: ${NAMES[*]}>"
else
  ENVF="$(mktemp)"; chmod 600 "$ENVF"; trap 'rm -f "$ENVF"' EXIT
  printf '%s\n' "${LINES[@]}" >"$ENVF"
  supabase secrets set --project-ref "$REF" --env-file "$ENVF" >/dev/null; rm -f "$ENVF"; echo "set: ${NAMES[*]}"
  if [[ -n "$NEW_TOKEN" ]]; then mkdir -p "$(dirname "$TOKF")"; (umask 077; printf '%s' "$HEALTH_CHECK_TOKEN" >"$TOKF"); echo "health token saved to $TOKF (0600) for your uptime monitor"; fi
  if [[ -n "$NEW_PS" ]]; then mkdir -p "$(dirname "$PSF")"; (umask 077; printf '%s' "$PROACTIVE_SECRET" >"$PSF"); echo "proactive scheduler secret saved to $PSF (0600)"; fi
fi
unset LINES

say "3. deploy"
do_ supabase functions deploy agent-chat --project-ref "$REF"
do_ supabase functions deploy broker-oauth-start --project-ref "$REF"
do_ supabase functions deploy broker-oauth-callback --project-ref "$REF" --no-verify-jwt
do_ supabase functions deploy model-health --project-ref "$REF" --no-verify-jwt
do_ supabase functions deploy agent-proactive --project-ref "$REF" --no-verify-jwt
# No password storage (owner decision 1): the vault that refuses passwords and the cancel agent that never types one.
do_ supabase functions deploy exec-vault-store --project-ref "$REF"
do_ supabase functions deploy agent-exec --project-ref "$REF"
# Guided manual connect (decision 1, session-only): the live sign-in window and the Vault session store. JWT on: every
# action is the signed-in person's own. Without BROWSERBASE_API_KEY/BROWSERBASE_PROJECT_ID it answers 503 NOT_WIRED.
do_ supabase functions deploy manual-connect --project-ref "$REF"
# Hourly, at minute 7: pg_cron -> pg_net -> agent-proactive with the secret read from Vault at call time.
if [[ -n "$DRY" ]]; then echo "DRY: psql <SUPABASE_DB_URL> -v url=$BASE/functions/v1/agent-proactive -f scripts/launch/schedule-proactive.sql (secret from Vault, never printed)"
else psql "$SUPABASE_DB_URL" -q -v url="$BASE/functions/v1/agent-proactive" -f scripts/launch/schedule-proactive.sql; fi

say "4. smoke (the new code is what answers)"
expect() { local want="$1" got="$2" what="$3"; if [[ "$got" == "$want" ]]; then echo "ok   $what ($got)"; else echo "FAIL $what: wanted $want, got $got"; exit 1; fi; }
if [[ -n "$DRY" ]]; then echo "DRY: POST agent-chat with no JWT -> 401; POST broker-oauth-start with no JWT -> 401; POST agent-proactive with no secret -> 401; POST manual-connect with no JWT -> 401; GET broker-oauth-callback?state=x -> 302 to #you?broker=error&reason=state_invalid; GET model-health?probe=1 (token header) -> 200 or STOP with the provider's error"
else
  expect 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/functions/v1/agent-chat")" "agent-chat refuses a call with no JWT"
  expect 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/functions/v1/broker-oauth-start")" "broker-oauth-start refuses a call with no JWT"
  expect 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/functions/v1/agent-proactive")" "agent-proactive refuses a call without its secret"
  expect 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/functions/v1/manual-connect")" "manual-connect refuses a call with no JWT"
  LOC="$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/functions/v1/broker-oauth-callback?state=x&code=y")"
  [[ "$LOC" == *"#you?broker=error&reason=state_invalid" ]] && echo "ok   broker-oauth-callback is the new code ($LOC)" || { echo "FAIL broker-oauth-callback answered '$LOC'"; exit 1; }
  # Step 1 of v3: one live model call. A dead model stops the run here with the provider's own words (key redacted).
  HB="$(mktemp)"; HC="$(curl -s -o "$HB" -w '%{http_code}' -H "x-health-token: $HEALTH_CHECK_TOKEN" "$BASE/functions/v1/model-health?probe=1")"
  if [[ "$HC" == "200" ]]; then echo "ok   live model call answered: $(jq -c '{provider,model,probe}' "$HB")"; rm -f "$HB"
  else echo "FAIL the live model call did not answer (HTTP $HC): $(jq -c '{status,provider,model,probe,last_error:.window.last_error}' "$HB" 2>/dev/null || cat "$HB")"; rm -f "$HB"
       echo "stopped before the gauntlet: fix the provider key (supabase secrets set ...) and re-run; nothing else was changed after the deploy"; exit 1; fi
fi

say "5. live gauntlet on $SHA"
if [[ -n "$DRY" ]]; then echo "DRY: mint a 1-hour JWT for gauntlet-test@upmore.test (password grant, anon key from index.html), run scripts/launch/verify-security-live.cjs (vault refuses a password, chat removes one, no reply asks for one; STOP on a FAIL), then run spec16, sloppy, l3 against $BASE/functions/v1/agent-chat, resetting the test user's hourly message window before each suite"
else
  ANON="$(grep -o 'UPMORE_ANON_KEY = "[^"]*"' index.html | head -1 | sed 's/.*= "//;s/"$//')"
  UPMORE_TEST_JWT="$(curl -s -X POST "$BASE/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' \
    -d "$(jq -n --arg e gauntlet-test@upmore.test --arg p "$GAUNTLET_PASSWORD" '{email:$e,password:$p}')" | jq -r .access_token)"
  [[ -n "$UPMORE_TEST_JWT" && "$UPMORE_TEST_JWT" != "null" ]] || { echo "FAIL: could not sign in as gauntlet-test@upmore.test"; exit 1; }
  export UPMORE_TEST_JWT UPMORE_CHAT_URL="$BASE/functions/v1/agent-chat"
  # The security changes are what answers: the vault refuses a password, chat removes one, no reply asks for one.
  UPMORE_BASE="$BASE" node scripts/launch/verify-security-live.cjs || { echo "FAIL: the live project does not run the security changes; stopped before the gauntlet"; unset UPMORE_TEST_JWT; exit 1; }
  # Each suite starts with a fresh hour for the test user only (Upmore allows 60 messages an hour per person; the three
  # suites together send about 95). Nobody else's limit is touched.
  for s in spec16 sloppy l3; do
    psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -c "update public.agent_rate_limits set count = 0, window_start = now() where user_id = '2e8cb31d-59ab-4b2c-99bb-d4c5de8613a3'"
    node evals/gauntlet/run-live.cjs --suite "$s" --label "go-live-$SHA-$s" $NOWAIT || true
  done
  unset UPMORE_TEST_JWT
fi

say "6. rollback, if the live handler misbehaves (the migrations stay; v203 runs on them)"
echo "   see scripts/launch/rollback/agent-chat-v203/README.md"
say "done on $SHA"
