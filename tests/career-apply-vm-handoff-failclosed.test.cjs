"use strict";
// Review of #800 (D-072 item 4, round 2), the worker's side. No browser: the engine and the re-check are counted stand-ins, the
// worker (workers/career-browser/apply-vm.cjs createWorker) is the real one.
//   A. A hand-off row is never driven as an ordinary approved row. Its state comes with the claim (career_apply_vm_claim_handoff:
//      handoff {done_at, yes}); a row whose state cannot be read is let go, unsent; a database without that claim, or a failing
//      call, is asked with the plain claim (which the database never lets hand out a hand-off row: tests/architect/
//      handoff-failclosed-20261113.test.ts holds that side on Postgres).
//   B. The employer's own page a same-posting redirect led to is never the form, on every page the run reaches: the rule itself
//      (followedPageRefusal), and that the runner asks it after the Apply control is opened and again before Submit.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorker, queueHash } = require("../workers/career-browser/apply-vm.cjs");
const { followedPageRefusal } = require("../workers/career-browser/parallel-apply.cjs");

const RESUME = Buffer.from("%PDF-1.4\n% TEST resume for the hand-off fail-closed test\n");
const RSHA = crypto.createHash("sha256").update(RESUME).digest("hex");
const URL_ = "https://jobs.lever.co/acme/6c1d84b8-7305-42d7-bf69-5ace8a5b932f";
function row(extra = {}) {
  const payload = { version: 1, user_id: "00000000-0000-4000-8000-000000000800", job_id: "lever:acme:1", company: "Acme", url: URL_, resume_sha256: RSHA,
    fields: [{ label: "Email", value: "test.person@example.invalid", factId: "f1" }] };
  const h = queueHash(payload);
  return { id: "80080080-0800-4800-8800-800800800800", lease_token: "22222222-2222-4222-8222-222222222222", url: URL_, user_id: payload.user_id, payload, payload_hash: h, approval_hash: h,
    approval_id: "33333333-3333-4333-8333-333333333333", ...extra };
}
// One worker over a scripted database: `aware` answers career_apply_vm_claim_handoff (a function, so it may throw), `plain` the old claim.
function vm({ aware, plain = () => [] }) {
  const calls = [], drives = [], rechecks = [], logs = [];
  let awareN = 0, plainN = 0;
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "career_apply_vm_claim_handoff") return aware(awareN++);
    if (name === "career_apply_vm_claim") return plain(plainN++);
    if (name === "career_apply_vm_resume") return { filename: "resume.pdf", sha256: RSHA, b64: RESUME.toString("base64") };
    if (name === "career_apply_vm_heartbeat") return { ok: true };
    return {};
  };
  const w = createWorker({ rpc, browser: {}, allowHosts: ["jobs.lever.co"], retries: 0, evidenceDir: null, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "vm-failclosed-")), log: (l) => logs.push(l),
    // The ordinary drive: the one path that presses Submit without a card.
    applyOne: async (_b, p) => { drives.push(p.id); return { status: "submitted_page_confirmed", confirmation: "LV-TEST", filled: [] }; },
    recheck: async (_b, p, o) => { rechecks.push({ id: p.id, yes: o.yes }); return { state: "ready_for_yes", card: { url: p.url, payload_hash: p.approval.hash, answers: [], hash: "c".repeat(64) } }; } });
  const run = async () => { const n = await w.tick(); while (w.inflight.size) await new Promise((r) => setTimeout(r, 5)); return n; };
  const named = (n) => calls.filter((c) => c.name === n);
  return { w, run, drives, rechecks, logs, named, completed: () => named("career_apply_vm_complete").map((c) => [c.args.p_state, c.args.p_reason]) };
}
const once = (r) => (n) => (n === 0 ? [r] : []);

test("A: a hand-off row from the hand-off claim is re-checked, never driven as an ordinary row; its yes rides with it", async () => {
  const a = vm({ aware: once(row({ handoff: { done_at: "2026-11-13T10:00:00Z", yes: null } })) });
  assert.equal(await a.run(), 1);
  assert.deepEqual(a.drives, [], "the ordinary drive (Submit) never ran");
  assert.deepEqual(a.rechecks, [{ id: row().id, yes: null }]);
  assert.deepEqual(a.completed(), [["needs_user", "ready_for_yes"]]);
  assert.equal(a.named("career_apply_vm_handoff_state").length, 0, "no second call to learn the row's state");
  assert.equal(a.named("career_apply_vm_claim").length, 0, "the hand-off claim answered: the plain claim is not asked");
  const yes = { card_hash: "c".repeat(64), at: "2026-11-13T10:05:00Z" };
  const b = vm({ aware: once(row({ handoff: { done_at: "2026-11-13T10:00:00Z", yes } })) });
  await b.run();
  assert.deepEqual(b.drives, []);
  assert.deepEqual(b.rechecks, [{ id: row().id, yes }], "the yes goes to the re-check, which presses Submit only on that exact card");
});

test("A: an ordinary row from the hand-off claim ({done_at: null, yes: null}) is driven as before", async () => {
  const a = vm({ aware: once(row({ handoff: { done_at: null, yes: null } })) });
  await a.run();
  assert.deepEqual(a.drives, [row().id]);
  assert.deepEqual(a.rechecks, []);
});

test("A: a row whose hand-off state cannot be read is never driven: let go unsent, nothing recorded, named in the log", async () => {
  const unreadable = [{}, { handoff: null }, { handoff: "2026-11-13" }, { handoff: [] }, { handoff: {} }, { handoff: { done_at: 0, yes: null } }, { handoff: { done_at: "", yes: null } },
    { handoff: { done_at: "2026-11-13T10:00:00Z" } }, { handoff: { done_at: "2026-11-13T10:00:00Z", yes: "yes" } }, { handoff: { done_at: "2026-11-13T10:00:00Z", yes: {} } },
    { handoff: { done_at: null, yes: { card_hash: "c".repeat(64) } } }];
  for (const extra of unreadable) {
    const a = vm({ aware: once(row(extra)) });
    assert.equal(await a.run(), 1, JSON.stringify(extra));
    assert.deepEqual(a.drives, [], `no Submit path for ${JSON.stringify(extra)}`);
    assert.deepEqual(a.rechecks, [], `no browser for ${JSON.stringify(extra)}`);
    assert.deepEqual(a.completed(), [], "no outcome is recorded: the lease lapses and the sweep puts the row back (twice, then closed not sent)");
    assert.equal(a.named("career_apply_vm_resume").length, 0, "the resume is not even fetched");
    assert.ok(a.logs.some((l) => l.startsWith(`HANDOFF_STATE_UNREADABLE ${row().id}`)), a.logs.join("|"));
    assert.equal(a.w.stats.handoffUnreadable, 1);
  }
});

test("A: a failing hand-off claim never leads to a hand-off row being driven: the plain claim is asked instead, and it is asked again later", async () => {
  // The failure the first version swallowed: any error from the database.
  const a = vm({ aware: () => { throw new Error("career_apply_vm_claim_handoff: 503 upstream timeout"); }, plain: once(row()) });
  assert.equal(await a.run(), 1);
  assert.deepEqual(a.named("career_apply_vm_claim").map((c) => Object.keys(c.args).sort()), [["p_limit", "p_per_user", "p_skip_hosts", "p_worker"]]);
  assert.deepEqual(a.drives, [row().id], "what the plain claim hands out is an ordinary approved row (the database's guard keeps hand-off rows out of it)");
  assert.ok(a.logs.some((l) => /^HANDOFF_CLAIM_UNAVAILABLE .*503/.test(l)), a.logs.join("|"));
  // A row the plain claim hands out that says it is a hand-off row (an older database's column on the row) is still re-checked.
  const b = vm({ aware: () => { throw new Error("x: 503"); }, plain: once(row({ handoff_done_at: "2026-11-13T10:00:00Z" })) });
  await b.run();
  assert.deepEqual(b.drives, []); assert.equal(b.rechecks.length, 1);
});

test("A: a database without the hand-off claim (this build released before the migration) is asked with the plain claim, and not asked for the missing one on every tick", async () => {
  for (const err of ['career_apply_vm_claim_handoff: 404 {"code":"PGRST202","message":"Could not find the function public.career_apply_vm_claim_handoff in the schema cache"}',
    "function public.career_apply_vm_claim_handoff() does not exist"]) {
    const a = vm({ aware: () => { throw new Error(err); }, plain: once(row()) });
    assert.equal(await a.run(), 1);
    assert.equal(await a.run(), 0);
    assert.equal(await a.run(), 0);
    assert.equal(a.named("career_apply_vm_claim_handoff").length, 1, "remembered for a minute");
    assert.equal(a.named("career_apply_vm_claim").length, 3);
    assert.deepEqual(a.drives, [row().id]);
  }
  // An answer that is not a list of rows (a stand-in database answering {} or null) is not read as "nothing to do".
  for (const odd of [{}, null, "ok"]) {
    const a = vm({ aware: () => odd, plain: once(row()) });
    assert.equal(await a.run(), 1, JSON.stringify(odd));
    assert.deepEqual(a.drives, [row().id]);
  }
});

test("B: the employer's own page after a same-posting redirect is never the form (the rule)", () => {
  const followed = new Set(["cribl.io", "apply.belmond.com"]);
  assert.equal(followedPageRefusal("https://cribl.io/job-detail/?gh_jid=5971252004", "greenhouse", followed), "cribl.io");
  assert.equal(followedPageRefusal("https://CRIBL.io/newsletter#signup", "greenhouse", followed), "cribl.io", "any page of that host");
  assert.equal(followedPageRefusal("https://job-boards.greenhouse.io/embed/job_app?for=cribl&token=5971252004", "greenhouse", followed), null, "the board's own form at its own address");
  assert.equal(followedPageRefusal("https://apply.belmond.com/_/j/7046AFAA95", "workable", followed), null, "Workable's own app on the employer's domain");
  assert.equal(followedPageRefusal("https://apply.belmond.com/_/j/7046AFAA95/apply/", "workable", followed), null);
  assert.equal(followedPageRefusal("https://apply.belmond.com/careers/alerts", "workable", followed), "apply.belmond.com", "any other page there is not");
  assert.equal(followedPageRefusal("https://apply.belmond.com/_/j/7046AFAA95", "greenhouse", followed), "apply.belmond.com", "only for Workable");
  assert.equal(followedPageRefusal("not a url", "greenhouse", followed), "unreadable_page_address", "a page whose address cannot be read is refused");
  assert.equal(followedPageRefusal("https://cribl.io/x", "greenhouse", new Set()), null, "no redirect was followed: the rule does not apply");
});

test("B: the runner asks the rule after the Apply control is opened and again on the page as it is before Submit", () => {
  const src = fs.readFileSync(path.join(__dirname, "../workers/career-browser/parallel-apply.cjs"), "utf8");
  const at = (s, from = 0) => { const i = src.indexOf(s, from); assert.ok(i >= 0, `"${s}" is in the runner`); return i; };
  const body = at("async function attempt(");
  const first = at("await leaveFollowed();", body);
  const open = at("await openApply(page", first);
  const afterOpen = at("await leaveFollowed();", open);
  const fill = at("await fillForm(page", afterOpen);
  const beforeSubmit = at("notOnFollowed();", fill);
  const recorded = at('opts.onPhase("submitting"', beforeSubmit);
  const lastRead = src.lastIndexOf("notOnFollowed();", recorded);
  const click = at('page.click("[data-upmore-submit]")', recorded);
  assert.ok(first < open && open < afterOpen && afterOpen < fill, "checked on the first page, and again on the page the Apply control led to, before anything is filled");
  assert.ok(fill < beforeSubmit && beforeSubmit <= lastRead && lastRead < recorded && recorded < click, "and on the page as it is before the submitting record and the click");
  assert.ok(lastRead > at("opts.shotBefore", fill), "the last read is after every other pre-click step (the screenshot)");
  // The rule the two names apply is the tested one, and a refusal is redirect_not_allowed (unsent).
  assert.match(src, /const notOnFollowed = \(\) => \{ const h = followedPageRefusal\(page\.url\(\), p\.ats, followed\); if \(h\) throw new NeedsUser\("redirect_not_allowed", h\); \};/);
});
