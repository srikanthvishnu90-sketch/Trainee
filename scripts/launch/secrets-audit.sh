#!/usr/bin/env bash
# Which launch secrets are still missing? Lists NAMES only. It never reads, prints, logs or stores a value: the only thing taken
# from the supabase / vercel CLIs is the `name` field (everything else, including the digest column, is dropped in the parser).
#
#   bash scripts/launch/secrets-audit.sh                         # needs `supabase login` and SUPABASE_PROJECT_REF (the 20 letters)
#   bash scripts/launch/secrets-audit.sh --names-file names.txt  # offline: one secret NAME per line (no values)
#   bash scripts/launch/secrets-audit.sh --vercel-names-file v.txt   # offline Vercel env NAMES; else `vercel env ls production` if linked
#   bash scripts/launch/secrets-audit.sh --strict                # optional/channel secrets count as missing too
#   bash scripts/launch/secrets-audit.sh --cloud-settings-file s.txt   # KEY=value lines of the database switches (CAREER_AGENT_SUBMIT,
#     CAREER_CLOUD_APPLY, CAREER_CLOUD_TEXT_CARDS), so the hosted-apply line can say "off by design" or "ON but NOT READY"
#   bash scripts/launch/secrets-audit.sh --require-hosted-apply  # a missing hosted-apply prerequisite is launch-blocking (default: reported only)
#   bash scripts/launch/secrets-audit.sh --features              # per feature: ENABLED or OFF, WIRED or NOT_WIRED (deploy standard S5)
#     A feature is ENABLED when its switch secret is set (or always, for the core); WIRED when every secret it needs is set.
#     Exit 1 when any feature is ENABLED and NOT_WIRED: a feature without its secrets must stay off, never faked (D-034).
# Tier C = hosted apply (the cloud runner, docs/launch/CLOUD-RUNNER.md): reported as its own "hosted apply" block (scripts/launch/
#   hosted-apply-setup.cjs holds the list). Hosted apply is off by design until the owner turns it on, so a missing C name never
#   changes the exit code unless --require-hosted-apply (or the switches given with --cloud-settings-file are ON).
# Exit 0: nothing launch-blocking is missing. Exit 1: something is. Exit 2: the audit could not read the names (nothing is "ok" then).
# Feature -> secrets, who sets them, and the verify command: docs/launch/OWNER-SETUP-CHECKLIST.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
NAMES_FILE=""; VERCEL_FILE=""; STRICT=""; FEATURES=""; CLOUD_SETTINGS=""; REQUIRE_HOSTED=""
while (($#)); do case "$1" in
  --names-file) NAMES_FILE="${2:?--names-file needs a path}"; shift 2;;
  --vercel-names-file) VERCEL_FILE="${2:?--vercel-names-file needs a path}"; shift 2;;
  --strict) STRICT=1; shift;;
  --features) FEATURES=1; shift;;
  --cloud-settings-file) CLOUD_SETTINGS="${2:?--cloud-settings-file needs a path}"; shift 2;;
  --require-hosted-apply) REQUIRE_HOSTED=1; shift;;
  *) echo "unknown option: $1" >&2; exit 2;;
esac; done

# tier: R = launch-blocking, O = optional (a feature that stays honestly NOT_WIRED without it), D = has a safe default
# where: fn = Supabase function secret, vercel = Vercel project env, gh = GitHub environment `production` secret
# Format: where|NAME|tier|feature
MANIFEST='
fn|ANTHROPIC_API_KEY|R|the model (every reply; Claude only)
fn|LOOPMESSAGE_API_KEY|R|inbound texts and the phone-login code (trainee-inbound answers 503 NOT_WIRED without it)
fn|TRAINEE_INBOUND_SECRET|R|LoopMessage webhook URL (?secret=)
fn|CAREER_INGEST_SECRET|R|job ingest schedule
fn|CAREER_PROACTIVE_SECRET|R|alerts schedule
fn|TRAINEE_DELIVER_SECRET|R|text delivery schedule
fn|INGEST_CONTACT_EMAIL|R|job ingest (503 without it)
fn|TRAINEE_FILE_LINK_SECRET|R|file page links + phone login (trainee-file is skipped by deploy without it)
fn|TRAINEE_FILE_BASE_URL|R|the https URL of the file page that links point to
fn|TRAINEE_BOT_URL|R|the bot link shown on file and connect pages
vercel|TRAINEE_FILE_UPSTREAM|R|/file proxy to trainee-file (503 "File pages are not set up yet" without it)
fn|OPS_MONITOR_TOKEN|R|owner alerts and daily digest (ops-monitor is skipped by deploy without it)
fn|TELEGRAM_BOT_TOKEN|R|owner alert messages and Telegram
fn|OWNER_TELEGRAM_CHAT_ID|R|where owner alerts are sent
gh|SUPABASE_ACCESS_TOKEN|R|GitHub production deploy
gh|SUPABASE_PROJECT_REF|R|GitHub production deploy
gh|SUPABASE_DB_URL|R|GitHub production deploy (Session pooler URI)
fn|SUPABASE_ACCESS_TOKEN|O|ops-monitor 5xx counts (not measured without it)
fn|SUPABASE_PROJECT_REF|O|ops-monitor 5xx counts (not measured without it)
fn|OPS_DAILY_CAP_USD|O|ops-monitor spend alerts when no budget row exists
fn|TRAINEE_ALLOWED_CONTACTS|O|who may sign up (closed by default)
fn|TRAINEE_CONNECT_LINK_SECRET|O|connect links (falls back to TRAINEE_FILE_LINK_SECRET when unset)
fn|GOOGLE_OAUTH_CLIENT_ID|O|Gmail connect
fn|GOOGLE_OAUTH_CLIENT_SECRET|O|Gmail connect
fn|OAUTH_STATE_SECRET|O|Gmail/Outlook connect state
fn|CAREER_PREPARE_AHEAD_URL|O|phone-only preparation host (real Apply from a phone)
fn|CAREER_PREPARE_AHEAD_TOKEN|O|phone-only preparation host
fn|HUNTER_API_KEY|O|outreach email checks
fn|PDL_API_KEY|O|hired-candidate aggregates
fn|TELEGRAM_WEBHOOK_SECRET|O|Telegram channel
fn|TELEGRAM_BOT_USERNAME|O|Telegram channel
fn|WHATSAPP_TOKEN|O|WhatsApp channel
fn|WHATSAPP_PHONE_NUMBER_ID|O|WhatsApp channel
fn|WHATSAPP_APP_SECRET|O|WhatsApp channel
fn|WHATSAPP_VERIFY_TOKEN|O|WhatsApp channel
vercel|TRAINEE_CONNECT_UPSTREAM|O|/connect proxy to trainee-connect
fn|VERCEL_TOKEN|C|hosted apply: sandbox host (career-cloud-runner answers 503 needs setup)
fn|VERCEL_TEAM_ID|C|hosted apply: sandbox host
fn|VERCEL_PROJECT_ID|C|hosted apply: sandbox host
fn|CLOUD_SANDBOX_SNAPSHOT_ID|C|hosted apply: runner snapshot
fn|CLOUD_RUNNER_SECRET|C|hosted apply: job/request tokens key (32+ characters; else 503 not configured)
fn|CLOUD_DISPATCH_SECRET|C|hosted apply: the pg_cron ticks
fn|CLOUD_BRIDGE_URL|C|hosted apply: where sandboxes call back (503 needs setup)'

# Names only. The parsers keep the `name` field / first column and nothing else.
names_from_supabase_json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);if(!Array.isArray(a))process.exit(3);for(const x of a)if(x&&typeof x.name==="string"&&/^[A-Z][A-Z0-9_]*$/.test(x.name))console.log(x.name)})'; }
names_from_vercel_table() { awk 'NR>1 && $1 ~ /^[A-Z][A-Z0-9_]*$/ {print $1}'; }

FN_NAMES=""; VERCEL_NAMES=""; GH_UNKNOWN=1; unreadable=""
if [[ -n "$NAMES_FILE" ]]; then FN_NAMES="$(grep -E '^[A-Z][A-Z0-9_]*$' "$NAMES_FILE" || true)"
else
  REF="${SUPABASE_PROJECT_REF:-}"
  if [[ -z "$REF" ]] || ! command -v supabase >/dev/null || ! command -v node >/dev/null; then unreadable="Supabase function secrets (need SUPABASE_PROJECT_REF, the supabase CLI logged in, and node)"
  elif ! FN_NAMES="$(supabase secrets list --project-ref "$REF" -o json 2>/dev/null | names_from_supabase_json)"; then unreadable="Supabase function secrets (supabase secrets list failed: run supabase login)"; FN_NAMES=""; fi
fi
if [[ -n "$VERCEL_FILE" ]]; then VERCEL_NAMES="$(grep -E '^[A-Z][A-Z0-9_]*$' "$VERCEL_FILE" || true)"
elif command -v vercel >/dev/null && [[ -d .vercel ]]; then VERCEL_NAMES="$(vercel env ls production 2>/dev/null | names_from_vercel_table || true)"; fi
VERCEL_KNOWN=""; { [[ -n "$VERCEL_FILE" ]] || [[ -n "$VERCEL_NAMES" ]]; } && VERCEL_KNOWN=1

if [[ -n "$unreadable" ]]; then echo "NOT RUN: could not read $unreadable. Nothing is reported as present." >&2; exit 2; fi

has() { grep -qxF "$2" <<<"$1"; }

# feature|switch (a function secret name whose presence turns it on, or "always")|the function secrets it needs
FEATURE_MANIFEST='
model|always|ANTHROPIC_API_KEY
job-ingest|always|CAREER_INGEST_SECRET INGEST_CONTACT_EMAIL
alerts|always|CAREER_PROACTIVE_SECRET
delivery|always|TRAINEE_DELIVER_SECRET
texts-loopmessage|LOOPMESSAGE_API_KEY|TRAINEE_INBOUND_SECRET
telegram|TELEGRAM_WEBHOOK_SECRET|TELEGRAM_BOT_TOKEN
whatsapp|WHATSAPP_TOKEN|WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN
file-pages|TRAINEE_FILE_LINK_SECRET|TRAINEE_FILE_BASE_URL TRAINEE_BOT_URL
ops-monitor|OPS_MONITOR_TOKEN|TELEGRAM_BOT_TOKEN OWNER_TELEGRAM_CHAT_ID
gmail-connect|GOOGLE_OAUTH_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET OAUTH_STATE_SECRET
phone-prepare|CAREER_PREPARE_AHEAD_URL|CAREER_PREPARE_AHEAD_TOKEN
people-data|PDL_API_KEY|PDL_API_KEY'
if [[ -n "$FEATURES" ]]; then
  bad=0
  while IFS='|' read -r feature switch needs; do
    [[ -z "$feature" ]] && continue
    if [[ "$switch" == always ]] || has "$FN_NAMES" "$switch"; then on=ENABLED; else on=OFF; fi
    missing=""
    for n in $needs; do has "$FN_NAMES" "$n" || missing+="${missing:+,}$n"; done
    if [[ -z "$missing" ]]; then wired=WIRED; else wired=NOT_WIRED; fi
    [[ $on == ENABLED && $wired == NOT_WIRED ]] && bad=$((bad+1))
    printf 'FEATURE %-18s %-7s %-9s%s\n' "$feature" "$on" "$wired" "${missing:+ missing=$missing}"
  done <<<"$FEATURE_MANIFEST"
  echo "features enabled and NOT_WIRED: $bad"
  ((bad)) && exit 1
  exit 0
fi
miss_r=0; miss_o=0; miss_c=0; unk=0
printf '%-8s %-34s %-6s %s\n' WHERE NAME STATUS "UNLOCKS"
while IFS='|' read -r where name tier feature; do
  [[ -z "$name" ]] && continue
  case "$where" in
    fn) if has "$FN_NAMES" "$name"; then st=set; else st=MISSING; fi;;
    vercel) if [[ -z "$VERCEL_KNOWN" ]]; then st=UNKNOWN; elif has "$VERCEL_NAMES" "$name"; then st=set; else st=MISSING; fi;;
    gh) st=UNKNOWN;; # GitHub environment secrets cannot be listed by name without a token; check Settings > Environments > production
  esac
  [[ "$st" == UNKNOWN ]] && unk=$((unk+1))
  if [[ "$st" == MISSING ]]; then case "$tier" in R) miss_r=$((miss_r+1));; C) miss_c=$((miss_c+1));; *) miss_o=$((miss_o+1));; esac; fi
  [[ "$st" == set ]] && continue
  case "$tier" in R) tag=' [launch]';; C) tag=' [hosted apply]';; *) tag=' [optional]';; esac
  printf '%-8s %-34s %-6s %s%s\n' "$where" "$name" "$st" "$feature" "$tag"
done <<<"$MANIFEST"
echo
echo "missing launch-blocking: $miss_r   missing optional: $miss_o   not checkable from here (UNKNOWN): $unk"
((unk)) && echo "UNKNOWN rows: gh = GitHub Settings > Environments > production (names are listed there, values are not); vercel = pass --vercel-names-file or run from a vercel-linked checkout."
# Hosted apply block: names only, from the same lists. Fails only when the switches given are ON and something is missing,
# or when --require-hosted-apply says it must be ready.
hosted_args=()
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "$FN_NAMES" >"$tmp/fn"; hosted_args+=(--secrets-file "$tmp/fn")
[[ -n "$VERCEL_KNOWN" ]] && { printf '%s\n' "$VERCEL_NAMES" >"$tmp/vercel"; hosted_args+=(--vercel-names-file "$tmp/vercel"); }
[[ -n "$CLOUD_SETTINGS" ]] && hosted_args+=(--settings-file "$CLOUD_SETTINGS")
echo
hosted_code=0
node scripts/launch/hosted-apply-setup.cjs ${REQUIRE_HOSTED:+--require-switches} "${hosted_args[@]}" || hosted_code=$?
((miss_r)) && exit 1
((hosted_code)) && exit 1
[[ -n "$REQUIRE_HOSTED" ]] && ((miss_c)) && exit 1
[[ -n "$STRICT" ]] && ((miss_o)) && exit 1
exit 0
