"use strict";
// Producer-only QA: actual engineInput/trustedManifest/planner/prepare, synthetic dry-run evidence and RPC receipts.
// No browser, network, database, card approval or external submission. Missing old entrypoints are controls, not reds.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const sourceRoot = path.resolve(process.env.CLOUD_CARD_PRODUCER_SOURCE_ROOT || path.join(__dirname, ".."));
const sourceSha = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (process.env.CLOUD_CARD_PRODUCER_EXPECT_SHA) assert.equal(sourceSha, process.env.CLOUD_CARD_PRODUCER_EXPECT_SHA);
const available = fs.existsSync(path.join(sourceRoot, "workers/career-cloud/prepare.ts"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-card-producer-qa-"));
const measured = [];
const control = available ? false : "NOT_AVAILABLE_BASELINE: producer entrypoint does not exist; no behavioral red claimed";
after(() => {
  if (process.env.CLOUD_CARD_PRODUCER_MEASUREMENTS) fs.writeFileSync(process.env.CLOUD_CARD_PRODUCER_MEASUREMENTS,
    JSON.stringify({ sourceRoot, sourceSha, available, baselineClassification: available ? "AVAILABLE" : "NOT_AVAILABLE_BASELINE", cases: measured }, null, 2) + "\n");
  fs.rmSync(root, { recursive: true, force: true });
});
const mod = (p) => JSON.stringify(pathToFileURL(path.join(sourceRoot, p)).href);
const driverSource = (dir, mode) => `
import { prepareCloudCard } from ${mod("workers/career-cloud/prepare.ts")};
import { trustedManifest, planForm, contractFill } from ${mod("extension/src/apply_core.ts")};
import { applicationApprovalHash } from ${mod("scripts/apply.ts")};
import { hashApplyPayload } from ${mod("supabase/functions/_shared/career_apply_store.ts")};
import { answerKey } from ${mod("supabase/functions/_shared/question_map.ts")};
const dir = ${JSON.stringify(dir)}, mode = ${JSON.stringify(mode)}, tmpRoot = dir + "/tmp";
await Deno.mkdir(tmpRoot);
const owner = "00000000-0000-4000-8000-0000000000a1", thread = "00000000-0000-4000-8000-0000000000b1";
const other = "00000000-0000-4000-8000-0000000000c1";
const urls = mode.startsWith("multi") || mode === "ready" ? ["https://jobs.example.test/one", "https://jobs.example.test/two"] : ["https://jobs.example.test/one"];
const bytes = new TextEncoder().encode("%PDF-1.4 SYNTHETIC QA RESUME");
const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(n => n.toString(16).padStart(2, "0")).join("");
const resume = { filename: "QA Person Resume.pdf", sha256: sha, b64: btoa(String.fromCharCode(...bytes)) };
const field = (name: string, label: string, type = "input_text", required = true) => ({ name, label, type, required, options: [] });
const base = [field("name", "Full name"), field("email", "Email"), field("phone", "Phone"),
  field("resume", "Resume", "input_file"), field("yes", "I agree to receive hiring updates", "checkbox"),
  field("no", "I consent to receive marketing emails", "checkbox", false), field("blank", "Favorite commuting snack", "input_text", false)];
const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const row = (n: number, key: string, answer: string, user = owner) => ({ id: id(n), user_id: user, state: "answered", kind: "fact", key, answer });
const profile = { user_id: owner, facts: [{ id: "QA-PHONE", kind: "other", text: "My phone number is (555) 010-0199",
  source: "user", status: "confirmed", needs_confirmation: false, provenance: "owner confirmed exact synthetic phone in chat",
  confirmation_event_id: "QA-PHONE-EVENT" }, { id: "QA-UNCONFIRMED", kind: "other", text: "My email is invented@example.test",
  source: "assistant", status: "unconfirmed", needs_confirmation: true }] };
const rows = [row(1, "fact:full_name", "QA Person"), row(2, "fact:email", "qa.person@example.test"),
  row(3, answerKey(base[4], "QA-ONE"), "Yes"), row(4, answerKey(base[5], "QA-ONE"), "No"),
  row(5, "fact:email", "another.person@example.test", other),
  { ...row(6, "fact:email", "unanswered@example.test"), state: "open" }];
if (mode === "no_invention") rows.splice(1, 1);
const snapshot: any = { user_id: owner, profile, rows };
snapshot.digest = await hashApplyPayload({ user_id: owner, profile, rows });
if (mode === "source_owner") snapshot.user_id = other;
if (mode === "source_digest") snapshot.digest = "0".repeat(64);
const calls: any[] = [], runs: any[] = [], cardItems: any[] = [];
let error: string | null = null, result: any = null;
const rpc = async (name: string, body: any) => {
  calls.push({ name, body: structuredClone(body) });
  if (name === "career_apply_message_cloud_prepare_context") {
    if (mode === "context_denied") throw Error("SYNTHETIC_CONTEXT_DISALLOWED");
    return { resume, account: { epoch: 2, version: 3 } };
  }
  if (name === "career_apply_message_cloud_sources") return structuredClone(snapshot);
  if (name === "career_apply_message_cloud_prepare_questions_as") return body.p_questions.length;
  if (name === "career_apply_message_cloud_card_show_as") {
    cardItems.push(...structuredClone(body.p_items));
    const payload = { version: 2, user_id: owner, thread_id: thread, execution_mode: "cloud", items: body.p_items };
    return { id: "SYNTHETIC-CARD-RECEIPT", payload, hash: await hashApplyPayload(payload) };
  }
  throw Error("UNEXPECTED_RPC:" + name);
};
const runEngine = async (args: string[]) => {
  const get = (flag: string) => args[args.indexOf(flag) + 1];
  if (args.includes("--submit")) throw Error("QA_DRY_RUN_ONLY");
  const url = get("--url"), factsPath = get("--facts"), resumePath = get("--resume");
  const facts = JSON.parse(await Deno.readTextFile(factsPath));
  const m = trustedManifest({ owner, file: facts, rows: facts.text_answers, resume: { sha256: sha } });
  const schema = structuredClone(base), posting = url.endsWith("/one") ? "QA-ONE" : "QA-TWO";
  if (mode === "missing" || (mode === "multi_missing" && posting === "QA-TWO") ||
    (mode === "multi_missing_first" && posting === "QA-ONE")) schema.push(field("missing", "What is your favorite programming language?"));
  const plan = planForm({ userId: owner, jobId: posting, company: "QA Employer", family: "lever", schema, answers: m.answers, saved: m.saved, now: 0 });
  const contract = contractFill({ schema, plan, manifest: m, resume, jobId: posting });
  runs.push({ args, facts, kept: m.answers, saved: m.saved, plan, contract, factsPath, resumePath,
    fileMode: (await Deno.stat(factsPath)).mode! & 0o777, resumeMode: (await Deno.stat(resumePath)).mode! & 0o777,
    dirMode: (await Deno.stat(factsPath.slice(0, factsPath.lastIndexOf("/")))).mode! & 0o777 });
  if (mode === "engine_error") throw Error("SYNTHETIC_DRY_ENGINE_ERROR");
  if (mode === "refusal") return { result: { state: "not_submitted", reason: "SYNTHETIC_REFUSAL" }, evidence: null };
  const questions = [...plan.needs, ...contract.asks];
  if (questions.length) return { result: { state: "not_submitted", reason: "needs_answers", posting, company: "QA Employer", questions }, evidence: null };
  const fields = contract.fill, destination = url + "/submit", schemaHash = await hashApplyPayload(schema);
  const readback = Object.fromEntries(fields.map((f: any) => [f.name, f.name === "yes" ? true : f.name === "no" ? false : f.name === "resume" ? "INTERNAL_FILE_TOKEN" : f.value]));
  const approval = await applicationApprovalHash({ userId: owner, posting, destination, fields, resumeSha256: sha,
    // The engine binds the employer's hidden values too (x-audit, 20261110170000), as scripts/apply.ts computes it.
    schemaHash, pageFieldNames: ["employer_hidden"], pageFieldValues: { employer_hidden: "SYNTHETIC_EMPLOYER_VALUE" }, manifest: m });
  return { result: { state: "not_submitted", reason: "dry_run" }, evidence: {
    fields, schema, readback, approval_hash: approval, sources: m.byFactId, replay_sources: Object.values(m.byFactId),
    trust: { quarantine_version: m.version, manifest_hash: m.hash },
    payload: { user_id: owner, posting, company: "QA Employer", destination, resume, schema_hash: schemaHash,
      page_fields: { employer_hidden: "SYNTHETIC_EMPLOYER_VALUE" } } } };
};
try { result = await prepareCloudCard({ owner, thread, urls, resumeSha256: sha }, { rpc, runEngine, tmpRoot, now: () => 1800000000000 }); }
catch (e) { error = String(e?.code || e?.message || e); }
const pathsLeft = [];
for (const r of runs) for (const p of [r.factsPath, r.resumePath]) try { await Deno.stat(p); pathsLeft.push(p); } catch { /* cleaned */ }
console.log("QA " + JSON.stringify({ mode, owner, thread, sha, result, error, calls, runs, cardItems,
  tempLeft: [...Deno.readDirSync(tmpRoot)].map(e => e.name), pathsLeft }));
`;

async function drive(mode) {
  const dir = fs.mkdtempSync(path.join(root, mode + "-")), driver = path.join(dir, "driver.ts");
  fs.writeFileSync(driver, driverSource(dir, mode));
  const r = await new Promise((resolve, reject) => {
    const p = spawn(process.env.DENO_BIN || "deno", ["run", "-A", "--deny-net", "--cached-only", "--no-check", driver], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", b => { out += b; }); p.stderr.on("data", b => { err += b; });
    const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
    p.once("error", e => { clearTimeout(timer); reject(e); });
    p.once("close", code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  assert.equal(r.code, 0, r.out + r.err);
  const line = r.out.split("\n").find(l => l.startsWith("QA "));
  assert.ok(line, r.out + r.err);
  const done = JSON.parse(line.slice(3)); measured.push(done); return done;
}
const asks = r => r.calls.filter(c => c.name === "career_apply_message_cloud_prepare_questions_as");
const cards = r => r.calls.filter(c => c.name === "career_apply_message_cloud_card_show_as");
const clean = r => { assert.deepEqual(r.tempLeft, []); assert.deepEqual(r.pathsLeft, []); };
const qa = (name, fn) => test(name, { skip: control }, fn);

test("entrypoint availability control is explicitly classified, never a missing-file behavioral red", () => {
  measured.push({ entrypointControl: available ? "AVAILABLE" : "NOT_AVAILABLE_BASELINE" });
  assert.equal(typeof available, "boolean");
});

qa("missing answer becomes an owned question RPC and creates no card", async () => {
  const r = await drive("missing");
  assert.equal(r.error, null); assert.equal(r.result.reason, "needs_answers"); assert.equal(r.result.ready, false);
  assert.equal(cards(r).length, 0); assert.equal(asks(r).length, 1);
  assert.equal(asks(r)[0].body.p_user, r.owner); assert.equal(asks(r)[0].body.p_job_id, "QA-ONE");
  assert.deepEqual(asks(r)[0].body.p_questions.map(q => q.label), ["What is your favorite programming language?"]);
  assert.ok(asks(r)[0].body.p_questions.every(q => !Object.hasOwn(q, "answer")));
  clean(r);
});

for (const [mode, readyIndex, askedJob] of [["multi_missing", 0, "QA-TWO"], ["multi_missing_first", 1, "QA-ONE"]])
qa("multi-item missing answer is all-or-nothing: " + mode, async () => {
  const r = await drive(mode);
  assert.equal(r.error, null); assert.equal(r.runs.length, 2); assert.equal(r.runs[readyIndex].plan.needs.length, 0);
  assert.equal(r.result.ready, false); assert.equal(r.result.reason, "needs_answers"); assert.equal(cards(r).length, 0);
  assert.deepEqual(asks(r).map(c => [c.body.p_user, c.body.p_job_id]), [[r.owner, askedJob]]); clean(r);
});

qa("all ready produces exact payload/readback pairs from owned facts, including boolean display and resume name", async () => {
  const r = await drive("ready");
  assert.equal(r.error, null); assert.equal(r.result.ready, true); assert.equal(asks(r).length, 0); assert.equal(cards(r).length, 1);
  assert.equal(r.cardItems.length, 2); assert.equal(cards(r)[0].body.p_user, r.owner); assert.equal(cards(r)[0].body.p_thread, r.thread);
  for (const item of r.cardItems) {
    const p = item.payload, readback = item.readback;
    assert.match(item.hash, /^[a-f0-9]{64}$/); assert.equal(p.user_id, r.owner);
    assert.deepEqual(readback.answers.map(a => Object.keys(a).sort()), p.fields.map(() => ["factId", "label", "name", "shown", "value"]));
    assert.deepEqual(readback.answers.map(({ name, label, value, factId }) => ({ name, label, value, factId })),
      p.fields.map(({ name, label, value, factId }) => ({ name, label, value, factId })));
    const byName = Object.fromEntries(readback.answers.map(a => [a.name, a]));
    assert.equal(byName.name.value, "QA Person"); assert.equal(byName.email.value, "qa.person@example.test");
    assert.equal(byName.name.factId, "text-answer:00000000-0000-4000-8000-000000000001");
    assert.equal(byName.email.factId, "text-answer:00000000-0000-4000-8000-000000000002");
    assert.equal(byName.yes.value, "Yes"); assert.equal(byName.no.value, "No");
    assert.equal(byName.phone.factId, "QA-PHONE"); assert.equal(byName.yes.shown, "Yes (checked)");
    assert.equal(byName.no.shown, "No (left unchecked)"); assert.equal(byName.resume.shown, "QA Person Resume.pdf");
    assert.equal(byName.resume.factId, "approved-local-resume:" + r.sha);
    assert.equal(readback.resume_name, "QA Person Resume.pdf"); assert.equal(readback.resume_sha256, r.sha);
    assert.equal(readback.destination, p.destination); assert.deepEqual(readback.employer_fields, ["employer_hidden"]);
    assert.deepEqual(readback.blank, ["Favorite commuting snack"]);
    assert.ok(!JSON.stringify(readback).includes("INTERNAL_FILE_TOKEN"));
  }
  for (const run of r.runs) { assert.equal(run.fileMode, 0o600); assert.equal(run.resumeMode, 0o600); assert.equal(run.dirMode, 0o700); }
  clean(r);
});

qa("disallowed context invokes zero engines and creates no question or card", async () => {
  const r = await drive("context_denied");
  assert.equal(r.error, "SYNTHETIC_CONTEXT_DISALLOWED"); assert.equal(r.runs.length, 0);
  assert.deepEqual(r.calls.map(c => c.name), ["career_apply_message_cloud_prepare_context"]); clean(r);
});

for (const mode of ["source_owner", "source_digest"]) qa("source tamper refuses before engine or card: " + mode, async () => {
  const r = await drive(mode);
  assert.equal(r.error, "CARD_CLOUD_SOURCE_READ_FAILED"); assert.equal(r.runs.length, 0); assert.equal(cards(r).length, 0); clean(r);
});

for (const mode of ["refusal", "engine_error"]) qa("temporary facts and resume are removed after " + mode, async () => {
  const r = await drive(mode); assert.equal(r.runs.length, 1); assert.equal(cards(r).length, 0);
  if (mode === "refusal") { assert.equal(r.error, null); assert.equal(r.result.reason, "PREPARATION_REFUSED"); }
  else assert.equal(r.error, "SYNTHETIC_DRY_ENGINE_ERROR");
  clean(r);
});

qa("unconfirmed, unanswered and another person's email never invent the missing owned answer", async () => {
  const r = await drive("no_invention");
  assert.equal(r.error, null); assert.equal(r.result.reason, "needs_answers"); assert.equal(cards(r).length, 0);
  assert.equal(r.runs[0].kept.email, undefined);
  assert.ok(!r.runs[0].facts.text_answers.some(row => row.answer === "another.person@example.test" || row.answer === "unanswered@example.test"));
  assert.deepEqual(asks(r)[0].body.p_questions.map(q => q.label), ["Email"]); clean(r);
});
