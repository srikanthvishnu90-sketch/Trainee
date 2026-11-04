// NAMED-ROLE COMPANY CAPTURE (fix lane 2026-10-20, branch
// fix/named-role-capture, base integration/v2-candidate @ 4ba2cb10;
// BUG-PENDING-ALLOCATION (named-role-capture) — numbers requested
// from Crew A per MI-093, none self-allocated).
//
// The defect (composition probe S1b on the v2 candidate, record:
// docs/gauntlet/99e975e1.md; proven pre-existing on Lane A's tree
// @ e10a6a49, NOT a merge artifact): namedRoleTargetOf's company
// capture admits '.' and up to three further capitalized tokens, so
// "…role at Northwind Ledger. The posting is on Greenhouse. Please
// handle the application for me." parsed the company as
// "Northwind Ledger. The" — the pool lookup missed and the user got
// the false "not in the served list" stop for a role the pool DOES
// hold. The owner's live Gusto phrasing has the same shape. Lane A's
// guards asserted the stop against an EMPTY pool, where the stop is
// correct either way; this guard exercises the POPULATED pool.
//
// Shape: the composition probe's — the REAL staged handler
// (scripts/career/stage-career.cjs staging of agent-chat/index.ts ->
// handler-career.ts, ESM realm, remote services faked) with Lane E's
// KB fixture behind the REAL pool loader. The named posting must be
// SELECTED (intent career_batch_apply; the run stops at the true
// worker stop, BOARD_NOT_WIRED) — never the false served-list stop —
// and the parsed company committed to the thread record must be the
// company exactly as stated ("Gusto", never "Gusto. The").
//
// Check: node --test tests/career-named-role-capture.test.cjs
// (respawns itself with --experimental-vm-modules, the pool-loader
// suite's pattern).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync, execFileSync } = require("node:child_process");
const { stripTypeScriptTypes } = require("node:module");
const nodeCrypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const persistenceFake = require(path.join(root, "tests/helpers/career-persistence-fake.cjs"));

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
    kbMode: "ok", kbCalls: 0, artifactRows: [],
    kbRows: [
      kbRow(),
      kbRow({ posting_key: "greenhouse:https://boards.greenhouse.io/ledgerline/jobs/77", board: "ledgerline", company: "Ledgerline Capital", title: "Finance Analyst Intern", url: "https://boards.greenhouse.io/ledgerline/jobs/77", text_excerpt: "Finance analyst intern. Build models in Excel, support deal teams, present findings." }),
      kbRow({ posting_key: "greenhouse:https://boards.greenhouse.io/northwind/jobs/102", company: "Northwind Ledger", title: "Data Engineering Intern", url: "https://boards.greenhouse.io/northwind/jobs/102", text_excerpt: "Data engineering intern. Pipelines in Python and SQL, dashboards for operators." }),
      kbRow({ posting_key: "greenhouse:https://boards.greenhouse.io/gusto/jobs/8257115", board: "gusto", company: "Gusto", title: "Finance Intern (Summer 2027)", url: "https://boards.greenhouse.io/gusto/jobs/8257115", text_excerpt: "Finance intern on the Finance Business Operations and Strategy team. Financial modeling, Excel, FP&A support." }),
      kbRow({ posting_key: "greenhouse:https://boards.greenhouse.io/jpmorganchase/jobs/555", board: "jpmorganchase", company: "J.P. Morgan", title: "Finance Intern", url: "https://boards.greenhouse.io/jpmorganchase/jobs/555", text_excerpt: "Finance intern. Markets and banking rotations, modeling in Excel, deal support." }),
    ],
  };
}
const USER = "00000000-0000-4000-8000-000000000001";
const THREAD = "00000000-0000-4000-8000-000000000002";

async function stagedApp(db, user) {
  if (!vm.SourceTextModule) throw new Error("run with --experimental-vm-modules");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "career-named-role-"));
  execFileSync(process.execPath, [path.join(root, "scripts/career/stage-career.cjs"), stage, "--json"]);
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } } }) },
    rpc: (name, args) => persistenceFake(db, user, THREAD, name, args),
    from(table) {
      if (table === "career_kb_postings") {
        db.kbCalls++;
        const query = {
          select() { return query; }, order() { return query; }, limit() { return query; },
          then(resolve) {
            if (db.kbMode === "error") return resolve({ data: null, error: { message: "kb read failed (fixture)" } });
            return resolve({ data: clone(db.kbRows), error: null });
          },
        };
        return query;
      }
      if (table === "channel_artifacts") {
        return {
          async insert(row) { db.artifactRows.push(clone(row)); return { error: null }; },
          select() { const q = { eq() { return q; }, async maybeSingle() { return { data: null, error: null }; }, then(r) { return r({ data: [], error: null }); } }; return q; },
        };
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
  let handle; let networkCalls = 0;
  const context = vm.createContext({
    Request, Response, Headers, URL, TextEncoder, TextDecoder, AbortController, crypto: nodeCrypto.webcrypto,
    Buffer: require("node:buffer").Buffer, atob, btoa, structuredClone, queueMicrotask,
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

// The machinery-engaged end state (identical to probe S1a on the
// minimal frame): the named posting is selected from the handler-
// loaded pool and the run stops at the TRUE worker stop.
function assertSelected(t, company) {
  assert.equal(t.status, 200);
  assert.equal(t.body.meta.intent, "career_batch_apply", `intent=${t.body.meta.intent} — the named-apply machinery must engage; reply: ${(t.body.reply || "").slice(0, 240)}`);
  assert.ok((t.body.reply || "").includes("I took the 1 you named"), `the named posting is selected: ${(t.body.reply || "").slice(0, 240)}`);
  // Launch readiness Q3 (2026-10-26): the stop reaches the person in plain words; its code stays on the record only.
  assert.ok((t.body.reply || "").includes(`Stopped — ${company}: Trainee can't reach this employer's application site from here, so nothing was filled or sent.`), `the stop is the true worker stop for ${company}: ${(t.body.reply || "").slice(0, 300)}`);
  assert.ok(!(t.body.reply || "").includes("BOARD_NOT_WIRED"), "the stop's code is never in the reply");
  assert.ok(!(t.body.reply || "").includes("not in the list I can work from"), "never the false served-list stop for a pooled role");
}
function assertCommittedCompany(db, company) {
  const sj = JSON.stringify(db.state);
  const committed = [...sj.matchAll(/"namedApply":\{"company":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  assert.ok(committed.length >= 1, "the named-apply target is committed to the thread record");
  for (const c of committed) assert.equal(c, company, "the committed company is the company exactly as stated — no sentence bleed");
}

if (!vm.SourceTextModule) {
  test("named-role capture staged-handler suites (respawned with VM modules)", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", __filename], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
} else {
  test("S1b verbatim: the trailing-sentence frame resolves the named posting from a populated pool", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t = await app.chat("I want to apply to the Software Engineering Intern role at Northwind Ledger. The posting is on Greenhouse. Please handle the application for me.", "nrc-s1b-1");
      assert.ok(db.kbCalls >= 1, "the handler read the KB pool");
      assertSelected(t, "Northwind Ledger");
      assertCommittedCompany(db, "Northwind Ledger");
    } finally { app.close(); }
  });

  test("the owner's Gusto phrasing (job 8257115 in the pool) resolves with the company exactly 'Gusto'", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t = await app.chat("I want to apply to the Finance Intern (Summer 2027) role at Gusto. The posting is on Greenhouse. Please handle the application for me.", "nrc-gusto-1");
      assertSelected(t, "Gusto");
      assertCommittedCompany(db, "Gusto");
    } finally { app.close(); }
  });

  test("'Please' opener alone after the company still resolves", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t = await app.chat("I want to apply to the Software Engineering Intern role at Northwind Ledger. Please handle the application for me.", "nrc-please-1");
      assertSelected(t, "Northwind Ledger");
      assertCommittedCompany(db, "Northwind Ledger");
    } finally { app.close(); }
  });

  test("'It' opener after the company still resolves", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t = await app.chat("I want to apply to the Software Engineering Intern role at Northwind Ledger. It is on Greenhouse. Please handle the application for me.", "nrc-it-1");
      assertSelected(t, "Northwind Ledger");
      assertCommittedCompany(db, "Northwind Ledger");
    } finally { app.close(); }
  });

  test("fused opener ('Ledger.The') with no space still resolves", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t = await app.chat("I want to apply to the Software Engineering Intern role at Northwind Ledger.The posting is on Greenhouse. Please handle the application for me.", "nrc-fused-1");
      assertSelected(t, "Northwind Ledger");
      assertCommittedCompany(db, "Northwind Ledger");
    } finally { app.close(); }
  });

  test("abbreviation chain survives whole: 'J.P. Morgan' with trailing sentences resolves as 'J.P. Morgan'", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t = await app.chat("I want to apply to the Finance Intern role at J.P. Morgan. The posting is on Greenhouse. Please handle the application for me.", "nrc-jpm-1");
      assertSelected(t, "J.P. Morgan");
      assertCommittedCompany(db, "J.P. Morgan");
    } finally { app.close(); }
  });

  test("controls: minimal frames resolve exactly as before (Northwind; J.P. Morgan)", async () => {
    {
      const db = freshDb(); const app = await stagedApp(db, USER);
      try {
        const t = await app.chat("I want to apply to the Software Engineering Intern role at Northwind Ledger.", "nrc-s1a-1");
        assertSelected(t, "Northwind Ledger");
        assertCommittedCompany(db, "Northwind Ledger");
      } finally { app.close(); }
    }
    {
      const db = freshDb(); const app = await stagedApp(db, USER);
      try {
        const t = await app.chat("I want to apply to the Finance Intern role at J.P. Morgan.", "nrc-jpm-min-1");
        assertSelected(t, "J.P. Morgan");
        assertCommittedCompany(db, "J.P. Morgan");
      } finally { app.close(); }
    }
  });

  test("honest stop stays honest — and names the company cleanly — for a role the pool does NOT hold", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t = await app.chat("I want to apply to the Software Engineering Intern role at Acme Rockets. The posting is on Greenhouse. Please handle the application for me.", "nrc-acme-1");
      assert.equal(t.status, 200);
      assert.equal(t.body.meta.intent, "named_role_apply", `an unpooled role keeps the named stop, intent=${t.body.meta.intent}`);
      assert.ok((t.body.reply || "").includes("Acme Rockets"), `the stop names the company: ${(t.body.reply || "").slice(0, 240)}`);
      assert.ok(!(t.body.reply || "").includes("I took the 1 you named"), "nothing is selected for an unpooled role");
      assertCommittedCompany(db, "Acme Rockets");
    } finally { app.close(); }
  });
}
