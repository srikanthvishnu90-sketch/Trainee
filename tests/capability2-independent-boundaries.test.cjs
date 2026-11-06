"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const R = require("../packages/domain/154-career-recommendations.js");
const P = require("../packages/domain/122-career-profile.js");
const { CareerHost } = require("../supabase/functions/_shared/career_host.js");
const D = path.join(__dirname, "fixtures/capability2-independent");
const manifest = JSON.parse(fs.readFileSync(path.join(D, "INDEPENDENT_CAPABILITY2_HOLDOUTS_v1.json")));
const host = CareerHost.createCareerHost(Object.fromEntries([["CareerAccess", "120-career-access.js"], ["CareerOnboarding", "130-career-onboarding.js"], ["CareerRouter", "142-career-router.js"], ["CareerDoorstep", "141-career-doorstep.js"], ["CareerReply", "140-career-reply.js"], ["CareerContainment", "143-career-containment.js"]].map(([k, f]) => [k, require("../packages/domain/" + f)])));
const now = Date.parse(manifest.now), copy = (v) => structuredClone(v), fact = (text, over = {}) => ({ id: "BOUNDARY-1", kind: "experience", text, status: "confirmed", ...over });
const base = manifest.cases.find((c) => c.id === "H16");
const outputs = [];
test.after(() => { if (process.env.CAPABILITY2_EVIDENCE_DIR) { fs.mkdirSync(process.env.CAPABILITY2_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.CAPABILITY2_EVIDENCE_DIR, "followup-boundary-evidence.json"), JSON.stringify(outputs, null, 2)); } });

test("independent manifest and runner bytes match their Library freeze", () => {
  const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(path.join(D, p))).digest("hex");
  assert.equal(hash("INDEPENDENT_CAPABILITY2_HOLDOUTS_v1.json"), "3b4ef7727ef295f9b196e8c8e5fbaccbf44dd4f08d2f0189a00757f848490857");
  const frozen = JSON.parse(fs.readFileSync(path.join(D, "freeze-metadata.json")));
  assert.equal(hash("run_independent_holdouts.cjs"), frozen.runner_sha256);
});
for (const c of manifest.cases) test(`${c.id} frozen: ${c.rule}`, { skip: c.kind === "cross_owner_correction" ? "H20 needs the atomic host; the frozen runner checks it (the test below)" : false }, () => {
  const profile = copy(c.profile || {}); let out;
  if (["evidence_not_present", "evidence_present"].includes(c.kind)) {
    out = R.evidence(profile, c.skill);
    c.kind === "evidence_present" ? assert.equal(out.status, "evidence_present") : assert.notEqual(out.status, "evidence_present");
  } else if (c.kind === "legacy_ingest_id") {
    const before = JSON.stringify(profile); out = R.ingestResume({ profile, now }, c.resume);
    assert.equal(JSON.stringify(profile), before);
    assert.ok(R.planPaths({ profile: out.profile }).factIds.includes("LEGACY-STABLE-901"));
  } else if (["no_openings", "one_opening"].includes(c.kind)) {
    out = R.planPaths({ profile, postings: copy(c.postings), now }).currentOpenings;
    assert.equal(out.openings.length, c.kind === "one_opening" ? 1 : 0);
  } else if (c.kind === "freshness_false") {
    out = R.freshness(c.posting, now); assert.equal(out.current, false);
  } else if (["named_skill_route", "budget_route", "posting_requirement_route"].includes(c.kind)) {
    const ctx = host.createTurnCtx({ userId: "boundary-owner", threadId: "boundary-thread", profile, now });
    if (c.posting) ctx.posting = copy(c.posting);
    const result = host.runTurn(c.message, ctx); assert.equal(result.contained, false); out = result.result.artifact;
    if (c.kind === "budget_route") assert.equal(out.totalMinutesPerWeek, c.expected_minutes);
    else assert.ok(out.gaps.some((g) => g.skill.toLowerCase() === c.skill.toLowerCase()));
  } else if (c.kind === "inplace_correction") {
    P.updateFact(profile, c.fact_id, { text: c.corrected_text }); out = R.evidence(profile, c.skill); assert.notEqual(out.status, "evidence_present");
  } else throw Error(c.kind);
  outputs.push({ id: c.id, input: c, out });
});
const expectedCoverage = { D01: ["mechanical-design", "CAD"], D02: ["electrical-trades", "circuit installation"], D03: ["teaching", "learning assessment"], D04: ["graphic-design", "vector illustration"] };
for (const c of manifest.coverage_observations) test(`${c.id}: distinct grounded ${c.label} hypotheses and honest gaps`, () => {
  const out = R.planPaths({ profile: copy(c.profile), now }), [role, skill] = expectedCoverage[c.id];
  assert.ok(out.paths.some((p) => p.id === role && p.evidenceLevel === "record_signal"));
  assert.ok(out.paths.every((p) => p.evidenceLevel === "record_signal"));
  const gaps = out.paths.flatMap((p) => p.gaps);
  assert.ok(gaps.some((g) => g.skill === skill && g.status === "evidence_present"));
  assert.ok(gaps.some((g) => g.status === "not_evidenced"), "unknown task evidence remains a gap, not an invented credential");
  assert.ok(out.paths.every((p) => /check|confirm|verify/.test(p.tradeoffs)));
  assert.equal(out.deterministicVerdict, null);
  outputs.push({ id: c.id, input: c, out });
});
for (const text of ["Scheduled interviews for Python engineers", "Scheduled interviews with Python engineers", "Recruited Python developers", "Hired engineers using Python", "Reviewed notes about Python", "Built a hiring pipeline for Python engineers", "I have zero Python experience", "I haven't used Python", "I have never used Python", "I cannot program Python", "I don't know Python", "Learning Python", "I lack Python experience", "Without Python experience"]) test(`relation negative or mention: ${text}`, () => {
  assert.notEqual(R.evidence({ facts: [fact(text)] }, "Python").status, "evidence_present");
});
for (const text of ["Built Python scripts", "Used Python to validate records", "Implemented a Python parser", "Developed services using Python", "Wrote a Python script with tests"]) test(`relation positive: ${text}`, () => {
  const out = R.evidence({ facts: [fact(text, { artifact_hash: "synthetic-source-hash" })] }, "Python");
  assert.equal(out.status, "evidence_present");
  const link = out.supportingRelations[0]; assert.equal(link.quote, text); assert.equal(link.relation, "performed_work");
  assert.equal(link.artifact_hash, "synthetic-source-hash"); assert.equal(text.slice(link.start, link.end), link.quote);
});
test("scheduling morphology is real work even when programmers are interviewees", () => {
  const p = { facts: [fact("Scheduled interviews for Python engineers and maintained the hiring calendar")] };
  assert.equal(R.evidence(p, "scheduling").status, "evidence_present");
  assert.ok(R.roleHypotheses({ profile: p }).every((r) => r.id !== "software-engineering"));
});
test("conflicts are explicit and independent of input order; only confirmed supersession resolves them", () => {
  const positive = fact("Built Python scripts", { id: "OLD" }), negative = fact("I have zero Python experience", { id: "NEW" });
  for (const facts of [[positive, negative], [negative, positive]]) {
    const out = R.evidence({ facts }, "Python"); assert.equal(out.status, "conflicted"); assert.ok(out.factIds.includes("NEW")); assert.deepEqual(out.supportingRelations, []);
  }
  assert.equal(R.evidence({ facts: [positive, { ...negative, status: "draft", supersedes: ["OLD"] }] }, "Python").status, "evidence_present");
  assert.notEqual(R.evidence({ facts: [positive, { ...negative, supersedes: ["OLD"] }] }, "Python").status, "evidence_present");
  assert.equal(R.evidence({ facts: [negative, { ...positive, supersedes: ["NEW"] }] }, "Python").status, "evidence_present");
});
for (const ordered of [false, true]) test(`newest closed observation suppresses old open; reversed=${ordered}`, () => {
  const open = copy(base.postings[0]), closed = { ...open, status: "closed", observed_at: "2026-10-15T11:59:00Z" };
  const out = R.planPaths({ profile: copy(base.profile), now, postings: ordered ? [closed, open] : [open, closed] });
  assert.equal(out.currentOpenings.openings.length, 0);
  assert.ok(out.currentOpenings.excluded.some((x) => x.reason === "superseded_observation"));
});
test("same-time closed tombstone wins, latest rows do not borrow old geography or requirements", () => {
  const old = copy(base.postings[0]);
  assert.equal(R.planPaths({ profile: base.profile, now, postings: [old, { ...old, status: "closed" }] }).currentOpenings.openings.length, 0);
  assert.equal(R.planPaths({ profile: base.profile, now, postings: [old, { ...old, observed_at: "2026-10-15T11:59:00Z", location: "" }] }).currentOpenings.openings.length, 0);
});
for (const url of ["https://example.org/x", "https://jobs.example.org/x", "https://EXAMPLE.NET/x", "https://careers.example.com/x", "https://localhost/x", "https://jobs.demo.test/x"]) test(`reserved example source: ${url}`, () => {
  assert.equal(R.freshness({ ...base.postings[0], source_url: url }, now).current, false);
});
for (const [message, minutes] of [["What SQL skill gaps should I close? I can spend one hour per week.", 60], ["What Rust skill gaps should I close? 90 minutes a week.", 90], ["What CAD skill gaps should I close? two hours weekly.", 120], ["What legal research skill gaps should I close? half an hour per week.", 30]]) test(`query retains target and budget: ${message}`, () => {
  const out = host.runTurn(message, host.createTurnCtx({ profile: copy(base.profile), userId: "query-owner", now }));
  assert.equal(out.contained, false); assert.equal(out.result.artifact.totalMinutesPerWeek, minutes);
  assert.equal(out.result.artifact.phases.reduce((a, p) => a + p.minutes, 0), minutes);
  assert.ok(out.result.artifact.query.typed.skill);
  assert.ok(out.result.artifact.grounding.schema_version === 1);
});
for (const message of ["What SQL and Excel skill gaps should I close?", "What SQL skill gaps should I close? one hour per week or two hours weekly.", "What SQL skill gaps should I close? zero hours per week."]) test(`ambiguous query asks instead of substituting: ${message}`, () => {
  const out = host.runTurn(message, host.createTurnCtx({ profile: copy(base.profile), userId: "query-owner", now }));
  assert.equal(out.resultStatus, "awaiting_user"); assert.match(out.reply, /Which single skill/); assert.ok(out.result.artifact.query.ambiguities.length);
});
test("legacy canonical identity and source references survive ingestion without changing the input", () => {
  const profile = { facts: [fact("Used Excel to validate records", { id: undefined, fact_id: "LEGACY-EXACT", evidence: ["LEGACY-EXACT"], source_hash: "HASH" })], _ownerMetadata: { revision: 4 } }, before = JSON.stringify(profile);
  const out = R.ingestResume({ profile, now }, "EXPERIENCE\nAssistant\n- Maintained records\n");
  assert.equal(JSON.stringify(profile), before); assert.equal(out.profile.facts[0].id, "LEGACY-EXACT"); assert.equal(out.profile.facts[0].source_hash, "HASH"); assert.equal(out.profile.facts[0].evidence[0], "LEGACY-EXACT");
  assert.deepEqual(out.profile._ownerMetadata, profile._ownerMetadata);
  assert.equal(R.ingestResume({ profile: { facts: [fact("x", { id: undefined })] } }, "EXPERIENCE\nAssistant").code, "canonical_id_required");
});
test("specific SQL gap request retains priority when framed as resume advice", () => {
  const out = host.runTurn("Based on my resume, recommend SQL skill gaps. What SQL skill gaps should I close? one hour per week.", host.createTurnCtx({ profile: copy(base.profile), userId: "query-owner", now }));
  assert.equal(out.result.artifact.kind, "skill_gap_plan"); assert.equal(out.result.artifact.totalMinutesPerWeek, 60); assert.ok(out.result.artifact.gaps.some((g) => g.skill === "SQL"));
});
test("requisition numeric/string aliases coalesce and placeholder geography stays unknown", () => {
  const open = { ...copy(base.postings[0]), id: 42 }, closed = { ...open, id: "42", status: "closed", observed_at: "2026-10-15T11:59:00Z" };
  assert.equal(R.planPaths({ profile: base.profile, now, postings: [open, closed] }).currentOpenings.openings.length, 0);
  assert.equal(R.planPaths({ profile: { ...base.profile, preferences: {} }, now, postings: [{ ...open, mode: "remote", location: "Remote - location unspecified" }] }).currentOpenings.openings.length, 0);
  assert.equal(R.freshness({ ...open, source_url: "https://jobs.example.org./42" }, now).current, false);
});
test("typed grounding retains canonical revision/epoch and original quote without inventing a hash", () => {
  const out = R.recommend({ recommendationIntent: "skill_gaps", skill: "Excel", profile: copy(base.profile), profile_revision: 7, privacy_epoch: 3 });
  assert.equal(out.grounding.profile_revision, 7); assert.equal(out.grounding.privacy_epoch, 3);
  assert.ok(out.grounding.supporting_relations.some((r) => r.fact_id === "I-OPS"));
  assert.ok(out.grounding.supporting_relations.every((r) => r.artifact_hash === null && r.quote));
});
// WO-081 port: H20 (a correction never crosses owners who share a default profile id) failed on the branch because
// module 130 kept a process-wide correction store. Trunk removed it (WO-067), so the original frozen runner, bytes
// unchanged, now passes every probe, H20 included; this keeps it that way.
test("the original frozen runner passes all 22 probes, H20 included", () => {
  const { spawnSync } = require("node:child_process"), os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-frozen-"));
  try {
    const run = spawnSync(process.execPath, [path.join(__dirname, "../scripts/career/run-capability2-frozen.cjs"), "--evidence-dir", dir], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual([out.pass, out.fail, out.failures], [22, 0, []]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
