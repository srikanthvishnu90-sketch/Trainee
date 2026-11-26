"use strict";
// Round 2 (review of #818): one local server and one Chromium for the engine's adversarial pages. Every page carries a recorder
// (capture phase) that reports each click on a pressable thing and each input/change event to the server by a synchronous
// request, so "nothing pressed, nothing typed, nothing sent" is read from the server, never from the runner's own word.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { applyOne, payloadHash, sha256 } = require("../../../workers/career-browser/parallel-apply.cjs");
const { recheck } = require("../../../workers/career-browser/handoff.cjs");
let pw = null;
for (const id of [process.env.UPMORE_PLAYWRIGHT_PATH, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(id); break; } catch { /* next */ } }
const REC = `<script>(function(){function b(k){try{var x=new XMLHttpRequest();x.open('GET','/beacon/'+encodeURIComponent(k),false);x.send();}catch(e){}}
function nm(t){return (t.getAttribute&&(t.getAttribute('data-k')||t.name||t.id))||((t.innerText||t.value||'')+'').trim().slice(0,40)||t.tagName}
document.addEventListener('click',function(e){var p=e.target.closest?e.target.closest('button,a,[role=button],input[type=submit],input[type=button],[data-check]'):null;if(p)b('click:'+nm(p));},true);
document.addEventListener('input',function(e){b('input:'+nm(e.target));},true);})();</script>`;
const F3 = `<label>First Name <input name="first_name" required></label><label>Last Name <input name="last_name" required></label><label>Email <input name="email" type="email" required></label>`;
const F = `${F3}<label>Resume <input type="file" name="resume"></label>`;
const SUB = `<button type="submit">Submit application</button>`;
const doc = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${REC}<h1>${title}</h1>${body}</body></html>`;
const st = { pages: {}, after: {}, dyn: {}, posts: [], beacons: [], hits: [], ws: [], base: "" };
function fieldsOf(buf, ct) {
  const s = buf.toString("latin1"), o = {};
  if (/multipart/.test(ct || "")) { const re = /name="([^"]*)"(?:; filename="([^"]*)")?\r\n(?:Content-Type:[^\r\n]*\r\n)?\r\n([\s\S]*?)\r\n--/g; let m; while ((m = re.exec(s))) o[m[1]] = m[2] !== undefined ? `file:${m[2]}` : m[3]; }
  else for (const [k, v] of new URLSearchParams(s)) o[k] = v;
  return o;
}
async function start() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), html = (s, code = 200) => res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(s);
    if (u.pathname.startsWith("/beacon/")) { st.beacons.push(decodeURIComponent(u.pathname.slice(8))); return res.writeHead(204).end(); }
    if (req.method !== "GET") {
      const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
        st.posts.push({ path: u.pathname, fields: fieldsOf(Buffer.concat(chunks), req.headers["content-type"]) });
        const key = u.pathname.replace(/\/submit$/, ""), after = st.after[key] || (st.dyn[key] && st.dyn[key].after);
        return after ? after(req, res, html) : html("<h1>Thank you for applying</h1>");
      }); return;
    }
    st.hits.push(req.url);
    if (st.dyn[u.pathname] && st.dyn[u.pathname].get) return st.dyn[u.pathname].get(req, res, html, u);
    const pg = st.pages[u.pathname];
    return pg ? html(typeof pg === "function" ? pg() : pg) : res.writeHead(404).end("nf");
  });
  // A WebSocket that logs every text message it receives (RFC 6455: the handshake, then masked frames from the client).
  server.on("upgrade", (req, sock) => {
    const key = req.headers["sec-websocket-key"]; if (!key) return sock.destroy();
    const accept = require("node:crypto").createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) break;
        const mask = buf.slice(off, off + 4), data = Buffer.from(buf.slice(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
        if ((buf[0] & 15) === 1) st.ws.push(data.toString("utf8"));
        buf = buf.slice(off + 4 + len);
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  st.base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "round2-"));
  const resume = path.join(dir, "resume.pdf"); fs.writeFileSync(resume, "%PDF-1.4 TEST\n"); const rsha = sha256(fs.readFileSync(resume));
  const browser = await pw.chromium.launch({ headless: true, chromiumSandbox: process.env.UPMORE_CHROMIUM_SANDBOX !== "off", ...(process.env.UPMORE_CHROMIUM_PATH ? { executablePath: process.env.UPMORE_CHROMIUM_PATH } : {}) });
  const FACTS = { first_name: "Casey", last_name: "Example", email: "casey@example.invalid", phone: "+1 415 555 0100", country: "United States", website_url: "https://casey.example.invalid", current_company: "Acme" };
  const job = (p0, x = {}) => { const p = { id: "r2" + p0.replace(/\W/g, "-"), ats: "greenhouse", url: st.base + p0, facts: { ...FACTS, ...(x.facts || {}) }, answers: x.answers || {}, resume: { path: resume, sha256: rsha, preparedWithSha256: rsha } }; p.approval = { approval_id: "appr-r2", hash: payloadHash(p) }; return p; };
  const reset = () => { st.posts.length = 0; st.beacons.length = 0; st.hits.length = 0; st.ws.length = 0; };
  const view = (r) => ({ r, posts: st.posts.slice(), clicks: st.beacons.filter((k) => k.startsWith("click:")).map((k) => k.slice(6)), hits: st.hits.slice(), ws: st.ws.slice(), typed: [...new Set(st.beacons.filter((k) => k.startsWith("input:")).map((k) => k.slice(6)))] });
  const run = async (p0, x = {}) => { reset(); const phases = []; const r = await applyOne(browser, job(p0, x), { stepTimeoutMs: 6000, retries: 0, checkSettleMs: x.settle ?? 300, onPhase: async (ph) => { phases.push(ph); if (x.beat) await new Promise((d) => setTimeout(d, x.beat)); }, ...(x.opts || {}) }); return { ...view(r), phases }; };
  const rc = async (p0, x = {}, yes) => { if (!x.keep) reset(); const out = await recheck(browser, job(p0, x), { stepTimeoutMs: 6000, checkSettleMs: 300, ...(yes ? { yes } : {}) }); return { out, posts: st.posts.slice() }; };
  const stop = async () => { await browser.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); };
  return { run, rc, stop };
}
module.exports = { start, st, doc, F, F3, SUB, skip: pw ? false : "PLAYWRIGHT_UNRESOLVABLE: set UPMORE_PLAYWRIGHT_PATH" };
