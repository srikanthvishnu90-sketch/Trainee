"use strict";
// Entry point of the apply VM worker (docker-compose / systemd). All settings come from the environment; nothing is read from the repo.
//   SUPABASE_URL, APPLY_VM_KEY (a JWT for the apply_vm_worker role; the service key only for a first look)   required
//   APPLY_VM_WORKER_ID (default <hostname>-<pid>), APPLY_VM_CONCURRENCY (default: what memory holds, ~450 MB each),
//   APPLY_VM_PER_USER (default 1: people are served round-robin), APPLY_VM_HOST_MAX / APPLY_VM_HOST_SPACING_MS (default none),
//   APPLY_VM_ALLOW_HOSTS (comma list of real employer hosts; empty = mock forms on this VM only), APPLY_VM_EVIDENCE_DIR,
//   UPMORE_PLAYWRIGHT_PATH, UPMORE_CHROMIUM_PATH (optional), APPLY_VM_CHROMIUM_SANDBOX (default on; never "off" on a VM with real postings)
const fs = require("node:fs");
const { createWorker, restRpc } = require("./apply-vm.cjs");

const env = (k, d) => (process.env[k] ?? d);
const num = (k) => { const v = env(k, ""); return /^\d{1,9}$/.test(v) ? Number(v) : undefined; };
function need(k) { const v = env(k, ""); if (!v) { console.error(`MISSING_ENV ${k}`); process.exit(2); } return v; }

(async () => {
  const url = need("SUPABASE_URL"), key = need("APPLY_VM_KEY");
  let pw = null;
  for (const id of [env("UPMORE_PLAYWRIGHT_PATH"), "playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
  if (!pw) { console.error("PLAYWRIGHT_UNRESOLVABLE"); process.exit(2); }
  const sandbox = env("APPLY_VM_CHROMIUM_SANDBOX", "on") !== "off";
  const evidenceDir = env("APPLY_VM_EVIDENCE_DIR", "/var/lib/apply-vm/evidence");
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: sandbox, ...(env("UPMORE_CHROMIUM_PATH") ? { executablePath: env("UPMORE_CHROMIUM_PATH") } : {}) });
  const worker = createWorker({
    rpc: restRpc({ url, key }), browser, evidenceDir,
    workerId: env("APPLY_VM_WORKER_ID") || undefined, concurrency: num("APPLY_VM_CONCURRENCY"), perUser: num("APPLY_VM_PER_USER"),
    hostMax: num("APPLY_VM_HOST_MAX"), hostSpacingMs: num("APPLY_VM_HOST_SPACING_MS"),
    allowHosts: env("APPLY_VM_ALLOW_HOSTS", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  });
  const stop = () => { console.log("STOPPING: no new claims; applications in flight finish and are recorded"); worker.stop(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  console.log(`APPLY_VM_START worker=${worker.cfg.workerId} concurrency=${worker.cfg.concurrency} perUser=${worker.cfg.perUser} realHosts=${worker.cfg.allowHosts.length} sandbox=${sandbox}`);
  setInterval(() => console.log(`APPLY_VM_STATS claimed=${worker.stats.claimed} inflight=${worker.inflight.size} done=${JSON.stringify(worker.stats.done)} p50=${worker.pct(0.5)}ms p95=${worker.pct(0.95)}ms`), 60000).unref();
  await worker.run();
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("APPLY_VM_FATAL", String(e && e.message).slice(0, 300)); process.exit(1); });
