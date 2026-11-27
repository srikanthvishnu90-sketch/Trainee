#!/usr/bin/env bash
# Release 12 (PR #881 review): run the R10 pdf.js probe INSIDE Supabase's edge runtime, from the bundled career artifact, with
# no network, so a module the bundler left out fails here and not in production. Needs Docker. Prints the probe line and the
# agent-chat bundle's gzip size (the platform's 20 MB limit applies to that); exits 1 on a failed probe or a bundle >= 20 MB.
# Usage: bash scripts/career/edge-pdfjs-probe.sh [workdir under $HOME]   (Docker Desktop/colima mount $HOME)
set -euo pipefail
IMG="public.ecr.aws/supabase/edge-runtime:v1.77.4"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
D="${1:-$HOME/.trainee-edge-probe}"; rm -rf "$D"; mkdir -p "$D/supabase/functions/zz-probe"
node "$ROOT/scripts/career/stage-career.cjs" "$D/supabase/functions" >/dev/null
printf 'import { probePdfjs } from "../_shared/career_resume_geometry.ts";\nconsole.log("PROBE", JSON.stringify(await probePdfjs({ log: () => {} })));\nDeno.serve(() => new Response("ok"));\n' >"$D/supabase/functions/zz-probe/index.ts"
docker run --rm -v "$D:/src" "$IMG" bundle --entrypoint /src/supabase/functions/zz-probe/index.ts --output /src/probe.eszip -q
docker run --rm -v "$D:/src" "$IMG" bundle --entrypoint /src/supabase/functions/agent-chat/index.ts --output /src/out.eszip -q
N="edge-pdfjs-probe-$$"; docker run -d --name "$N" --network none -v "$D:/src" "$IMG" start --main-service /src/probe.eszip --main-entrypoint /src/supabase/functions/zz-probe/index.ts >/dev/null
for _ in $(seq 1 60); do docker logs "$N" 2>&1 | grep -q '^PROBE\|rror:' && break; sleep 1; done
LINE="$(docker logs "$N" 2>&1 | grep '^PROBE' || true)"; docker rm -f "$N" >/dev/null
GZ=$(gzip -c "$D/out.eszip" | wc -c | tr -d ' ')
echo "${LINE:-PROBE none}"; echo "agent-chat bundle gzip: $GZ bytes"
[[ "$LINE" == *'"ok":true'* ]] || { echo "FAIL: pdf.js does not load in the edge runtime"; exit 1; }
(( GZ < 20000000 )) || { echo "FAIL: agent-chat bundle $GZ bytes >= the 20 MB platform limit"; exit 1; }
echo "OK"
