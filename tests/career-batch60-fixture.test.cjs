"use strict";
// Release item 2, the local fixture version of scripts/browser-eval/batch60.cjs: 60 approved applications through the apply VM's
// whole path (workers/career-browser/apply-vm.cjs createWorker) on a REAL queue (a throwaway Postgres with every migration:
// career_apply_vm_claim / heartbeat / resume / complete), in real headless Chromium, on the LOCAL mock employer forms
// (tests/fixtures/mock-ats-server.cjs), submitted for real to that loopback mock. Then the receipts (career_apply_receipts.ts
// planReceipts, one per application) and the ONE closeout (WO-G, batch_closeout.ts runBatchCloseouts, keyed by the card).
// Counted: exactly one outcome per posting, duplicates 0, dropped 0, and fields that differ from the approved payload 0, both at
// the instant before Submit (ats-fill heldNow) and in what the employer received. Nothing leaves 127.0.0.1; no model; $0.
//   node --test tests/career-batch60-fixture.test.cjs      (Postgres 16 binaries on PATH or PGBIN; Playwright)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { provision, seedPeople, seedRows, PAYLOAD, uid, RESUME_SHA, ROOT } = require("./fixtures/apply-vm-seed.cjs");
const { psqlRpc } = require("./fixtures/psql-rpc.cjs");
const { startMockAts } = require("./fixtures/mock-ats-server.cjs");
const { createWorker } = require("../workers/career-browser/apply-vm.cjs");
const { auditedEngine, drain, tally } = require("../scripts/browser-eval/batch60.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
const pgBin = (() => { try { return !!(process.env.PGBIN || execFileSync("bash", ["-c", "command -v initdb || ls /usr/lib/postgresql/16/bin/initdb"], { encoding: "utf8" }).trim()); } catch { return false; } })();
const CI = process.env.CI === "true";
const skip = !pw ? "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH" : !pgBin && !CI ? "no Postgres 16 binaries" : false;

const AUTH = "Are you legally authorized to work in the United States?";
const SPONS = "Will you now or in the future require sponsorship for employment visa status?";
const APPROVED = { "First Name": "Test", "Last Name": "Person", "Full name": "Test Person", "Email": "test.person@example.invalid", [AUTH]: "Yes", [SPONS]: "No" };
const fieldsJson = (omit = []) => JSON.stringify(Object.entries(APPROVED).filter(([l]) => !omit.includes(l)).map(([label, value], i) => ({ label, value, factId: `f${i + 1}` })));
// What the mock form posts under which of its labels (mock-ats-server.cjs GH and LV).
const POSTED_LABEL = { greenhouse: { first_name: "First Name", last_name: "Last Name", email: "Email", question_auth: AUTH, question_sponsorship: SPONS },
  lever: { name: "Full name", email: "Email", "cards[auth]": AUTH } };

// The 60: ten people, six each. Most are ordinary Greenhouse / Lever forms; a few are what a real batch meets.
const N = 60;
const SPECIAL = { 7: "flaky", 31: "flaky", 13: "login", 44: "login", 20: "ask", 25: "bot", 50: "bot" };
let pg, rpc, mock, mockBot, browser;
before(async () => {
  if (skip) return;
  pg = provision(54460);
  rpc = psqlRpc({ dir: pg.dir, port: pg.port, size: 4 });
  mock = await startMockAts(); mockBot = await startMockAts(); // a shown check holds its portal off for everyone: its own host
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => {
  if (browser) await browser.close();
  for (const m of [mock, mockBot]) if (m) await m.close();
  if (rpc) rpc.close();
  if (pg) pg.stop();
});

test("batch of 60 through the apply VM: one outcome each, none twice, none dropped, every field as approved; 60 receipts and one closeout", { skip, timeout: 600000 }, async () => {
  const admin = rpc.admin, one = async (sql) => (await admin.q(sql))[0];
  await admin.q("set client_min_messages = warning");
  for (const [k, v] of [["APPLY_VM", "on"], ["APPLY_VM_USER_IDS", "*"], ["APPLY_VM_ALLOW_LOCAL", "on"]]) await admin.q(`insert into career_cloud_settings(key,value) values ('${k}','${v}') on conflict (key) do update set value=excluded.value`);
  await seedPeople(admin, 9000, 10);
  const items = Array.from({ length: N }, (_, k) => {
    const n = k + 1, person = Math.floor(k / 6) + 1, kind = SPECIAL[n] || "", ats = kind === "ask" || n % 2 ? "greenhouse" : "lever";
    const base = kind === "bot" ? mockBot.base : mock.base;
    return { n, u: uid(9000 + person), jid: `B60-${n}`, co: `Mock Employer ${n}`, url: `${base}/${ats}/${kind}${kind ? "-" : ""}b60-${n}`, ats, kind, fields: fieldsJson(kind === "ask" ? [SPONS] : []) };
  });
  const values = items.map((x) => `('${x.u}','${x.jid}','${x.co}','${x.url}',$f$${x.fields}$f$::jsonb)`).join(",");
  await seedRows(admin, `select x.u, x.jid, x.co, x.url, ${PAYLOAD({ fields: "x.f" })} || jsonb_build_object('title', 'TEST Analyst') as p from (values ${values}) as x(u, jid, co, url, f)`);
  const where = `url like '${mock.base}/%' or url like '${mockBot.base}/%'`;
  const ids = await admin.q(`select id || '|' || job_id from career_apply_jobs where ${where}`);
  const idOf = new Map(ids.map((l) => { const [id, jid] = l.split("|"); return [jid, id]; }));
  assert.equal(idOf.size, N, "60 approved rows queued");

  // Every submit request the employers received, per posting (the mock keeps only the first of a posting; this counts all).
  const posts = new Map();
  for (const m of [mock, mockBot]) m.server.on("request", (req) => { if (req.method === "POST") { const job = req.url.split("/")[2]; posts.set(job, (posts.get(job) || 0) + 1); } });
  // Every finish the worker recorded (career_apply_vm_complete that the database accepted).
  const finishes = [];
  const counted = async (name, a) => { const r = await rpc(name, a); if (name === "career_apply_vm_complete") finishes.push({ id: a.p_id, state: a.p_state, reason: a.p_reason }); return r; };
  const audits = [];
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), "b60-ev-"));
  const worker = createWorker({ rpc: counted, browser, workerId: "vm-b60", concurrency: 6, perUser: 1, pollMs: 50, heartbeatMs: 1000, sweepMs: 60000, evidenceDir: ev,
    applyOne: auditedEngine({ dryRun: false, audits }), log: () => {} });
  const t0 = Date.now();
  await drain(worker, async () => Number(await one(`select count(*) from career_apply_jobs where (${where}) and state in ('queued','driving')`)), 420000);
  const wall = Date.now() - t0;
  fs.rmSync(ev, { recursive: true, force: true });

  const rows = JSON.parse(await one(`select coalesce(json_agg(json_build_object('id', id, 'job_id', job_id, 'company', company, 'url', url, 'state', state, 'reason', reason,
    'confirmation_id', confirmation_id, 'claimed_at', claimed_at, 'payload_hash', payload_hash, 'user_id', user_id) order by job_id), '[]')::text from career_apply_jobs where ${where}`));
  const final = new Map(rows.map((r) => [r.id, r]));
  const batch = items.map((x) => ({ id: idOf.get(x.jid), n: x.n, url: x.url }));
  const { rows: per, summary } = tally({ batch, finishes, final, audits, posts });
  console.log("BATCH60-FIXTURE " + JSON.stringify({ ...summary, wall_s: Math.round(wall / 1000), posts: [...posts.values()].reduce((a, b) => a + b, 0) }));

  assert.equal(summary.one_outcome_each, N, `exactly one outcome per posting: ${JSON.stringify(per.filter((x) => x.finishes !== 1))}`);
  assert.equal(summary.dropped, 0, "no posting dropped");
  assert.equal(summary.duplicates, 0, "no posting twice");
  assert.equal(summary.mismatches, 0, `no field other than approved: ${JSON.stringify(per.filter((x) => x.mismatches && x.mismatches.length))}`);
  const want = (x) => ({ login: "needs_user:login_required", bot: "needs_user:bot_check", ask: "not_submitted:needs_answers" }[x.kind] || "submitted_unconfirmed");
  assert.deepEqual(per.map((x) => x.outcome), items.map(want), "each posting ended as its form allows");
  assert.equal(summary.reached_submit, items.filter((x) => want(x) === "submitted_unconfirmed").length);

  // What each employer received is exactly the approved payload: every posted answer is the approved value for its label, the
  // one resume, nothing to a posting that was not submitted, and one submission per submitted posting.
  const subs = [...mock.submissions, ...mockBot.submissions];
  assert.equal(subs.length, summary.reached_submit);
  for (const s of subs) {
    const x = items.find((i) => i.url.endsWith(`/${s.ats}/${s.job}`));
    assert.ok(x && want(x) === "submitted_unconfirmed", `a submission only for a submitted posting: ${s.job}`);
    for (const [name, label] of Object.entries(POSTED_LABEL[s.ats])) assert.equal(s.fields[name], APPROVED[label], `${s.job} ${name}`);
    for (const [name, v] of Object.entries(s.fields)) if (v && !POSTED_LABEL[s.ats][name]) assert.fail(`${s.job}: ${name} holds "${v}", which nothing approved`);
    assert.equal(s.files.resume.sha256, RESUME_SHA, `${s.job}: the one resume`);
  }

  // The receipts and the ONE closeout, from the records alone (Node runs the TypeScript modules with type stripping).
  const script = `
    const { planReceipts } = await import(${JSON.stringify(path.join(ROOT, "supabase/functions/_shared/career_apply_receipts.ts"))});
    const { runBatchCloseouts } = await import(${JSON.stringify(path.join(ROOT, "supabase/functions/_shared/batch_closeout.ts"))});
    const rows = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const receipts = planReceipts(rows, 0);
    const box = new Map();
    const outbox = { enqueue: async (userId, m) => (box.has(m.key) ? false : (box.set(m.key, { userId, ...m }), true)) };
    const batches = async () => [{ key: "status:closeout:b60-card", userId: rows[0].user_id, items: rows.map((r, i) => ({ n: i + 1, company: r.company, title: "TEST Analyst", result: "queued", job: { ...r, title: "TEST Analyst", sent_at: r.claimed_at } })) }];
    const first = await runBatchCloseouts({ outbox, now: 0, batches }), second = await runBatchCloseouts({ outbox, now: 1, batches });
    console.log(JSON.stringify({ receipts, first, second, closeouts: [...box.values()] }));`;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=commonjs", "-e", `(async () => { ${script} })().catch((e) => { console.error(e); process.exit(1); })`], { input: JSON.stringify(rows), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.receipts.length, N, "one receipt per application");
  assert.equal(new Set(out.receipts.map((x) => x.key)).size, N, "each receipt its own key (said once, ever)");
  for (const x of out.receipts) {
    const row = rows.find((y) => `receipt:${y.id}` === x.key);
    const head = { submitted_unconfirmed: `Sent to ${row.company}.`, needs_user: `${row.company} is not finished:`, not_submitted: `Not sent to ${row.company}:` }[row.state];
    assert.ok(head && x.text.startsWith(head), `${row.job_id} ${row.state}: ${x.text}`);
  }
  assert.deepEqual([out.first, out.second, out.closeouts.length], [1, 0, 1], "one closeout for the batch, however often the run sees it");
  const text = out.closeouts[0].text, lines = text.split("\n").slice(1);
  assert.ok(text.startsWith(`Your batch of ${N} is closed out, from the records:`), text.slice(0, 200));
  assert.equal(lines.length, N, "one line per application");
  for (const x of items) assert.equal(lines.filter((l) => l.includes(`Mock Employer ${x.n} `) || l.endsWith(`Mock Employer ${x.n}.`) || l.includes(`Mock Employer ${x.n};`) || l.includes(`Mock Employer ${x.n}:`)).length, 1, `Mock Employer ${x.n} named once`);
  console.log("BATCH60-FIXTURE-TEXTS " + JSON.stringify({ receipts: out.receipts.length, closeouts: out.closeouts.length, closeout_lines: lines.length }));
});

// The counters catch what they count (no browser, no database).
test("tally: a second finish, a second Submit, a missing finish and a field held other than approved are each counted", () => {
  const { memoryQueue } = require("../scripts/browser-eval/batch60.cjs");
  const pool = { facts: {}, answers: { Email: "a@example.invalid" }, resume: { path: "/x/resume.pdf" } };
  const ok = { label: "Email", source: "answer", kind: "text", approved: "a@example.invalid", held: "a@example.invalid" };
  const batch = [{ id: "a", url: "u1" }, { id: "b", url: "u2" }, { id: "c", url: "u3" }, { id: "d", url: "u4" }];
  const final = new Map([["a", { state: "submitted_unconfirmed" }], ["b", { state: "submitted_unconfirmed" }], ["d", { state: "submitted_unconfirmed" }]]);
  const finishes = [{ id: "a" }, { id: "b" }, { id: "b" }, { id: "d" }];
  const audits = [{ id: "a", pool, fields: [ok] }, { id: "b", pool, fields: [ok] }, { id: "d", pool, fields: [{ ...ok, held: "b@example.invalid" }] }, { id: "d", pool, fields: [{ ...ok, held: "b@example.invalid" }] }];
  const { summary } = tally({ batch, finishes, final, audits, posts: new Map([["j", 2]]) });
  assert.deepEqual([summary.one_outcome_each, summary.dropped, summary.duplicates, summary.mismatches], [2, 1, 3, 1]);
  const clean = tally({ batch: batch.slice(0, 1), finishes: finishes.slice(0, 1), final, audits: audits.slice(0, 1) }).summary;
  assert.deepEqual([clean.one_outcome_each, clean.dropped, clean.duplicates, clean.mismatches], [1, 0, 0, 0]);
});

test("memoryQueue keeps the database's transitions: a lease per claim, no 'submitted' without 'submitting', after 'submitting' never 'not sent'", async () => {
  const { memoryQueue } = require("../scripts/browser-eval/batch60.cjs");
  const mk = (id) => ({ id, user_id: "p", url: `https://jobs.lever.co/x/${id}`, payload: { url: `https://jobs.lever.co/x/${id}` }, approval_id: "a" });
  const q = memoryQueue([mk("1"), mk("2"), mk("3")]);
  const got = await q.rpc("career_apply_vm_claim", { p_worker: "w", p_limit: 5, p_per_user: 2, p_skip_hosts: [] });
  assert.equal(got.length, 2, "per person");
  const [r1, r2] = got;
  await assert.rejects(q.rpc("career_apply_vm_complete", { p_id: r1.id, p_lease: r1.lease_token, p_worker: "w", p_state: "submitted_unconfirmed" }), /invalid apply transition/);
  await q.rpc("career_apply_vm_heartbeat", { p_id: r2.id, p_lease: r2.lease_token, p_worker: "w", p_phase: "submitting" });
  assert.equal((await q.rpc("career_apply_vm_complete", { p_id: r2.id, p_lease: r2.lease_token, p_worker: "w", p_state: "not_submitted", p_reason: "x" })).state, "unknown_outcome");
  await assert.rejects(q.rpc("career_apply_vm_complete", { p_id: r2.id, p_lease: r2.lease_token, p_worker: "w", p_state: "not_submitted" }), /invalid apply claim/, "finished once");
  assert.equal(q.open(), 2);
});
