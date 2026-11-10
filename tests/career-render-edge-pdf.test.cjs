"use strict";
/* LANE F — the PDF renderer on the Deno edge runtime (blocker under
   CHANNEL-DOC-1; Lane B record channel-doc-1-record-2026-10-20.md §5).
   FAIL-FIRST: on the base tree (75ccf5f5 lineage) every edge-realm test
   below is RED — module 148 captures require("zlib") at eval time, and in
   the ESM bundle there is no require, so renderPdf refuses ("zlib is
   unavailable in this runtime; PDF rendering needs Node") and a live
   tailor turn renders text-only while the reply claims an attachment.
   The fix is a bundle-legal pure-JS zlib + SHA-256 fallback INSIDE 148,
   used only when the Node captures are absent; the Node path keeps the
   real zlib/crypto, so its bytes stay byte-identical (golden-pinned in
   the control test at the bottom — green before and after). Since #673
   (2026-11-10) every runtime compresses with 148's deterministic deflate,
   so the Node bytes are pinned to that codec; the content is unchanged.

   The edge realm here is Deno-shaped, faithfully: Buffer exists (Deno
   exposes it as a global — verified on deno 2.9.7), require and module
   do not. The staged-handler companion guard is
   tests/edge/edge-pdf-renderer.test.ts (the real bundle through the
   real CareerHost under Deno itself).

   Bug law: BUG-PENDING-ALLOCATION (edge-pdf-renderer) +
   FR-PENDING-ALLOCATION (edge-pdf-renderer) — numbers requested from
   Crew A per MI-093, never self-allocated. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const Profile = require("../packages/domain/122-career-profile.js");
const Tailor = require("../packages/domain/123-career-tailor.js");
const RenderNode = require("../packages/domain/148-career-render.js");

const SWE_JD = `Software Engineer, New Grad (TEST posting)
Required: Python, JavaScript, React, SQL, PostgreSQL, Git.
Nice to have: Kubernetes, Docker, AWS.
You will build APIs and deploy services.`;

function tailoredResume() {
  const persona = Profile.profileFromData(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "packages", "career-data", "fixtures", "test-persona.json"), "utf8")));
  const r = Tailor.tailorResume(persona, SWE_JD, { jobId: "TEST-JOB-1", date: "2026-10-12" });
  assert.equal(r.ok, true, JSON.stringify(r.violations || []));
  return r.resume;
}

// Module 148 evaluated the way the Deno bundle evaluates it: one flat
// script scope, no require anywhere in the graph.
function loadEdgeRender() {
  const src = fs.readFileSync(path.join(__dirname, "..", "packages", "domain", "148-career-render.js"), "utf8");
  const context = vm.createContext({ Buffer, console });
  assert.equal(vm.runInContext("typeof require", context), "undefined");
  assert.equal(vm.runInContext("typeof module", context), "undefined");
  vm.runInContext(src, context, { filename: "148-career-render.js" });
  return vm.runInContext("CareerRender", context);
}

const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// Node-path goldens for this exact fixture. Re-pinned 2026-11-10 (#673, architect ruling): 148 now compresses with its own
// deterministic deflate on every runtime, so Node and Deno write the same bytes. Only the compression moved: the inflated
// PDF content stream and every DOCX part are identical to the base tree's (bf12dbaa goldens 89317f47.../28f5b1dd...,
// 1,706 / 2,436 bytes). Now renderPdf 1,926 bytes / renderDocx 2,782 bytes.
const GOLDEN_PDF_SHA256 = "a03a0de9ebd039cfb65fbf2224157d17e013cc78055844058de16f7e46395cc1";
const GOLDEN_DOCX_SHA256 = "293f712875d87e17f5d82d9436fe012a71330e74ea992cd5e27571d5a5538ca9";

test("edge realm (no require): renderPdf produces a real PDF instead of refusing", () => {
  const Edge = loadEdgeRender();
  const rendered = Edge.renderPdf(tailoredResume());
  assert.equal(rendered.ok, true, rendered.reason || "renderPdf refused in the edge realm");
  assert.ok(Buffer.isBuffer(rendered.buffer), "buffer must be a Buffer");
  assert.equal(rendered.buffer.subarray(0, 9).toString("latin1"), "%PDF-1.4\n");
  assert.ok(rendered.buffer.subarray(rendered.buffer.length - 16).toString("latin1").includes("%%EOF"));
  assert.equal(rendered.filename, "Alex_Testcase_Resume.pdf");
  assert.ok(rendered.pages >= 1, "at least one page");
  assert.equal(rendered.bytes, rendered.buffer.length);
});

test("edge PDF parses with the independent Node extractor and carries the tailored text", () => {
  const Edge = loadEdgeRender();
  const resume = tailoredResume();
  const rendered = Edge.renderPdf(resume);
  assert.equal(rendered.ok, true, rendered.reason || "renderPdf refused");
  // Independent parser: the Node-realm module (real zlib) reads the
  // edge-produced bytes — two implementations must agree on the content.
  const lines = RenderNode.extractPdfLines(rendered.buffer);
  assert.ok(lines.some((l) => l.includes("Alex Testcase")), `name line missing from edge PDF: ${JSON.stringify(lines.slice(0, 4))}`);
  const joined = lines.join("\n");
  assert.match(joined, /Python/);
  assert.match(joined, /EXPERIENCE|SKILLS/);
  const structure = RenderNode.pdfStructure ? null : null; // structure helper is not exported; page count via trailer:
  const m = rendered.buffer.toString("latin1").match(/\/Count (\d+)/);
  assert.ok(m && parseInt(m[1], 10) >= 1, "Pages /Count must be >= 1");
  // Every expected layout line is present (the renderer's own contract).
  const expected = RenderNode.layoutLines(resume).map((l) => l.text);
  for (const line of expected) assert.ok(lines.includes(line), `layout line missing from edge PDF: ${line}`);
});

test("edge realm parse-check passes on its own PDF (pure inflate, both parsers)", () => {
  const Edge = loadEdgeRender();
  const resume = tailoredResume();
  const rendered = Edge.renderPdf(resume);
  assert.equal(rendered.ok, true, rendered.reason || "renderPdf refused");
  const check = Edge.parseCheck({ resume, pdf: rendered.buffer });
  assert.equal(check.status, "PASS", JSON.stringify(check.reasons));
});

test("pure inflate reads Node zlib's real streams (fixed + dynamic Huffman)", () => {
  const Edge = loadEdgeRender();
  const resume = tailoredResume();
  const nodeRendered = RenderNode.renderPdf(resume);
  assert.equal(nodeRendered.ok, true);
  // Cross-realm arrays fail deepStrictEqual on prototypes alone, so the
  // comparison is on serialized content — the values themselves.
  const asJson = (v) => JSON.stringify(v);
  assert.equal(asJson(Edge.extractPdfLines(nodeRendered.buffer)), asJson(RenderNode.extractPdfLines(nodeRendered.buffer)));
  assert.equal(asJson(Edge.extractPdfStrings(nodeRendered.buffer)), asJson(RenderNode.extractPdfStrings(nodeRendered.buffer)));
  assert.ok(Edge.extractPdfLines(nodeRendered.buffer).length > 20, "the pure inflater actually recovered the lines");
});

test("edge artifact: sha256 is real and equals the hash of the bytes the channel seam delivers", () => {
  const Edge = loadEdgeRender();
  const rendered = Edge.renderPdf(tailoredResume());
  assert.equal(rendered.ok, true, rendered.reason || "renderPdf refused");
  const art = Edge.artifact("pdf", rendered);
  assert.ok(art, "artifact must exist for a rendered PDF");
  assert.ok(art.base64 && art.base64.length > 0, "artifact carries bytes (base64)");
  const delivered = Buffer.from(art.base64, "base64"); // exactly what the channel seam fetches and sends
  assert.equal(art.bytes, delivered.length);
  assert.equal(art.sha256, sha256Hex(delivered), "artifact sha256 must be the delivered bytes' hash");
  assert.equal(art.filename, "Alex_Testcase_Resume.pdf");
  assert.equal(art.contentType, "application/pdf");
});

test("edge realm: DOCX renders through the same fallback and round-trips", () => {
  const Edge = loadEdgeRender();
  const rendered = Edge.renderDocx(tailoredResume());
  assert.equal(rendered.ok, true, rendered.reason || "renderDocx refused in the edge realm");
  const lines = RenderNode.extractDocxLines(rendered.buffer);
  assert.ok(lines.some((l) => l.includes("Alex Testcase")), "name line missing from edge DOCX");
  const art = Edge.artifact("docx", rendered);
  assert.equal(art.sha256, sha256Hex(Buffer.from(art.base64, "base64")));
});

test("control: refused resumes still render nothing in the edge realm", () => {
  const Edge = loadEdgeRender();
  const out = Edge.renderPdf({ ok: false, header: { name: "Refused Person" }, sections: [{ heading: "Experience", lines: [{ text: "x", type: "entry" }] }] });
  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.equal(out.buffer, null);
});

test("control: Node path output is byte-stable (golden hashes from the base tree)", () => {
  const resume = tailoredResume();
  const pdf = RenderNode.renderPdf(resume);
  const docx = RenderNode.renderDocx(resume);
  assert.equal(pdf.ok, true);
  assert.equal(docx.ok, true);
  assert.equal(sha256Hex(pdf.buffer), GOLDEN_PDF_SHA256, "Node PDF bytes must not change");
  assert.equal(sha256Hex(docx.buffer), GOLDEN_DOCX_SHA256, "Node DOCX bytes must not change");
});
