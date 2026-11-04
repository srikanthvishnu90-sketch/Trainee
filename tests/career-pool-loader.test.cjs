// POOL LOADER (Lane E item 1 — composition wiring, Feature Depth
// Program v2): the live product served ZERO roles because
// handler-career.ts never passed `postings` into createTurnCtx, so
// career_host defaulted the pool to [] for every user on every turn
// (Lane D checklist §8; live-loop evidence 2026-10-20). This suite
// pins the fix:
//   * unit: career_kb_postings rows map to the corpus shape the
//     router's rankedShortlist consumes — fetched_on carried through,
//     role family/band computed, company never invented, HTML
//     stripped, unusable rows dropped (never repaired by guessing);
//   * unit: the loader never throws — a failed KB read degrades to an
//     empty pool so the product gives its designed honest-empty
//     reply (never a crash, never invented roles);
//   * integration: the REAL staged handler (index-career.ts ->
//     handler-career.ts, ESM realm, only the two remote services
//     replaced — the delegation suite's pattern) reads the KB
//     through its service-role client and a discovery ask ranks a
//     real role from the pool; with the KB read failing, the same
//     ask gets the honest-empty reply.
// Check: node --experimental-vm-modules --test tests/career-pool-loader.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync, execFileSync } = require("node:child_process");
const { stripTypeScriptTypes } = require("node:module");

const root = path.resolve(__dirname, "..");
const { CareerPool } = require(path.join(root, "supabase/functions/_shared/career_pool.js"));
const CareerJobs = require(path.join(root, "packages/domain/121-career-jobs.js"));
const persistenceFake = require(path.join(root, "tests/helpers/career-persistence-fake.cjs"));

const JOBS = { roleFamily: CareerJobs.roleFamily, seniorityBand: CareerJobs.seniorityBand, stripHtml: CareerJobs.stripHtml };
const recent = (days) => new Date(Date.now() - days * 864e5).toISOString();

function kbRow(over = {}) {
  return Object.assign({
    posting_key: "greenhouse:https://boards.greenhouse.io/northwind/jobs/101",
    source: "greenhouse", board: "northwind",
    company: "Northwind Ledger", title: "Software Engineering Intern",
    location: "Chicago, IL", url: "https://boards.greenhouse.io/northwind/jobs/101",
    posted_at: recent(2), fetched_on: "2026-10-14",
    text_excerpt: "Software engineering intern. Build product in JavaScript and Python, write tests, ship with a mentor.",
  }, over);
}

// ---------------- mapper / loader units ----------------

test("mapper: a KB row becomes the corpus shape rankedShortlist consumes", () => {
  const p = CareerPool.mapKbPosting(kbRow(), JOBS);
  assert.ok(p, "row maps");
  assert.equal(p.id, "greenhouse:https://boards.greenhouse.io/northwind/jobs/101");
  assert.equal(p.job_id, p.id, "adaptPosting's passthrough needs job_id");
  assert.equal(p.corpus_id, p.id);
  assert.equal(p.company, "Northwind Ledger");
  assert.equal(p.title, "Software Engineering Intern");
  assert.equal(p.location, "Chicago, IL");
  assert.equal(p.url, "https://boards.greenhouse.io/northwind/jobs/101");
  assert.equal(p.jd_text, "Software engineering intern. Build product in JavaScript and Python, write tests, ship with a mentor.");
  assert.equal(p.atsFamily, "greenhouse");
  assert.equal(p.source, "greenhouse");
  assert.equal(p.role_family, "SWE", "family computed by 121, not left undefined");
  assert.ok(p.seniority_band, "band computed");
  assert.equal(p.remote, "onsite");
  assert.equal(p.fetched_on, "2026-10-14", "snapshot freshness rides on every posting");
  assert.ok(!("requirements" in p), "no requirements key — its presence would make adaptPosting discard jd_text");
});

test("mapper: HTML/entities in the excerpt are stripped, remote is read from the row's own text", () => {
  const p = CareerPool.mapKbPosting(kbRow({ location: "Remote — United States", text_excerpt: "&nbsp; <p>Build <b>remote</b> tools &amp; services.</p>" }), JOBS);
  assert.equal(p.jd_text, "Build remote tools & services.");
  assert.equal(p.remote, "remote");
});

test("mapper: a company-less row stays company-less (TN-1a) and an unusable row is dropped, never repaired", () => {
  const p = CareerPool.mapKbPosting(kbRow({ company: null }), JOBS);
  assert.equal(p.company, null);
  assert.equal(p.company_not_stated, true);
  assert.equal(CareerPool.mapKbPosting(kbRow({ title: "" }), JOBS), null);
  assert.equal(CareerPool.mapKbPosting(kbRow({ posting_key: "" }), JOBS), null);
  assert.equal(CareerPool.mapKbPosting(null, JOBS), null);
});

test("loader: reads career_kb_postings bounded + recency-ordered and reports the pool's fetched_on", async () => {
  let spec = null;
  const loader = CareerPool.createKbPoolLoader({
    jobs: JOBS, limit: 25,
    readRows: async (s) => { spec = s; return [kbRow(), kbRow({ posting_key: "ashby:https://jobs.ashbyhq.com/openai/9", source: "ashby", board: "openai", company: "OpenAI", title: "Research Intern", fetched_on: "2026-10-13" })]; },
  });
  const pool = await loader.loadPool();
  assert.equal(spec.table, "career_kb_postings");
  assert.equal(spec.limit, 25);
  assert.equal(spec.order.column, "posted_at");
  assert.equal(spec.order.ascending, false);
  assert.equal(pool.error, null);
  assert.equal(pool.postings.length, 2);
  assert.equal(pool.fetchedOn, "2026-10-14", "the pool's freshness is the freshest row's fetched_on");
  assert.equal(pool.postings[1].atsFamily, "ashby");
});

test("loader: a failing KB read degrades to an empty pool — never a throw, never an invented role", async () => {
  const loader = CareerPool.createKbPoolLoader({ jobs: JOBS, readRows: async () => { throw new Error("kb down"); } });
  const pool = await loader.loadPool();
  assert.deepEqual(pool.postings, []);
  assert.equal(pool.error, "KB_POOL_READ_FAILED");
  assert.equal(pool.fetchedOn, null);
});

// ---------------- the staged real handler ----------------

const USER = "00000000-0000-4000-8000-000000000001";
const THREAD = "00000000-0000-4000-8000-000000000002";
const SNAPSHOT_PROFILE = {
  basics: { name: "Bundle Test", location: "Chicago, IL" },
  facts: [
    { kind: "education", text: "B.S. Computer Science at TEST University, graduating May 2028", org: "TEST University", title: "B.S. Computer Science", end: "2028-05" },
    { kind: "skill", name: "Python", text: "Skill: Python", fact_id: "TEST-F1", evidence: ["synthetic resume lists Python"], unproven: false },
  ],
  constraints: { workAuthorization: "US citizen", needsSponsorship: false },
  preferences: { locations: ["Chicago"], starredCompanies: [] },
};
const clone = (v) => JSON.parse(JSON.stringify(v));

function freshDb() {
  return {
    state: { career: { v: 1, stores: { profile: clone(SNAPSHOT_PROFILE) } } },
    messages: [], writes: [], account: {},
    kbMode: "ok", kbCalls: 0,
    kbRows: [
      kbRow(),
      kbRow({ posting_key: "greenhouse:https://boards.greenhouse.io/ledgerline/jobs/77", board: "ledgerline", company: "Ledgerline Capital", title: "Finance Analyst Intern", url: "https://boards.greenhouse.io/ledgerline/jobs/77", text_excerpt: "Finance analyst intern. Build models in Excel, support deal teams, present findings." }),
      kbRow({ posting_key: "greenhouse:https://boards.greenhouse.io/northwind/jobs/102", company: "Northwind Ledger", title: "Data Engineering Intern", url: "https://boards.greenhouse.io/northwind/jobs/102", text_excerpt: "Data engineering intern. Pipelines in Python and SQL, dashboards for operators." }),
    ],
  };
}

async function stagedApp(db, user) {
  if (!vm.SourceTextModule) throw new Error("run with --experimental-vm-modules");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "career-pool-loader-"));
  execFileSync(process.execPath, [path.join(root, "scripts/career/stage-career.cjs"), stage, "--json"]);
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } } }) },
    rpc: (name, args) => persistenceFake(db, user, THREAD, name, args),
    from(table) {
      if (table === "career_kb_postings") {
        db.kbCalls++;
        const query = {
          select() { return query; },
          order() { return query; },
          limit() { return query; },
          then(resolve, reject) {
            if (db.kbMode === "error") return resolve({ data: null, error: { message: "kb read failed (fixture)" } });
            return resolve({ data: clone(db.kbRows), error: null });
          },
        };
        return query;
      }
      assert.ok(["profiles", "agent_threads", "agent_flow_state", "agent_messages"].includes(table), `unexpected table: ${table}`);
      const filters = {};
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        async maybeSingle() {
          assert.equal(filters.user_id, user);
          if (table === "agent_threads") { assert.equal(filters.id, THREAD); return { data: { id: THREAD, user_id: user }, error: null }; }
          assert.equal(table, "agent_flow_state");
          assert.equal(filters.thread_id, THREAD);
          return { data: { state: clone(db.state) }, error: null };
        },
        async upsert(row) {
          db.writes.push(table);
          if (table === "agent_flow_state") { assert.equal(row.user_id, user); assert.equal(row.thread_id, THREAD); db.state = clone(row.state); }
          else assert.equal(table, "profiles");
          return { error: null };
        },
        async insert(row) { assert.equal(table, "agent_messages"); assert.equal(row.thread_id, THREAD); db.messages.push(clone(row)); return { error: null }; },
      };
      return query;
    },
  };
  let handle;
  let networkCalls = 0;
  const context = vm.createContext({
    Request, Response, Headers, URL, TextEncoder, TextDecoder, AbortController, crypto: require("node:crypto").webcrypto,
    setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} },
    fetch() { networkCalls++; throw new Error("external network forbidden in staged handler"); },
    Deno: { env: { get: (name) => ({ SUPABASE_URL: "https://supabase.example.test", SUPABASE_ANON_KEY: "mock-anon", SUPABASE_SERVICE_ROLE_KEY: "mock-service" })[name] } },
  });
  const modules = new Map();
  function load(id) {
    if (modules.has(id)) return modules.get(id);
    let mod;
    if (id === "https://deno.land/std@0.208.0/http/server.ts") {
      mod = new vm.SyntheticModule(["serve"], function () { this.setExport("serve", (fn) => { handle = fn; }); }, { context, identifier: id });
    } else if (id === "https://esm.sh/@supabase/supabase-js@2.117.1") {
      mod = new vm.SyntheticModule(["createClient"], function () { this.setExport("createClient", () => client); }, { context, identifier: id });
    } else {
      assert.ok(id.startsWith(stage + path.sep), `import escaped staged tree: ${id}`);
      let code = fs.readFileSync(id, "utf8");
      if (id.endsWith(".ts")) code = stripTypeScriptTypes(code, { mode: "transform" });
      mod = new vm.SourceTextModule(code, { context, identifier: id });
    }
    modules.set(id, mod);
    return mod;
  }
  const entry = load(path.join(stage, "agent-chat/index.ts"));
  await entry.link((specifier, referencing) => load(specifier.startsWith("https:") ? specifier : path.resolve(path.dirname(referencing.identifier), specifier)));
  await entry.evaluate();
  assert.equal(typeof handle, "function", "the staged entry registered the real handler");
  return {
    async chat(message, key) {
      const res = await handle(new Request("https://upmore.example.test/chat", {
        method: "POST", headers: { Authorization: "Bearer <redacted>", "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: THREAD, message, turn_key: key }),
      }));
      const body = await res.json();
      assert.equal(networkCalls, 0, "the handler attempted no external network call");
      return { status: res.status, body };
    },
    close() { fs.rmSync(stage, { recursive: true, force: true }); },
  };
}

if (!vm.SourceTextModule) {
  test("pool loader staged-handler suites (respawned with VM modules)", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", __filename], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
} else {
  test("handler: a discovery ask ranks a real role from the KB pool (the §8 gap, closed)", async () => {
    const db = freshDb();
    const app = await stagedApp(db, USER);
    try {
      const turn = await app.chat("Find me software engineering intern roles", "pool-ask-1");
      assert.equal(turn.status, 200);
      assert.ok(db.kbCalls >= 1, "the handler read career_kb_postings");
      assert.ok(!turn.body.reply.includes("I won't make any up"), `reply must not be the honest-empty text: ${turn.body.reply}`);
      assert.ok(turn.body.reply.includes("Northwind Ledger"), `reply names a role from the pool: ${turn.body.reply}`);
      assert.ok(turn.body.reply.includes("Software Engineering Intern"), `reply names the ranked role: ${turn.body.reply}`);
    } finally { app.close(); }
  });

  test("handler: with the KB read failing, the same ask degrades to the honest-empty reply (no crash, no invented role)", async () => {
    const db = freshDb();
    db.kbMode = "error";
    const app = await stagedApp(db, USER);
    try {
      const turn = await app.chat("Find me software engineering intern roles", "pool-ask-degraded-1");
      assert.equal(turn.status, 200);
      assert.ok(db.kbCalls >= 1, "the handler attempted the KB read");
      assert.ok(turn.body.reply.includes("I won't make any up"), `reply is the designed honest-empty text: ${turn.body.reply}`);
      assert.ok(!turn.body.reply.includes("Northwind Ledger"), "no role is served from a failed read");
    } finally { app.close(); }
  });
}
