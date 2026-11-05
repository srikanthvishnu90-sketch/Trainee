"use strict";
// Entry point of the batch executor (MASS APPLY END TO END, 2026-11-04). D-037 lists CAREER_BATCH_EXECUTOR as pending
// because "nothing in production loads batch-executor.cjs, so a batch ask would commit an intent nobody runs". This is
// the missing loader: the operator assembly the batch-executor.cjs header describes, built from the environment, and a
// drain loop. It changes no rule: the executor is the same module (155 through batch-executor.cjs), every application is
// submitted only under an approve intent that carries the card's exact set hash (APPROVAL_SET_CHANGED otherwise), 149
// re-verifies each payload at click time, captchas stop the application and hand it to the person, LinkedIn and Indeed
// are refused by 149 and also dropped from the pool here.
//
// WHERE IT LIVES. Here in scripts/career, not in workers/: nothing in production runs it (tests/architect/d037-live-effects
// D-037/1e scans the production roots and keeps CAREER_BATCH_EXECUTOR pending while that holds). Running it on a worker
// host is the owner's deploy; the moment a production entry point loads it, that test requires CAREER_BATCH_EXECUTOR to
// move into RELEASE_FLAGS in the same change.
//
// THE SWITCH IS THE OWNER'S. The process does nothing unless CAREER_BATCH_EXECUTOR=on in ITS environment, and the chat
// commits a batch intent only when the agent-chat function's CAREER_BATCH_EXECUTOR is on too (handler-career.ts
// batchExecutorLive; release_config.ts RELEASE_PENDING). Turning it on is a release decision (D-034), not this file's.
//
// Environment (the worker host's own; nothing is read from chat or the repo):
//   CAREER_BATCH_EXECUTOR=on                              required, else the process exits 0 having claimed nothing
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY               the batch RPCs and the KB pool (supabase-transport.cjs)
//   UPMORE_CAREER_WORKER_URL, UPMORE_CAREER_WORKER_SECRET the board service (board-service.cjs) this executor drives through
//   BATCH_EXECUTOR_INTERVAL_MS (default 15000; 0 = drain once and exit)
const path = require("node:path");
const W = path.join(__dirname, "..", "..", "workers", "career-browser");
const { createBatchExecutor, createBatchRpcStore } = require(path.join(W, "batch-executor.cjs"));

const NEVER_HOSTS = /(^|\.)(linkedin\.com|indeed\.com|joinhandshake\.com|handshake\.com)$/i;
const hostOf = (u) => { try { return new URL(String(u || "")).hostname; } catch { return ""; } };
// The owner rule, before 149's own refusal: a posting whose link is LinkedIn, Indeed or Handshake never enters a batch.
function neverSites(postings) {
  return (Array.isArray(postings) ? postings : []).filter((p) => {
    const urls = [p && p.url, p && p.apply_url, ...((p && Array.isArray(p.source_urls)) ? p.source_urls : [])].filter(Boolean);
    return !urls.some((u) => NEVER_HOSTS.test(hostOf(u)));
  });
}

const coded = (code, message) => Object.assign(new Error(message || code), { code });

// The assembly, injectable for tests: every factory can be replaced, and nothing is constructed when the switch is off.
function assembleBatchExecutor(env, o) {
  const e = env || {};
  const x = o || {};
  if (String(e.CAREER_BATCH_EXECUTOR || "").trim().toLowerCase() !== "on") return { off: true, reason: "CAREER_BATCH_EXECUTOR is not on in this environment; the executor claims nothing" };
  const need = (k) => { const v = String(e[k] || ""); if (!v) throw coded("MISSING_ENV", `${k} is not set`); return v; };
  const workerUrl = need("UPMORE_CAREER_WORKER_URL"), secret = need("UPMORE_CAREER_WORKER_SECRET");
  const transport = x.transport || require(path.join(W, "supabase-transport.cjs")).supabaseTransportFromEnv(e);
  const sources = x.sources || require(path.join(W, "production-sources.cjs")).createProductionSources({ transport });
  const Bridge = x.bridge || require(path.join(__dirname, "..", "..", "supabase", "functions", "_shared", "career_task_bridge.js"));
  const httpFor = x.boardTransport || (() => require(path.join(W, "board-transport.cjs")).createSyncHttpTransport({ baseUrl: workerUrl }));
  let http = null;
  const boardForFor = (userId, opts) => {
    if (!http) http = httpFor();
    return Bridge.createCareerBoardFor(Bridge.createWorkerBoardProvider({ workerUrl, secret, userId, transport: http, resumeSha256: opts && opts.resumeSha256 ? opts.resumeSha256 : null }));
  };
  const executor = createBatchExecutor({
    store: x.store || createBatchRpcStore({ call: transport.call }),
    postingsFor: async (userId, familyText, count) => neverSites(await sources.postingsFor(userId, familyText, count)),
    profileFor: sources.profileFor,
    boardForFor,
    now: x.now,
  });
  return { off: false, executor, close: () => { if (http && typeof http.close === "function") http.close(); } };
}

async function main() {
  const a = assembleBatchExecutor(process.env);
  if (a.off) { console.log(`BATCH_EXECUTOR_OFF ${a.reason}`); return 0; }
  const every = /^\d{1,9}$/.test(String(process.env.BATCH_EXECUTOR_INTERVAL_MS || "")) ? Number(process.env.BATCH_EXECUTOR_INTERVAL_MS) : 15000;
  let stopping = false;
  const stop = () => { stopping = true; console.log("BATCH_EXECUTOR_STOPPING: no new claims; the drain in flight finishes and is recorded"); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  console.log(`BATCH_EXECUTOR_START interval=${every}ms`);
  do {
    try {
      const results = await a.executor.runBatchPending();
      if (results.length) console.log(JSON.stringify({ batchExecutor: "drained", results }));
    } catch (err) {
      // A drain that fails is logged and retried on the next tick; an execute intent is claimed once and is never
      // re-driven (batch-executor.cjs), so a retry can never double-submit.
      console.error("BATCH_EXECUTOR_DRAIN_FAILED", String(err && err.message).slice(0, 300));
    }
    if (!every) break;
    await new Promise((r) => setTimeout(r, every));
  } while (!stopping);
  a.close();
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { console.error("BATCH_EXECUTOR_FATAL", String(e && e.message).slice(0, 300)); process.exit(1); });

module.exports = { assembleBatchExecutor, neverSites };
