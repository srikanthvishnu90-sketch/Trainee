"use strict";
// #340: a choice question (select, radio, Yes/No buttons, combobox) is set only to the option whose words are EXACTLY the
// approved answer (case, spacing and punctuation aside). The fill engine used to accept a prefix ("Yes" took "Yes, with
// sponsorship") or a substring ("Male" took "Female"), so the employer received a value the person never approved. Now an
// approved answer that is not one of the page's options is never guessed: the question is handed back as needs_user (even
// when optional) and nothing is submitted. When every approved answer is present, the payload posted to the employer carries
// exactly the approved answers.
// Run: node --test tests/career-apply-exact-option.test.cjs
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { matchOption } = require("../workers/career-browser/ats-fill.cjs");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";

test("matchOption: only an exact (normalized) option; never a prefix, a substring or a yes-like word", () => {
  assert.deepEqual(matchOption(["Yes", "Yes, with sponsorship", "No"], "Yes"), { index: 0 });
  assert.deepEqual(matchOption(["Yes", "Yes, with sponsorship", "No"], "yes, with sponsorship"), { index: 1 });
  assert.equal(matchOption(["Yes, with sponsorship", "No"], "Yes").error, "no_matching_option", "'Yes' is not 'Yes, with sponsorship'");
  assert.equal(matchOption(["Yes, I am authorized to work", "No"], "Yes").error, "no_matching_option");
  assert.equal(matchOption(["No, I do not need it", "Yes"], "No").error, "no_matching_option");
  assert.deepEqual(matchOption(["Male", "Female"], "Male"), { index: 0 });
  assert.deepEqual(matchOption(["Male", "Female"], "female"), { index: 1 });
  assert.equal(matchOption(["Female", "Decline to self-identify"], "Male").error, "no_matching_option", "'Male' is not 'Female'");
  assert.deepEqual(matchOption(["1", "10"], "1"), { index: 0 });
  assert.deepEqual(matchOption(["1", "10"], "10"), { index: 1 });
  assert.equal(matchOption(["10", "20"], "1").error, "no_matching_option", "'1' is not '10'");
  assert.equal(matchOption(["10+ years", "2"], "10").error, "no_matching_option");
  assert.equal(matchOption(["Yes", "No"], "y").error, "no_matching_option", "'y' is not an approved 'Yes'");
  assert.equal(matchOption(["Yes", "No"], "true").error, "no_matching_option");
  assert.equal(matchOption(["Senior Software Engineer", "Engineer"], "Software Engineer").error, "no_matching_option");
  assert.deepEqual(matchOption(["Yes!", "No"], "yes"), { index: 0 }, "punctuation and case aside, the words are the same");
  assert.equal(matchOption(["Yes", "YES"], "yes").error, "ambiguous_option");
});

// ---- the worker against a local form: what is POSTed --------------------------------------------------------------------
// One form, three choice questions; `opts` sets each question's options. The option VALUES are opaque codes, so the posted
// payload is compared through the page's own value -> label map.
const OPT = (name, labels, type) => labels.map((l, i) => type === "radio"
  ? `<label><input type="radio" name="${name}" value="${name}${i}" required> ${l}</label>`
  : `<option value="${name}${i}">${l}</option>`).join("\n");
const PAGES = {
  present: { sp: ["Yes", "Yes, with sponsorship", "No"], g: ["Male", "Female", "Decline to self-identify"], y: ["1", "10", "20"], yRequired: true },
  sponsorship_prefix: { sp: ["Yes, with sponsorship", "No"], g: ["Male", "Female"], y: ["1", "10"], yRequired: true },
  gender_substring: { sp: ["Yes", "No"], g: ["Female", "Decline to self-identify"], y: ["1", "10"], yRequired: true },
  years_optional_missing: { sp: ["Yes", "No"], g: ["Male", "Female"], y: ["10", "20"], yRequired: false },
};
const html = (k) => {
  const p = PAGES[k];
  return `<!doctype html><html><body><h2>Apply</h2><form method="post" action="/submit/${k}">
<label for="fn">First Name *</label><input id="fn" name="first_name" required>
<label for="sp">Will you require visa sponsorship? *</label><select id="sp" name="sp" required><option value="">Select...</option>${OPT("sp", p.sp)}</select>
<fieldset><legend>Gender *</legend>${OPT("g", p.g, "radio")}</fieldset>
<label for="y">Years of experience${p.yRequired ? " *" : ""}</label><select id="y" name="y"${p.yRequired ? " required" : ""}><option value="">Select...</option>${OPT("y", p.y)}</select>
<label for="cv">Resume/CV *</label><input id="cv" type="file" name="resume" required>
<button type="submit">Submit application</button></form></body></html>`;
};
const labelOf = (k, field, value) => { const i = Number(String(value).slice(field.length)); return PAGES[k][field][i]; };
const APPROVED = { "Will you require visa sponsorship?": "Yes", "Gender": "Male", "Years of experience": "1" };

let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        posts.push({ url: req.url, body: Buffer.concat(chunks).toString("latin1") });
        res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1 id=confirmation>Thank you for applying</h1></body></html>");
      });
      return;
    }
    const k = req.url.split("?")[0].slice(1);
    return PAGES[k] ? res.writeHead(200, { "content-type": "text/html" }).end(html(k)) : res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "exact-opt-"));
  resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  if (resume) fs.rmSync(path.dirname(resume), { recursive: true, force: true });
});
const job = (k) => {
  const p = { id: "j-" + k, ats: "greenhouse", url: `${base}/${k}`, facts: { first_name: "Casey" }, answers: { ...APPROVED }, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } };
  p.approval = { approval_id: "appr-" + k, hash: payloadHash(p) };
  return p;
};
// The posted form's fields (urlencoded: the form sets no enctype).
const fieldsOf = (body) => Object.fromEntries(new URLSearchParams(body));

test("every approved answer is an option: the posted payload is exactly the approved card", { skip, timeout: 60000 }, async () => {
  const before = posts.length;
  const r = await applyOne(browser, job("present"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  const mine = posts.slice(before).filter((p) => p.url === "/submit/present");
  assert.equal(mine.length, 1, "posted once");
  const f = fieldsOf(mine[0].body);
  assert.deepEqual({
    "Will you require visa sponsorship?": labelOf("present", "sp", f.sp),
    "Gender": labelOf("present", "g", f.g),
    "Years of experience": labelOf("present", "y", f.y),
  }, APPROVED, "what the employer received is what was approved");
  assert.equal(f.first_name, "Casey");
});

for (const [k, field, label] of [
  ["sponsorship_prefix", "Will you require visa sponsorship?", "a required select: 'Yes' approved, only 'Yes, with sponsorship' offered"],
  ["gender_substring", "Gender", "a required radio: 'Male' approved, only 'Female' offered"],
  ["years_optional_missing", "Years of experience", "an OPTIONAL select: '1' approved, only '10' and '20' offered"],
]) {
  test(`${label}: needs_user, nothing posted`, { skip, timeout: 60000 }, async () => {
    const before = posts.length;
    const r = await applyOne(browser, job(k), { stepTimeoutMs: 8000, retries: 0 });
    assert.equal(posts.length - before, 0, `nothing may be posted (the employer got ${JSON.stringify(posts.slice(before).map((p) => fieldsOf(p.body)))})`);
    assert.equal(r.status, "not_submitted", JSON.stringify(r));
    assert.equal(r.reason, "field_not_filled");
    assert.ok((r.needs || []).some((n) => n.label === field && n.reason === "no_matching_option"), `the question is handed back: ${JSON.stringify(r.needs)}`);
  });
}
