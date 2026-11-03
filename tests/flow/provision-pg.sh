#!/bin/bash
# A throwaway Postgres 16 with the career schema in the same order CI's tests/db/run.sh builds it: the migrations
# run.sh names before its production-ledger step, in that order; then every other migration in filename order (what the
# ledger step applies, after its baseline); never the draft card-cloud bridge (DRAFT / NOT APPLIED, not in production),
# unless INCLUDE_BRIDGE=1: then the bridge too, at its filename position, outside a transaction (it owns BEGIN/COMMIT), as
# apply-rails-and-seed.sh applies it. Prints the socket directory and port as `PGHOST=... PGPORT=...` on the last line.
# Nothing here touches the live project.
# Usage: [INCLUDE_BRIDGE=1] bash tests/flow/provision-pg.sh <work-dir> <port>     (stop: pg_ctl -D <work-dir>/data -m immediate stop)
set -euo pipefail
export LC_ALL=C LANG=C
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$1"; PORT="$2"
PGBIN="${PGBIN:-$(dirname "$(command -v postgres 2>/dev/null || echo /usr/lib/postgresql/16/bin/postgres)")}"
BRIDGE=20261024130000_career_apply_card_cloud_bridge.sql
# initdb refuses to run as root (containers); the postgres account owns the cluster there. CI runs unprivileged.
AS=(); if [[ "$(id -u)" == "0" ]]; then AS=(runuser -u postgres --); chown postgres "$WORK"; fi
"${AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c max_connections=${PG_MAX_CONNECTIONS:-100}" -l "$WORK/log" -w start >/dev/null
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
PGOPTIONS='-c client_min_messages=error' "${PSQL[@]}" -f "$ROOT/tests/db/stubs.sql" >/dev/null 2>&1
RUN="$ROOT/tests/db/run.sh"
LEDGER_LINE="$(grep -n 'apply-rails-and-seed.sh --pending' "$RUN" | head -1 | cut -d: -f1)"
names() { grep -oE '[0-9]{8}[_0-9]*_[a-z0-9_]+\.sql' | awk '!s[$0]++' | while read -r b; do [[ -f "$ROOT/supabase/migrations/$b" ]] && echo "$b"; done; }
# run.sh names the bridge before its ledger step only to defer it; it is never one of the early files here.
BEFORE="$(head -n "$LEDGER_LINE" "$RUN" | names | grep -vxF "$BRIDGE")"
# The ledger step backfills every file up to its BASELINE as already applied, so only later files are applied by it.
BASELINE="$(grep -oE '^BASELINE="[^"]+"' "$ROOT/scripts/launch/apply-rails-and-seed.sh" | cut -d'"' -f2)"
AFTER="$( (ls "$ROOT/supabase/migrations" | grep '\.sql$' | sort) | while read -r b; do [[ "$b" > "$BASELINE" ]] || continue; grep -qx "$b" <<<"$BEFORE" || echo "$b"; done)"
n=0
for b in $BEFORE $AFTER; do
  TX=(--single-transaction)
  if [[ "$b" == "$BRIDGE" ]]; then [[ "${INCLUDE_BRIDGE:-}" == "1" ]] || continue; TX=(); fi
  if ! PGOPTIONS='-c client_min_messages=error' "${PSQL[@]}" "${TX[@]}" -f "$ROOT/supabase/migrations/$b" >"$WORK/migrate.log" 2>&1; then
    echo "MIGRATION FAILED: $b" >&2; grep -m3 ERROR "$WORK/migrate.log" >&2; exit 1
  fi
  n=$((n + 1))
done
echo "applied $n migrations" >&2
echo "PGHOST=$WORK PGPORT=$PORT"
