"use strict";
// The apply VM against a REAL Postgres (every migration, the new one included) and, for the end-to-end part, real headless
// Chromium on LOCAL mock Greenhouse/Lever forms. Nothing leaves 127.0.0.1; no model calls; no employer is contacted.
//   node --test tests/career-apply-vm.test.cjs        (APPLY_VM_PG="<socket dir>:<port>" reuses a database; else one is built, ~1 min)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { provision, seedPeople, seedItems, seedRows, PAYLOAD, FIELDS, uid, RESUME_SHA, ROOT } = require("./fixtures/apply-vm-seed.cjs");
const { psqlRpc } = require("./fixtures/psql-rpc.cjs");
const { startMockAts } = require("./fixtures/mock-ats-server.cjs");
const { createWorker, queueHash } = require("../workers/career-browser/apply-vm.cjs");

let pg, admin, rpcs = [];
const mk = () => { const r = psqlRpc({ dir: pg.dir, port: pg.port, size: 3 }); rpcs.push(r); return r; };
const one = async (sql) => (await admin.q(sql))[0];
let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright"]) { if (!id) continue; try { pw = require(id); break; } catch { /* next */ } }
const skipBrowser = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
const setting = (k, v) => admin.q(`insert into career_cloud_settings(key,value) values ('${k}','${v}') on conflict (key) do update set value=excluded.value`);

before(async () => {
  pg = provision(54420);
  const base = psqlRpc({ dir: pg.dir, port: pg.port, size: 1 });
  rpcs.push(base); admin = base.admin;
  await admin.q("set client_min_messages = warning");
  // a reused database (APPLY_VM_PG) is cleaned of what an earlier run seeded
  await admin.q("delete from career_apply_jobs; delete from career_apply_host_backoff; delete from career_cloud_settings where key like 'APPLY_VM%'; delete from auth.users where email like 'vm%@example.test'");
});
after(() => { rpcs.forEach((r) => r.close()); pg && pg.stop(); });

test("off by default: with the switch off nothing is claimed, whatever is queued", async () => {
  await seedPeople(admin, 100, 1);
  await seedItems(admin, 100, 1, 2, `'https://jobs.lever.co/off'||g||'/'||g`);
  const w = mk();
  assert.deepEqual(await w("career_apply_vm_claim", { p_worker: "w-off", p_limit: 10, p_per_user: 1, p_skip_hosts: [] }), []);
  await setting("APPLY_VM", "on"); // the people list is still empty: nobody
  assert.deepEqual(await w("career_apply_vm_claim", { p_worker: "w-off", p_limit: 10, p_per_user: 1, p_skip_hosts: [] }), []);
  await setting("APPLY_VM", "off");
});

test("least privilege: the worker's role can run its functions and read no table", async () => {
  // a session that is apply_vm_worker reading the queue directly:
  const { session } = require("./fixtures/psql-rpc.cjs");
  const s = session({ dir: pg.dir, port: pg.port, role: "apply_vm_worker" });
  await assert.rejects(() => s.q("select count(*) from public.career_apply_jobs"), /permission denied/);
  await assert.rejects(() => s.q("update public.career_apply_jobs set state='confirmed'"), /permission denied/);
  await assert.rejects(() => s.q("select * from public.career_apply_cloud_resumes"), /permission denied/);
  await assert.rejects(() => s.q("select public.career_apply_status_for('00000000-0000-4000-8000-000000000001')"), /permission denied/);
  s.close();
});

test("claim: two or three workers claiming at once never get the same item; each item under its own lease", async () => {
  await setting("APPLY_VM", "on"); await setting("APPLY_VM_USER_IDS", "*"); await setting("APPLY_VM_ALLOW_LOCAL", "on");
  await seedPeople(admin, 1000, 30);
  await seedItems(admin, 1000, 30, 12, `'http://127.0.0.1:9/lever/c'||i||'-'||g`);
  const ws = [mk(), mk(), mk()];
  const got = [];
  for (let round = 0; round < 8; round++) {
    const res = await Promise.all(ws.map((w, k) => w("career_apply_vm_claim", { p_worker: `w${k}`, p_limit: 12, p_per_user: 2, p_skip_hosts: [] })));
    res.forEach((rows, k) => rows.forEach((r) => got.push({ ...r, worker: `w${k}` })));
  }
  assert.ok(got.length >= 100, `claimed ${got.length}`);
  assert.equal(new Set(got.map((r) => r.id)).size, got.length, "no item claimed twice");
  assert.equal(new Set(got.map((r) => r.lease_token)).size, got.length, "one lease each");
  const states = await admin.q(`select count(*) filter (where state='driving' and attempts=1 and vm_phase='preparing') , count(*) from career_apply_jobs where id = any (array[${got.map((r) => `'${r.id}'`).join(",")}]::uuid[])`);
  assert.equal(states[0], `${got.length}|${got.length}`);
  // a worker cannot touch another worker's lease
  const r0 = got.find((r) => r.worker === "w0");
  const hb = await ws[1]("career_apply_vm_heartbeat", { p_id: r0.id, p_lease: r0.lease_token, p_worker: "w1", p_phase: null });
  assert.equal(hb.ok, false);
  await assert.rejects(() => ws[1]("career_apply_vm_complete", { p_id: r0.id, p_lease: r0.lease_token, p_worker: "w1", p_state: "not_submitted", p_reason: "x", p_evidence: {} }), /invalid apply claim/);
});

test("fairness: one person's 500-item batch cannot starve the others", async () => {
  await admin.q("update career_apply_jobs set state='not_submitted', reason='test reset', attempts=attempts where state in ('queued','driving')");
  await seedPeople(admin, 2000, 21);
  await seedItems(admin, 2000, 1, 500, `'http://127.0.0.1:9/lever/heavy'||g`); // person 2001: 500 items, queued first
  await seedItems(admin, 2001, 20, 3, `'http://127.0.0.1:9/lever/light'||i||'-'||g`); // 20 people: 3 each
  const w = mk();
  const first = await w("career_apply_vm_claim", { p_worker: "wf", p_limit: 20, p_per_user: 1, p_skip_hosts: [] });
  assert.equal(first.length, 20);
  assert.equal(new Set(first.map((r) => r.user_id)).size, 20, "20 claims, 20 different people");
  assert.equal(first.filter((r) => r.user_id === uid(2001)).length, 1, "the heavy person got one place, not twenty");
  const second = await w("career_apply_vm_claim", { p_worker: "wf", p_limit: 21, p_per_user: 1, p_skip_hosts: [] });
  assert.equal(new Set(second.map((r) => r.user_id)).size, 21, "the next round serves all 21 people once");
});

test("NOT_APPROVED: a row is claimed only with a stored approval that is this person's, for this exact payload, unrevoked and unexpired", async () => {
  await admin.q("update career_apply_jobs set state='not_submitted', reason='test reset' where state in ('queued','driving')");
  await setting("APPLY_VM", "on"); await setting("APPLY_VM_USER_IDS", "*"); await setting("APPLY_VM_ALLOW_LOCAL", "on");
  await seedPeople(admin, 8000, 8);
  const modes = ["ok", "none", "wrong_hash", "revoked", "expired", "other_user"]; // people 8001..8006
  for (const [k, mode] of modes.entries()) await seedItems(admin, 8000 + k, 1, 1, `'http://127.0.0.1:9/lever/na-${mode}'`, undefined, mode, { job: `NA-${mode}-`, co: "Co NA " }, uid(8008));
  // the engine_approval token inside every payload is 64 hex and every hash matches: the old checks would have passed all of them
  assert.equal(await one("select count(*) from career_apply_jobs where state='queued' and job_id like 'NA-%' and payload_hash = approval_hash and payload->>'engine_approval' ~ '^[0-9a-f]{64}$'"), "6");
  const w = mk();
  const got = await w("career_apply_vm_claim", { p_worker: "wna", p_limit: 60, p_per_user: 5, p_skip_hosts: [] });
  assert.deepEqual(got.map((r) => r.job_id), ["NA-ok-1"], "only the row with a live stored approval is handed out");
  assert.match(got[0].approval_id, /^[0-9a-f-]{36}$/, "the claim hands back the stored approval's id, not a token from the payload");
  assert.equal(await one(`select approval_id::text from career_message_approval_private.cloud_bound_jobs where job_row_id='${got[0].id}'`), got[0].approval_id);
  for (const mode of modes.slice(1)) {
    assert.equal(await one(`select state||':'||reason from career_apply_jobs where job_id='NA-${mode}-1'`), "not_submitted:NOT_APPROVED", `${mode} is refused NOT_APPROVED`);
    assert.equal(await one(`select attempts||':'||coalesce(vm_worker,'-') from career_apply_jobs where job_id='NA-${mode}-1'`), "0:-", `${mode} was never leased`);
  }
  // revoked between the claim and the click: the last heartbeat before Submit reads the stored approval again
  const r = got[0], a = (over = {}) => ({ p_id: r.id, p_lease: r.lease_token, p_worker: "wna", ...over });
  assert.equal((await w("career_apply_vm_heartbeat", a())).ok, true, "preparing heartbeat is unaffected");
  await admin.q(`update career_message_approval_private.cloud_bound_approvals set revoked_at = now() where approval_id = '${r.approval_id}'`);
  assert.deepEqual(await w("career_apply_vm_heartbeat", a({ p_phase: "submitting" })), { ok: false, why: "not_approved" });
  assert.equal(await one(`select vm_phase from career_apply_jobs where id='${r.id}'`), "preparing", "never recorded as submitting");
  // and a person's enqueue alone (no approval) is not one, even when the whole payload is well formed: no approval store, nothing approved
  assert.equal(await one(`select public.career_apply_vm_approval_refusal(j, now()) from career_apply_jobs j where job_id='NA-none-1'`), "NOT_APPROVED");
});

test("refusals: LinkedIn, Indeed and Handshake are never driven; Workday-style portals go to the person as 'needs you'", async () => {
  await admin.q("update career_apply_jobs set state='not_submitted', reason='test reset' where state in ('queued','driving')");
  await seedPeople(admin, 3000, 1);
  for (const [n, url] of [[1, "https://www.linkedin.com/jobs/view/1"], [2, "https://jobs.indeed.com/viewjob?jk=1"], [3, "https://app.joinhandshake.com/jobs/1"], [4, "https://acme.wd5.myworkdayjobs.com/en-US/x/job/1"], [5, "https://careers.example.com/jobs/1"], [6, "https://jobs.lever.co/acme/1"]]) {
    await seedRows(admin, `select x.u, x.jid, x.co, x.url, ${PAYLOAD({ fields: "'[]'::jsonb" })} as p from (select '${uid(3001)}' as u, 'REF-${n}' as jid, 'Co${n}' as co, '${url}' as url) x`);
  }
  const w = mk();
  const t = await w("career_apply_vm_triage", { p_limit: 100 });
  assert.deepEqual(t, { refused: 3, handed_back: 1 });
  const claimed = await w("career_apply_vm_claim", { p_worker: "wr", p_limit: 50, p_per_user: 50, p_skip_hosts: [] });
  assert.deepEqual(claimed.map((r) => r.job_id), ["REF-6"], "only the Lever posting is claimable");
  const rows = await admin.q(`select job_id||':'||state||':'||coalesce(reason,'') from career_apply_jobs where user_id='${uid(3001)}' order by job_id`);
  assert.deepEqual(rows, ["REF-1:not_submitted:site_not_supported", "REF-2:not_submitted:site_not_supported", "REF-3:not_submitted:site_not_supported", "REF-4:needs_user:login_required", "REF-5:queued:", "REF-6:driving:"]);
  const status = JSON.parse(await one(`select public.career_apply_status_for('${uid(3001)}')::text`));
  const by = Object.fromEntries(status.map((s) => [s.job_id, s]));
  assert.equal(by["REF-4"].status, "needs_you"); assert.equal(by["REF-4"].detail, "login_required"); assert.match(by["REF-4"].link, /myworkdayjobs/);
  assert.equal(by["REF-1"].status, "not_sent"); assert.equal(by["REF-5"].status, "queued"); assert.equal(by["REF-5"].detail, "site_not_supported_yet");
  assert.equal(by["REF-6"].status, "preparing");
  // the person signs in themselves (handoff), then the item is driven again; nothing else can be re-queued this way
  assert.deepEqual(await admin.q(`select public.career_apply_vm_handoff_requeue('${uid(3001)}','REF-1')::text`), ['{"ok": false}']);
  assert.deepEqual(await admin.q(`select public.career_apply_vm_handoff_requeue('${uid(3001)}','REF-4')::text`), ['{"ok": false, "why": "site_not_supported_yet"}'], "a sign-in-only portal is finished by the person");
  // a sign-in wall on a form the VM does fill (the worker handed it back): after the person signs in themselves, it is driven again
  await admin.q(`update career_apply_jobs set state='needs_user', reason='login_required', attempts=1, lease_token=gen_random_uuid(), claimed_at=now() where user_id='${uid(3001)}' and job_id='REF-6'`);
  await admin.q(`update career_apply_jobs set state='needs_user' where user_id='${uid(3001)}' and job_id='REF-6'`);
  assert.deepEqual(await admin.q(`select public.career_apply_vm_handoff_requeue('${uid(3001)}','REF-6')::text`), ['{"ok": true}']);
  assert.equal(await one(`select state from career_apply_jobs where user_id='${uid(3001)}' and job_id='REF-6'`), "queued");
});

test("honest outcomes: submitted only after the 'submitting' record; a dead worker retries only before it", async () => {
  await admin.q("update career_apply_jobs set state='not_submitted', reason='test reset' where state in ('queued','driving')");
  await seedPeople(admin, 4000, 1);
  await seedItems(admin, 4000, 1, 4, `'http://127.0.0.1:9/lever/h'||g`);
  const w = mk();
  const rows = await w("career_apply_vm_claim", { p_worker: "wh", p_limit: 4, p_per_user: 4, p_skip_hosts: [] });
  assert.equal(rows.length, 4);
  const [a, b, c, d] = rows;
  const args = (r, over = {}) => ({ p_id: r.id, p_lease: r.lease_token, p_worker: "wh", ...over });
  // cannot say "submitted" without having recorded "submitting"
  await assert.rejects(() => w("career_apply_vm_complete", args(a, { p_state: "submitted_unconfirmed", p_reason: null, p_evidence: { confirmation_id: "X" } })), /invalid apply transition/);
  // 'submitting' is recorded, then a failure can only be "unknown", never "not sent"
  assert.equal((await w("career_apply_vm_heartbeat", args(a, { p_phase: "submitting" }))).ok, true);
  const done = await w("career_apply_vm_complete", args(a, { p_state: "not_submitted", p_reason: "boom", p_evidence: {} }));
  assert.equal(done.state, "unknown_outcome");
  // the kill switch is checked at the last step before the click
  await setting("APPLY_VM", "off");
  assert.deepEqual(await w("career_apply_vm_heartbeat", args(b, { p_phase: "submitting" })), { ok: false, why: "switch_off" });
  await setting("APPLY_VM", "on");
  // dead workers: c died while preparing; d died after Submit was recorded
  await w("career_apply_vm_heartbeat", args(d, { p_phase: "submitting" }));
  await admin.q(`update career_apply_jobs set vm_heartbeat_at = now() - interval '10 minutes' where id in ('${c.id}','${d.id}')`);
  const reaped = await w("career_apply_vm_reap", { p_stale_seconds: 120 });
  assert.equal(reaped.unknown, 1); assert.equal(reaped.requeued, 1);
  assert.equal(await one(`select state||':'||vm_requeues from career_apply_jobs where id='${c.id}'`), "queued:1");
  assert.equal(await one(`select state from career_apply_jobs where id='${d.id}'`), "unknown_outcome");
  const again = await w("career_apply_vm_claim", { p_worker: "wh2", p_limit: 10, p_per_user: 10, p_skip_hosts: [] });
  assert.ok(again.some((r) => r.id === c.id && r.requeues === 1), "the pre-submit item is claimable again");
  assert.ok(!again.some((r) => r.id === d.id), "the post-submit item is never re-sent");
});

test("hash refusal in the worker: a payload that differs from what was approved, or a resume that differs, opens no browser", async () => {
  const calls = [], done = [];
  const payload = { version: 1, user_id: uid(5001), job_id: "J1", company: "Co", url: "http://127.0.0.1:9/lever/x", fields: [], privacy_epoch: 1, account_version: 1, expires_at: "2099-01-01T00:00:00Z", engine_approval: "e".repeat(64), resume_sha256: RESUME_SHA };
  const good = queueHash(payload);
  const row = (over = {}) => ({ id: "11111111-1111-4111-8111-111111111111", lease_token: "22222222-2222-4222-8222-222222222222", user_id: uid(5001), url: payload.url, payload, payload_hash: good, approval_hash: good, ...over });
  const mkWorker = (resume) => createWorker({
    workerId: "wt", browser: {}, concurrency: 1, evidenceDir: require("node:os").tmpdir(),
    applyOne: async () => { calls.push("browser"); return { status: "submitted_page_confirmed" }; },
    rpc: async (name, a) => { if (name === "career_apply_vm_resume") return resume; if (name === "career_apply_vm_complete") done.push([a.p_state, a.p_reason]); return null; },
    log: () => {},
  });
  const run = async (resume, r) => { const w = mkWorker(resume); await w.__test(r); };
  // reach into the worker through a claim of exactly one row
  const drive = async (resume, r) => {
    const w = createWorker({ workerId: "wt", browser: {}, concurrency: 1, evidenceDir: require("node:os").tmpdir(), applyOne: async () => { calls.push("browser"); return { status: "submitted_page_confirmed", attempts: 1 }; },
      rpc: async (name, a) => { if (name === "career_apply_vm_claim") return [r]; if (name === "career_apply_vm_resume") return resume; if (name === "career_apply_vm_complete") { done.push([a.p_state, a.p_reason]); return {}; } return {}; }, log: () => {} });
    await w.tick(); while (w.inflight.size) await new Promise((x) => setTimeout(x, 10));
  };
  void run;
  const okResume = { filename: "r.pdf", sha256: RESUME_SHA, b64: require("./fixtures/apply-vm-seed.cjs").RESUME.toString("base64") };
  await drive(okResume, row({ payload: { ...payload, company: "Someone Else" } }));            // payload changed after approval
  await drive(okResume, row({ approval_hash: "0".repeat(64) }));                                // approval differs
  await drive({ ...okResume, b64: Buffer.from("a different resume").toString("base64") }, row()); // resume bytes differ
  await drive(okResume, row({ url: "https://www.linkedin.com/jobs/view/1", payload: { ...payload, url: "https://www.linkedin.com/jobs/view/1" }, payload_hash: queueHash({ ...payload, url: "https://www.linkedin.com/jobs/view/1" }), approval_hash: queueHash({ ...payload, url: "https://www.linkedin.com/jobs/view/1" }) }));
  await drive(okResume, row({ url: "https://jobs.lever.co/acme/1", payload: { ...payload, url: "https://jobs.lever.co/acme/1" }, payload_hash: queueHash({ ...payload, url: "https://jobs.lever.co/acme/1" }), approval_hash: queueHash({ ...payload, url: "https://jobs.lever.co/acme/1" }) })); // real host, not on this VM's allow-list
  await drive(okResume, row());                                                                  // no stored approval id with the row
  await drive(okResume, row({ approval_id: "e".repeat(64) }));                                   // the payload's own token is not an approval id
  assert.deepEqual(calls, [], "no browser was ever opened");
  assert.deepEqual(done, [["not_submitted", "APPROVED_APPLICATION_CHANGED"], ["not_submitted", "APPROVED_APPLICATION_CHANGED"], ["not_submitted", "RESUME_CHANGED"], ["not_submitted", "site_not_supported"], ["not_submitted", "host_not_allowed"], ["not_submitted", "NOT_APPROVED"], ["not_submitted", "NOT_APPROVED"]]);
  // and the canonical hash is the database's own
  const sqlHash = await one(`select public.career_apply_payload_hash('${JSON.stringify({ b: [1, "é\"\\", null, true], a: { z: 1, y: "x" } })}'::jsonb)`);
  assert.equal(sqlHash, queueHash({ b: [1, "é\"\\", null, true], a: { z: 1, y: "x" } }));
});

test("end to end on mock forms: many people at once, isolated, honest status; a bot check stops the item and holds the portal", { skip: skipBrowser }, async () => {
  await admin.q("update career_apply_jobs set state='not_submitted', reason='test reset' where state in ('queued','driving')");
  await setting("APPLY_VM", "on"); await setting("APPLY_VM_USER_IDS", "*"); await setting("APPLY_VM_ALLOW_LOCAL", "on");
  const mock = await startMockAts();
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  try {
    await seedPeople(admin, 6000, 6);
    // six people, one heavy (6 items), the rest 2 each; Greenhouse- and Lever-style alternate
    await seedItems(admin, 6000, 6, 2, `'${mock.base}/'||case when g=1 then 'greenhouse' else 'lever' end||'/u'||i||'-'||g`);
  } finally { /* person 6001 gets 4 more items next, so one person's batch is bigger than the rest */ }
  await seedRows(admin, `select x.u, x.jid, x.co, x.url, ${PAYLOAD({ fields: `'[{"label":"Full name","value":"Test Person","factId":"f"},{"label":"Email","value":"test.person@example.invalid","factId":"f"},{"label":"Are you legally authorized to work in the United States?","value":"Yes","factId":"f"}]'::jsonb` })} as p
    from (select '${uid(6001)}' as u, 'XTR-'||g as jid, 'Co X'||g as co, '${mock.base}/lever/extra'||g as url from generate_series(1,4) g) x`);
  const total = Number(await one("select count(*) from career_apply_jobs where state='queued' and url like '" + mock.base + "%'"));
  const rpc1 = mk(), rpc2 = mk();
  const mkw = (rpc, id) => createWorker({ rpc, browser, workerId: id, concurrency: 3, perUser: 1, pollMs: 50, heartbeatMs: 500, sweepMs: 60000, evidenceDir: require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/ev-"), log: () => {} });
  const w1 = mkw(rpc1, "vm-a"), w2 = mkw(rpc2, "vm-b");
  const runs = [w1.run(), w2.run()];
  const t0 = Date.now();
  while (Number(await one(`select count(*) from career_apply_jobs where state in ('queued','driving') and url like '${mock.base}%'`)) > 0 && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200));
  w1.stop(); w2.stop(); await Promise.all(runs);
  const states = await admin.q(`select state, count(*) from career_apply_jobs where url like '${mock.base}%' group by 1 order by 1`);
  assert.deepEqual(states, [`submitted_unconfirmed|${total}`], "every item ended submitted_unconfirmed (the employer's email, not the page, confirms)");
  assert.equal(mock.submissions.length, total);
  assert.ok(w1.stats.claimed > 0 && w2.stats.claimed > 0, "both VMs worked");
  // isolation: each submission carries only its own cookie (a context shared across people would carry another job's) and only the one resume
  for (const s of mock.submissions) { assert.equal(s.cookie, `sid=${s.job}`, "no cookie from another application"); assert.equal(s.files.resume.sha256, RESUME_SHA); }
  assert.equal(await one(`select count(*) from career_apply_jobs where url like '${mock.base}%' and (vm_phase is distinct from 'submitting' or confirmation_id is null)`), "0");
  const st = JSON.parse(await one(`select public.career_apply_status_for('${uid(6002)}')::text`));
  assert.ok(st.every((s) => s.status === "submitted" && s.proof.confirmation_id), "status says submitted (not confirmed), with the page's confirmation code as proof");

  // bot check: stops the item, never solved, the portal is held off for everyone
  await seedPeople(admin, 7000, 2);
  const mock2 = await startMockAts();
  await seedItems(admin, 7000, 2, 1, `'${mock2.base}/greenhouse/bot'||i`);
  const w3 = mkw(mk(), "vm-c"); const r3 = w3.run();
  const t1 = Date.now();
  while (Number(await one(`select count(*) from career_apply_jobs where state in ('queued','driving') and url like '${mock2.base}/greenhouse/bot%' and attempts=1`)) < 2 && Date.now() - t1 < 60000) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 1500));
  w3.stop(); await r3;
  const bot = await admin.q(`select state||':'||reason from career_apply_jobs where url like '${mock2.base}/greenhouse/bot%' order by url`);
  assert.ok(bot.every((x) => x === "needs_user:bot_check"), `bot-check items: ${bot}`);
  assert.equal(mock2.submissions.length, 0, "nothing was submitted to a page showing a check");
  assert.equal(await one(`select count(*) from career_apply_host_backoff where host='${mock2.base.replace("http://", "")}' and last_reason='bot_wall'`), "1", "the portal is held off");
  // a 429 holds the portal off too, and the item is not asked again
  const mock3 = await startMockAts();
  await seedPeople(admin, 7100, 1);
  await seedItems(admin, 7100, 1, 1, `'${mock3.base}/lever/rate'||i`);
  const w4 = mkw(mk(), "vm-d"); const r4 = w4.run();
  const t2 = Date.now();
  while (Number(await one(`select count(*) from career_apply_jobs where url like '${mock3.base}/lever/rate%' and state='driving'`)) + Number(await one(`select count(*) from career_apply_jobs where url like '${mock3.base}/lever/rate%' and state='queued'`)) > 0 && Date.now() - t2 < 30000) await new Promise((r) => setTimeout(r, 200));
  w4.stop(); await r4;
  assert.equal(await one(`select count(*) from career_apply_host_backoff where host='${mock3.base.replace("http://", "")}' and last_reason='rate_limited'`), "1");
  assert.equal(await one(`select state||':'||reason from career_apply_jobs where url like '${mock3.base}/lever/rate%'`), "not_submitted:retries_exhausted");
  await Promise.all([mock, mock2, mock3].map((m) => m.close()));
  assert.equal(await one(`select count(*) from career_apply_jobs where url like '%/rate%' and attempts>1`), "0");
  await browser.close();
});

test("a sign-in wall is handed back as 'needs you', never signed into, nothing submitted", { skip: skipBrowser }, async () => {
  const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const mock = await startMockAts();
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off" });
  try {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "li-")), "r.pdf"); fs.writeFileSync(f, "%PDF-1.4\n");
    const p = { id: "login", ats: "lever", url: `${mock.base}/lever/login1`, facts: {}, answers: {}, resume: { path: f, sha256: sha256(fs.readFileSync(f)), preparedWithSha256: sha256(fs.readFileSync(f)) } };
    p.approval = { approval_id: "appr-login", hash: payloadHash(p) };
    const r = await applyOne(browser, p);
    assert.equal(r.status, "needs_user"); assert.equal(r.reason, "login_required");
    assert.equal(mock.submissions.length, 0);
  } finally { await browser.close(); await mock.close(); }
});
