"use strict";
/* MASS APPLY END TO END (2026-11-04): the batch executor's entry point (scripts/career/batch-executor-main.cjs).
   D-037 keeps CAREER_BATCH_EXECUTOR pending because nothing in production loads workers/career-browser/batch-executor.cjs.
   The entry point is the missing loader, kept outside the production roots so turning it on stays the owner's deploy.
   REQUIRED: with the switch unset (or anything but "on") it constructs nothing and claims nothing; on, it refuses to run
   without its worker settings; assembled, it drains through the same executor; a LinkedIn, Indeed or Handshake posting
   never reaches the pool. Fakes only: no network, no database. Check: node --test tests/career-batch-executor-main-20261104.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const { assembleBatchExecutor, neverSites } = require(path.join(root, "scripts/career/batch-executor-main.cjs"));

const fakeStore = (intents) => {
  const calls = [];
  return { calls, pending: async () => { calls.push("pending"); return intents; }, claim: async () => { calls.push("claim"); return null; },
    finish: async () => { calls.push("finish"); }, saveRun: async () => {}, readRun: async () => null, ledgerFor: async () => ({ records: [] }), saveLedger: async () => {} };
};
const fakes = (store, postings) => ({
  store, transport: { call: async () => { throw new Error("no network in this test"); } },
  sources: { postingsFor: async () => postings || [], profileFor: async () => null },
  bridge: { createCareerBoardFor: () => () => null, createWorkerBoardProvider: () => ({}) },
  boardTransport: () => ({ close() {} }),
});

test("off unless CAREER_BATCH_EXECUTOR=on: nothing is constructed, nothing is claimed", () => {
  for (const v of [undefined, "", "off", "1", "true", "ON "]) {
    const store = fakeStore([{ intentId: "i1", userId: "u1", binding: { action: "prepare" } }]);
    const env = { UPMORE_CAREER_WORKER_URL: "https://worker.example.test", UPMORE_CAREER_WORKER_SECRET: "x".repeat(40) };
    if (v !== undefined) env.CAREER_BATCH_EXECUTOR = v;
    const a = assembleBatchExecutor(env, fakes(store));
    if (v === "ON ") { assert.equal(a.off, false, "the value is read trimmed and case-blind, like every release switch"); continue; }
    assert.equal(a.off, true, `CAREER_BATCH_EXECUTOR=${v}`);
    assert.match(a.reason, /claims nothing/);
    assert.deepEqual(store.calls, []);
  }
});
test("on without its worker settings: refuses to start, names the missing setting", () => {
  assert.throws(() => assembleBatchExecutor({ CAREER_BATCH_EXECUTOR: "on" }, fakes(fakeStore([]))), (e) => e.code === "MISSING_ENV" && /UPMORE_CAREER_WORKER_URL/.test(e.message));
  assert.throws(() => assembleBatchExecutor({ CAREER_BATCH_EXECUTOR: "on", UPMORE_CAREER_WORKER_URL: "https://w.example.test" }, fakes(fakeStore([]))), (e) => /UPMORE_CAREER_WORKER_SECRET/.test(e.message));
});
test("on and assembled: a drain goes through the same executor (a claim it does not win runs nothing)", async () => {
  const store = fakeStore([{ intentId: "i1", userId: "u1", binding: { action: "approve" } }]);
  const a = assembleBatchExecutor({ CAREER_BATCH_EXECUTOR: "on", UPMORE_CAREER_WORKER_URL: "https://w.example.test", UPMORE_CAREER_WORKER_SECRET: "s".repeat(40) }, fakes(store));
  assert.equal(a.off, false);
  const results = await a.executor.runBatchPending();
  assert.deepEqual(results, [{ intentId: "i1", status: "skipped_claimed" }]);
  assert.deepEqual(store.calls, ["pending", "claim"], "no finish without a claim: nothing executed");
  a.close();
});
test("LinkedIn, Indeed and Handshake postings never enter a batch pool", () => {
  const kept = neverSites([
    { id: 1, url: "https://boards.greenhouse.io/acme/jobs/1" },
    { id: 2, url: "https://www.linkedin.com/jobs/view/2" },
    { id: 3, url: "https://jobs.lever.co/beta/3", apply_url: "https://indeed.com/apply/3" },
    { id: 4, url: "https://jobs.ashbyhq.com/c/4", source_urls: ["https://app.joinhandshake.com/jobs/4"] },
    { id: 5, url: "https://notlinkedin.com.example.test/5" },
  ]);
  assert.deepEqual(kept.map((p) => p.id), [1, 5]);
});
