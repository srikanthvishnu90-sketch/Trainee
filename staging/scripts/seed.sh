#!/usr/bin/env bash
# staging/scripts/seed.sh — create the staging gauntlet test user and the minimum
# rows the career flows need, on a STAGING project only. Owner-run only.
#
# Usage:
#   STAGING_REF=<ref> bash staging/scripts/seed.sh [--dry-run]
#   STAGING_TEST_EMAIL / STAGING_TEST_PASSWORD may be preset; if the password is
#   unset, one is generated for this run and printed ONCE (test account only —
#   export it in the same shell so smoke.sh can sign in).
#
# Method (the GoTrue
# admin API): the project's anon + service_role keys are fetched TRANSIENTLY from
# the Management API (/projects/{ref}/api-keys) through sb.py's own request
# helper, held only in this process's environment, never printed, never written
# to disk. The user is created via POST /auth/v1/admin/users (email_confirm),
# looked up first so re-runs are idempotent.
#
# Minimum rows seeded — and why this is all a fresh staging user needs:
#   auth.users row            (GoTrue admin create; the account itself)
#   public.profiles row       (id + display_name; the chat handler also upserts
#                              {id} itself on first message, handler.ts:189-192,
#                              but the rate-limiter FK and profile reads expect it)
# Nothing else: agent_threads / agent_messages rows are created by the handler
# per conversation; routes / listings stay empty by design in staging v1;
# the career grant (user_oauth_connections, provider google_career) is created
# only by the owner's real Google consent through gmail-oauth — never seeded,
# because a seeded grant would be a fake connector.
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
TEST_EMAIL="${STAGING_TEST_EMAIL:-gauntlet-staging@example.test}"
TEST_NAME="Gauntlet Staging Test"

# --- production / safety guard (must stay in this file; verified by grep) ---
if [ -z "$REF" ]; then
  echo "REFUSE: no staging ref given. Set STAGING_REF=<staging project ref> (never the production ref $PROD_REF)." >&2
  exit 64
fi
if [ "$REF" = "$PROD_REF" ]; then
  echo "REFUSE: ref $REF is the PRODUCTION Upmore project (mrwngntwmnaqrqhupvlt). Staging scripts never seed production." >&2
  exit 64
fi
if [ "$REF" = "$SPORV_REF" ]; then
  echo "REFUSE: ref $REF is the Sporv project. Out of scope for Upmore staging." >&2
  exit 64
fi
case "$REF" in *[!a-z0-9]*|"") echo "REFUSE: ref '$REF' is not a bare Supabase project ref." >&2; exit 64;; esac

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — seed.sh against staging ref: $REF (production ref $PROD_REF refused)"
  echo "step 0: guard — refuse if ref == $PROD_REF (production) or == $SPORV_REF (Sporv)"
  echo "step 1: fetch anon + service_role keys transiently via Management API /projects/$REF/api-keys (sb.py req helper; keys never printed or stored)"
  echo "step 2: GET https://$REF.supabase.co/auth/v1/admin/users — look up $TEST_EMAIL (idempotency check)"
  echo "step 3: if absent: POST /auth/v1/admin/users {email: $TEST_EMAIL, password: <generated or \$STAGING_TEST_PASSWORD>, email_confirm: true, user_metadata: {staging: true, purpose: gauntlet}}"
  echo "step 4: upsert minimum row: insert into public.profiles (id, display_name) values (<uid>, '$TEST_NAME') on conflict (id) do update set display_name = excluded.display_name (via sb.py query, SUPABASE_REF=$REF)"
  echo "step 5: print user id + email only (no keys, no token); remind owner to export STAGING_TEST_PASSWORD for smoke.sh"
  echo "DRY RUN complete. Nothing was executed."
  exit 0
fi

[ -f "$SB" ] || { echo "FAIL: sb.py not found at $SB" >&2; exit 1; }

if [ -z "${STAGING_TEST_PASSWORD:-}" ]; then
  STAGING_TEST_PASSWORD="$(openssl rand -hex 16)"
  GENERATED_PW=1
else
  GENERATED_PW=0
fi
export STAGING_TEST_PASSWORD

# Transient key fetch + GoTrue admin create/lookup. Prints ONLY the user id.
# Keys travel through this process's environment only; nothing is logged.
USER_ID="$(SUPABASE_REF="$REF" SB_PY="$SB" TEST_EMAIL="$TEST_EMAIL" python3 - <<'PY'
import importlib.util, json, os, sys, urllib.request, urllib.error

spec = importlib.util.spec_from_file_location("sb", os.environ["SB_PY"])
sb = importlib.util.module_from_spec(spec); spec.loader.exec_module(sb)
st, keys = sb.req("GET", f"/projects/{os.environ['SUPABASE_REF']}/api-keys")
if st != 200 or not isinstance(keys, list):
    print("key fetch failed", file=sys.stderr); sys.exit(1)
anon = next(k["api_key"] for k in keys if k.get("name") == "anon")
svc = next(k["api_key"] for k in keys if k.get("name") == "service_role")
base = f"https://{os.environ['SUPABASE_REF']}.supabase.co"
email = os.environ["TEST_EMAIL"]

def call(method, path, body=None):
    r = urllib.request.Request(base + path, method=method)
    r.add_header("apikey", anon); r.add_header("Authorization", "Bearer " + svc)
    if body is not None:
        r.add_header("Content-Type", "application/json"); r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or "{}")
        except Exception: return e.code, {}

st, data = call("GET", "/auth/v1/admin/users?per_page=200")
users = data.get("users", []) if isinstance(data, dict) else []
hit = next((u for u in users if u.get("email") == email), None)
if hit:
    print(hit["id"]); sys.exit(0)
st, data = call("POST", "/auth/v1/admin/users", {
    "email": email, "password": os.environ["STAGING_TEST_PASSWORD"],
    "email_confirm": True, "user_metadata": {"staging": True, "purpose": "gauntlet"}})
if st in (200, 201) and data.get("id"):
    print(data["id"]); sys.exit(0)
print(f"admin create failed: HTTP {st} {data.get('msg') or data.get('error') or ''}", file=sys.stderr)
sys.exit(1)
PY
)"

echo "test user: $TEST_EMAIL (id $USER_ID) on staging ref $REF"
OUT="$(printf "insert into public.profiles (id, display_name) values ('%s', '%s') on conflict (id) do update set display_name = excluded.display_name;" "$USER_ID" "$TEST_NAME" \
  | SUPABASE_REF="$REF" python3 "$SB" query - 2>&1)"
printf '%s' "$OUT" | grep -q '"status": 200' || { echo "FAIL seeding profiles row" >&2; printf '%s\n' "$OUT" | head -5 >&2; exit 1; }
echo "seeded: public.profiles row for $USER_ID"
if [ "$GENERATED_PW" = "1" ]; then
  echo "generated test-account password (shown once; test account only): $STAGING_TEST_PASSWORD"
  echo "export STAGING_TEST_PASSWORD in this shell before running smoke.sh, or let staging-up.sh run seed+smoke in one process."
fi
echo "PASS seed: gauntlet test user ready on staging ref $REF"
