# The apply VM worker image (docs/launch/APPLY-VM-RUNBOOK.md). Build from the repo root:
#   docker build -f docker/apply-vm/Dockerfile -t trainee-apply-vm .
# NOT BUILT in the session that wrote it (no Docker daemon there): the first `docker compose build` on the VM is the first build.
# The Playwright tag must equal PLAYWRIGHT_VERSION (the repo's pin, docs/launch/CLOUD-WORKER.md); change both together.
ARG PLAYWRIGHT_VERSION=1.64.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION
ENV NODE_ENV=production UPMORE_PLAYWRIGHT_PATH=/app/node_modules/playwright
WORKDIR /app
RUN printf '{"name":"trainee-apply-vm","private":true,"dependencies":{"playwright":"%s"}}' "$PLAYWRIGHT_VERSION" > package.json \
 && npm install --omit=dev --no-audit --no-fund
COPY workers/career-browser/parallel-apply.cjs workers/career-browser/apply-vm.cjs workers/career-browser/apply-vm-main.cjs /app/workers/career-browser/
COPY tests/fixtures/mock-ats-server.cjs /app/mock/mock-ats-server.cjs
# Never root: Chromium keeps its sandbox on (compose gives it the seccomp profile that allows that).
RUN mkdir -p /var/lib/apply-vm/evidence && chown -R pwuser:pwuser /var/lib/apply-vm /app
USER pwuser
VOLUME ["/var/lib/apply-vm"]
CMD ["node", "/app/workers/career-browser/apply-vm-main.cjs"]
