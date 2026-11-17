"use strict";
// Teamtailor's upload script stores the chosen resume and writes where it stored it into a box of the form,
// candidate[resume_remote_url] (answered run of 2026-11-16: 9 Teamtailor postings stopped on it as "set by the page, not confirmed
// by you"). That box carries the approved resume itself only on positive evidence that this run's file set put it there (delta
// review of rs-05, default-deny): the box was empty just before the file was set, the file was then sent to the host the address
// names, and the address ends in the file's own name. Anything else the page puts there is still asked. Local page and mock employer.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../workers/career-browser/parallel-apply.cjs");

let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const skip = pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH";
// A form whose resume box holds `prefill` at load, and whose page script is `js`. up(host) sends the chosen file to that host as a
// board's upload script does (multipart, the file's own name); the request fails (no such host), what the page writes is the same.
const STALE = "https://attacker-or-stale.example/someone-else/Casey-Example-Resume.pdf";
const BOX = "[name='candidate[resume_remote_url]']";
const form = (prefill, js) => `<!doctype html><html><body><h1>Apply</h1><form id="f" action="/applications" method="post">
<label>First name <input name="candidate[first_name]" required></label><label>Last name <input name="candidate[last_name]" required></label>
<label>Email <input type="email" name="candidate[email]" required></label>
<label>Resume <input type="file" id="cv" name="candidate[resume]"></label>
${prefill === null ? "" : `<input type="text" name="candidate[resume_remote_url]" value="${prefill}" style="position:absolute;left:-9999px" tabindex="-1" aria-hidden="true">`}
<button type="submit">Send application</button></form><script>
const up = (host, file) => { const d = new FormData(); d.append("key", "uploads/7f3a/" + file.name); d.append("file", file); return fetch("https://" + host + "/", { method: "POST", body: d }).catch(() => {}); };
const onFile = (fn) => document.getElementById("cv").addEventListener("change", (e) => fn(e.target.files[0]));
${js}
</script></body></html>`;
// The board's own flow: the chosen file is sent to its storage, then the stored address is written into the box.
const stores = (address) => `onFile((f) => up("storage.example", f).then(() => { document.querySelector("${BOX}").value = ${JSON.stringify(address)}.replace("{name}", f.name); }));`;
const PAGES = {
  own: form("", stores("https://storage.example/uploads/7f3a/{name}")),
  other: form("", stores("https://storage.example/uploads/7f3a/someone-else.pdf")),
  // Review probe p05-resume-url-stale: the page itself puts another file's address there at load; this run's upload leaves it.
  stale: form(STALE, `onFile((f) => up("storage.example", f));`),
  // Delta review probe p05-resume-url-variants: the box empty at load, then set by the page in ways the file set did not cause.
  "late-set-after-load": form("", `onFile((f) => up("storage.example", f)); setTimeout(() => { document.querySelector("${BOX}").value = ${JSON.stringify(STALE)}; }, 1500);`),
  "set-on-first-input": form("", `onFile((f) => up("storage.example", f)); document.addEventListener("input", () => { document.querySelector("${BOX}").value = ${JSON.stringify(STALE)}; }, { once: true, capture: true });`),
  "created-later": form(null, `onFile((f) => up("storage.example", f)); setTimeout(() => { const i = document.createElement("input"); i.type = "text"; i.name = "candidate[resume_remote_url]"; i.value = "https://storage.example/uploads/7f3a/Casey-Example-Resume.pdf"; i.style.cssText = "position:absolute;left:-9999px"; document.getElementById("f").appendChild(i); }, 800);`),
  "prefilled-emptied-refilled": form("https://storage.example/uploads/old/Casey-Example-Resume.pdf", `onFile((f) => { const b = document.querySelector("${BOX}"); const was = b.value; b.value = ""; up("storage.example", f).then(() => { b.value = was; }); });`),
  // the file went to the board's storage, but the address names another host
  "third-party-host": form("", `onFile((f) => up("storage.example", f).then(() => { document.querySelector("${BOX}").value = "https://attacker-or-stale.example/x/" + f.name; }));`),
  // the address is written on the file change, but the file was never sent anywhere
  "written-without-upload": form("", `onFile((f) => { document.querySelector("${BOX}").value = "https://storage.example/uploads/7f3a/" + f.name; });`),
  // a file of that name was sent to that host by the page at load, before this run set the resume
  "upload-before-set": form("", `up("storage.example", new File(["x"], "Casey-Example-Resume.pdf", { type: "application/pdf" })); onFile((f) => { document.querySelector("${BOX}").value = "https://storage.example/uploads/7f3a/" + f.name; });`),
  // Second delta review of rs-05 (2026-11-17): two boxes of the box's name, one holding a stale address at load (and, in -b, the
  // other written with the storage address after this run's upload). Evidence is per element: two boxes of one name are asked.
  "dup-name": form("https://storage.example/uploads/old/Casey-Example-Resume.pdf", `onFile((f) => up("storage.example", f));`).replace('<button type="submit">', '<input type="text" name="candidate[resume_remote_url]" value="" style="position:absolute;left:-9999px" tabindex="-1" aria-hidden="true"><button type="submit">'),
  "dup-name-b": form("https://storage.example/uploads/old/Casey-Example-Resume.pdf", `onFile((f) => up("storage.example", f).then(() => { document.querySelectorAll("${BOX}")[1].value = "https://storage.example/uploads/7f3a/" + f.name; }));`).replace('<button type="submit">', '<input type="text" name="candidate[resume_remote_url]" value="" style="position:absolute;left:-9999px" tabindex="-1" aria-hidden="true"><button type="submit">'),
};
let server, base, browser, resume, rsha;
const posts = [];
before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    if (req.method === "POST") { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { posts.push({ url: req.url, body: Buffer.concat(c).toString() }); res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying</h1>"); }); return; }
    const k = req.url.slice(1);
    if (PAGES[k]) return res.writeHead(200, { "content-type": "text/html" }).end(PAGES[k]);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rurl-")), "Casey-Example-Resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); rsha = sha256(fs.readFileSync(resume));
  browser = await pw.chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const job = (k) => { const p = { id: k, ats: "teamtailor", url: `${base}/${k}`, facts: { first_name: "Casey", last_name: "Example", email: "casey@example.invalid" }, answers: {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } }; p.approval = { approval_id: "a-" + k, hash: payloadHash(p) }; return p; };

test("the box holding the stored resume's own address is the resume, not a page default: sent once", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("own"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "submitted_page_confirmed", JSON.stringify(r));
  assert.equal(posts.length - n, 1);
});
test("another file's address in that box is still asked; nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("other"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.ok((r.needs || []).some((x) => /set by the page/.test(x.detail || "")), JSON.stringify(r.needs));
  assert.equal(posts.length, n);
});

test("an address the page put in that box at load is never the resume, even with the approved file's name: asked, nothing sent", { skip, timeout: 60000 }, async () => {
  const n = posts.length;
  const r = await applyOne(browser, job("stale"), { stepTimeoutMs: 8000, retries: 0 });
  assert.equal(r.status, "not_submitted", JSON.stringify(r));
  assert.ok((r.needs || []).some((x) => /set by the page/.test(x.detail || "")), JSON.stringify(r.needs));
  assert.equal(posts.length, n);
});

for (const k of ["late-set-after-load", "set-on-first-input", "created-later", "prefilled-emptied-refilled", "third-party-host", "written-without-upload", "upload-before-set", "dup-name", "dup-name-b"]) {
  test(`delta review of rs-05, ${k}: an address the file set did not put there is never the resume: asked, nothing sent`, { skip, timeout: 60000 }, async () => {
    const n = posts.length;
    const r = await applyOne(browser, job(k), { stepTimeoutMs: 8000, retries: 0 });
    assert.equal(r.status, "not_submitted", JSON.stringify(r));
    assert.ok((r.needs || []).some((x) => /set by the page/.test(x.detail || "")), JSON.stringify(r.needs));
    assert.equal(posts.length, n);
  });
}
