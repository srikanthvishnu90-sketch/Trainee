"use strict";
// WO-086: trunk's extension/ stays ready for the Chrome Web Store. The same checks scripts/launch/extension-package.sh runs
// on its zip (scripts/launch/extension-package-check.cjs) run here on extension/ as committed, with the file list the zip
// would hold; and each check is shown to refuse what it is for (localhost in the manifest, a service_role key, a .json
// fixture, a file over 1 MB), so a check that stopped working cannot pass silently.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { packageFiles, checkPackage, walk } = require("../scripts/launch/extension-package-check.cjs");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

test("the store package of extension/ passes every check", () => {
  const files = packageFiles(EXT);
  assert.deepEqual(checkPackage(EXT, files), []);
});

test("the package holds the extension's runtime files and none of its sources, build script, README or tests", () => {
  const files = packageFiles(EXT);
  for (const f of ["manifest.json", "background.js", "content.js", "config.js", "panel.html", "panel.js", "panel.css", "lib/trainee-core.js"]) {
    assert.ok(files.includes(f), f + " ships");
  }
  for (const n of [16, 32, 48, 128]) assert.ok(files.includes(`icons/icon-${n}.png`), `icon ${n} ships`);
  assert.ok(!files.some((f) => f.startsWith("src/") || f === "build.ts" || /readme/i.test(f) || /\.map$/.test(f) || /test/i.test(f)));
  assert.ok(!files.some((f) => f.endsWith(".json") && f !== "manifest.json"), "no JSON fixture");
});

test("the icons are real PNGs at their stated sizes", () => {
  for (const [size, rel] of Object.entries(MANIFEST.icons)) {
    const b = fs.readFileSync(path.join(EXT, rel));
    assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", rel);
    assert.equal(b.readUInt32BE(16), Number(size), rel + " width");
    assert.equal(b.readUInt32BE(20), Number(size), rel + " height");
  }
  assert.deepEqual(MANIFEST.action.default_icon, MANIFEST.icons);
});

test("the manifest asks only for what the code uses (WO-086 audit)", () => {
  const code = ["background.js", "content.js", "panel.js"].map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n");
  const perms = MANIFEST.permissions;
  assert.deepEqual([...perms].sort(), ["scripting", "sidePanel", "storage", "unlimitedStorage"]);
  // "tabs" is not requested: <all_urls> already exposes tab.url for the pages the extension reads.
  assert.ok(!perms.includes("tabs"));
  assert.match(code, /chrome\.scripting\.executeScript/);
  assert.match(code, /chrome\.sidePanel/);
  assert.match(code, /chrome\.storage\.(local|session)|storage\.local/);
  // Host access stays <all_urls> while the proof screenshot is taken with captureVisibleTab (WO-063/1).
  if (code.includes("captureVisibleTab")) assert.deepEqual(MANIFEST.host_permissions, ["<all_urls>"]);
  assert.ok(MANIFEST.description.length <= 132);
  assert.match(MANIFEST.description, /Workday/, "the description names every family it fills");
});

function fixture(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wo086-pkg-"));
  for (const f of packageFiles(EXT)) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(EXT, f), path.join(dir, f));
  }
  mutate(dir);
  try {
    return checkPackage(dir, walk(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const manifestEdit = (dir, fn) => {
  const p = path.join(dir, "manifest.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  fn(m);
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
};

test("each check refuses what it is for", () => {
  const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), "expected " + re + " in " + JSON.stringify(problems));
  has(fixture((d) => manifestEdit(d, (m) => m.host_permissions.push("http://localhost:3000/*"))), /localhost/);
  has(fixture((d) => manifestEdit(d, (m) => m.host_permissions.push("http://127.0.0.1/*"))), /127\.0\.0\.1/);
  // A key whose JWT role is service_role, built here (never a real key), and the bare word.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const fake = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role: "service_role" })}.${"x".repeat(43)}`;
  has(fixture((d) => fs.appendFileSync(path.join(d, "config.js"), `\nconst k = "${fake}";\n`)), /role "service_role"/);
  has(fixture((d) => fs.appendFileSync(path.join(d, "panel.js"), "\n// service_role\n")), /service_role/);
  has(fixture((d) => fs.writeFileSync(path.join(d, "answer-bank.alex-testcase.json"), "{}")), /no JSON file other than manifest/);
  has(fixture((d) => fs.writeFileSync(path.join(d, "big.js"), Buffer.alloc(1024 * 1024 + 1, 32))), /over 1 MB/);
  has(fixture((d) => manifestEdit(d, (m) => (m.web_accessible_resources = [{ resources: ["x.json"], matches: ["<all_urls>"] }]))), /web_accessible_resources/);
  has(fixture((d) => fs.appendFileSync(path.join(d, "background.js"), '\nfetch(u + "/auth/v1/token?grant_type=password");\n')), /password grant/);
  has(fixture((d) => fs.appendFileSync(path.join(d, "panel.js"), "\neval(x);\n")), /evaluates strings as code/);
  has(fixture((d) => fs.rmSync(path.join(d, "icons/icon-48.png"))), /icons\/icon-48\.png is referenced/);
  has(fixture((d) => fs.writeFileSync(path.join(d, "README.md"), "x")), /must not ship/);
});

// Owner rule (back off, then RESUME; 20261029180000/20261029190000): a posting already in the queue may be approved and
// waiting (a site that asked us to slow down, a claim not started yet), never sent. Approving it again in the extension
// says what the chat and the card say: it is already in the person's applications (sent, or approved and waiting to go),
// never "You already applied", which would be untrue for one still waiting.
test("the extension's answer to approving a queued posting again matches the chat's: already in your applications, never 'already applied'", () => {
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const branch = bg.match(/\/duplicate_job\/\.test\(e\.message\)[\s\S]*?\?\s*("[^"]*")/);
  assert.ok(branch, "the duplicate_job branch is there");
  const said = JSON.parse(branch[1]);
  assert.match(said, /already in your applications \(sent, or approved and waiting to go\)/);
  assert.match(said, /each posting goes at most once/);
  assert.doesNotMatch(bg, /already applied to this posting/i);
});
