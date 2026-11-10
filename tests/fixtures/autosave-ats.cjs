"use strict";
// x-audit (D-MS-1, 2026-11-10): a mock employer form that autosaves every field AS IT IS TYPED, the way Ashby's
// ApiSetFormValue mutation does, over every channel a page has: a GraphQL mutation, a plain fetch POST, a sendBeacon, a
// WebSocket message and a GET pixel. The server counts every receipt that carries a value typed into the form, by channel.
// Before the person's yes the count of receipts carrying a typed value, on ANY channel, must be 0 (coordinator ruling).
// Test only: listens on 127.0.0.1, never contacts anything.
const http = require("node:http");
const crypto = require("node:crypto");

const PAGE = (port) => `<!doctype html><html><head><meta charset="utf-8"><title>Mock autosave form</title></head><body>
<h1>Software Engineer Intern</h1><p>MOCK AUTOSAVE ATS (test fixture, not a real employer)</p>
<form id="application-form" method="post" action="/submit" enctype="multipart/form-data">
<label for="first_name">First Name *</label><input id="first_name" name="first_name" type="text" required>
<label for="last_name">Last Name *</label><input id="last_name" name="last_name" type="text" required>
<label for="email">Email *</label><input id="email" name="email" type="email" required>
<label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required>
<button type="submit">Submit Application</button></form>
<script>
(function(){
  var ws = null;
  try { ws = new WebSocket("ws://127.0.0.1:${port}/ws"); } catch (e) {}
  function save(name, value) {
    if (!value) return;
    var gql = { operationName: "ApiSetFormValue", variables: { field: name, value: value },
      query: "mutation ApiSetFormValue($field: String!, $value: String!) { setFormValue(field: $field, value: $value) { ok } }" };
    fetch("/api/non-user-graphql?op=ApiSetFormValue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(gql) }).catch(function(){});
    fetch("/autosave", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: name + "=" + encodeURIComponent(value) }).catch(function(){});
    try { navigator.sendBeacon("/beacon", name + "=" + value); } catch (e) {}
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ field: name, value: value })); } catch (e) {}
    new Image().src = "/pixel?" + name + "=" + encodeURIComponent(value);
  }
  // A file input's value is the browser's "C:\\fakepath\\..." placeholder, not something typed: not autosaved here.
  document.addEventListener("input", function (e) { if (e.target && e.target.name && e.target.type !== "file") save(e.target.name, e.target.value); }, true);
  document.addEventListener("change", function (e) { if (e.target && e.target.name && e.target.type !== "file") save(e.target.name, e.target.value); }, true);
})();
</script></body></html>`;

// One WebSocket frame from a client (masked, payload < 64 KiB), decoded to text.
function frames(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f, masked = buf[i + 1] & 0x80;
    let len = buf[i + 1] & 0x7f, p = i + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; } else if (len === 127) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (p + len > buf.length) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let k = 0; k < data.length; k++) data[k] ^= mask[k % 4];
    if (op === 1) out.push(data.toString("utf8"));
    i = p + len;
  }
  return out;
}

async function startAutosaveAts({ typed = [] } = {}) {
  const receipts = []; // { channel, method, path, body }
  const carries = (s) => typed.some((v) => v && s.includes(v));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      const u = new URL(req.url, "http://x");
      const raw = decodeURIComponent(u.search + " " + body.replace(/\+/g, " "));
      const channel = u.pathname.startsWith("/api/non-user-graphql") ? "graphql_mutation" : u.pathname === "/autosave" ? "fetch_post"
        : u.pathname === "/beacon" ? "beacon" : u.pathname === "/pixel" ? "get_pixel" : u.pathname === "/submit" ? "submit" : null;
      if (channel) receipts.push({ channel, method: req.method, path: u.pathname, raw: raw.slice(0, 2000), carries: carries(raw) });
      if (req.method === "GET" && (u.pathname === "/" || u.pathname.startsWith("/greenhouse/") || u.pathname === "/form")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(PAGE(server.address().port));
      }
      if (u.pathname === "/submit") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1 id=confirmation>Thank you for applying</h1>"); }
      res.writeHead(u.pathname === "/pixel" ? 204 : 200, { "content-type": "application/json" });
      res.end(u.pathname === "/pixel" ? undefined : "{}");
    });
  });
  const sockets = new Set();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (b) => { for (const t of frames(b)) receipts.push({ channel: "websocket", method: "WS", path: "/ws", raw: t.slice(0, 2000), carries: carries(t) }); });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, receipts,
    // Receipts that are not a plain GET: the ones D-MS-1 forbids before the yes.
    writes: () => receipts.filter((r) => r.carries && r.channel !== "get_pixel" && r.channel !== "submit"),
    // Every receipt that carries a typed value, on any channel (GET pixel included): the D-MS-1 bar before the yes.
    anyChannel: () => receipts.filter((r) => r.carries && r.channel !== "submit"),
    byChannel: () => receipts.filter((r) => r.carries).reduce((a, r) => ((a[r.channel] = (a[r.channel] || 0) + 1), a), {}),
    // An upgraded socket is not one of the server's connections: destroyed here, or close() would wait for it forever.
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(r); }),
  };
}

module.exports = { startAutosaveAts };
