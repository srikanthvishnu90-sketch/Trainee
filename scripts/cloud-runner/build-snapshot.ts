// F-RUNNER: build the runner snapshot every cloud sandbox starts from (docs/launch/CLOUD-RUNNER.md, owner step 3).
// One sandbox: the repo at a pinned commit, Playwright 1.64.1 and its Chromium with system libraries, Deno 2.9.6, the
// engine's module cache warm; then snapshotted (which stops it). Prints SNAPSHOT <id> for CLOUD_SANDBOX_SNAPSHOT_ID.
//   VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... deno run -A scripts/cloud-runner/build-snapshot.ts <commit sha>
// The token is read from the environment only and never printed. No employer is reached: the warm-up is the cloud
// worker's own local-form suite (tests/career-cloud-worker.test.cjs), on 127.0.0.1 inside the sandbox.
const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) { console.error(`set ${k}`); Deno.exit(2); }
  return v;
};
const token = env("VERCEL_TOKEN"), team = env("VERCEL_TEAM_ID"), project = env("VERCEL_PROJECT_ID");
const commit = Deno.args[0] ?? "";
if (!/^[0-9a-f]{40}$/.test(commit)) { console.error("usage: build-snapshot.ts <40-hex commit on trunk>"); Deno.exit(2); }
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(team)}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const SETUP = [
  "set -euo pipefail",
  "cd /vercel && git clone -q https://github.com/srikanthvishnu90-sketch/upmore-agent.git repo && cd repo && git checkout -q " + commit,
  "npm ci --prefix tools --no-audit --no-fund",
  "cd tools && npx --no-install playwright install chromium && sudo npx --no-install playwright install-deps chromium && cd ..",
  "curl -fsSL https://dl.deno.land/release/v2.9.6/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip && cd /tmp && unzip -oq deno.zip && sudo mv deno /usr/local/bin/ && cd /vercel/repo",
  "deno cache workers/career-cloud/sandbox-runner.ts workers/career-cloud/prepare-runner.ts scripts/apply.ts",
  "PLAYWRIGHT_BROWSERS_PATH=/vercel/.cache/ms-playwright UPMORE_PLAYWRIGHT_PATH=/vercel/repo/tools/node_modules/playwright DENO_BIN=/usr/local/bin/deno node --test --test-reporter=tap tests/career-cloud-worker.test.cjs",
].join(" && ");

const created = await api("POST", "/v4/sandboxes", {
  projectId: project, name: `trainee-runner-snapshot-${commit.slice(0, 8)}`, persistent: false, timeout: 20 * 60_000,
  resources: { vcpus: 2, memory: 4096 }, region: Deno.env.get("CLOUD_SANDBOX_REGION") || "iad1", tags: { purpose: "trainee-runner-snapshot" },
});
const sid = created.session.id;
console.log(`sandbox ${sid}`);
try {
  const cmd = await api("POST", `/v2/sandboxes/sessions/${sid}/cmd`, { command: "bash", args: ["-c", SETUP], cwd: "/vercel" });
  const cmdId = cmd?.command?.id ?? cmd?.id;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const c = await api("GET", `/v2/sandboxes/sessions/${sid}/cmd/${cmdId}`);
    const exit = c?.command?.exitCode ?? c?.exitCode;
    if (exit === null || exit === undefined) continue;
    if (exit !== 0) throw Error(`setup failed (exit ${exit}); read its logs: GET /v2/sandboxes/sessions/${sid}/cmd/${cmdId}/logs`);
    break;
  }
  const snap = await api("POST", `/v3/sandboxes/sessions/${sid}/snapshot`, {});
  console.log(`SNAPSHOT ${snap.snapshot.id} (${Math.round(snap.snapshot.sizeBytes / 1e6)} MB)`);
} catch (e) {
  await api("POST", `/v2/sandboxes/sessions/${sid}/stop`, {}).catch(() => {});
  throw e;
}
