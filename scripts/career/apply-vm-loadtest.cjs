#!/usr/bin/env node
"use strict";
// Load test of the apply VM on MOCK forms and a throwaway Postgres. Nothing leaves 127.0.0.1; no model calls.
//   node scripts/career/apply-vm-loadtest.cjs [--users 1000] [--items 20] [--heavy 500] [--workers 4] [--per-worker 16] [--sim-ms 50]
//        [--browser-apps 120] [--browser-concurrency 6] [--latency-ms 0] [--json out.json] [--skip-sim] [--skip-browser]
// Part A (scheduling and fairness): the REAL database functions and the REAL worker loop, the browser replaced by a driver
//   that takes --sim-ms and follows the same protocol (records "submitting" before it would click). It measures the claim,
//   lease and completion path of many people at once, not Chromium.
// Part B (browser): real headless Chromium on the mock Greenhouse/Lever forms through the same worker: apps per second,
//   p50/p95 per application, and CPU use, on whatever machine this runs on.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { provision, seedPeople, seedItems, uid, RESUME_SHA } = require("../../tests/fixtures/apply-vm-seed.cjs");
const { psqlRpc } = require("../../tests/fixtures/psql-rpc.cjs");
const { startMockAts } = require("../../tests/fixtures/mock-ats-server.cjs");
const { createWorker } = require("../../workers/career-browser/apply-vm.cjs");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? Number(process.argv[i + 1]) || process.argv[i + 1] : true); };
const users = arg("users", 1000), items = arg("items", 20), heavy = arg("heavy", 500), workers = arg("workers", 4), perWorker = arg("per-worker", 16), simMs = arg("sim-ms", 50);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { host: { cpus: os.cpus().length, mem_gb: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version } };

async function waitDone(admin, like, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const [n] = await admin.q(`select count(*) from career_apply_jobs where state in ('queued','driving') and url like '${like}'`);
    if (Number(n) === 0) return true;
    await sleep(500);
  }
  return false;
}
const setting = (admin, k, v) => admin.q(`insert into career_cloud_settings(key,value) values ('${k}','${v}') on conflict (key) do update set value=excluded.value`);

(async () => {
  const pg = provision(54430);
  const base = psqlRpc({ dir: pg.dir, port: pg.port, size: 1 }), admin = base.admin;
  await admin.q("set client_min_messages = warning");
  await admin.q("delete from career_apply_jobs; delete from career_apply_host_backoff; delete from auth.users where email like 'vm%@example.test'"); // test data of an earlier run
  await setting(admin, "APPLY_VM", "on"); await setting(admin, "APPLY_VM_USER_IDS", "*"); await setting(admin, "APPLY_VM_ALLOW_LOCAL", "on");
  try {
    if (!process.argv.includes("--skip-sim")) {
      const t = Date.now();
      await seedPeople(admin, 10000, users + 1);
      await seedItems(admin, 10000, users, items, `'http://127.0.0.1:9/lever/s'||i||'-'||g`);        // 1000 people x 20, older rows
      await seedItems(admin, 10000 + users, 1, heavy, `'http://127.0.0.1:9/lever/heavy'||g`);       // one person with a big batch, queued LAST
      const total = users * items + heavy;
      out.sim = { people: users + 1, items: total, heavy_batch: heavy, workers, concurrency_each: perWorker, sim_driver_ms: simMs, seed_s: +((Date.now() - t) / 1000).toFixed(1) };
      const ws = Array.from({ length: workers }, (_, k) => {
        const rpc = psqlRpc({ dir: pg.dir, port: pg.port, size: 4 });
        const driver = async (_b, p, o) => { await sleep(simMs * (0.5 + Math.random())); await o.onPhase("submitting"); await sleep(simMs / 2); return { status: "submitted_page_confirmed", attempts: 1, confirmation: "SIM-" + p.id.slice(0, 8), filled: [], ms: simMs, timing: {} }; };
        return createWorker({ rpc, browser: {}, workerId: `sim-${k}`, concurrency: perWorker, perUser: 1, pollMs: 20, heartbeatMs: 20000, sweepMs: 3600000, applyOne: driver, evidenceDir: null, log: () => {} });
      });
      const t0 = Date.now(); const [{ now: dbT0 }] = [{ now: (await admin.q("select extract(epoch from clock_timestamp())"))[0] }];
      const runs = ws.map((w) => w.run());
      const ok = await waitDone(admin, "http://127.0.0.1:9/lever/%", 3 * 3600 * 1000);
      const wall = (Date.now() - t0) / 1000;
      ws.forEach((w) => w.stop()); await Promise.all(runs);
      const rows = await admin.q(`select user_id, extract(epoch from claimed_at)-${dbT0}, extract(epoch from updated_at)-${dbT0}, state from career_apply_jobs where url like 'http://127.0.0.1:9/lever/%'`);
      const per = new Map(); const lat = []; const finishes = [];
      for (const l of rows) {
        const [u, c, f, s] = l.split("|"); const e = per.get(u) || { first: Infinity, last: 0, n: 0, done: [] };
        e.first = Math.min(e.first, +c); e.last = Math.max(e.last, +f); e.n++; e.done.push(+f); per.set(u, e); lat.push((+f - +c) * 1000); finishes.push(+f);
        if (s !== "submitted_unconfirmed") out.sim_unexpected = (out.sim_unexpected || 0) + 1;
      }
      const firsts = [...per.values()].map((e) => e.first), lasts = [...per.values()].map((e) => e.last);
      // Jain's fairness index over items done per person when half of all items are done (1.0 = perfectly even shares for people still waiting)
      finishes.sort((a, b) => a - b); const half = finishes[Math.floor(finishes.length / 2)];
      const doneAtHalf = [...per.values()].filter((e) => e.n === items).map((e) => e.done.filter((d) => d <= half).length);
      const jain = (xs) => { const s = xs.reduce((a, b) => a + b, 0), s2 = xs.reduce((a, b) => a + b * b, 0); return s2 ? (s * s) / (xs.length * s2) : 1; };
      const heavyEntry = per.get(uid(10000 + users + 1));
      Object.assign(out.sim, {
        finished_all: ok, wall_s: +wall.toFixed(1), apps_per_s: +(total / wall).toFixed(1),
        per_app_ms: { p50: Math.round(q(lat, 0.5)), p95: Math.round(q(lat, 0.95)), max: Math.round(Math.max(...lat)) },
        time_to_first_claim_s: { p50: +q(firsts, 0.5).toFixed(1), p95: +q(firsts, 0.95).toFixed(1), max: +Math.max(...firsts).toFixed(1) },
        time_to_all_done_s: { p50: +q(lasts, 0.5).toFixed(1), p95: +q(lasts, 0.95).toFixed(1), max_light_person: +Math.max(...[...per.entries()].filter(([u]) => u !== uid(10000 + users + 1)).map(([, e]) => e.last)).toFixed(1), heavy_person: heavyEntry ? +heavyEntry.last.toFixed(1) : null },
        items_done_per_person_at_half: { min: Math.min(...doneAtHalf), max: Math.max(...doneAtHalf), jain: +jain(doneAtHalf).toFixed(3) },
        claimed_per_worker: ws.map((w) => w.stats.claimed),
      });
      ws.forEach((w) => 0);
      console.log("SIM", JSON.stringify(out.sim));
    }
    if (!process.argv.includes("--skip-browser")) {
      let pw = null;
      for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
      if (!pw) throw new Error("PLAYWRIGHT_UNRESOLVABLE");
      const apps = arg("browser-apps", 120), conc = arg("browser-concurrency", 6), latency = arg("latency-ms", 0);
      const mock = await startMockAts();
      const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
      const people = Math.ceil(apps / 3);
      await seedPeople(admin, 50000, people);
      await seedItems(admin, 50000, people, 3, `'${mock.base}/'||case when g=2 then 'greenhouse' else 'lever' end||'/b'||i||'-'||g||'?latency=${latency}'`);
      const ev = fs.mkdtempSync(path.join(os.tmpdir(), "ev-"));
      const w = createWorker({ rpc: psqlRpc({ dir: pg.dir, port: pg.port, size: 4 }), browser, workerId: "browser-0", concurrency: conc, perUser: 1, pollMs: 20, heartbeatMs: 20000, sweepMs: 3600000, evidenceDir: ev, log: () => {} });
      const cpu0 = process.cpuUsage(), t0 = Date.now(); const run = w.run();
      await waitDone(admin, `${mock.base}%`, 30 * 60 * 1000);
      const wall = (Date.now() - t0) / 1000; w.stop(); await run;
      const cpu = process.cpuUsage(cpu0), cpuS = (cpu.user + cpu.system) / 1e6;
      const [okN] = await admin.q(`select count(*) from career_apply_jobs where url like '${mock.base}%' and state='submitted_unconfirmed'`);
      out.browser = { applications: people * 3, ok: Number(okN), mock_received: mock.submissions.length, concurrency: conc, mock_latency_ms: latency, wall_s: +wall.toFixed(1), apps_per_s: +((people * 3) / wall).toFixed(2),
        per_app_ms: { p50: w.pct(0.5), p95: w.pct(0.95) }, node_cpu_s: +cpuS.toFixed(1), note: "Chromium child processes' CPU is not in node_cpu_s; watch `top` for the whole-machine figure" };
      console.log("BROWSER", JSON.stringify(out.browser));
      await browser.close(); await mock.close();
    }
  } finally {
    base.close(); pg.stop();
  }
  const j = arg("json", null); if (typeof j === "string") fs.writeFileSync(j, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => { console.error("LOADTEST_FAILED", e && e.stack || e); process.exit(1); });
