#!/usr/bin/env bash
# The Trainee extension as the owner loads it in his own Chrome: a folder for "Load unpacked" and the same files as a zip.
#
#   bash scripts/extension/package.sh --variant shipped --out <dir>
#   bash scripts/extension/package.sh --variant agent   --out <dir>
#
#   shipped  extension/ as committed; config.js unchanged; refused unless personSubmits and agentSubmits are both false.
#   agent    the same files, except config.js in the package has ONLY agentSubmits: true (personSubmits stays false).
#            Refused while the privacy policy says the extension "never submits an application for you".
#            Refused if that one replacement did not happen exactly. The repository's extension/config.js is never written.
#            Sending still needs the person's batch approval AND the owner's CAREER_AGENT_SUBMIT 'on' in the database.
#
# Writes <dir>/trainee-extension-<version>-<variant>/ (select this folder in chrome://extensions > Load unpacked) and
# <dir>/trainee-extension-<version>-<variant>.zip (the folder's files at the zip's root), each with a BUILD-INFO.txt
# (commit, variant, flags, date). First runs `deno run -A extension/build.ts --check` and refuses a stale bundle. The
# files are the store package's (scripts/launch/extension-package-check.cjs list) and pass its checks. Prints the zip's
# SHA-256 and the commit. Nothing is uploaded, deployed or sent; no secret is read or written.
set -euo pipefail
for tool in git deno node zip unzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "refused: '$tool' is not installed (needed: git, deno, node, zip, unzip)" >&2; exit 1; }
done
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
root=$(pwd)
check="$root/scripts/launch/extension-package-check.cjs"
variant_js="$root/scripts/extension/variant.cjs"

usage() { echo "usage: bash scripts/extension/package.sh --variant shipped|agent --out <dir>" >&2; exit 2; }
variant="" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --variant) variant="${2:-}"; shift 2 || usage ;;
    --variant=*) variant="${1#*=}"; shift ;;
    --out) out="${2:-}"; shift 2 || usage ;;
    --out=*) out="${1#*=}"; shift ;;
    *) usage ;;
  esac
done
case "$variant" in shipped|agent) ;; *) echo "refused: --variant must be shipped or agent (got '${variant}')" >&2; usage ;; esac
[ -n "$out" ] || usage
# Google verification (review of #196): the privacy policy says the extension "never submits an application for you". That
# is true only of the shipped variant (agentSubmits: false). An agent build is refused while any policy source says it,
# and while the policy cannot be read (a build that cannot check the claim does not get the benefit of the doubt).
# Change the policy sentence first (docs/launch/legal-pages/privacy.template.html, and site/privacy.html once built).
if [ "$variant" = agent ]; then
  policy_claim="never submits an application for you"
  template="$root/docs/launch/legal-pages/privacy.template.html"
  [ -r "$template" ] || { echo "refused: the agent variant needs the privacy policy template to check ($template is missing). Nothing was written." >&2; exit 1; }
  for p in "$template" "$root/site/privacy.html"; do
    if [ -r "$p" ] && grep -qF "$policy_claim" "$p"; then
      echo "refused: the privacy policy (${p#"$root"/}) says the extension \"$policy_claim\", and the agent variant submits. Change the policy first. Nothing was written." >&2
      exit 1
    fi
  done
fi
mkdir -p "$out"
out=$(cd "$out" && pwd)
case "$out/" in "$root/extension/"*) echo "refused: the output directory must not be inside extension/" >&2; exit 1 ;; esac

# 1. The bundle the content script runs must be what its sources build.
if ! deno run -A extension/build.ts --check; then
  echo "refused: extension/lib/trainee-core.js is stale; run 'deno run -A extension/build.ts', commit it, and package again. Nothing was written." >&2
  exit 1
fi

# 2. Where it was built from.
commit=$(git -C "$root" rev-parse HEAD 2>/dev/null || echo "unknown (not a git checkout)")
if [ -n "$(git -C "$root" status --porcelain -- extension scripts/extension 2>/dev/null || true)" ]; then
  commit="$commit (with uncommitted changes in extension/ or scripts/extension/)"
  echo "warning: extension/ or scripts/extension/ has uncommitted changes; BUILD-INFO.txt says so." >&2
fi
version=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$root/extension/manifest.json")
name="trainee-extension-$version-$variant"

# 3. Stage the package's files in a scratch directory; the repository is only read.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage="$work/$name"
# (A while-read loop, not mapfile: macOS ships bash 3.2.)
files=()
while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(node "$check" list extension)
[ "${#files[@]}" -gt 0 ] || { echo "refused: no files to package" >&2; exit 1; }
for f in "${files[@]}"; do
  mkdir -p "$stage/$(dirname "$f")"
  cp "extension/$f" "$stage/$f"
done

if [ "$variant" = agent ]; then
  node "$variant_js" agent "$root/extension/config.js" "$stage/config.js" || {
    echo "refused: the agent variant could not be made (config.js was not changed as expected). Nothing was written." >&2
    exit 1
  }
fi
flags=$(node "$variant_js" flags "$stage/config.js")
case "$variant:$flags" in
  "shipped:personSubmits=false agentSubmits=false") ;;
  "agent:personSubmits=false agentSubmits=true") ;;
  *) echo "refused: the $variant variant would carry '$flags'. Nothing was written." >&2; exit 1 ;;
esac

built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$stage/BUILD-INFO.txt" <<EOF
Trainee apply (Upmore) extension, packaged by scripts/extension/package.sh
commit: $commit
variant: $variant
flags: $flags
version: $version
built: $built_at
EOF
if [ "$variant" = agent ]; then
  cat >> "$stage/BUILD-INFO.txt" <<'EOF'
note: agentSubmits is on in this package only. Trainee sends a posting only after the person approves that batch of
  exact answers in the panel AND the owner's CAREER_AGENT_SUBMIT is 'on' in the database; otherwise nothing is sent.
EOF
fi
files+=("BUILD-INFO.txt")

# 4. The zip: fixed timestamps for the package's own files, no extra attributes.
# (touch -t is the form both GNU and BSD/macOS touch read.)
find "$stage" -exec env TZ=UTC touch -h -t 202610200000 {} +
zip_tmp="$work/$name.zip"
(cd "$stage" && TZ=UTC zip -X -D -q "$zip_tmp" "${files[@]}")

# 5. Check what was actually zipped, unpacked again (the store package's checks).
mkdir -p "$work/unzipped"
(cd "$work/unzipped" && unzip -q "$zip_tmp")
if ! node "$check" check "$work/unzipped"; then
  echo "refused: the package failed its checks. Nothing was written." >&2
  exit 1
fi

# 6. Only now write to the output directory.
rm -rf "${out:?}/$name" "$out/$name.zip"
cp -R "$stage" "$out/$name"
cp "$zip_tmp" "$out/$name.zip"
if command -v sha256sum >/dev/null 2>&1; then sha=$(sha256sum "$out/$name.zip" | cut -d' ' -f1)
else sha=$(shasum -a 256 "$out/$name.zip" | cut -d' ' -f1); fi

echo "variant: $variant ($flags)"
echo "folder (Load unpacked): $out/$name"
echo "zip: $out/$name.zip"
echo "sha256: $sha"
echo "commit: $commit"
