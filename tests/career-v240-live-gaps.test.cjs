// LIVE-FIX LANE (2026-10-20, branch fix/v240-live-gaps, base
// integration/v2-candidate @ 71e01ef6 = deployed v240 + its record;
// BUG/FR-PENDING-ALLOCATION (v240-live-gaps) — numbers requested
// from Crew A per MI-093, none self-allocated).
//
// The defects, from the v240 LIVE gauntlet (docs/gauntlet/
// 566d622d.md — both failing exchanges verbatim there, recovered
// from the product's own agent_messages):
//
//   (h) WATCH: "Watch data analyst roles for me." drew the
//       contained "I didn't catch that" reply on the deployed
//       product. Lane A's tier-2 guards proved watch creation —
//       with phrasings that match the dispatch gates ("watch for
//       X", "alert me when…"). The gauntlet's natural imperative
//       matches NEITHER create gate in module 142 (both require
//       "watch for / set up a watch / alert me when…" shapes), so
//       no handler claimed the turn. Reproduced identically on the
//       node harness: the divergence is phrasing coverage, not
//       state carriage (the watch profile round-trips through
//       career_watch_kv / the commit RPC — the gauntlet read-back
//       counted the pre-existing watches fine).
//   (i) MEMORY: "My recruiter contact at Northwind Ledger is
//       Dana." drew the contained reply (never captured); a fresh
//       thread's "Who is my recruiter contact at Northwind
//       Ledger?" routed to company_intel. Two composing misses:
//       the keyed-fact capture frames require a TWO-token person
//       name, so a single first name never captures; and the
//       conversation-recall handler has no branch for the direct
//       keyed question ("who is my recruiter contact at X?").
//   (j) DOC: pasting the resume the tailor's own reply asked for
//       routed to company_intel (harness) / tracking_status
//       (live) — no dispatch claims a pasted resume, so the
//       profile is never built and the promised tailoring never
//       happens. The no-facts tailor ask and the no-document
//       delivery reply are CORRECT behavior and are pinned as
//       such; the paste route is the defect.
//   (f2) POOL WINDOW: a named posting older than the loader's
//       600-row recency window is unreachable, so a named-role ask
//       gets the honest "not in the served list" stop for a role
//       the KB holds. The handler must run a targeted KB lookup
//       for the named company/title beyond the window.
//
// Part 1 runs the node harness world (Lane A's production-
// semantics store). Part 2 runs the REAL staged handler
// (scripts/career/stage-career.cjs; remote services faked) —
// the deployed shape. Every assertion below was RED on the base
// tree for the defect it pins (controls marked as such were
// green before and must stay green).
//
// Check: node --test tests/career-v240-live-gaps.test.cjs
// (Part 2 respawns with --experimental-vm-modules, the
// pool-loader suite's pattern).
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

const ROOT = path.resolve(__dirname, "..");
const D = (n) => require(path.join(ROOT, "packages/domain", n));
const { CareerHost } = require(path.join(ROOT, "supabase/functions/_shared/career_host.js"));
const persistenceFake = require(path.join(ROOT, "tests/helpers/career-persistence-fake.cjs"));

const NOW = Date.parse("2026-10-20T15:00:00.000Z");
const WHITELIST = ["paused", "preferred_locations", "erase", "stated_facts"];
const clone = (v) => JSON.parse(JSON.stringify(v));

// =====================================================================
// Part 1 — node harness world (items 1 + 2)
// =====================================================================

function makeHost(extra) {
  return CareerHost.createCareerHost(Object.assign({
    CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"),
    CareerRouter: D("142-career-router.js"), CareerDoorstep: D("141-career-doorstep.js"),
    CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js"),
  }, extra || {}));
}
function makeWorld(hostExtra) {
  const host = makeHost(hostExtra);
  const store = { accounts: new Map(), threads: new Map(), watches: new Map() };
  let n = 0;
  const say = (userId, threadId, text, opts) => {
    const o = opts || {};
    n += 1;
    const ctx = host.createTurnCtx({ userId, threadId, now: NOW + n * 60000, accountPersistence: true, snapshot: store.threads.get(threadId) || null, account: clone(store.accounts.get(userId) || {}), watchState: clone(store.watches.get(userId) || {}), postings: o.postings || [], batchDeps: o.batchDeps || undefined, profile: o.profile });
    const out = host.runTurn(text, ctx);
    const snap = host.extractSnapshot(ctx);
    store.threads.set(threadId, snap);
    if (ctx._hostPatch) {
      for (const k of Object.keys(ctx._hostPatch)) assert.ok(WHITELIST.includes(k), `commit patch key "${k}" is outside the career_host_commit whitelist`);
      if (ctx._hostPatch.erase === true) store.accounts.set(userId, { paused: true });
      else { const a = store.accounts.get(userId) || {}; for (const k of Object.keys(ctx._hostPatch)) a[k] = clone(ctx._hostPatch[k]); store.accounts.set(userId, a); }
    }
    const aws = snap.stores && snap.stores.alertWatchState;
    const wpk = `career:watch-profile:${userId}`;
    if (aws && aws[wpk]) store.watches.set(userId, { [wpk]: clone(aws[wpk]) });
    return { out, ctx, snap };
  };
  return { host, store, say };
}
const factsOf = (r) => ((r.ctx.statedFacts || {}).facts) || [];
const isFallback = (out) => !out || out.contained || out.intent === "career_fallback" || !out.reply || out.reply.match(/^(I didn't catch that|I'm Trainee, a career agent: I find roles)/);

const PILOT = require(path.join(ROOT, "scripts/career/gauntlet/pilot-lib.cjs"));
const CORPUS = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/career-data/fixtures/gauntlet/jobs/scored-corpus.json"), "utf8")).postings;
function watchWorld() {
  const w = makeWorld();
  const profile = PILOT.gauntletProfile("p1-early-career-swe");
  const sayP = (uid, tid, text) => w.say(uid, tid, text, { postings: CORPUS, profile });
  return { sayP, store: w.store };
}
const watchInterests = (r, uid) => {
  const aws = (r.snap.stores || {}).alertWatchState || {};
  const wp = aws[`career:watch-profile:${uid}`];
  return wp ? (wp.interests || []) : [];
};

// ---------- Item 1: watch (gauntlet probe h) ----------

test("probe h verbatim: 'Watch data analyst roles for me.' creates the watch in the ask's own words", () => {
  const { sayP } = watchWorld();
  const w = sayP("u-h1", "t", "Watch data analyst roles for me.");
  assert.ok(!isFallback(w.out), `the gauntlet ask must not fall back, got: ${w.out && w.out.reply}`);
  assert.equal(w.out.intent, "career_watch_create", `intent=${w.out.intent}`);
  const interests = watchInterests(w, "u-h1");
  assert.equal(interests.length, 1, `exactly one watch created: ${JSON.stringify(interests)}`);
  assert.match(JSON.stringify(interests[0].role), /Data Analyst/, "the watch is for the role the user named");
  assert.ok(/^\d{2}-\d{4}$/.test(interests[0].role.soc), `watch role carries a real SOC: ${JSON.stringify(interests[0].role)}`);
});

test("probe h read-back: 'What am I watching now?' names the watch the gauntlet ask created", () => {
  const { sayP } = watchWorld();
  sayP("u-h2", "t", "Watch data analyst roles for me.");
  const r = sayP("u-h2", "t", "What am I watching now?");
  assert.ok(!isFallback(r.out), `read-back must not fall back: ${r.out && r.out.reply}`);
  assert.match(r.out.reply, /Data Analyst/, `read-back names the new watch: ${r.out.reply}`);
  assert.ok(!/no job watches on file/i.test(r.out.reply), "read-back must not disown the watch");
});

test("probe h discipline: manage still beats create — 'stop watching' removes, never re-creates", () => {
  const { sayP } = watchWorld();
  const created = sayP("u-h3", "t", "Watch data analyst roles for me.");
  assert.equal(watchInterests(created, "u-h3").length, 1, "the watch exists before the stop (else this test proves nothing)");
  const stop = sayP("u-h3", "t", "Stop watching data analyst roles.");
  assert.ok(!isFallback(stop.out), `stop turn must not fall back: ${stop.out && stop.out.reply}`);
  assert.notEqual(stop.out.intent, "career_watch_create", "a stop ask is never read as a new watch");
  assert.equal(watchInterests(stop, "u-h3").length, 0, `the watch is removed: ${JSON.stringify(watchInterests(stop, "u-h3"))}`);
});

test("probe h control (green before and after): 'watch out' is advice-seeking, never a watch create", () => {
  const { sayP } = watchWorld();
  const w = sayP("u-h4", "t", "Watch out for data analyst roles, they're competitive this year.");
  assert.equal(watchInterests(w, "u-h4").length, 0, "no watch may be created by a 'watch out' turn");
});

test("probe h control (green before and after): the gated phrasing 'watch for … and alert me' still creates", () => {
  const { sayP } = watchWorld();
  const w = sayP("u-h5", "t", "watch for Data Analyst roles and alert me when one opens");
  assert.equal(watchInterests(w, "u-h5").length, 1, `existing gate phrasing still creates: ${w.out.reply}`);
});

// ---------- Item 2: memory (gauntlet probe i) ----------

test("probe i verbatim: a single-first-name recruiter contact is captured, in the user's words", () => {
  const { say } = makeWorld();
  const w = say("u-i1", "t", "My recruiter contact at Northwind Ledger is Dana.");
  assert.ok(!isFallback(w.out), `the gauntlet statement must not fall back, got: ${w.out && w.out.reply}`);
  const facts = factsOf(w);
  assert.ok(facts.some((f) => f.kind === "recruiter_contact" && f.value === "Dana"), `recruiter_contact{Dana} captured: ${JSON.stringify(facts)}`);
});

test("probe i verbatim: a fresh thread's 'who is my recruiter contact' recalls the name — never company intel", () => {
  const { say } = makeWorld();
  say("u-i2", "t1", "My recruiter contact at Northwind Ledger is Dana.");
  const r = say("u-i2", "t2", "Who is my recruiter contact at Northwind Ledger?");
  assert.ok(!isFallback(r.out), `recall must not fall back: ${r.out && r.out.reply}`);
  assert.notEqual(r.out.intent, "company_intel", `the keyed question is a recall, not an intel ask (intent=${r.out.intent})`);
  assert.match(r.out.reply, /Dana/, `recall names the contact: ${r.out.reply}`);
  assert.match(r.out.reply, /Northwind Ledger/, `recall names the company: ${r.out.reply}`);
});

test("probe i discipline (BUG-169): a QUESTION about the contact records nothing", () => {
  const { say } = makeWorld();
  say("u-i3", "t", "Is my recruiter contact at Northwind Ledger Dana?");
  const after = say("u-i3", "t", "what do you remember about my Northwind Ledger plans?");
  assert.ok(!factsOf(after).some((f) => f.kind === "recruiter_contact"), `a question writes no fact: ${JSON.stringify(factsOf(after))}`);
});

test("probe i discipline: with nothing recorded, the who-ask invents no name", () => {
  const { say } = makeWorld();
  const r = say("u-i4", "t", "Who is my recruiter contact at Northwind Ledger?");
  assert.ok(!/your recruiter contact at Northwind Ledger is [A-Z][a-z]+/.test(r.out.reply || ""), `no invented contact may be presented: ${r.out.reply}`);
  assert.ok(!factsOf(r).some((f) => f.kind === "recruiter_contact"), "the ask itself writes nothing");
});

test("probe i witness (isolates the recall miss): a two-token name captures on today's code, yet the who-ask still misses it", () => {
  const { say } = makeWorld();
  say("u-i5", "t1", "My recruiter contact at Northwind Ledger is Priya Nair.");
  const r = say("u-i5", "t2", "Who is my recruiter contact at Northwind Ledger?");
  assert.match(r.out.reply || "", /Priya Nair/, `two-token recall still works: ${r.out.reply}`);
});

// =====================================================================
// Part 2 — the staged REAL handler (items 3 + 4)
// =====================================================================

const USER = "00000000-0000-4000-8000-000000000001";
const THREAD = "00000000-0000-4000-8000-000000000002";
const recent = (days) => new Date(Date.now() - days * 864e5).toISOString();
function kbRow(over = {}) {
  return Object.assign({
    posting_key: "greenhouse:https://boards.greenhouse.io/natera/jobs/501",
    source: "greenhouse", board: "natera",
    company: "Natera", title: "Senior Product Manager, Provider and RWD Health Systems Applications",
    location: "Remote, United States", url: "https://boards.greenhouse.io/natera/jobs/501",
    posted_at: recent(2), fetched_on: "2026-10-14",
    text_excerpt: "Senior product manager for provider and real-world-data health systems applications. Requirements: product management experience, SQL, Python, stakeholder management, roadmap ownership.",
  }, over);
}
const GUSTO_ROW = kbRow({
  posting_key: "greenhouse:https://boards.greenhouse.io/gusto/jobs/8257115", board: "gusto",
  company: "Gusto", title: "Finance Intern (Summer 2027)",
  location: "Denver, CO", url: "https://boards.greenhouse.io/gusto/jobs/8257115",
  posted_at: recent(30),
  text_excerpt: "Finance intern on the Finance Business Operations and Strategy team. Financial modeling, Excel, FP&A support.",
});
function freshDb(over = {}) {
  return Object.assign({
    state: { career: { v: 1, stores: {} } },
    messages: [], writes: [], account: {},
    kbMode: "ok", kbCalls: 0, kbTargetedCalls: 0, artifactRows: [],
    kbRows: [kbRow()],
    kbShelf: null,
  }, over);
}

async function stagedApp(db, user) {
  if (!vm.SourceTextModule) throw new Error("run with --experimental-vm-modules");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "career-v240-gaps-"));
  execFileSync(process.execPath, [path.join(ROOT, "scripts/career/stage-career.cjs"), stage, "--json"]);
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } } }) },
    rpc: (name, args) => persistenceFake(db, user, THREAD, name, args),
    from(table) {
      if (table === "career_kb_postings") {
        const query = {
          _ilike: null, _limit: null,
          select() { return query; },
          order() { return query; },
          limit(n) { query._limit = n; return query; },
          ilike(col, pattern) { query._ilike = { col, pattern }; return query; },
          then(resolve) {
            db.kbCalls++;
            if (db.kbMode === "error") return resolve({ data: null, error: { message: "kb read failed (fixture)" } });
            if (query._ilike) {
              db.kbTargetedCalls++;
              if (db.kbMode === "targeted-error") return resolve({ data: null, error: { message: "kb targeted read failed (fixture)" } });
              const shelf = db.kbShelf || db.kbRows;
              const needle = String(query._ilike.pattern || "").replace(/%/g, "").toLowerCase();
              const hits = shelf.filter((r) => String(r[query._ilike.col] || "").toLowerCase().includes(needle));
              return resolve({ data: clone(query._limit ? hits.slice(0, query._limit) : hits), error: null });
            }
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

const RESUME_TEXT = fs.readFileSync(path.join(ROOT, "packages/career-data/fixtures/test-resume.txt"), "utf8");
const CB0495 = "Tailor my resume for the Product Manager role at Natera and send me the PDF as a file in this chat.";
const GUSTO_ASK = "I want to apply to the Finance Intern (Summer 2027) role at Gusto. The posting is on Greenhouse. Please handle the application for me.";

if (!vm.SourceTextModule) {
  test("v240 live-gaps staged-handler suites (respawned with VM modules)", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", __filename], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
} else {
  // ---------- Item 3: doc contract (probe j) ----------
  test("probe j (a) CORRECT, pinned: no confirmed facts → the tailor asks for the resume; no document yet → the honest no-document reply", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const t1 = await app.chat(CB0495, "j-a1");
      assert.equal(t1.status, 200);
      assert.equal(t1.body.meta.intent, "career_tailor", `intent=${t1.body.meta.intent}`);
      assert.match(t1.body.reply, /Paste your resume/, `the tailor names the one missing input: ${t1.body.reply.slice(0, 200)}`);
      const t2 = await app.chat("Send me the PDF as a file in this chat.", "j-a2");
      assert.equal(t2.body.meta.intent, "career_document_delivery", `intent=${t2.body.meta.intent}`);
      assert.match(t2.body.reply, /no document file on this conversation yet/i, `the honest no-document reply: ${t2.body.reply.slice(0, 160)}`);
      assert.equal(db.artifactRows.length, 0, "no artifact row exists before any document is produced");
    } finally { app.close(); }
  });

  test("probe j (b) DEFECT: the pasted resume is ingested (never company intel / tracking), confirmed on the user's yes, and the standing tailor target produces the PDF in chat", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      await app.chat(CB0495, "j-b1");
      const paste = await app.chat(RESUME_TEXT, "j-b2");
      assert.equal(paste.status, 200);
      assert.equal(paste.body.meta.intent, "career_resume_ingest", `a pasted resume is an ingest, not ${paste.body.meta.intent}; reply: ${(paste.body.reply || "").slice(0, 200)}`);
      assert.match(paste.body.reply, /draft/i, `the receipt says the facts are held as drafts until confirmed: ${paste.body.reply.slice(0, 240)}`);
      assert.ok(JSON.stringify(db.state).includes("resume-ingest"), "the ingested facts are on the profile record");
      const yes = await app.chat("Yes, that's my resume.", "j-b3");
      assert.equal(yes.body.meta.intent, "career_tailor", `confirmation runs the standing tailor target (intent=${yes.body.meta.intent}); reply: ${(yes.body.reply || "").slice(0, 240)}`);
      assert.ok(Array.isArray(yes.body.artifacts) && yes.body.artifacts.length >= 1, `the tailor turn carries the document artifact: ${JSON.stringify(yes.body.artifacts)}`);
      assert.ok(db.artifactRows.length >= 1, "a channel_artifacts row was materialized");
      const row = db.artifactRows[db.artifactRows.length - 1];
      const bytes = Buffer.from(row.bytes_b64, "base64");
      assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-", "the stored bytes are a real PDF");
      assert.equal(nodeCrypto.createHash("sha256").update(bytes).digest("hex"), row.sha256, "the stored sha256 is the bytes' own hash");
      const send = await app.chat("Send me the PDF as a file in this chat.", "j-b4");
      assert.equal(send.body.meta.intent, "career_document_delivery", `intent=${send.body.meta.intent}`);
      const delivered = db.artifactRows[db.artifactRows.length - 1];
      assert.equal(delivered.sha256, row.sha256, "re-delivery is byte-identical (same sha)");
    } finally { app.close(); }
  });

  test("probe j control: a pasted JOB POSTING is never mistaken for a resume ingest", async () => {
    const db = freshDb(); const app = await stagedApp(db, USER);
    try {
      const posting = "Finance Intern (Summer 2027) at Gusto\n\nAbout the role: join the FBOS team.\n\nResponsibilities:\n- Build financial models in Excel\n- Support FP&A reporting\n\nRequirements:\n- Rising junior or senior\n- Excel and financial modeling\n\nApply: https://boards.greenhouse.io/gusto/jobs/8257115";
      const t = await app.chat(posting, "j-c1");
      assert.equal(t.status, 200);
      assert.notEqual(t.body.meta.intent, "career_resume_ingest", `a posting paste keeps its own route (intent=${t.body.meta.intent})`);
    } finally { app.close(); }
  });

  // ---------- Item 4: pool window (probe f2) ----------
  test("probe f2: the Gusto posting beyond the recency window is found by the targeted lookup and selected", async () => {
    const db = freshDb({ kbRows: [kbRow()], kbShelf: [kbRow(), GUSTO_ROW] });
    const app = await stagedApp(db, USER);
    try {
      const t = await app.chat(GUSTO_ASK, "f2-1");
      assert.equal(t.status, 200);
      assert.ok(db.kbTargetedCalls >= 1, "the handler ran a targeted KB lookup for the named company beyond the window");
      assert.equal(t.body.meta.intent, "career_batch_apply", `intent=${t.body.meta.intent}; reply: ${(t.body.reply || "").slice(0, 240)}`);
      // Launch readiness Q3 (2026-10-26): the stop reaches the person in plain words; its code stays on the record only.
      assert.ok((t.body.reply || "").includes("Stopped — Gusto: Trainee can't reach this employer's application site from here, so nothing was filled or sent."), `the stop is the true worker stop: ${(t.body.reply || "").slice(0, 300)}`);
      assert.ok(!(t.body.reply || "").includes("BOARD_NOT_WIRED"), "the stop's code is never in the reply");
      assert.ok(!(t.body.reply || "").includes("not in the list I can work from"), "never the false served-list stop for a KB-held role");
      const sj = JSON.stringify(db.state);
      const committed = [...sj.matchAll(/"namedApply":\{"company":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
      assert.ok(committed.length >= 1 && committed.every((c) => c === "Gusto"), `the committed company is exactly "Gusto": ${JSON.stringify(committed)}`);
    } finally { app.close(); }
  });

  test("probe f2 degradation: when the targeted lookup fails, the named ask degrades to the honest stop — no crash, no invented role", async () => {
    const db = freshDb({ kbRows: [kbRow()], kbShelf: [kbRow(), GUSTO_ROW], kbMode: "targeted-error" });
    const app = await stagedApp(db, USER);
    try {
      const t = await app.chat(GUSTO_ASK, "f2-2");
      assert.equal(t.status, 200, "the turn never crashes on a failed targeted read");
      assert.ok((t.body.reply || "").includes("not in the list I can work from"), `the honest named stop stands: ${(t.body.reply || "").slice(0, 240)}`);
    } finally { app.close(); }
  });
}
