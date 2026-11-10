"use strict";
// Architect ruling (2026-11-10, release item 2): the apply VM drives a board only when the strict benchmark shows the runner
// completes it (today Greenhouse, Lever, Personio, Breezy), each by an exact host pattern, the denylist first. Look-alike hosts
// are refused. The SQL side (career_apply_vm_family, 20261110120000) is checked with the same links by tests/db/run.sh.
//   node --test tests/career-apply-vm-boards.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { atsOf, BOARDS } = require("../workers/career-browser/apply-vm.cjs");

const DRIVES = { "https://acme.breezy.hr/p/1": "breezy", "https://x.jobs.personio.de/job/1": "personio", "https://jobs.lever.co/a/1": "lever",
  "https://www.jobs.lever.co/a": "lever", "https://boards.greenhouse.io/a": "greenhouse", "https://job-boards.greenhouse.io/a/jobs/1": "greenhouse" };
const LOOK_ALIKES = ["https://jobs.lever.co:8443/a", "https://breezy.hr/p", "https://a.b.breezy.hr/p", "https://acme.breezy.hr.evil.com/p",
  "https://evil-breezy.hr/p", "https://acme.jobs.personio.de.evil.io/", "https://acme.jobs.personio.com/", "https://-x.breezy.hr/",
  "https://jobs.ashbyhq.com/acme/1", "https://boards.greenhouse.io.evil.com/a", "https://jobs-lever.co/a", "https://acme.breezy.hr@evil.com/p"];

test("the four boards are driven by exact host", () => {
  for (const [u, ats] of Object.entries(DRIVES)) assert.equal(atsOf(u).ats, ats, u);
  assert.deepEqual(BOARDS.map(([a]) => a), ["greenhouse", "lever", "personio", "breezy"]);
});

test("a look-alike host, an extra label, a port or another domain is refused", () => {
  for (const u of LOOK_ALIKES) assert.deepEqual(atsOf(u), { refuse: "site_not_supported" }, u);
});

test("the denylist wins over every board pattern", () => {
  for (const u of ["https://www.linkedin.com/jobs/view/1", "https://jobs.linkedin.com/x", "https://www.indeed.com/viewjob?jk=1", "https://app.joinhandshake.com/jobs/1", "https://lnkd.in/x"]) {
    assert.deepEqual(atsOf(u), { refuse: "site_not_supported" }, u);
  }
});

test("the SQL family function carries the same host patterns", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20261110120000_career_apply_vm_boards.sql"), "utf8");
  for (const pat of ["\\.jobs\\.personio\\.de$'", "\\.breezy\\.hr$'", "'jobs.lever.co'", "'boards.greenhouse.io', 'job-boards.greenhouse.io'"]) assert.ok(sql.includes(pat), pat);
  assert.ok(sql.indexOf("then 'refused'") < sql.indexOf("then 'personio'"), "the denylist is checked first");
});
