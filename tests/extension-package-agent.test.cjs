"use strict";
// scripts/extension/package.sh: the folder + zip the owner loads in his own Chrome. The agent variant has only
// agentSubmits on; the shipped variant is extension/'s package files byte for byte (plus BUILD-INFO.txt); a stale bundle
// is refused; a config.js the agent replacement cannot change exactly is refused; the repository's extension/config.js
// is never written. The refusals run the same script in a scratch copy of the files it and the bundle read.
// Google verification (review of #196): the agent variant is refused while the privacy policy says the extension "never
// submits an application for you". The agent package is therefore built from a scratch copy whose policy template no
// longer makes that claim (what the owner would have to do first); the real repository's agent build is refused.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { packageFiles } = require("../scripts/launch/extension-package-check.cjs");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const VERSION = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).version;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const CONFIG_BEFORE = sha(fs.readFileSync(path.join(EXT, "config.js")));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frs-pkg-"));
const run = (root, ...args) => spawnSync("bash", [path.join(root, "scripts/extension/package.sh"), ...args], { cwd: os.tmpdir(), encoding: "utf8" });
const defaults = (text) => {
  const s = {};
  s.globalThis = s;
  vm.runInNewContext(text, s);
  return JSON.parse(JSON.stringify(s.TRAINEE_DEFAULTS));
};
const walk = (dir, base = dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  }).sort();
const unzipList = (zip) => spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" }).stdout.trim().split("\n").sort();
const unzipFile = (zip, f) => spawnSync("unzip", ["-p", zip, f]).stdout;

const TEMPLATE = "docs/launch/legal-pages/privacy.template.html", CLAIM = "never submits an application for you";
let shipped, agent, agentRepo;
before(() => {
  shipped = run(ROOT, "--variant", "shipped", "--out", path.join(tmp, "out"));
  agentRepo = scratchRepo();
  agent = run(agentRepo, "--variant", "agent", "--out", path.join(tmp, "out"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dirOf = (v) => path.join(tmp, "out", `trainee-extension-${VERSION}-${v}`);
const zipOf = (v) => dirOf(v) + ".zip";

test("both variants build, print the zip's sha256 and the commit, and hold a BUILD-INFO.txt", () => {
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  // The agent package comes from the scratch copy (not a git checkout), so its commit is said to be unknown.
  for (const [v, r, commit] of [["shipped", shipped, head], ["agent", agent, "unknown (not a git checkout)"]]) {
    assert.equal(r.status, 0, v + ": " + r.stderr);
    assert.match(r.stdout, /extension\/lib\/trainee-core\.js is fresh/);
    assert.equal(/sha256: ([0-9a-f]{64})/.exec(r.stdout)?.[1], sha(fs.readFileSync(zipOf(v))), v + " printed sha256");
    assert.ok(r.stdout.includes("commit: " + commit), v + " printed commit");
    const info = fs.readFileSync(path.join(dirOf(v), "BUILD-INFO.txt"), "utf8");
    assert.ok(info.includes("commit: " + commit));
    assert.match(info, new RegExp(`^variant: ${v}$`, "m"));
    assert.match(info, /^flags: personSubmits=false agentSubmits=(true|false)$/m);
    assert.match(info, /^built: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
    assert.ok(!/eyJ|service_role|secret|password/i.test(info), "no key or secret in BUILD-INFO");
    // The zip holds exactly the folder's files, byte for byte, at its root.
    assert.deepEqual(unzipList(zipOf(v)), walk(dirOf(v)));
    for (const f of walk(dirOf(v))) assert.ok(unzipFile(zipOf(v), f).equals(fs.readFileSync(path.join(dirOf(v), f))), v + " zip " + f);
  }
});

test("the agent variant has agentSubmits true, personSubmits false, and nothing else changed", () => {
  const src = fs.readFileSync(path.join(EXT, "config.js"), "utf8");
  const out = fs.readFileSync(path.join(dirOf("agent"), "config.js"), "utf8");
  const a = defaults(out), s = defaults(src);
  assert.equal(a.agentSubmits, true);
  assert.equal(a.personSubmits, false);
  assert.deepEqual({ ...a, agentSubmits: s.agentSubmits }, s);
  const x = src.split("\n"), y = out.split("\n");
  assert.equal(x.length, y.length);
  assert.deepEqual(y.filter((l, i) => l !== x[i]).map((l) => l.trim()), ["agentSubmits: true,"]);
  for (const f of packageFiles(EXT)) {
    if (f !== "config.js") assert.ok(fs.readFileSync(path.join(dirOf("agent"), f)).equals(fs.readFileSync(path.join(EXT, f))), f);
  }
  assert.match(fs.readFileSync(path.join(dirOf("agent"), "BUILD-INFO.txt"), "utf8"), /^flags: personSubmits=false agentSubmits=true$/m);
});

test("the shipped variant is extension/'s package files byte for byte, plus BUILD-INFO.txt only", () => {
  const want = packageFiles(EXT);
  assert.deepEqual(walk(dirOf("shipped")), [...want, "BUILD-INFO.txt"].sort());
  for (const f of want) assert.ok(fs.readFileSync(path.join(dirOf("shipped"), f)).equals(fs.readFileSync(path.join(EXT, f))), f);
  const c = defaults(fs.readFileSync(path.join(dirOf("shipped"), "config.js"), "utf8"));
  assert.equal(c.agentSubmits, false);
  assert.equal(c.personSubmits, false);
});

test("the repository's extension/config.js is unchanged after the runs", () => {
  assert.equal(sha(fs.readFileSync(path.join(EXT, "config.js"))), CONFIG_BEFORE);
  const d = spawnSync("git", ["-C", ROOT, "diff", "--quiet", "--", "extension/config.js"]);
  assert.equal(d.status, 0, "git sees no change to extension/config.js");
});

// A scratch copy of exactly what the script and the bundle read (the bundle's module graph, from deno info), plus the
// privacy policy template, by default with the "never submits" claim changed (claim: true keeps it as committed).
function scratchRepo({ claim = false } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
  const info = JSON.parse(spawnSync("deno", ["info", "--json", "extension/src/core.ts"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }).stdout);
  const prefix = "file://" + ROOT + "/";
  const rels = info.modules.map((m) => m.specifier).filter((s) => s.startsWith(prefix)).map((s) => decodeURIComponent(s.slice(prefix.length)));
  assert.ok(rels.length > 5, "the bundle's module graph was read");
  for (const rel of [...rels, ...walk(EXT).map((f) => "extension/" + f), "scripts/launch/extension-package-check.cjs",
    "scripts/extension/package.sh", "scripts/extension/variant.cjs"]) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  const policy = fs.readFileSync(path.join(ROOT, TEMPLATE), "utf8");
  assert.ok(policy.includes(CLAIM), "the committed policy makes the claim");
  fs.mkdirSync(path.join(dir, path.dirname(TEMPLATE)), { recursive: true });
  fs.writeFileSync(path.join(dir, TEMPLATE), claim ? policy : policy.replaceAll(CLAIM, "submits only a batch you approved"));
  return dir;
}

test("the agent variant is refused while the privacy policy says the extension never submits an application", () => {
  // The repository as committed: the policy makes the claim, so no agent package is made.
  const out = path.join(tmp, "out-real-agent");
  const r = run(ROOT, "--variant", "agent", "--out", out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused: the privacy policy \(docs\/launch\/legal-pages\/privacy\.template\.html\) says the extension "never submits an application for you"/);
  assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0, "nothing written");
  // The same in a scratch copy that keeps the claim, in a built site/privacy.html, or with no policy to check.
  const kept = scratchRepo({ claim: true });
  assert.notEqual(run(kept, "--variant", "agent", "--out", path.join(kept, "o1")).status, 0, "the template's claim");
  const built = scratchRepo();
  fs.mkdirSync(path.join(built, "site"), { recursive: true });
  fs.writeFileSync(path.join(built, "site/privacy.html"), "<li>It " + CLAIM + ".</li>");
  const b = run(built, "--variant", "agent", "--out", path.join(built, "o2"));
  assert.notEqual(b.status, 0, "the published page's claim");
  assert.match(b.stderr, /site\/privacy\.html/);
  const none = scratchRepo();
  fs.rmSync(path.join(none, TEMPLATE));
  const n = run(none, "--variant", "agent", "--out", path.join(none, "o3"));
  assert.notEqual(n.status, 0, "no policy to check");
  assert.match(n.stderr, /privacy policy template to check/);
  // The shipped variant is never affected by the policy check.
  assert.equal(run(kept, "--variant", "shipped", "--out", path.join(kept, "o4")).status, 0, "shipped still packages");
});

test("a stale bundle is refused and nothing is written; the same copy, fresh, packages", () => {
  const repo = scratchRepo();
  const fresh = run(repo, "--variant", "shipped", "--out", path.join(repo, "out-fresh"));
  assert.equal(fresh.status, 0, "control: the scratch copy packages while fresh: " + fresh.stderr);
  fs.appendFileSync(path.join(repo, "extension/lib/trainee-core.js"), "\n// edited by hand\n");
  for (const v of ["shipped", "agent"]) {
    const r = run(repo, "--variant", v, "--out", path.join(repo, "out-stale"));
    assert.notEqual(r.status, 0, v);
    assert.match(r.stderr, /stale/);
    assert.deepEqual(fs.readdirSync(path.join(repo, "out-stale")), [], "no folder or zip written");
  }
});

test("the agent variant is refused when the one replacement cannot happen exactly", () => {
  const repo = scratchRepo();
  const cfg = path.join(repo, "extension/config.js");
  const orig = fs.readFileSync(cfg, "utf8");
  for (const [why, text] of [
    ["no agentSubmits: false line", orig.replace("agentSubmits: false,", "agentSubmits:false ,")],
    ["two of them", orig.replace("agentSubmits: false,", "agentSubmits: false,\n  agentSubmits: false,")],
  ]) {
    fs.writeFileSync(cfg, text);
    const r = run(repo, "--variant", "agent", "--out", path.join(repo, "out-" + why.replace(/\W+/g, "-")));
    assert.notEqual(r.status, 0, why);
    assert.match(r.stderr, /refused/, why);
    assert.deepEqual(fs.readdirSync(path.join(repo, "out-" + why.replace(/\W+/g, "-"))), [], why + ": nothing written");
    assert.equal(fs.readFileSync(cfg, "utf8"), text, why + ": the source config.js is not written");
  }
  // A shipped build with a flag on is not "shipped".
  fs.writeFileSync(cfg, orig.replace("personSubmits: false,", "personSubmits: true,"));
  const r = run(repo, "--variant", "shipped", "--out", path.join(repo, "out-flag-on"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /personSubmits=true/);
});

test("an unknown variant or a missing --out is refused", () => {
  assert.notEqual(run(ROOT, "--variant", "store", "--out", path.join(tmp, "x")).status, 0);
  assert.notEqual(run(ROOT, "--variant", "agent").status, 0);
});
