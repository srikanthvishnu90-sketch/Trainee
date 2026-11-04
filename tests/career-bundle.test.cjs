/* CAREER-ONLY BUNDLE guard (owner decision 2026-10-15: "Prune the shelved
   finance half from the bundle, re-measure, then deploy" — the deployed
   agent-chat artifact contains ZERO finance code). The career entry
   (agent-chat/index-career.ts -> handler-career.ts) imports
   supabase/functions/_shared/router_core.career.js, built by
   scripts/build-router-core.py --career-only from the same career domain
   modules in the same order. These tests pin the prune forever:
   the career bundle stays current, exports only Career* names, carries no
   finance code or finance data consts, and — the real proof — answers
   byte-identically to the unpruned career domain modules (packages/domain, loaded as source) through the production
   career host, on the 9-turn chain and on the whole 42-conversation battery. (The Upmore full bundle, the earlier
   comparison point, was removed with the finance code on 2026-10-28.)
   Check: node --test tests/career-bundle.test.cjs */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const CAREER_BUNDLE = path.join(ROOT, "supabase/functions/_shared/router_core.career.js");
const DOMAIN = path.join(ROOT, "packages/domain");
// The same career modules the bundle is built from, loaded straight from source (comments and the embedded data
// compression are the only differences from the generated artifact).
function sourceModules() {
  return {
    CareerAccess: require(path.join(DOMAIN, "120-career-access.js")), CareerOnboarding: require(path.join(DOMAIN, "130-career-onboarding.js")),
    CareerRouter: require(path.join(DOMAIN, "142-career-router.js")), CareerDoorstep: require(path.join(DOMAIN, "141-career-doorstep.js")),
    CareerReply: require(path.join(DOMAIN, "140-career-reply.js")), CareerContainment: require(path.join(DOMAIN, "143-career-containment.js")),
  };
}
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const CONVS = require(path.join(ROOT, "tests/fixtures/complexity-battery.cjs"));
const BNOW = Date.parse("2026-10-14T23:00:00.000Z");

test("the career bundle is current with packages/domain (build --career-only --check)", () => {
  const r = spawnSync("python3", [path.join(ROOT, "scripts/build-router-core.py"), "--career-only", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the career bundle exports only Career* names — no finance surface", async () => {
  const m = await import(pathToFileURL(CAREER_BUNDLE).href);
  const keys = Object.keys(m);
  assert.ok(keys.length > 0, "career bundle exports something");
  for (const k of keys) assert.ok(k.startsWith("Career"), `non-career export leaked into the career bundle: ${k}`);
  for (const k of ["CareerAccess", "CareerOnboarding", "CareerRouter", "CareerDoorstep", "CareerReply", "CareerContainment"])
    assert.equal(typeof m[k], "object", k);
  const src = fs.readFileSync(CAREER_BUNDLE, "utf8");
  for (const marker of ["AlpacaTrading", "AgentTrade", "MERCHANT_TERMS_JSON", "STYLE_CORPUS_JSON", "PLATFORMS_JSON", "CapabilityRegistry"])
    assert.ok(!src.includes(marker), `finance marker present in career bundle: ${marker}`);
  assert.match(src, /CAREER_FIRM_SETS_JSON/);
  assert.match(src, /CAREER_CIRS_JSON/);
});

function deps(m) {
  return {
    CareerAccess: m.CareerAccess, CareerOnboarding: m.CareerOnboarding,
    CareerRouter: m.CareerRouter, CareerDoorstep: m.CareerDoorstep,
    CareerReply: m.CareerReply, CareerContainment: m.CareerContainment,
  };
}
const pick = (res, snap) => JSON.stringify({
  reply: res.reply, intent: res.intent, resultStatus: res.resultStatus,
  contained: res.contained, handler: res.handler, snap,
});
const isFallback = (res) => !res || res.intent === "career_fallback" || String((res && res.reply) || "").match(/^(I didn't catch that|I'm Trainee, a career agent: I find roles)/);

test("pruned artifact == unpruned source modules: 9-turn chain and the whole battery, byte-identical", async () => {
  const full = sourceModules();
  const career = await import(pathToFileURL(CAREER_BUNDLE).href);
  const hostA = CareerHost.createCareerHost(deps(full));
  const hostB = CareerHost.createCareerHost(deps(career));

  const NOW0 = Date.parse("2026-10-15T15:00:00.000Z");
  const CHAIN = [
    "I am a sophomore who wants to network into investment banking. Help me find people to reach out to and draft my first outreach.",
    "Find me internships I can apply to this week.",
    "What job applications do I have out right now, and what is their status?",
    "I want to break into investment banking — where do I start?",
    "How much did I spend on food last month?",
    "Stop everything. Pause all my outreach right now.",
    "Go ahead and send my outreach emails now.",
    "Can you get me a referral at Lincoln International?",
    "asdf qwer zzzz",
  ];
  function runChain(host) {
    let ctx = host.createTurnCtx({ userId: "ab-user", threadId: "ab-thread", now: NOW0, snapshot: null });
    const out = [];
    CHAIN.forEach((text, i) => {
      const res = host.runTurn(text, ctx);
      const snap = host.extractSnapshot(ctx);
      out.push(pick(res, snap));
      ctx = host.createTurnCtx({ userId: "ab-user", threadId: "ab-thread", now: NOW0 + (i + 1) * 60000, snapshot: snap });
    });
    return out;
  }
  assert.deepEqual(runChain(hostB), runChain(hostA), "career bundle chain diverges from the source modules");

  function runConv(host, cid) {
    let ctx = host.createTurnCtx({ userId: "battery-user", threadId: "battery-" + cid, now: BNOW, snapshot: null });
    const turns = [];
    CONVS[cid].forEach((text, i) => {
      const res = host.runTurn(text, ctx);
      const snap = host.extractSnapshot(ctx);
      turns.push({ res, snap });
      ctx = host.createTurnCtx({ userId: "battery-user", threadId: "battery-" + cid, now: BNOW + (i + 1) * 60000, snapshot: snap });
    });
    return turns;
  }
  let fallbackB = 0;
  for (const cid of Object.keys(CONVS)) {
    const ta = runConv(hostA, cid), tb = runConv(hostB, cid);
    ta.forEach((tn, i) => {
      if (isFallback(tb[i].res)) fallbackB++;
      assert.equal(pick(tb[i].res, tb[i].snap), pick(tn.res, tn.snap), `battery divergence at ${cid} turn ${i + 1}`);
    });
  }
  assert.equal(fallbackB, 0, "career bundle must serve the whole battery with zero fallback turns");
});
