#!/bin/bash
unset DENO_CERT SSL_CERT_FILE NODE_EXTRA_CA_CERTS
export HOME=/home/runner
export UPMORE_PLAYWRIGHT_PATH=/home/runner/tools/node_modules/playwright UPMORE_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome NODE_PATH=/home/runner/tools/node_modules PATH=/home/claude/.npm-global/bin:/opt/node22/bin:$PATH TZ=UTC NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 PGBIN=/usr/lib/postgresql/16/bin
cd /home/runner/sq-results
exec "$@"
