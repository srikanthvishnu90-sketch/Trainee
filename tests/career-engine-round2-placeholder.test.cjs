"use strict";
// Round 2 (review of #818), item 10: a select whose placeholder option carries a value ("Please select" = "0", a disabled "Choose
// one" = "-1") holds no answer: it is not the page's choice to ask about, and not a filled question. The rule, and the same rule in
// both page-side readers (ats-fill STATE, parallel-apply CONTROLS). In Chromium: the -browser file's k8 pages.
// Run: node --test tests/career-engine-round2-placeholder.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const af = require("../workers/career-browser/ats-fill.cjs");

test("10: a placeholder option is known by its words, whatever its value", () => {
  for (const t of ["Select...", "Select…", "Select", "Choose one", "Choose…", "Please select", "Please choose", "-- Select --", "--", "Select an option", "— Please select —", ""]) assert.equal(af.isPlaceholderOption(t, false), true, t);
  for (const t of ["LinkedIn", "Friend", "1 month", "Selected works", "Choose Life Ltd", "Select Plan Premium"]) assert.equal(af.isPlaceholderOption(t, false), false, t);
  assert.equal(af.isPlaceholderOption("Pick a value", true), true, "a disabled option is never an answer");
  const fill = fs.readFileSync(path.join(__dirname, "../workers/career-browser/ats-fill.cjs"), "utf8"), run = fs.readFileSync(path.join(__dirname, "../workers/career-browser/parallel-apply.cjs"), "utf8");
  const src = af.PLACEHOLDER_OPTION.source;
  assert.ok(fill.split(src).length >= 3, "STATE uses the same words"); assert.ok(run.includes(src), "CONTROLS uses the same words");
});
