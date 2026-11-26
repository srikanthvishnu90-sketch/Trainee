"use strict";
// Round 2 (review of #818), item 6: nothing the page changes after the last look reaches the employer. Plain data and the runner's
// order (no browser): the in-page guard's rule (guardVerdict) and where the last look sits. The pages: the -browser file.
// Run: node --test tests/career-engine-round2-submit-guard.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pa = require("../workers/career-browser/parallel-apply.cjs");
const SRC = fs.readFileSync(path.join(__dirname, "../workers/career-browser/parallel-apply.cjs"), "utf8");

test("6: the guard's verdict at the moment the form is sent", () => {
  assert.deepEqual(pa.guardVerdict(null), { status: null }, "the page navigated away: the guard saw nothing to stop");
  assert.deepEqual(pa.guardVerdict({ aborted: false }), { status: null });
  assert.deepEqual(pa.guardVerdict({ aborted: true, late: false }), { status: "not_submitted", reason: "page_changed_at_submit" }, "stopped before the browser sent anything");
  assert.equal(pa.guardVerdict({ aborted: true, late: true }).status, "unknown_outcome", "the page's own script had already taken the submission: it may have been sent");
});

test("6: the order before the click: values read back against the approved ones, the record, the guard armed, the click", () => {
  const fill = SRC.indexOf("await fillForm(page");
  const drift = SRC.indexOf("driftedFills(page", fill), rec = SRC.indexOf('opts.onPhase("submitting"', fill), arm = SRC.indexOf("page.evaluate(GUARD", fill), click = SRC.indexOf('page.click("[data-upmore-submit]")', fill);
  assert.ok(drift > 0 && drift < rec, "a value the page rewrote is refused before the submitting record");
  assert.ok(rec < arm && arm < click, "the guard is armed after the record, as the last step before the click");
  const between = SRC.slice(SRC.indexOf("\n", arm), click);
  assert.doesNotMatch(between, /await (?!Promise\.all\(\[page\.waitForLoadState)/, "nothing awaited between arming and the click");
  assert.ok(SRC.indexOf("guardVerdict(", click) > click, "the guard's flag is read after the click");
});
