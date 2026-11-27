#!/bin/bash
# Instinct: brand-new users doing the two features end to end on every channel, judged only by state (scorecard per
# feature and per channel, PASS / FAIL / NOT_BUILT per step with its evidence). Nothing real is contacted: real Postgres 16,
# a real Chromium, every deployed edge function loaded from its own index.ts, every outside system faked over HTTP, the
# employers on 127.0.0.1. No model calls (a scripted writer answers the OpenAI host).
#
#   bash tests/instinct/run.sh [--feature apply|network|scale|all] [--branch-set b1,b2,...] [--base trunk] [--out DIR]
#                              [--keep] [--strict] [-- <tests/instinct/main.ts options>]
#
#   --branch-set   merge these branches (from origin) onto --base in a scratch worktree and run there, so the scorecard
#                  says what trunk plus those branches does. A branch that is not pushed, or does not merge cleanly, is
#                  named in the scorecard's header and left out; the run goes on with the rest. The harness itself always
#                  comes from THIS checkout (the newest judge for any tree).
#   --strict       exit 1 when any step is not PASS (default: exit 0 once a scorecard is written; 2 if the harness broke)
#   main.ts options (after --): --channels web,telegram,whatsapp,imessage --apply-n 60 --channel-n 6 --emails 30
#                  --scale-users 50 --scale-items 20 --scale-concurrency 8 --groups gold,variants,...
#
# Needs (as CI's ubuntu-24.04 runner has them; see .github/workflows/instinct.yml):
#   Postgres 16 server binaries   /usr/lib/postgresql/16/bin or PGBIN=...
#   Deno 2.9.6, Node 22           on PATH
#   Playwright + a Chromium       npm ci --prefix tools; UPMORE_PLAYWRIGHT_PATH / UPMORE_CHROMIUM_PATH as the flow tests use
#   an unprivileged user          Chromium's sandbox: as root this re-runs itself as INSTINCT_USER (default: postgres)
#   network once                  Deno fetches supabase-js from npm (tests/instinct/import-map.json); where npm is not
#                                 reachable, INSTINCT_IMPORT_MAP=<file> supplies another map (its "__TREE__" is replaced by
#                                 the tree's file URL)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FEATURE=all BRANCHES="" BASE=trunk OUT="$ROOT/instinct-out" KEEP="" STRICT="" PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --feature) FEATURE="$2"; shift 2 ;;
    --branch-set) BRANCHES="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --strict) STRICT=--strict; shift ;;
    --) shift; PASS+=("$@"); break ;;
    *) PASS+=("$1"); shift ;;
  esac
done
case "$FEATURE" in apply|network|scale|all) ;; *) echo "--feature must be apply, network, scale or all (got $FEATURE)" >&2; exit 2 ;; esac
export PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
test -x "$PGBIN/initdb" || { echo "no Postgres 16 at $PGBIN (set PGBIN)" >&2; exit 2; }
"$PGBIN/postgres" --version | grep -q " 16\." || { echo "PGBIN is not Postgres 16: $("$PGBIN/postgres" --version)" >&2; exit 2; }
command -v deno >/dev/null || { echo "deno is not on PATH" >&2; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"

# ---------------------------------------------------------------------------------------------------- the tree
TREE="$ROOT" LABEL="this checkout ($(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown))" MERGED="" SKIPPED=""
if [ -n "$BRANCHES" ] || [ "${INSTINCT_FORCE_SCRATCH:-}" = 1 ]; then
  SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/instinct-tree.XXXXXX")"
  cleanup_tree() { [ -n "$KEEP" ] || { git -C "$ROOT" worktree remove --force "$SCRATCH/tree" >/dev/null 2>&1 || true; rm -rf "$SCRATCH"; }; }
  trap cleanup_tree EXIT
  # A shallow clone has no merge bases: deepen what the merges need.
  deepen=(); [ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" = true ] && deepen=(--deepen=1000)
  git -C "$ROOT" fetch --quiet "${deepen[@]}" origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
  git -C "$ROOT" worktree add --quiet --detach "$SCRATCH/tree" "origin/$BASE"
  TREE="$SCRATCH/tree"
  IFS=',' read -r -a LIST <<<"$BRANCHES"
  for b in "${LIST[@]}"; do
    b="$(echo "$b" | xargs)"; [ -n "$b" ] || continue
    if ! git -C "$ROOT" fetch --quiet "${deepen[@]}" origin "+refs/heads/$b:refs/remotes/origin/$b" 2>/dev/null; then
      SKIPPED="$SKIPPED $b(not pushed)"; echo "instinct: $b is not on origin; left out" >&2; continue
    fi
    G=(git -C "$TREE" -c user.name=instinct -c user.email=instinct@example.invalid)
    if "${G[@]}" merge --quiet --no-edit --no-ff "origin/$b" >/dev/null 2>&1; then
      MERGED="$MERGED $b@$(git -C "$ROOT" rev-parse --short "origin/$b")"
    else
      conflicted="$(git -C "$TREE" diff --name-only --diff-filter=U)"
      # A conflict only in documents changes nothing that runs: the base's text is kept, and the scorecard says so.
      if [ -n "$conflicted" ] && ! grep -qvE '(^docs/|\.md$)' <<<"$conflicted"; then
        while read -r f; do "${G[@]}" checkout --ours -- "$f"; "${G[@]}" add -- "$f"; done <<<"$conflicted"
        "${G[@]}" commit --quiet --no-edit
        MERGED="$MERGED $b@$(git -C "$ROOT" rev-parse --short "origin/$b")(docs kept from the base: $(tr '\n' ' ' <<<"$conflicted"))"
      else
        "${G[@]}" merge --abort >/dev/null 2>&1 || true
        SKIPPED="$SKIPPED $b(merge conflict in $(tr '\n' ' ' <<<"$conflicted"))"; echo "instinct: $b does not merge cleanly onto the set; left out" >&2
      fi
    fi
  done
  # The judge is always this checkout's.
  rm -rf "$TREE/tests/instinct"; cp -R "$HERE" "$TREE/tests/instinct"
  LABEL="$BASE@$(git -C "$ROOT" rev-parse --short "origin/$BASE") +${MERGED:- nothing}"
fi
echo "instinct: tree $LABEL${SKIPPED:+; left out:$SKIPPED}"

# ---------------------------------------------------------------------------------------------------- the run
MAP="$TREE/tests/instinct/import-map.json"
if [ -n "${INSTINCT_IMPORT_MAP:-}" ]; then
  MAP="$OUT/import-map.json"
  sed "s#__TREE__#file://$TREE#g" "$INSTINCT_IMPORT_MAP" > "$MAP"
fi
export UPMORE_PLAYWRIGHT_PATH="${UPMORE_PLAYWRIGHT_PATH:-$TREE/tools/node_modules/playwright}"
[ -e "$UPMORE_PLAYWRIGHT_PATH" ] || UPMORE_PLAYWRIGHT_PATH="$ROOT/tools/node_modules/playwright"
CMD=(deno run -A --no-check --import-map="$MAP" tests/instinct/main.ts --feature "$FEATURE" --out "$OUT" $STRICT "${PASS[@]}")
ENVS=(PATH="$PGBIN:$PATH" PGBIN="$PGBIN" CI=true NO_COLOR=1 NO_PROXY="127.0.0.1,localhost"
  INSTINCT_TREE_LABEL="$LABEL" INSTINCT_BRANCHES="merged:${MERGED:- none}${SKIPPED:+; left out:$SKIPPED}"
  UPMORE_PLAYWRIGHT_PATH="$UPMORE_PLAYWRIGHT_PATH" ${UPMORE_CHROMIUM_PATH:+UPMORE_CHROMIUM_PATH="$UPMORE_CHROMIUM_PATH"}
  ${DENO_DIR:+DENO_DIR="$DENO_DIR"} ${DENO_CERT:+DENO_CERT="$DENO_CERT"} ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"})
cd "$TREE"
set +e
if [ "$(id -u)" = "0" ]; then
  U="${INSTINCT_USER:-postgres}"
  H="$(mktemp -d "${TMPDIR:-/tmp}/instinct-home.XXXX")"; chown "$U" "$H" "$OUT"; chmod -R a+rX "$TREE"
  runuser -u "$U" -- env HOME="$H" "${ENVS[@]}" "${CMD[@]}"
else
  env "${ENVS[@]}" "${CMD[@]}"
fi
code=$?
set -e
[ -f "$OUT/scorecard.md" ] && echo "instinct: scorecard at $OUT/scorecard.md (and scorecard.json, transcripts.md)"
exit $code
