// Discovery default deny, class by class (coordinator review of 8cf8de8d): for each way a page can send something, the
// employer's own server (and another origin's) is the witness, never the engine's record of what it stopped. Every case
// below runs after the engine has put the person's first value into the page, and sends that value.
//   socket   opened before the first value and sending after it; opened after it, with the value in its address
//   workers  a web worker, a shared worker, a service worker
//   frames   a same-origin frame and a cross-site frame (localhost in a 127.0.0.1 page: its own process under site
//            isolation), each sending what the page passed it, at once and when it goes
//   redirect a read the page started before the first value, whose redirect is followed after it
//   hints    prefetch, preconnect and dns-prefetch links added with the value
//   leaving  pagehide, beforeunload, unload and visibilitychange senders, in the page and in each frame, with keepalive
//            and beacon, and a deferred fetchLater: all sent when the page goes, at the engine's teardown
//   form     a form sent by GET, and a link with ping (their own run: each leaves the page)
// What the browser cannot be made to stop is said in DISCOVERY-DEFAULT-DENY-2026-10-24.md, not claimed here.
import assertNode from "node:assert/strict";
import { engineRunner } from "../../workers/career-browser/approve-first.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const VALUE = "Wyxlene";
const FACTS = {
  user_id: "7b0f8f8e-6a43-4a49-9d2c-0000000000d3",
  answers: Object.fromEntries(Object.entries({ first_name: VALUE, last_name: "Tester", email: "wyxlene.tester@example.test" }).map(([k, v], i) =>
    [k, { value: v, factId: `CLASS-TEST-FACT-${i + 1}`, confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-class" }])),
};

function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try {
    Deno.statSync(`${ROOT}/tools/node_modules/playwright`);
    Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`);
    return true;
  } catch {
    return false;
  }
}

// A server that logs everything that reaches it: requests (path, query, body), socket handshakes and socket frames.
function server(pages: Record<string, (s: { base: string; other: string }) => string>, other = "") {
  const log: string[] = [];
  let base = "";
  const s = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      log.push(`WS-OPEN ${u.pathname}${u.search}`);
      socket.onmessage = (e) => log.push(`WS-FRAME ${u.pathname} ${String(e.data)}`);
      return response;
    }
    const body = req.body ? new TextDecoder().decode(await req.arrayBuffer()) : "";
    log.push(`${req.method} ${u.pathname}${u.search}${body ? ` BODY ${body}` : ""}`);
    if (u.pathname === "/slow-start") { await new Promise((ok) => setTimeout(ok, 1500)); return new Response(null, { status: 302, headers: { location: "/apply?redirect-landing=1" } }); }
    if (u.pathname === "/sw.js") return new Response(`self.addEventListener("message", (e) => fetch("${base}/sw-leak?v=" + e.data));`, { headers: { "content-type": "text/javascript" } });
    const page = pages[u.pathname];
    if (page) return new Response(page({ base, other }), { headers: { "content-type": "text/html", "access-control-allow-origin": "*" } });
    return Response.json({ ok: true }, { headers: { "access-control-allow-origin": "*" } });
  });
  base = `http://127.0.0.1:${(s.addr as Deno.NetAddr).port}`;
  return { get base() { return base; }, log, close: () => s.shutdown() };
}

const FIELDS = `<label for="first">First name</label><input name="first_name" id="first" required>
<label for="last">Last name</label><input name="last_name" id="last" required>
<label for="email">Email</label><input name="email" id="email" type="email" required>
<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>`;
const head = (title: string) => `<!doctype html><title>${title}</title><h1>TEST Analyst</h1><p>TEST Classes Employer</p>`;

// Run A: every class that leaves the page in place.
const classes = ({ base, other }: { base: string; other: string }) => `${head("TEST role")}
<form method="post" action="/apply/submit" enctype="multipart/form-data">${FIELDS}<button type="submit">Submit application</button></form>
<iframe id="same" src="/frame-same" style="display:none"></iframe>
<iframe id="cross" src="${other.replace("127.0.0.1", "localhost")}/frame-cross" style="display:none"></iframe>
<script>
  const q = (p) => p.catch(() => {});
  const sockBefore = new WebSocket("${base.replace("http", "ws")}/ws-before");
  q(fetch("/slow-start")); // a read started before any value; its redirect comes back after the first fill
  q(fetch("/fetchlater-type?t=" + typeof fetchLater)); // before any value: does this page have fetchLater at all
  try { navigator.serviceWorker.register("/sw.js").catch(() => {}); } catch {}
  let done = false;
  document.getElementById("first").addEventListener("input", (e) => {
    if (done) return; done = true;
    const v = e.target.value;
    const send = () => { try { sockBefore.send("value:" + v); } catch {} };
    sockBefore.readyState === 1 ? send() : sockBefore.addEventListener("open", send);
    try { const s2 = new WebSocket("${base.replace("http", "ws")}/ws-after?v=" + v); s2.addEventListener("open", () => s2.send("value:" + v)); } catch {}
    try { const w = new Worker(URL.createObjectURL(new Blob(["onmessage = (e) => fetch(e.data).catch(() => {})"], { type: "text/javascript" }))); w.postMessage("${base}/worker-leak?v=" + v); } catch {}
    try { const sw = new SharedWorker(URL.createObjectURL(new Blob(["onconnect = (c) => { c.ports[0].onmessage = (e) => fetch(e.data).catch(() => {}); }"], { type: "text/javascript" }))); sw.port.start(); sw.port.postMessage("${base}/shared-leak?v=" + v); } catch {}
    try { navigator.serviceWorker && navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage(v); } catch {}
    document.getElementById("same").contentWindow.postMessage(v, "*");
    document.getElementById("cross").contentWindow.postMessage(v, "*");
    for (const [rel, href] of [["prefetch", "/prefetch-leak?v=" + v], ["preconnect", "${other}/?v=" + v], ["dns-prefetch", "//" + v.toLowerCase() + ".invalid"]]) {
      const l = document.createElement("link"); l.rel = rel; l.href = href; document.head.appendChild(l);
    }
    addEventListener("pagehide", () => { try { navigator.sendBeacon("/pagehide-leak", v); } catch {} q(fetch("/pagehide-keepalive?v=" + v, { keepalive: true })); });
    addEventListener("beforeunload", () => { try { navigator.sendBeacon("/beforeunload-leak", v); } catch {} });
    addEventListener("unload", () => { try { navigator.sendBeacon("/unload-leak", v); } catch {} });
    addEventListener("visibilitychange", () => { try { navigator.sendBeacon("/visibility-leak", v); } catch {} q(fetch("/visibility-keepalive?v=" + v, { keepalive: true })); });
    // A deferred request: the browser itself sends it when the page goes (or after activateAfter), not the page's script.
    try { if (typeof fetchLater === "function") fetchLater("/fetchlater-leak?v=" + v, { activateAfter: 600000 }); } catch {}
  });
</script>`;
// Each frame also sends what it was passed when it goes (a cross-origin frame runs in its own process).
const frameLeak = (name: string) => `<!doctype html><script>let v = "";
addEventListener("message", (e) => { v = e.data; fetch("/${name}-leak?v=" + v).catch(() => {}); });
addEventListener("pagehide", () => { try { navigator.sendBeacon("/${name}-pagehide", v); } catch {} fetch("/${name}-keepalive?v=" + v, { keepalive: true }).catch(() => {}); });</script>`;
const frameSame = () => frameLeak("frame-same");
const frameCross = () => frameLeak("frame-cross");

// Run B: a form sent by GET, and a link with ping, each made by the page's script once the first value is in.
const leaving = () => `${head("TEST role")}
<form method="post" action="/apply/submit" enctype="multipart/form-data">${FIELDS}<button type="submit">Submit application</button></form>
<form id="getform" method="get" action="/search"><input type="hidden" name="v" id="gv"></form>
<a id="pinger" href="/pinged-page" ping="/ping-leak">x</a>
<script>
  let done = false;
  document.getElementById("first").addEventListener("input", (e) => {
    if (done) return; done = true;
    const v = e.target.value;
    setTimeout(() => { document.getElementById("pinger").setAttribute("ping", "/ping-leak?v=" + v); document.getElementById("pinger").click(); }, 100);
    setTimeout(() => { document.getElementById("gv").value = v; document.getElementById("getform").requestSubmit(); }, 300);
  });
</script>`;

// Run C: the page leaves for about:blank by itself (no request: the routes never see it), with unload senders set.
const blank = () => `${head("TEST role")}
<form method="post" action="/apply/submit" enctype="multipart/form-data">${FIELDS}<button type="submit">Submit application</button></form>
<script>
  let done = false;
  document.getElementById("first").addEventListener("input", (e) => {
    if (done) return; done = true;
    const v = e.target.value;
    addEventListener("pagehide", () => { try { navigator.sendBeacon("/blank-pagehide", v); } catch {} fetch("/blank-keepalive?v=" + v, { keepalive: true }).catch(() => {}); });
    setTimeout(() => { location.href = "about:blank"; }, 100);
  });
</script>`;

async function dryRun(run: "classes" | "leaving" | "blank") {
  const other = server({ "/frame-cross": frameCross });
  const employer = server(run === "classes" ? { "/apply": classes, "/frame-same": frameSame } : { "/apply": run === "leaving" ? leaving : blank }, other.base);
  // The pages need each other's addresses; both servers exist before the page is asked for.
  (employer as any).log; // (pages read base/other when served)
  const work = await Deno.makeTempDir({ prefix: "trainee-dryrun-classes-" });
  try {
    await Deno.writeTextFile(`${work}/facts.json`, JSON.stringify(FACTS));
    await Deno.writeFile(`${work}/resume.pdf`, new TextEncoder().encode("%PDF-1.4\n% synthetic\n%%EOF\n"));
    const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
    const result = await runEngine(["--url", `${employer.base}/apply`, "--facts", `${work}/facts.json`, "--resume", `${work}/resume.pdf`]);
    await new Promise((ok) => setTimeout(ok, 2500)); // the slow redirect, sockets, workers, unload senders
    console.log(`${run}: result ${JSON.stringify(result?.result)}\n employer: ${JSON.stringify(employer.log)}\n other: ${JSON.stringify(other.log)}`);
    return { result, employer: employer.log, other: other.log };
  } finally {
    await employer.close();
    await other.close();
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}
const carries = (log: string[]) => log.filter((l) => l.includes(VALUE) || l.includes(VALUE.toLowerCase()));

const opts = { sanitizeResources: false, sanitizeOps: false };
const guard = () => {
  if (!browserEnv()) { if (CI) throw Error("needs the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Playwright browser"); return false; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user"); return false; }
  return true;
};

Deno.test({
  ...opts,
  name: "deny classes: sockets, workers, frames, a late redirect, link hints and unload senders send nothing of the person's",
  async fn() {
    if (!guard()) return;
    const r = await dryRun("classes");
    eq(carries(r.employer), [], "the employer received nothing carrying the person's value (requests, socket handshakes, socket frames)");
    eq(carries(r.other), [], "another origin received nothing carrying the person's value");
    // The socket opened before the first value is open, and its frames after it are what was at stake (not a socket
    // that never opened).
    assert(r.employer.includes("WS-OPEN /ws-before"), "the socket from before the first value was open");
    eq(r.employer.filter((l) => l.startsWith("WS-FRAME")), [], "no socket frame reached the employer");
    eq(r.employer.filter((l) => l.startsWith("WS-OPEN /ws-after")), [], "no socket was opened after the first value");
    // The read from before the first value went out (allowed: nothing of theirs yet); its redirect, after, did not.
    assert(r.employer.includes("GET /slow-start"), "the read from before any value reached the employer");
    // (It lands on the posting's own page: a redirect anywhere else is refused by the engine's own rule, before this one.)
    eq(r.employer.filter((l) => l.includes("redirect-landing")), [], "the redirect followed after the first value did not");
    // The cross-origin frame loaded (before any value): what it was passed after did not go out.
    assert(r.other.some((l) => l.startsWith("GET /frame-cross")), "the cross-origin frame loaded");
    // fetchLater is gone from the discovery page (the browser itself would send its deferred request when the page goes).
    eq(r.employer.filter((l) => l.startsWith("GET /fetchlater-type")), ["GET /fetchlater-type?t=undefined"], "the page has no fetchLater");
    eq(r.result?.result?.reason, "dry_run", JSON.stringify(r.result?.result));
  },
});

Deno.test({
  ...opts,
  name: "deny classes: a form sent by GET and a link's ping send nothing of the person's; the run ends, named",
  async fn() {
    if (!guard()) return;
    const r = await dryRun("leaving");
    eq(carries(r.employer), [], "the employer received nothing carrying the person's value");
    eq(r.employer.filter((l) => /\/(search|ping-leak|pinged-page)/.test(l)), [], "neither the GET form, the ping nor the link's navigation went out");
    eq([r.result?.result?.state, r.result?.result?.reason], ["not_submitted", "DISCOVERY_NAVIGATION_STOPPED"], JSON.stringify(r.result?.result));
  },
});

Deno.test({
  ...opts,
  name: "deny classes: a page that leaves for about:blank by itself sends nothing of the person's as it goes",
  async fn() {
    if (!guard()) return;
    const r = await dryRun("blank");
    eq(carries(r.employer), [], "the employer received nothing carrying the person's value");
    // Not yet a named reason (the form is gone, so the run fails as a driver error); nothing was sent either way.
    eq(r.result?.result?.state, "not_submitted", JSON.stringify(r.result?.result));
  },
});
