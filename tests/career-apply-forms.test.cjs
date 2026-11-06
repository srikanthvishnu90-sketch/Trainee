"use strict";
const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  { spawn, spawnSync } = require("node:child_process");
const fixtureFile = path.join(__dirname, "fixtures/portal-fixture-server.cjs"),
  packet = require("./fixtures/apply-profile.json");
let api, base, child, root, resume;
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const form = (extra) =>
  `<!doctype html><h1>SYNTHETIC TEST FORM</h1><form method="post" action="/never-submit"><label for="name">Full name</label><input id="name" name="name" required><label for="email">Email</label><input id="email" name="email" required><label for="resume">Resume</label><input id="resume" name="resume" type="file" required><label for="work">Are you authorized to work in the US?</label><select id="work" name="work_authorization" required><option value="">Select</option><option value="y">Yes</option><option value="n">No</option></select>${
    extra || ""
  }<button type="submit">Submit application</button></form>`;
before(async () => {
  const check = spawnSync(process.execPath, [
    "-e",
    `const a=require(${
      JSON.stringify(fixtureFile)
    });if(typeof a.loadSnapshots!=='function'||typeof a.probeSnapshot!=='function')throw Error('SNAPSHOT_HARNESS_MISSING');`,
  ], { encoding: "utf8", timeout: 4000 });
  assert.equal(check.status, 0, check.stderr || check.error?.message);
  api = require(fixtureFile);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "upmore-fill-harness-"));
  resume = path.join(root, packet.resume.filename);
  fs.writeFileSync(resume, packet.resume.text);
  const cases = [
    {
      id: "synthetic-empty-captcha",
      synthetic: true,
      html: form(
        '<div class="h-captcha" data-sitekey="TEST"></div><div class="g-recaptcha" data-sitekey="TEST"></div>',
      ),
      fields: [],
    },
    {
      id: "synthetic-anchor",
      synthetic: true,
      html: form(
        '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=TEST&size=invisible" width="300" height="80"></iframe>',
      ),
      fields: [],
    },
    {
      id: "synthetic-visible-anchor",
      synthetic: true,
      html: form(
        '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=TEST" width="300" height="80"></iframe>',
      ),
      fields: [],
    },
    {
      id: "synthetic-zero-challenge",
      synthetic: true,
      html: form(
        '<iframe src="https://newassets.hcaptcha.com/captcha/v1/test/static/hcaptcha.html#frame=challenge" width="0" height="0" style="border:0"></iframe>',
      ),
      fields: [],
    },
    {
      id: "synthetic-challenge",
      synthetic: true,
      html: form(
        '<iframe src="https://newassets.hcaptcha.com/captcha/v1/test/static/hcaptcha.html#frame=challenge" width="300" height="200"></iframe>',
      ),
      fields: [],
    },
    {
      id: "synthetic-recaptcha",
      synthetic: true,
      html: form(
        '<iframe src="https://www.google.com/recaptcha/api2/bframe?k=TEST" width="300" height="200"></iframe>',
      ),
      fields: [],
    },
    {
      id: "synthetic-hidden-challenge",
      synthetic: true,
      html: form(
        '<iframe src="https://newassets.hcaptcha.com/captcha/v1/test/static/hcaptcha.html#frame=challenge" width="300" height="200" style="display:none"></iframe>',
      ),
      fields: [],
    },
    {
      id: "synthetic-widget-first",
      synthetic: true,
      html: form().replace(
        '<label for="name">',
        '<label for="country">Country</label><input class="select__input" id="country" name="country" role="combobox" required><label for="name">',
      ),
      fields: [],
    },
    {
      id: "synthetic-unnamed",
      synthetic: true,
      html: form(
        '<label>Preferred start date<input type="date" required></label>',
      ),
      fields: [],
    },
    {
      id: "synthetic-widget",
      synthetic: true,
      html: form(
        '<label for="country">Country</label><input class="select__input" id="country" name="country" role="combobox" required>',
      ),
      fields: [],
    },
    { id: "synthetic-ready", synthetic: true, html: form(), fields: [] },
    {
      id: "synthetic-unknown",
      synthetic: true,
      html: form(
        '<label for="unknown">Favorite programming language</label><input id="unknown" name="unknown" required>',
      ),
      fields: [],
    },
    {
      id: "synthetic-lone-checkbox-yes",
      synthetic: true,
      html: form(
        '<label for="lone-work">Are you legally authorized to work for this employer?</label><input id="lone-work" name="lone_work" type="checkbox" required>',
      ),
      fields: [],
    },
    {
      id: "synthetic-lone-checkbox-no",
      synthetic: true,
      html: form(
        '<label for="lone-sponsor">Will you require sponsorship?</label><input id="lone-sponsor" name="lone_sponsor" type="checkbox" required>',
      ),
      fields: [],
    },
    {
      id: "synthetic-offsite",
      synthetic: true,
      html:
        '<script>location.href="https://jobs.lever.co/never-requested/id"</script>',
      fields: [],
    },
  ];
  const inventory = api.loadSnapshots(
    process.env.UPMORE_FORM_SNAPSHOT_ROOT ||
      path.join(__dirname, "fixtures/forms-ci"),
  );
  const config = path.join(root, "local-bundle.json");
  fs.writeFileSync(config, JSON.stringify([...cases, ...inventory.snapshots]));
  child = spawn(process.execPath, [fixtureFile, "--snapshot-bundle", config], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(Error("fixture server startup")),
      10000,
    );
    child.stdout.on("data", (b) => {
      out += b;
      const m = out.match(/FIXTURE_PORT (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve("http://localhost:" + m[1]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("fixture server exited"));
    });
  });
});
after(() => {
  if (child) child.kill();
  if (api) api.shutdownProbe();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
const expectedFields = ["name", "email", "resume", "work_authorization"].map(
  (name) => ({ name, required: true }),
);
function probe(id, over = {}) {
  return api.probeSnapshot({
    url: base + "/snapshots/" + id,
    snapshot: { id, synthetic: true, fields: expectedFields },
    packet,
    resumePath: resume,
    evidenceDir: root,
    ...over,
  });
}
test("009b-3 absent captures report NOT_RUN, never synthetic real-source coverage", () => {
  const r = api.loadSnapshots(path.join(root, "missing"));
  assert.equal(r.real_count, 0);
  assert.equal(r.status, "NOT_RUN");
  assert.equal(r.expected, 17);
});
test("009b-3 accepted rendered corpus has 17 applications and SmartRecruiters handoffs", () => {
  const r = api.loadSnapshots(path.join(__dirname, "fixtures/forms-ci"));
  assert.equal(r.real_count, 17);
  for (const family of ["greenhouse", "lever", "ashby"]) {
    assert.ok(r.snapshots.filter((s) => s.family === family).length >= 5);
  }
  assert.equal(
    r.handoffs.filter((s) => s.family === "smartrecruiters").length,
    6,
  );
});
test("009b-3 real inventory rejects traversal, modified HTML and synthetic provenance", () => {
  const dir = path.join(root, "inventory");
  fs.mkdirSync(dir);
  const manifest = {
    forms: [{
      id: "../escape",
      status: "captured",
      family: "greenhouse",
      source_url: "https://job-boards.greenhouse.io/acme/jobs/1",
    }],
  };
  const save = () =>
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  save();
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_ID/);
  manifest.forms[0].id = "case";
  save();
  fs.writeFileSync(path.join(dir, "case.html"), form());
  const meta = {
    source_url: manifest.forms[0].source_url,
    captured_at: "2026-10-19T00:00:00Z",
    http_status: 200,
    sha256: "0".repeat(64),
    fields: [],
  };
  fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify(meta));
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_HASH/);
  meta.sha256 = digest(form());
  meta.synthetic = true;
  fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify(meta));
  assert.throws(() => api.loadSnapshots(dir), /SYNTHETIC_CAPTURE/);
});
test("009b-3 rendered provenance is hash-bound and paths, aliases and handoffs fail closed", () => {
  const source = path.join(__dirname, "fixtures/forms-ci"),
    row = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"))).forms
      .find((r) => r.status === "application");
  const dir = path.join(root, "rendered-inventory");
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(source, row.html), path.join(dir, row.html));
  const save = (rows) =>
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ forms: rows }),
    );
  save([row]);
  const loaded = api.loadSnapshots(dir);
  assert.equal(loaded.real_count, 1);
  assert.equal(loaded.status, "PARTIAL");
  assert.equal(loaded.snapshots[0].rendered, true);
  save([{ ...row, html: "../" + row.html }]);
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_PATH/);
  save([{ ...row, html_sha256: "0".repeat(64) }]);
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_HASH/);
  save([{ ...row, source_url: "https://foreign.example.test/jobs/1" }]);
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_PROVENANCE/);
  save([{ ...row, required: [] }]);
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_PROVENANCE/);
  save([row, { ...row, id: row.id + "-alias" }]);
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_PROVENANCE/);
  save([{
    ...row,
    status: "blocked_403",
    http_status: 403,
    bot_check: ["datadome"],
  }]);
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_HANDOFF/);
  save([row]);
  fs.unlinkSync(path.join(dir, row.html));
  fs.symlinkSync(path.join(source, row.html), path.join(dir, row.html));
  assert.throws(() => api.loadSnapshots(dir), /CAPTURE_SYMLINK/);
});
test("009b-3 stripped React widgets have a named live-page limitation, never a fabricated fill", () => {
  const r = probe("synthetic-widget", {
    snapshot: {
      id: "synthetic-widget",
      synthetic: true,
      rendered: true,
      fields: expectedFields,
    },
  });
  assert.equal(r.status, "blocked");
  assert.equal(r.code, "RENDERED_WIDGET_REQUIRES_LIVE_PAGE");
  assert.ok(r.requires_live_widget.includes("Country"));
  assert.equal(r.review_calls, 0);
  assert.equal(r.submit_calls, 0);
  assert.ok(r.read_back < r.required);
});
test("009b-3 empty containers, invisible anchors and hidden or zero-area frames are not challenges", () => {
  for (
    const id of [
      "synthetic-empty-captcha",
      "synthetic-anchor",
      "synthetic-zero-challenge",
      "synthetic-hidden-challenge",
    ]
  ) {
    const r = probe(id);
    assert.equal(r.status, "prepared", id);
    assert.equal(r.read_back, 4);
    assert.equal(r.resume_verified, true);
    assert.equal(r.submit_calls, 0);
  }
});
test("009b-3 visible hCaptcha and reCAPTCHA challenges and checkbox anchors stop before typing or review", () => {
  for (const id of ["synthetic-challenge", "synthetic-recaptcha", "synthetic-visible-anchor"]) {
    const r = probe(id);
    assert.equal(r.status, "blocked", id);
    assert.equal(r.code, "CAPTCHA_HANDOFF");
    assert.equal(r.fill_calls, 0);
    assert.equal(r.review_calls, 0);
    assert.equal(r.submit_calls, 0);
  }
});
test("009b-3 a missing widget runtime still verifies all answerable native controls", () => {
  const r = probe("synthetic-widget-first", {
    snapshot: {
      id: "synthetic-widget-first",
      synthetic: true,
      rendered: true,
      fields: expectedFields,
    },
  });
  assert.equal(r.code, "RENDERED_WIDGET_REQUIRES_LIVE_PAGE");
  assert.equal(r.native_answerable, 4);
  assert.equal(r.native_bound, 4);
  assert.equal(r.native_read_back, 4);
  assert.equal(r.resume_verified, true);
  assert.equal(r.review_calls, 0);
  assert.equal(r.submit_calls, 0);
});
test("009b-3 149/150 fill and read back all required fields and the exact resume, without submit", async () => {
  const r = probe("synthetic-ready");
  console.log("SYNTHETIC_CONTROL " + JSON.stringify(r));
  assert.equal(r.status, "prepared");
  assert.equal(r.expected_raw, 4);
  assert.equal(r.detected_raw, 4);
  assert.equal(r.required, 4);
  assert.equal(r.bound, 4);
  assert.equal(r.read_back, 4);
  assert.equal(r.ratio, 1);
  assert.equal(r.resume_verified, true);
  assert.equal(r.submit_calls, 0);
  assert.equal(
    (await (await fetch(base + "/__snapshot_stats")).json()).mutations,
    0,
  );
});
test("009b-3 captured native control types match the actual browser controls", () => {
  const fields = expectedFields.map((f) => ({
    ...f,
    type: f.name === "resume"
      ? "file"
      : f.name === "work_authorization"
      ? "select-one"
      : "text",
  }));
  const r = probe("synthetic-ready", {
    snapshot: { id: "synthetic-ready", synthetic: true, fields },
  });
  assert.equal(r.expected_raw, 4);
  assert.equal(r.detected_raw, 4);
  assert.deepEqual(r.undetected, []);
});
test("009b-3 a nameless labeled required control matches once, never by blank identity", () => {
  const extra = {
      name: "",
      label: "Preferred start date",
      type: "date",
      required: true,
    },
    r = probe("synthetic-unnamed", {
      snapshot: {
        id: "synthetic-unnamed",
        synthetic: true,
        fields: [...expectedFields, extra, extra, {
          name: "",
          label: "",
          type: "date",
          required: true,
        }],
      },
    });
  assert.equal(r.expected_raw, 7);
  assert.equal(r.detected_raw, 5);
  assert.equal(r.undetected.length, 2);
  assert.equal(r.status, "awaiting_user");
  assert.ok(r.unknown.includes("Preferred start date"));
  assert.equal(r.review_calls, 0);
  assert.equal(r.submit_calls, 0);
});
test("009b-3 absent final observation cannot reuse cached preparation as equal readback or resume proof", () => {
  const Portal = require("../packages/domain/149-career-portal-apply.js"),
    Browser = require("../packages/domain/150-career-portal-browser.js"),
    run = Portal.runApply,
    create = Browser.createBrowserBoard;
  let returned = false;
  Portal.runApply = (...args) => {
    const r = run(...args);
    returned = true;
    return r;
  };
  Browser.createBrowserBoard = (...args) => {
    const b = create(...args), read = b.answers.bind(b);
    b.answers = () => returned ? {} : read();
    return b;
  };
  try {
    const r = probe("synthetic-ready");
    assert.equal(r.read_back, 0);
    assert.equal(r.resume_verified, false);
    assert.equal(r.ratio, 0);
    assert.equal(r.code, "FINAL_OBSERVATION_INCOMPLETE");
    assert.equal(r.status, "blocked");
    assert.equal(r.submit_calls, 0);
  } finally {
    Portal.runApply = run;
    Browser.createBrowserBoard = create;
  }
});
test("009b-3 unknown required questions stop before review and name the question", () => {
  const r = probe("synthetic-unknown");
  console.log("SYNTHETIC_CONTROL " + JSON.stringify(r));
  assert.equal(r.status, "awaiting_user");
  assert.ok(r.unknown.includes("Favorite programming language"));
  assert.equal(r.review_calls, 0);
  assert.equal(r.submit_calls, 0);
});
test("009b-3 a mismatched resume cannot pass the harness", () => {
  const bad = path.join(root, "wrong-resume.txt");
  fs.writeFileSync(bad, "DIFFERENT SYNTHETIC BYTES");
  assert.throws(
    () => probe("synthetic-ready", { resumePath: bad }),
    (e) => e.code === "RESUME_SHA_MISMATCH",
  );
});
test("009b-3 required source controls missing from the DOM remain visibly unmatched", () => {
  const r = probe("synthetic-ready", {
    snapshot: {
      id: "synthetic-ready",
      synthetic: true,
      fields: [...expectedFields, { name: "missing", required: true }],
    },
  });
  assert.equal(r.expected_raw, 5);
  assert.equal(r.detected_raw, 4);
});
test("009b-3 saved pages cannot navigate synthetic facts outside the fixture origin", () => {
  const r = probe("synthetic-offsite");
  assert.notEqual(r.status, "prepared");
  assert.equal(r.submit_calls, 0);
});
test("009b-3 fixture server refuses mutation and traversal", async () => {
  assert.equal(
    (await fetch(base + "/snapshots/synthetic-ready", {
      method: "POST",
      body: "TEST",
    })).status,
    405,
  );
  assert.equal((await fetch(base + "/snapshots/%2e%2e%2fprivate")).status, 404);
  assert.match(
    (await fetch(base + "/snapshots/synthetic-ready")).headers.get(
      "content-security-policy",
    ),
    /connect-src 'none'/,
  );
});
test("009b-3 employer office preference is never the candidate home address", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  const { defs } = Browser.classifyFields([{
    domIndex: 0,
    selector: "#office",
    tag: "select",
    inputType: "select",
    name: "office",
    id: "office",
    label: "Which location are you applying for?",
    required: true,
    options: [{ label: "New York", value: "ny" }],
  }]);
  assert.equal(defs[0].kind, "unknown");
  assert.equal(defs[0].profile_key, undefined);
});
test("009b-3 an email acknowledgement is explicit consent, never an email value", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  const { defs } = Browser.classifyFields([{
    domIndex: 0,
    selector: "#ack",
    tag: "input",
    inputType: "checkbox",
    name: "ack",
    id: "ack",
    label:
      "I understand that next steps will be sent via email and I have marked the sender address above as safe.",
    required: true,
  }]);
  assert.equal(defs[0].kind, "attestation");
  assert.equal(defs[0].profile_key, undefined);
});
test("009b-3 smartphone ownership is not a contact phone number", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  const { defs } = Browser.classifyFields([{
    domIndex: 0,
    selector: "#phone",
    tag: "input",
    inputType: "radio",
    name: "owns_phone",
    id: "phone",
    label:
      "Do you own a Smartphone that you can use during the rating project?",
    required: true,
  }]);
  assert.equal(defs[0].kind, "unknown");
  assert.equal(defs[0].profile_key, undefined);
});
test("009b-3 residence duration is not the current country name", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  const { defs } = Browser.classifyFields([{
    domIndex: 0,
    selector: "#duration",
    tag: "input",
    inputType: "checkbox",
    name: "residence_duration",
    id: "duration",
    label:
      "How many years have you lived in your current country? (Please choose one)",
    required: true,
  }]);
  assert.equal(defs[0].kind, "unknown");
  assert.equal(defs[0].profile_key, undefined);
});
test("009b-3 government employment never takes an education school fact", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  const { defs } = Browser.classifyFields([{
    domIndex: 0,
    selector: "#government",
    tag: "input",
    inputType: "checkbox",
    name: "government_employment",
    label: "Have you ever been directly employed by (1) any government or military entity, state-owned enterprise, or publicly-funded institution, or (2) a government contractor in a role that recommended Snowflake as part of Government procurement?",
    required: true,
  }]);
  assert.equal(defs[0].kind, "unknown");
  assert.equal(defs[0].profile_key, undefined);
});
test("009b-3 education facts never fill checkbox or radio questions", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  for (const inputType of ["checkbox", "radio"]) {
    for (const label of ["School or university", "Degree", "What is your major?", "What year did you graduate?", "GPA"]) {
      const { defs } = Browser.classifyFields([{
        domIndex: 0, selector: "#education", tag: "input", inputType,
        name: "education", label, required: true,
      }]);
      assert.equal(defs[0].kind, "unknown", inputType + ": " + label);
      assert.equal(defs[0].profile_key, undefined, inputType + ": " + label);
    }
  }
});
test("009b-3 education school is free text and degree can remain a select", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  const classify = (label, inputType, tag) => Browser.classifyFields([{
    domIndex: 0, selector: "#education", tag, inputType, name: "education", label, required: true,
  }]).defs[0];
  assert.equal(classify("School or university", "text", "input").profile_key, "education_school");
  assert.equal(classify("School or university", "select", "select").kind, "unknown");
  assert.equal(classify("Degree", "select", "select").profile_key, "education_degree");
  assert.equal(classify("What is your major?", "select", "select").profile_key, "education_discipline");
  assert.equal(classify("What year did you graduate?", "select", "select").profile_key, "education_graduation_year");
});
test("009b-3 a screening question on a lone checkbox requires a live widget", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  for (const label of ["Are you authorized to work in the US?", "Will you require sponsorship?"]) {
    const { defs, bindings } = Browser.classifyFields([{
      domIndex: 0, selector: "#choice", tag: "input", inputType: "checkbox", name: "choice", label, required: true,
    }]);
    assert.equal(defs[0].kind, "screening");
    assert.equal(bindings[defs[0].field_id].widget, "lone-checkbox");
  }
});
test("009b-3 lone checkbox Yes and No stop without review or submission", () => {
  for (const id of ["synthetic-lone-checkbox-yes", "synthetic-lone-checkbox-no"]) {
    const r = probe(id);
    assert.equal(r.status, "blocked", id);
    assert.equal(r.code, "RENDERED_WIDGET_REQUIRES_LIVE_PAGE", id);
    assert.equal(r.review_calls, 0, id);
    assert.equal(r.submit_calls, 0, id);
    assert.deepEqual(r.native_gaps, [], id);
  }
});
test("009b-3 explicit choice groups keep their option binding", () => {
  const Browser = require("../packages/domain/150-career-portal-browser.js");
  const { defs, bindings } = Browser.classifyFields(["Yes", "No"].map((label, domIndex) => ({
    domIndex, selector: "#option" + domIndex, tag: "input", inputType: "radio", name: "work",
    label, groupLabel: "Are you authorized to work in the US?", required: true,
  })));
  assert.equal(defs.length, 1);
  assert.equal(defs[0].question_key, "work_authorization");
  assert.equal(bindings[defs[0].field_id].inputType, "radio_group");
  assert.ok(!bindings[defs[0].field_id].widget);
});
test("009b-3 real forms preserve the architect's prepared, unknown and runtime stop contracts", () => {
  const inventory = api.loadSnapshots(
    process.env.UPMORE_FORM_SNAPSHOT_ROOT ||
      path.join(__dirname, "fixtures/forms-ci"),
  );
  assert.equal(inventory.real_count, 17);
  const counts = { greenhouse: {}, lever: {}, ashby: {} };
  const failures = [];
  for (const snapshot of inventory.snapshots) {
    const r = api.probeSnapshot({
      url: base + "/snapshots/" + snapshot.id,
      snapshot,
      packet,
      resumePath: resume,
      evidenceDir: root,
    });
    console.log("REAL_FORM " + JSON.stringify(r));
    const outcome = r.code || r.status;
    counts[snapshot.family][outcome] = (counts[snapshot.family][outcome] || 0) +
      1;
    const gaps = [];
    if (r.submit_calls !== 0) gaps.push("submit called");
    if (
      r.native_answerable !== r.native_bound ||
      r.native_answerable !== r.native_read_back
    ) {
      gaps.push(
        "answerable native control lacks equal readback: " +
          JSON.stringify(r.native_gaps),
      );
    }
    if (r.status === "prepared") {
      if (r.ratio < 0.95 || !r.resume_verified) {
        gaps.push("prepared without required readback/resume proof");
      }
    } else if (r.status === "awaiting_user") {
      if (
        !r.unknown.length || r.unknown.some((label) => !label) ||
        r.unknown_required.some((label) => !r.unknown.includes(label))
      ) {
        gaps.push("unknown required question not named");
      }
      if (r.review_calls !== 0) {
        gaps.push("unknown required field reached review");
      }
    } else if (
      r.status !== "blocked" ||
      !["RENDERED_WIDGET_REQUIRES_LIVE_PAGE", "CAPTCHA_HANDOFF"].includes(
        r.code,
      )
    ) {
      gaps.push("unexpected stop: " + outcome);
    }
    if (gaps.length) failures.push(snapshot.id + ": " + gaps.join("; "));
  }
  console.log("REAL_FORM_OUTCOMES " + JSON.stringify(counts));
  console.log("REAL_FORM_FAILURES " + JSON.stringify(failures));
  assert.deepEqual(failures, []);
  // PR25 now sees mandatory Ashby questions; four forms need live Yes/No widgets, and none can claim prepared.
  assert.deepEqual(counts, {
    greenhouse: { RENDERED_WIDGET_REQUIRES_LIVE_PAGE: 5 },
    lever: { awaiting_user: 6 },
    ashby: { RENDERED_WIDGET_REQUIRES_LIVE_PAGE: 4, awaiting_user: 2 },
  });
});
