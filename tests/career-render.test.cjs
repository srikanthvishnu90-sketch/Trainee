/* CA-02 — resume document rendering + parse-check (Spec 3 v2 §10.4, §2.5,
   render rules R1–R11). FAIL-FIRST: written before 148-career-render.js
   existed; every test here failed on the pre-CA-02 tree (123 render()
   returned pdf:null and no DOCX at all).
   Fixtures are the synthetic TEST personas only. External cross-checks use
   poppler (pdftotext/pdfinfo) and python-docx — the two independent
   open-source parsers of Spec 3 §2.5 — and skip cleanly when absent. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const Profile = require("../packages/domain/122-career-profile.js");
const Tailor = require("../packages/domain/123-career-tailor.js");
const Render = require("../packages/domain/148-career-render.js");

const fixtureDir = path.join(__dirname, "..", "packages", "career-data", "fixtures");
const loadPersona = () => Profile.profileFromData(JSON.parse(fs.readFileSync(path.join(fixtureDir, "test-persona.json"), "utf8")));

const SWE_JD = `Software Engineer, New Grad (TEST posting)
Required: Python, JavaScript, React, SQL, PostgreSQL, Git.
Nice to have: Kubernetes, Docker, AWS.
You will build APIs and deploy services.`;
const IB_JD = `Investment Banking Summer Analyst (TEST posting)
Required: Excel, Financial Modeling, Valuation.
Nice to have: Bloomberg.
You will build DCF models and support deal teams.`;

const norm = (s) => String(s || "").replace(/•/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const normSeq = (lines) => lines.map(norm).filter(Boolean);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hasBin = (bin) => { try { execFileSync("which", [bin], { stdio: "pipe" }); return true; } catch { return false; } };
const hasPythonDocx = () => { try { execFileSync("python3", ["-c", "import docx"], { stdio: "pipe" }); return true; } catch { return false; } };

function tailoredSwe() {
  const r = Tailor.tailorResume(loadPersona(), SWE_JD, { jobId: "TEST-JOB-1", date: "2026-10-12" });
  assert.equal(r.ok, true, JSON.stringify(r.violations || []));
  return r;
}

// ---------- artifacts are real files (bytes verified, not asserted) ----------

test("PDF artifact: real PDF bytes, <1MB, R8 filename, opens in pdfinfo", { skip: hasBin("pdfinfo") ? false : "pdfinfo (poppler) not available" }, () => {
  const r = tailoredSwe();
  const pdf = r.rendered.pdf;
  assert.ok(pdf, "rendered.pdf must be an artifact, not null");
  const buf = Buffer.from(pdf.base64, "base64");
  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(buf.subarray(buf.length - 32).toString("latin1").includes("%%EOF"));
  assert.equal(pdf.bytes, buf.length);
  assert.equal(pdf.sha256, sha(buf));
  assert.ok(buf.length < 1_000_000, `R8: file under 1MB (got ${buf.length})`);
  assert.equal(pdf.filename, "Alex_Testcase_Resume.pdf"); // R8: FirstName_LastName_Resume.pdf
  const tmp = path.join(require("node:os").tmpdir(), `ca02-${process.pid}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const info = execFileSync("pdfinfo", [tmp], { encoding: "utf8" });
    assert.match(info, /Pages:\s*[1-9]/);
    assert.match(info, /Page size:\s*612 x 792/); // US Letter
  } finally { fs.unlinkSync(tmp); }
});

test("DOCX artifact: real OOXML zip, <1MB, R8 filename, opens in python-docx", { skip: hasPythonDocx() ? false : "python-docx not available" }, () => {
  const r = tailoredSwe();
  const docx = r.rendered.docx;
  assert.ok(docx, "rendered.docx must be an artifact, not null");
  const buf = Buffer.from(docx.base64, "base64");
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  assert.equal(docx.bytes, buf.length);
  assert.equal(docx.sha256, sha(buf));
  assert.ok(buf.length < 1_000_000, `R8: file under 1MB (got ${buf.length})`);
  assert.equal(docx.filename, "Alex_Testcase_Resume.docx");
  const tmp = path.join(require("node:os").tmpdir(), `ca02-${process.pid}.docx`);
  fs.writeFileSync(tmp, buf);
  try {
    const out = execFileSync("python3", ["-c", "import docx,sys; d=docx.Document(sys.argv[1]); print('\\n'.join(p.text for p in d.paragraphs))", tmp], { encoding: "utf8" });
    assert.ok(norm(out).includes("alex testcase"), "python-docx reads the name back");
    assert.ok(norm(out).includes("experience"), "python-docx reads a section heading back");
  } finally { fs.unlinkSync(tmp); }
});

test("determinism: same resume JSON renders byte-identical PDF and DOCX (Spec 3 §10.5 snapshot reproducibility)", () => {
  const r = tailoredSwe();
  const a = Render.renderPdf(r.resume), b = Render.renderPdf(r.resume);
  const c = Render.renderDocx(r.resume), d = Render.renderDocx(r.resume);
  assert.equal(sha(a.buffer), sha(b.buffer));
  assert.equal(sha(c.buffer), sha(d.buffer));
});

test("no content invention: every rendered line traces to the fact bank via the source JSON", () => {
  const r = tailoredSwe();
  // PDF ground truth is the renderer's deterministic layout lines (the
  // source JSON word-wrapped); the DOCX truth is the logical source lines.
  // Both derive from the same JSON — extraction must match byte-derived
  // text exactly, line for line, with nothing added and nothing lost.
  const pdfBuf = Buffer.from(r.rendered.pdf.base64, "base64");
  const docxBuf = Buffer.from(r.rendered.docx.base64, "base64");
  assert.deepEqual(normSeq(Render.extractPdfLines(pdfBuf)), normSeq(Render.layoutLines(r.resume).map((l) => l.text)));
  assert.deepEqual(normSeq(Render.extractDocxLines(docxBuf)), normSeq(Render.sourceLines(r.resume).map((l) => l.text)));
  // fact IDs are audit metadata — they must never appear inside the documents
  for (const art of [r.rendered.pdf, r.rendered.docx]) {
    const text = Buffer.from(art.base64, "base64").toString("latin1");
    assert.ok(!/F-0\d\d/.test(text), `${art.filename} leaks a fact ID`);
  }
});

// ---------- R1–R11, one fail-first test per rule ----------

test("R1 single column, no layout tables, no text boxes/frames", () => {
  const r = tailoredSwe();
  const pc = Render.parseCheck({ resume: r.resume, pdf: Buffer.from(r.rendered.pdf.base64, "base64"), docx: Buffer.from(r.rendered.docx.base64, "base64") });
  assert.equal(pc.checks.docx.tables, 0);
  assert.equal(pc.checks.docx.textFrames, 0);
  assert.equal(pc.checks.pdf.singleColumn, true);
  const docXml = Render.docxPart(Buffer.from(r.rendered.docx.base64, "base64"), "word/document.xml").toString("utf8");
  assert.ok(!docXml.includes("<w:tbl") && !docXml.includes("txbxContent") && !docXml.includes("<w:cols"));
});

test("R2 real text, never an image: both independent parsers recover the full text; zero images", () => {
  const r = tailoredSwe();
  const pdfBuf = Buffer.from(r.rendered.pdf.base64, "base64");
  const layout = normSeq(Render.layoutLines(r.resume).map((l) => l.text));
  assert.deepEqual(normSeq(Render.extractPdfLines(pdfBuf)), layout); // parser A: content-stream operators
  const scanned = normSeq(Render.extractPdfStrings(pdfBuf)); // parser B: raw string scan
  for (const line of layout) assert.ok(scanned.includes(line), `parser B missed: ${line}`);
  const pc = Render.parseCheck({ resume: r.resume, pdf: pdfBuf, docx: Buffer.from(r.rendered.docx.base64, "base64") });
  assert.equal(pc.checks.pdf.images, 0);
  assert.equal(pc.checks.docx.images, 0);
});

test("R3 standard headings only (allowlist), same headings in both formats", () => {
  const r = tailoredSwe();
  const pc = Render.parseCheck({ resume: r.resume, pdf: Buffer.from(r.rendered.pdf.base64, "base64"), docx: Buffer.from(r.rendered.docx.base64, "base64") });
  const ALLOW = ["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS", "LEADERSHIP"];
  assert.ok(pc.checks.pdf.headings.every((h) => ALLOW.includes(h)), JSON.stringify(pc.checks.pdf.headings));
  assert.deepEqual(pc.checks.docx.headings, pc.checks.pdf.headings);
  assert.ok(!pc.reasons.some((x) => x.check === "heading_allowlist"));
});

test("R4 contact info in the body, not header/footer", () => {
  const r = tailoredSwe();
  const email = "alex.testcase@example.test";
  const pdfLines = normSeq(Render.extractPdfLines(Buffer.from(r.rendered.pdf.base64, "base64")));
  const docxLines = normSeq(Render.extractDocxLines(Buffer.from(r.rendered.docx.base64, "base64")));
  assert.ok(pdfLines.slice(0, 3).some((l) => l.includes(email)), "email in the PDF body head");
  assert.ok(docxLines.slice(0, 3).some((l) => l.includes(email)), "email in the DOCX body head");
  assert.equal(pdfLines.filter((l) => l.includes(email)).length, 1, "contact appears once — no running footer/header repeat");
  const parts = Render.docxPartNames(Buffer.from(r.rendered.docx.base64, "base64"));
  assert.ok(!parts.some((p) => /header|footer/.test(p)), "DOCX has no header/footer parts at all");
});

test("R5 plain bullet glyphs only — no icons, emoji, or dingbats in either document", () => {
  const r = tailoredSwe();
  for (const art of [r.rendered.pdf, r.rendered.docx]) {
    const lines = art.format === "pdf" ? Render.extractPdfLines(Buffer.from(art.base64, "base64")) : Render.extractDocxLines(Buffer.from(art.base64, "base64"));
    const bullets = Render.sourceLines(r.resume).filter((l) => l.kind === "bullet");
    const rawBullets = lines.filter((l) => l.trim().startsWith("•"));
    assert.equal(rawBullets.length, bullets.length, `${art.format}: every bullet carries the plain glyph`);
    const all = lines.join("\n");
    assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}✓★☆✔]/u.test(all), `${art.format}: no emoji/dingbat characters`);
  }
});

test("R6 standard fonts, 10–12pt only, in both formats", () => {
  const r = tailoredSwe();
  const pc = Render.parseCheck({ resume: r.resume, pdf: Buffer.from(r.rendered.pdf.base64, "base64"), docx: Buffer.from(r.rendered.docx.base64, "base64") });
  assert.ok(pc.checks.pdf.fonts.every((f) => ["Helvetica", "Helvetica-Bold"].includes(f)), JSON.stringify(pc.checks.pdf.fonts));
  // R6 scoped (release 10, architect ruling 2026-11-08): body and headings 10-12 pt; the name line 10-18 pt.
  assert.ok(pc.checks.pdf.bodySizesPt.every((s) => s >= 10 && s <= 12), JSON.stringify(pc.checks.pdf.bodySizesPt));
  assert.ok(pc.checks.pdf.nameSizesPt.every((s) => s >= 10 && s <= 18), JSON.stringify(pc.checks.pdf.nameSizesPt));
  assert.ok(pc.checks.docx.fonts.every((f) => ["Calibri", "Arial", "Georgia", "Times New Roman", "Cambria", "Helvetica"].includes(f)), JSON.stringify(pc.checks.docx.fonts));
  assert.ok(pc.checks.docx.bodySizesPt.every((s) => s >= 10 && s <= 12), JSON.stringify(pc.checks.docx.bodySizesPt));
  assert.ok(pc.checks.docx.nameSizesPt.every((s) => s >= 10 && s <= 18), JSON.stringify(pc.checks.docx.nameSizesPt));
});

test("R7 one date format: 'Mon YYYY' is clean; numeric/mixed date formats make the parse-check WARN", () => {
  const clean = { header: { name: "Casey Clean", email: "casey@example.test", location: "Chicago, IL" }, sections: [{ heading: "Experience", lines: [{ text: "Analyst, Globex Corporation Inc.", type: "entry" }, { text: "Built models from Jan 2024 - Mar 2025 for the team", type: "bullet" }] }] };
  const pcClean = Render.parseCheck({ resume: clean, pdf: Render.renderPdf(clean).buffer, docx: Render.renderDocx(clean).buffer });
  assert.ok(!pcClean.reasons.some((x) => x.check === "date_format"), JSON.stringify(pcClean.reasons));
  const numeric = JSON.parse(JSON.stringify(clean));
  numeric.sections[0].lines[1].text = "Built models from 01/2024 - 03/2025 for the team";
  const pcNum = Render.parseCheck({ resume: numeric, pdf: Render.renderPdf(numeric).buffer, docx: Render.renderDocx(numeric).buffer });
  assert.equal(pcNum.status, "WARN");
  assert.ok(pcNum.reasons.some((x) => x.check === "date_format" && x.level === "warn"));
  const mixed = JSON.parse(JSON.stringify(clean));
  mixed.sections[0].lines[1].text = "Built models Jan 2024 - 03/2025 for the team";
  const pcMix = Render.parseCheck({ resume: mixed, pdf: Render.renderPdf(mixed).buffer, docx: Render.renderDocx(mixed).buffer });
  assert.ok(pcMix.reasons.some((x) => x.check === "date_format"), "mixed formats flagged too");
});

test("R8 filename rule: FirstName_LastName_Resume.<ext> from the person's name", () => {
  assert.equal(Render.filenameFor("Alex Testcase (TEST)", "pdf"), "Alex_Testcase_Resume.pdf");
  assert.equal(Render.filenameFor("Alex Testcase (TEST)", "docx"), "Alex_Testcase_Resume.docx");
  assert.equal(Render.filenameFor("Mary Jane Watson-Parker", "pdf"), "Mary_Watson-Parker_Resume.pdf");
});

test("R9 format selection: DOCX when asked/required, PDF the default deliverable; both produced from the same JSON", () => {
  const r = tailoredSwe();
  assert.equal(r.rendered.filename, r.rendered.pdf.filename, "default deliverable is the PDF");
  const onlyDocx = Tailor.render(r.resume, { format: "docx" });
  assert.ok(onlyDocx.docx && !onlyDocx.pdf, "format:'docx' yields the DOCX artifact");
  const onlyPdf = Tailor.render(r.resume, { format: "pdf" });
  assert.ok(onlyPdf.pdf && !onlyPdf.docx, "format:'pdf' yields the PDF artifact");
});

test("R10 full job titles and real company suffixes survive rendering verbatim (both formats, parser A)", () => {
  const r = Tailor.tailorResume(loadPersona(), IB_JD, { family: "ib_finance" });
  assert.equal(r.ok, true, JSON.stringify(r.violations || []));
  const srcText = Render.sourceLines(r.resume).map((l) => l.text).join("\n");
  assert.ok(srcText.includes("TEST Systems Inc"), "source carries the suffixed company name");
  for (const art of [r.rendered.pdf, r.rendered.docx]) {
    const lines = art.format === "pdf" ? Render.extractPdfLines(Buffer.from(art.base64, "base64")) : Render.extractDocxLines(Buffer.from(art.base64, "base64"));
    const joined = lines.join("\n");
    assert.ok(joined.includes("TEST Systems Inc"), `${art.format}: company suffix verbatim, never stripped`);
    assert.ok(!/\bSr\.|\bExec\b/.test(joined), `${art.format}: no abbreviated titles introduced`);
  }
});

test("R11 placeholder data is a parse-check FAIL, never a pass", () => {
  const ph = { header: { name: "First Last", email: "first.last@example.test", location: "Anytown" }, sections: [{ heading: "Experience", lines: [{ text: "Analyst, Company 1", type: "entry" }, { text: "Did work at Any Company", type: "bullet" }] }] };
  const pc = Render.parseCheck({ resume: ph, pdf: Render.renderPdf(ph).buffer, docx: Render.renderDocx(ph).buffer });
  assert.equal(pc.status, "FAIL");
  assert.ok(pc.reasons.some((x) => x.check === "placeholder" && x.level === "fail"), JSON.stringify(pc.reasons));
});

// ---------- parse-check core behavior (Spec 3 §2.5) ----------

test("parse-check PASS on a clean tailored resume; verdict is a word + reasons, NEVER a numeric score", () => {
  const r = tailoredSwe();
  const pc = r.rendered.parseCheck;
  assert.ok(pc, "123 render() attaches the parse-check");
  assert.equal(pc.status, "PASS", JSON.stringify(pc.reasons));
  assert.ok(Array.isArray(pc.reasons));
  assert.ok(!("score" in pc) && !Object.keys(pc).some((k) => /score/i.test(k)), "no numeric ATS score field, ever");
  assert.equal(pc.formats.pdf.parsers, 2, "PDF checked by two parsers");
  assert.equal(pc.formats.docx.parsers, 2, "DOCX checked by two parsers");
});

test("parse-check FAIL when rendered content is missing from the file (source/render divergence)", () => {
  const r = tailoredSwe();
  const doctored = JSON.parse(JSON.stringify(r.resume));
  doctored.sections[0].lines.push({ text: "Line that was never rendered", type: "bullet" });
  const pc = Render.parseCheck({ resume: doctored, pdf: Buffer.from(r.rendered.pdf.base64, "base64"), docx: Buffer.from(r.rendered.docx.base64, "base64") });
  assert.equal(pc.status, "FAIL");
  assert.ok(pc.reasons.some((x) => x.check === "missing_content" && x.level === "fail"));
});

test("parse-check FAIL on extra content in the file that the source does not have", () => {
  const r = tailoredSwe();
  const shrunk = JSON.parse(JSON.stringify(r.resume));
  shrunk.sections[0].lines.splice(0, 1);
  const pc = Render.parseCheck({ resume: shrunk, pdf: Buffer.from(r.rendered.pdf.base64, "base64"), docx: Buffer.from(r.rendered.docx.base64, "base64") });
  assert.equal(pc.status, "FAIL");
  assert.ok(pc.reasons.some((x) => x.check === "extra_content" && x.level === "fail"));
});

test("parse-check WARN (not FAIL) when the same lines arrive in a different order", () => {
  const r = tailoredSwe();
  const swapped = JSON.parse(JSON.stringify(r.resume));
  const secs = swapped.sections;
  const i = secs.findIndex((s) => s.heading === "Experience"), j = secs.findIndex((s) => s.heading === "Projects");
  assert.ok(i >= 0 && j >= 0, "fixture has both sections to swap");
  [secs[i], secs[j]] = [secs[j], secs[i]];
  const pc = Render.parseCheck({ resume: swapped, pdf: Buffer.from(r.rendered.pdf.base64, "base64"), docx: Buffer.from(r.rendered.docx.base64, "base64") });
  assert.equal(pc.status, "WARN", JSON.stringify(pc.reasons));
  assert.ok(pc.reasons.some((x) => x.check === "reading_order" && x.level === "warn"));
});

test("parse-check flags risky foreign layouts (Spec 3 §13.2): a DOCX with a layout table WARNS/FAILs in audit mode", () => {
  const r = tailoredSwe();
  const docxBuf = Buffer.from(r.rendered.docx.base64, "base64");
  // Rebuild the same DOCX but with the first paragraph wrapped in a table cell.
  const xml = Render.docxPart(docxBuf, "word/document.xml").toString("utf8");
  const tabled = xml.replace("<w:p>", "<w:tbl><w:tr><w:tc><w:p>").replace("</w:p>", "</w:p></w:tc></w:tr></w:tbl>");
  const mutant = Render.rebuildDocx(docxBuf, { "word/document.xml": tabled });
  const pc = Render.parseCheck({ docx: mutant });
  assert.notEqual(pc.status, "PASS");
  assert.ok(pc.reasons.some((x) => x.check === "tables"), JSON.stringify(pc.reasons));
});

// ---------- truth gate + §8D ----------

test("truth gate: a resume the audit refused renders NOTHING in any format", () => {
  const p = loadPersona();
  const r = Tailor.tailorResume(p, SWE_JD, { extraLines: [{ text: "Expert in Rust and Kubernetes at scale", factIds: [], type: "bullet" }] });
  assert.equal(r.ok, false);
  assert.equal(r.rendered, null);
  for (const fn of [Render.renderPdf, Render.renderDocx]) {
    const out = fn(r);
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.equal(out.buffer, null);
  }
  const direct = Render.renderPdf({ ok: false, refused: true, sections: [{ heading: "Experience", lines: [{ text: "x", type: "bullet" }] }] });
  assert.equal(direct.refused, true);
});

test("Spec 3 §8D-1 (allowed rephrase) renders traceably; the not-allowed additions never appear", () => {
  const fx = require("./fixtures/spec3-tailoring-examples.cjs").find((x) => x.id === "8D-1");
  const data = {
    basics: { name: "Dana Example", email: "dana@example.test", location: "Chicago, IL", links: {} },
    facts: [
      { id: "F-101", kind: "experience", title: "Reporting Analyst, Example Retail Group", org: "Example Retail Group", text: fx.fact, bullets: fx.allowed, skills: ["Tableau"], needs_confirmation: false, evidence: [] },
      { id: "F-102", kind: "skill", name: "Tableau", title: "Tableau", text: "Skill: Tableau", skills: ["Tableau"], needs_confirmation: false, evidence: ["F-101"] },
    ],
  };
  const prof = Profile.profileFromData(data);
  const r = Tailor.tailorResume(prof, "Data Analyst (TEST): data visualization, stakeholder reporting. Required: Tableau.", {});
  assert.equal(r.ok, true, JSON.stringify(r.violations || []));
  assert.equal(r.rendered.parseCheck.status, "PASS", JSON.stringify(r.rendered.parseCheck.reasons));
  const pdfText = Render.extractPdfLines(Buffer.from(r.rendered.pdf.base64, "base64")).join("\n");
  assert.ok(pdfText.includes(fx.allowed[0]), "the allowed rephrase is in the PDF verbatim");
  for (const bad of fx.notAllowedAdditions) assert.ok(!pdfText.includes(bad), `not-allowed addition leaked: ${bad}`);
});

test("tailor version record snapshots the artifacts (Spec 3 §10.5): filenames + sha256 of the exact rendered bytes", () => {
  const r = tailoredSwe();
  assert.ok(r.version.artifacts, "version carries the artifact snapshot");
  assert.equal(r.version.artifacts.pdf.filename, "Alex_Testcase_Resume.pdf");
  assert.equal(r.version.artifacts.pdf.sha256, r.rendered.pdf.sha256);
  assert.equal(r.version.artifacts.docx.sha256, r.rendered.docx.sha256);
});

// ---------- independent external parsers agree (Spec 3 §2.5) ----------

test("external parser B (poppler pdftotext) recovers the same reading order as parser A", { skip: hasBin("pdftotext") ? false : "pdftotext not available" }, () => {
  const r = tailoredSwe();
  const buf = Buffer.from(r.rendered.pdf.base64, "base64");
  const viaPoppler = normSeq(Render.extractPdfPoppler(buf));
  const layout = normSeq(Render.layoutLines(r.resume).map((l) => l.text));
  assert.deepEqual(viaPoppler, layout);
});

test("external parser B (python-docx) recovers the same lines as the in-repo DOCX parser", { skip: hasPythonDocx() ? false : "python-docx not available" }, () => {
  const r = tailoredSwe();
  const buf = Buffer.from(r.rendered.docx.base64, "base64");
  assert.deepEqual(normSeq(Render.extractDocxPython(buf)), normSeq(Render.extractDocxLines(buf)));
});
