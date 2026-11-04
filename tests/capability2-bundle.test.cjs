"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { execFileSync, spawnSync } = require("node:child_process");
const { stripTypeScriptTypes } = require("node:module");
const ROOT = path.resolve(__dirname, "..");
const cases = require("./fixtures/capability2/resumes.cjs");
const P = require("../packages/domain/122-career-profile.js");
const R = require("../packages/domain/154-career-recommendations.js");
const { CareerHost } = require("../supabase/functions/_shared/career_host.js");
const NOW = Date.parse("2026-10-15T12:00:00Z");
function profileFor(c) {
  const p = R.ingestResume({ now: NOW }, c.resume).profile;
  for (const f of p.facts) P.confirmFact(p, f.id);
  p.preferences.locations = c.locations;
  p.constraints.remoteOnly = c.remoteOnly;
  return p;
}
function deps(m) { return Object.fromEntries(["CareerAccess", "CareerOnboarding", "CareerRouter", "CareerDoorstep", "CareerReply", "CareerContainment"].map((n) => [n, m[n]])); }

test("C2 bundle: all 120 resumes traverse the generated career bundle and the source modules identically", async () => {
  const career = await import(path.join(ROOT, "supabase/functions/_shared/router_core.career.js"));
  const DOMAIN = path.join(ROOT, "packages/domain");
  const full = { CareerAccess: require(path.join(DOMAIN, "120-career-access.js")), CareerOnboarding: require(path.join(DOMAIN, "130-career-onboarding.js")), CareerRouter: require(path.join(DOMAIN, "142-career-router.js")), CareerDoorstep: require(path.join(DOMAIN, "141-career-doorstep.js")), CareerReply: require(path.join(DOMAIN, "140-career-reply.js")), CareerContainment: require(path.join(DOMAIN, "143-career-containment.js")) };
  const hosts = [career, full].map((m) => CareerHost.createCareerHost(deps(m)));
  for (const c of cases) {
    const results = hosts.map((h) => h.runTurn("Based on my resume, recommend roles", h.createTurnCtx({ userId: "synthetic-" + c.id, profile: profileFor(c), now: NOW })));
    assert.equal(results[0].contained, false, c.id);
    assert.equal(results[0].intent, "career_recommendations", c.id);
    assert.ok(results[0].result.artifact.paths.some((p) => p.id === c.expected), c.id);
    assert.deepEqual(results[0], results[1], c.id);
    assert.match(results[0].reply, /\[F-/);
  }
});
test("C2 bundle: host-injected fresh observations route with citations and requirement gaps", async () => {
  const m = await import(path.join(ROOT, "supabase/functions/_shared/router_core.career.js"));
  const host = CareerHost.createCareerHost(deps(m));
  const profile = profileFor(cases.find((c) => c.id === "warehouse-1"));
  const postings = [{ id: "synthetic-feed-1", title: "Operations coordinator", company: "SYNTHETIC Employer", location: "Chicago, IL", status: "open", source_kind: "live_public", source_url: "https://employer.invalid/jobs/1", observed_at: "2026-10-15T11:00:00Z", requirements: [{ skill: "SQL", level: "required", text: "SQL required" }] }];
  const out = host.runTurn("What current openings fit me?", host.createTurnCtx({ profile, postings, now: NOW }));
  assert.equal(out.intent, "career_recommendations");
  assert.equal(out.contained, false);
  assert.match(out.reply, /https:\/\/employer.invalid\/jobs\/1/);
  assert.match(out.reply, /SQL: not_evidenced \(required\)/);
  assert.equal(out.result.sends, 0);
});

if (!vm.SourceTextModule) {
  test("C2 actual staged HTTP entry in an ESM-only VM", () => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", "--test-name-pattern=C2 HTTP", __filename], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
} else {
  test("C2 HTTP: actual staged entry restores profile, recommends roles/gaps/locations, refuses fake current jobs", async () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "capability2-entry-"));
    try {
      execFileSync(process.execPath, [path.join(ROOT, "scripts/career/stage-career.cjs"), stage, "--json"]);
      const user = "00000000-0000-4000-8000-000000000001", thread = "00000000-0000-4000-8000-000000000002";
      // Merge repair (2026-10-15, combine lane): this test was written against
      // the pre-durability handler, which read agent_flow_state directly. The
      // merged handler loads/commits through the career persistence RPCs, and
      // its adapter correctly rejects this test's old blanket rpc stub
      // ({data:true}) as invalid storage. The client below backs rpc with
      // Codex's own persistence fake (the real RPC contract, same fixture the
      // durability suite grades) seeded with the same v:1/stores snapshot the
      // old fake served; every assertion below is unchanged in intent.
      const persistenceRpc = require("./helpers/career-persistence-fake.cjs");
      const db = { options: {}, state: { career: { v: 1, stores: { profile: profileFor(cases.find((c) => c.id === "legal-1")) } } }, messages: [], writes: [] };
      const messages = db.messages, writes = db.writes;
      let handle, networkCalls = 0;
      const client = { auth: { getUser: async () => ({ data: { user: { id: user } } }) }, rpc: (name, args) => persistenceRpc(db, user, thread, name, args), from(table) {
        assert.ok(["profiles", "agent_threads", "agent_flow_state", "agent_messages", "career_watch_kv"].includes(table));
        const filters = {};
        const query = { select() { return query; }, eq(k, v) { filters[k] = v; return query; }, async maybeSingle() {
          assert.equal(filters.user_id, user);
          if (table === "career_watch_kv") { assert.match(filters.key, /^career:(mock:|questions-shown$)/); return { data: null, error: null }; } // the per-turn reads: no mock running, no questions showing
          if (table === "agent_threads") return { data: { id: thread, user_id: user }, error: null };
          assert.equal(table, "agent_flow_state");
          return { data: { state: structuredClone(db.state) }, error: null };
        }, async upsert(row) { writes.push(table); if (table === "agent_flow_state") db.state = structuredClone(row.state); return { error: null }; }, async insert(row) { messages.push(structuredClone(row)); return { error: null }; } };
        return query;
      } };
      const context = vm.createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder, AbortController, crypto: require("node:crypto").webcrypto, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} }, fetch() { networkCalls++; throw Error("No network allowed"); }, Deno: { env: { get: (n) => ({ SUPABASE_URL: "https://supabase.invalid", SUPABASE_ANON_KEY: "mock-anon", SUPABASE_SERVICE_ROLE_KEY: "mock-service" })[n] } } });
      assert.equal(vm.runInContext("typeof require", context), "undefined");
      const modules = new Map();
      function load(id) {
        if (modules.has(id)) return modules.get(id);
        let mod;
        if (id === "https://deno.land/std@0.208.0/http/server.ts") mod = new vm.SyntheticModule(["serve"], function () { this.setExport("serve", (fn) => { handle = fn; }); }, { context, identifier: id });
        else if (id === "https://esm.sh/@supabase/supabase-js@2.117.1") mod = new vm.SyntheticModule(["createClient"], function () { this.setExport("createClient", () => client); }, { context, identifier: id });
        else {
          assert.ok(id.startsWith(stage + path.sep));
          let code = fs.readFileSync(id, "utf8");
          if (id.endsWith(".ts")) code = stripTypeScriptTypes(code, { mode: "transform" });
          mod = new vm.SourceTextModule(code, { context, identifier: id });
        }
        modules.set(id, mod); return mod;
      }
      const entry = load(path.join(stage, "agent-chat/index.ts"));
      await entry.link((s, m) => load(s.startsWith("https:") ? s : path.resolve(path.dirname(m.identifier), s)));
      await entry.evaluate();
      async function chat(message) {
        const response = await handle(new Request("https://upmore.invalid/chat", { method: "POST", headers: { Authorization: "Bearer mock-user-token", "Content-Type": "application/json" }, body: JSON.stringify({ thread_id: thread, message }) }));
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.action, null);
        assert.equal(messages.at(-1).meta.contained, false);
        assert.equal(messages.at(-1).meta.intent, "career_recommendations");
        return body;
      }
      const role = await chat("Based on my resume, recommend roles");
      assert.match(role.reply, /Legal support/);
      assert.match(role.reply, /\[F-/);
      assert.doesNotMatch(role.reply, /Python|CS degree/);
      const location = await chat("Which cities should I look in?");
      assert.match(location.reply, /Chicago, IL/);
      assert.match(location.reply, /no evidence supports ranking cities/);
      const gap = await chat("What skill gaps should I close?");
      assert.match(gap.reply, /unknown|no posting requirement/);
      // Client-posted job/profile payloads are not a trusted injection seam;
      // the real handler supplies no postings and must not read fixture jobs.
      const jobs = await chat("What current openings fit me?");
      assert.match(jobs.reply, /unverified/);
      assert.match(jobs.reply, /fixture and stale jobs are excluded/);
      assert.equal(networkCalls, 0);
      assert.ok(writes.every((t) => ["profiles", "agent_flow_state"].includes(t)));
      assert.equal(db.state.career.stores.alertWatchState, undefined);
      assert.ok(!db.state.career.stores.applyLog && !db.state.career.stores.applicationLog && !db.state.career.stores.portalRecords);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });
}
