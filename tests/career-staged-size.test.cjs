"use strict";
// B-05 STRUCTURAL TEST (Crew A, 2026-10-15; protocol
// docs/career/prod-verification-protocol.md §9; master issue MI-047):
// the HTTP 413 class fails HERE, in the sweep, instead of at the
// platform. The career entry's static import graph is staged with
// scripts/career/stage-career.cjs and the staged total must stay under
// the 4,200,000 B ceiling (the practical platform ceiling sits between
// 3,950,107 B accepted and 4,822,785 B rejected — the full bundle was
// the rejected one). The career artifact must also never contain the
// finance-carrying full bundle.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// 2026-10-26 (architect; owner's written yes to go live): the 4,200,000 B ceiling was the SERVER-SIDE bundling limit
// (Supabase: "5MB (bundled server-side, e.g. via the Management API or Dashboard)"; the probe above: 3.95 MB accepted,
// 4.82 MB rejected). Go-live deploys with the CLI and --use-docker, which bundles locally: "Maximum Function Size: 20MB
// (bundled locally via the CLI)" (supabase.com/docs/guides/functions/limits). The ceiling is now that limit with a 25%
// margin, and it holds only while every deploy in go-live bundles locally (asserted below). A deploy through the MCP,
// the Dashboard or the Management API still has the 5 MB limit and is not how agent-chat ships.
const CEILING = 15000000;
const SERVER_SIDE_CEILING = 4200000;
const REMEDIATION = "Remediation: the career artifact is staged from agent-chat/index-career.ts only (protocol §9 / MI-047). If the total grew, a module pulled the full bundle or a heavy dependency into the career graph — prune the import, or split the data file; never raise the ceiling without the owner's word and a platform probe.";

test("B-05: the staged career artifact stays under the platform ceiling", () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-stage-"));
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "career", "stage-career.cjs"), stageDir, "--json"], { encoding: "utf8" });
    const report = JSON.parse(out.trim().split("\n").pop());
    const paths = report.fileList.map((f) => f.path);
    assert.ok(paths.includes("_shared/router_core.career.js"), `the career bundle must be staged; got: ${paths.join(", ")}. ${REMEDIATION}`);
    assert.ok(!paths.includes("_shared/router_core.js"), `the FULL bundle (finance surface, 4.9 MB raw) must never enter the career artifact. ${REMEDIATION}`);
    const golive = fs.readFileSync(path.join(__dirname, "..", "scripts", "launch", "trainee-go-live.sh"), "utf8");
    const deploys = golive.split("\n").filter((l) => /^\s*(\(cd .*&& )?(run ".*" )?supabase functions deploy /.test(l.trim().replace(/^\(cd [^&]+&& /, "")) && !/^\s*echo /.test(l));
    if (report.totalBytes > SERVER_SIDE_CEILING) {
      assert.ok(deploys.length > 0, "go-live deploys nothing: the local-bundling claim cannot be checked");
      for (const l of deploys) assert.match(l, /--use-docker/, `over ${SERVER_SIDE_CEILING} B the artifact ships only when bundled locally; this deploy is not: ${l.trim()}`);
    }
    assert.ok(report.totalBytes <= CEILING, `staged career artifact is ${report.totalBytes} B, over the ${CEILING} B ceiling (mode: ${report.mode}). ${REMEDIATION}`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

// Release 12 (deploy-production run 45874743067, HTTP 413 "request entity too large"): an `npm:` specifier in the career graph
// (npm:pdfjs-dist) made the edge bundler vendor the whole npm package: agent-chat went from 4.5 MB to 38 MB compressed (the
// platform's 20 MB limit applies to that), while the staged source total above grew only 8.0 -> 10.5 MB and passed. Remote
// modules (esm.sh, deno.land) bundle only their module graph. No staged career file imports an `npm:` specifier.
test("release 12: no npm: specifier enters the staged career artifact (the bundler vendors the whole package)", () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-stage-npm-"));
  try {
    execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "career", "stage-career.cjs"), stageDir], { encoding: "utf8" });
    const hits = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|js|mjs)$/.test(e.name)) { const src = fs.readFileSync(p, "utf8"); for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)["'](npm:[^"']+)["']/g)) hits.push(`${path.relative(stageDir, p)}: ${m[1]}`); } } };
    walk(stageDir);
    assert.deepStrictEqual(hits, [], `npm: specifiers in the career artifact: ${hits.join("; ")}. Use an esm.sh URL pinned to the same version. ${REMEDIATION}`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});
